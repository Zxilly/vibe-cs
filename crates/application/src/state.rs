use std::{
    collections::{HashMap, HashSet},
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::{Mutex, broadcast, watch};
use tokio::time::Instant;
use uuid::Uuid;

use crate::{
    AnalysisPort, ApiError, ApiResult, CosmeticsPort, DemoWatchPort, DisabledAnalysisPort,
    DisabledCosmeticsPort, DisabledDemoWatchPort, DisabledExportPort, DisabledIntegrationPort,
    DisabledMediaPort, DisabledPlayerPort, DisabledRecordingPort, DisabledReviewPort,
    DisabledSourceAssetPort, ExportPort, IntegrationPort, MediaPort, PlayerPort, RecordingPort,
    ReviewPort, SourceAssetPort, analysis_tasks::AnalysisTaskRegistry,
};

/// Keyed by path *and* size, so a file replaced in place is probed again
/// rather than serving the previous file's resolution.
pub(crate) type OutputMediaCache =
    Arc<Mutex<HashMap<(String, Option<u64>), Option<crate::routes::outputs::OutputMediaInfo>>>>;

#[derive(Debug, Clone)]
pub(crate) struct RecordingPlanLease {
    pub(crate) items: Vec<vibe_cs_domain::RecordingRequest>,
    pub(crate) retry_of: Option<Uuid>,
    pub(crate) project_source: Option<crate::routes::recording::ProjectRecordingSource>,
    pub(crate) binding_sha256: String,
    pub(crate) expires_at: DateTime<Utc>,
    pub(crate) deadline: Instant,
    pub(crate) state: RecordingPlanLeaseState,
    pub(crate) transitions: watch::Sender<RecordingPlanLeaseState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecordingPlanLeaseState {
    Ready,
    Starting { job_id: Uuid },
    Started { job_id: Uuid },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeSessionState {
    Idle,
    PlaybackLaunching { token: Uuid },
    PlaybackActive { token: Uuid },
    PlaybackStopping { token: Uuid },
    Recording { job_id: Uuid },
}

pub(crate) struct PlaybackSessionReservation {
    sessions: Arc<Mutex<RuntimeSessionState>>,
    cleanup: Arc<dyn IntegrationPort>,
    token: Uuid,
    runtime_launch_started: bool,
    armed: bool,
}

impl PlaybackSessionReservation {
    pub(crate) const fn token(&self) -> Uuid {
        self.token
    }

    pub(crate) const fn begin_runtime_launch(&mut self) {
        self.runtime_launch_started = true;
    }

    pub(crate) async fn mark_active(mut self) -> bool {
        let activated = {
            let mut session = self.sessions.lock().await;
            if matches!(*session, RuntimeSessionState::PlaybackLaunching { token } if token == self.token)
            {
                *session = RuntimeSessionState::PlaybackActive { token: self.token };
                true
            } else {
                false
            }
        };
        if activated {
            self.armed = false;
        }
        activated
    }
}

impl Drop for PlaybackSessionReservation {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let sessions = Arc::clone(&self.sessions);
        let token = self.token;
        if !self.runtime_launch_started {
            let _release_task = tokio::spawn(async move {
                release_playback_session(&sessions, token).await;
            });
            return;
        }
        let cleanup = Arc::clone(&self.cleanup);
        let _cleanup_task = tokio::spawn(async move {
            {
                let mut session = sessions.lock().await;
                if !matches!(
                    *session,
                    RuntimeSessionState::PlaybackLaunching { token: active }
                        | RuntimeSessionState::PlaybackActive { token: active }
                        if active == token
                ) {
                    return;
                }
                *session = RuntimeSessionState::PlaybackStopping { token };
            }
            reconcile_playback_stop(&sessions, &cleanup, token).await;
        });
    }
}

async fn release_playback_session(sessions: &Mutex<RuntimeSessionState>, token: Uuid) {
    let mut session = sessions.lock().await;
    if matches!(
        *session,
        RuntimeSessionState::PlaybackLaunching { token: active }
            | RuntimeSessionState::PlaybackActive { token: active }
            | RuntimeSessionState::PlaybackStopping { token: active }
            if active == token
    ) {
        *session = RuntimeSessionState::Idle;
    }
}

pub(crate) struct PlaybackStopReservation {
    sessions: Arc<Mutex<RuntimeSessionState>>,
    cleanup: Arc<dyn IntegrationPort>,
    token: Uuid,
    armed: bool,
}

impl PlaybackStopReservation {
    pub(crate) const fn token(&self) -> Uuid {
        self.token
    }

    pub(crate) async fn complete(mut self) {
        release_playback_session(&self.sessions, self.token).await;
        self.armed = false;
    }
}

impl Drop for PlaybackStopReservation {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let sessions = Arc::clone(&self.sessions);
        let cleanup = Arc::clone(&self.cleanup);
        let token = self.token;
        let _reconcile_task = tokio::spawn(async move {
            reconcile_playback_stop(&sessions, &cleanup, token).await;
        });
    }
}

async fn reconcile_playback_stop(
    sessions: &Mutex<RuntimeSessionState>,
    cleanup: &Arc<dyn IntegrationPort>,
    token: Uuid,
) {
    let stopped = cleanup
        .request("demo_stop", json!({ "session_token": token }))
        .await
        .ok()
        .and_then(|response| response.get("stopped").and_then(serde_json::Value::as_bool))
        .unwrap_or(false);
    let mut session = sessions.lock().await;
    if !matches!(*session, RuntimeSessionState::PlaybackStopping { token: active } if active == token)
    {
        return;
    }
    *session = if stopped {
        RuntimeSessionState::Idle
    } else {
        RuntimeSessionState::PlaybackActive { token }
    };
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChangedEvent {
    pub resource: String,
    pub action: String,
    pub id: Option<Uuid>,
    pub changed_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct EventHub {
    sender: broadcast::Sender<ChangedEvent>,
}

impl Default for EventHub {
    fn default() -> Self {
        let (sender, _) = broadcast::channel(256);
        Self { sender }
    }
}

impl EventHub {
    pub fn subscribe(&self) -> broadcast::Receiver<ChangedEvent> {
        self.sender.subscribe()
    }

    pub fn publish(&self, resource: &str, action: &str, id: Option<Uuid>) {
        let _ = self.sender.send(ChangedEvent {
            resource: resource.to_owned(),
            action: action.to_owned(),
            id,
            changed_at: Utc::now(),
        });
    }
}

#[derive(Clone)]
pub struct AppState {
    pub(crate) storage: vibe_cs_storage::Storage,
    pub(crate) analysis: Arc<dyn AnalysisPort>,
    pub(crate) analysis_tasks: AnalysisTaskRegistry,
    pub(crate) review: Arc<dyn ReviewPort>,
    pub(crate) cosmetics: Arc<dyn CosmeticsPort>,
    pub(crate) recording: Arc<dyn RecordingPort>,
    pub(crate) exports: Arc<dyn ExportPort>,
    pub(crate) media: Arc<dyn MediaPort>,
    pub(crate) players: Arc<dyn PlayerPort>,
    pub(crate) source_assets: Arc<dyn SourceAssetPort>,
    pub(crate) integrations: Arc<dyn IntegrationPort>,
    pub(crate) demo_watch: Arc<dyn DemoWatchPort>,
    pub(crate) events: EventHub,
    pub(crate) started_at: DateTime<Utc>,
    pub(crate) active_recording: Arc<Mutex<Option<Uuid>>>,
    runtime_session: Arc<Mutex<RuntimeSessionState>>,
    pub(crate) recording_monitors: Arc<Mutex<HashSet<Uuid>>>,
    pub(crate) recording_plans: Arc<Mutex<HashMap<Uuid, RecordingPlanLease>>>,
    /// Probed media facts for the outputs list, keyed by path and size. See
    /// `routes::outputs::attach_media_info` for why it exists and what
    /// invalidates it.
    pub(crate) output_media_cache: OutputMediaCache,
    pub(crate) output_mutations: Arc<Mutex<()>>,
    pub(crate) hlae_preparation: Arc<Mutex<()>>,
    pub(crate) gsi_last_timestamp: Arc<Mutex<Option<i64>>>,
    gsi_token: Arc<str>,
    data_dir: Arc<PathBuf>,
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AppState")
            .field("storage", &self.storage)
            .field("analysis", &self.analysis)
            .field("analysis_tasks", &self.analysis_tasks)
            .field("review", &self.review)
            .field("cosmetics", &self.cosmetics)
            .field("recording", &self.recording)
            .field("exports", &self.exports)
            .field("media", &self.media)
            .field("players", &self.players)
            .field("source_assets", &self.source_assets)
            .field("integrations", &self.integrations)
            .field("demo_watch", &self.demo_watch)
            .field("events", &self.events)
            .field("started_at", &self.started_at)
            .field("data_dir", &self.data_dir)
            .finish_non_exhaustive()
    }
}

impl AppState {
    pub fn new(storage: vibe_cs_storage::Storage, data_dir: PathBuf) -> Self {
        let gsi_token = load_or_create_gsi_token(&data_dir);
        Self {
            storage,
            analysis: Arc::new(DisabledAnalysisPort),
            analysis_tasks: AnalysisTaskRegistry::default(),
            review: Arc::new(DisabledReviewPort),
            cosmetics: Arc::new(DisabledCosmeticsPort),
            recording: Arc::new(DisabledRecordingPort),
            exports: Arc::new(DisabledExportPort),
            media: Arc::new(DisabledMediaPort),
            players: Arc::new(DisabledPlayerPort),
            source_assets: Arc::new(DisabledSourceAssetPort),
            integrations: Arc::new(DisabledIntegrationPort),
            demo_watch: Arc::new(DisabledDemoWatchPort),
            events: EventHub::default(),
            started_at: Utc::now(),
            active_recording: Arc::new(Mutex::new(None)),
            runtime_session: Arc::new(Mutex::new(RuntimeSessionState::Idle)),
            recording_monitors: Arc::new(Mutex::new(HashSet::new())),
            recording_plans: Arc::new(Mutex::new(HashMap::new())),
            output_media_cache: Arc::new(Mutex::new(HashMap::new())),
            output_mutations: Arc::new(Mutex::new(())),
            hlae_preparation: Arc::new(Mutex::new(())),
            gsi_last_timestamp: Arc::new(Mutex::new(None)),
            gsi_token: Arc::from(gsi_token),
            data_dir: Arc::new(data_dir),
        }
    }

    #[must_use]
    pub fn with_analysis(mut self, port: Arc<dyn AnalysisPort>) -> Self {
        self.analysis = port;
        self
    }

    #[must_use]
    pub fn with_review(mut self, port: Arc<dyn ReviewPort>) -> Self {
        self.review = port;
        self
    }

    #[must_use]
    pub fn with_cosmetics(mut self, port: Arc<dyn CosmeticsPort>) -> Self {
        self.cosmetics = port;
        self
    }

    #[must_use]
    pub fn with_recording(mut self, port: Arc<dyn RecordingPort>) -> Self {
        self.recording = port;
        self
    }

    #[must_use]
    pub fn with_exports(mut self, port: Arc<dyn ExportPort>) -> Self {
        self.exports = port;
        self
    }

    #[must_use]
    pub fn with_media(mut self, port: Arc<dyn MediaPort>) -> Self {
        self.media = port;
        self
    }

    #[must_use]
    pub fn with_players(mut self, port: Arc<dyn PlayerPort>) -> Self {
        self.players = port;
        self
    }

    #[must_use]
    pub fn with_source_assets(mut self, port: Arc<dyn SourceAssetPort>) -> Self {
        self.source_assets = port;
        self
    }

    #[must_use]
    pub fn with_integrations(mut self, port: Arc<dyn IntegrationPort>) -> Self {
        self.integrations = port;
        self
    }

    #[must_use]
    pub fn with_demo_watch(mut self, port: Arc<dyn DemoWatchPort>) -> Self {
        self.demo_watch = port;
        self
    }

    #[must_use]
    pub fn storage(&self) -> &vibe_cs_storage::Storage {
        &self.storage
    }

    pub fn data_dir(&self) -> &PathBuf {
        &self.data_dir
    }

    pub fn event_hub(&self) -> EventHub {
        self.events.clone()
    }

    pub(crate) fn gsi_token(&self) -> &str {
        &self.gsi_token
    }

    pub(crate) async fn reserve_playback_session(&self) -> ApiResult<PlaybackSessionReservation> {
        let token = Uuid::new_v4();
        let mut session = self.runtime_session.lock().await;
        let active_recording = *self.active_recording.lock().await;
        if let Some(job_id) = active_recording {
            *session = RuntimeSessionState::Recording { job_id };
            return Err(runtime_session_busy(
                "A recording job is using the local game session",
            ));
        }
        if !matches!(*session, RuntimeSessionState::Idle) {
            return Err(runtime_session_busy(
                "The local game session is already reserved",
            ));
        }
        *session = RuntimeSessionState::PlaybackLaunching { token };
        Ok(PlaybackSessionReservation {
            sessions: Arc::clone(&self.runtime_session),
            cleanup: Arc::clone(&self.integrations),
            token,
            runtime_launch_started: false,
            armed: true,
        })
    }

    pub(crate) async fn reserve_recording_session(
        &self,
        id: Uuid,
        allow_existing: bool,
    ) -> ApiResult<bool> {
        let mut session = self.runtime_session.lock().await;
        let mut active = self.active_recording.lock().await;
        if matches!(
            *session,
            RuntimeSessionState::PlaybackLaunching { .. }
                | RuntimeSessionState::PlaybackActive { .. }
                | RuntimeSessionState::PlaybackStopping { .. }
        ) {
            return Err(runtime_session_busy(
                "Demo playback is using the local game session",
            ));
        }
        if let Some(active_id) = *active {
            if active_id == id && allow_existing {
                *session = RuntimeSessionState::Recording { job_id: id };
                return Ok(false);
            }
            let (code, message) = if active_id == id {
                ("recording_job_active", "Recording job is already active")
            } else {
                (
                    "runtime_session_busy",
                    "A different recording job is already active",
                )
            };
            return Err(ApiError::new(StatusCode::CONFLICT, code, message));
        }
        if let RuntimeSessionState::Recording { job_id } = *session {
            if job_id == id && allow_existing {
                *active = Some(id);
                return Ok(false);
            }
            return Err(runtime_session_busy(
                "A recording job is already using the local game session",
            ));
        }
        *active = Some(id);
        *session = RuntimeSessionState::Recording { job_id: id };
        Ok(true)
    }

    pub(crate) async fn release_recording_session(&self, id: Uuid) {
        let mut session = self.runtime_session.lock().await;
        let mut active = self.active_recording.lock().await;
        if *active == Some(id) {
            *active = None;
        }
        if matches!(*session, RuntimeSessionState::Recording { job_id } if job_id == id) {
            *session = RuntimeSessionState::Idle;
        }
    }

    pub(crate) async fn begin_playback_stop(&self) -> ApiResult<PlaybackStopReservation> {
        let mut session = self.runtime_session.lock().await;
        let token = match *session {
            RuntimeSessionState::PlaybackActive { token } => token,
            RuntimeSessionState::PlaybackLaunching { .. } => {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "playback_launching",
                    "Demo playback is still launching and cannot be stopped yet",
                ));
            }
            RuntimeSessionState::PlaybackStopping { .. } => {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "playback_stopping",
                    "Demo playback is already stopping",
                ));
            }
            RuntimeSessionState::Idle | RuntimeSessionState::Recording { .. } => {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "playback_not_active",
                    "No local demo playback session is active",
                ));
            }
        };
        *session = RuntimeSessionState::PlaybackStopping { token };
        Ok(PlaybackStopReservation {
            sessions: Arc::clone(&self.runtime_session),
            cleanup: Arc::clone(&self.integrations),
            token,
            armed: true,
        })
    }

    pub(crate) async fn runtime_session_snapshot(&self) -> (&'static str, Option<Uuid>) {
        let session = self.runtime_session.lock().await;
        let active_recording = self.active_recording.lock().await;
        match *session {
            RuntimeSessionState::Idle => ("idle", None),
            RuntimeSessionState::PlaybackLaunching { .. } => ("playback_launching", None),
            RuntimeSessionState::PlaybackActive { .. } => ("playback", None),
            RuntimeSessionState::PlaybackStopping { .. } => ("playback_stopping", None),
            RuntimeSessionState::Recording { job_id } => {
                debug_assert_eq!(*active_recording, Some(job_id));
                ("recording", Some(job_id))
            }
        }
    }

    #[cfg(test)]
    pub(crate) async fn lock_runtime_session_for_test(&self) -> impl Drop + '_ {
        self.runtime_session.lock().await
    }
}

fn runtime_session_busy(message: &'static str) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "runtime_session_busy", message)
}

const GSI_TOKEN_FILE_NAME: &str = ".gsi-auth-token";

fn load_or_create_gsi_token(data_dir: &Path) -> String {
    let path = data_dir.join(GSI_TOKEN_FILE_NAME);
    if let Some(token) = read_gsi_token(&path) {
        return token;
    }
    if let Err(error) = std::fs::create_dir_all(data_dir) {
        tracing::error!(%error, path = %data_dir.display(), "unable to create GSI token directory");
        return Uuid::new_v4().to_string();
    }
    let token = Uuid::new_v4().to_string();
    let temporary = data_dir.join(format!("{GSI_TOKEN_FILE_NAME}.{}.tmp", Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    match options.open(&temporary) {
        Ok(mut file) => {
            let persisted = file
                .write_all(token.as_bytes())
                .and_then(|()| file.flush())
                .and_then(|()| file.sync_all());
            if let Err(error) = persisted {
                tracing::error!(%error, path = %temporary.display(), "unable to persist GSI token");
                drop(file);
                let _ = std::fs::remove_file(&temporary);
                return token;
            }
            drop(file);
            let publication = std::fs::hard_link(&temporary, &path);
            let _ = std::fs::remove_file(&temporary);
            match publication {
                Ok(()) => token,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => read_gsi_token(
                    &path,
                )
                .unwrap_or_else(|| {
                    tracing::error!(path = %path.display(), "existing GSI token file is invalid");
                    token
                }),
                Err(error) => {
                    tracing::error!(%error, path = %path.display(), "unable to publish GSI token file");
                    token
                }
            }
        }
        Err(error) => {
            tracing::error!(%error, path = %temporary.display(), "unable to create temporary GSI token file");
            token
        }
    }
}

fn read_gsi_token(path: &Path) -> Option<String> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > 128 {
        return None;
    }
    let token = std::fs::read_to_string(path).ok()?;
    Uuid::parse_str(token.trim())
        .ok()
        .map(|token| token.to_string())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use async_trait::async_trait;

    use super::*;

    #[derive(Debug)]
    struct SuccessfulPlaybackCleanup;

    #[async_trait]
    impl IntegrationPort for SuccessfulPlaybackCleanup {
        async fn request(
            &self,
            capability: &str,
            _request: serde_json::Value,
        ) -> Result<serde_json::Value, vibe_cs_domain::DomainError> {
            assert_eq!(capability, "demo_stop");
            Ok(json!({ "stopped": true }))
        }
    }

    #[tokio::test]
    async fn gsi_token_is_persistent_and_not_exposed_by_debug() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let first = AppState::new(
            vibe_cs_storage::Storage::open_in_memory()
                .await
                .expect("storage"),
            directory.path().to_path_buf(),
        );
        let token = first.gsi_token().to_owned();
        let rendered = format!("{first:?}");
        assert!(!rendered.contains(&token));

        let second = AppState::new(
            vibe_cs_storage::Storage::open_in_memory()
                .await
                .expect("storage"),
            directory.path().to_path_buf(),
        );
        assert_eq!(second.gsi_token(), token);
    }

    #[tokio::test]
    async fn runtime_session_reservations_are_atomic_and_token_scoped() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let state = AppState::new(
            vibe_cs_storage::Storage::open_in_memory()
                .await
                .expect("storage"),
            directory.path().to_path_buf(),
        )
        .with_integrations(Arc::new(SuccessfulPlaybackCleanup));
        let first = state
            .reserve_playback_session()
            .await
            .expect("first playback reservation");
        let first_token = first.token;
        assert!(
            state
                .reserve_recording_session(Uuid::new_v4(), false)
                .await
                .is_err()
        );

        {
            let mut session = state.runtime_session.lock().await;
            *session = RuntimeSessionState::Idle;
        }
        let second = state
            .reserve_playback_session()
            .await
            .expect("second playback reservation");
        let second_token = second.token;
        assert_ne!(first_token, second_token);
        drop(first);
        tokio::task::yield_now().await;
        assert!(matches!(
            *state.runtime_session.lock().await,
            RuntimeSessionState::PlaybackLaunching { token } if token == second_token
        ));

        drop(second);
        for _ in 0..20 {
            if matches!(
                *state.runtime_session.lock().await,
                RuntimeSessionState::Idle
            ) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("dropping the current playback token did not release the session");
    }
}
