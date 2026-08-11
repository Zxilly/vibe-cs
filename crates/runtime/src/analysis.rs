use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;
use vibe_cs_api::{AnalysisPort, ReplayCacheCleanup, ReplayCacheStatus, ReplayPayload};
use vibe_cs_demo::{
    DemoEngine, DemoError, ParseCancellation, create_terminal_tail_compatibility_copy,
    heatmap_from_events, replay_frames_from_events,
};
use vibe_cs_domain::{DemoRecord, DomainError, HeatPoint, MatchAnalysis};

use crate::replay_cache::ReplayCache;

const ANALYSIS_TIMEOUT: Duration = Duration::from_secs(240);
const MAXIMUM_WORKER_RESPONSE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug)]
struct CompatibilityCleanup(PathBuf);

impl Drop for CompatibilityCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[derive(Debug, Clone)]
pub struct RuntimeAnalysisPort {
    storage: vibe_cs_storage::Storage,
    engine: DemoEngine,
    worker: Option<PathBuf>,
    task_dir: PathBuf,
    replay_cache: ReplayCache,
    timeout: Duration,
}

impl RuntimeAnalysisPort {
    #[must_use]
    pub fn new(
        storage: vibe_cs_storage::Storage,
        task_dir: PathBuf,
        replay_cache_dir: PathBuf,
    ) -> Self {
        Self {
            storage,
            engine: DemoEngine::default(),
            worker: discover_worker(),
            task_dir,
            replay_cache: ReplayCache::new(replay_cache_dir),
            timeout: ANALYSIS_TIMEOUT,
        }
    }

    #[cfg(test)]
    fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    async fn analyze_inner(&self, demo: &DemoRecord) -> Result<MatchAnalysis, DomainError> {
        let initial = self.analyze_direct(demo).await;
        if initial.is_ok() {
            return initial;
        }
        tokio::fs::create_dir_all(&self.task_dir)
            .await
            .map_err(|error| DomainError::Internal(error.to_string()))?;
        let compatibility_path = self
            .task_dir
            .join(format!(".compat-{}.dem", Uuid::new_v4()));
        let source_path = PathBuf::from(&demo.path);
        let destination = compatibility_path.clone();
        let compatibility = tokio::task::spawn_blocking(move || {
            create_terminal_tail_compatibility_copy(source_path, destination)
        })
        .await
        .map_err(|error| {
            DomainError::Internal(format!("compatibility inspection failed: {error}"))
        })?;
        let Ok(Some(copy)) = compatibility else {
            return initial;
        };
        tracing::warn!(
            source_bytes = copy.source_bytes,
            copied_bytes = copy.copied_bytes,
            "analyzing a bounded compatibility copy after terminal-tail recovery"
        );
        let cleanup = CompatibilityCleanup(copy.path.clone());
        let mut compatible_demo = demo.clone();
        compatible_demo.path = copy.path.to_string_lossy().into_owned();
        let result = self.analyze_direct(&compatible_demo).await;
        drop(cleanup);
        result
    }

    async fn analyze_direct(&self, demo: &DemoRecord) -> Result<MatchAnalysis, DomainError> {
        if let Some(worker) = &self.worker {
            return self.analyze_with_worker(worker, demo).await;
        }
        tracing::warn!(
            "demo worker was not found; using the in-process parser with panic isolation"
        );
        let cancellation = ParseCancellation::default();
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
        worker: &Path,
        demo: &DemoRecord,
    ) -> Result<MatchAnalysis, DomainError> {
        tokio::fs::create_dir_all(&self.task_dir)
            .await
            .map_err(|error| DomainError::Internal(error.to_string()))?;
        let task_id = Uuid::new_v4();
        let request_path = self.task_dir.join(format!("{task_id}.request.json"));
        let response_path = self.task_dir.join(format!("{task_id}.response.json"));
        let request = WorkerRequest {
            version: 1,
            operation: "analyze",
            demo_path: Some(demo.path.clone()),
            demo_id: Some(demo.id),
            analysis: None,
        };
        let request_bytes = serde_json::to_vec(&request)
            .map_err(|error| DomainError::Internal(error.to_string()))?;
        write_new(&request_path, &request_bytes).await?;

        let execution = tokio::process::Command::new(worker)
            .arg("--input")
            .arg(&request_path)
            .arg("--output")
            .arg(&response_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .status();
        let result = match tokio::time::timeout(self.timeout, execution).await {
            Ok(Ok(status)) => {
                if !status.success() && !response_path.is_file() {
                    Err(DomainError::Internal(format!(
                        "demo worker exited unsuccessfully with {status}"
                    )))
                } else {
                    read_worker_analysis(&response_path).await
                }
            }
            Ok(Err(error)) => Err(DomainError::Internal(format!(
                "unable to start demo worker: {error}"
            ))),
            Err(_) => Err(DomainError::Conflict(format!(
                "demo worker exceeded {} seconds and was terminated",
                self.timeout.as_secs()
            ))),
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

#[async_trait]
impl AnalysisPort for RuntimeAnalysisPort {
    async fn analyze(&self, demo: DemoRecord) -> Result<MatchAnalysis, DomainError> {
        let analysis = self.analyze_inner(&demo).await?;
        self.storage
            .put_analysis(analysis.clone())
            .await
            .map_err(|error| DomainError::Internal(error.to_string()))?;
        Ok(analysis)
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
                replay_frames_from_events(&events).map_err(map_demo_error)
            })
            .await
    }

    async fn heatmap(&self, demo: DemoRecord) -> Result<Vec<HeatPoint>, DomainError> {
        let events = self
            .stored_analysis(demo.id)
            .await?
            .rounds
            .into_iter()
            .flat_map(|round| round.events)
            .collect::<Vec<_>>();
        heatmap_from_events(&events).map_err(map_demo_error)
    }

    async fn replay_cache_status(&self) -> Result<ReplayCacheStatus, DomainError> {
        self.replay_cache.status().await
    }

    async fn clear_replay_cache(&self) -> Result<ReplayCacheCleanup, DomainError> {
        self.replay_cache.clear().await
    }
}

#[derive(Debug, Serialize)]
struct WorkerRequest<'a> {
    version: u32,
    operation: &'a str,
    demo_path: Option<String>,
    demo_id: Option<Uuid>,
    analysis: Option<MatchAnalysis>,
}

#[derive(Debug, Deserialize)]
struct WorkerResponse {
    version: u32,
    ok: bool,
    result: Option<Value>,
    error: Option<WorkerFailure>,
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
    if response.version != 1 {
        return Err(DomainError::Internal(
            "demo worker protocol version does not match".to_owned(),
        ));
    }
    if !response.ok {
        let failure = response.error.unwrap_or(WorkerFailure {
            code: "internal_error".to_owned(),
            message: "demo worker failed without an error payload".to_owned(),
        });
        return Err(map_worker_failure(failure));
    }
    serde_json::from_value(
        response
            .result
            .ok_or_else(|| DomainError::Internal("worker result is empty".to_owned()))?,
    )
    .map_err(|error| DomainError::Internal(format!("invalid analysis result: {error}")))
}

fn map_worker_failure(failure: WorkerFailure) -> DomainError {
    match failure.code.as_str() {
        "not_found" => DomainError::NotFound(failure.message),
        "invalid_input" | "parse_error" => DomainError::InvalidInput(failure.message),
        "cancelled" | "timeout" => DomainError::Conflict(failure.message),
        "dependency_unavailable" => DomainError::DependencyUnavailable(failure.message),
        _ => DomainError::Internal(failure.message),
    }
}

fn discover_worker() -> Option<PathBuf> {
    if let Some(configured) = std::env::var_os("VIBE_CS_DEMO_WORKER") {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Some(path);
        }
        tracing::warn!(path = %path.display(), "configured demo worker was not found");
    }
    let adjacent = std::env::current_exe().ok().map(|executable| {
        executable.with_file_name(if cfg!(windows) {
            "vibe-cs-demo-worker.exe"
        } else {
            "vibe-cs-demo-worker"
        })
    });
    let worker = adjacent.filter(|path| path.is_file());
    if worker.is_none() {
        tracing::warn!("adjacent demo worker was not found; in-process fallback will be used");
    }
    worker
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
    use super::*;

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
}
