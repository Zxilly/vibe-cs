use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use chrono::Utc;
use serde_json::Value;
use tokio::sync::{Mutex, mpsc};
use uuid::Uuid;
use vibe_cs_application::ExportPort;
use vibe_cs_domain::{DomainError, ExportJob, JobFailureCode, JobStatus};
use vibe_cs_media::{
    EditorMediaKind, EditorMediaSource, EditorRenderOptions, EncoderSelection, FilterPlan,
    MediaError, ProcessCancellation, ProgressCallback, build_project_plan_with_sources,
    execute_native_filter_plan_with_progress, native_ffmpeg_info, native_probe_media,
    select_video_encoder,
};
use vibe_cs_storage::ExportJobRecord;

const MEDIA_INSPECTION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

pub struct RuntimeExportPort {
    storage: vibe_cs_storage::Storage,
    data_dir: PathBuf,
    active: Arc<Mutex<HashMap<Uuid, ProcessCancellation>>>,
}

/// The editor export request body.
///
/// It reaches this port as a `serde_json::Value` forwarded by the HTTP layer,
/// so this struct is the only place the shape is written down and therefore
/// the only honest source for the TypeScript binding.
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectRenderRequest {
    /// Encoder selection. `auto` lets the media layer choose.
    encoder: String,
    quality: u8,
    /// Trim the export to a window of the timeline. Both bounds may be omitted.
    #[serde(default)]
    range_start_seconds: Option<f64>,
    #[serde(default)]
    range_end_seconds: Option<f64>,
}

impl std::fmt::Debug for RuntimeExportPort {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeExportPort")
            .field("storage", &self.storage)
            .field("data_dir", &self.data_dir)
            .finish_non_exhaustive()
    }
}

impl RuntimeExportPort {
    #[must_use]
    pub fn new(storage: vibe_cs_storage::Storage, data_dir: PathBuf) -> Self {
        Self {
            storage,
            data_dir,
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Marks persisted active jobs left behind by a previous process as terminal.
    pub async fn recover_orphaned_jobs(&self) {
        let records = match self.storage.list_export_jobs(None).await {
            Ok(records) => records,
            Err(error) => {
                tracing::error!(%error, "unable to inspect orphaned export jobs");
                return;
            }
        };
        for mut record in records {
            record.job.status = match record.job.status {
                JobStatus::Cancelling => JobStatus::Cancelled,
                JobStatus::Queued | JobStatus::Preparing | JobStatus::Running => JobStatus::Failed,
                JobStatus::Completed | JobStatus::Failed | JobStatus::Cancelled => continue,
            };
            record.job.updated_at = Utc::now();
            record.job.error = Some(
                match record.job.status {
                    JobStatus::Cancelled => "export cancellation completed after service restart",
                    JobStatus::Failed => "export was interrupted by service restart",
                    _ => unreachable!("orphan reconciliation produces a terminal status"),
                }
                .to_owned(),
            );
            record.job.error_code = Some(match record.job.status {
                JobStatus::Cancelled => JobFailureCode::Cancelled,
                _ => JobFailureCode::Interrupted,
            });
            if let Err(error) = self.storage.put_export_job(record).await {
                tracing::error!(%error, "unable to persist orphaned export terminal state");
            }
        }
    }

    async fn prepare(
        &self,
        kind: &str,
        project_id: Uuid,
        request: &Value,
    ) -> Result<(ExportJobRecord, FilterPlan), DomainError> {
        if !matches!(kind, "project" | "project_preview") {
            return Err(DomainError::InvalidInput(format!(
                "unsupported export kind: {kind}"
            )));
        }
        let request: ProjectRenderRequest =
            serde_json::from_value(request.clone()).map_err(|error| {
                DomainError::InvalidInput(format!("invalid export options: {error}"))
            })?;
        let export_dir = self.data_dir.join(if kind == "project_preview" {
            "previews"
        } else {
            "exports"
        });
        tokio::fs::create_dir_all(&export_dir)
            .await
            .map_err(|error| DomainError::Internal(error.to_string()))?;
        let id = Uuid::new_v4();
        let output = export_dir.join(format!("{kind}-{project_id}-{id}.mp4"));
        let (plan, project_revision, range_start_seconds, range_end_seconds) =
            self.project_plan(project_id, &output, &request).await?;
        let now = Utc::now();
        let job = ExportJob {
            id,
            project_id,
            project_revision,
            range_start_seconds,
            range_end_seconds,
            status: JobStatus::Running,
            progress: 0.0,
            output_path: output.to_string_lossy().into_owned(),
            error: None,
            error_code: None,
            created_at: now,
            updated_at: now,
        };
        Ok((
            ExportJobRecord {
                kind: kind.to_owned(),
                job,
            },
            plan,
        ))
    }

    async fn project_plan(
        &self,
        project_id: Uuid,
        output: &Path,
        request: &ProjectRenderRequest,
    ) -> Result<(FilterPlan, u64, f64, f64), DomainError> {
        let project = self
            .storage
            .get_project(project_id)
            .await
            .map_err(|error| storage_error(&error))?
            .ok_or_else(|| DomainError::NotFound("project".to_owned()))?;
        let mut assets = HashMap::new();
        let mut referenced_assets = project
            .document
            .tracks
            .iter()
            .flat_map(|track| &track.clips)
            .filter_map(|clip| match clip.material {
                vibe_cs_domain::TimelineClipMaterial::Take { asset_id, .. }
                | vibe_cs_domain::TimelineClipMaterial::Asset { asset_id, .. } => Some(asset_id),
                vibe_cs_domain::TimelineClipMaterial::Planned => None,
            })
            .collect::<Vec<_>>();
        referenced_assets.extend(
            project
                .document
                .tracks
                .iter()
                .flat_map(|track| &track.clips)
                .filter_map(|clip| clip.text.as_ref()?.font_asset_id),
        );
        for asset_id in referenced_assets {
            if assets.contains_key(&asset_id.to_string()) {
                continue;
            }
            let (path, kind) = if let Some(asset) = self
                .storage
                .get_asset(asset_id)
                .await
                .map_err(|error| storage_error(&error))?
            {
                (asset.path, editor_media_kind(&asset.kind))
            } else if let Some(clip) = self
                .storage
                .get_recorded_clip(asset_id)
                .await
                .map_err(|error| storage_error(&error))?
            {
                // Recorded clips are first-class editor sources. Keeping their
                // identifier avoids copying a potentially large local video.
                (clip.path, EditorMediaKind::Video)
            } else {
                return Err(DomainError::NotFound(format!("media source {asset_id}")));
            };
            let path = PathBuf::from(path);
            let has_audio = match kind {
                EditorMediaKind::Audio => true,
                EditorMediaKind::Image | EditorMediaKind::Font => false,
                EditorMediaKind::Video => self.probe_has_audio(&path).await.unwrap_or(true),
            };
            assets.insert(
                asset_id.to_string(),
                EditorMediaSource {
                    path,
                    kind,
                    has_audio,
                },
            );
        }
        let encoder = Self::select_encoder(&request.encoder)?;
        let options = EditorRenderOptions {
            encoder,
            quality: request.quality,
            range_start: request.range_start_seconds,
            range_end: request.range_end_seconds,
        };
        let revision = project.revision;
        let range_start = request.range_start_seconds.unwrap_or(0.0);
        let range_end = request
            .range_end_seconds
            .unwrap_or(project.document.duration_seconds);
        build_project_plan_with_sources(&project, &assets, output, &options)
            .map(|plan| (plan, revision, range_start, range_end))
            .map_err(map_media_error)
    }

    async fn probe_has_audio(&self, path: &Path) -> Option<bool> {
        let cancellation = ProcessCancellation::default();
        let path = path.to_path_buf();
        let worker_cancellation = cancellation.clone();
        let result = tokio::time::timeout(
            MEDIA_INSPECTION_TIMEOUT,
            tokio::task::spawn_blocking(move || native_probe_media(&path, &worker_cancellation)),
        )
        .await
        .ok()
        .and_then(Result::ok);
        result
            .and_then(Result::ok)
            .map(|probe| probe.streams.iter().any(|stream| stream.kind == "audio"))
    }

    fn select_encoder(requested: &str) -> Result<EncoderSelection, DomainError> {
        let encoders = native_ffmpeg_info().map_err(map_media_error)?.encoders;
        select_video_encoder(requested, &encoders).map_err(map_media_error)
    }

    fn spawn_export(
        &self,
        mut record: ExportJobRecord,
        plan: FilterPlan,
        cancellation: ProcessCancellation,
    ) {
        let storage = self.storage.clone();
        let active = Arc::clone(&self.active);
        let job_id = record.job.id;
        tokio::spawn(async move {
            let (progress_sender, mut progress_receiver) = mpsc::unbounded_channel::<f64>();
            let duration = plan.duration_seconds;
            let progress_callback: ProgressCallback = Arc::new(move |progress| {
                let ratio = if progress.completed {
                    0.995
                } else {
                    (progress.out_time_seconds / duration).clamp(0.0, 0.995)
                };
                let _ = progress_sender.send(ratio);
            });
            let progress_storage = storage.clone();
            let progress_job_id = job_id;
            let progress_task = tokio::spawn(async move {
                let mut persisted = 0.0_f64;
                while let Some(progress) = progress_receiver.recv().await {
                    if progress <= persisted + 0.002 {
                        continue;
                    }
                    let Ok(Some(mut current)) =
                        progress_storage.get_export_job(progress_job_id).await
                    else {
                        break;
                    };
                    if current.job.status != JobStatus::Running {
                        break;
                    }
                    current.job.progress = progress;
                    current.job.updated_at = Utc::now();
                    if progress_storage.put_export_job(current).await.is_err() {
                        break;
                    }
                    persisted = progress;
                }
                persisted
            });
            let result =
                execute_native_filter_plan_with_progress(&plan, &cancellation, progress_callback)
                    .await;
            let persisted_progress = progress_task.await.unwrap_or(0.0);
            record.job.updated_at = Utc::now();
            record.job.progress = record.job.progress.max(persisted_progress);
            match (cancellation.is_cancelled(), result) {
                (true, _) | (false, Err(MediaError::Cancelled)) => {
                    record.job.status = JobStatus::Cancelled;
                    record.job.error = Some("export was cancelled".to_owned());
                    record.job.error_code = Some(JobFailureCode::Cancelled);
                }
                (false, Ok(())) => {
                    record.job.status = JobStatus::Completed;
                    record.job.progress = 1.0;
                    record.job.error = None;
                    record.job.error_code = None;
                }
                (false, Err(error)) => {
                    record.job.status = JobStatus::Failed;
                    record.job.error_code = Some(export_failure_code(&error));
                    record.job.error = Some(error.to_string().chars().take(2_000).collect());
                }
            }
            if let Err(error) = storage.put_export_job(record).await {
                tracing::error!(%error, "unable to persist export completion state");
            }
            active.lock().await.remove(&job_id);
        });
    }
}

fn editor_media_kind(kind: &str) -> EditorMediaKind {
    let kind = kind.trim().to_ascii_lowercase();
    if kind == "audio" || kind.starts_with("audio/") {
        EditorMediaKind::Audio
    } else if kind == "image" || kind.starts_with("image/") {
        EditorMediaKind::Image
    } else if kind == "font"
        || kind.starts_with("font/")
        || kind.contains("truetype")
        || kind.contains("opentype")
    {
        EditorMediaKind::Font
    } else {
        EditorMediaKind::Video
    }
}

#[async_trait]
impl ExportPort for RuntimeExportPort {
    async fn start(
        &self,
        kind: &str,
        project_id: Uuid,
        request: Value,
    ) -> Result<ExportJob, DomainError> {
        let (record, plan) = self.prepare(kind, project_id, &request).await?;
        let cancellation = ProcessCancellation::default();
        self.active
            .lock()
            .await
            .insert(record.job.id, cancellation.clone());
        if let Err(error) = self.storage.put_export_job(record.clone()).await {
            self.active.lock().await.remove(&record.job.id);
            return Err(storage_error(&error));
        }
        let job = record.job.clone();
        self.spawn_export(record, plan, cancellation);
        Ok(job)
    }

    async fn cancel(&self, job_id: Uuid) -> Result<ExportJob, DomainError> {
        let active_jobs = self.active.lock().await;
        let cancellation = active_jobs.get(&job_id).cloned();
        let mut record = self
            .storage
            .get_export_job(job_id)
            .await
            .map_err(|error| storage_error(&error))?
            .ok_or_else(|| DomainError::NotFound("export job".to_owned()))?;
        let Some(cancellation) = cancellation else {
            return if record.job.status.is_terminal() {
                Err(DomainError::Conflict(format!(
                    "export job is already {:?}",
                    record.job.status
                )))
            } else {
                Err(DomainError::Conflict(
                    "export job is not active in this process".to_owned(),
                ))
            };
        };
        match record.job.status {
            JobStatus::Queued | JobStatus::Preparing | JobStatus::Running => {
                record.job.status = JobStatus::Cancelling;
                record.job.updated_at = Utc::now();
                record.job.error = None;
                self.storage
                    .put_export_job(record.clone())
                    .await
                    .map_err(|error| storage_error(&error))?;
            }
            JobStatus::Cancelling => {}
            JobStatus::Completed | JobStatus::Failed | JobStatus::Cancelled => {
                return Err(DomainError::Conflict(format!(
                    "export job is already {:?}",
                    record.job.status
                )));
            }
        }
        cancellation.cancel();
        Ok(record.job)
    }

    async fn encoders(&self) -> Vec<String> {
        // Compiled into the linked libavcodec, so this is a registry lookup, not
        // a process spawn — but `ffmpeg::init()` runs on the first call, which is
        // why it goes to a blocking thread. A failure here means the build
        // cannot encode at all, which reads the same as an empty list.
        tokio::task::spawn_blocking(|| {
            native_ffmpeg_info()
                .map(|info| info.encoders)
                .unwrap_or_default()
        })
        .await
        .unwrap_or_default()
    }
}

fn storage_error(error: &vibe_cs_storage::StorageError) -> DomainError {
    DomainError::Internal(error.to_string())
}

fn map_media_error(error: MediaError) -> DomainError {
    match error {
        MediaError::ExecutableNotFound(message) => DomainError::DependencyUnavailable(message),
        MediaError::InvalidInput(message) => DomainError::InvalidInput(message),
        MediaError::Cancelled => DomainError::Conflict("media operation was cancelled".to_owned()),
        MediaError::OutputExists(path) => {
            DomainError::Conflict(format!("output already exists: {}", path.display()))
        }
        error @ (MediaError::OutputLimit { .. }
        | MediaError::ProcessFailed { .. }
        | MediaError::InvalidToolOutput(_)
        | MediaError::NativeFfmpeg(_)
        | MediaError::UnsupportedWave(_)
        | MediaError::EmptyOutput(_)
        | MediaError::Io { .. }
        | MediaError::Json(_)) => DomainError::Internal(error.to_string()),
    }
}

/// Classifies a render failure for 「11 输出与任务记录」.
///
/// The interesting one is `Io`: 「磁盘空间不足」 is the failure the artboard
/// actually draws, and `std::io::ErrorKind::StorageFull` is where that fact
/// exists. Everything else is mapped by what the user would do next, not by
/// which subsystem produced it — `ProcessFailed` and `NativeFfmpeg` are both
/// "`FFmpeg` ran and did not like it", and the message is the only thing that
/// separates them.
fn export_failure_code(error: &MediaError) -> JobFailureCode {
    match error {
        MediaError::Cancelled => JobFailureCode::Cancelled,
        MediaError::Io { source, .. } => JobFailureCode::from_io(source.kind()),
        MediaError::ExecutableNotFound(_) => JobFailureCode::DependencyMissing,
        MediaError::InvalidInput(_) | MediaError::UnsupportedWave(_) => {
            JobFailureCode::InvalidInput
        }
        MediaError::EmptyOutput(_) | MediaError::OutputExists(_) => JobFailureCode::Unknown,
        MediaError::ProcessFailed { .. }
        | MediaError::NativeFfmpeg(_)
        | MediaError::InvalidToolOutput(_)
        | MediaError::Json(_)
        | MediaError::OutputLimit { .. } => JobFailureCode::DependencyFailed,
    }
}
