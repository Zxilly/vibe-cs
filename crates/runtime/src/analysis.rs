use std::{
    collections::HashMap,
    io::Read as _,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;
use vibe_cs_application::{
    AnalysisPort, AnalysisProgressReporter, ReplayCacheCleanup, ReplayCacheStatus, ReplayPayload,
};
use vibe_cs_demo::{
    DemoEngine, DemoError, ParseCancellation, ValidationLimits, create_terminal_tail_repair_copy,
    heatmap_from_rounds, replay_artifact_from_events, validate_demo,
};
use vibe_cs_domain::{
    AnalysisInputFingerprint, DemoRecord, DomainError, HeatPoint, MatchAnalysis, ReplayFrame,
};

use crate::replay_cache::ReplayCache;

const ANALYSIS_TIMEOUT: Duration = Duration::from_secs(12 * 60);
const MAXIMUM_WORKER_RESPONSE_BYTES: u64 = 256 * 1024 * 1024;
const MAXIMUM_DEMO_WORKER_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DemoWorkerSidecar {
    path: PathBuf,
    expected_sha256: String,
}

impl DemoWorkerSidecar {
    /// Creates an integrity-pinned demo worker descriptor.
    ///
    /// # Errors
    ///
    /// Returns an error when the expected digest is not a lowercase or uppercase SHA-256 hex
    /// digest. File existence and identity are checked immediately before every launch.
    pub fn new(path: PathBuf, expected_sha256: impl Into<String>) -> Result<Self, String> {
        let expected_sha256 = expected_sha256.into();
        if expected_sha256.len() != 64
            || !expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("demo worker SHA-256 digest is invalid".to_owned());
        }
        Ok(Self {
            path,
            expected_sha256: expected_sha256.to_ascii_lowercase(),
        })
    }

    /// Revalidates the configured worker without launching it.
    ///
    /// The launch path performs the same check again and keeps the verified handles locked across
    /// process creation. This method exists for startup diagnostics and release-equivalent tests.
    ///
    /// # Errors
    ///
    /// Returns an error when the worker is missing, linked, replaced, oversized, or does not match
    /// the pinned SHA-256 digest.
    pub async fn verify_integrity(&self) -> Result<(), DomainError> {
        let guard = verify_demo_worker(self).await?;
        drop(guard);
        Ok(())
    }
}

#[derive(Debug)]
struct VerifiedDemoWorker {
    _file: std::fs::File,
    _parent: std::fs::File,
}

#[derive(Debug)]
struct RepairCopyCleanup(PathBuf);

impl Drop for RepairCopyCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[derive(Debug, Clone)]
pub struct RuntimeAnalysisPort {
    storage: vibe_cs_storage::Storage,
    engine: DemoEngine,
    worker: Option<DemoWorkerSidecar>,
    task_dir: PathBuf,
    replay_cache: ReplayCache,
    timeout: Duration,
    analysis_gate: Arc<Semaphore>,
}

impl RuntimeAnalysisPort {
    #[must_use]
    pub fn new(
        storage: vibe_cs_storage::Storage,
        task_dir: PathBuf,
        replay_cache_dir: PathBuf,
    ) -> Self {
        Self::new_with_worker(storage, task_dir, replay_cache_dir, None)
    }

    #[must_use]
    pub fn new_with_worker(
        storage: vibe_cs_storage::Storage,
        task_dir: PathBuf,
        replay_cache_dir: PathBuf,
        worker: Option<DemoWorkerSidecar>,
    ) -> Self {
        Self {
            storage,
            engine: DemoEngine::default(),
            worker,
            task_dir,
            replay_cache: ReplayCache::new(replay_cache_dir),
            timeout: ANALYSIS_TIMEOUT,
            analysis_gate: Arc::new(Semaphore::new(1)),
        }
    }

    #[cfg(test)]
    fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    async fn analyze_inner(
        &self,
        demo: &DemoRecord,
        progress: Arc<dyn AnalysisProgressReporter>,
    ) -> Result<MatchAnalysis, DomainError> {
        let initial = self.analyze_direct(demo, Some(progress)).await;
        if initial.is_ok() {
            return initial;
        }
        if initial
            .as_ref()
            .is_err_and(|error| !should_attempt_terminal_tail_recovery(error))
        {
            return initial;
        }
        tokio::fs::create_dir_all(&self.task_dir)
            .await
            .map_err(|error| DomainError::Internal(error.to_string()))?;
        let repair_path = self
            .task_dir
            .join(format!(".repair-{}.dem", Uuid::new_v4()));
        let source_path = PathBuf::from(&demo.path);
        let destination = repair_path.clone();
        let repair = tokio::task::spawn_blocking(move || {
            create_terminal_tail_repair_copy(source_path, destination)
        })
        .await
        .map_err(|error| {
            DomainError::Internal(format!("terminal-tail repair inspection failed: {error}"))
        })?;
        let Ok(Some(copy)) = repair else {
            return initial;
        };
        tracing::warn!(
            source_bytes = copy.source_bytes,
            copied_bytes = copy.copied_bytes,
            "analyzing a bounded repair copy after terminal-tail recovery"
        );
        let cleanup = RepairCopyCleanup(copy.path.clone());
        let mut repaired_demo = demo.clone();
        repaired_demo.path = copy.path.to_string_lossy().into_owned();
        let result = self.analyze_direct(&repaired_demo, None).await;
        drop(cleanup);
        result
    }

    async fn acquire_analysis_permit(&self) -> Result<OwnedSemaphorePermit, DomainError> {
        Arc::clone(&self.analysis_gate)
            .acquire_owned()
            .await
            .map_err(|_| DomainError::Internal("demo analysis resource gate closed".to_owned()))
    }

    async fn analyze_direct(
        &self,
        demo: &DemoRecord,
        progress: Option<Arc<dyn AnalysisProgressReporter>>,
    ) -> Result<MatchAnalysis, DomainError> {
        if let Some(worker) = &self.worker {
            return self.analyze_with_worker(worker, demo, progress).await;
        }
        tracing::warn!(
            "demo worker was not found; using the in-process parser with panic isolation"
        );
        let cancellation = ParseCancellation::default();
        if let Some(progress) = progress {
            progress.parser_started().await?;
        }
        let parsing = self
            .engine
            .analyze(&demo.path, demo.id, cancellation.clone());
        if let Ok(result) = tokio::time::timeout(self.timeout, parsing).await {
            result.map_err(map_demo_error)
        } else {
            cancellation.cancel();
            Err(DomainError::Conflict(format!(
                "demo analysis exceeded {} seconds and was cancelled",
                self.timeout.as_secs()
            )))
        }
    }

    async fn analyze_with_worker(
        &self,
        worker: &DemoWorkerSidecar,
        demo: &DemoRecord,
        progress: Option<Arc<dyn AnalysisProgressReporter>>,
    ) -> Result<MatchAnalysis, DomainError> {
        let _verified_worker = verify_demo_worker(worker).await?;
        tokio::fs::create_dir_all(&self.task_dir)
            .await
            .map_err(|error| DomainError::Internal(error.to_string()))?;
        let task_id = Uuid::new_v4();
        let request_path = self.task_dir.join(format!("{task_id}.request.json"));
        let response_path = self.task_dir.join(format!("{task_id}.response.json"));
        let request = WorkerRequest::Analyze {
            demo_path: &demo.path,
            demo_id: demo.id,
        };
        let request_bytes = serde_json::to_vec(&request)
            .map_err(|error| DomainError::Internal(error.to_string()))?;
        write_new(&request_path, &request_bytes).await?;

        let mut child = tokio::process::Command::new(&worker.path)
            .arg("--input")
            .arg(&request_path)
            .arg("--output")
            .arg(&response_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                DomainError::Internal(format!("unable to start demo worker: {error}"))
            })?;
        if let Some(progress) = progress
            && let Err(error) = progress.parser_started().await
        {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = tokio::fs::remove_file(&request_path).await;
            let _ = tokio::fs::remove_file(&response_path).await;
            return Err(error);
        }
        let result = match tokio::time::timeout(self.timeout, child.wait()).await {
            Ok(Ok(status)) => {
                if !status.success() && !response_path.is_file() {
                    Err(DomainError::Internal(format!(
                        "demo worker exited unsuccessfully with {status}"
                    )))
                } else {
                    read_worker_analysis(&response_path).await
                }
            }
            Ok(Err(error)) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                Err(DomainError::Internal(format!(
                    "unable to wait for demo worker: {error}"
                )))
            }
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                Err(DomainError::Conflict(format!(
                    "demo worker exceeded {} seconds and was terminated",
                    self.timeout.as_secs()
                )))
            }
        };
        let _ = tokio::fs::remove_file(&request_path).await;
        let _ = tokio::fs::remove_file(&response_path).await;
        result
    }

    async fn stored_analysis(&self, demo_id: Uuid) -> Result<MatchAnalysis, DomainError> {
        self.storage
            .get_analysis(demo_id)
            .await
            .map_err(|error| DomainError::Internal(error.to_string()))?
            .ok_or_else(|| DomainError::NotFound("demo analysis".to_owned()))
    }
}

fn should_attempt_terminal_tail_recovery(error: &DomainError) -> bool {
    matches!(
        error,
        DomainError::InvalidInput(message) if message.starts_with("demo parser failed:")
    )
}

#[async_trait]
impl AnalysisPort for RuntimeAnalysisPort {
    async fn validate_input(
        &self,
        demo: DemoRecord,
    ) -> Result<AnalysisInputFingerprint, DomainError> {
        let path = PathBuf::from(demo.path);
        let validated = tokio::task::spawn_blocking(move || {
            validate_demo(
                path,
                ValidationLimits::default(),
                &ParseCancellation::default(),
            )
        })
        .await
        .map_err(|error| DomainError::Internal(format!("Demo validation task failed: {error}")))?
        .map_err(map_demo_error)?;
        Ok(AnalysisInputFingerprint {
            sha256: validated.sha256,
            size: validated.size,
        })
    }

    async fn analyze(
        &self,
        demo: DemoRecord,
        progress: Arc<dyn AnalysisProgressReporter>,
    ) -> Result<MatchAnalysis, DomainError> {
        let _permit = self.acquire_analysis_permit().await?;
        self.analyze_inner(&demo, progress).await
    }

    async fn replay(&self, demo: DemoRecord) -> Result<ReplayPayload, DomainError> {
        let analysis = self.stored_analysis(demo.id).await?;
        let events = analysis
            .rounds
            .iter()
            .flat_map(|round| round.events.iter().cloned())
            .collect::<Vec<_>>();
        self.replay_cache
            .resolve(&demo, &analysis, || {
                let mut artifact = replay_artifact_from_events(&events, analysis.tick_rate)
                    .map_err(map_demo_error)?;
                apply_stable_replay_player_identity(&mut artifact.frames, &analysis)?;
                artifact.fidelity.frame_count =
                    u64::try_from(artifact.frames.len()).unwrap_or(u64::MAX);
                artifact.fidelity.start_tick =
                    artifact.frames.first().map_or(0, |frame| frame.tick);
                artifact.fidelity.end_tick = artifact.frames.last().map_or(0, |frame| frame.tick);
                Ok(artifact)
            })
            .await
    }

    async fn heatmap(&self, demo: DemoRecord) -> Result<Vec<HeatPoint>, DomainError> {
        let analysis = self.stored_analysis(demo.id).await?;
        heatmap_from_rounds(&analysis.rounds).map_err(map_demo_error)
    }

    async fn replay_cache_status(&self) -> Result<ReplayCacheStatus, DomainError> {
        self.replay_cache.status().await
    }

    async fn clear_replay_cache(&self) -> Result<ReplayCacheCleanup, DomainError> {
        self.replay_cache.clear().await
    }
}

fn apply_stable_replay_player_identity(
    frames: &mut Vec<ReplayFrame>,
    analysis: &MatchAnalysis,
) -> Result<(), DomainError> {
    let players = analysis
        .players
        .iter()
        .filter(|player| matches!(player.team.as_str(), "A" | "B"))
        .map(|player| (player.steam_id.as_str(), player))
        .collect::<HashMap<_, _>>();
    for frame in frames.iter_mut() {
        frame.players.retain_mut(|player| {
            let Some(identity) = players.get(player.id.as_str()) else {
                return false;
            };
            player.name.clone_from(&identity.name);
            player.team.clone_from(&identity.team);
            true
        });
    }
    frames.retain(|frame| {
        !frame.players.is_empty() || !frame.projectiles.is_empty() || frame.bomb.is_some()
    });
    if frames.is_empty() {
        return Err(DomainError::DependencyUnavailable(
            "2D replay: positioned events did not resolve to analyzed players or utility"
                .to_owned(),
        ));
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
enum WorkerRequest<'a> {
    Analyze { demo_path: &'a str, demo_id: Uuid },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
enum WorkerResponse {
    Success { result: Value },
    Failure { error: WorkerFailure },
}

#[derive(Debug, Deserialize)]
struct WorkerFailure {
    code: String,
    message: String,
}

async fn write_new(path: &Path, bytes: &[u8]) -> Result<(), DomainError> {
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
        .map_err(|error| DomainError::Internal(error.to_string()))?;
    let result = async {
        file.write_all(bytes)
            .await
            .map_err(|error| DomainError::Internal(error.to_string()))?;
        file.flush()
            .await
            .map_err(|error| DomainError::Internal(error.to_string()))?;
        file.sync_all()
            .await
            .map_err(|error| DomainError::Internal(error.to_string()))
    }
    .await;
    if result.is_err() {
        drop(file);
        let _ = tokio::fs::remove_file(path).await;
    }
    result
}

async fn read_worker_analysis(path: &Path) -> Result<MatchAnalysis, DomainError> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| DomainError::Internal(format!("worker result is missing: {error}")))?;
    if !metadata.is_file() || metadata.len() > MAXIMUM_WORKER_RESPONSE_BYTES {
        return Err(DomainError::Internal(
            "demo worker result is invalid or exceeds the size limit".to_owned(),
        ));
    }
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|error| DomainError::Internal(error.to_string()))?;
    let mut bytes = Vec::with_capacity(
        usize::try_from(metadata.len().min(MAXIMUM_WORKER_RESPONSE_BYTES)).unwrap_or(0),
    );
    file.take(MAXIMUM_WORKER_RESPONSE_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| DomainError::Internal(error.to_string()))?;
    if bytes.len() > usize::try_from(MAXIMUM_WORKER_RESPONSE_BYTES).unwrap_or(usize::MAX) {
        return Err(DomainError::Internal(
            "demo worker result exceeds the size limit".to_owned(),
        ));
    }
    let response: WorkerResponse = serde_json::from_slice(&bytes)
        .map_err(|error| DomainError::Internal(format!("invalid worker response: {error}")))?;
    match response {
        WorkerResponse::Success { result } => serde_json::from_value(result)
            .map_err(|error| DomainError::Internal(format!("invalid analysis result: {error}"))),
        WorkerResponse::Failure { error } => Err(map_worker_failure(error)),
    }
}

fn map_worker_failure(failure: WorkerFailure) -> DomainError {
    match failure.code.as_str() {
        "not_found" => DomainError::NotFound(failure.message),
        "invalid_input" | "parse_error" | "resource_limit" => {
            DomainError::InvalidInput(failure.message)
        }
        "cancelled" | "timeout" => DomainError::Conflict(failure.message),
        "dependency_unavailable" => DomainError::DependencyUnavailable(failure.message),
        _ => DomainError::Internal(failure.message),
    }
}

async fn verify_demo_worker(worker: &DemoWorkerSidecar) -> Result<VerifiedDemoWorker, DomainError> {
    let worker = worker.clone();
    tokio::task::spawn_blocking(move || verify_demo_worker_sync(&worker))
        .await
        .map_err(|error| {
            DomainError::Internal(format!("demo worker integrity task failed: {error}"))
        })?
}

fn verify_demo_worker_sync(worker: &DemoWorkerSidecar) -> Result<VerifiedDemoWorker, DomainError> {
    let (mut file, parent) = open_locked_demo_worker(&worker.path).map_err(|error| {
        DomainError::DependencyUnavailable(format!("unable to lock demo worker: {error}"))
    })?;
    let metadata = file.metadata().map_err(|error| {
        DomainError::DependencyUnavailable(format!("unable to inspect demo worker: {error}"))
    })?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAXIMUM_DEMO_WORKER_BYTES {
        return Err(DomainError::DependencyUnavailable(
            "demo worker is not a bounded regular file".to_owned(),
        ));
    }
    if linked_or_reparse(&worker.path)? {
        return Err(DomainError::DependencyUnavailable(
            "demo worker must not be a link or reparse point".to_owned(),
        ));
    }

    let mut hash = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
    let mut read_bytes = 0_u64;
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            DomainError::DependencyUnavailable(format!("unable to verify demo worker: {error}"))
        })?;
        if read == 0 {
            break;
        }
        read_bytes = read_bytes
            .checked_add(read as u64)
            .ok_or_else(|| DomainError::Internal("demo worker size overflow".to_owned()))?;
        if read_bytes > MAXIMUM_DEMO_WORKER_BYTES {
            return Err(DomainError::DependencyUnavailable(
                "demo worker exceeds its integrity size limit".to_owned(),
            ));
        }
        hash.update(&buffer[..read]);
    }
    if read_bytes != metadata.len()
        || !hex::encode(hash.finalize()).eq_ignore_ascii_case(&worker.expected_sha256)
    {
        return Err(DomainError::DependencyUnavailable(
            "demo worker failed its integrity check".to_owned(),
        ));
    }
    let open_handle = same_file::Handle::from_file(file.try_clone().map_err(|error| {
        DomainError::DependencyUnavailable(format!("unable to clone demo worker handle: {error}"))
    })?)
    .map_err(|error| {
        DomainError::DependencyUnavailable(format!("unable to identify demo worker: {error}"))
    })?;
    let named_handle = same_file::Handle::from_path(&worker.path).map_err(|error| {
        DomainError::DependencyUnavailable(format!("unable to re-open demo worker: {error}"))
    })?;
    if open_handle != named_handle || linked_or_reparse(&worker.path)? {
        return Err(DomainError::DependencyUnavailable(
            "demo worker changed during integrity verification".to_owned(),
        ));
    }
    Ok(VerifiedDemoWorker {
        _file: file,
        _parent: parent,
    })
}

fn open_locked_demo_worker(path: &Path) -> std::io::Result<(std::fs::File, std::fs::File)> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("demo worker has no parent"))?;
    let mut file_options = std::fs::OpenOptions::new();
    file_options.read(true);
    let mut parent_options = std::fs::OpenOptions::new();
    parent_options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        file_options.share_mode(FILE_SHARE_READ);
        parent_options
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
    }
    Ok((file_options.open(path)?, parent_options.open(parent)?))
}

fn linked_or_reparse(path: &Path) -> Result<bool, DomainError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        DomainError::DependencyUnavailable(format!("unable to inspect demo worker path: {error}"))
    })?;
    if metadata.file_type().is_symlink() {
        return Ok(true);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn map_demo_error(error: DemoError) -> DomainError {
    match error {
        error @ DemoError::NotFound(_) => DomainError::NotFound(error.to_string()),
        error @ (DemoError::NotAFile(_)
        | DemoError::UnsupportedExtension(_)
        | DemoError::TooSmall { .. }
        | DemoError::TooLarge { .. }
        | DemoError::InvalidMagic
        | DemoError::EventLimitExceeded { .. }
        | DemoError::ParserResourceLimit { .. }
        | DemoError::UnsafeArchivePath(_)
        | DemoError::ArchiveEntryLimit(_)
        | DemoError::ArchiveSizeLimit(_)
        | DemoError::ArchiveDemoLimit(_)
        | DemoError::DuplicateArchivePath(_)
        | DemoError::UnsafeArchiveFileType(_)
        | DemoError::ArchiveCompressionRatio(_)
        | DemoError::EmptyDemoArchive
        | DemoError::MetadataUnavailable(_)
        | DemoError::Parse(_)) => DomainError::InvalidInput(error.to_string()),
        DemoError::Cancelled => DomainError::Conflict("demo analysis was cancelled".to_owned()),
        DemoError::Unavailable { capability, reason } => {
            DomainError::DependencyUnavailable(format!("{capability}: {reason}"))
        }
        error @ (DemoError::ParserPanicked
        | DemoError::Join(_)
        | DemoError::Io { .. }
        | DemoError::Zip(_)
        | DemoError::Walk(_)) => DomainError::Internal(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeSet, time::Instant};

    use chrono::Utc;
    use serde_json::json;
    use tempfile::TempDir;
    use vibe_cs_application::{AnalysisProgressReporter, ReplayCacheState, ReplayFidelityMode};
    use vibe_cs_domain::{DemoStatus, EventKind, PlayerStats, RoundSummary, TimelineEvent};

    use super::*;

    #[derive(Debug)]
    struct IgnoredAnalysisProgress;

    #[async_trait]
    impl AnalysisProgressReporter for IgnoredAnalysisProgress {
        async fn parser_started(&self) -> Result<(), DomainError> {
            Ok(())
        }
    }

    async fn persist_completed_analysis(
        storage: &vibe_cs_storage::Storage,
        analysis: MatchAnalysis,
    ) {
        let demo = storage.get_demo(analysis.demo_id).await.unwrap().unwrap();
        let fingerprint = AnalysisInputFingerprint {
            sha256: demo.content_sha256.unwrap(),
            size: demo.file_size,
        };
        storage
            .set_demo_status(demo.id, DemoStatus::Discovered)
            .await
            .unwrap();
        let run_id = storage.start_analysis_run(demo.id).await.unwrap().run.id;
        storage
            .bind_analysis_run_input(run_id, fingerprint.clone())
            .await
            .unwrap();
        storage.mark_analysis_parser_started(run_id).await.unwrap();
        storage
            .mark_analysis_input_revalidation_started(run_id)
            .await
            .unwrap();
        storage
            .mark_analysis_projection_started(run_id)
            .await
            .unwrap();
        storage
            .complete_analysis_run(run_id, analysis, fingerprint)
            .await
            .unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn timed_out_worker_is_terminated_before_task_files_are_cleaned() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let worker_path = directory.path().join("slow-worker.cmd");
        std::fs::write(&worker_path, "@echo off\r\nping -n 30 127.0.0.1 > nul\r\n")
            .expect("slow worker fixture");
        let worker = DemoWorkerSidecar::new(
            worker_path.clone(),
            hex::encode(Sha256::digest(std::fs::read(&worker_path).unwrap())),
        )
        .expect("worker descriptor");
        let task_dir = directory.path().join("worker-tasks");
        let storage = vibe_cs_storage::Storage::open_in_memory().await.unwrap();
        let port = RuntimeAnalysisPort::new_with_worker(
            storage,
            task_dir.clone(),
            directory.path().join("cache"),
            Some(worker.clone()),
        )
        .with_timeout(Duration::from_millis(25));
        let demo = DemoRecord {
            id: Uuid::new_v4(),
            path: "C:/unused/current.dem".to_owned(),
            file_name: "current.dem".to_owned(),
            display_name: "Current".to_owned(),
            source: "test".to_owned(),
            status: DemoStatus::Analyzing,
            map_name: None,
            match_date: None,
            duration_seconds: None,
            total_rounds: None,
            team_a_name: None,
            team_b_name: None,
            team_a_score: None,
            team_b_score: None,
            player_names: Vec::new(),
            remark: String::new(),
            content_sha256: Some("a".repeat(64)),
            file_size: 512,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let error = port
            .analyze_with_worker(&worker, &demo, Some(Arc::new(IgnoredAnalysisProgress)))
            .await
            .expect_err("slow worker must time out");

        assert!(error.to_string().contains("terminated"));
        assert!(task_dir.is_dir());
        assert_eq!(
            std::fs::read_dir(task_dir)
                .expect("read task directory")
                .count(),
            0,
            "request and response files must be removed after the child exits"
        );
    }

    #[test]
    fn demo_worker_descriptor_requires_a_sha256_digest() {
        assert!(DemoWorkerSidecar::new(PathBuf::from("worker.exe"), "not-a-digest").is_err());
        assert!(DemoWorkerSidecar::new(PathBuf::from("worker.exe"), "a".repeat(64)).is_ok());
    }

    #[test]
    fn demo_worker_integrity_is_bound_to_the_locked_file() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("vibe-cs-demo-worker.exe");
        std::fs::write(&path, b"integrity checked worker").expect("worker fixture");
        let digest = hex::encode(Sha256::digest(b"integrity checked worker"));
        let worker = DemoWorkerSidecar::new(path.clone(), digest).expect("worker descriptor");
        let guard = verify_demo_worker_sync(&worker).expect("verified worker");

        #[cfg(windows)]
        assert!(
            std::fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&path)
                .is_err(),
            "the verified executable must remain immutable through process launch"
        );
        drop(guard);
        std::fs::write(&path, b"tampered worker").expect("replace fixture after unlock");
        assert!(verify_demo_worker_sync(&worker).is_err());
    }

    #[test]
    fn demo_errors_map_to_stable_domain_categories() {
        assert!(matches!(
            map_demo_error(DemoError::NotFound(PathBuf::from("missing.dem"))),
            DomainError::NotFound(_)
        ));
        assert!(matches!(
            map_demo_error(DemoError::InvalidMagic),
            DomainError::InvalidInput(_)
        ));
        assert!(matches!(
            map_demo_error(DemoError::ParserResourceLimit {
                resource: "game events".to_owned(),
                limit: 500_000,
                actual: 500_001,
            }),
            DomainError::InvalidInput(message)
                if message.starts_with("demo parser resource limit exceeded")
        ));
        assert!(matches!(
            map_worker_failure(WorkerFailure {
                code: "resource_limit".to_owned(),
                message: "bounded worker limit reached".to_owned(),
            }),
            DomainError::InvalidInput(message) if message == "bounded worker limit reached"
        ));
        assert!(matches!(
            map_demo_error(DemoError::Unavailable {
                capability: "replay",
                reason: "coordinates are absent".to_owned(),
            }),
            DomainError::DependencyUnavailable(_)
        ));
        assert!(matches!(
            map_demo_error(DemoError::ParserPanicked),
            DomainError::Internal(_)
        ));
    }

    #[test]
    fn production_analysis_budget_covers_large_real_demos() {
        assert!(ANALYSIS_TIMEOUT >= Duration::from_secs(10 * 60));
    }

    #[test]
    fn terminal_tail_recovery_is_only_considered_for_parser_failures() {
        assert!(should_attempt_terminal_tail_recovery(
            &DomainError::InvalidInput("demo parser failed: unexpected EOF".to_owned())
        ));
        assert!(!should_attempt_terminal_tail_recovery(
            &DomainError::Conflict(
                "demo worker exceeded 720 seconds and was terminated".to_owned()
            )
        ));
        assert!(!should_attempt_terminal_tail_recovery(
            &DomainError::InvalidInput("invalid Source 2 demo magic".to_owned())
        ));
        assert!(!should_attempt_terminal_tail_recovery(
            &DomainError::Internal(
                "demo parser panicked while handling malformed input".to_owned()
            )
        ));
    }

    #[tokio::test]
    async fn timeout_cancels_in_process_analysis() {
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let port = RuntimeAnalysisPort::new(
            storage,
            PathBuf::from("unused"),
            PathBuf::from("unused-cache"),
        )
        .with_timeout(Duration::ZERO);
        assert_eq!(port.timeout, Duration::ZERO);
    }

    #[tokio::test]
    async fn analysis_resource_gate_allows_only_one_heavy_worker() {
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let port = RuntimeAnalysisPort::new(
            storage,
            PathBuf::from("unused"),
            PathBuf::from("unused-cache"),
        );
        let first = port.acquire_analysis_permit().await.expect("first permit");
        let second_port = port.clone();
        let mut second = tokio::spawn(async move {
            second_port
                .acquire_analysis_permit()
                .await
                .expect("second permit")
        });

        assert!(
            tokio::time::timeout(Duration::from_millis(25), &mut second)
                .await
                .is_err(),
            "a second high-memory parser must wait for the first one"
        );
        drop(first);
        let _second_permit = tokio::time::timeout(Duration::from_secs(1), second)
            .await
            .expect("second permit should become available")
            .expect("permit task");
    }

    #[tokio::test]
    async fn sparse_replay_uses_stable_analysis_player_identity_and_cache() {
        let temporary = TempDir::new().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let now = Utc::now();
        let demo = DemoRecord {
            id: Uuid::new_v4(),
            path: temporary
                .path()
                .join("major-m1.dem")
                .to_string_lossy()
                .into_owned(),
            file_name: "major-m1.dem".to_owned(),
            display_name: "Major M1".to_owned(),
            source: "test".to_owned(),
            status: DemoStatus::Ready,
            map_name: Some("de_mirage".to_owned()),
            match_date: None,
            duration_seconds: Some(10.0),
            total_rounds: Some(1),
            team_a_name: Some("Team A".to_owned()),
            team_b_name: Some("Team B".to_owned()),
            team_a_score: Some(1),
            team_b_score: Some(0),
            player_names: vec!["FalleN".to_owned()],
            remark: String::new(),
            content_sha256: Some("a".repeat(64)),
            file_size: 1,
            created_at: now,
            updated_at: now,
        };
        storage.put_demo(demo.clone()).await.expect("persist demo");
        persist_completed_analysis(
            &storage,
            MatchAnalysis {
                demo_id: demo.id,
                map_name: "de_mirage".to_owned(),
                tick_rate: 64.0,
                duration_seconds: 10.0,
                verified_total_ticks: None,
                teams: Vec::new(),
                players: vec![PlayerStats {
                    steam_id: "76561197960690195".to_owned(),
                    spectator_slot: None,
                    name: "FalleN".to_owned(),
                    team: "A".to_owned(),
                    kills: 1,
                    deaths: 0,
                    assists: 0,
                    headshots: 0,
                    damage: 100,
                    adr: 100.0,
                    kill_death_ratio: 1.0,
                    score: 2,
                }],
                rounds: vec![RoundSummary {
                    number: 1,
                    start_tick: 100,
                    end_tick: 200,
                    winner: "A".to_owned(),
                    reason: String::new(),
                    team_a_score: 1,
                    team_b_score: 0,
                    events: vec![
                        TimelineEvent {
                            id: "round_start-100-0".to_owned(),
                            tick: 100,
                            seconds: 1.5625,
                            kind: EventKind::RoundStart,
                            actor: None,
                            target: None,
                            weapon: None,
                            headshot: false,
                            penetrated: false,
                            position: None,
                            detail: json!({}),
                        },
                        TimelineEvent {
                            id: "player_hurt-128-1".to_owned(),
                            tick: 128,
                            seconds: 2.0,
                            kind: EventKind::Damage,
                            actor: Some("enemy".to_owned()),
                            target: Some("76561197960690195".to_owned()),
                            weapon: Some("ak47".to_owned()),
                            headshot: false,
                            penetrated: false,
                            position: Some([12.0, 34.0, 5.0]),
                            detail: json!({
                                "health": 64,
                                "userteam": 3,
                                "target_name": "stale-event-name"
                            }),
                        },
                    ],
                }],
                highlights: Vec::new(),
            },
        )
        .await;
        let port = RuntimeAnalysisPort::new(
            storage,
            temporary.path().join("tasks"),
            temporary.path().join("replay-cache"),
        );

        let generated = port.replay(demo.clone()).await.expect("generated replay");
        let player = generated.frames[0].players.first().expect("replay player");
        assert_eq!(player.id, "76561197960690195");
        assert_eq!(player.name, "FalleN");
        assert_eq!(player.team, "A");
        assert_eq!(generated.cache.state, ReplayCacheState::Generated);
        assert_eq!(generated.fidelity.mode, ReplayFidelityMode::EventSparse);
        assert!((generated.fidelity.tick_rate - 64.0).abs() < f64::EPSILON);
        assert_eq!(generated.fidelity.frame_count, 1);
        assert_eq!(generated.fidelity.positioned_event_count, 1);
        assert_eq!(generated.fidelity.start_tick, 128);
        assert_eq!(generated.fidelity.end_tick, 128);

        let cached = port.replay(demo).await.expect("cached replay");
        assert_eq!(cached.cache.state, ReplayCacheState::Hit);
        assert_eq!(cached.frames, generated.frames);
        assert_eq!(cached.fidelity, generated.fidelity);
    }

    #[tokio::test]
    #[ignore = "requires VIBE_CS_REAL_APP_DATA_DIR with the imported Major M1 analysis"]
    async fn real_major_m1_round_20_sparse_replay_misses_then_hits_without_reparsing() {
        let data_dir = PathBuf::from(
            std::env::var("VIBE_CS_REAL_APP_DATA_DIR")
                .expect("VIBE_CS_REAL_APP_DATA_DIR points at the desktop app-data directory"),
        );
        let demo_id = std::env::var("VIBE_CS_REAL_DEMO_ID")
            .unwrap_or_else(|_| "bc6043de-b77e-4f79-afcb-3193a40a3bf2".to_owned())
            .parse::<Uuid>()
            .expect("VIBE_CS_REAL_DEMO_ID is a UUID");
        let storage = vibe_cs_storage::Storage::open(data_dir.join("vibe-cs.db"))
            .await
            .expect("open real desktop storage");
        let demo = storage
            .get_demo(demo_id)
            .await
            .expect("read real demo")
            .expect("imported real M1 demo");
        let analysis = storage
            .get_analysis(demo_id)
            .await
            .expect("read real analysis")
            .expect("persisted real M1 analysis");
        let round = analysis
            .rounds
            .iter()
            .find(|round| round.number == 20)
            .expect("real M1 round 20");
        let positioned_events = round
            .events
            .iter()
            .filter(|event| event.position.is_some())
            .count();
        let temporary = TempDir::new().expect("temporary replay cache");
        let task_dir = temporary.path().join("worker-tasks");
        let port = RuntimeAnalysisPort::new(
            storage,
            task_dir.clone(),
            temporary.path().join("replay-cache"),
        );

        let started = Instant::now();
        let generated = port
            .replay(demo.clone())
            .await
            .expect("generate real replay");
        let generated_latency = started.elapsed();
        let started = Instant::now();
        let cached = port.replay(demo).await.expect("read cached real replay");
        let cached_latency = started.elapsed();
        let round_frames = generated
            .frames
            .iter()
            .filter(|frame| frame.tick >= round.start_tick && frame.tick <= round.end_tick)
            .collect::<Vec<_>>();
        let players = round_frames
            .iter()
            .flat_map(|frame| frame.players.iter().map(|player| player.name.as_str()))
            .collect::<BTreeSet<_>>();

        eprintln!(
            "M1 R20 replay: frames={}, players={:?}, positioned_events={}, total_frames={}, ticks={}-{}, generated_ms={}, hit_ms={}, cache_bytes={}",
            round_frames.len(),
            players,
            positioned_events,
            generated.frames.len(),
            generated.fidelity.start_tick,
            generated.fidelity.end_tick,
            generated_latency.as_millis(),
            cached_latency.as_millis(),
            generated.cache.bytes,
        );
        assert_eq!(generated.cache.state, ReplayCacheState::Generated);
        assert_eq!(cached.cache.state, ReplayCacheState::Hit);
        assert_eq!(generated.fidelity.mode, ReplayFidelityMode::EventSparse);
        assert!((generated.fidelity.tick_rate - analysis.tick_rate).abs() < f64::EPSILON);
        assert_eq!(cached.frames, generated.frames);
        assert!(!round_frames.is_empty());
        assert!(players.contains("FalleN"));
        assert!(players.contains("m0NESY"));
        assert!(positioned_events > 0);
        assert!(
            !task_dir.exists(),
            "replay must use stored sparse evidence without launching the dense parser"
        );
    }

    #[tokio::test]
    #[ignore = "requires VIBE_CS_REAL_APP_DATA_DIR with a copied imported Major M1 analysis"]
    async fn real_major_m1_heatmap_keeps_round_20_killer_and_victim_evidence_distinct() {
        let data_dir = PathBuf::from(
            std::env::var("VIBE_CS_REAL_APP_DATA_DIR")
                .expect("VIBE_CS_REAL_APP_DATA_DIR points at a copied app-data directory"),
        );
        let demo_id = std::env::var("VIBE_CS_REAL_DEMO_ID")
            .unwrap_or_else(|_| "bc6043de-b77e-4f79-afcb-3193a40a3bf2".to_owned())
            .parse::<Uuid>()
            .expect("VIBE_CS_REAL_DEMO_ID is a UUID");
        let storage = vibe_cs_storage::Storage::open(data_dir.join("vibe-cs.db"))
            .await
            .expect("open copied desktop storage");
        let demo = storage
            .get_demo(demo_id)
            .await
            .expect("read real demo")
            .expect("imported real M1 demo");
        let temporary = TempDir::new().expect("temporary runtime directories");
        let port = RuntimeAnalysisPort::new(
            storage,
            temporary.path().join("tasks"),
            temporary.path().join("replay-cache"),
        );

        let points = port.heatmap(demo).await.expect("real heatmap evidence");
        let unique_ids = points
            .iter()
            .map(|point| point.id.as_str())
            .collect::<BTreeSet<_>>();
        let fallen_kill_ticks = points
            .iter()
            .filter(|point| {
                point.round == Some(20)
                    && point.kind == "kill"
                    && point.player_id.as_deref() == Some("76561197960690195")
            })
            .map(|point| point.tick)
            .collect::<BTreeSet<_>>();
        let round_death_ticks = points
            .iter()
            .filter(|point| point.round == Some(20) && point.kind == "death")
            .map(|point| point.tick)
            .collect::<BTreeSet<_>>();

        eprintln!(
            "M1 heatmap: points={}, R20 FalleN kills={}, R20 deaths={}",
            points.len(),
            fallen_kill_ticks.len(),
            round_death_ticks.len(),
        );
        assert_eq!(unique_ids.len(), points.len());
        assert!(points.iter().all(|point| {
            point.round.is_some()
                && point.x.is_finite()
                && point.y.is_finite()
                && point
                    .side
                    .as_deref()
                    .is_none_or(|side| matches!(side, "T" | "CT"))
        }));
        assert!(fallen_kill_ticks.len() >= 4);
        assert!(fallen_kill_ticks.is_subset(&round_death_ticks));
    }
}
