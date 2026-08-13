use std::{
    collections::HashMap,
    fs::File,
    io::Read as _,
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex, OnceLock, Weak},
    time::SystemTime,
};

use async_trait::async_trait;
use chrono::Utc;
use serde_json::json;
use sha2::{Digest as _, Sha256};
use tokio::sync::Mutex;
use uuid::Uuid;
use vibe_cs_application::RecordingPort;
use vibe_cs_domain::{
    AppConfig, DemoRecord, DomainError, Highlight, HighlightKind, JobStatus, MatchAnalysis,
    RecordedClip, RecordingJob, RecordingRequest,
};
use vibe_cs_recording::SegmentPlan;
use vibe_cs_storage::Storage;

use crate::recording_progress::{
    RecordingProgressSink, RecordingStage, recording_progress_channel,
};

pub type RecordingCancellation = vibe_cs_media::ProcessCancellation;

#[derive(Debug, Clone, PartialEq)]
pub enum OrphanedRecordingRecovery {
    NoPublishedClip,
    PublishedClip {
        item_index: usize,
        clip: Box<RecordedClip>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct PreparedRecording {
    pub job_id: Uuid,
    pub item_index: usize,
    pub request: RecordingRequest,
    pub demo: DemoRecord,
    pub segment: SegmentPlan,
}

struct PreparedRecordingJob {
    items: Vec<PreparedRecording>,
    _demo_guards: Vec<Arc<VerifiedRecordingDemo>>,
}

#[derive(Debug, Clone)]
struct ActiveRecording {
    cancellation: RecordingCancellation,
    persistence: Arc<Mutex<()>>,
}

type ActiveRecordings = Arc<Mutex<HashMap<Uuid, ActiveRecording>>>;

struct RecordingRun {
    storage: Storage,
    backend: Arc<dyn RecordingBackend>,
    active: ActiveRecordings,
    config: AppConfig,
    job: RecordingJob,
    prepared: PreparedRecordingJob,
    cancellation: RecordingCancellation,
    persistence: Arc<Mutex<()>>,
}

struct RecordingStartupGuard {
    active: ActiveRecordings,
    backend: Arc<dyn RecordingBackend>,
    job_id: Uuid,
    armed: bool,
}

impl RecordingStartupGuard {
    fn new(active: ActiveRecordings, backend: Arc<dyn RecordingBackend>, job_id: Uuid) -> Self {
        Self {
            active,
            backend,
            job_id,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for RecordingStartupGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let active = Arc::clone(&self.active);
        let backend = Arc::clone(&self.backend);
        let job_id = self.job_id;
        tokio::spawn(async move {
            if let Err(error) = backend.finish_job(job_id).await {
                tracing::error!(%job_id, %error, "unable to clean an aborted recording startup context");
            }
            active.lock().await.remove(&job_id);
        });
    }
}

struct StagePersistence {
    storage: Storage,
    persistence: Arc<Mutex<()>>,
    cancellation: RecordingCancellation,
    job: RecordingJob,
    progress_index: u32,
    total: u32,
    receiver: tokio::sync::mpsc::Receiver<RecordingStage>,
    finished: tokio::sync::oneshot::Receiver<()>,
}

#[async_trait]
pub trait RecordingBackend: Send + Sync + std::fmt::Debug {
    async fn preflight(
        &self,
        config: &AppConfig,
        items: &[PreparedRecording],
    ) -> Result<(), DomainError>;

    async fn record(
        &self,
        config: &AppConfig,
        item: &PreparedRecording,
        cancellation: &RecordingCancellation,
        progress: &RecordingProgressSink,
    ) -> Result<RecordedClip, DomainError>;

    /// Removes only artifacts durably leased to one persisted non-terminal job.
    ///
    /// # Errors
    ///
    /// Returns an error when a present lease cannot be authenticated or its
    /// exact artifacts cannot be removed safely. The default backend owns no
    /// recoverable artifacts.
    async fn recover_orphaned_job(
        &self,
        _job: &RecordingJob,
    ) -> Result<OrphanedRecordingRecovery, DomainError> {
        Ok(OrphanedRecordingRecovery::NoPublishedClip)
    }

    /// Retires backend-owned publication evidence only after the clip and its
    /// owning job output are durable in storage.
    async fn commit_recorded_clip(
        &self,
        _job_id: Uuid,
        _item_index: usize,
        _clip: &RecordedClip,
    ) -> Result<(), DomainError> {
        Ok(())
    }

    async fn begin_job(
        &self,
        config: &AppConfig,
        items: &[PreparedRecording],
    ) -> Result<(), DomainError> {
        self.preflight(config, items).await
    }

    async fn finish_job(&self, _job_id: Uuid) -> Result<(), DomainError> {
        Ok(())
    }
}

#[derive(Clone)]
pub struct RuntimeRecordingPort {
    storage: Storage,
    backend: Arc<dyn RecordingBackend>,
    active: ActiveRecordings,
}

impl std::fmt::Debug for RuntimeRecordingPort {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeRecordingPort")
            .field("storage", &self.storage)
            .field("backend", &self.backend)
            .finish_non_exhaustive()
    }
}

impl RuntimeRecordingPort {
    #[must_use]
    pub fn new(storage: Storage, backend: Arc<dyn RecordingBackend>) -> Self {
        Self {
            storage,
            backend,
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Reconciles active records that cannot survive a process restart.
    pub async fn recover_orphaned_jobs(&self) {
        let jobs = match self.storage.list_recording_jobs().await {
            Ok(jobs) => jobs,
            Err(error) => {
                tracing::error!(%error, "unable to inspect orphaned recording jobs");
                return;
            }
        };
        for mut job in jobs {
            let orphaned_status = job.status;
            if matches!(orphaned_status, JobStatus::Completed | JobStatus::Cancelled) {
                continue;
            }
            let recovery = self.backend.recover_orphaned_job(&job).await;
            let (status, message) = match recovery {
                Err(error) => (
                    JobStatus::Failed,
                    truncate_message(&format!(
                        "Recording artifact recovery failed after service restart: {error}"
                    )),
                ),
                Ok(OrphanedRecordingRecovery::NoPublishedClip)
                    if orphaned_status == JobStatus::Failed =>
                {
                    continue;
                }
                Ok(OrphanedRecordingRecovery::NoPublishedClip)
                    if job.outputs.len() == job.items.len() && !job.items.is_empty() =>
                {
                    job.current_index = job.items.len();
                    job.progress = 1.0;
                    (
                        JobStatus::Completed,
                        "Completed durable recording publication recovery after service restart"
                            .to_owned(),
                    )
                }
                Ok(OrphanedRecordingRecovery::NoPublishedClip) => match orphaned_status {
                    JobStatus::Queued | JobStatus::Preparing | JobStatus::Running => (
                        JobStatus::Failed,
                        "Recording was interrupted by service restart".to_owned(),
                    ),
                    JobStatus::Cancelling => (
                        JobStatus::Cancelled,
                        "Recording cancellation completed after service restart".to_owned(),
                    ),
                    JobStatus::Completed | JobStatus::Failed | JobStatus::Cancelled => {
                        unreachable!("completed, failed, and cancelled jobs were handled above")
                    }
                },
                Ok(OrphanedRecordingRecovery::PublishedClip { item_index, clip }) => {
                    match self
                        .restore_published_clip(&mut job, item_index, *clip)
                        .await
                    {
                        Ok(()) if orphaned_status == JobStatus::Cancelling => (
                            JobStatus::Cancelled,
                            "Recovered a verified clip while completing cancellation after service restart"
                                .to_owned(),
                        ),
                        Ok(()) if orphaned_status == JobStatus::Failed => (
                            JobStatus::Failed,
                            "Recovered a verified published clip from the failed recording"
                                .to_owned(),
                        ),
                        Ok(()) if job.outputs.len() == job.items.len() => (
                            JobStatus::Completed,
                            "Recovered the verified published clip after service restart".to_owned(),
                        ),
                        Ok(()) => (
                            JobStatus::Failed,
                            "Recovered a verified published clip; remaining recordings were interrupted by service restart"
                                .to_owned(),
                        ),
                        Err(error) => (
                            JobStatus::Failed,
                            truncate_message(&format!(
                                "Published clip recovery failed after service restart: {error}"
                            )),
                        ),
                    }
                }
            };
            job.status = status;
            job.message = message;
            job.updated_at = Utc::now();
            if let Err(error) = self.storage.put_recording_job(job.clone()).await {
                tracing::error!(job_id = %job.id, %error, "unable to persist orphaned recording terminal state");
            }
        }
    }

    async fn restore_published_clip(
        &self,
        job: &mut RecordingJob,
        item_index: usize,
        clip: RecordedClip,
    ) -> Result<(), DomainError> {
        if job.current_index != item_index {
            return Err(DomainError::Conflict(
                "published clip lease does not match the persisted recording cursor".to_owned(),
            ));
        }
        let request = job.items.get(item_index).ok_or_else(|| {
            DomainError::Conflict(
                "published clip lease references an unavailable recording item".to_owned(),
            )
        })?;
        validate_recovered_clip(&clip, request).await?;
        if job.outputs.len() < item_index || job.outputs.len() > item_index.saturating_add(1) {
            return Err(DomainError::Conflict(
                "published clip cannot be inserted into a non-contiguous recording output list"
                    .to_owned(),
            ));
        }
        if job.outputs[..item_index]
            .iter()
            .any(|existing| existing.id == clip.id || existing.path == clip.path)
        {
            return Err(DomainError::Conflict(
                "published clip duplicates an earlier recording output".to_owned(),
            ));
        }
        if let Some(existing) = job.outputs.get(item_index)
            && existing != &clip
        {
            return Err(DomainError::Conflict(
                "persisted recording output conflicts with the exact published clip lease"
                    .to_owned(),
            ));
        }
        match self
            .storage
            .get_recorded_clip(clip.id)
            .await
            .map_err(|error| storage_error(&error))?
        {
            Some(existing) if existing != clip => {
                return Err(DomainError::Conflict(
                    "recorded clip ID already belongs to different persisted content".to_owned(),
                ));
            }
            Some(_) => {}
            None => {
                self.storage
                    .put_recorded_clip(clip.clone())
                    .await
                    .map_err(|error| storage_error(&error))?;
            }
        }
        if job.outputs.len() == item_index {
            job.outputs.push(clip.clone());
        }
        let completed = u32::try_from(job.outputs.len()).map_err(|_| {
            DomainError::Internal("recovered recording output count overflowed".to_owned())
        })?;
        let total = u32::try_from(job.items.len()).map_err(|_| {
            DomainError::Internal("recording item count overflowed during recovery".to_owned())
        })?;
        job.progress = (f64::from(completed) / f64::from(total)).min(1.0);
        job.updated_at = Utc::now();
        self.storage
            .put_recording_job(job.clone())
            .await
            .map_err(|error| storage_error(&error))?;
        self.backend
            .commit_recorded_clip(job.id, item_index, &clip)
            .await?;
        job.current_index = item_index.saturating_add(1);
        Ok(())
    }

    async fn prepare(&self, job: &RecordingJob) -> Result<PreparedRecordingJob, DomainError> {
        if job.items.is_empty() {
            return Err(DomainError::InvalidInput(
                "recording job must contain at least one item".to_owned(),
            ));
        }
        if matches!(
            job.status,
            JobStatus::Running
                | JobStatus::Cancelling
                | JobStatus::Completed
                | JobStatus::Cancelled
        ) {
            return Err(DomainError::Conflict(format!(
                "recording job cannot start from {:?}",
                job.status
            )));
        }
        let mut prepared = Vec::with_capacity(job.items.len());
        let mut demo_guards = Vec::with_capacity(job.items.len());
        for (item_index, request) in job.items.iter().enumerate() {
            request.validate()?;
            let demo = self
                .storage
                .get_demo(request.demo_id)
                .await
                .map_err(|error| storage_error(&error))?
                .ok_or_else(|| DomainError::NotFound("recording demo".to_owned()))?;
            let analysis = self
                .storage
                .get_analysis(demo.id)
                .await
                .map_err(|error| storage_error(&error))?;
            let tick_rate = authoritative_tick_rate(analysis.as_ref())?;
            let demo_path = std::path::absolute(Path::new(&demo.path)).map_err(|error| {
                DomainError::InvalidInput(format!(
                    "recording demo path could not be made absolute: {error}"
                ))
            })?;
            let demo_guard = acquire_recording_demo_guard(&demo, &demo_path).await?;
            register_recording_demo_guard(&demo_guard);
            let segment = build_segment_plan(
                request,
                &demo,
                analysis.as_ref(),
                demo_path,
                tick_rate,
                Uuid::new_v4(),
            )?;
            prepared.push(PreparedRecording {
                job_id: job.id,
                item_index,
                request: request.clone(),
                demo,
                segment,
            });
            demo_guards.push(demo_guard);
        }
        Ok(PreparedRecordingJob {
            items: prepared,
            _demo_guards: demo_guards,
        })
    }

    async fn run_job(run: RecordingRun) {
        let RecordingRun {
            storage,
            backend,
            active,
            config,
            mut job,
            prepared,
            cancellation,
            persistence,
        } = run;
        let result = Self::record_all(
            &storage,
            backend.as_ref(),
            &config,
            &mut job,
            &prepared.items,
            &cancellation,
            &persistence,
        )
        .await;
        let cleanup = backend.finish_job(job.id).await;
        let result = match (result, cleanup) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(primary), Ok(())) => Err(primary),
            (Ok(()), Err(cleanup)) => Err(cleanup),
            (Err(primary), Err(cleanup)) => Err(DomainError::Internal(format!(
                "{primary}; additionally failed to restore recording job resources: {cleanup}"
            ))),
        };
        {
            let _persistence_guard = persistence.lock().await;
            match result {
                Ok(()) if cancellation.is_cancelled() => {
                    job.status = JobStatus::Cancelled;
                    "Cancelled".clone_into(&mut job.message);
                }
                Ok(()) => {
                    job.status = JobStatus::Completed;
                    job.progress = 1.0;
                    job.current_index = job.items.len();
                    "Completed".clone_into(&mut job.message);
                }
                Err(error)
                    if cancellation.is_cancelled()
                        && !matches!(error, DomainError::CleanupFailed(_)) =>
                {
                    tracing::info!(job_id = %job.id, %error, "recording job cancelled");
                    job.status = JobStatus::Cancelled;
                    "Cancelled".clone_into(&mut job.message);
                }
                Err(error) => {
                    tracing::error!(job_id = %job.id, %error, "recording job failed");
                    job.status = JobStatus::Failed;
                    job.message = truncate_message(&error.to_string());
                }
            }
            job.updated_at = Utc::now();
            if let Err(error) = storage.put_recording_job(job.clone()).await {
                tracing::error!(job_id = %job.id, %error, "unable to persist terminal recording state");
            }
        }
        active.lock().await.remove(&job.id);
    }

    async fn record_all(
        storage: &Storage,
        backend: &dyn RecordingBackend,
        config: &AppConfig,
        job: &mut RecordingJob,
        prepared: &[PreparedRecording],
        cancellation: &RecordingCancellation,
        persistence: &Arc<Mutex<()>>,
    ) -> Result<(), DomainError> {
        let total = u32::try_from(prepared.len()).map_err(|_| {
            DomainError::InvalidInput("recording queue contains too many items".to_owned())
        })?;
        for (index, item) in prepared.iter().enumerate() {
            if cancellation.is_cancelled() {
                return Ok(());
            }
            let progress_index = u32::try_from(index).map_err(|_| {
                DomainError::Internal("recording progress index overflowed".to_owned())
            })?;
            job.current_index = index;
            job.progress = f64::from(progress_index) / f64::from(total);
            job.message = format!("Recording {} of {total}", progress_index + 1);
            job.updated_at = Utc::now();
            storage
                .put_recording_job(job.clone())
                .await
                .map_err(|error| storage_error(&error))?;

            let (progress, receiver) = recording_progress_channel();
            let (progress_finished, finished) = tokio::sync::oneshot::channel();
            let progress_task = tokio::spawn(persist_recording_stages(StagePersistence {
                storage: storage.clone(),
                persistence: Arc::clone(persistence),
                cancellation: cancellation.clone(),
                job: job.clone(),
                progress_index,
                total,
                receiver,
                finished,
            }));
            let recording = backend.record(config, item, cancellation, &progress).await;
            let _ = progress_finished.send(());
            drop(progress);
            let persisted = progress_task.await.map_err(|error| {
                DomainError::Internal(format!(
                    "recording progress persistence task failed: {error}"
                ))
            })?;
            let persisted = match (recording, persisted) {
                (Ok(clip), Ok(persisted)) => {
                    job.progress = persisted.progress;
                    job.message = persisted.message;
                    job.updated_at = persisted.updated_at;
                    clip
                }
                (Ok(clip), Err(error)) => {
                    return Err(cleanup_unpublished_clip(&clip, error).await);
                }
                (Err(error), Ok(persisted)) => {
                    job.progress = persisted.progress;
                    job.message = persisted.message;
                    job.updated_at = persisted.updated_at;
                    return Err(error);
                }
                (Err(primary), Err(progress)) => {
                    return Err(DomainError::Internal(format!(
                        "{primary}; additionally failed to persist recording progress: {progress}"
                    )));
                }
            };
            if let Err(error) = validate_clip(&persisted, item).await {
                return Err(cleanup_unpublished_clip(&persisted, error).await);
            }
            if let Err(error) = storage.put_recorded_clip(persisted.clone()).await {
                return Err(cleanup_unpublished_clip(&persisted, storage_error(&error)).await);
            }
            job.outputs.push(persisted.clone());
            job.progress = f64::from(progress_index + 1) / f64::from(total);
            job.updated_at = Utc::now();
            storage
                .put_recording_job(job.clone())
                .await
                .map_err(|error| storage_error(&error))?;
            backend
                .commit_recorded_clip(job.id, index, &persisted)
                .await?;
        }
        Ok(())
    }
}

async fn persist_recording_stages(context: StagePersistence) -> Result<RecordingJob, DomainError> {
    let StagePersistence {
        storage,
        persistence,
        cancellation,
        mut job,
        progress_index,
        total,
        mut receiver,
        mut finished,
    } = context;
    loop {
        tokio::select! {
            biased;
            stage = receiver.recv() => {
                let Some(stage) = stage else { break };
                if !persist_recording_stage(
                    &storage,
                    &persistence,
                    &cancellation,
                    &mut job,
                    progress_index,
                    total,
                    stage,
                ).await? {
                    break;
                }
            }
            _ = &mut finished => {
                while let Ok(stage) = receiver.try_recv() {
                    if !persist_recording_stage(
                        &storage,
                        &persistence,
                        &cancellation,
                        &mut job,
                        progress_index,
                        total,
                        stage,
                    ).await? {
                        break;
                    }
                }
                break;
            }
        }
    }
    Ok(job)
}

#[allow(clippy::too_many_arguments)]
async fn persist_recording_stage(
    storage: &Storage,
    persistence: &Arc<Mutex<()>>,
    cancellation: &RecordingCancellation,
    job: &mut RecordingJob,
    progress_index: u32,
    total: u32,
    stage: RecordingStage,
) -> Result<bool, DomainError> {
    let _persistence_guard = persistence.lock().await;
    if cancellation.is_cancelled() {
        return Ok(false);
    }
    let item_fraction = f64::from(stage.milestone()) / f64::from(RecordingStage::COUNT);
    let progress = ((f64::from(progress_index) + item_fraction) / f64::from(total)).min(0.99);
    job.progress = job.progress.max(progress.clamp(0.0, 1.0));
    stage.code().clone_into(&mut job.message);
    job.updated_at = Utc::now();
    storage
        .put_recording_job(job.clone())
        .await
        .map_err(|error| storage_error(&error))?;
    Ok(true)
}

const MAXIMUM_RECORDING_DEMO_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Debug)]
struct VerifiedRecordingDemo {
    demo_id: Uuid,
    path: PathBuf,
    expected_sha256: String,
    length: u64,
    modified: Option<SystemTime>,
    file: File,
}

type RecordingDemoGuardCache = HashMap<(Uuid, PathBuf, String), Weak<VerifiedRecordingDemo>>;

fn recording_demo_guard_cache() -> &'static StdMutex<RecordingDemoGuardCache> {
    static CACHE: OnceLock<StdMutex<RecordingDemoGuardCache>> = OnceLock::new();
    CACHE.get_or_init(|| StdMutex::new(HashMap::new()))
}

#[cfg(test)]
fn recording_demo_hash_passes() -> &'static StdMutex<HashMap<PathBuf, usize>> {
    static HASH_PASSES: OnceLock<StdMutex<HashMap<PathBuf, usize>>> = OnceLock::new();
    HASH_PASSES.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn recording_demo_guard_key(
    demo: &DemoRecord,
    path: &Path,
) -> Result<(Uuid, PathBuf, String), DomainError> {
    let expected = demo
        .content_sha256
        .as_deref()
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| {
            DomainError::DependencyUnavailable(
                "this Demo must be reimported before recording can bind its content hash"
                    .to_owned(),
            )
        })?;
    Ok((demo.id, path.to_path_buf(), expected.to_ascii_lowercase()))
}

fn register_recording_demo_guard(guard: &Arc<VerifiedRecordingDemo>) {
    let key = (
        guard.demo_id,
        guard.path.clone(),
        guard.expected_sha256.clone(),
    );
    let mut cache = recording_demo_guard_cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    cache.retain(|_, candidate| candidate.strong_count() > 0);
    cache.insert(key, Arc::downgrade(guard));
}

async fn acquire_recording_demo_guard(
    demo: &DemoRecord,
    path: &Path,
) -> Result<Arc<VerifiedRecordingDemo>, DomainError> {
    let key = recording_demo_guard_key(demo, path)?;
    if let Some(guard) = recording_demo_guard_cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&key)
        .and_then(Weak::upgrade)
    {
        guard.verify_path_identity()?;
        return Ok(guard);
    }
    let demo_id = demo.id;
    let path = path.to_path_buf();
    let expected_sha256 = key.2;
    tokio::task::spawn_blocking(move || {
        VerifiedRecordingDemo::open(demo_id, path, expected_sha256).map(Arc::new)
    })
    .await
    .map_err(|error| DomainError::Internal(format!("recording Demo guard task failed: {error}")))?
}

impl VerifiedRecordingDemo {
    fn open(demo_id: Uuid, path: PathBuf, expected_sha256: String) -> Result<Self, DomainError> {
        reject_link_or_reparse(&path)?;
        let mut file = open_recording_demo_read_only(&path).map_err(|error| {
            DomainError::InvalidInput(format!("unable to open recording Demo: {error}"))
        })?;
        let metadata = file.metadata().map_err(|error| {
            DomainError::InvalidInput(format!("unable to inspect recording Demo: {error}"))
        })?;
        if !metadata.is_file() || metadata.len() > MAXIMUM_RECORDING_DEMO_BYTES {
            return Err(DomainError::InvalidInput(
                "recording Demo must be a bounded regular non-link file".to_owned(),
            ));
        }
        let modified = metadata.modified().ok();
        #[cfg(test)]
        {
            let mut passes = recording_demo_hash_passes()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            *passes.entry(path.clone()).or_default() += 1;
        }
        let mut hash = Sha256::new();
        let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
        let mut total = 0_u64;
        loop {
            let count = file.read(&mut buffer).map_err(|error| {
                DomainError::InvalidInput(format!("unable to read recording Demo: {error}"))
            })?;
            if count == 0 {
                break;
            }
            total = total.checked_add(count as u64).ok_or_else(|| {
                DomainError::InvalidInput("recording Demo size overflowed".to_owned())
            })?;
            if total > metadata.len() || total > MAXIMUM_RECORDING_DEMO_BYTES {
                return Err(DomainError::Conflict(
                    "recording Demo changed while its content was verified".to_owned(),
                ));
            }
            hash.update(&buffer[..count]);
        }
        if total != metadata.len()
            || !hex::encode(hash.finalize()).eq_ignore_ascii_case(&expected_sha256)
        {
            return Err(DomainError::Conflict(
                "recording Demo content no longer matches its analyzed fingerprint".to_owned(),
            ));
        }
        let guard = Self {
            demo_id,
            path,
            expected_sha256,
            length: metadata.len(),
            modified,
            file,
        };
        guard.verify_path_identity()?;
        Ok(guard)
    }

    fn verify_path_identity(&self) -> Result<(), DomainError> {
        reject_link_or_reparse(&self.path)?;
        let open_handle = same_file::Handle::from_file(self.file.try_clone().map_err(|error| {
            DomainError::Conflict(format!("unable to clone verified Demo handle: {error}"))
        })?)
        .map_err(|error| {
            DomainError::Conflict(format!("unable to identify verified Demo handle: {error}"))
        })?;
        let named_handle = same_file::Handle::from_path(&self.path).map_err(|error| {
            DomainError::Conflict(format!(
                "recording Demo path is no longer available: {error}"
            ))
        })?;
        reject_link_or_reparse(&self.path)?;
        let metadata = self.file.metadata().map_err(|error| {
            DomainError::Conflict(format!("unable to re-inspect verified Demo: {error}"))
        })?;
        if open_handle != named_handle
            || metadata.len() != self.length
            || metadata.modified().ok() != self.modified
        {
            return Err(DomainError::Conflict(
                "recording Demo changed after its content was verified".to_owned(),
            ));
        }
        Ok(())
    }
}

fn reject_link_or_reparse(path: &Path) -> Result<(), DomainError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        DomainError::InvalidInput(format!("unable to inspect recording Demo: {error}"))
    })?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAXIMUM_RECORDING_DEMO_BYTES
    {
        return Err(DomainError::InvalidInput(
            "recording Demo must be a bounded regular non-link file".to_owned(),
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(DomainError::InvalidInput(
                "recording Demo must not be a Windows reparse point".to_owned(),
            ));
        }
    }
    Ok(())
}

fn open_recording_demo_read_only(path: &Path) -> std::io::Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        const FILE_SHARE_READ: u32 = 0x0000_0001;
        options.share_mode(FILE_SHARE_READ);
    }
    options.open(path)
}

pub(crate) async fn verify_recording_demo_content(
    demo: &DemoRecord,
    path: &Path,
) -> Result<(), DomainError> {
    let guard = acquire_recording_demo_guard(demo, path).await?;
    register_recording_demo_guard(&guard);
    guard.verify_path_identity()
}

#[async_trait]
impl RecordingPort for RuntimeRecordingPort {
    async fn preflight(&self, items: &[RecordingRequest]) -> Result<(), DomainError> {
        let now = Utc::now();
        let transient_job = RecordingJob {
            id: Uuid::new_v4(),
            status: JobStatus::Queued,
            items: items.to_vec(),
            current_index: 0,
            progress: 0.0,
            message: "Preflight".to_owned(),
            outputs: Vec::new(),
            created_at: now,
            updated_at: now,
        };
        let prepared = self.prepare(&transient_job).await?;
        let config = self
            .storage
            .get_config()
            .await
            .map_err(|error| storage_error(&error))?
            .unwrap_or_default();
        self.backend.preflight(&config, &prepared.items).await
    }

    async fn execute(&self, mut job: RecordingJob) -> Result<RecordingJob, DomainError> {
        if !self.active.lock().await.is_empty() {
            return Err(DomainError::Conflict(
                "another recording job is already active".to_owned(),
            ));
        }
        let mut prepared = self.prepare(&job).await?;
        let config = self
            .storage
            .get_config()
            .await
            .map_err(|error| storage_error(&error))?
            .unwrap_or_default();
        for item in &mut prepared.items {
            let voice_participants = item
                .segment
                .metadata
                .get("voice_participants")
                .cloned()
                .unwrap_or_else(|| json!([]));
            item.segment.metadata["capture"] = json!({
                "backend": "managed_hlae_windows_mf",
                "show_radar": config.recording.show_radar,
                "mute_voice": config.recording.mute_voice,
                "camera_fov": config.recording.camera_fov,
                "viewmodel_fov": config.recording.viewmodel_fov,
                "flash_alpha": config.recording.flash_alpha,
                "show_hud": config.recording.show_hud,
                "isolate_target_voice": config.recording.isolate_target_voice,
                "voice_participants": voice_participants,
            });
        }
        let cancellation = RecordingCancellation::default();
        let persistence = Arc::new(Mutex::new(()));
        {
            let mut active = self.active.lock().await;
            if !active.is_empty() {
                return Err(DomainError::Conflict(
                    "another recording job is already active".to_owned(),
                ));
            }
            active.insert(
                job.id,
                ActiveRecording {
                    cancellation: cancellation.clone(),
                    persistence: Arc::clone(&persistence),
                },
            );
        }
        let mut startup =
            RecordingStartupGuard::new(Arc::clone(&self.active), Arc::clone(&self.backend), job.id);
        if let Err(error) = self.backend.begin_job(&config, &prepared.items).await {
            let cleanup = self.backend.finish_job(job.id).await;
            self.active.lock().await.remove(&job.id);
            startup.disarm();
            return match cleanup {
                Ok(()) => Err(error),
                Err(cleanup) => Err(DomainError::CleanupFailed(format!(
                    "{error}; additionally failed to restore recording job resources: {cleanup}"
                ))),
            };
        }
        if cancellation.is_cancelled() {
            let cleanup = self.backend.finish_job(job.id).await;
            self.active.lock().await.remove(&job.id);
            startup.disarm();
            return match cleanup {
                Ok(()) => Err(DomainError::Conflict(
                    "recording was cancelled while preparing".to_owned(),
                )),
                Err(cleanup) => Err(DomainError::CleanupFailed(format!(
                    "recording was cancelled while preparing; additionally failed to restore recording job resources: {cleanup}"
                ))),
            };
        }
        job.status = JobStatus::Running;
        "Running".clone_into(&mut job.message);
        job.updated_at = Utc::now();
        if let Err(error) = self.storage.put_recording_job(job.clone()).await {
            let cleanup = self.backend.finish_job(job.id).await;
            self.active.lock().await.remove(&job.id);
            startup.disarm();
            let primary = storage_error(&error);
            return match cleanup {
                Ok(()) => Err(primary),
                Err(cleanup) => Err(DomainError::CleanupFailed(format!(
                    "{primary}; additionally failed to restore recording job resources: {cleanup}"
                ))),
            };
        }

        let storage = self.storage.clone();
        let backend = Arc::clone(&self.backend);
        let active = Arc::clone(&self.active);
        let background_job = job.clone();
        tokio::spawn(async move {
            Self::run_job(RecordingRun {
                storage,
                backend,
                active,
                config,
                job: background_job,
                prepared,
                cancellation,
                persistence,
            })
            .await;
        });
        startup.disarm();
        Ok(job)
    }

    async fn cancel(&self, mut job: RecordingJob) -> Result<RecordingJob, DomainError> {
        if job.status.is_terminal() {
            return Err(DomainError::Conflict(
                "recording job is already terminal".to_owned(),
            ));
        }
        let Some(active) = self.active.lock().await.get(&job.id).cloned() else {
            return Err(DomainError::Conflict(
                "recording job is not active in this runtime".to_owned(),
            ));
        };
        active.cancellation.cancel();
        let _persistence_guard = active.persistence.lock().await;
        let Some(current) = self
            .storage
            .get_recording_job(job.id)
            .await
            .map_err(|error| storage_error(&error))?
        else {
            return Err(DomainError::NotFound("recording job".to_owned()));
        };
        if current.status.is_terminal() {
            return Ok(current);
        }
        job = current;
        job.status = JobStatus::Cancelling;
        "Cancelling".clone_into(&mut job.message);
        job.updated_at = Utc::now();
        self.storage
            .put_recording_job(job.clone())
            .await
            .map_err(|error| storage_error(&error))?;
        Ok(job)
    }
}

fn authoritative_tick_rate(analysis: Option<&MatchAnalysis>) -> Result<f64, DomainError> {
    analysis
        .map(|analysis| analysis.tick_rate)
        .filter(|tick_rate| tick_rate.is_finite() && (1.0..=256.0).contains(tick_rate))
        .ok_or_else(|| {
            DomainError::DependencyUnavailable(
                "this Demo must be reanalyzed before its authoritative tick rate can be used for recording"
                    .to_owned(),
            )
        })
}

fn build_segment_plan(
    request: &RecordingRequest,
    demo: &DemoRecord,
    analysis: Option<&MatchAnalysis>,
    demo_path: PathBuf,
    tick_rate: f64,
    output_id: Uuid,
) -> Result<SegmentPlan, DomainError> {
    request.validate()?;
    if !tick_rate.is_finite() || !(1.0..=256.0).contains(&tick_rate) {
        return Err(DomainError::InvalidInput(
            "recording tick rate must be between 1 and 256".to_owned(),
        ));
    }
    let title = request.title.trim();
    if title.is_empty() || title.len() > 256 || title.chars().any(char::is_control) {
        return Err(DomainError::InvalidInput(
            "recording title must be a bounded printable value".to_owned(),
        ));
    }
    let pre_roll_ticks = seconds_to_ticks(request.pre_roll_seconds, tick_rate)?;
    let post_roll_ticks = seconds_to_ticks(request.post_roll_seconds, tick_rate)?;
    let start_tick = request.start_tick.saturating_sub(pre_roll_ticks);
    let end_tick = request
        .end_tick
        .checked_add(post_roll_ticks)
        .ok_or_else(|| {
            DomainError::InvalidInput("recording post-roll exceeds the tick range".to_owned())
        })?;
    if end_tick <= start_tick || end_tick - start_tick > u64::from(u32::MAX) {
        return Err(DomainError::InvalidInput(
            "recording segment tick span exceeds the supported range".to_owned(),
        ));
    }
    let highlight = request.highlight_id.as_deref().and_then(|highlight_id| {
        analysis.and_then(|analysis| {
            analysis
                .highlights
                .iter()
                .find(|highlight| highlight.id == highlight_id)
        })
    });
    let camera_player_id = resolve_camera_player(request, analysis, highlight)?;
    let player_name = analysis
        .and_then(|analysis| {
            analysis
                .players
                .iter()
                .find(|player| player.steam_id == camera_player_id)
        })
        .map_or_else(|| camera_player_id.clone(), |player| player.name.clone());
    let spectator_slot =
        analysis.and_then(|analysis| resolved_spectator_slot(analysis, &camera_player_id));
    let verified_total_ticks = analysis
        .and_then(|analysis| analysis.verified_total_ticks)
        .filter(|ticks| *ticks > 0);
    let category = highlight.map_or("custom", |highlight| highlight_category(highlight.kind));
    let mut tags = highlight.map_or_else(Vec::new, |highlight| highlight.tags.clone());
    if request.victim_pov && !tags.iter().any(|tag| tag == "victim_pov") {
        tags.push("victim_pov".to_owned());
    }
    let output_file_name = format!("{}-{}.mp4", safe_output_stem(title), output_id.simple());
    Ok(SegmentPlan {
        demo_id: demo.id,
        demo_path,
        title: title.to_owned(),
        player_id: camera_player_id.clone(),
        player_name: Some(player_name.clone()),
        spectator_slot,
        verified_total_ticks,
        start_tick,
        end_tick,
        tick_rate,
        output_file_name,
        category: category.to_owned(),
        tags,
        metadata: json!({
            "request_id": request.id,
            "highlight_id": request.highlight_id,
            "requested_start_tick": request.start_tick,
            "requested_end_tick": request.end_tick,
            "effective_start_tick": start_tick,
            "effective_end_tick": end_tick,
            "pre_roll_seconds": request.pre_roll_seconds,
            "post_roll_seconds": request.post_roll_seconds,
            "pre_roll_ticks": pre_roll_ticks,
            "post_roll_ticks": post_roll_ticks,
            "tick_rate_source": "persisted_analysis",
            "victim_pov_requested": request.victim_pov,
            "perspective": if request.victim_pov { "victim" } else { "player" },
            "camera_player_id": camera_player_id,
            "camera_player_name": player_name,
            "hud": {
                "title": title,
                "map_name": demo.map_name,
                "category": category,
            },
            "voice_participants": analysis.map_or_else(Vec::new, |analysis| {
                analysis.players.iter().map(|player| player.steam_id.clone()).collect::<Vec<_>>()
            }),
        }),
    })
}

fn resolved_spectator_slot(analysis: &MatchAnalysis, player_id: &str) -> Option<u8> {
    let mut matches = analysis
        .players
        .iter()
        .filter(|player| player.steam_id == player_id);
    let player = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    let slot = player
        .spectator_slot
        .filter(|slot| (1..=64).contains(slot))?;
    (analysis
        .players
        .iter()
        .filter(|player| player.spectator_slot == Some(slot))
        .count()
        == 1)
        .then_some(slot)
}

fn resolve_camera_player(
    request: &RecordingRequest,
    analysis: Option<&MatchAnalysis>,
    highlight: Option<&Highlight>,
) -> Result<String, DomainError> {
    if !request.victim_pov {
        return Ok(request.player_id.clone());
    }
    let analysis = analysis.ok_or_else(|| {
        DomainError::DependencyUnavailable(
            "victim POV requires a persisted demo analysis".to_owned(),
        )
    })?;
    let highlight = highlight.ok_or_else(|| {
        DomainError::InvalidInput(
            "victim POV requires a highlight_id that exists in the analysis".to_owned(),
        )
    })?;
    highlight
        .victims
        .iter()
        .find(|victim| {
            analysis
                .players
                .iter()
                .any(|player| player.steam_id == victim.as_str())
        })
        .cloned()
        .ok_or_else(|| {
            DomainError::InvalidInput(
                "the selected highlight has no stable victim identity".to_owned(),
            )
        })
}

const fn highlight_category(kind: HighlightKind) -> &'static str {
    match kind {
        HighlightKind::MultiKill => "multi-kill",
        HighlightKind::Clutch => "clutch",
        HighlightKind::Fail => "failure",
        HighlightKind::Defuse | HighlightKind::Timeline => "utility",
        HighlightKind::OneTap
        | HighlightKind::Wallbang
        | HighlightKind::NoScope
        | HighlightKind::Knife
        | HighlightKind::Taser => "entry",
    }
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss
)]
fn seconds_to_ticks(seconds: f64, tick_rate: f64) -> Result<u64, DomainError> {
    let ticks = seconds * tick_rate;
    if !ticks.is_finite() || ticks < 0.0 || ticks > u64::MAX as f64 {
        return Err(DomainError::InvalidInput(
            "recording pre/post-roll is outside the supported tick range".to_owned(),
        ));
    }
    Ok(ticks.ceil() as u64)
}

fn safe_output_stem(title: &str) -> String {
    let mut stem = String::with_capacity(title.len().min(64));
    let mut separator_pending = false;
    for character in title.chars() {
        if stem.len() >= 64 {
            break;
        }
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
            if separator_pending && !stem.is_empty() && !stem.ends_with('-') {
                stem.push('-');
            }
            separator_pending = false;
            stem.push(character.to_ascii_lowercase());
        } else {
            separator_pending = true;
        }
    }
    while stem.ends_with(['-', '_']) {
        stem.pop();
    }
    if stem.is_empty() {
        "recording".to_owned()
    } else {
        stem
    }
}

async fn validate_clip(clip: &RecordedClip, item: &PreparedRecording) -> Result<(), DomainError> {
    if clip.demo_id != Some(item.demo.id) {
        return Err(DomainError::InvalidInput(
            "recording backend returned a clip for another demo".to_owned(),
        ));
    }
    if !clip.duration_seconds.is_finite() || clip.duration_seconds <= 0.0 {
        return Err(DomainError::InvalidInput(
            "recording backend returned an invalid clip duration".to_owned(),
        ));
    }
    crate::hlae_recording::validate_managed_hlae_clip_path(clip)?;
    let metadata = tokio::fs::metadata(&clip.path)
        .await
        .map_err(|error| DomainError::Internal(format!("recorded clip is unavailable: {error}")))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(DomainError::Internal(
            "recording backend did not produce a non-empty clip file".to_owned(),
        ));
    }
    Ok(())
}

async fn validate_recovered_clip(
    clip: &RecordedClip,
    request: &RecordingRequest,
) -> Result<(), DomainError> {
    if clip.demo_id != Some(request.demo_id) {
        return Err(DomainError::InvalidInput(
            "recovered recording clip belongs to another demo".to_owned(),
        ));
    }
    if !clip.duration_seconds.is_finite() || clip.duration_seconds <= 0.0 {
        return Err(DomainError::InvalidInput(
            "recovered recording clip has an invalid duration".to_owned(),
        ));
    }
    crate::hlae_recording::validate_managed_hlae_clip_path(clip)?;
    let metadata = tokio::fs::metadata(&clip.path).await.map_err(|error| {
        DomainError::Internal(format!("recovered clip is unavailable: {error}"))
    })?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(DomainError::Internal(
            "recovered clip is not a non-empty regular file".to_owned(),
        ));
    }
    Ok(())
}

async fn cleanup_unpublished_clip(clip: &RecordedClip, primary: DomainError) -> DomainError {
    if let Some(result) = crate::hlae_recording::remove_managed_hlae_unpublished_clip(clip).await {
        return match result {
            Ok(()) => primary,
            Err(cleanup) => DomainError::CleanupFailed(format!(
                "{primary}; managed recording cleanup also failed: {cleanup}"
            )),
        };
    }
    match tokio::fs::remove_file(&clip.path).await {
        Ok(()) => tracing::info!(clip_id = %clip.id, "removed cancelled unpublished clip"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return primary,
        Err(error) => {
            return DomainError::CleanupFailed(format!(
                "{primary}; unpublished clip cleanup also failed: {error}"
            ));
        }
    }
    primary
}

fn truncate_message(message: &str) -> String {
    message.chars().take(1_000).collect()
}

fn storage_error(error: &vibe_cs_storage::StorageError) -> DomainError {
    DomainError::Internal(format!("storage operation failed: {error}"))
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        sync::{
            Mutex as TestMutex,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use super::*;

    #[derive(Debug)]
    struct FakeBackend {
        output_dir: PathBuf,
        wait_for_cancel: bool,
    }

    #[async_trait]
    impl RecordingBackend for FakeBackend {
        async fn preflight(
            &self,
            _config: &AppConfig,
            _items: &[PreparedRecording],
        ) -> Result<(), DomainError> {
            Ok(())
        }

        async fn record(
            &self,
            _config: &AppConfig,
            item: &PreparedRecording,
            cancellation: &RecordingCancellation,
            _progress: &RecordingProgressSink,
        ) -> Result<RecordedClip, DomainError> {
            if self.wait_for_cancel {
                cancellation.cancelled().await;
                return Err(DomainError::Conflict("cancelled".to_owned()));
            }
            let path = self.output_dir.join(format!("{}.mp4", Uuid::new_v4()));
            tokio::fs::write(&path, b"fake-video")
                .await
                .map_err(|error| DomainError::Internal(error.to_string()))?;
            Ok(RecordedClip {
                id: Uuid::new_v4(),
                path: path.to_string_lossy().into_owned(),
                title: item.request.title.clone(),
                duration_seconds: 1.0,
                demo_id: Some(item.demo.id),
                player_name: Some(item.request.player_id.clone()),
                category: "highlight".to_owned(),
                tags: Vec::new(),
                metadata: serde_json::Value::Null,
                created_at: Utc::now(),
            })
        }
    }

    #[derive(Debug)]
    struct CommitOrderBackend {
        output_dir: PathBuf,
        storage: Storage,
        commits: AtomicUsize,
        cancel_after_publish: bool,
    }

    #[async_trait]
    impl RecordingBackend for CommitOrderBackend {
        async fn preflight(
            &self,
            _config: &AppConfig,
            _items: &[PreparedRecording],
        ) -> Result<(), DomainError> {
            Ok(())
        }

        async fn record(
            &self,
            _config: &AppConfig,
            item: &PreparedRecording,
            cancellation: &RecordingCancellation,
            _progress: &RecordingProgressSink,
        ) -> Result<RecordedClip, DomainError> {
            let path = self.output_dir.join(format!("{}.mp4", Uuid::new_v4()));
            tokio::fs::write(&path, b"durable-video")
                .await
                .map_err(|error| DomainError::Internal(error.to_string()))?;
            let clip = RecordedClip {
                id: Uuid::new_v4(),
                path: path.to_string_lossy().into_owned(),
                title: item.request.title.clone(),
                duration_seconds: 1.0,
                demo_id: Some(item.demo.id),
                player_name: Some(item.request.player_id.clone()),
                category: "highlight".to_owned(),
                tags: Vec::new(),
                metadata: serde_json::Value::Null,
                created_at: Utc::now(),
            };
            if self.cancel_after_publish {
                cancellation.cancel();
            }
            Ok(clip)
        }

        async fn commit_recorded_clip(
            &self,
            job_id: Uuid,
            _item_index: usize,
            clip: &RecordedClip,
        ) -> Result<(), DomainError> {
            let stored_clip = self
                .storage
                .get_recorded_clip(clip.id)
                .await
                .map_err(|error| storage_error(&error))?;
            if stored_clip.as_ref() != Some(clip) {
                return Err(DomainError::Internal(
                    "backend commit ran before RecordedClip persistence".to_owned(),
                ));
            }
            let stored_job = self
                .storage
                .get_recording_job(job_id)
                .await
                .map_err(|error| storage_error(&error))?
                .ok_or_else(|| DomainError::Internal("recording job disappeared".to_owned()))?;
            if !stored_job.outputs.iter().any(|output| output == clip) {
                return Err(DomainError::Internal(
                    "backend commit ran before recording job output persistence".to_owned(),
                ));
            }
            self.commits.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[derive(Debug, Default)]
    struct ObservingPreflightBackend {
        preflights: AtomicUsize,
        records: AtomicUsize,
        observed: TestMutex<Option<(AppConfig, Vec<PreparedRecording>)>>,
    }

    #[async_trait]
    impl RecordingBackend for ObservingPreflightBackend {
        async fn preflight(
            &self,
            config: &AppConfig,
            items: &[PreparedRecording],
        ) -> Result<(), DomainError> {
            self.preflights.fetch_add(1, Ordering::SeqCst);
            *self.observed.lock().expect("preflight observation") =
                Some((config.clone(), items.to_vec()));
            Ok(())
        }

        async fn record(
            &self,
            _config: &AppConfig,
            _item: &PreparedRecording,
            _cancellation: &RecordingCancellation,
            _progress: &RecordingProgressSink,
        ) -> Result<RecordedClip, DomainError> {
            self.records.fetch_add(1, Ordering::SeqCst);
            Err(DomainError::Internal(
                "record must not run during preflight".to_owned(),
            ))
        }
    }

    #[derive(Debug)]
    struct FailingLifecycleBackend {
        begins: AtomicUsize,
        finishes: AtomicUsize,
    }

    #[derive(Debug)]
    struct BlockingStartupBackend {
        begins: AtomicUsize,
        finishes: AtomicUsize,
        entered: tokio::sync::Notify,
    }

    #[async_trait]
    impl RecordingBackend for BlockingStartupBackend {
        async fn preflight(
            &self,
            _config: &AppConfig,
            _items: &[PreparedRecording],
        ) -> Result<(), DomainError> {
            Ok(())
        }

        async fn begin_job(
            &self,
            _config: &AppConfig,
            _items: &[PreparedRecording],
        ) -> Result<(), DomainError> {
            if self.begins.fetch_add(1, Ordering::SeqCst) == 0 {
                self.entered.notify_one();
                futures_util::future::pending::<()>().await;
            }
            Ok(())
        }

        async fn record(
            &self,
            _config: &AppConfig,
            _item: &PreparedRecording,
            _cancellation: &RecordingCancellation,
            _progress: &RecordingProgressSink,
        ) -> Result<RecordedClip, DomainError> {
            Err(DomainError::DependencyUnavailable(
                "injected recording failure".to_owned(),
            ))
        }

        async fn finish_job(&self, _job_id: Uuid) -> Result<(), DomainError> {
            self.finishes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[async_trait]
    impl RecordingBackend for FailingLifecycleBackend {
        async fn preflight(
            &self,
            _config: &AppConfig,
            _items: &[PreparedRecording],
        ) -> Result<(), DomainError> {
            Ok(())
        }

        async fn begin_job(
            &self,
            _config: &AppConfig,
            _items: &[PreparedRecording],
        ) -> Result<(), DomainError> {
            self.begins.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn record(
            &self,
            _config: &AppConfig,
            _item: &PreparedRecording,
            _cancellation: &RecordingCancellation,
            _progress: &RecordingProgressSink,
        ) -> Result<RecordedClip, DomainError> {
            Err(DomainError::DependencyUnavailable(
                "injected recording failure".to_owned(),
            ))
        }

        async fn finish_job(&self, _job_id: Uuid) -> Result<(), DomainError> {
            self.finishes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[derive(Debug, Default)]
    struct ReportingBackend {
        retained_progress: TestMutex<Option<RecordingProgressSink>>,
        encoding_reported: bool,
    }

    #[derive(Debug)]
    struct UncleanableCancelledClipBackend {
        output_path: PathBuf,
    }

    #[derive(Debug)]
    struct ObservingRecoveryBackend {
        recovered: TestMutex<Vec<Uuid>>,
        fail_job: Uuid,
    }

    #[derive(Debug)]
    struct PublishedRecoveryBackend {
        storage: Storage,
        clip: RecordedClip,
        commits: AtomicUsize,
    }

    #[async_trait]
    impl RecordingBackend for PublishedRecoveryBackend {
        async fn preflight(
            &self,
            _config: &AppConfig,
            _items: &[PreparedRecording],
        ) -> Result<(), DomainError> {
            Ok(())
        }

        async fn record(
            &self,
            _config: &AppConfig,
            _item: &PreparedRecording,
            _cancellation: &RecordingCancellation,
            _progress: &RecordingProgressSink,
        ) -> Result<RecordedClip, DomainError> {
            unreachable!("restart recovery must not start a new recording")
        }

        async fn recover_orphaned_job(
            &self,
            job: &RecordingJob,
        ) -> Result<OrphanedRecordingRecovery, DomainError> {
            Ok(OrphanedRecordingRecovery::PublishedClip {
                item_index: job.current_index,
                clip: Box::new(self.clip.clone()),
            })
        }

        async fn commit_recorded_clip(
            &self,
            job_id: Uuid,
            item_index: usize,
            clip: &RecordedClip,
        ) -> Result<(), DomainError> {
            let stored_clip = self
                .storage
                .get_recorded_clip(clip.id)
                .await
                .map_err(|error| storage_error(&error))?;
            let stored_job = self
                .storage
                .get_recording_job(job_id)
                .await
                .map_err(|error| storage_error(&error))?
                .ok_or_else(|| DomainError::Internal("recording job disappeared".to_owned()))?;
            if stored_clip.as_ref() != Some(clip)
                || stored_job.current_index != item_index
                || stored_job.outputs.get(item_index) != Some(clip)
            {
                return Err(DomainError::Internal(
                    "recovery retired publication evidence before durable clip and job storage"
                        .to_owned(),
                ));
            }
            self.commits.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[async_trait]
    impl RecordingBackend for ObservingRecoveryBackend {
        async fn preflight(
            &self,
            _config: &AppConfig,
            _items: &[PreparedRecording],
        ) -> Result<(), DomainError> {
            Ok(())
        }

        async fn record(
            &self,
            _config: &AppConfig,
            _item: &PreparedRecording,
            _cancellation: &RecordingCancellation,
            _progress: &RecordingProgressSink,
        ) -> Result<RecordedClip, DomainError> {
            unreachable!("orphan recovery must not start recording")
        }

        async fn recover_orphaned_job(
            &self,
            job: &RecordingJob,
        ) -> Result<OrphanedRecordingRecovery, DomainError> {
            self.recovered
                .lock()
                .expect("recovery observations")
                .push(job.id);
            if job.id == self.fail_job {
                return Err(DomainError::CleanupFailed(
                    "injected artifact lease rejection".to_owned(),
                ));
            }
            Ok(OrphanedRecordingRecovery::NoPublishedClip)
        }
    }

    #[async_trait]
    impl RecordingBackend for UncleanableCancelledClipBackend {
        async fn preflight(
            &self,
            _config: &AppConfig,
            _items: &[PreparedRecording],
        ) -> Result<(), DomainError> {
            Ok(())
        }

        async fn record(
            &self,
            _config: &AppConfig,
            item: &PreparedRecording,
            cancellation: &RecordingCancellation,
            _progress: &RecordingProgressSink,
        ) -> Result<RecordedClip, DomainError> {
            tokio::fs::write(&self.output_path, b"must-not-be-deleted")
                .await
                .expect("external clip fixture");
            cancellation.cancel();
            Ok(RecordedClip {
                id: Uuid::new_v4(),
                path: self.output_path.to_string_lossy().into_owned(),
                title: item.request.title.clone(),
                duration_seconds: 1.0,
                demo_id: Some(item.demo.id),
                player_name: Some(item.request.player_id.clone()),
                category: "highlight".to_owned(),
                tags: Vec::new(),
                metadata: json!({
                    "capture_backend": "managed_hlae_windows_mf"
                }),
                created_at: Utc::now(),
            })
        }
    }

    #[async_trait]
    impl RecordingBackend for ReportingBackend {
        async fn preflight(
            &self,
            _config: &AppConfig,
            _items: &[PreparedRecording],
        ) -> Result<(), DomainError> {
            Ok(())
        }

        async fn record(
            &self,
            _config: &AppConfig,
            _item: &PreparedRecording,
            cancellation: &RecordingCancellation,
            progress: &RecordingProgressSink,
        ) -> Result<RecordedClip, DomainError> {
            progress.report(RecordingStage::Launching);
            if self.encoding_reported {
                progress.report(RecordingStage::Encoding);
            }
            *self
                .retained_progress
                .lock()
                .expect("retained progress sink") = Some(progress.clone());
            cancellation.cancelled().await;
            Err(DomainError::Conflict("cancelled".to_owned()))
        }
    }

    async fn fixture(
        wait_for_cancel: bool,
    ) -> (
        tempfile::TempDir,
        Storage,
        RuntimeRecordingPort,
        RecordingJob,
    ) {
        let root = tempfile::tempdir().expect("tempdir");
        let demo_path = root.path().join("fixture.dem");
        tokio::fs::write(&demo_path, b"demo")
            .await
            .expect("demo file");
        let storage = Storage::open_in_memory().await.expect("storage");
        let now = Utc::now();
        let demo_id = Uuid::new_v4();
        storage
            .put_demo(DemoRecord {
                id: demo_id,
                path: demo_path.to_string_lossy().into_owned(),
                file_name: "fixture.dem".to_owned(),
                display_name: "Fixture".to_owned(),
                source: "test".to_owned(),
                status: vibe_cs_domain::DemoStatus::Ready,
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
                content_sha256: Some(hex::encode(Sha256::digest(b"demo"))),
                file_size: 4,
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("demo");
        storage
            .put_analysis(MatchAnalysis {
                demo_id,
                map_name: "de_test".to_owned(),
                tick_rate: 64.0,
                duration_seconds: 4.0,
                verified_total_ticks: Some(256),
                teams: Vec::new(),
                players: vec![vibe_cs_domain::PlayerStats {
                    steam_id: "player".to_owned(),
                    spectator_slot: Some(7),
                    name: "Player".to_owned(),
                    team: "T".to_owned(),
                    kills: 0,
                    deaths: 0,
                    assists: 0,
                    headshots: 0,
                    damage: 0,
                    adr: 0.0,
                    kill_death_ratio: 0.0,
                    score: 0,
                }],
                rounds: Vec::new(),
                highlights: Vec::new(),
            })
            .await
            .expect("analysis");
        let job = RecordingJob {
            id: Uuid::new_v4(),
            status: JobStatus::Queued,
            items: vec![RecordingRequest {
                id: None,
                demo_id,
                highlight_id: None,
                player_id: "player".to_owned(),
                title: "Highlight".to_owned(),
                start_tick: 64,
                end_tick: 128,
                pre_roll_seconds: 0.0,
                post_roll_seconds: 0.0,
                victim_pov: false,
            }],
            current_index: 0,
            progress: 0.0,
            message: "Queued".to_owned(),
            outputs: Vec::new(),
            created_at: now,
            updated_at: now,
        };
        let backend = Arc::new(FakeBackend {
            output_dir: root.path().to_path_buf(),
            wait_for_cancel,
        });
        let port = RuntimeRecordingPort::new(storage.clone(), backend);
        (root, storage, port, job)
    }

    async fn wait_for_terminal(storage: &Storage, id: Uuid) -> RecordingJob {
        for _ in 0..100 {
            let job = storage
                .get_recording_job(id)
                .await
                .expect("read job")
                .expect("job exists");
            if job.status.is_terminal() {
                return job;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("recording job did not become terminal");
    }

    #[tokio::test]
    async fn preflight_uses_current_config_and_authoritative_analysis_without_persisting_or_recording()
     {
        let (_root, storage, _port, job) = fixture(false).await;
        let mut config = AppConfig::default();
        config.recording.camera_fov = 101.0;
        storage
            .put_config(config)
            .await
            .expect("current recording config");
        storage
            .put_analysis(MatchAnalysis {
                demo_id: job.items[0].demo_id,
                map_name: "de_test".to_owned(),
                tick_rate: 128.0,
                duration_seconds: 12.0,
                verified_total_ticks: Some(1_536),
                teams: Vec::new(),
                players: vec![vibe_cs_domain::PlayerStats {
                    steam_id: "player".to_owned(),
                    spectator_slot: Some(7),
                    name: "Player".to_owned(),
                    team: "T".to_owned(),
                    kills: 0,
                    deaths: 0,
                    assists: 0,
                    headshots: 0,
                    damage: 0,
                    adr: 0.0,
                    kill_death_ratio: 0.0,
                    score: 0,
                }],
                rounds: Vec::new(),
                highlights: Vec::new(),
            })
            .await
            .expect("authoritative analysis");
        let backend = Arc::new(ObservingPreflightBackend::default());
        let port = RuntimeRecordingPort::new(storage.clone(), backend.clone());

        port.preflight(&job.items)
            .await
            .expect("recording preflight");

        assert_eq!(backend.preflights.load(Ordering::SeqCst), 1);
        assert_eq!(backend.records.load(Ordering::SeqCst), 0);
        assert!(
            storage
                .list_recording_jobs()
                .await
                .expect("recording jobs")
                .is_empty()
        );
        let observed = backend
            .observed
            .lock()
            .expect("preflight observation")
            .clone()
            .expect("observed preflight");
        assert!((observed.0.recording.camera_fov - 101.0).abs() < f64::EPSILON);
        assert_eq!(observed.1.len(), 1);
        assert_eq!(observed.1[0].segment.spectator_slot, Some(7));
        assert_eq!(observed.1[0].segment.verified_total_ticks, Some(1_536));
        assert!((observed.1[0].segment.tick_rate - 128.0).abs() < f64::EPSILON);
    }

    #[tokio::test]
    async fn preflight_preserves_missing_or_ambiguous_observer_evidence_for_backend_rejection() {
        let (_root, storage, _port, job) = fixture(false).await;
        let player = vibe_cs_domain::PlayerStats {
            steam_id: "player".to_owned(),
            spectator_slot: Some(7),
            name: "Player".to_owned(),
            team: "T".to_owned(),
            kills: 0,
            deaths: 0,
            assists: 0,
            headshots: 0,
            damage: 0,
            adr: 0.0,
            kill_death_ratio: 0.0,
            score: 0,
        };
        let mut conflicting_player = player.clone();
        conflicting_player.steam_id = "other-player".to_owned();
        storage
            .put_analysis(MatchAnalysis {
                demo_id: job.items[0].demo_id,
                map_name: "de_test".to_owned(),
                tick_rate: 64.0,
                duration_seconds: 12.0,
                verified_total_ticks: None,
                teams: Vec::new(),
                players: vec![player, conflicting_player],
                rounds: Vec::new(),
                highlights: Vec::new(),
            })
            .await
            .expect("ambiguous observer analysis");
        let backend = Arc::new(ObservingPreflightBackend::default());
        let port = RuntimeRecordingPort::new(storage, backend.clone());

        port.preflight(&job.items)
            .await
            .expect("runtime preserves evidence for the concrete backend contract");

        let observed = backend
            .observed
            .lock()
            .expect("preflight observation")
            .clone()
            .expect("observed preflight");
        assert_eq!(observed.1[0].segment.spectator_slot, None);
        assert_eq!(observed.1[0].segment.verified_total_ticks, None);
    }

    #[tokio::test]
    async fn fake_backend_completes_and_persists_a_real_output() {
        let (_root, storage, port, job) = fixture(false).await;
        let started = port.execute(job).await.expect("start");
        assert_eq!(started.status, JobStatus::Running);
        let completed = wait_for_terminal(&storage, started.id).await;
        assert_eq!(completed.status, JobStatus::Completed);
        assert_eq!(completed.outputs.len(), 1);
        assert!(Path::new(&completed.outputs[0].path).is_file());
        assert_eq!(storage.list_recorded_clips().await.expect("clips").len(), 1);
    }

    #[tokio::test]
    async fn backend_publication_is_committed_only_after_clip_and_job_are_durable() {
        let (root, storage, _port, job) = fixture(false).await;
        let backend = Arc::new(CommitOrderBackend {
            output_dir: root.path().to_path_buf(),
            storage: storage.clone(),
            commits: AtomicUsize::new(0),
            cancel_after_publish: false,
        });
        let port = RuntimeRecordingPort::new(storage.clone(), backend.clone());

        let started = port.execute(job).await.expect("start recording");
        let completed = wait_for_terminal(&storage, started.id).await;

        assert_eq!(completed.status, JobStatus::Completed);
        assert_eq!(backend.commits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancellation_after_publication_commits_the_verified_clip_before_cancelling_job() {
        let (root, storage, _port, job) = fixture(false).await;
        let backend = Arc::new(CommitOrderBackend {
            output_dir: root.path().to_path_buf(),
            storage: storage.clone(),
            commits: AtomicUsize::new(0),
            cancel_after_publish: true,
        });
        let port = RuntimeRecordingPort::new(storage.clone(), backend.clone());

        let started = port.execute(job).await.expect("start recording");
        let cancelled = wait_for_terminal(&storage, started.id).await;

        assert_eq!(cancelled.status, JobStatus::Cancelled);
        assert_eq!(cancelled.outputs.len(), 1);
        assert_eq!(backend.commits.load(Ordering::SeqCst), 1);
        assert_eq!(
            storage.list_recorded_clips().await.expect("durable clips"),
            cancelled.outputs
        );
        assert!(Path::new(&cancelled.outputs[0].path).is_file());
    }

    #[tokio::test]
    async fn backend_stage_is_persisted_without_waiting_for_the_clip_to_finish() {
        let (_root, storage, _port, job) = fixture(false).await;
        let backend = Arc::new(ReportingBackend {
            retained_progress: TestMutex::new(None),
            encoding_reported: false,
        });
        let port = RuntimeRecordingPort::new(storage.clone(), backend.clone());

        let started = port.execute(job).await.expect("start recording");
        let observed = loop {
            let observed = storage
                .get_recording_job(started.id)
                .await
                .expect("read recording job")
                .expect("recording job");
            if observed.message == RecordingStage::Launching.code() {
                break observed;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };

        assert!((observed.progress - 0.2).abs() < f64::EPSILON);
        let cancelling = port.cancel(observed).await.expect("cancel recording");
        assert_eq!(
            wait_for_terminal(&storage, cancelling.id).await.status,
            JobStatus::Cancelled
        );
        assert!(
            backend
                .retained_progress
                .lock()
                .expect("retained progress sink")
                .take()
                .is_some(),
            "job completion must not depend on every sink clone being dropped"
        );
    }

    #[tokio::test]
    async fn encoding_stage_never_marks_an_unpublished_clip_complete() {
        let (_root, storage, _port, job) = fixture(false).await;
        let backend = Arc::new(ReportingBackend {
            retained_progress: TestMutex::new(None),
            encoding_reported: true,
        });
        let port = RuntimeRecordingPort::new(storage.clone(), backend.clone());

        let started = port.execute(job).await.expect("start recording");
        let observed = loop {
            let observed = storage
                .get_recording_job(started.id)
                .await
                .expect("read recording job")
                .expect("recording job");
            if observed.message == RecordingStage::Encoding.code() {
                break observed;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };

        assert!(observed.progress < 1.0);
        assert!(observed.outputs.is_empty());
        let cancelling = port.cancel(observed).await.expect("cancel recording");
        assert_eq!(
            wait_for_terminal(&storage, cancelling.id).await.status,
            JobStatus::Cancelled
        );
        backend
            .retained_progress
            .lock()
            .expect("retained progress sink")
            .take();
    }

    #[tokio::test]
    async fn recording_refuses_a_demo_that_changed_after_analysis() {
        let (root, _storage, port, job) = fixture(false).await;
        tokio::fs::write(root.path().join("fixture.dem"), b"changed demo")
            .await
            .expect("replace demo fixture");

        let error = port
            .execute(job)
            .await
            .expect_err("stale parser identity must not drive another Demo");
        assert!(matches!(error, DomainError::Conflict(_)));
        assert!(error.to_string().contains("fingerprint"));
    }

    #[tokio::test]
    async fn one_job_hashes_each_unique_demo_only_once() {
        let (root, storage, port, mut job) = fixture(true).await;
        job.items.push(job.items[0].clone());
        let demo_path = std::path::absolute(root.path().join("fixture.dem"))
            .expect("absolute Demo fixture path");
        recording_demo_hash_passes()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&demo_path);

        let started = port.execute(job).await.expect("start recording");
        assert_eq!(
            recording_demo_hash_passes()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .get(&demo_path),
            Some(&1),
        );
        let cancelling = port.cancel(started).await.expect("cancel recording");
        assert_eq!(
            wait_for_terminal(&storage, cancelling.id).await.status,
            JobStatus::Cancelled
        );
    }

    #[tokio::test]
    async fn recording_refuses_a_demo_without_a_valid_content_hash() {
        let (_root, storage, port, job) = fixture(false).await;
        let mut demo = storage
            .get_demo(job.items[0].demo_id)
            .await
            .expect("read Demo")
            .expect("Demo fixture");
        demo.content_sha256 = Some("not-a-sha256".to_owned());
        storage.put_demo(demo).await.expect("update Demo");

        let error = port
            .execute(job)
            .await
            .expect_err("an invalid content hash must fail closed");
        assert!(matches!(error, DomainError::DependencyUnavailable(_)));
        assert!(error.to_string().contains("reimported"));
    }

    #[tokio::test]
    async fn recording_refuses_a_demo_without_any_content_hash() {
        let (_root, storage, port, job) = fixture(false).await;
        let mut demo = storage
            .get_demo(job.items[0].demo_id)
            .await
            .expect("read Demo")
            .expect("Demo fixture");
        demo.content_sha256 = None;
        storage.put_demo(demo).await.expect("update Demo");

        let error = port
            .execute(job)
            .await
            .expect_err("a missing content hash must fail closed");
        assert!(matches!(error, DomainError::DependencyUnavailable(_)));
        assert!(error.to_string().contains("reimported"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn recording_holds_the_verified_demo_read_only_for_the_whole_job() {
        let (root, storage, port, job) = fixture(true).await;
        let demo_path = root.path().join("fixture.dem");
        let started = port.execute(job).await.expect("start recording");

        let write_error = std::fs::OpenOptions::new()
            .write(true)
            .open(&demo_path)
            .expect_err("a running recording must deny new Demo writers");
        assert_eq!(
            write_error.raw_os_error(),
            Some(32),
            "the verified Demo handle should reject Windows write sharing"
        );

        let cancelling = port.cancel(started).await.expect("cancel recording");
        let cancelled = wait_for_terminal(&storage, cancelling.id).await;
        assert_eq!(cancelled.status, JobStatus::Cancelled);
        for _ in 0..100 {
            match std::fs::OpenOptions::new().write(true).open(&demo_path) {
                Ok(_) => return,
                Err(_) => tokio::time::sleep(Duration::from_millis(5)).await,
            }
        }
        panic!("the Demo guard should be released when the job becomes terminal");
    }

    #[tokio::test]
    async fn fake_backend_transitions_through_cancelling_to_cancelled() {
        let (_root, storage, port, job) = fixture(true).await;
        let started = port.execute(job).await.expect("start");
        let cancelling = port.cancel(started).await.expect("cancel");
        assert_eq!(cancelling.status, JobStatus::Cancelling);
        let cancelled = wait_for_terminal(&storage, cancelling.id).await;
        assert_eq!(cancelled.status, JobStatus::Cancelled);
        assert!(cancelled.outputs.is_empty());
    }

    #[tokio::test]
    async fn cancellation_with_failed_managed_clip_cleanup_is_failed_not_cancelled() {
        let (external, _external_storage, _external_port, _external_job) = fixture(false).await;
        let victim = external.path().join("external-victim.mp4");
        let (_root, storage, _port, job) = fixture(false).await;
        let port = RuntimeRecordingPort::new(
            storage.clone(),
            Arc::new(UncleanableCancelledClipBackend {
                output_path: victim.clone(),
            }),
        );

        let started = port.execute(job).await.expect("start recording");
        let terminal = wait_for_terminal(&storage, started.id).await;

        assert_eq!(terminal.status, JobStatus::Failed);
        assert!(terminal.message.contains("cleanup"));
        assert_eq!(
            tokio::fs::read(&victim)
                .await
                .expect("external victim survives"),
            b"must-not-be-deleted"
        );
    }

    #[tokio::test]
    async fn job_resources_are_finished_after_a_recording_failure() {
        let (_root, storage, port, mut job) = fixture(false).await;
        let prepared = port.prepare(&job).await.expect("prepared job");
        let backend = Arc::new(FailingLifecycleBackend {
            begins: AtomicUsize::new(0),
            finishes: AtomicUsize::new(0),
        });
        let cancellation = RecordingCancellation::default();
        let persistence = Arc::new(Mutex::new(()));
        let active = Arc::new(Mutex::new(HashMap::from([(
            job.id,
            ActiveRecording {
                cancellation: cancellation.clone(),
                persistence: Arc::clone(&persistence),
            },
        )])));
        backend
            .begin_job(&AppConfig::default(), &prepared.items)
            .await
            .expect("begin recording lifecycle");
        job.status = JobStatus::Running;
        storage.put_recording_job(job.clone()).await.expect("job");
        RuntimeRecordingPort::run_job(RecordingRun {
            storage: storage.clone(),
            backend: backend.clone(),
            active,
            config: AppConfig::default(),
            job: job.clone(),
            prepared,
            cancellation,
            persistence,
        })
        .await;
        assert_eq!(backend.begins.load(Ordering::SeqCst), 1);
        assert_eq!(backend.finishes.load(Ordering::SeqCst), 1);
        assert_eq!(
            storage
                .get_recording_job(job.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            JobStatus::Failed
        );
    }

    #[tokio::test]
    async fn aborting_execute_during_begin_releases_the_job_context_and_active_reservation() {
        let (_root, storage, _port, job) = fixture(false).await;
        let backend = Arc::new(BlockingStartupBackend {
            begins: AtomicUsize::new(0),
            finishes: AtomicUsize::new(0),
            entered: tokio::sync::Notify::new(),
        });
        let port = RuntimeRecordingPort::new(storage.clone(), backend.clone());
        let first_port = port.clone();
        let first_job = job.clone();
        let first = tokio::spawn(async move { first_port.execute(first_job).await });
        backend.entered.notified().await;

        first.abort();
        let _ = first.await;
        for _ in 0..100 {
            if backend.finishes.load(Ordering::SeqCst) == 1 && port.active.lock().await.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(backend.finishes.load(Ordering::SeqCst), 1);
        assert!(port.active.lock().await.is_empty());

        let mut next = job;
        next.id = Uuid::new_v4();
        let started = port
            .execute(next)
            .await
            .expect("aborted startup must not block the next recording job");
        assert_eq!(started.status, JobStatus::Running);
        assert_eq!(
            wait_for_terminal(&storage, started.id).await.status,
            JobStatus::Failed
        );
        assert_eq!(backend.finishes.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn restart_recovery_terminalizes_orphaned_recording_jobs() {
        let (_root, storage, port, mut running) = fixture(false).await;
        running.status = JobStatus::Running;
        storage
            .put_recording_job(running.clone())
            .await
            .expect("persist running job");
        let mut cancelling = running.clone();
        cancelling.id = Uuid::new_v4();
        cancelling.status = JobStatus::Cancelling;
        storage
            .put_recording_job(cancelling.clone())
            .await
            .expect("persist cancelling job");

        port.recover_orphaned_jobs().await;

        let failed = storage
            .get_recording_job(running.id)
            .await
            .expect("read running job")
            .expect("running job exists");
        let cancelled = storage
            .get_recording_job(cancelling.id)
            .await
            .expect("read cancelling job")
            .expect("cancelling job exists");
        assert_eq!(failed.status, JobStatus::Failed);
        assert!(failed.message.contains("interrupted"));
        assert_eq!(cancelled.status, JobStatus::Cancelled);
    }

    #[tokio::test]
    async fn restart_restores_verified_publication_before_retiring_backend_evidence() {
        let (root, storage, _port, mut running) = fixture(false).await;
        let output = root.path().join("recovered.mp4");
        tokio::fs::write(&output, b"verified-recovered-video")
            .await
            .expect("recovered output");
        let clip = RecordedClip {
            id: Uuid::new_v4(),
            path: output.to_string_lossy().into_owned(),
            title: running.items[0].title.clone(),
            duration_seconds: 1.0,
            demo_id: Some(running.items[0].demo_id),
            player_name: Some(running.items[0].player_id.clone()),
            category: "highlight".to_owned(),
            tags: Vec::new(),
            metadata: serde_json::Value::Null,
            created_at: Utc::now(),
        };
        running.status = JobStatus::Running;
        storage
            .put_recording_job(running.clone())
            .await
            .expect("persist orphaned job");
        let backend = Arc::new(PublishedRecoveryBackend {
            storage: storage.clone(),
            clip: clip.clone(),
            commits: AtomicUsize::new(0),
        });
        let port = RuntimeRecordingPort::new(storage.clone(), backend.clone());

        port.recover_orphaned_jobs().await;

        let recovered = storage
            .get_recording_job(running.id)
            .await
            .expect("read recovered job")
            .expect("recovered job");
        assert_eq!(recovered.status, JobStatus::Completed);
        assert_eq!(recovered.outputs, vec![clip.clone()]);
        assert_eq!(
            storage
                .get_recorded_clip(clip.id)
                .await
                .expect("read recovered clip"),
            Some(clip)
        );
        assert_eq!(backend.commits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn restart_completes_a_fully_committed_job_after_its_lease_was_retired() {
        let (root, storage, port, mut running) = fixture(false).await;
        let output = root.path().join("already-committed.mp4");
        tokio::fs::write(&output, b"already-committed-video")
            .await
            .expect("committed output");
        let clip = RecordedClip {
            id: Uuid::new_v4(),
            path: output.to_string_lossy().into_owned(),
            title: running.items[0].title.clone(),
            duration_seconds: 1.0,
            demo_id: Some(running.items[0].demo_id),
            player_name: Some(running.items[0].player_id.clone()),
            category: "highlight".to_owned(),
            tags: Vec::new(),
            metadata: serde_json::Value::Null,
            created_at: Utc::now(),
        };
        running.status = JobStatus::Running;
        running.outputs.push(clip.clone());
        storage
            .put_recorded_clip(clip.clone())
            .await
            .expect("durable clip");
        storage
            .put_recording_job(running.clone())
            .await
            .expect("durable job output");

        port.recover_orphaned_jobs().await;

        let recovered = storage
            .get_recording_job(running.id)
            .await
            .expect("read recovered job")
            .expect("recovered job");
        assert_eq!(recovered.status, JobStatus::Completed);
        assert_eq!(recovered.current_index, recovered.items.len());
        assert!((recovered.progress - 1.0).abs() <= f64::EPSILON);
        assert_eq!(recovered.outputs, vec![clip]);
    }

    #[tokio::test]
    async fn restart_recovers_only_non_terminal_jobs_and_surfaces_cleanup_failure() {
        let (_root, storage, _port, mut running) = fixture(false).await;
        running.status = JobStatus::Running;
        storage
            .put_recording_job(running.clone())
            .await
            .expect("persist running job");
        let mut cancelling = running.clone();
        cancelling.id = Uuid::new_v4();
        cancelling.status = JobStatus::Cancelling;
        storage
            .put_recording_job(cancelling.clone())
            .await
            .expect("persist cancelling job");
        let mut completed = running.clone();
        completed.id = Uuid::new_v4();
        completed.status = JobStatus::Completed;
        storage
            .put_recording_job(completed.clone())
            .await
            .expect("persist completed job");
        let backend = Arc::new(ObservingRecoveryBackend {
            recovered: TestMutex::new(Vec::new()),
            fail_job: cancelling.id,
        });
        let port = RuntimeRecordingPort::new(storage.clone(), backend.clone());

        port.recover_orphaned_jobs().await;

        let observed = backend
            .recovered
            .lock()
            .expect("recovery observations")
            .clone();
        assert!(observed.contains(&running.id));
        assert!(observed.contains(&cancelling.id));
        assert!(!observed.contains(&completed.id));
        let failed_cleanup = storage
            .get_recording_job(cancelling.id)
            .await
            .expect("read cancelling job")
            .expect("cancelling job exists");
        assert_eq!(failed_cleanup.status, JobStatus::Failed);
        assert!(failed_cleanup.message.contains("recovery failed"));
        assert!(failed_cleanup.message.contains("lease rejection"));
        assert_eq!(
            storage
                .get_recording_job(completed.id)
                .await
                .expect("read completed job")
                .expect("completed job exists")
                .status,
            JobStatus::Completed
        );
    }

    #[tokio::test]
    async fn segment_mapping_uses_analysis_rate_rolls_and_unique_safe_outputs() {
        let (_root, storage, _port, job) = fixture(false).await;
        let request = &job.items[0];
        let demo = storage
            .get_demo(request.demo_id)
            .await
            .expect("read demo")
            .expect("demo");
        let mut request = request.clone();
        request.title = "Ace / ../ dangerous : title".to_owned();
        request.start_tick = 640;
        request.end_tick = 1_280;
        request.pre_roll_seconds = 1.0;
        request.post_roll_seconds = 0.5;
        let analysis = MatchAnalysis {
            demo_id: demo.id,
            map_name: "de_test".to_owned(),
            tick_rate: 128.0,
            duration_seconds: 30.0,
            verified_total_ticks: Some(3_840),
            teams: Vec::new(),
            players: vec![vibe_cs_domain::PlayerStats {
                steam_id: "player".to_owned(),
                spectator_slot: Some(7),
                name: "Player".to_owned(),
                team: "T".to_owned(),
                kills: 0,
                deaths: 0,
                assists: 0,
                headshots: 0,
                damage: 0,
                adr: 0.0,
                kill_death_ratio: 0.0,
                score: 0,
            }],
            rounds: Vec::new(),
            highlights: Vec::new(),
        };
        let tick_rate = authoritative_tick_rate(Some(&analysis)).expect("authoritative tick rate");
        assert!((tick_rate - 128.0).abs() < f64::EPSILON);
        assert!(matches!(
            authoritative_tick_rate(None),
            Err(DomainError::DependencyUnavailable(message)) if message.contains("reanalyzed")
        ));

        let demo_path = std::path::absolute(&demo.path).expect("absolute demo path");
        let first = build_segment_plan(
            &request,
            &demo,
            Some(&analysis),
            demo_path.clone(),
            tick_rate,
            Uuid::from_u128(1),
        )
        .expect("first segment");
        let second = build_segment_plan(
            &request,
            &demo,
            Some(&analysis),
            demo_path.clone(),
            tick_rate,
            Uuid::from_u128(2),
        )
        .expect("second segment");

        assert_eq!(first.start_tick, 512);
        assert_eq!(first.end_tick, 1_344);
        assert!((first.tick_rate - 128.0).abs() < f64::EPSILON);
        assert_eq!(first.metadata["tick_rate_source"], "persisted_analysis");
        for retired in [
            "show_keyboard_requested",
            "show_kill_fx_requested",
            "fade_requested",
            "kill_track",
            "input_track",
            "input_state_bus",
        ] {
            assert!(first.metadata.get(retired).is_none());
        }
        assert_eq!(first.spectator_slot, Some(7));
        assert_eq!(first.verified_total_ticks, Some(3_840));
        let mut ambiguous_analysis = analysis.clone();
        let mut conflicting_player = ambiguous_analysis.players[0].clone();
        conflicting_player.steam_id = "another-player".to_owned();
        ambiguous_analysis.players.push(conflicting_player);
        let ambiguous = build_segment_plan(
            &request,
            &demo,
            Some(&ambiguous_analysis),
            std::path::absolute(&demo.path).expect("absolute demo path"),
            tick_rate,
            Uuid::from_u128(4),
        )
        .expect("ambiguous analysis remains representable for fail-closed preflight");
        assert_eq!(ambiguous.spectator_slot, None);
        assert_ne!(first.output_file_name, second.output_file_name);
        assert!(
            Path::new(&first.output_file_name)
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4"))
        );
        assert_eq!(
            Path::new(&first.output_file_name)
                .file_name()
                .and_then(|name| name.to_str()),
            Some(first.output_file_name.as_str())
        );
        assert!(!first.output_file_name.contains(['/', '\\', ':']));
    }
}
