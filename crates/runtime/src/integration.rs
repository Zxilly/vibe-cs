use std::{
    collections::HashMap,
    ffi::OsString,
    fs::{self, File as StdFile},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use async_trait::async_trait;
use cap_std::{
    ambient_authority,
    fs::{Dir, File as CapabilityFile, OpenOptions as CapabilityOpenOptions},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::{
    io::AsyncWriteExt,
    sync::{Mutex, RwLock},
};
use url::Url;
use uuid::Uuid;
use vibe_cs_application::IntegrationPort;
use vibe_cs_demo::{
    ParseCancellation, SOURCE2_DEMO_MAGIC, ValidatedDemo, ValidationLimits, validate_demo,
};
use vibe_cs_domain::{
    AppConfig, DemoRecord, DemoStatus, DomainError, MatchDemoStatus, MatchDownloadJob,
    MatchDownloadStatus, MatchHistoryQuery, MatchHistoryResult, SteamConfig, SteamMatchRecord,
};
use vibe_cs_integrations::{
    DemoDecompressionLimits, DemoDownloadObserver, DemoDownloadPort, DemoDownloadProgress,
    DemoDownloadRequest, DependencyInspector, DownloadCancellation, GameLaunchOptions, GsiPayload,
    GsiState, IntegrationError, LaunchCommand, MatchHistoryRequest, OpenAiClient, OpenAiConfig,
    SecretString, SteamMatchHistoryPort, SteamMatchReference, SteamWebClient,
    build_cs2_launch_command, decode_match_sharing_code, decompress_bz2_archive_cancellable,
    discover_paths, is_steam_id, parse_gsi_payload,
};
use vibe_cs_storage::{
    DemoCatalogIdentity, DemoContentIdentity, DemoContentRecovery, MatchDownloadClaim, Storage,
    StorageError,
};

use crate::analysis::map_demo_error;

const MAXIMUM_GSI_CONFIG_BYTES: usize = 64 * 1024;
const MAXIMUM_GSI_PAYLOAD_BYTES: usize = 512 * 1024;
const MAXIMUM_RECOVERY_MARKER_BYTES: u64 = 128 * 1024;
const GSI_FILE_NAME: &str = "gamestate_integration_vibe_cs.cfg";
const MAXIMUM_STEAM_ARCHIVE_BYTES: u64 = 1024 * 1024 * 1024;
const MAXIMUM_STEAM_DEMO_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAXIMUM_PLAYBACK_TICK: u64 = 2_147_483_647;
const MAXIMUM_PLAYBACK_CACHE_ENTRIES: usize = 4;
const MAXIMUM_PLAYBACK_CACHE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAXIMUM_PLAYBACK_CACHE_SCAN_ENTRIES: usize = 64;
const PLAYBACK_PARTIAL_STALE_AGE: Duration = Duration::from_secs(60 * 60);

#[async_trait]
trait RuntimeSteamBackend: Send + Sync + std::fmt::Debug {
    async fn history(
        &self,
        api_key: SecretString,
        request: MatchHistoryRequest,
    ) -> Result<Vec<SteamMatchReference>, IntegrationError>;

    async fn download(
        &self,
        api_key: SecretString,
        request: DemoDownloadRequest,
        cancellation: DownloadCancellation,
        observer: Arc<dyn DemoDownloadObserver>,
    ) -> Result<PathBuf, IntegrationError>;
}

#[derive(Debug, Default)]
struct SystemSteamBackend;

#[derive(Debug)]
enum TrackedPlaybackState {
    Idle,
    Launching {
        token: Uuid,
        signal: Arc<PlaybackLaunchSignal>,
    },
    Active {
        token: Uuid,
        process_id: u32,
        child: Box<tokio::process::Child>,
    },
    Stopping {
        token: Uuid,
        process_id: u32,
        signal: Arc<PlaybackStopSignal>,
    },
    Stopped {
        token: Uuid,
        process_id: u32,
    },
}

#[derive(Debug)]
struct PlaybackLaunchSignal {
    cancelled: AtomicBool,
    completion: tokio::sync::watch::Sender<bool>,
}

impl Default for PlaybackLaunchSignal {
    fn default() -> Self {
        let (completion, _) = tokio::sync::watch::channel(false);
        Self {
            cancelled: AtomicBool::new(false),
            completion,
        }
    }
}

impl PlaybackLaunchSignal {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    fn complete(&self) {
        self.completion.send_replace(true);
    }

    async fn wait(&self) {
        let mut completion = self.completion.subscribe();
        if *completion.borrow() {
            return;
        }
        completion
            .changed()
            .await
            .expect("playback launch completion sender remains alive");
    }
}

#[derive(Debug)]
struct PlaybackStopSignal {
    completion: tokio::sync::watch::Sender<bool>,
}

impl Default for PlaybackStopSignal {
    fn default() -> Self {
        let (completion, _) = tokio::sync::watch::channel(false);
        Self { completion }
    }
}

impl PlaybackStopSignal {
    fn complete(&self) {
        self.completion.send_replace(true);
    }

    async fn wait(&self) {
        let mut completion = self.completion.subscribe();
        if *completion.borrow() {
            return;
        }
        completion
            .changed()
            .await
            .expect("playback stop completion sender remains alive");
    }
}

#[derive(Debug)]
struct TrackedPlaybackLaunch {
    state: Arc<StdMutex<TrackedPlaybackState>>,
    token: Uuid,
    signal: Arc<PlaybackLaunchSignal>,
    armed: bool,
}

impl TrackedPlaybackLaunch {
    fn reserve(
        state: Arc<StdMutex<TrackedPlaybackState>>,
        token: Uuid,
    ) -> Result<Self, DomainError> {
        let signal = {
            let mut tracked = state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if !matches!(
                &*tracked,
                TrackedPlaybackState::Idle | TrackedPlaybackState::Stopped { .. }
            ) {
                return Err(DomainError::Conflict(
                    "a managed playback process is already tracked".to_owned(),
                ));
            }
            let signal = Arc::new(PlaybackLaunchSignal::default());
            *tracked = TrackedPlaybackState::Launching {
                token,
                signal: Arc::clone(&signal),
            };
            signal
        };
        Ok(Self {
            state,
            token,
            signal,
            armed: true,
        })
    }

    fn ensure_not_cancelled(&self) -> Result<(), DomainError> {
        if self.signal.is_cancelled() {
            Err(DomainError::Conflict(
                "managed playback launch was cancelled before the process started".to_owned(),
            ))
        } else {
            Ok(())
        }
    }

    fn activate(mut self, child: tokio::process::Child) -> Result<(u32, bool), DomainError> {
        let process_id = child.id().ok_or_else(|| {
            DomainError::Internal(
                "managed playback process started without an identifier".to_owned(),
            )
        })?;
        let mut tracked = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !matches!(
            &*tracked,
            TrackedPlaybackState::Launching { token, signal }
                if *token == self.token && Arc::ptr_eq(signal, &self.signal)
        ) {
            return Err(DomainError::Conflict(
                "managed playback launch identity changed before activation".to_owned(),
            ));
        }
        let cancelled = self.signal.is_cancelled();
        *tracked = TrackedPlaybackState::Active {
            token: self.token,
            process_id,
            child: Box::new(child),
        };
        drop(tracked);
        self.armed = false;
        self.signal.complete();
        Ok((process_id, cancelled))
    }
}

impl Drop for TrackedPlaybackLaunch {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut tracked = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if matches!(
            &*tracked,
            TrackedPlaybackState::Launching { token, signal }
                if *token == self.token && Arc::ptr_eq(signal, &self.signal)
        ) {
            *tracked = TrackedPlaybackState::Idle;
        }
        drop(tracked);
        self.signal.complete();
    }
}

#[derive(Debug)]
struct TrackedPlaybackStop {
    state: Arc<StdMutex<TrackedPlaybackState>>,
    token: Uuid,
    process_id: u32,
    child: Option<Box<tokio::process::Child>>,
    signal: Arc<PlaybackStopSignal>,
    armed: bool,
}

impl TrackedPlaybackStop {
    fn begin(state: Arc<StdMutex<TrackedPlaybackState>>, token: Uuid) -> Result<Self, DomainError> {
        let (process_id, child, signal) = {
            let mut tracked = state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let previous = std::mem::replace(&mut *tracked, TrackedPlaybackState::Idle);
            match previous {
                TrackedPlaybackState::Active {
                    token: active,
                    process_id,
                    child,
                } if active == token => {
                    let signal = Arc::new(PlaybackStopSignal::default());
                    *tracked = TrackedPlaybackState::Stopping {
                        token,
                        process_id,
                        signal: Arc::clone(&signal),
                    };
                    (process_id, child, signal)
                }
                other => {
                    *tracked = other;
                    return Err(DomainError::Conflict(
                        "playback session token does not match an active tracked process"
                            .to_owned(),
                    ));
                }
            }
        };
        Ok(Self {
            state,
            token,
            process_id,
            child: Some(child),
            signal,
            armed: true,
        })
    }

    fn child_mut(&mut self) -> &mut tokio::process::Child {
        self.child
            .as_deref_mut()
            .expect("armed playback stop always owns its child handle")
    }

    fn complete(mut self) {
        let mut tracked = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if matches!(
            &*tracked,
            TrackedPlaybackState::Stopping { token, process_id, signal }
                if *token == self.token && *process_id == self.process_id
                    && Arc::ptr_eq(signal, &self.signal)
        ) {
            *tracked = TrackedPlaybackState::Stopped {
                token: self.token,
                process_id: self.process_id,
            };
        }
        drop(tracked);
        drop(self.child.take());
        self.armed = false;
        self.signal.complete();
    }
}

impl Drop for TrackedPlaybackStop {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let Some(child) = self.child.take() else {
            return;
        };
        let mut tracked = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if matches!(
            &*tracked,
            TrackedPlaybackState::Stopping { token, process_id, signal }
                if *token == self.token && *process_id == self.process_id
                    && Arc::ptr_eq(signal, &self.signal)
        ) {
            *tracked = TrackedPlaybackState::Active {
                token: self.token,
                process_id: self.process_id,
                child,
            };
        }
        drop(tracked);
        self.signal.complete();
    }
}

#[derive(Debug)]
struct PlaybackLaunchGuard {
    _directory: Dir,
    _file: CapabilityFile,
}

#[derive(Debug)]
enum PlaybackDataDirectory {
    Open(PlaybackDataCapability),
    Unavailable(String),
}

#[derive(Debug)]
struct PlaybackDataCapability {
    path: PathBuf,
    directory: Dir,
}

#[derive(Debug)]
struct ManagedPlaybackSnapshot {
    path: PathBuf,
    directory: Dir,
    file: CapabilityFile,
}

#[async_trait]
impl RuntimeSteamBackend for SystemSteamBackend {
    async fn history(
        &self,
        api_key: SecretString,
        request: MatchHistoryRequest,
    ) -> Result<Vec<SteamMatchReference>, IntegrationError> {
        SteamWebClient::new(api_key)?.history(request).await
    }

    async fn download(
        &self,
        api_key: SecretString,
        request: DemoDownloadRequest,
        cancellation: DownloadCancellation,
        observer: Arc<dyn DemoDownloadObserver>,
    ) -> Result<PathBuf, IntegrationError> {
        SteamWebClient::new(api_key)?
            .download_archive_observed(request, cancellation, Some(observer))
            .await
    }
}

/// Concrete adapter for locally configured services and tools.
#[derive(Debug, Clone)]
pub struct RuntimeIntegrationPort {
    storage: Storage,
    data_dir: PathBuf,
    inspector: DependencyInspector,
    gsi: Arc<RwLock<GsiState>>,
    steam_backend: Arc<dyn RuntimeSteamBackend>,
    steam_downloads: Arc<Mutex<HashMap<Uuid, DownloadCancellation>>>,
    #[cfg(test)]
    steam_terminal_failure_budget: Arc<std::sync::atomic::AtomicUsize>,
    tracked_playback: Arc<StdMutex<TrackedPlaybackState>>,
    playback_data_dir: Arc<PlaybackDataDirectory>,
    playback_guards: Arc<StdMutex<HashMap<Uuid, PlaybackLaunchGuard>>>,
}

impl RuntimeIntegrationPort {
    #[must_use]
    pub fn new(storage: Storage, data_dir: PathBuf) -> Self {
        Self::new_with_state(
            storage,
            data_dir,
            Arc::new(RwLock::new(GsiState::default())),
        )
    }

    #[must_use]
    pub fn new_with_state(storage: Storage, data_dir: PathBuf, gsi: Arc<RwLock<GsiState>>) -> Self {
        let playback_data_dir = Arc::new(open_playback_data_directory(&data_dir).map_or_else(
            |error| PlaybackDataDirectory::Unavailable(error.to_string()),
            PlaybackDataDirectory::Open,
        ));
        Self {
            storage,
            data_dir,
            inspector: DependencyInspector,
            gsi,
            steam_backend: Arc::new(SystemSteamBackend),
            steam_downloads: Arc::new(Mutex::new(HashMap::new())),
            #[cfg(test)]
            steam_terminal_failure_budget: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            tracked_playback: Arc::new(StdMutex::new(TrackedPlaybackState::Idle)),
            playback_data_dir,
            playback_guards: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    #[cfg(test)]
    fn with_steam_backend(mut self, backend: Arc<dyn RuntimeSteamBackend>) -> Self {
        self.steam_backend = backend;
        self
    }

    #[cfg(test)]
    fn with_steam_terminal_failures(self, failures: usize) -> Self {
        self.steam_terminal_failure_budget
            .store(failures, Ordering::SeqCst);
        self
    }

    /// Updates the in-memory GSI snapshot after a host validates an incoming payload.
    pub async fn apply_gsi(&self, payload: GsiPayload, received_at: DateTime<Utc>) {
        self.gsi.write().await.apply(payload, received_at);
    }

    async fn config(&self) -> Result<AppConfig, DomainError> {
        self.storage
            .get_config()
            .await
            .map_err(|error| storage_error(&error))
            .map(Option::unwrap_or_default)
    }

    /// Marks non-terminal download records left by a previous process as failed.
    /// A new download can then be started explicitly without reusing partial files.
    ///
    /// # Errors
    ///
    /// Returns the storage error without starting the runtime when the download
    /// jobs and their Steam match records cannot be recovered atomically.
    pub async fn recover_orphaned_downloads(&self) -> vibe_cs_storage::Result<u64> {
        self.storage
            .recover_orphaned_match_downloads(
                "the local service stopped before the download completed".to_owned(),
            )
            .await
    }

    fn steam_test_config(
        mut config: SteamConfig,
        request: &Value,
    ) -> Result<SteamConfig, DomainError> {
        let mut requested =
            serde_json::from_value::<SteamConfig>(request.clone()).map_err(|error| {
                DomainError::InvalidInput(format!("invalid Steam test configuration: {error}"))
            })?;
        if is_secret_placeholder(&requested.web_api_key) {
            requested.web_api_key = config.web_api_key;
        }
        if is_secret_placeholder(&requested.authentication_code) {
            requested.authentication_code = config.authentication_code;
        }
        if is_secret_placeholder(&requested.known_share_code) {
            requested.known_share_code = config.known_share_code;
        }
        config = requested;
        Ok(config)
    }

    fn steam_history_request(
        config: &SteamConfig,
        maximum_results: usize,
    ) -> Result<MatchHistoryRequest, DomainError> {
        if config.web_api_key.trim().is_empty() {
            return Err(DomainError::DependencyUnavailable(
                "Steam match history is not configured; add a Web API key in Settings".to_owned(),
            ));
        }
        let request = MatchHistoryRequest {
            steam_id: config.steam_id.trim().to_owned(),
            authentication_code: SecretString::new(config.authentication_code.trim()),
            known_code: config.known_share_code.trim().to_owned(),
            maximum_results,
        };
        request.validate().map_err(integration_error)?;
        Ok(request)
    }

    async fn test_steam_history(&self, config: &SteamConfig) -> Result<Value, DomainError> {
        let request = Self::steam_history_request(config, 1)?;
        let matches = self
            .steam_backend
            .history(SecretString::new(config.web_api_key.trim()), request)
            .await
            .map_err(integration_error)?;
        Ok(json!({ "ok": true, "next_match_available": !matches.is_empty() }))
    }

    async fn sync_steam_history(&self, config: &AppConfig) -> Result<Value, DomainError> {
        let maximum_results =
            usize::try_from(config.steam.maximum_results.clamp(1, 100)).unwrap_or(100);
        let request = Self::steam_history_request(&config.steam, maximum_results)?;
        let seed = decode_match_sharing_code(&request.known_code).map_err(integration_error)?;
        let fetched = self
            .steam_backend
            .history(SecretString::new(config.steam.web_api_key.trim()), request)
            .await
            .map_err(integration_error)?;
        let latest_code = fetched.last().map_or_else(
            || seed.sharing_code.clone(),
            |reference| reference.sharing_code.clone(),
        );
        let mut references = Vec::with_capacity(fetched.len() + 1);
        references.push(seed);
        references.extend(fetched);
        references.sort_unstable_by_key(|reference| reference.match_id);
        references.dedup_by_key(|reference| reference.match_id);

        let now = Utc::now();
        let mut records = Vec::with_capacity(references.len());
        for reference in references {
            let id = steam_match_record_id(&config.steam.steam_id, reference.match_id);
            records.push(SteamMatchRecord {
                id,
                steam_id: config.steam.steam_id.clone(),
                match_id: reference.match_id.to_string(),
                outcome_id: reference.outcome_id.to_string(),
                token: reference.token,
                map_name: None,
                played_at: None,
                score: None,
                result: MatchHistoryResult::Unknown,
                demo_status: MatchDemoStatus::Available,
                demo_id: None,
                last_error: None,
                synced_at: now,
                updated_at: now,
            });
        }
        let synced = records.len();
        let (_, created) = self
            .storage
            .merge_synced_steam_matches(records)
            .await
            .map_err(|error| storage_error(&error))?;

        if latest_code != config.steam.known_share_code {
            let mut updated = config.clone();
            updated.steam.known_share_code = latest_code.clone();
            self.storage
                .put_config(updated)
                .await
                .map_err(|error| storage_error(&error))?;
        }
        let total = self
            .storage
            .list_steam_matches(MatchHistoryQuery {
                steam_id: Some(config.steam.steam_id.clone()),
                search: None,
                page: Some(1),
                page_size: Some(1),
            })
            .await
            .map_err(|error| storage_error(&error))?
            .total;
        Ok(json!({
            "synced": synced,
            "created": created,
            "total": total,
            "cursor_advanced": latest_code != config.steam.known_share_code,
        }))
    }

    async fn list_steam_history(
        &self,
        config: &AppConfig,
        request: &Value,
    ) -> Result<Value, DomainError> {
        if config.steam.steam_id.trim().is_empty() {
            return Err(DomainError::DependencyUnavailable(
                "Steam match history is not configured; open Settings to connect an account"
                    .to_owned(),
            ));
        }
        let page = request.get("page").and_then(Value::as_u64).unwrap_or(1);
        let search = request
            .get("search")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let page_size = request
            .get("page_size")
            .and_then(Value::as_u64)
            .unwrap_or(50);
        let result = self
            .storage
            .list_steam_matches(MatchHistoryQuery {
                steam_id: Some(config.steam.steam_id.clone()),
                search,
                page: Some(u32::try_from(page).unwrap_or(u32::MAX).max(1)),
                page_size: Some(u32::try_from(page_size).unwrap_or(u32::MAX).clamp(1, 200)),
            })
            .await
            .map_err(|error| storage_error(&error))?;
        serde_json::to_value(result).map_err(|error| json_error(&error))
    }

    async fn start_steam_download(
        &self,
        config: &AppConfig,
        request: &Value,
    ) -> Result<Value, DomainError> {
        let runtime = self.clone();
        let config = config.clone();
        let request = request.clone();
        let (response, receiver) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            runtime
                .start_steam_download_owned(&config, &request, response)
                .await;
        });
        receiver.await.map_err(|_| {
            DomainError::Internal(
                "Steam download owner stopped before reporting its claim".to_owned(),
            )
        })?
    }

    async fn start_steam_download_owned(
        &self,
        config: &AppConfig,
        request: &Value,
        response: tokio::sync::oneshot::Sender<Result<Value, DomainError>>,
    ) {
        let result = self.start_steam_download_inner(config, request).await;
        if response.send(result).is_err() {
            tracing::debug!("Steam download requester left after detached owner started");
        }
    }

    async fn start_steam_download_inner(
        &self,
        config: &AppConfig,
        request: &Value,
    ) -> Result<Value, DomainError> {
        let steam_id = config.steam.steam_id.as_str();
        if !is_steam_id(steam_id) {
            return Err(DomainError::DependencyUnavailable(
                "Steam match downloads are not configured; connect a Steam account in Settings"
                    .to_owned(),
            ));
        }
        let web_api_key = config.steam.web_api_key.as_str();
        if web_api_key.len() != 32
            || !web_api_key
                .bytes()
                .all(|character| character.is_ascii_hexdigit())
        {
            return Err(DomainError::DependencyUnavailable(
                "Steam match downloads are not configured; add a valid Web API key in Settings"
                    .to_owned(),
            ));
        }
        let match_record_id = request
            .get("match_id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| DomainError::InvalidInput("match_id is required".to_owned()))?;
        let record = self
            .storage
            .get_steam_match(match_record_id)
            .await
            .map_err(|error| storage_error(&error))?
            .ok_or_else(|| DomainError::NotFound("Steam match".to_owned()))?;
        if record.steam_id != steam_id {
            return Err(DomainError::NotFound("Steam match".to_owned()));
        }
        if let Some(demo_id) = record.demo_id
            && let Some(demo) = self
                .storage
                .get_demo(demo_id)
                .await
                .map_err(|error| storage_error(&error))?
            && reusable_downloaded_demo(&demo).await
        {
            let Some(content_sha256) = demo.content_sha256.clone() else {
                return Err(DomainError::Conflict(
                    "reusable downloaded Demo lost its content identity".to_owned(),
                ));
            };
            let completed = self
                .storage
                .complete_existing_match_download(
                    record.id.clone(),
                    record.demo_id,
                    demo_id,
                    DemoContentIdentity {
                        id: demo.id,
                        path: demo.path.clone(),
                        status: demo.status,
                        content_sha256,
                        file_size: demo.file_size,
                    },
                    Uuid::new_v4(),
                )
                .await
                .map_err(|error| storage_error(&error))?
                .ok_or_else(|| {
                    DomainError::NotFound("Steam match or downloaded Demo".to_owned())
                })?;
            let job = match completed {
                MatchDownloadClaim::Claimed { job, .. } | MatchDownloadClaim::Existing(job) => job,
            };
            return serde_json::to_value(job).map_err(|error| json_error(&error));
        }

        let claim = self
            .storage
            .claim_match_download(record.id.clone(), record.demo_id, Uuid::new_v4())
            .await
            .map_err(|error| storage_error(&error))?
            .ok_or_else(|| DomainError::NotFound("Steam match".to_owned()))?;
        let (job, record, linked_demo) = match claim {
            MatchDownloadClaim::Existing(job) => {
                return serde_json::to_value(job).map_err(|error| json_error(&error));
            }
            MatchDownloadClaim::Claimed {
                job,
                record,
                linked_demo,
            } => (job, *record, linked_demo),
        };

        let cancellation = DownloadCancellation::default();
        self.steam_downloads
            .lock()
            .await
            .insert(job.id, cancellation.clone());
        let response_job = job.clone();
        let runtime = self.clone();
        let api_key = web_api_key.to_owned();
        tokio::spawn(async move {
            let job_id = job.id;
            let panic_job = job.clone();
            let worker_runtime = runtime.clone();
            let worker = tokio::spawn(async move {
                worker_runtime
                    .run_steam_download(job, record, linked_demo, api_key, cancellation)
                    .await;
            });
            if let Err(error) = worker.await {
                let mut terminal = panic_job;
                terminal.status = MatchDownloadStatus::Failed;
                terminal.error = Some(format!(
                    "Steam download worker stopped unexpectedly: {error}"
                ));
                terminal.updated_at = Utc::now();
                if let Err(reconcile_error) = runtime
                    .persist_match_download_terminal(terminal, None)
                    .await
                {
                    tracing::error!(%reconcile_error, %job_id, "unable to reconcile panicked Steam download");
                }
            }
            runtime.steam_downloads.lock().await.remove(&job_id);
        });
        serde_json::to_value(response_job).map_err(|error| json_error(&error))
    }

    async fn run_steam_download(
        &self,
        mut job: MatchDownloadJob,
        mut record: SteamMatchRecord,
        linked_demo: Option<DemoCatalogIdentity>,
        api_key: String,
        cancellation: DownloadCancellation,
    ) {
        let result = self
            .run_steam_download_inner(
                &mut job,
                &mut record,
                linked_demo,
                &api_key,
                cancellation.clone(),
            )
            .await;
        if let Err(error) = result {
            let cancelled = cancellation.is_cancelled()
                || matches!(error, DomainError::Conflict(ref message) if message == "download cancelled");
            job.status = if cancelled {
                MatchDownloadStatus::Cancelled
            } else {
                MatchDownloadStatus::Failed
            };
            job.error = (!cancelled).then(|| error.to_string());
            job.updated_at = Utc::now();
            if let Err(storage_error) = self
                .persist_match_download_terminal(job.clone(), None)
                .await
            {
                tracing::error!(%storage_error, job_id = %job.id, "unable to atomically persist failed Steam download");
            }
        }
    }

    async fn run_steam_download_inner(
        &self,
        job: &mut MatchDownloadJob,
        record: &mut SteamMatchRecord,
        linked_demo: Option<DemoCatalogIdentity>,
        api_key: &str,
        cancellation: DownloadCancellation,
    ) -> Result<(), DomainError> {
        let match_id = record.match_id.parse::<u64>().map_err(|_| {
            DomainError::InvalidInput("stored match identifier is invalid".to_owned())
        })?;
        let outcome_id = record.outcome_id.parse::<u64>().map_err(|_| {
            DomainError::InvalidInput("stored outcome identifier is invalid".to_owned())
        })?;
        let reference = SteamMatchReference {
            sharing_code: String::new(),
            match_id,
            outcome_id,
            token: record.token,
        };
        if cancellation.is_cancelled() {
            return Err(DomainError::Conflict("download cancelled".to_owned()));
        }
        let directory = self.data_dir.join("downloads/steam");
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(|error| io_error("create Steam download directory", &error))?;
        let archive = directory.join(format!("{match_id}_{outcome_id}.dem.bz2"));
        let demo_path = directory.join(format!("{match_id}_{outcome_id}.dem"));
        if demo_path.is_file() {
            match self
                .complete_steam_import(job, record, linked_demo.clone(), &demo_path, &cancellation)
                .await
            {
                Ok(()) => return Ok(()),
                Err(DomainError::InvalidInput(error)) => {
                    tracing::warn!(%error, path = %demo_path.display(), "discarding invalid recovered Steam demo");
                    tokio::fs::remove_file(&demo_path)
                        .await
                        .map_err(|error| io_error("remove invalid recovered Steam demo", &error))?;
                }
                Err(error) => return Err(error),
            }
        }
        if archive.exists() {
            tokio::fs::remove_file(&archive)
                .await
                .map_err(|error| io_error("remove stale Steam archive", &error))?;
        }

        job.status = MatchDownloadStatus::Downloading;
        job.updated_at = Utc::now();
        self.advance_steam_download(job).await?;
        let observer: Arc<dyn DemoDownloadObserver> =
            Arc::new(JobDownloadObserver::new(self.storage.clone(), job.id));
        self.steam_backend
            .download(
                SecretString::new(api_key),
                DemoDownloadRequest {
                    url: reference.replay_url().map_err(integration_error)?,
                    destination: archive.clone(),
                    maximum_bytes: MAXIMUM_STEAM_ARCHIVE_BYTES,
                },
                cancellation.clone(),
                observer,
            )
            .await
            .map_err(integration_error)?;

        if let Some(progress_job) = self
            .storage
            .get_match_download_job(job.id)
            .await
            .map_err(|error| storage_error(&error))?
        {
            job.downloaded_bytes = progress_job.downloaded_bytes;
            job.total_bytes = progress_job.total_bytes;
            job.progress = progress_job.progress;
        }
        job.status = MatchDownloadStatus::Decompressing;
        job.progress = job.progress.max(0.9);
        job.updated_at = Utc::now();
        self.advance_steam_download(job).await?;
        let archive_for_worker = archive.clone();
        let demo_for_worker = demo_path.clone();
        let cancellation_for_worker = cancellation.clone();
        let decompression_task = tokio::task::spawn_blocking(move || {
            decompress_bz2_archive_cancellable(
                &archive_for_worker,
                &demo_for_worker,
                DemoDecompressionLimits {
                    maximum_archive_bytes: MAXIMUM_STEAM_ARCHIVE_BYTES,
                    maximum_demo_bytes: MAXIMUM_STEAM_DEMO_BYTES,
                },
                &cancellation_for_worker,
            )
        })
        .await;
        let _ = tokio::fs::remove_file(&archive).await;
        let decompression = decompression_task.map_err(|error| {
            DomainError::Internal(format!("demo decompression task failed: {error}"))
        })?;
        decompression.map_err(integration_error)?;
        if cancellation.is_cancelled() {
            let _ = tokio::fs::remove_file(&demo_path).await;
            return Err(DomainError::Conflict("download cancelled".to_owned()));
        }

        self.complete_steam_import(job, record, linked_demo, &demo_path, &cancellation)
            .await
    }

    async fn complete_steam_import(
        &self,
        job: &mut MatchDownloadJob,
        record: &mut SteamMatchRecord,
        linked_demo: Option<DemoCatalogIdentity>,
        demo_path: &Path,
        cancellation: &DownloadCancellation,
    ) -> Result<(), DomainError> {
        if cancellation.is_cancelled() {
            return Err(DomainError::Conflict("download cancelled".to_owned()));
        }
        job.status = MatchDownloadStatus::Importing;
        job.progress = 0.97;
        job.updated_at = Utc::now();
        self.advance_steam_download(job).await?;
        let demo = import_downloaded_demo_replacing(
            &self.storage,
            demo_path,
            record.played_at,
            linked_demo,
        )
        .await?;
        let demo_identity = demo_content_identity(&demo)?;
        if cancellation.is_cancelled() {
            return Err(DomainError::Conflict("download cancelled".to_owned()));
        }
        job.status = MatchDownloadStatus::Completed;
        job.progress = 1.0;
        job.demo_id = Some(demo.id);
        job.error = None;
        job.updated_at = Utc::now();
        let finalized = self
            .persist_match_download_terminal(job.clone(), Some(demo_identity))
            .await?;
        let completed = finalized.status == MatchDownloadStatus::Completed;
        *job = finalized;
        if !completed {
            return Err(DomainError::Conflict("download cancelled".to_owned()));
        }
        Ok(())
    }

    async fn persist_match_download_terminal(
        &self,
        mut desired: MatchDownloadJob,
        mut expected_demo: Option<DemoContentIdentity>,
    ) -> Result<MatchDownloadJob, DomainError> {
        const INITIAL_RETRY_DELAY: Duration = Duration::from_millis(100);
        const MAX_RETRY_DELAY: Duration = Duration::from_secs(5);
        let mut attempt = 0_u64;
        let mut retry_delay = INITIAL_RETRY_DELAY;
        loop {
            attempt = attempt.saturating_add(1);
            let current = match self.storage.get_match_download_job(desired.id).await {
                Ok(Some(current)) => current,
                Ok(None) => return Err(DomainError::NotFound("Steam download job".to_owned())),
                Err(error) => {
                    tracing::warn!(
                        %error,
                        job_id = %desired.id,
                        attempt,
                        retry_delay_ms = retry_delay.as_millis(),
                        "unable to inspect Steam download before terminal reconciliation"
                    );
                    tokio::time::sleep(retry_delay).await;
                    retry_delay = retry_delay.saturating_mul(2).min(MAX_RETRY_DELAY);
                    continue;
                }
            };
            if current.status.is_terminal() {
                return Ok(current);
            }
            desired.downloaded_bytes = desired.downloaded_bytes.max(current.downloaded_bytes);
            desired.total_bytes = desired.total_bytes.or(current.total_bytes);
            desired.progress = desired.progress.max(current.progress);
            if current.status == MatchDownloadStatus::Cancelling {
                desired.status = MatchDownloadStatus::Cancelled;
                desired.demo_id = None;
                desired.error = None;
                expected_demo = None;
            }
            desired.updated_at = Utc::now();
            #[cfg(test)]
            if self
                .steam_terminal_failure_budget
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok()
            {
                tracing::warn!(
                    job_id = %desired.id,
                    attempt,
                    retry_delay_ms = retry_delay.as_millis(),
                    "retrying injected Steam terminal persistence failure"
                );
                tokio::time::sleep(retry_delay).await;
                retry_delay = retry_delay.saturating_mul(2).min(MAX_RETRY_DELAY);
                continue;
            }
            match self
                .storage
                .finalize_match_download(desired.clone(), expected_demo.clone())
                .await
            {
                Ok(Some(job)) => return Ok(job),
                Ok(None) => return Err(DomainError::NotFound("Steam download job".to_owned())),
                Err(StorageError::Domain(error)) => return Err(error),
                Err(error) => {
                    tracing::warn!(
                        %error,
                        job_id = %desired.id,
                        attempt,
                        retry_delay_ms = retry_delay.as_millis(),
                        "retrying Steam download terminal persistence"
                    );
                }
            }
            tokio::time::sleep(retry_delay).await;
            retry_delay = retry_delay.saturating_mul(2).min(MAX_RETRY_DELAY);
        }
    }

    async fn advance_steam_download(&self, job: &mut MatchDownloadJob) -> Result<(), DomainError> {
        let requested_status = job.status;
        let current = self
            .storage
            .advance_match_download(job.clone())
            .await
            .map_err(|error| storage_error(&error))?
            .ok_or_else(|| DomainError::NotFound("Steam download job".to_owned()))?;
        let advanced = current.status == requested_status;
        *job = current;
        if advanced {
            Ok(())
        } else if matches!(
            job.status,
            MatchDownloadStatus::Cancelling | MatchDownloadStatus::Cancelled
        ) {
            Err(DomainError::Conflict("download cancelled".to_owned()))
        } else {
            Err(DomainError::Conflict(
                "Steam download job is no longer owned by this worker".to_owned(),
            ))
        }
    }

    async fn steam_download_status(&self, request: &Value) -> Result<Value, DomainError> {
        let id = parse_request_uuid(request, "job_id")?;
        let job = self
            .storage
            .get_match_download_job(id)
            .await
            .map_err(|error| storage_error(&error))?
            .ok_or_else(|| DomainError::NotFound("Steam download job".to_owned()))?;
        serde_json::to_value(job).map_err(|error| json_error(&error))
    }

    async fn list_active_steam_downloads(&self, config: &AppConfig) -> Result<Value, DomainError> {
        if config.steam.steam_id.trim().is_empty() {
            return Ok(json!([]));
        }
        let jobs = self
            .storage
            .list_active_match_download_jobs()
            .await
            .map_err(|error| storage_error(&error))?;
        let mut account_jobs = Vec::new();
        for job in jobs {
            let record = self
                .storage
                .get_steam_match(job.match_record_id.clone())
                .await
                .map_err(|error| storage_error(&error))?;
            if record.is_some_and(|record| record.steam_id == config.steam.steam_id) {
                account_jobs.push(job);
            }
        }
        serde_json::to_value(account_jobs).map_err(|error| json_error(&error))
    }

    async fn cancel_steam_download(&self, request: &Value) -> Result<Value, DomainError> {
        let id = parse_request_uuid(request, "job_id")?;
        let mut job = self
            .storage
            .request_match_download_cancel(id)
            .await
            .map_err(|error| storage_error(&error))?
            .ok_or_else(|| DomainError::NotFound("Steam download job".to_owned()))?;
        if job.status.is_terminal() {
            return serde_json::to_value(job).map_err(|error| json_error(&error));
        }
        if let Some(cancellation) = self.steam_downloads.lock().await.get(&id) {
            cancellation.cancel();
        } else {
            job.status = MatchDownloadStatus::Cancelled;
            job.error = None;
            job.updated_at = Utc::now();
            job = self
                .persist_match_download_terminal(job.clone(), None)
                .await?;
        }
        serde_json::to_value(job).map_err(|error| json_error(&error))
    }

    async fn disconnect_steam(&self, config: &AppConfig) -> Result<Value, DomainError> {
        let mut updated = config.clone();
        updated.steam = SteamConfig::default();
        self.storage
            .put_config(updated)
            .await
            .map_err(|error| storage_error(&error))?;
        Ok(json!({ "disconnected": true }))
    }

    fn llm_client(config: &AppConfig) -> Result<OpenAiClient, DomainError> {
        let base_url = Url::parse(config.llm.base_url.trim())
            .map_err(|error| DomainError::InvalidInput(format!("invalid LLM base URL: {error}")))?;
        OpenAiClient::new(OpenAiConfig {
            provider: config.llm.provider.clone(),
            base_url,
            model: config.llm.model.clone(),
            api_key: SecretString::new(config.llm.api_key.clone()),
            maximum_commentary_chars: 4_000,
        })
        .map_err(integration_error)
    }

    fn llm_status(config: &AppConfig) -> Value {
        let public_base_url = Url::parse(config.llm.base_url.trim())
            .ok()
            .and_then(|mut url| {
                url.set_username("").ok()?;
                url.set_password(None).ok()?;
                url.set_query(None);
                url.set_fragment(None);
                Some(url.to_string())
            })
            .unwrap_or_default();
        json!({
            "configured": !config.llm.provider.trim().is_empty()
                && !config.llm.model.trim().is_empty()
                && !config.llm.base_url.trim().is_empty()
                && !config.llm.api_key.is_empty(),
            "provider": config.llm.provider,
            "model": config.llm.model,
            "base_url": public_base_url,
            "has_api_key": !config.llm.api_key.is_empty(),
        })
    }

    fn llm_test_config(mut config: AppConfig, request: &Value) -> Result<AppConfig, DomainError> {
        let mut requested = serde_json::from_value::<vibe_cs_domain::LlmConfig>(request.clone())
            .map_err(|error| {
                DomainError::InvalidInput(format!("invalid LLM test configuration: {error}"))
            })?;
        if is_secret_placeholder(&requested.api_key) {
            requested.api_key = config.llm.api_key;
        }
        config.llm = requested;
        Ok(config)
    }

    async fn llm_commentary(
        &self,
        config: &AppConfig,
        request: &Value,
        test: bool,
    ) -> Result<Value, DomainError> {
        let client = Self::llm_client(config)?;
        let (system, context) = if test {
            (
                "Return a JSON object with a concise commentary field.",
                "Connectivity test. Reply with a short confirmation.",
            )
        } else {
            let system = request
                .get("system")
                .and_then(Value::as_str)
                .unwrap_or(config.llm.prompt.as_str());
            let context = request
                .get("context")
                .and_then(Value::as_str)
                .ok_or_else(|| DomainError::InvalidInput("context is required".to_owned()))?;
            if system.len() > 32 * 1024 {
                return Err(DomainError::InvalidInput(
                    "LLM system prompt is too large".to_owned(),
                ));
            }
            (system, context)
        };
        let commentary = client
            .commentary(system, context)
            .await
            .map_err(integration_error)?;
        Ok(json!({ "ok": true, "commentary": commentary }))
    }

    async fn llm_agent_test(&self, config: &AppConfig) -> Result<Value, DomainError> {
        let capabilities = Self::llm_client(config)?
            .agent_capabilities()
            .await
            .map_err(integration_error)?;
        Ok(json!({
            "ok": true,
            "provider": config.llm.provider,
            "model": config.llm.model,
            "capabilities": capabilities,
        }))
    }

    async fn gsi_status(&self, config: &AppConfig) -> Result<Value, DomainError> {
        let state = self.gsi.read().await.clone();
        let installed = gsi_config_path(config).is_some_and(|path| path.is_file());
        Ok(json!({
            "installed": installed,
            "fresh": state.is_fresh(Utc::now(), chrono::Duration::seconds(15)),
            "state": state,
        }))
    }

    async fn playback_status(&self, config: &AppConfig) -> Result<Value, DomainError> {
        let discovery_config = config.clone();
        let discovered = tokio::task::spawn_blocking(move || discover_paths(&discovery_config))
            .await
            .map_err(|error| {
                DomainError::Internal(format!("game discovery task failed to join: {error}"))
            })?;
        let state = self.gsi.read().await.clone();
        let now = Utc::now();
        let gsi_fresh = state.is_fresh(now, chrono::Duration::seconds(15));
        let gsi_installed = discovered
            .cs2
            .as_deref()
            .and_then(gsi_config_path_from_executable)
            .is_some_and(|path| path.is_file());
        let latest = state.latest.as_ref();
        let provider_is_cs2 = latest
            .and_then(|payload| payload.provider.as_ref())
            .and_then(|provider| provider.appid)
            == Some(730);
        let executable = discovered
            .cs2
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned());
        let executable_available = executable.is_some();
        let gsi_ready = executable_available && gsi_installed && gsi_fresh && provider_is_cs2;
        let mut warnings = Vec::new();
        if !executable_available {
            warnings.push("CS2 executable was not found".to_owned());
        }
        if !gsi_installed {
            warnings.push("managed GSI configuration is not installed".to_owned());
        } else if !gsi_fresh {
            warnings.push("no fresh GSI heartbeat is available".to_owned());
        } else if !provider_is_cs2 {
            warnings.push("the latest GSI heartbeat does not identify CS2".to_owned());
        }
        Ok(json!({
            "executable_available": executable_available,
            "executable": executable,
            "gsi_installed": gsi_installed,
            "gsi_fresh": gsi_fresh,
            "gsi_sequence": state.sequence,
            "gsi_received_at": state.received_at,
            "map_name": latest
                .and_then(|payload| payload.map.as_ref())
                .and_then(|map| map.name.as_deref()),
            "map_phase": latest
                .and_then(|payload| payload.map.as_ref())
                .and_then(|map| map.phase.as_deref()),
            "player_name": latest
                .and_then(|payload| payload.player.as_ref())
                .and_then(|player| player.name.as_deref()),
            "player_activity": latest
                .and_then(|payload| payload.player.as_ref())
                .and_then(|player| player.activity.as_deref()),
            "ready_to_launch": executable_available,
            "gsi_ready": gsi_ready,
            "warnings": warnings,
        }))
    }

    async fn playback_preflight(
        &self,
        config: &AppConfig,
        request: &Value,
    ) -> Result<(ValidatedDemo, Value), DomainError> {
        let preflight_config = config.clone();
        let preflight_request = request.clone();
        let (command, validated) = tokio::task::spawn_blocking(move || {
            let command = build_playback_command(&preflight_config, &preflight_request)?;
            let demo_path = command
                .args
                .windows(2)
                .find(|pair| pair.first().is_some_and(|argument| argument == "+playdemo"))
                .and_then(|pair| pair.get(1))
                .map(PathBuf::from)
                .ok_or_else(|| {
                    DomainError::Internal("playback command omitted demo path".to_owned())
                })?;
            let validated = validate_demo(
                demo_path,
                ValidationLimits::default(),
                &ParseCancellation::default(),
            )
            .map_err(map_demo_error)?;
            validate_expected_demo_hash(&preflight_request, &validated)?;
            Ok::<_, DomainError>((command, validated))
        })
        .await
        .map_err(|error| {
            DomainError::Internal(format!("demo preflight task failed to join: {error}"))
        })??;

        let status = self.playback_status(config).await?;
        let mut warnings = status
            .get("warnings")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if status.get("gsi_ready").and_then(Value::as_bool) != Some(true) {
            warnings.push(Value::String(
                "launch is available, but recording controls cannot be verified until GSI is fresh"
                    .to_owned(),
            ));
        }
        let arguments = command
            .args
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let response = json!({
            "ready": true,
            "executable": command.program.to_string_lossy(),
            "demo_path": validated.path.to_string_lossy(),
            "launch_path": validated.path.to_string_lossy(),
            "demo_size": validated.size,
            "demo_sha256": validated.sha256,
            "arguments": arguments,
            "managed_copy": false,
            "status": status,
            "warnings": warnings,
        });
        Ok((validated, response))
    }

    async fn managed_playback_copy(
        &self,
        validated: &ValidatedDemo,
    ) -> Result<ManagedPlaybackSnapshot, DomainError> {
        let data_directory = Arc::clone(&self.playback_data_dir);
        let validated = validated.clone();
        tokio::task::spawn_blocking(move || match data_directory.as_ref() {
            PlaybackDataDirectory::Open(directory) => stage_managed_playback(directory, &validated),
            PlaybackDataDirectory::Unavailable(reason) => Err(DomainError::DependencyUnavailable(
                format!("managed playback data directory is unavailable: {reason}"),
            )),
        })
        .await
        .map_err(|error| {
            DomainError::Internal(format!("managed playback copy task failed: {error}"))
        })?
    }

    fn retain_playback_guard(&self, session_token: Uuid, snapshot: ManagedPlaybackSnapshot) {
        self.playback_guards
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                session_token,
                PlaybackLaunchGuard {
                    _directory: snapshot.directory,
                    _file: snapshot.file,
                },
            );
    }

    async fn play_demo(&self, config: &AppConfig, request: &Value) -> Result<Value, DomainError> {
        let session_token = parse_request_uuid(request, "session_token")?;
        let tracked_launch =
            TrackedPlaybackLaunch::reserve(Arc::clone(&self.tracked_playback), session_token)?;
        let (validated, mut preflight) = self.playback_preflight(config, request).await?;
        tracked_launch.ensure_not_cancelled()?;
        let managed = self.managed_playback_copy(&validated).await?;
        tracked_launch.ensure_not_cancelled()?;
        let launch_path = managed.path.clone();
        let mut launch_request = request.clone();
        let launch_object = launch_request.as_object_mut().ok_or_else(|| {
            DomainError::InvalidInput("demo playback request must be an object".to_owned())
        })?;
        launch_object.insert(
            "path".to_owned(),
            Value::String(launch_path.to_string_lossy().into_owned()),
        );
        launch_object.insert(
            "expected_sha256".to_owned(),
            Value::String(validated.sha256.clone()),
        );
        let launch_config = config.clone();
        let command = tokio::task::spawn_blocking(move || {
            build_playback_command(&launch_config, &launch_request)
        })
        .await
        .map_err(|error| {
            DomainError::Internal(format!("managed playback task failed to join: {error}"))
        })??;
        tracked_launch.ensure_not_cancelled()?;
        let verification_path = launch_path.clone();
        let verification_directory = managed
            .directory
            .try_clone()
            .map_err(|error| playback_cache_io("clone playback cache capability", &error))?;
        let verification_file = managed
            .file
            .try_clone()
            .map_err(|error| playback_cache_io("clone managed playback guard", &error))?;
        tokio::task::spawn_blocking(move || {
            verify_managed_playback_mapping(
                &verification_directory,
                &verification_file,
                &verification_path,
            )
        })
        .await
        .map_err(|error| {
            DomainError::Internal(format!(
                "managed playback verification task failed: {error}"
            ))
        })??;
        tracked_launch.ensure_not_cancelled()?;
        if let Some(object) = preflight.as_object_mut() {
            object.insert(
                "launch_path".to_owned(),
                Value::String(launch_path.to_string_lossy().into_owned()),
            );
            object.insert("managed_copy".to_owned(), Value::Bool(true));
            object.insert(
                "arguments".to_owned(),
                json!(
                    command
                        .args
                        .iter()
                        .map(|argument| argument.to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                ),
            );
        }
        let child = spawn_managed_playback(&command)?;
        self.retain_playback_guard(session_token, managed);
        let (process_id, cancelled_after_spawn) = match tracked_launch.activate(child) {
            Ok(activated) => activated,
            Err(error) => {
                self.playback_guards
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&session_token);
                return Err(error);
            }
        };
        if cancelled_after_spawn {
            self.stop_demo(request).await?;
            return Err(DomainError::Conflict(
                "managed playback launch was cancelled while the process started".to_owned(),
            ));
        }
        Ok(json!({
            "started": true,
            "process_id": process_id,
            "demo_id": request.get("demo_id"),
            "preflight": preflight,
        }))
    }

    async fn stop_demo(&self, request: &Value) -> Result<Value, DomainError> {
        enum PendingTransaction {
            Launch(Arc<PlaybackLaunchSignal>),
            Stop(Arc<PlaybackStopSignal>),
        }

        let session_token = parse_request_uuid(request, "session_token")?;
        loop {
            let pending = {
                let tracked = self
                    .tracked_playback
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                match &*tracked {
                    TrackedPlaybackState::Stopped { token, process_id }
                        if *token == session_token =>
                    {
                        return Ok(playback_stopped_response(Some(*process_id), true, false));
                    }
                    TrackedPlaybackState::Idle | TrackedPlaybackState::Stopped { .. } => {
                        return Ok(playback_stopped_response(None, true, false));
                    }
                    TrackedPlaybackState::Launching { token, signal }
                        if *token == session_token =>
                    {
                        signal.cancel();
                        Some(PendingTransaction::Launch(Arc::clone(signal)))
                    }
                    TrackedPlaybackState::Stopping { token, signal, .. }
                        if *token == session_token =>
                    {
                        Some(PendingTransaction::Stop(Arc::clone(signal)))
                    }
                    TrackedPlaybackState::Launching { .. }
                    | TrackedPlaybackState::Active { .. }
                    | TrackedPlaybackState::Stopping { .. } => None,
                }
            };
            match pending {
                Some(PendingTransaction::Launch(signal)) => signal.wait().await,
                Some(PendingTransaction::Stop(signal)) => signal.wait().await,
                None => break,
            }
        }

        let mut stop =
            TrackedPlaybackStop::begin(Arc::clone(&self.tracked_playback), session_token)?;
        let process_id = stop.process_id;
        let (already_stopped, forced_process_stop) = if stop
            .child_mut()
            .try_wait()
            .map_err(|error| playback_child_error("inspect", process_id, &error))?
            .is_some()
        {
            (true, false)
        } else {
            stop.child_mut()
                .kill()
                .await
                .map_err(|error| playback_child_error("terminate", process_id, &error))?;
            (false, true)
        };
        stop.complete();
        self.playback_guards
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&session_token);
        Ok(playback_stopped_response(
            Some(process_id),
            already_stopped,
            forced_process_stop,
        ))
    }

    async fn install_gsi(&self, config: &AppConfig, request: &Value) -> Result<Value, DomainError> {
        if read_marker(&self.data_dir)
            .await?
            .is_some_and(|marker| marker.recovery_required)
        {
            return Err(DomainError::Conflict(
                "restore the pending managed configuration before installing again".to_owned(),
            ));
        }
        let uri = request
            .get("uri")
            .and_then(Value::as_str)
            .ok_or_else(|| DomainError::InvalidInput("uri is required".to_owned()))?;
        validate_loopback_uri(uri)?;
        let token = request
            .get("token")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if token.len() > 256 || token.contains(['\r', '\n', '"']) {
            return Err(DomainError::InvalidInput(
                "GSI token contains unsupported characters".to_owned(),
            ));
        }
        let target = gsi_config_path(config).ok_or_else(|| {
            DomainError::DependencyUnavailable("CS2 installation was not found".to_owned())
        })?;
        let overwrite = request
            .get("overwrite")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if target.exists() && !overwrite {
            return Err(DomainError::Conflict(
                "GSI configuration already exists; explicit overwrite is required".to_owned(),
            ));
        }

        let recovery_dir = self.data_dir.join("recovery");
        tokio::fs::create_dir_all(&recovery_dir)
            .await
            .map_err(|error| io_error("create recovery directory", &error))?;
        let backup = recovery_dir.join("gsi-config.backup");
        let had_previous = target.is_file();
        if had_previous {
            let metadata = tokio::fs::metadata(&target)
                .await
                .map_err(|error| io_error("inspect existing GSI configuration", &error))?;
            if metadata.len() > MAXIMUM_GSI_CONFIG_BYTES as u64 {
                return Err(DomainError::InvalidInput(
                    "existing GSI configuration is too large to back up safely".to_owned(),
                ));
            }
            tokio::fs::copy(&target, &backup)
                .await
                .map_err(|error| io_error("back up GSI configuration", &error))?;
        } else if backup.exists() {
            tokio::fs::remove_file(&backup)
                .await
                .map_err(|error| io_error("remove stale GSI backup", &error))?;
        }

        let escaped_uri = uri.replace('\\', "\\\\").replace('"', "\\\"");
        let escaped_token = token.replace('\\', "\\\\");
        let contents = format!(
            "\"Vibe CS\"\n{{\n  \"uri\" \"{escaped_uri}\"\n  \"timeout\" \"5.0\"\n  \"buffer\" \"0.1\"\n  \"throttle\" \"0.1\"\n  \"heartbeat\" \"15.0\"\n  \"auth\" {{ \"token\" \"{escaped_token}\" }}\n  \"data\" {{ \"provider\" \"1\" \"map\" \"1\" \"player_id\" \"1\" \"player_state\" \"1\" \"player_match_stats\" \"1\" \"round\" \"1\" \"bomb\" \"1\" }}\n}}\n"
        );
        if contents.len() > MAXIMUM_GSI_CONFIG_BYTES {
            return Err(DomainError::InvalidInput(
                "generated GSI configuration is too large".to_owned(),
            ));
        }
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| io_error("create CS2 configuration directory", &error))?;
        }
        let marker = RecoveryMarker {
            recovery_required: true,
            target: target.to_string_lossy().into_owned(),
            had_previous,
            installed_at: Utc::now(),
        };
        write_marker(&self.data_dir, &marker).await?;
        write_atomic(&target, contents.as_bytes()).await?;
        Ok(json!({
            "installed": true,
            "path": target,
            "recovery_required": true,
        }))
    }

    async fn restore_gsi(&self, config: &AppConfig) -> Result<Value, DomainError> {
        let marker = read_marker(&self.data_dir).await?.ok_or_else(|| {
            DomainError::Conflict("no managed configuration recovery is pending".to_owned())
        })?;
        if !marker.recovery_required {
            return Err(DomainError::Conflict(
                "no managed configuration recovery is pending".to_owned(),
            ));
        }
        let target = gsi_config_path(config).ok_or_else(|| {
            DomainError::DependencyUnavailable("CS2 installation was not found".to_owned())
        })?;
        if marker.target != target.to_string_lossy() {
            return Err(DomainError::Conflict(
                "recovery marker does not match the configured CS2 installation".to_owned(),
            ));
        }
        let backup = self.data_dir.join("recovery/gsi-config.backup");
        if marker.had_previous {
            let bytes = tokio::fs::read(&backup)
                .await
                .map_err(|error| io_error("read GSI backup", &error))?;
            if bytes.len() > MAXIMUM_GSI_CONFIG_BYTES {
                return Err(DomainError::InvalidInput(
                    "GSI backup is too large to restore safely".to_owned(),
                ));
            }
            write_atomic(&target, &bytes).await?;
            tokio::fs::remove_file(&backup)
                .await
                .map_err(|error| io_error("remove restored GSI backup", &error))?;
        } else if target.exists() {
            tokio::fs::remove_file(&target)
                .await
                .map_err(|error| io_error("remove managed GSI configuration", &error))?;
        }
        let marker_path = marker_path(&self.data_dir);
        tokio::fs::remove_file(marker_path)
            .await
            .map_err(|error| io_error("remove recovery marker", &error))?;
        Ok(json!({ "restored": true, "recovery_required": false }))
    }

    async fn recovery_status(&self) -> Result<Value, DomainError> {
        let marker = read_marker(&self.data_dir).await?;
        Ok(marker.map_or_else(
            || json!({ "recovery_required": false }),
            |marker| json!(marker),
        ))
    }
}

#[derive(Debug)]
struct JobDownloadObserver {
    storage: Storage,
    job_id: Uuid,
    last: StdMutex<(Instant, u64)>,
}

impl JobDownloadObserver {
    fn new(storage: Storage, job_id: Uuid) -> Self {
        Self {
            storage,
            job_id,
            last: StdMutex::new((
                Instant::now()
                    .checked_sub(Duration::from_secs(1))
                    .unwrap_or_else(Instant::now),
                0,
            )),
        }
    }
}

#[async_trait]
impl DemoDownloadObserver for JobDownloadObserver {
    async fn update(&self, progress: DemoDownloadProgress) -> Result<(), IntegrationError> {
        let should_persist = {
            let mut last = self.last.lock().map_err(|_| {
                IntegrationError::Protocol("download progress lock was poisoned".to_owned())
            })?;
            let complete = progress
                .total_bytes
                .is_some_and(|total| progress.downloaded_bytes >= total);
            if !complete
                && progress.downloaded_bytes.saturating_sub(last.1) < 1024 * 1024
                && last.0.elapsed() < Duration::from_millis(500)
            {
                false
            } else {
                *last = (Instant::now(), progress.downloaded_bytes);
                true
            }
        };
        if !should_persist {
            return Ok(());
        }
        let Some(mut job) = self
            .storage
            .get_match_download_job(self.job_id)
            .await
            .map_err(|error| IntegrationError::Protocol(error.to_string()))?
        else {
            return Err(IntegrationError::Protocol(
                "download job disappeared while reporting progress".to_owned(),
            ));
        };
        if job.status != MatchDownloadStatus::Downloading {
            return Ok(());
        }
        job.downloaded_bytes = progress.downloaded_bytes;
        job.total_bytes = progress.total_bytes;
        job.progress = progress.total_bytes.map_or(job.progress, |total| {
            if total == 0 {
                0.0
            } else {
                let bounded = progress.downloaded_bytes.min(total);
                let downloaded = u32::try_from(bounded).unwrap_or(u32::MAX);
                let total = u32::try_from(total).unwrap_or(u32::MAX);
                (f64::from(downloaded) / f64::from(total) * 0.9).clamp(0.0, 0.9)
            }
        });
        job.updated_at = Utc::now();
        self.storage
            .advance_match_download(job)
            .await
            .map_err(|error| IntegrationError::Protocol(error.to_string()))?
            .ok_or_else(|| {
                IntegrationError::Protocol(
                    "download job disappeared while reporting progress".to_owned(),
                )
            })?;
        Ok(())
    }
}

#[cfg(test)]
async fn import_downloaded_demo(
    storage: &Storage,
    path: &Path,
    played_at: Option<DateTime<Utc>>,
) -> Result<DemoRecord, DomainError> {
    import_downloaded_demo_replacing(storage, path, played_at, None).await
}

async fn import_downloaded_demo_replacing(
    storage: &Storage,
    path: &Path,
    played_at: Option<DateTime<Utc>>,
    replace_demo: Option<DemoCatalogIdentity>,
) -> Result<DemoRecord, DomainError> {
    let canonical = tokio::fs::canonicalize(path)
        .await
        .map_err(|error| io_error("resolve downloaded demo", &error))?;
    let validation_path = canonical.clone();
    let validated = tokio::task::spawn_blocking(move || {
        validate_demo(
            &validation_path,
            ValidationLimits::default(),
            &ParseCancellation::default(),
        )
    })
    .await
    .map_err(|error| DomainError::Internal(format!("demo validation task failed: {error}")))?
    .map_err(|error| DomainError::InvalidInput(error.to_string()))?;
    let file_name = validated
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            DomainError::InvalidInput("downloaded demo file name is invalid".to_owned())
        })?
        .to_owned();
    let display_name = validated
        .path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or(&file_name)
        .to_owned();
    let now = Utc::now();
    let validated_path = validated.path.clone();
    let validated_sha256 = validated.sha256.clone();
    let validated_size = validated.size;
    let result = storage
        .put_content_addressed_demo_observed(
            DemoRecord {
                id: replace_demo
                    .as_ref()
                    .map_or_else(Uuid::new_v4, |identity| identity.id),
                path: validated.path.to_string_lossy().into_owned(),
                file_name,
                display_name,
                source: "download".to_owned(),
                status: DemoStatus::Discovered,
                map_name: None,
                match_date: played_at,
                duration_seconds: None,
                total_rounds: None,
                team_a_name: None,
                team_b_name: None,
                team_a_score: None,
                team_b_score: None,
                player_names: Vec::new(),
                remark: "Steam 比赛历史下载".to_owned(),
                content_sha256: Some(validated_sha256.clone()),
                file_size: validated_size,
                created_at: now,
                updated_at: now,
            },
            replace_demo,
        )
        .await
        .map_err(|error| storage_error(&error))?;
    let mut demo = result.into_demo();
    if Path::new(&demo.path) != validated_path {
        if reusable_downloaded_demo(&demo).await {
            tokio::fs::remove_file(&validated_path)
                .await
                .map_err(|error| io_error("remove duplicate downloaded demo", &error))?;
        } else {
            let expected = DemoContentIdentity {
                id: demo.id,
                path: demo.path.clone(),
                status: demo.status,
                content_sha256: demo.content_sha256.clone().ok_or_else(|| {
                    DomainError::Conflict(
                        "content-addressed Demo lost its fingerprint before recovery".to_owned(),
                    )
                })?,
                file_size: demo.file_size,
            };
            demo = storage
                .recover_content_addressed_demo(DemoContentRecovery {
                    expected,
                    verified_path: validated_path.to_string_lossy().into_owned(),
                    verified_file_name: validated_path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .ok_or_else(|| {
                            DomainError::InvalidInput(
                                "downloaded demo file name is invalid".to_owned(),
                            )
                        })?
                        .to_owned(),
                    verified_size: validated_size,
                    verified_sha256: validated_sha256,
                })
                .await
                .map_err(|error| storage_error(&error))?
                .ok_or_else(|| DomainError::NotFound("cataloged Demo".to_owned()))?;
        }
    }
    Ok(demo)
}

async fn reusable_downloaded_demo(demo: &DemoRecord) -> bool {
    if demo.status == DemoStatus::Missing {
        return false;
    }
    let Some(expected_hash) = demo.content_sha256.clone() else {
        return false;
    };
    let expected_size = demo.file_size;
    let path = PathBuf::from(&demo.path);
    tokio::task::spawn_blocking(move || {
        validate_demo(
            &path,
            ValidationLimits::default(),
            &ParseCancellation::default(),
        )
        .is_ok_and(|validated| validated.size == expected_size && validated.sha256 == expected_hash)
    })
    .await
    .unwrap_or(false)
}

fn demo_content_identity(demo: &DemoRecord) -> Result<DemoContentIdentity, DomainError> {
    Ok(DemoContentIdentity {
        id: demo.id,
        path: demo.path.clone(),
        status: demo.status,
        content_sha256: demo.content_sha256.clone().ok_or_else(|| {
            DomainError::Conflict("downloaded Demo lost its content fingerprint".to_owned())
        })?,
        file_size: demo.file_size,
    })
}

fn steam_match_record_id(steam_id: &str, match_id: u64) -> String {
    format!("{}:{match_id}", steam_id.trim())
}

fn parse_request_uuid(request: &Value, field: &str) -> Result<Uuid, DomainError> {
    request
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| DomainError::InvalidInput(format!("{field} is required")))?
        .parse()
        .map_err(|_| DomainError::InvalidInput(format!("{field} must be a UUID")))
}

#[async_trait]
impl IntegrationPort for RuntimeIntegrationPort {
    async fn request(&self, capability: &str, request: Value) -> Result<Value, DomainError> {
        let config = self.config().await?;
        match capability {
            "dependency_status" => serde_json::to_value(self.inspector.inspect(&config))
                .map_err(|error| json_error(&error)),
            "llm_status" => Ok(Self::llm_status(&config)),
            "llm_test" => {
                let test_config = Self::llm_test_config(config, &request)?;
                self.llm_agent_test(&test_config).await
            }
            "llm_commentary" => self.llm_commentary(&config, &request, false).await,
            "gsi_ingest" => {
                let bytes = serde_json::to_vec(&request).map_err(|error| json_error(&error))?;
                let payload = parse_gsi_payload(&bytes, MAXIMUM_GSI_PAYLOAD_BYTES)
                    .map_err(integration_error)?;
                self.apply_gsi(payload, Utc::now()).await;
                Ok(json!({ "accepted": true }))
            }
            "gsi_status" => self.gsi_status(&config).await,
            "gsi_install" => self.install_gsi(&config, &request).await,
            "gsi_remove" | "config_backup_restore" => self.restore_gsi(&config).await,
            "config_backup_status" => self.recovery_status().await,
            "demo_playback_status" => self.playback_status(&config).await,
            "demo_playback_preflight" => self
                .playback_preflight(&config, &request)
                .await
                .map(|(_, response)| response),
            "demo_play" => self.play_demo(&config, &request).await,
            "demo_stop" => self.stop_demo(&request).await,
            "match_history" => self.list_steam_history(&config, &request).await,
            "match_history_sync" => self.sync_steam_history(&config).await,
            "match_history_test" => {
                let test_config = Self::steam_test_config(config.steam, &request)?;
                self.test_steam_history(&test_config).await
            }
            "match_history_download" => self.start_steam_download(&config, &request).await,
            "match_history_downloads_active" => self.list_active_steam_downloads(&config).await,
            "match_history_download_status" => self.steam_download_status(&request).await,
            "match_history_download_cancel" => self.cancel_steam_download(&request).await,
            "match_history_disconnect" => self.disconnect_steam(&config).await,
            _ => Err(DomainError::DependencyUnavailable(format!(
                "unsupported integration capability: {capability}"
            ))),
        }
    }
}

fn is_secret_placeholder(value: &str) -> bool {
    matches!(value.trim(), "" | "********" | "••••••••" | "<redacted>")
}

fn spawn_managed_playback(command: &LaunchCommand) -> Result<tokio::process::Child, DomainError> {
    let mut process = tokio::process::Command::new(&command.program);
    process
        .args(&command.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    process.spawn().map_err(|error| {
        DomainError::DependencyUnavailable(format!(
            "unable to launch managed playback with {}: {error}",
            command.program.display()
        ))
    })
}

fn build_playback_command(
    config: &AppConfig,
    request: &Value,
) -> Result<LaunchCommand, DomainError> {
    let executable = discover_paths(config).cs2.ok_or_else(|| {
        DomainError::DependencyUnavailable("CS2 executable was not found".to_owned())
    })?;
    let requested_path = request
        .get("path")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| DomainError::InvalidInput("demo path is required".to_owned()))?;
    let path = PathBuf::from(requested_path);
    if !path.is_absolute() {
        return Err(DomainError::InvalidInput(
            "demo path must be absolute".to_owned(),
        ));
    }
    let canonical_path = std::fs::canonicalize(&path).map_err(|error| {
        DomainError::DependencyUnavailable(format!(
            "demo file is unavailable at {}: {error}",
            path.display()
        ))
    })?;
    let mut command = build_cs2_launch_command(
        &executable,
        &canonical_path,
        GameLaunchOptions {
            skip_intro: true,
            ..GameLaunchOptions::default()
        },
    )
    .map_err(integration_error)?;

    if let Some(start_tick) = request.get("start_tick").and_then(Value::as_u64) {
        if start_tick > MAXIMUM_PLAYBACK_TICK {
            return Err(DomainError::InvalidInput(format!(
                "demo start tick must not exceed {MAXIMUM_PLAYBACK_TICK}"
            )));
        }
        command.args.push(OsString::from("+demo_gototick"));
        command.args.push(OsString::from(start_tick.to_string()));
    }
    if let Some(player) = request.get("player").and_then(Value::as_str) {
        validate_playback_player(player)?;
        command.args.push(OsString::from("+spec_player"));
        command.args.push(OsString::from(player));
    }
    if let Some(timescale) = request.get("timescale").and_then(Value::as_f64) {
        if !timescale.is_finite() || !(0.1..=8.0).contains(&timescale) {
            return Err(DomainError::InvalidInput(
                "demo timescale must be between 0.1 and 8.0".to_owned(),
            ));
        }
        command.args.push(OsString::from("+demo_timescale"));
        command.args.push(OsString::from(timescale.to_string()));
    }
    Ok(command)
}

fn validate_playback_player(player: &str) -> Result<(), DomainError> {
    if player.is_empty()
        || player.len() > 128
        || player.trim() != player
        || player
            .chars()
            .any(|character| character.is_control() || matches!(character, '"' | ';' | '\\'))
    {
        return Err(DomainError::InvalidInput(
            "spectator target contains unsupported characters".to_owned(),
        ));
    }
    Ok(())
}

fn validate_expected_demo_hash(
    request: &Value,
    validated: &ValidatedDemo,
) -> Result<(), DomainError> {
    let Some(expected) = request
        .get("expected_sha256")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(DomainError::InvalidInput(
            "expected demo SHA-256 must contain exactly 64 hexadecimal characters".to_owned(),
        ));
    }
    if !validated.sha256.eq_ignore_ascii_case(expected) {
        return Err(DomainError::Conflict(
            "demo content changed after it was indexed; rescan it before playback".to_owned(),
        ));
    }
    Ok(())
}

#[derive(Debug)]
struct ManagedPlaybackEntry {
    name: OsString,
    bytes: u64,
    modified: std::time::SystemTime,
}

fn open_playback_data_directory(data_path: &Path) -> Result<PlaybackDataCapability, DomainError> {
    let metadata = fs::symlink_metadata(data_path)
        .map_err(|error| playback_cache_io("inspect playback data directory", &error))?;
    validate_ambient_plain_directory(data_path, &metadata)?;
    let directory = Dir::open_ambient_dir(data_path, ambient_authority())
        .map_err(|error| playback_cache_io("open playback data capability", &error))?;
    let opened = directory
        .dir_metadata()
        .map_err(|error| playback_cache_io("inspect playback data capability", &error))?;
    if !opened.is_dir() || capability_metadata_is_reparse(&opened) {
        return Err(DomainError::Conflict(
            "managed playback data capability is not a plain directory".to_owned(),
        ));
    }
    ensure_capability_directory_matches_ambient(
        &directory,
        data_path,
        "managed playback data directory changed while it was opened",
    )?;
    let absolute_path = fs::canonicalize(data_path)
        .map_err(|error| playback_cache_io("resolve playback data directory", &error))?;
    if !absolute_path.is_absolute() {
        return Err(DomainError::Internal(
            "resolved playback data directory is not absolute".to_owned(),
        ));
    }
    ensure_capability_directory_matches_ambient(
        &directory,
        &absolute_path,
        "resolved playback data directory does not match its capability",
    )?;
    Ok(PlaybackDataCapability {
        path: absolute_path,
        directory,
    })
}

fn stage_managed_playback(
    data: &PlaybackDataCapability,
    validated: &ValidatedDemo,
) -> Result<ManagedPlaybackSnapshot, DomainError> {
    if validated.sha256.len() != 64
        || !validated
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(DomainError::Internal(
            "validated demo returned an invalid content identity".to_owned(),
        ));
    }
    ensure_capability_directory_matches_ambient(
        &data.directory,
        &data.path,
        "managed playback data directory no longer matches its capability",
    )?;
    let directory = open_or_create_playback_cache(&data.directory)?;
    let directory_path = data.path.join("playback-cache");
    ensure_capability_directory_matches_ambient(
        &directory,
        &directory_path,
        "managed playback cache no longer matches its capability",
    )?;
    let target_name = OsString::from(format!("{}.dem", validated.sha256.to_ascii_lowercase()));
    let target_path = directory_path.join(&target_name);
    match directory.symlink_metadata(&target_name) {
        Ok(_) => {
            if let Some(file) =
                open_and_validate_managed_playback(&directory, &target_name, validated)?
            {
                prune_playback_cache(&directory, &target_name)?;
                verify_managed_playback_mapping(&directory, &file, &target_path)?;
                return Ok(ManagedPlaybackSnapshot {
                    path: target_path,
                    directory,
                    file,
                });
            }
            validate_capability_plain_file(&directory, &target_name)?;
            directory
                .remove_file(&target_name)
                .map_err(|error| playback_cache_io("remove invalid cached demo", &error))?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(playback_cache_io("inspect managed playback target", &error));
        }
    }

    let temporary_name = OsString::from(format!(
        ".{}.{}.partial.dem",
        validated.sha256,
        Uuid::new_v4()
    ));
    let staging_file =
        match copy_playback_snapshot(&validated.path, &directory, &temporary_name, validated) {
            Ok(file) => file,
            Err(error) => {
                let _ = directory.remove_file(&temporary_name);
                return Err(error);
            }
        };
    let staging_identity =
        match capability_file_matches_name(&directory, &temporary_name, &staging_file) {
            Ok(matches) => matches,
            Err(error) => {
                drop(staging_file);
                let _ = directory.remove_file(&temporary_name);
                return Err(error);
            }
        };
    if !staging_identity {
        drop(staging_file);
        let _ = directory.remove_file(&temporary_name);
        return Err(DomainError::Conflict(
            "managed playback staging file changed before publication".to_owned(),
        ));
    }
    match directory.hard_link(&temporary_name, &directory, &target_name) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            // A concurrent publisher is accepted only after its exact file handle
            // passes the same content and identity checks below.
        }
        Err(error) => {
            drop(staging_file);
            let _ = directory.remove_file(&temporary_name);
            return Err(playback_cache_io(
                "publish managed playback snapshot",
                &error,
            ));
        }
    }
    drop(staging_file);
    directory
        .remove_file(&temporary_name)
        .map_err(|error| playback_cache_io("remove playback snapshot staging file", &error))?;
    let published_file =
        match open_and_validate_managed_playback(&directory, &target_name, validated) {
            Ok(Some(file)) => file,
            Ok(None) => {
                return Err(DomainError::Conflict(
                    "managed playback cache changed during publication".to_owned(),
                ));
            }
            Err(error) => return Err(error),
        };
    prune_playback_cache(&directory, &target_name)?;
    verify_managed_playback_mapping(&directory, &published_file, &target_path)?;
    Ok(ManagedPlaybackSnapshot {
        path: target_path,
        directory,
        file: published_file,
    })
}

fn open_or_create_playback_cache(data_directory: &Dir) -> Result<Dir, DomainError> {
    match data_directory.create_dir("playback-cache") {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(playback_cache_io("create playback cache", &error)),
    }
    validate_capability_plain_directory(data_directory, "playback-cache")?;
    let directory = data_directory
        .open_dir("playback-cache")
        .map_err(|error| playback_cache_io("open playback cache capability", &error))?;
    let metadata = directory
        .dir_metadata()
        .map_err(|error| playback_cache_io("inspect playback cache capability", &error))?;
    if !metadata.is_dir() || capability_metadata_is_reparse(&metadata) {
        return Err(DomainError::Conflict(
            "managed playback cache capability is not a plain directory".to_owned(),
        ));
    }
    validate_capability_plain_directory(data_directory, "playback-cache")?;
    Ok(directory)
}

fn validate_capability_plain_directory(
    parent: &Dir,
    name: impl AsRef<Path>,
) -> Result<(), DomainError> {
    let metadata = parent
        .symlink_metadata(name.as_ref())
        .map_err(|error| playback_cache_io("inspect playback cache directory", &error))?;
    if !metadata.is_dir() || metadata.is_symlink() || capability_metadata_is_reparse(&metadata) {
        return Err(DomainError::Conflict(
            "managed playback cache is not a plain directory".to_owned(),
        ));
    }
    Ok(())
}

fn validate_capability_plain_file(
    directory: &Dir,
    name: impl AsRef<Path>,
) -> Result<(), DomainError> {
    let name = name.as_ref();
    let metadata = directory
        .symlink_metadata(name)
        .map_err(|error| playback_cache_io("inspect managed playback file", &error))?;
    if !metadata.is_file() || metadata.is_symlink() || capability_metadata_is_reparse(&metadata) {
        return Err(DomainError::Conflict(format!(
            "managed playback cache entry {} is not a plain file",
            name.display()
        )));
    }
    Ok(())
}

fn validate_ambient_plain_directory(
    path: &Path,
    metadata: &fs::Metadata,
) -> Result<(), DomainError> {
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || ambient_metadata_is_reparse(metadata)
    {
        return Err(DomainError::Conflict(format!(
            "managed playback path {} is not a plain directory",
            path.display()
        )));
    }
    Ok(())
}

fn validate_ambient_plain_file(path: &Path, metadata: &fs::Metadata) -> Result<(), DomainError> {
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || ambient_metadata_is_reparse(metadata)
    {
        return Err(DomainError::Conflict(format!(
            "managed playback path {} is not a plain file",
            path.display()
        )));
    }
    Ok(())
}

fn ensure_capability_directory_matches_ambient(
    directory: &Dir,
    path: &Path,
    message: &str,
) -> Result<(), DomainError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| playback_cache_io("inspect ambient playback directory", &error))?;
    validate_ambient_plain_directory(path, &metadata)?;
    let ambient = Dir::open_ambient_dir(path, ambient_authority())
        .map_err(|error| playback_cache_io("open ambient playback directory", &error))?;
    if !capability_directories_are_same(directory, &ambient)? {
        return Err(DomainError::Conflict(message.to_owned()));
    }
    Ok(())
}

fn capability_directories_are_same(first: &Dir, second: &Dir) -> Result<bool, DomainError> {
    let first = same_file::Handle::from_file(
        first
            .try_clone()
            .map_err(|error| playback_cache_io("clone first directory capability", &error))?
            .into_std_file(),
    )
    .map_err(|error| playback_cache_io("identify first directory capability", &error))?;
    let second = same_file::Handle::from_file(
        second
            .try_clone()
            .map_err(|error| playback_cache_io("clone second directory capability", &error))?
            .into_std_file(),
    )
    .map_err(|error| playback_cache_io("identify second directory capability", &error))?;
    Ok(first == second)
}

fn capability_file_matches_name(
    directory: &Dir,
    name: impl AsRef<Path>,
    file: &CapabilityFile,
) -> Result<bool, DomainError> {
    let name = name.as_ref();
    validate_capability_plain_file(directory, name)?;
    let named = directory
        .open(name)
        .map_err(|error| playback_cache_io("open managed playback identity", &error))?;
    validate_capability_plain_file(directory, name)?;
    let open_handle = same_file::Handle::from_file(
        file.try_clone()
            .map_err(|error| playback_cache_io("clone managed playback handle", &error))?
            .into_std(),
    )
    .map_err(|error| playback_cache_io("identify managed playback handle", &error))?;
    let named_handle = same_file::Handle::from_file(named.into_std())
        .map_err(|error| playback_cache_io("identify managed playback name", &error))?;
    Ok(open_handle == named_handle)
}

fn verify_managed_playback_mapping(
    directory: &Dir,
    file: &CapabilityFile,
    path: &Path,
) -> Result<(), DomainError> {
    let parent = path.parent().ok_or_else(|| {
        DomainError::Internal("managed playback path has no parent directory".to_owned())
    })?;
    ensure_capability_directory_matches_ambient(
        directory,
        parent,
        "managed playback cache path changed before launch",
    )?;
    let name = path.file_name().ok_or_else(|| {
        DomainError::Internal("managed playback path has no file name".to_owned())
    })?;
    if !capability_file_matches_name(directory, name, file)? {
        return Err(DomainError::Conflict(
            "managed playback cache file changed before launch".to_owned(),
        ));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| playback_cache_io("inspect ambient managed playback file", &error))?;
    validate_ambient_plain_file(path, &metadata)?;
    let ambient = StdFile::open(path)
        .map_err(|error| playback_cache_io("open ambient managed playback file", &error))?;
    let open_handle = same_file::Handle::from_file(
        file.try_clone()
            .map_err(|error| playback_cache_io("clone playback launch guard", &error))?
            .into_std(),
    )
    .map_err(|error| playback_cache_io("identify playback launch guard", &error))?;
    let ambient_handle = same_file::Handle::from_file(ambient)
        .map_err(|error| playback_cache_io("identify ambient playback file", &error))?;
    if open_handle != ambient_handle {
        return Err(DomainError::Conflict(
            "managed playback path no longer identifies the published file".to_owned(),
        ));
    }
    Ok(())
}

fn copy_playback_snapshot(
    source: &Path,
    directory: &Dir,
    temporary_name: &std::ffi::OsStr,
    validated: &ValidatedDemo,
) -> Result<CapabilityFile, DomainError> {
    let source_file =
        StdFile::open(source).map_err(|error| playback_cache_io("open source demo", &error))?;
    let source_metadata = source_file
        .metadata()
        .map_err(|error| playback_cache_io("inspect source demo", &error))?;
    if !source_metadata.is_file() || source_metadata.len() != validated.size {
        return Err(DomainError::Conflict(
            "demo changed after preflight; run preflight again".to_owned(),
        ));
    }
    let mut reader = source_file.take(validated.size.saturating_add(1));
    let mut options = CapabilityOpenOptions::new();
    options.read(true).write(true).create_new(true);
    configure_exclusive_managed_file_options(&mut options);
    let mut writer = directory
        .open_with(temporary_name, &options)
        .map_err(|error| playback_cache_io("create playback snapshot staging file", &error))?;
    let copied = std::io::copy(&mut reader, &mut writer)
        .map_err(|error| playback_cache_io("copy demo into playback cache", &error))?;
    if copied != validated.size {
        return Err(DomainError::Conflict(
            "demo changed while the playback snapshot was copied".to_owned(),
        ));
    }
    writer
        .flush()
        .map_err(|error| playback_cache_io("flush playback snapshot", &error))?;
    writer
        .sync_all()
        .map_err(|error| playback_cache_io("persist playback snapshot", &error))?;
    if !validate_opened_managed_playback(&mut writer, validated)? {
        return Err(DomainError::Conflict(
            "demo changed after preflight; the playback snapshot was rejected".to_owned(),
        ));
    }
    Ok(writer)
}

fn open_and_validate_managed_playback(
    directory: &Dir,
    name: impl AsRef<Path>,
    expected: &ValidatedDemo,
) -> Result<Option<CapabilityFile>, DomainError> {
    let name = name.as_ref();
    validate_capability_plain_file(directory, name)?;
    let mut options = CapabilityOpenOptions::new();
    options.read(true);
    configure_exclusive_managed_file_options(&mut options);
    let mut file = directory
        .open_with(name, &options)
        .map_err(|error| playback_cache_io("open managed playback demo", &error))?;
    let metadata = file
        .metadata()
        .map_err(|error| playback_cache_io("inspect opened managed playback demo", &error))?;
    if !metadata.is_file() || capability_metadata_is_reparse(&metadata) {
        return Err(DomainError::Conflict(
            "managed playback cache contains a non-regular demo".to_owned(),
        ));
    }
    if !capability_file_matches_name(directory, name, &file)? {
        return Err(DomainError::Conflict(
            "managed playback cache entry changed while it was opened".to_owned(),
        ));
    }
    let valid = validate_opened_managed_playback(&mut file, expected)?;
    if !capability_file_matches_name(directory, name, &file)? {
        return Err(DomainError::Conflict(
            "managed playback cache entry changed while it was validated".to_owned(),
        ));
    }
    Ok(valid.then_some(file))
}

fn validate_opened_managed_playback(
    file: &mut CapabilityFile,
    expected: &ValidatedDemo,
) -> Result<bool, DomainError> {
    let initial = file
        .metadata()
        .map_err(|error| playback_cache_io("inspect managed playback demo", &error))?;
    if !initial.is_file()
        || capability_metadata_is_reparse(&initial)
        || initial.len() != expected.size
    {
        return Ok(false);
    }
    let initial_modified = initial.modified().ok();
    file.seek(SeekFrom::Start(0))
        .map_err(|error| playback_cache_io("rewind managed playback demo", &error))?;
    let mut hasher = Sha256::new();
    let mut magic = [0_u8; 8];
    file.read_exact(&mut magic)
        .map_err(|error| playback_cache_io("read managed playback header", &error))?;
    if &magic != SOURCE2_DEMO_MAGIC {
        return Ok(false);
    }
    hasher.update(magic);
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut total = u64::try_from(magic.len()).unwrap_or(u64::MAX);
    let maximum = expected.size.saturating_add(1);
    loop {
        let remaining = maximum.saturating_sub(total);
        if remaining == 0 {
            break;
        }
        let limit = usize::try_from(remaining)
            .unwrap_or(usize::MAX)
            .min(buffer.len());
        let count = file
            .read(&mut buffer[..limit])
            .map_err(|error| playback_cache_io("hash managed playback demo", &error))?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(u64::try_from(count).unwrap_or(u64::MAX))
            .ok_or_else(|| {
                DomainError::Internal(
                    "managed playback byte count overflowed while hashing".to_owned(),
                )
            })?;
        hasher.update(&buffer[..count]);
    }
    let final_metadata = file
        .metadata()
        .map_err(|error| playback_cache_io("reinspect managed playback demo", &error))?;
    let modified_changed = initial_modified
        .zip(final_metadata.modified().ok())
        .is_some_and(|(before, after)| before != after);
    file.seek(SeekFrom::Start(0))
        .map_err(|error| playback_cache_io("reset managed playback demo", &error))?;
    Ok(total == expected.size
        && final_metadata.len() == expected.size
        && !modified_changed
        && hex::encode(hasher.finalize()).eq_ignore_ascii_case(&expected.sha256))
}

#[cfg(windows)]
fn configure_exclusive_managed_file_options(options: &mut CapabilityOpenOptions) {
    use cap_std::fs::OpenOptionsExt as _;

    const FILE_SHARE_READ: u32 = 0x0000_0001;
    options.share_mode(FILE_SHARE_READ);
}

#[cfg(not(windows))]
fn configure_exclusive_managed_file_options(_options: &mut CapabilityOpenOptions) {}

#[cfg(windows)]
fn capability_metadata_is_reparse(metadata: &cap_std::fs::Metadata) -> bool {
    use cap_std::fs::MetadataExt as _;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn capability_metadata_is_reparse(_metadata: &cap_std::fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
fn ambient_metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn ambient_metadata_is_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

fn prune_playback_cache(
    directory: &Dir,
    protected_name: &std::ffi::OsStr,
) -> Result<(), DomainError> {
    let mut entries = Vec::new();
    let mut scanned = 0_usize;
    for entry in directory
        .entries()
        .map_err(|error| playback_cache_io("list playback cache", &error))?
    {
        scanned = scanned.saturating_add(1);
        if scanned > MAXIMUM_PLAYBACK_CACHE_SCAN_ENTRIES {
            return Err(DomainError::Conflict(
                "managed playback cache contains too many entries".to_owned(),
            ));
        }
        let entry =
            entry.map_err(|error| playback_cache_io("read playback cache entry", &error))?;
        let file_name = entry.file_name();
        let Some(file_name_text) = file_name.to_str() else {
            continue;
        };
        if is_managed_playback_partial_name(file_name_text) {
            let metadata = directory
                .symlink_metadata(&file_name)
                .map_err(|error| playback_cache_io("inspect playback staging entry", &error))?;
            if metadata.is_file()
                && !metadata.is_symlink()
                && !capability_metadata_is_reparse(&metadata)
                && metadata
                    .modified()
                    .ok()
                    .and_then(|modified| modified.into_std().elapsed().ok())
                    .is_some_and(|age| age >= PLAYBACK_PARTIAL_STALE_AGE)
            {
                let _ = directory.remove_file(&file_name);
            }
            continue;
        }
        if !is_managed_playback_name(file_name_text) {
            continue;
        }
        let metadata = directory
            .symlink_metadata(&file_name)
            .map_err(|error| playback_cache_io("inspect playback cache entry", &error))?;
        if !metadata.is_file() || metadata.is_symlink() || capability_metadata_is_reparse(&metadata)
        {
            continue;
        }
        entries.push(ManagedPlaybackEntry {
            name: file_name,
            bytes: metadata.len(),
            modified: metadata
                .modified()
                .map_or(std::time::UNIX_EPOCH, cap_std::time::SystemTime::into_std),
        });
    }
    entries.sort_by_key(|entry| entry.modified);
    let mut total_bytes = entries
        .iter()
        .fold(0_u64, |total, entry| total.saturating_add(entry.bytes));
    while entries.len() > MAXIMUM_PLAYBACK_CACHE_ENTRIES
        || total_bytes > MAXIMUM_PLAYBACK_CACHE_BYTES
    {
        let Some(index) = entries
            .iter()
            .position(|entry| entry.name != protected_name)
        else {
            break;
        };
        let entry = entries.remove(index);
        if validate_capability_plain_file(directory, &entry.name).is_err() {
            continue;
        }
        match directory.remove_file(&entry.name) {
            Ok(()) => total_bytes = total_bytes.saturating_sub(entry.bytes),
            Err(error) => {
                tracing::warn!(
                    %error,
                    name = %entry.name.to_string_lossy(),
                    "unable to prune a managed playback cache entry"
                );
            }
        }
    }
    Ok(())
}

fn is_managed_playback_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() == 68
        && bytes[..64].iter().all(u8::is_ascii_hexdigit)
        && bytes[64..].eq_ignore_ascii_case(b".dem")
}

fn is_managed_playback_partial_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix('.') else {
        return false;
    };
    let Some((hash, rest)) = rest.split_once('.') else {
        return false;
    };
    let Some(uuid) = rest.strip_suffix(".partial.dem") else {
        return false;
    };
    hash.len() == 64
        && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        && Uuid::parse_str(uuid).is_ok()
}

fn playback_cache_io(operation: &str, error: &std::io::Error) -> DomainError {
    DomainError::Internal(format!("{operation}: {error}"))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct RecoveryMarker {
    recovery_required: bool,
    target: String,
    had_previous: bool,
    installed_at: DateTime<Utc>,
}

fn gsi_config_path(config: &AppConfig) -> Option<PathBuf> {
    let executable = discover_paths(config).cs2?;
    gsi_config_path_from_executable(&executable)
}

fn gsi_config_path_from_executable(executable: &Path) -> Option<PathBuf> {
    executable
        .ancestors()
        .find(|path| {
            path.file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("game"))
        })
        .map(|game| game.join("csgo/cfg").join(GSI_FILE_NAME))
}

fn validate_loopback_uri(value: &str) -> Result<(), DomainError> {
    if value.len() > 2_048 || value.contains(['\0', '\r', '\n', '"']) {
        return Err(DomainError::InvalidInput(
            "GSI URI contains unsupported characters".to_owned(),
        ));
    }
    let uri = Url::parse(value)
        .map_err(|error| DomainError::InvalidInput(format!("invalid GSI URI: {error}")))?;
    if uri.scheme() != "http"
        || !uri.username().is_empty()
        || uri.password().is_some()
        || uri.host_str().is_none_or(|host| {
            !matches!(
                host.to_ascii_lowercase().as_str(),
                "localhost" | "127.0.0.1" | "::1"
            )
        })
    {
        return Err(DomainError::InvalidInput(
            "GSI URI must be an unauthenticated loopback HTTP URL".to_owned(),
        ));
    }
    Ok(())
}

fn marker_path(data_dir: &Path) -> PathBuf {
    data_dir.join("recovery/config-backup.json")
}

async fn read_marker(data_dir: &Path) -> Result<Option<RecoveryMarker>, DomainError> {
    let path = marker_path(data_dir);
    let metadata = match tokio::fs::metadata(&path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error("inspect recovery marker", &error)),
    };
    if !metadata.is_file() || metadata.len() > MAXIMUM_RECOVERY_MARKER_BYTES {
        return Err(DomainError::InvalidInput(
            "configuration recovery marker is invalid or too large".to_owned(),
        ));
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| io_error("read recovery marker", &error))?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| DomainError::InvalidInput(format!("invalid recovery marker: {error}")))
}

async fn write_marker(data_dir: &Path, marker: &RecoveryMarker) -> Result<(), DomainError> {
    let bytes = serde_json::to_vec(marker).map_err(|error| json_error(&error))?;
    write_atomic(&marker_path(data_dir), &bytes).await
}

async fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), DomainError> {
    let parent = path.parent().ok_or_else(|| {
        DomainError::InvalidInput("managed file has no parent directory".to_owned())
    })?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| io_error("create managed file directory", &error))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("managed-file");
    let temporary = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));
    let write_result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await
            .map_err(|error| io_error("create temporary managed file", &error))?;
        file.write_all(bytes)
            .await
            .map_err(|error| io_error("write temporary managed file", &error))?;
        file.flush()
            .await
            .map_err(|error| io_error("flush temporary managed file", &error))?;
        file.sync_all()
            .await
            .map_err(|error| io_error("sync temporary managed file", &error))?;
        Ok::<_, DomainError>(())
    }
    .await;
    if let Err(error) = write_result {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }
    let publication = publish_temporary(&temporary, path).await;
    if publication.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    publication
}

#[cfg(not(windows))]
async fn publish_temporary(temporary: &Path, target: &Path) -> Result<(), DomainError> {
    tokio::fs::rename(temporary, target)
        .await
        .map_err(|error| io_error("publish managed file", &error))
}

#[cfg(windows)]
async fn publish_temporary(temporary: &Path, target: &Path) -> Result<(), DomainError> {
    let metadata = match tokio::fs::metadata(target).await {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(io_error("inspect managed file target", &error)),
    };
    let Some(metadata) = metadata else {
        return tokio::fs::rename(temporary, target)
            .await
            .map_err(|error| io_error("publish managed file", &error));
    };
    if !metadata.is_file() {
        return Err(DomainError::Conflict(
            "managed file target is not a regular file".to_owned(),
        ));
    }

    let parent = target.parent().ok_or_else(|| {
        DomainError::InvalidInput("managed file has no parent directory".to_owned())
    })?;
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("managed-file");
    let displaced = parent.join(format!(".{file_name}.{}.previous", Uuid::new_v4()));
    tokio::fs::rename(target, &displaced)
        .await
        .map_err(|error| io_error("stage previous managed file", &error))?;

    match tokio::fs::rename(temporary, target).await {
        Ok(()) => {
            if let Err(error) = tokio::fs::remove_file(&displaced).await {
                tracing::warn!(
                    %error,
                    path = %displaced.display(),
                    "published managed file but could not remove displaced copy"
                );
            }
            Ok(())
        }
        Err(publication_error) => {
            if let Err(rollback_error) = tokio::fs::rename(&displaced, target).await {
                tracing::error!(
                    error = %rollback_error,
                    path = %displaced.display(),
                    "managed file publication and automatic rollback both failed; displaced copy was preserved"
                );
                return Err(DomainError::Internal(format!(
                    "publish managed file: {publication_error}; previous file remains at {}",
                    displaced.display()
                )));
            }
            Err(io_error("publish managed file", &publication_error))
        }
    }
}

fn playback_child_error(operation: &str, process_id: u32, error: &std::io::Error) -> DomainError {
    DomainError::DependencyUnavailable(format!(
        "unable to {operation} exact playback process {process_id}: {error}"
    ))
}

fn playback_stopped_response(
    process_id: Option<u32>,
    already_stopped: bool,
    forced_process_stop: bool,
) -> Value {
    json!({
        "stopped": true,
        "process_id": process_id,
        "already_stopped": already_stopped,
        "forced_process_stop": forced_process_stop,
    })
}

fn integration_error(error: IntegrationError) -> DomainError {
    match error {
        IntegrationError::NotConfigured {
            integration,
            message,
        }
        | IntegrationError::Unavailable {
            integration,
            message,
        } => DomainError::DependencyUnavailable(format!("{integration}: {message}")),
        IntegrationError::InvalidConfiguration(message)
        | IntegrationError::InvalidInput(message)
        | IntegrationError::Protocol(message) => DomainError::InvalidInput(message),
        IntegrationError::HttpStatus { status, message } => DomainError::DependencyUnavailable(
            format!("remote service returned HTTP {status}: {message}"),
        ),
        IntegrationError::ResponseLimit(limit) => {
            DomainError::InvalidInput(format!("integration response exceeded {limit} bytes"))
        }
        IntegrationError::Cancelled => DomainError::Conflict("download cancelled".to_owned()),
        IntegrationError::Io { path, source } => DomainError::DependencyUnavailable(format!(
            "I/O failure for {}: {source}",
            path.display()
        )),
        IntegrationError::Http(error) => {
            DomainError::DependencyUnavailable(format!("integration request failed: {error}"))
        }
        IntegrationError::Url(error) => DomainError::InvalidInput(format!("invalid URL: {error}")),
        IntegrationError::Json(error) => {
            DomainError::InvalidInput(format!("invalid integration response: {error}"))
        }
    }
}

fn storage_error(error: &vibe_cs_storage::StorageError) -> DomainError {
    match error {
        vibe_cs_storage::StorageError::Domain(DomainError::NotFound(message)) => {
            DomainError::NotFound(message.clone())
        }
        vibe_cs_storage::StorageError::Domain(DomainError::InvalidInput(message)) => {
            DomainError::InvalidInput(message.clone())
        }
        vibe_cs_storage::StorageError::Domain(DomainError::Conflict(message)) => {
            DomainError::Conflict(message.clone())
        }
        vibe_cs_storage::StorageError::Domain(DomainError::DependencyUnavailable(message)) => {
            DomainError::DependencyUnavailable(message.clone())
        }
        vibe_cs_storage::StorageError::Domain(DomainError::CleanupFailed(message)) => {
            DomainError::CleanupFailed(message.clone())
        }
        vibe_cs_storage::StorageError::Domain(DomainError::Internal(message)) => {
            DomainError::Internal(message.clone())
        }
        _ => DomainError::Internal(format!("storage operation failed: {error}")),
    }
}

fn json_error(error: &serde_json::Error) -> DomainError {
    DomainError::Internal(format!("JSON operation failed: {error}"))
}

fn io_error(operation: &str, error: &std::io::Error) -> DomainError {
    DomainError::Internal(format!("{operation}: {error}"))
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use bzip2::{Compression, write::BzEncoder};

    use super::*;

    #[derive(Debug)]
    struct FakeSteamBackend {
        history: Vec<SteamMatchReference>,
        block_download: bool,
    }

    #[async_trait]
    impl RuntimeSteamBackend for FakeSteamBackend {
        async fn history(
            &self,
            _api_key: SecretString,
            request: MatchHistoryRequest,
        ) -> Result<Vec<SteamMatchReference>, IntegrationError> {
            request.validate()?;
            Ok(self.history.clone())
        }

        async fn download(
            &self,
            _api_key: SecretString,
            request: DemoDownloadRequest,
            cancellation: DownloadCancellation,
            observer: Arc<dyn DemoDownloadObserver>,
        ) -> Result<PathBuf, IntegrationError> {
            request.validate()?;
            if self.block_download {
                observer
                    .update(DemoDownloadProgress {
                        downloaded_bytes: 1,
                        total_bytes: Some(10),
                    })
                    .await?;
                loop {
                    if cancellation.is_cancelled() {
                        return Err(IntegrationError::Cancelled);
                    }
                    tokio::task::yield_now().await;
                }
            }
            let mut encoder = BzEncoder::new(Vec::new(), Compression::best());
            encoder
                .write_all(b"PBDEMS2\0fixture!")
                .map_err(|source| IntegrationError::Io {
                    path: request.destination.clone(),
                    source,
                })?;
            let archive = encoder.finish().map_err(|source| IntegrationError::Io {
                path: request.destination.clone(),
                source,
            })?;
            tokio::fs::write(&request.destination, &archive)
                .await
                .map_err(|source| IntegrationError::Io {
                    path: request.destination.clone(),
                    source,
                })?;
            observer
                .update(DemoDownloadProgress {
                    downloaded_bytes: u64::try_from(archive.len()).unwrap_or(u64::MAX),
                    total_bytes: Some(u64::try_from(archive.len()).unwrap_or(u64::MAX)),
                })
                .await?;
            Ok(request.destination)
        }
    }

    #[derive(Debug)]
    struct PanickingSteamBackend;

    #[async_trait]
    impl RuntimeSteamBackend for PanickingSteamBackend {
        async fn history(
            &self,
            _api_key: SecretString,
            request: MatchHistoryRequest,
        ) -> Result<Vec<SteamMatchReference>, IntegrationError> {
            request.validate()?;
            Ok(Vec::new())
        }

        async fn download(
            &self,
            _api_key: SecretString,
            _request: DemoDownloadRequest,
            _cancellation: DownloadCancellation,
            _observer: Arc<dyn DemoDownloadObserver>,
        ) -> Result<PathBuf, IntegrationError> {
            panic!("injected Steam backend panic");
        }
    }

    fn same_path_for_test(left: &Path, right: &Path) -> bool {
        let normalize = |path: &Path| {
            std::fs::canonicalize(path)
                .unwrap_or_else(|_| path.to_path_buf())
                .to_string_lossy()
                .trim_start_matches(r"\\?\")
                .to_lowercase()
        };
        normalize(left) == normalize(right)
    }

    fn sharing_code(match_id: u64, outcome_id: u64, token: u16) -> String {
        const ALPHABET: &[u8; 57] = b"ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789";
        let mut bytes = [0_u8; 18];
        bytes[0..8].copy_from_slice(&match_id.to_le_bytes());
        bytes[8..16].copy_from_slice(&outcome_id.to_le_bytes());
        bytes[16..18].copy_from_slice(&token.to_le_bytes());
        let mut compact = String::with_capacity(25);
        for _ in 0..25 {
            let mut remainder = 0_u16;
            for byte in bytes.iter_mut().rev() {
                let value = (remainder << 8) | u16::from(*byte);
                *byte = u8::try_from(value / 57).unwrap_or_default();
                remainder = value % 57;
            }
            compact.push(ALPHABET[usize::from(remainder)] as char);
        }
        format!(
            "CSGO-{}-{}-{}-{}-{}",
            &compact[0..5],
            &compact[5..10],
            &compact[10..15],
            &compact[15..20],
            &compact[20..25]
        )
    }

    fn steam_config(known_share_code: String) -> SteamConfig {
        SteamConfig {
            steam_id: "76561198000000000".to_owned(),
            web_api_key: "a".repeat(32),
            authentication_code: "ABCD-EFGHI-JKLM".to_owned(),
            known_share_code,
            maximum_results: 20,
        }
    }

    fn cataloged_demo(path: &str, match_date: Option<DateTime<Utc>>) -> DemoRecord {
        let now = Utc::now();
        DemoRecord {
            id: Uuid::new_v4(),
            path: path.to_owned(),
            file_name: "match.dem".to_owned(),
            display_name: "Cataloged match".to_owned(),
            source: "download".to_owned(),
            status: DemoStatus::Ready,
            map_name: Some("de_nuke".to_owned()),
            match_date,
            duration_seconds: Some(2_345.5),
            total_rounds: Some(24),
            team_a_name: Some("Alpha".to_owned()),
            team_b_name: Some("Bravo".to_owned()),
            team_a_score: Some(13),
            team_b_score: Some(11),
            player_names: vec!["Player One".to_owned()],
            remark: "analyzed locally".to_owned(),
            content_sha256: Some("a".repeat(64)),
            file_size: 16,
            created_at: now - chrono::Duration::days(10),
            updated_at: now - chrono::Duration::days(1),
        }
    }

    #[test]
    fn playback_command_keeps_all_dynamic_values_in_separate_arguments() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let executable = directory
            .path()
            .join(if cfg!(windows) { "cs2.exe" } else { "cs2" });
        let demo = directory.path().join("match with spaces.dem");
        std::fs::write(&executable, b"stub").expect("CS2 stub");
        std::fs::write(&demo, b"PBDEMS2\0").expect("demo stub");
        let config = AppConfig {
            cs2_path: executable.to_string_lossy().into_owned(),
            ..AppConfig::default()
        };

        let command = build_playback_command(
            &config,
            &json!({
                "path": demo,
                "start_tick": 42_000,
                "player": "Player One",
                "timescale": 0.5,
            }),
        )
        .expect("playback command");
        let args = command
            .args
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert!(
            args.windows(2)
                .any(|pair| pair == ["+demo_gototick", "42000"])
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["+spec_player", "Player One"])
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["+demo_timescale", "0.5"])
        );
        assert!(args.iter().any(|argument| argument == "+playdemo"));
    }

    #[test]
    fn playback_player_rejects_console_injection_characters() {
        assert!(validate_playback_player("player;quit").is_err());
        assert!(validate_playback_player("player\nquit").is_err());
        assert!(validate_playback_player("player one").is_ok());
    }

    #[test]
    fn playback_command_rejects_ticks_outside_the_game_console_range() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let executable = directory
            .path()
            .join(if cfg!(windows) { "cs2.exe" } else { "cs2" });
        let demo = directory.path().join("match.dem");
        std::fs::write(&executable, b"stub").expect("CS2 stub");
        std::fs::write(&demo, b"PBDEMS2\0fixture!").expect("demo fixture");
        let config = AppConfig {
            cs2_path: executable.to_string_lossy().into_owned(),
            ..AppConfig::default()
        };

        let result = build_playback_command(
            &config,
            &json!({ "path": demo, "start_tick": MAXIMUM_PLAYBACK_TICK + 1 }),
        );

        assert!(matches!(result, Err(DomainError::InvalidInput(_))));
    }

    #[tokio::test]
    async fn playback_preflight_validates_content_hash_and_reports_fresh_control_evidence() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let game = directory.path().join("game");
        let executable = game
            .join("bin/win64")
            .join(if cfg!(windows) { "cs2.exe" } else { "cs2" });
        let gsi_config = game.join("csgo/cfg").join(GSI_FILE_NAME);
        let demo = directory.path().join("verified.dem");
        std::fs::create_dir_all(executable.parent().expect("executable parent"))
            .expect("create executable directory");
        std::fs::create_dir_all(gsi_config.parent().expect("GSI parent"))
            .expect("create GSI directory");
        std::fs::write(&executable, b"stub").expect("CS2 stub");
        std::fs::write(&gsi_config, b"managed").expect("GSI config");
        std::fs::write(&demo, b"PBDEMS2\0fixture!").expect("demo fixture");

        let storage = Storage::open_in_memory().await.expect("storage");
        storage
            .put_config(AppConfig {
                cs2_path: executable.to_string_lossy().into_owned(),
                ..AppConfig::default()
            })
            .await
            .expect("config");
        let gsi = Arc::new(RwLock::new(GsiState::default()));
        let port = RuntimeIntegrationPort::new_with_state(
            storage,
            directory.path().join("data"),
            Arc::clone(&gsi),
        );
        port.apply_gsi(
            serde_json::from_value(json!({
                "provider": { "appid": 730 },
                "map": { "name": "de_mirage", "phase": "live" },
                "player": { "name": "Player One", "activity": "playing" }
            }))
            .expect("GSI payload"),
            Utc::now(),
        )
        .await;

        let response = port
            .request(
                "demo_playback_preflight",
                json!({ "path": demo, "start_tick": 1_024 }),
            )
            .await
            .expect("preflight");
        assert_eq!(response["ready"], true);
        assert_eq!(response["demo_size"], 16);
        assert_eq!(response["status"]["gsi_ready"], true);
        assert_eq!(response["status"]["map_name"], "de_mirage");
        let sha256 = response["demo_sha256"]
            .as_str()
            .expect("validated hash")
            .to_owned();
        assert_eq!(sha256.len(), 64);

        let mismatch = port
            .request(
                "demo_playback_preflight",
                json!({ "path": demo, "expected_sha256": "0".repeat(64) }),
            )
            .await
            .expect_err("changed content must fail");
        assert!(matches!(mismatch, DomainError::Conflict(_)));
    }

    #[test]
    fn managed_playback_snapshot_is_content_addressed_and_rejects_source_drift() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let source = directory.path().join("source.dem");
        std::fs::write(&source, b"PBDEMS2\0fixture!").expect("source demo");
        let validated = validate_demo(
            &source,
            ValidationLimits::default(),
            &ParseCancellation::default(),
        )
        .expect("validated source");
        let data_directory =
            open_playback_data_directory(directory.path()).expect("data capability");
        std::fs::write(&source, b"PBDEMS2\0changed!").expect("changed source");

        let cache = directory.path().join("playback-cache");
        let error = stage_managed_playback(&data_directory, &validated)
            .expect_err("source drift must be rejected");

        assert!(matches!(error, DomainError::Conflict(_)));
        let published = std::fs::read_dir(&cache)
            .expect("cache directory")
            .filter_map(Result::ok)
            .filter(|entry| is_managed_playback_name(&entry.file_name().to_string_lossy()))
            .count();
        assert_eq!(published, 0);

        std::fs::write(&source, b"PBDEMS2\0fixture!").expect("restore source");
        let snapshot =
            stage_managed_playback(&data_directory, &validated).expect("managed snapshot");
        assert_ne!(snapshot.path, source);
        assert_eq!(
            validate_demo(
                &snapshot.path,
                ValidationLimits::default(),
                &ParseCancellation::default()
            )
            .expect("snapshot validation")
            .sha256,
            validated.sha256
        );
    }

    #[test]
    fn relative_data_directory_produces_an_absolute_capability_bound_launch_path() {
        let current_directory = std::env::current_dir().expect("current directory");
        let test_root = current_directory
            .join("target")
            .join("runtime-capability-tests");
        std::fs::create_dir_all(&test_root).expect("relative test root");
        let directory = tempfile::Builder::new()
            .prefix("relative-data-")
            .tempdir_in(&test_root)
            .expect("relative temporary directory");
        let data_path = directory.path().join("data");
        std::fs::create_dir(&data_path).expect("data directory");
        let relative_data_path = data_path
            .strip_prefix(&current_directory)
            .expect("test data is below the current directory");
        assert!(!relative_data_path.is_absolute());
        let source = directory.path().join("source.dem");
        std::fs::write(&source, b"PBDEMS2\0fixture!").expect("source demo");
        let validated = validate_demo(
            &source,
            ValidationLimits::default(),
            &ParseCancellation::default(),
        )
        .expect("validated source");

        let data_directory =
            open_playback_data_directory(relative_data_path).expect("relative data capability");
        let snapshot =
            stage_managed_playback(&data_directory, &validated).expect("managed snapshot");

        assert!(data_directory.path.is_absolute());
        assert!(snapshot.path.is_absolute());
        assert!(snapshot.path.starts_with(&data_directory.path));
        verify_managed_playback_mapping(&snapshot.directory, &snapshot.file, &snapshot.path)
            .expect("absolute launch path remains bound to the capability file");
    }

    #[test]
    fn managed_playback_rejects_a_static_cache_link_without_touching_external_files() {
        let data = tempfile::tempdir().expect("data directory");
        let external = tempfile::tempdir().expect("external directory");
        let source = data.path().join("source.dem");
        std::fs::write(&source, b"PBDEMS2\0fixture!").expect("source demo");
        let validated = validate_demo(
            &source,
            ValidationLimits::default(),
            &ParseCancellation::default(),
        )
        .expect("validated source");
        let external_demo = external.path().join(format!("{}.dem", validated.sha256));
        std::fs::write(&external_demo, b"external sentinel").expect("external sentinel");
        if let Err(error) =
            create_directory_link(external.path(), &data.path().join("playback-cache"))
        {
            #[cfg(windows)]
            if error.kind() == std::io::ErrorKind::PermissionDenied {
                return;
            }
            panic!("create static cache link: {error}");
        }
        let data_directory = open_playback_data_directory(data.path()).expect("data capability");

        let error = stage_managed_playback(&data_directory, &validated)
            .expect_err("linked cache must be rejected");

        assert!(matches!(error, DomainError::Conflict(_)));
        assert_eq!(
            std::fs::read(&external_demo).expect("read external sentinel"),
            b"external sentinel"
        );
    }

    #[test]
    fn capability_prune_never_unlinks_an_external_managed_name() {
        let data = tempfile::tempdir().expect("data directory");
        let external = tempfile::tempdir().expect("external directory");
        let data_directory = open_playback_data_directory(data.path()).expect("data capability");
        let cache =
            open_or_create_playback_cache(&data_directory.directory).expect("cache capability");
        let protected = format!("{}.dem", "f".repeat(64));
        for digit in ['a', 'b', 'c', 'd', 'f'] {
            std::fs::write(
                data.path()
                    .join("playback-cache")
                    .join(format!("{}.dem", digit.to_string().repeat(64))),
                b"cached",
            )
            .expect("cache entry");
        }
        let external_name = format!("{}.dem", "a".repeat(64));
        let external_demo = external.path().join(&external_name);
        std::fs::write(&external_demo, b"external sentinel").expect("external sentinel");

        prune_playback_cache(&cache, std::ffi::OsStr::new(&protected)).expect("prune cache");

        assert_eq!(
            std::fs::read(&external_demo).expect("read external sentinel"),
            b"external sentinel"
        );
        assert!(data.path().join("playback-cache").join(protected).exists());
    }

    #[cfg(not(windows))]
    #[test]
    fn replaced_data_ancestor_is_rejected_before_cache_mutation() {
        let root = tempfile::tempdir().expect("temporary directory");
        let data_path = root.path().join("data");
        let detached_path = root.path().join("detached-data");
        std::fs::create_dir(&data_path).expect("data directory");
        let data_directory = open_playback_data_directory(&data_path).expect("data capability");
        std::fs::rename(&data_path, &detached_path).expect("detach original data directory");
        std::fs::create_dir_all(data_path.join("playback-cache"))
            .expect("replacement cache directory");
        let source = root.path().join("source.dem");
        std::fs::write(&source, b"PBDEMS2\0fixture!").expect("source demo");
        let validated = validate_demo(
            &source,
            ValidationLimits::default(),
            &ParseCancellation::default(),
        )
        .expect("validated source");
        let replacement_sentinel = data_path
            .join("playback-cache")
            .join(format!("{}.dem", validated.sha256));
        std::fs::write(&replacement_sentinel, b"replacement sentinel")
            .expect("replacement sentinel");

        let error = stage_managed_playback(&data_directory, &validated)
            .expect_err("replaced data ancestor must be rejected");

        assert!(matches!(error, DomainError::Conflict(_)));
        assert_eq!(
            std::fs::read(&replacement_sentinel).expect("read replacement sentinel"),
            b"replacement sentinel"
        );
        assert!(!detached_path.join("playback-cache").exists());
    }

    #[cfg(windows)]
    #[test]
    fn playback_capability_guards_deny_file_and_ancestor_mutation_until_released() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let managed_root = directory.path().join("managed-root");
        let data = managed_root.join("data");
        std::fs::create_dir_all(&data).expect("data directory");
        let source = directory.path().join("source.dem");
        std::fs::write(&source, b"PBDEMS2\0fixture!").expect("source demo");
        let validated = validate_demo(
            &source,
            ValidationLimits::default(),
            &ParseCancellation::default(),
        )
        .expect("validated source");
        let data_directory = open_playback_data_directory(&data).expect("data capability");
        let snapshot =
            stage_managed_playback(&data_directory, &validated).expect("managed snapshot");

        assert!(
            std::fs::OpenOptions::new()
                .write(true)
                .open(&snapshot.path)
                .is_err()
        );
        assert!(
            std::fs::rename(
                data.join("playback-cache"),
                data.join("moved-playback-cache")
            )
            .is_err()
        );
        assert!(std::fs::rename(&data, directory.path().join("moved-data")).is_err());
        assert!(
            std::fs::rename(&managed_root, directory.path().join("moved-managed-root")).is_err()
        );
        let path = snapshot.path.clone();
        drop(snapshot);
        drop(data_directory);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("write access after guard release");
    }

    #[cfg(unix)]
    fn create_directory_link(original: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(original, link)
    }

    #[cfg(windows)]
    fn create_directory_link(original: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(original, link)
    }

    fn spawn_running_playback_test_child() -> tokio::process::Child {
        #[cfg(windows)]
        let mut process = {
            let mut process = tokio::process::Command::new("ping.exe");
            process.args(["-n", "30", "127.0.0.1"]);
            process
        };
        #[cfg(not(windows))]
        let mut process = {
            let mut process = tokio::process::Command::new("sleep");
            process.arg("30");
            process
        };
        process
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        process.spawn().expect("long-running test child")
    }

    fn spawn_exiting_playback_test_child() -> tokio::process::Child {
        #[cfg(windows)]
        let mut process = {
            let mut process = tokio::process::Command::new("cmd.exe");
            process.args(["/D", "/S", "/C", "exit /B 0"]);
            process
        };
        #[cfg(not(windows))]
        let mut process = {
            let mut process = tokio::process::Command::new("sh");
            process.args(["-c", "exit 0"]);
            process
        };
        process
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        process.spawn().expect("exiting test child")
    }

    fn assert_tracked_playback_is_running(
        port: &RuntimeIntegrationPort,
        expected_token: Uuid,
        expected_process_id: u32,
    ) {
        let mut tracked = port
            .tracked_playback
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match &mut *tracked {
            TrackedPlaybackState::Active {
                token,
                process_id,
                child,
            } => {
                assert_eq!(*token, expected_token);
                assert_eq!(*process_id, expected_process_id);
                assert!(
                    child
                        .try_wait()
                        .expect("inspect tracked test child")
                        .is_none(),
                    "tracked test child exited unexpectedly"
                );
            }
            state => panic!("expected active playback, got {state:?}"),
        }
    }

    fn assert_tracked_playback_is_stopped(
        port: &RuntimeIntegrationPort,
        expected_token: Uuid,
        expected_process_id: u32,
    ) {
        let tracked = port
            .tracked_playback
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(matches!(
            &*tracked,
            TrackedPlaybackState::Stopped { token, process_id }
                if *token == expected_token && *process_id == expected_process_id
        ));
    }

    #[tokio::test]
    async fn playback_stop_is_idempotent_while_no_process_is_tracked() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = Storage::open_in_memory().await.expect("storage");
        let port = RuntimeIntegrationPort::new(storage, directory.path().to_path_buf());

        let stopped = port
            .request("demo_stop", json!({ "session_token": Uuid::new_v4() }))
            .await
            .expect("idle stop is idempotent");

        assert_eq!(stopped["stopped"], true);
        assert!(stopped["process_id"].is_null());
        assert_eq!(stopped["already_stopped"], true);
        assert_eq!(stopped["forced_process_stop"], false);
        assert!(matches!(
            *port
                .tracked_playback
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            TrackedPlaybackState::Idle
        ));
    }

    #[tokio::test]
    async fn playback_stop_rejects_a_stale_session_token_without_signalling_the_process() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = Storage::open_in_memory().await.expect("storage");
        let port = RuntimeIntegrationPort::new(storage, directory.path().to_path_buf());
        let token = Uuid::new_v4();
        let child = spawn_running_playback_test_child();
        let expected_process_id = child.id().expect("test child process identifier");
        let (process_id, cancelled) =
            TrackedPlaybackLaunch::reserve(Arc::clone(&port.tracked_playback), token)
                .expect("reserve tracked launch")
                .activate(child)
                .expect("activate tracked launch");
        assert_eq!(process_id, expected_process_id);
        assert!(!cancelled);

        let error = port
            .request("demo_stop", json!({ "session_token": Uuid::new_v4() }))
            .await
            .expect_err("stale token must be rejected");

        assert!(matches!(error, DomainError::Conflict(_)));
        assert_tracked_playback_is_running(&port, token, process_id);
        let cleanup = port
            .request("demo_stop", json!({ "session_token": token }))
            .await
            .expect("clean up tracked test child");
        assert_eq!(cleanup["forced_process_stop"], true);
    }

    #[tokio::test]
    async fn playback_stop_terminates_the_exact_tracked_child_and_is_retryable() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = Storage::open_in_memory().await.expect("storage");
        let port = RuntimeIntegrationPort::new(storage, directory.path().to_path_buf());
        let token = Uuid::new_v4();
        let child = spawn_running_playback_test_child();
        let expected_process_id = child.id().expect("test child process identifier");
        let (process_id, cancelled) =
            TrackedPlaybackLaunch::reserve(Arc::clone(&port.tracked_playback), token)
                .expect("reserve tracked launch")
                .activate(child)
                .expect("activate tracked launch");
        assert_eq!(process_id, expected_process_id);
        assert!(!cancelled);

        let stopped = port
            .request("demo_stop", json!({ "session_token": token }))
            .await
            .expect("stop exact tracked child");
        assert_eq!(stopped["stopped"], true);
        assert_eq!(stopped["process_id"], process_id);
        assert_eq!(stopped["already_stopped"], false);
        assert_eq!(stopped["forced_process_stop"], true);
        assert_tracked_playback_is_stopped(&port, token, process_id);

        let retry = port
            .request("demo_stop", json!({ "session_token": token }))
            .await
            .expect("same-token stop retry is idempotent");
        assert_eq!(retry["stopped"], true);
        assert_eq!(retry["process_id"], process_id);
        assert_eq!(retry["already_stopped"], true);
        assert_eq!(retry["forced_process_stop"], false);
        assert_tracked_playback_is_stopped(&port, token, process_id);
    }

    #[tokio::test]
    async fn playback_stop_observes_an_exited_child_before_attempting_termination() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = Storage::open_in_memory().await.expect("storage");
        let port = RuntimeIntegrationPort::new(storage, directory.path().to_path_buf());
        let token = Uuid::new_v4();
        let child = spawn_exiting_playback_test_child();
        let expected_process_id = child.id().expect("test child process identifier");
        let (process_id, cancelled) =
            TrackedPlaybackLaunch::reserve(Arc::clone(&port.tracked_playback), token)
                .expect("reserve tracked launch")
                .activate(child)
                .expect("activate tracked launch");
        assert_eq!(process_id, expected_process_id);
        assert!(!cancelled);
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let exited = {
                    let mut tracked = port
                        .tracked_playback
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    match &mut *tracked {
                        TrackedPlaybackState::Active { child, .. } => child
                            .try_wait()
                            .expect("inspect exiting test child")
                            .is_some(),
                        state => panic!("expected active playback, got {state:?}"),
                    }
                };
                if exited {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("test child exits");

        let stopped = port
            .request("demo_stop", json!({ "session_token": token }))
            .await
            .expect("exited child is already stopped");

        assert_eq!(stopped["stopped"], true);
        assert_eq!(stopped["process_id"], process_id);
        assert_eq!(stopped["already_stopped"], true);
        assert_eq!(stopped["forced_process_stop"], false);
        assert_tracked_playback_is_stopped(&port, token, process_id);
    }

    #[tokio::test]
    async fn playback_stop_cancels_and_waits_for_a_pre_spawn_launch_transaction() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = Storage::open_in_memory().await.expect("storage");
        let port = RuntimeIntegrationPort::new(storage, directory.path().to_path_buf());
        let token = Uuid::new_v4();
        let launch = TrackedPlaybackLaunch::reserve(Arc::clone(&port.tracked_playback), token)
            .expect("reserve tracked launch");
        let signal = Arc::clone(&launch.signal);
        let stop_port = port.clone();
        let stop_task = tokio::spawn(async move {
            stop_port
                .request("demo_stop", json!({ "session_token": token }))
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if signal.is_cancelled() && signal.completion.receiver_count() > 0 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("stop waits for launch cancellation");

        drop(launch);
        let stopped = stop_task
            .await
            .expect("stop task")
            .expect("cancelled launch is idempotently stopped");
        assert_eq!(stopped["stopped"], true);
        assert!(stopped["process_id"].is_null());
        assert_eq!(stopped["already_stopped"], true);
        assert_eq!(stopped["forced_process_stop"], false);
        assert!(matches!(
            *port
                .tracked_playback
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            TrackedPlaybackState::Idle
        ));
    }

    #[tokio::test]
    async fn playback_launch_rechecks_cancellation_while_activating_the_child() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = Storage::open_in_memory().await.expect("storage");
        let port = RuntimeIntegrationPort::new(storage, directory.path().to_path_buf());
        let token = Uuid::new_v4();
        let launch = TrackedPlaybackLaunch::reserve(Arc::clone(&port.tracked_playback), token)
            .expect("reserve tracked launch");
        launch.signal.cancel();
        let child = spawn_running_playback_test_child();
        let (process_id, cancelled) = launch.activate(child).expect("activate cancelled launch");
        assert!(cancelled);
        assert_tracked_playback_is_running(&port, token, process_id);

        let stopped = port
            .request("demo_stop", json!({ "session_token": token }))
            .await
            .expect("cancelled post-spawn launch is stopped");
        assert_eq!(stopped["process_id"], process_id);
        assert_eq!(stopped["forced_process_stop"], true);
        assert_tracked_playback_is_stopped(&port, token, process_id);
    }

    #[tokio::test]
    async fn playback_stop_retry_waits_for_an_in_progress_stop_and_recovers_after_abort() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = Storage::open_in_memory().await.expect("storage");
        let port = RuntimeIntegrationPort::new(storage, directory.path().to_path_buf());
        let token = Uuid::new_v4();
        let child = spawn_running_playback_test_child();
        let (process_id, cancelled) =
            TrackedPlaybackLaunch::reserve(Arc::clone(&port.tracked_playback), token)
                .expect("reserve tracked launch")
                .activate(child)
                .expect("activate tracked launch");
        assert!(!cancelled);
        let stop = TrackedPlaybackStop::begin(Arc::clone(&port.tracked_playback), token)
            .expect("begin tracked stop");
        let signal = Arc::clone(&stop.signal);
        let retry_port = port.clone();
        let retry = tokio::spawn(async move {
            retry_port
                .request("demo_stop", json!({ "session_token": token }))
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if signal.completion.receiver_count() > 0 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("retry waits on stop transaction");

        drop(stop);
        let stopped = tokio::time::timeout(Duration::from_secs(5), retry)
            .await
            .expect("retry completes")
            .expect("retry task")
            .expect("retry safely stops restored child");
        assert_eq!(stopped["process_id"], process_id);
        assert_eq!(stopped["already_stopped"], false);
        assert_eq!(stopped["forced_process_stop"], true);
        assert_tracked_playback_is_stopped(&port, token, process_id);
    }

    #[tokio::test]
    async fn retired_obs_capabilities_are_not_runtime_dependencies() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let port = RuntimeIntegrationPort::new(storage, PathBuf::from("unused"));

        for capability in ["obs_status", "obs_test", "obs_start", "obs_diagnose"] {
            let error = port
                .request(capability, Value::Null)
                .await
                .expect_err("retired capability");
            assert!(
                matches!(error, DomainError::DependencyUnavailable(ref message)
                    if message == &format!("unsupported integration capability: {capability}"))
            );
        }
    }

    #[test]
    fn llm_connection_tests_use_ephemeral_fields_and_preserve_saved_secrets() {
        let mut saved = AppConfig::default();
        saved.llm.api_key = "saved-llm-secret".to_owned();

        let llm = RuntimeIntegrationPort::llm_test_config(
            saved,
            &json!({
                "provider": "openai-compatible",
                "model": "test-model",
                "base_url": "https://example.test/v1",
                "api_key": "********",
                "prompt": ""
            }),
        )
        .expect("LLM test config");
        assert_eq!(llm.llm.model, "test-model");
        assert_eq!(llm.llm.api_key, "saved-llm-secret");
    }

    #[tokio::test]
    async fn status_values_never_serialize_integration_secrets() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let mut config = AppConfig::default();
        config.llm.provider = "compatible".to_owned();
        config.llm.model = "model".to_owned();
        config.llm.base_url =
            "https://url-user:url-secret@example.test/v1?api_key=query-secret".to_owned();
        config.llm.api_key = "llm-secret-value".to_owned();
        storage.put_config(config).await.expect("config");
        let port = RuntimeIntegrationPort::new(storage, PathBuf::from("unused"));

        let status = port
            .request("llm_status", Value::Null)
            .await
            .expect("status");
        let encoded = serde_json::to_string(&status).expect("JSON");
        assert!(!encoded.contains("llm-secret-value"));
        assert!(!encoded.contains("url-secret"));
        assert!(!encoded.contains("query-secret"));
        assert_eq!(status["has_api_key"], true);
    }

    #[tokio::test]
    async fn match_history_is_explicitly_unavailable_without_credentials() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let port = RuntimeIntegrationPort::new(storage, PathBuf::from("unused"));
        let error = port
            .request("match_history", json!({ "steam_id": "1" }))
            .await
            .expect_err("credentials are unavailable");
        assert!(matches!(error, DomainError::DependencyUnavailable(_)));
    }

    #[tokio::test]
    async fn fake_steam_sync_download_and_import_complete_the_vertical_slice() {
        let root = tempfile::tempdir().expect("temporary directory");
        let storage = Storage::open_in_memory().await.expect("storage");
        let seed_code = sharing_code(11_000_000_000_000_001, 22_000_000_000_000_001, 101);
        let next_code = sharing_code(11_000_000_000_000_002, 22_000_000_000_000_002, 102);
        storage
            .put_config(AppConfig {
                steam: steam_config(seed_code),
                ..AppConfig::default()
            })
            .await
            .expect("config");
        let backend = Arc::new(FakeSteamBackend {
            history: vec![decode_match_sharing_code(&next_code).expect("next code")],
            block_download: false,
        });
        let port = RuntimeIntegrationPort::new(storage.clone(), root.path().to_path_buf())
            .with_steam_backend(backend);

        let sync = port
            .request("match_history_sync", Value::Null)
            .await
            .expect("sync history");
        assert_eq!(sync["created"], 2);
        assert_eq!(
            storage
                .get_config()
                .await
                .expect("config")
                .expect("saved config")
                .steam
                .known_share_code,
            next_code
        );
        let history = port
            .request("match_history", json!({ "page": 1, "page_size": 10 }))
            .await
            .expect("list history");
        assert_eq!(history["total"], 2);
        let record_id = history["items"][0]["id"]
            .as_str()
            .expect("record id")
            .to_owned();
        let trusted_played_at = "2025-06-19T20:15:42Z"
            .parse::<DateTime<Utc>>()
            .expect("trusted match date");
        let mut record = storage
            .get_steam_match(&record_id)
            .await
            .expect("match lookup")
            .expect("synced match");
        record.played_at = Some(trusted_played_at);
        storage.put_steam_match(record).await.expect("dated match");

        let started = port
            .request("match_history_download", json!({ "match_id": record_id }))
            .await
            .expect("start download");
        let job_id = Uuid::parse_str(started["id"].as_str().expect("job id")).expect("UUID");
        let completed = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let job = storage
                    .get_match_download_job(job_id)
                    .await
                    .expect("job")
                    .expect("persisted job");
                if job.status.is_terminal() {
                    break job;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("download completes");
        assert_eq!(completed.status, MatchDownloadStatus::Completed);
        assert!((completed.progress - 1.0).abs() < f64::EPSILON);
        let demo_id = completed.demo_id.expect("imported demo id");
        let demo = storage
            .get_demo(demo_id)
            .await
            .expect("demo")
            .expect("imported demo");
        assert_eq!(demo.source, "download");
        assert_eq!(demo.match_date, Some(trusted_played_at));
        assert!(Path::new(&demo.path).is_file());
    }

    #[tokio::test]
    async fn steam_import_adds_a_trusted_date_to_an_undated_duplicate_without_replacing_demo_truth()
    {
        let root = tempfile::tempdir().expect("temporary directory");
        let existing_path = root.path().join("cataloged.dem");
        let downloaded_path = root.path().join("downloaded.dem");
        std::fs::write(&existing_path, b"PBDEMS2\0fixture!").expect("cataloged demo");
        std::fs::write(&downloaded_path, b"PBDEMS2\0fixture!").expect("downloaded demo");
        let validated = validate_demo(
            &existing_path,
            ValidationLimits::default(),
            &ParseCancellation::default(),
        )
        .expect("validated demo");
        let storage = Storage::open_in_memory().await.expect("storage");
        let trusted_played_at = "2025-06-19T20:15:42Z"
            .parse::<DateTime<Utc>>()
            .expect("trusted match date");
        let existing = DemoRecord {
            id: Uuid::new_v4(),
            path: validated.path.to_string_lossy().into_owned(),
            file_name: "cataloged.dem".to_owned(),
            display_name: "Cataloged truth".to_owned(),
            source: "local".to_owned(),
            status: DemoStatus::Ready,
            map_name: Some("de_nuke".to_owned()),
            match_date: None,
            duration_seconds: Some(2_345.5),
            total_rounds: Some(24),
            team_a_name: Some("Alpha".to_owned()),
            team_b_name: Some("Bravo".to_owned()),
            team_a_score: Some(13),
            team_b_score: Some(11),
            player_names: vec!["Player One".to_owned()],
            remark: "analyzed locally".to_owned(),
            content_sha256: Some(validated.sha256),
            file_size: validated.size,
            created_at: trusted_played_at - chrono::Duration::days(10),
            updated_at: trusted_played_at - chrono::Duration::days(1),
        };
        storage
            .put_demo(existing.clone())
            .await
            .expect("cataloged demo");

        let imported = import_downloaded_demo(&storage, &downloaded_path, Some(trusted_played_at))
            .await
            .expect("duplicate import");

        let mut expected = existing;
        expected.match_date = Some(trusted_played_at);
        expected.updated_at = imported.updated_at;
        assert_eq!(imported, expected);
        assert_eq!(
            storage.get_demo(imported.id).await.expect("demo lookup"),
            Some(imported)
        );
    }

    #[tokio::test]
    async fn steam_import_fails_closed_when_duplicate_match_dates_conflict() {
        let root = tempfile::tempdir().expect("temporary directory");
        let existing_path = root.path().join("cataloged.dem");
        let downloaded_path = root.path().join("downloaded.dem");
        std::fs::write(&existing_path, b"PBDEMS2\0fixture!").expect("cataloged demo");
        std::fs::write(&downloaded_path, b"PBDEMS2\0fixture!").expect("downloaded demo");
        let storage = Storage::open_in_memory().await.expect("storage");
        let existing_played_at = "2025-06-19T20:15:42Z"
            .parse::<DateTime<Utc>>()
            .expect("existing match date");
        let conflicting_played_at = "2025-06-20T20:15:42Z"
            .parse::<DateTime<Utc>>()
            .expect("conflicting match date");
        let existing = import_downloaded_demo(&storage, &existing_path, Some(existing_played_at))
            .await
            .expect("initial import");

        let error = import_downloaded_demo(&storage, &downloaded_path, Some(conflicting_played_at))
            .await
            .expect_err("conflicting trusted dates must reject the duplicate import");

        assert!(
            matches!(error, DomainError::Conflict(ref message) if message.contains("match date"))
        );
        assert_eq!(
            storage.get_demo(existing.id).await.expect("demo lookup"),
            Some(existing)
        );
    }

    #[tokio::test]
    async fn steam_import_keeps_match_date_unknown_when_steam_has_no_played_at() {
        let root = tempfile::tempdir().expect("temporary directory");
        let downloaded_path = root.path().join("downloaded.dem");
        std::fs::write(&downloaded_path, b"PBDEMS2\0fixture!").expect("downloaded demo");
        let storage = Storage::open_in_memory().await.expect("storage");

        let imported = import_downloaded_demo(&storage, &downloaded_path, None)
            .await
            .expect("undated import");

        assert_eq!(imported.match_date, None);
        assert_eq!(
            storage.get_demo(imported.id).await.expect("demo lookup"),
            Some(imported)
        );
    }

    #[tokio::test]
    async fn steam_import_repairs_an_unusable_same_hash_catalog_entry_without_deleting_the_only_copy()
     {
        let root = tempfile::tempdir().expect("temporary directory");
        let stale_path = root.path().join("stale.dem");
        let downloaded_path = root.path().join("downloaded.dem");
        std::fs::write(&downloaded_path, b"PBDEMS2\0fixture!").expect("downloaded demo");
        let validated = validate_demo(
            &downloaded_path,
            ValidationLimits::default(),
            &ParseCancellation::default(),
        )
        .expect("validated demo");
        let storage = Storage::open_in_memory().await.expect("storage");
        let mut stale = cataloged_demo(&stale_path.to_string_lossy(), None);
        stale.status = DemoStatus::Missing;
        stale.content_sha256 = Some(validated.sha256.clone());
        stale.file_size = validated.size;
        storage.put_demo(stale.clone()).await.expect("stale Demo");
        let stale_identity = DemoCatalogIdentity {
            id: stale.id,
            path: stale.path.clone(),
            status: stale.status,
            content_sha256: stale.content_sha256.clone(),
            file_size: stale.file_size,
            updated_at: stale.updated_at,
        };

        let repaired = import_downloaded_demo_replacing(
            &storage,
            &downloaded_path,
            None,
            Some(stale_identity),
        )
        .await
        .expect("repaired import");

        assert_eq!(repaired.id, stale.id);
        assert_eq!(repaired.status, DemoStatus::Discovered);
        assert!(Path::new(&repaired.path).is_file());
        assert_eq!(
            validate_demo(
                Path::new(&repaired.path),
                ValidationLimits::default(),
                &ParseCancellation::default(),
            )
            .expect("repaired Demo validation")
            .sha256,
            validated.sha256
        );
        assert!(same_path_for_test(
            Path::new(&repaired.path),
            &validated.path
        ));
    }

    #[tokio::test]
    async fn steam_import_recovers_a_same_size_tampered_hash_owner_to_the_verified_copy() {
        let root = tempfile::tempdir().expect("temporary directory");
        let stale_path = root.path().join("stale.dem");
        let downloaded_path = root.path().join("downloaded.dem");
        std::fs::write(&stale_path, b"PBDEMS2\0fixture!").expect("cataloged demo");
        std::fs::write(&downloaded_path, b"PBDEMS2\0fixture!").expect("downloaded demo");
        let validated = validate_demo(
            &stale_path,
            ValidationLimits::default(),
            &ParseCancellation::default(),
        )
        .expect("validated cataloged Demo");
        let storage = Storage::open_in_memory().await.expect("storage");
        let mut stale = cataloged_demo(&validated.path.to_string_lossy(), None);
        stale.content_sha256 = Some(validated.sha256.clone());
        stale.file_size = validated.size;
        storage
            .put_demo(stale.clone())
            .await
            .expect("cataloged Demo");
        std::fs::write(&stale_path, b"PBDEMS2\0tampered").expect("same-size tampering");
        let expected_incoming =
            std::fs::canonicalize(&downloaded_path).expect("incoming canonical path before import");

        let repaired = import_downloaded_demo(&storage, &downloaded_path, None)
            .await
            .expect("recover from stale hash owner");

        assert_eq!(repaired.id, stale.id);
        assert_eq!(
            std::fs::canonicalize(&repaired.path).expect("repaired canonical path"),
            expected_incoming
        );
        assert_eq!(
            validate_demo(
                Path::new(&repaired.path),
                ValidationLimits::default(),
                &ParseCancellation::default(),
            )
            .expect("repaired Demo validation")
            .sha256,
            validated.sha256
        );
        assert_ne!(Path::new(&repaired.path), stale_path);
    }

    #[tokio::test]
    async fn claimed_steam_import_preserves_a_linked_demo_replaced_during_download() {
        let root = tempfile::tempdir().expect("temporary directory");
        let linked_path = root.path().join("linked.dem");
        let incoming_path = root.path().join("incoming.dem");
        std::fs::write(&linked_path, b"PBDEMS2\0original").expect("original Demo");
        std::fs::write(&incoming_path, b"PBDEMS2\0download").expect("downloaded Demo");
        let linked_validation = validate_demo(
            &linked_path,
            ValidationLimits::default(),
            &ParseCancellation::default(),
        )
        .expect("linked validation");
        let storage = Storage::open_in_memory().await.expect("storage");
        let mut linked = cataloged_demo(&linked_validation.path.to_string_lossy(), None);
        linked.content_sha256 = Some(linked_validation.sha256);
        linked.file_size = linked_validation.size;
        storage.put_demo(linked.clone()).await.expect("linked Demo");
        let claimed_identity = DemoCatalogIdentity {
            id: linked.id,
            path: linked.path.clone(),
            status: linked.status,
            content_sha256: linked.content_sha256.clone(),
            file_size: linked.file_size,
            updated_at: linked.updated_at,
        };
        std::fs::write(&linked_path, b"PBDEMS2\0newtruth").expect("new linked bytes");
        let replacement_validation = validate_demo(
            &linked_path,
            ValidationLimits::default(),
            &ParseCancellation::default(),
        )
        .expect("replacement validation");
        let mut replacement = linked.clone();
        replacement.content_sha256 = Some(replacement_validation.sha256.clone());
        replacement.file_size = replacement_validation.size;
        replacement.status = DemoStatus::Discovered;
        replacement.updated_at = Utc::now();
        storage
            .replace_demo_content(replacement.clone())
            .await
            .expect("concurrent replacement");

        let result = import_downloaded_demo_replacing(
            &storage,
            &incoming_path,
            None,
            Some(claimed_identity),
        )
        .await;

        assert!(matches!(
            result,
            Err(DomainError::Conflict(ref message))
                if message.contains("after the download claim")
        ));
        assert_eq!(
            storage
                .get_demo(linked.id)
                .await
                .expect("Demo")
                .expect("Demo")
                .content_sha256,
            Some(replacement_validation.sha256)
        );
        assert!(incoming_path.is_file());
    }

    #[tokio::test]
    async fn already_downloaded_match_backfills_its_trusted_date_before_returning_completed() {
        let root = tempfile::tempdir().expect("temporary directory");
        let demo_path = root.path().join("already-downloaded.dem");
        std::fs::write(&demo_path, b"PBDEMS2\0fixture!").expect("downloaded demo");
        let validated = validate_demo(
            &demo_path,
            ValidationLimits::default(),
            &ParseCancellation::default(),
        )
        .expect("validated demo");
        let storage = Storage::open_in_memory().await.expect("storage");
        storage
            .put_config(AppConfig {
                steam: steam_config(sharing_code(1, 2, 3)),
                ..AppConfig::default()
            })
            .await
            .expect("config");
        let trusted_played_at = "2025-06-19T20:15:42Z"
            .parse::<DateTime<Utc>>()
            .expect("trusted match date");
        let mut demo = cataloged_demo(&validated.path.to_string_lossy(), None);
        demo.content_sha256 = Some(validated.sha256);
        demo.file_size = validated.size;
        storage.put_demo(demo.clone()).await.expect("demo");
        let now = Utc::now();
        let record = SteamMatchRecord {
            id: "76561198000000000:42".to_owned(),
            steam_id: "76561198000000000".to_owned(),
            match_id: "42".to_owned(),
            outcome_id: "420".to_owned(),
            token: 42,
            map_name: Some("de_nuke".to_owned()),
            played_at: Some(trusted_played_at),
            score: Some("13:11".to_owned()),
            result: MatchHistoryResult::Win,
            demo_status: MatchDemoStatus::Downloaded,
            demo_id: Some(demo.id),
            last_error: None,
            synced_at: now,
            updated_at: now,
        };
        storage
            .put_steam_match(record.clone())
            .await
            .expect("Steam match");
        let port = RuntimeIntegrationPort::new(storage.clone(), PathBuf::from("unused"));

        let completed = port
            .request("match_history_download", json!({ "match_id": record.id }))
            .await
            .expect("completed download");

        assert_eq!(completed["status"], "completed");
        assert_eq!(completed["demo_id"], demo.id.to_string());
        assert_eq!(
            storage
                .get_demo(demo.id)
                .await
                .expect("demo lookup")
                .expect("demo")
                .match_date,
            Some(trusted_played_at)
        );
        let stored_record = storage
            .get_steam_match(record.id)
            .await
            .expect("Steam match lookup")
            .expect("Steam match");
        assert_eq!(stored_record.demo_status, MatchDemoStatus::Downloaded);
        assert_eq!(stored_record.last_error, None);
    }

    #[tokio::test]
    async fn already_downloaded_match_rejects_a_conflicting_trusted_date_without_a_job() {
        let root = tempfile::tempdir().expect("temporary directory");
        let demo_path = root.path().join("already-downloaded-conflict.dem");
        std::fs::write(&demo_path, b"PBDEMS2\0fixture!").expect("downloaded demo");
        let validated = validate_demo(
            &demo_path,
            ValidationLimits::default(),
            &ParseCancellation::default(),
        )
        .expect("validated demo");
        let storage = Storage::open_in_memory().await.expect("storage");
        storage
            .put_config(AppConfig {
                steam: steam_config(sharing_code(1, 2, 3)),
                ..AppConfig::default()
            })
            .await
            .expect("config");
        let existing_played_at = "2025-06-19T20:15:42Z"
            .parse::<DateTime<Utc>>()
            .expect("existing match date");
        let conflicting_played_at = "2025-06-20T20:15:42Z"
            .parse::<DateTime<Utc>>()
            .expect("conflicting match date");
        let mut demo = cataloged_demo(&validated.path.to_string_lossy(), Some(existing_played_at));
        demo.content_sha256 = Some(validated.sha256);
        demo.file_size = validated.size;
        storage.put_demo(demo.clone()).await.expect("demo");
        let now = Utc::now();
        let record = SteamMatchRecord {
            id: "76561198000000000:43".to_owned(),
            steam_id: "76561198000000000".to_owned(),
            match_id: "43".to_owned(),
            outcome_id: "430".to_owned(),
            token: 43,
            map_name: Some("de_nuke".to_owned()),
            played_at: Some(conflicting_played_at),
            score: Some("13:11".to_owned()),
            result: MatchHistoryResult::Win,
            demo_status: MatchDemoStatus::Downloaded,
            demo_id: Some(demo.id),
            last_error: None,
            synced_at: now,
            updated_at: now,
        };
        storage
            .put_steam_match(record.clone())
            .await
            .expect("Steam match");
        let port = RuntimeIntegrationPort::new(storage.clone(), PathBuf::from("unused"));

        let error = port
            .request("match_history_download", json!({ "match_id": record.id }))
            .await
            .expect_err("conflicting trusted dates must reject the completed fast path");

        assert!(
            matches!(error, DomainError::Conflict(ref message) if message.contains("match date"))
        );
        assert_eq!(
            storage.get_demo(demo.id).await.expect("demo lookup"),
            Some(demo)
        );
        assert!(
            storage
                .list_match_download_jobs()
                .await
                .expect("download jobs")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn same_size_tampering_never_fast_completes_an_already_linked_demo() {
        let root = tempfile::tempdir().expect("temporary directory");
        let demo_path = root.path().join("tampered.dem");
        std::fs::write(&demo_path, b"PBDEMS2\0fixture!").expect("downloaded demo");
        let validated = validate_demo(
            &demo_path,
            ValidationLimits::default(),
            &ParseCancellation::default(),
        )
        .expect("validated demo");
        let storage = Storage::open_in_memory().await.expect("storage");
        storage
            .put_config(AppConfig {
                steam: steam_config(sharing_code(1, 2, 3)),
                ..AppConfig::default()
            })
            .await
            .expect("config");
        let mut demo = cataloged_demo(&validated.path.to_string_lossy(), None);
        demo.content_sha256 = Some(validated.sha256);
        demo.file_size = validated.size;
        storage.put_demo(demo.clone()).await.expect("demo");
        std::fs::write(&demo_path, b"PBDEMS2\0tampered").expect("same-size tampering");
        assert_eq!(
            std::fs::metadata(&demo_path).expect("metadata").len(),
            demo.file_size
        );
        let now = Utc::now();
        let record = SteamMatchRecord {
            id: "76561198000000000:44".to_owned(),
            steam_id: "76561198000000000".to_owned(),
            match_id: "44".to_owned(),
            outcome_id: "440".to_owned(),
            token: 44,
            map_name: None,
            played_at: None,
            score: None,
            result: MatchHistoryResult::Unknown,
            demo_status: MatchDemoStatus::Failed,
            demo_id: Some(demo.id),
            last_error: Some("previous failure".to_owned()),
            synced_at: now,
            updated_at: now,
        };
        storage
            .put_steam_match(record.clone())
            .await
            .expect("Steam match");
        let port = RuntimeIntegrationPort::new(storage.clone(), root.path().join("data"))
            .with_steam_backend(Arc::new(FakeSteamBackend {
                history: Vec::new(),
                block_download: true,
            }));

        let started = port
            .request("match_history_download", json!({ "match_id": record.id }))
            .await
            .expect("repair download starts");

        assert_eq!(started["status"], "queued");
        let job_id = Uuid::parse_str(started["id"].as_str().expect("job id")).expect("UUID");
        port.request("match_history_download_cancel", json!({ "job_id": job_id }))
            .await
            .expect("cancel repair download");
    }

    #[tokio::test]
    async fn match_history_search_is_applied_before_runtime_pagination() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let mut config = AppConfig::default();
        config.steam.steam_id = "76561198000000000".to_owned();
        storage.put_config(config).await.expect("config");
        let now = Utc::now();
        let record = |token: u16, map_name: &str| SteamMatchRecord {
            id: format!("76561198000000000:{token}"),
            steam_id: "76561198000000000".to_owned(),
            match_id: token.to_string(),
            outcome_id: token.to_string(),
            token,
            map_name: Some(map_name.to_owned()),
            played_at: None,
            score: None,
            result: MatchHistoryResult::Unknown,
            demo_status: MatchDemoStatus::Available,
            demo_id: None,
            last_error: None,
            synced_at: now,
            updated_at: now,
        };
        storage
            .put_steam_matches(vec![record(1, "de_mirage"), record(2, "de_nuke")])
            .await
            .expect("matches");
        let port = RuntimeIntegrationPort::new(storage, PathBuf::from("unused"));

        let history = port
            .request(
                "match_history",
                json!({ "search": "NUKE", "page": 1, "page_size": 1 }),
            )
            .await
            .expect("filtered history");

        assert_eq!(history["total"], 1);
        assert_eq!(history["items"][0]["map_name"], "de_nuke");
    }

    #[tokio::test]
    async fn match_download_rejects_missing_credentials_without_persisting_a_job() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let now = Utc::now();
        let record = SteamMatchRecord {
            id: "76561198000000000:42".to_owned(),
            steam_id: "76561198000000000".to_owned(),
            match_id: "42".to_owned(),
            outcome_id: "420".to_owned(),
            token: 42,
            map_name: Some("de_anubis".to_owned()),
            played_at: Some(now),
            score: Some("13:10".to_owned()),
            result: MatchHistoryResult::Win,
            demo_status: MatchDemoStatus::Available,
            demo_id: None,
            last_error: None,
            synced_at: now,
            updated_at: now,
        };
        storage
            .put_steam_matches(vec![record.clone()])
            .await
            .expect("match");
        let port = RuntimeIntegrationPort::new(storage.clone(), PathBuf::from("unused"));

        let error = port
            .request("match_history_download", json!({ "match_id": record.id }))
            .await
            .expect_err("missing Steam credentials must reject download");

        assert!(matches!(error, DomainError::DependencyUnavailable(_)));
        assert!(
            storage
                .list_match_download_jobs()
                .await
                .expect("download jobs")
                .is_empty()
        );
        assert_eq!(
            storage
                .get_steam_match(record.id.clone())
                .await
                .expect("match lookup"),
            Some(record)
        );
    }

    #[tokio::test]
    async fn match_download_rejects_a_missing_web_api_key_without_persisting_or_mutating() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let mut config = AppConfig::default();
        config.steam.steam_id = "76561198000000000".to_owned();
        storage.put_config(config).await.expect("config");
        let now = Utc::now();
        let record = SteamMatchRecord {
            id: "76561198000000000:42".to_owned(),
            steam_id: "76561198000000000".to_owned(),
            match_id: "42".to_owned(),
            outcome_id: "420".to_owned(),
            token: 42,
            map_name: Some("de_anubis".to_owned()),
            played_at: Some(now),
            score: Some("13:10".to_owned()),
            result: MatchHistoryResult::Win,
            demo_status: MatchDemoStatus::Available,
            demo_id: None,
            last_error: None,
            synced_at: now,
            updated_at: now,
        };
        storage
            .put_steam_matches(vec![record.clone()])
            .await
            .expect("match");
        let port = RuntimeIntegrationPort::new(storage.clone(), PathBuf::from("unused"));

        let error = port
            .request("match_history_download", json!({ "match_id": record.id }))
            .await
            .expect_err("missing Web API key must reject download");

        assert!(matches!(error, DomainError::DependencyUnavailable(_)));
        assert!(
            storage
                .list_match_download_jobs()
                .await
                .expect("download jobs")
                .is_empty()
        );
        assert_eq!(
            storage
                .get_steam_match(record.id.clone())
                .await
                .expect("match lookup"),
            Some(record)
        );
    }

    #[tokio::test]
    async fn match_download_rejects_a_previous_accounts_record_without_persisting_a_job() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let mut config = AppConfig::default();
        config.steam.steam_id = "76561198000000001".to_owned();
        config.steam.web_api_key = "a".repeat(32);
        storage.put_config(config).await.expect("config");
        let now = Utc::now();
        let record = SteamMatchRecord {
            id: "76561198000000000:42".to_owned(),
            steam_id: "76561198000000000".to_owned(),
            match_id: "42".to_owned(),
            outcome_id: "420".to_owned(),
            token: 42,
            map_name: Some("de_anubis".to_owned()),
            played_at: Some(now),
            score: Some("13:10".to_owned()),
            result: MatchHistoryResult::Win,
            demo_status: MatchDemoStatus::Available,
            demo_id: None,
            last_error: None,
            synced_at: now,
            updated_at: now,
        };
        storage
            .put_steam_matches(vec![record.clone()])
            .await
            .expect("match");
        let port = RuntimeIntegrationPort::new(storage.clone(), PathBuf::from("unused"));

        let error = port
            .request("match_history_download", json!({ "match_id": record.id }))
            .await
            .expect_err("previous account match must not be downloadable");

        assert!(matches!(error, DomainError::NotFound(_)));
        assert!(
            storage
                .list_match_download_jobs()
                .await
                .expect("download jobs")
                .is_empty()
        );
        assert_eq!(
            storage
                .get_steam_match(record.id.clone())
                .await
                .expect("match lookup"),
            Some(record)
        );
    }

    #[tokio::test]
    async fn match_history_restores_only_the_configured_accounts_active_downloads() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let mut config = AppConfig::default();
        config.steam.steam_id = "76561198000000000".to_owned();
        storage.put_config(config).await.expect("config");
        let now = Utc::now();
        let record = |steam_id: &str, token: u16| SteamMatchRecord {
            id: format!("{steam_id}:{token}"),
            steam_id: steam_id.to_owned(),
            match_id: token.to_string(),
            outcome_id: token.to_string(),
            token,
            map_name: None,
            played_at: None,
            score: None,
            result: MatchHistoryResult::Unknown,
            demo_status: MatchDemoStatus::Downloading,
            demo_id: None,
            last_error: None,
            synced_at: now,
            updated_at: now,
        };
        let own_record = record("76561198000000000", 1);
        let other_record = record("76561198000000001", 2);
        storage
            .put_steam_matches(vec![own_record.clone(), other_record.clone()])
            .await
            .expect("matches");
        for (record, status) in [
            (&own_record, MatchDownloadStatus::Downloading),
            (&other_record, MatchDownloadStatus::Downloading),
            (&own_record, MatchDownloadStatus::Completed),
        ] {
            storage
                .put_match_download_job(MatchDownloadJob {
                    id: Uuid::new_v4(),
                    match_record_id: record.id.clone(),
                    status,
                    downloaded_bytes: 10,
                    total_bytes: Some(100),
                    progress: 0.1,
                    demo_id: None,
                    error: None,
                    error_code: None,
                    created_at: now,
                    updated_at: now,
                })
                .await
                .expect("job");
        }
        let port = RuntimeIntegrationPort::new(storage, PathBuf::from("unused"));

        let jobs = port
            .request("match_history_downloads_active", Value::Null)
            .await
            .expect("active jobs");

        assert_eq!(jobs.as_array().map(Vec::len), Some(1));
        assert_eq!(jobs[0]["match_record_id"], own_record.id);
        assert_eq!(jobs[0]["status"], "downloading");
    }

    #[tokio::test]
    async fn fake_steam_download_can_be_cancelled_cooperatively() {
        let root = tempfile::tempdir().expect("temporary directory");
        let storage = Storage::open_in_memory().await.expect("storage");
        let seed_code = sharing_code(31_000_000_000_000_001, 32_000_000_000_000_001, 201);
        storage
            .put_config(AppConfig {
                steam: steam_config(seed_code),
                ..AppConfig::default()
            })
            .await
            .expect("config");
        let port = RuntimeIntegrationPort::new(storage.clone(), root.path().to_path_buf())
            .with_steam_backend(Arc::new(FakeSteamBackend {
                history: Vec::new(),
                block_download: true,
            }));
        port.request("match_history_sync", Value::Null)
            .await
            .expect("sync history");
        let history = port
            .request("match_history", json!({ "page": 1, "page_size": 10 }))
            .await
            .expect("list history");
        let record_id = history["items"][0]["id"].as_str().expect("record id");
        let started = port
            .request("match_history_download", json!({ "match_id": record_id }))
            .await
            .expect("start download");
        let job_id = Uuid::parse_str(started["id"].as_str().expect("job id")).expect("UUID");
        port.request("match_history_download_cancel", json!({ "job_id": job_id }))
            .await
            .expect("cancel download");

        let cancelled = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let job = storage
                    .get_match_download_job(job_id)
                    .await
                    .expect("job")
                    .expect("persisted job");
                if job.status.is_terminal() {
                    break job;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("download cancellation completes");
        assert_eq!(cancelled.status, MatchDownloadStatus::Cancelled);
        assert!(cancelled.demo_id.is_none());
    }

    #[tokio::test]
    async fn terminal_persistence_failure_retries_until_the_download_is_durable() {
        let root = tempfile::tempdir().expect("temporary directory");
        let storage = Storage::open_in_memory().await.expect("storage");
        let seed_code = sharing_code(33_000_000_000_000_001, 34_000_000_000_000_001, 203);
        storage
            .put_config(AppConfig {
                steam: steam_config(seed_code),
                ..AppConfig::default()
            })
            .await
            .expect("config");
        let port = RuntimeIntegrationPort::new(storage.clone(), root.path().to_path_buf())
            .with_steam_backend(Arc::new(FakeSteamBackend {
                history: Vec::new(),
                block_download: false,
            }))
            .with_steam_terminal_failures(1);
        port.request("match_history_sync", Value::Null)
            .await
            .expect("sync history");
        let history = port
            .request("match_history", json!({ "page": 1, "page_size": 10 }))
            .await
            .expect("list history");
        let record_id = history["items"][0]["id"]
            .as_str()
            .expect("record id")
            .to_owned();
        let started = port
            .request("match_history_download", json!({ "match_id": record_id }))
            .await
            .expect("start download");
        let job_id = Uuid::parse_str(started["id"].as_str().expect("job id")).expect("UUID");

        let completed = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let job = storage
                    .get_match_download_job(job_id)
                    .await
                    .expect("job")
                    .expect("job");
                if job.status.is_terminal()
                    && !port.steam_downloads.lock().await.contains_key(&job_id)
                {
                    break job;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("terminal retry converges");
        assert_eq!(completed.status, MatchDownloadStatus::Completed);

        let duplicate = port
            .request("match_history_download", json!({ "match_id": record_id }))
            .await
            .expect("duplicate observes completed truth");
        assert_eq!(duplicate["status"], "completed");
    }

    #[tokio::test]
    async fn panicking_download_backend_is_supervised_to_a_failed_terminal_record() {
        let root = tempfile::tempdir().expect("temporary directory");
        let storage = Storage::open_in_memory().await.expect("storage");
        let seed_code = sharing_code(35_000_000_000_000_001, 36_000_000_000_000_001, 204);
        storage
            .put_config(AppConfig {
                steam: steam_config(seed_code),
                ..AppConfig::default()
            })
            .await
            .expect("config");
        let port = RuntimeIntegrationPort::new(storage.clone(), root.path().to_path_buf())
            .with_steam_backend(Arc::new(PanickingSteamBackend));
        port.request("match_history_sync", Value::Null)
            .await
            .expect("sync history");
        let history = port
            .request("match_history", json!({ "page": 1, "page_size": 10 }))
            .await
            .expect("list history");
        let record_id = history["items"][0]["id"]
            .as_str()
            .expect("record id")
            .to_owned();
        let started = port
            .request("match_history_download", json!({ "match_id": record_id }))
            .await
            .expect("start download");
        let job_id = Uuid::parse_str(started["id"].as_str().expect("job id")).expect("UUID");

        let failed = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let job = storage
                    .get_match_download_job(job_id)
                    .await
                    .expect("job")
                    .expect("job");
                if job.status.is_terminal()
                    && !port.steam_downloads.lock().await.contains_key(&job_id)
                {
                    break job;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("panic supervisor terminalizes");
        assert_eq!(failed.status, MatchDownloadStatus::Failed);
        assert!(
            failed
                .error
                .as_deref()
                .is_some_and(|error| error.contains("stopped unexpectedly"))
        );
        let record = storage
            .get_steam_match(record_id)
            .await
            .expect("Steam match")
            .expect("Steam match");
        assert_eq!(record.demo_status, MatchDemoStatus::Failed);
        let cancelled = port
            .request("match_history_download_cancel", json!({ "job_id": job_id }))
            .await
            .expect("terminal cancellation is idempotent");
        assert_eq!(cancelled["status"], "failed");
    }

    #[tokio::test]
    async fn gsi_ingest_validates_the_game_and_updates_the_live_snapshot() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let shared_state = Arc::new(RwLock::new(GsiState::default()));
        let port = RuntimeIntegrationPort::new_with_state(
            storage,
            PathBuf::from("unused"),
            Arc::clone(&shared_state),
        );
        let accepted = port
            .request(
                "gsi_ingest",
                json!({
                    "provider": { "appid": 730, "timestamp": 1 },
                    "map": { "name": "de_mirage", "round": 4 }
                }),
            )
            .await
            .expect("ingest CS2 payload");
        assert_eq!(accepted["accepted"], true);
        let status = port
            .request("gsi_status", Value::Null)
            .await
            .expect("GSI status");
        assert_eq!(status["state"]["sequence"], 1);
        assert_eq!(status["state"]["latest"]["map"]["name"], "de_mirage");
        assert_eq!(shared_state.read().await.sequence, 1);

        let error = port
            .request("gsi_ingest", json!({ "provider": { "appid": 570 } }))
            .await
            .expect_err("another game must be rejected");
        assert!(matches!(error, DomainError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn gsi_installation_keeps_a_secret_free_recovery_marker_and_restores() {
        let root = tempfile::tempdir().expect("temporary directory");
        let executable = root.path().join("game/bin/win64/cs2.exe");
        tokio::fs::create_dir_all(executable.parent().expect("executable parent"))
            .await
            .expect("game directory");
        tokio::fs::write(&executable, b"stub")
            .await
            .expect("executable");
        let target = root.path().join("game/csgo/cfg").join(GSI_FILE_NAME);
        tokio::fs::create_dir_all(target.parent().expect("configuration parent"))
            .await
            .expect("configuration directory");
        tokio::fs::write(&target, b"original")
            .await
            .expect("original configuration");

        let storage = Storage::open_in_memory().await.expect("storage");
        storage
            .put_config(AppConfig {
                cs2_path: executable.to_string_lossy().into_owned(),
                ..AppConfig::default()
            })
            .await
            .expect("config");
        let port = RuntimeIntegrationPort::new(storage, root.path().join("data"));
        port.request(
            "gsi_install",
            json!({
                "uri": "http://127.0.0.1:47831/gsi",
                "token": "private-gsi-token",
                "overwrite": true,
            }),
        )
        .await
        .expect("install");
        let installed = tokio::fs::read_to_string(&target)
            .await
            .expect("installed configuration");
        assert!(installed.contains("private-gsi-token"));
        let recovery = port
            .request("config_backup_status", Value::Null)
            .await
            .expect("recovery status");
        let encoded = serde_json::to_string(&recovery).expect("JSON");
        assert_eq!(recovery["recovery_required"], true);
        assert!(!encoded.contains("private-gsi-token"));

        port.request("config_backup_restore", Value::Null)
            .await
            .expect("restore");
        assert_eq!(
            tokio::fs::read(&target)
                .await
                .expect("restored configuration"),
            b"original"
        );
        assert!(!marker_path(&root.path().join("data")).exists());
    }

    #[test]
    fn gsi_endpoint_is_limited_to_loopback_http() {
        assert!(validate_loopback_uri("http://127.0.0.1:47831/gsi").is_ok());
        assert!(validate_loopback_uri("https://127.0.0.1/gsi").is_err());
        assert!(validate_loopback_uri("http://example.test/gsi").is_err());
    }
}
