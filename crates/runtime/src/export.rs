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
use vibe_cs_domain::{AppConfig, DomainError, ExportJob, JobStatus};
use vibe_cs_media::{
    EditorMediaKind, EditorMediaSource, EditorRenderOptions, EncoderSelection, FilterPlan,
    MediaError, MontageSource, ProcessCancellation, ProcessRunner, ProgressCallback,
    SystemProcessRunner, build_editor_plan_with_sources, build_montage_plan_with_sources,
    execute_filter_plan_with_progress, find_executable, inspect_ffmpeg, probe_media,
    select_video_encoder,
};
use vibe_cs_storage::ExportJobRecord;

const MEDIA_INSPECTION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

pub struct RuntimeExportPort {
    storage: vibe_cs_storage::Storage,
    data_dir: PathBuf,
    runner: Arc<dyn ProcessRunner>,
    active: Arc<Mutex<HashMap<Uuid, ProcessCancellation>>>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default, deny_unknown_fields)]
struct EditorExportRequest {
    encoder: Option<String>,
    quality: Option<u8>,
    range_start_seconds: Option<f64>,
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
        Self::with_runner(storage, data_dir, Arc::new(SystemProcessRunner::default()))
    }

    #[must_use]
    pub fn with_runner(
        storage: vibe_cs_storage::Storage,
        data_dir: PathBuf,
        runner: Arc<dyn ProcessRunner>,
    ) -> Self {
        Self {
            storage,
            data_dir,
            runner,
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
        if !matches!(kind, "montage" | "editor") {
            return Err(DomainError::InvalidInput(format!(
                "unsupported export kind: {kind}"
            )));
        }
        let config = self
            .storage
            .get_config()
            .await
            .map_err(|error| storage_error(&error))?
            .unwrap_or_default();
        let configured =
            (!config.ffmpeg_path.trim().is_empty()).then(|| Path::new(&config.ffmpeg_path));
        let ffmpeg = find_executable("ffmpeg", configured).map_err(map_media_error)?;
        let ffprobe = Self::resolve_ffprobe(&config);
        let export_dir = self.data_dir.join("exports");
        tokio::fs::create_dir_all(&export_dir)
            .await
            .map_err(|error| DomainError::Internal(error.to_string()))?;
        let id = Uuid::new_v4();
        let output = export_dir.join(format!("{kind}-{project_id}-{id}.mp4"));
        let plan = match kind {
            "montage" => {
                self.montage_plan(&ffmpeg, ffprobe.as_deref(), project_id, &output)
                    .await?
            }
            "editor" => {
                self.editor_plan(&ffmpeg, ffprobe.as_deref(), project_id, &output, request)
                    .await?
            }
            _ => unreachable!("validated kind"),
        };
        let now = Utc::now();
        let job = ExportJob {
            id,
            project_id,
            status: JobStatus::Running,
            progress: 0.0,
            output_path: output.to_string_lossy().into_owned(),
            error: None,
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

    async fn montage_plan(
        &self,
        ffmpeg: &Path,
        ffprobe: Option<&Path>,
        project_id: Uuid,
        output: &Path,
    ) -> Result<FilterPlan, DomainError> {
        let project = self
            .storage
            .get_montage_project(project_id)
            .await
            .map_err(|error| storage_error(&error))?
            .ok_or_else(|| DomainError::NotFound("montage project".to_owned()))?;
        let mut sources = HashMap::new();
        for clip in &project.clips {
            let source = self
                .storage
                .get_recorded_clip(clip.clip_id)
                .await
                .map_err(|error| storage_error(&error))?
                .ok_or_else(|| DomainError::NotFound(format!("recorded clip {}", clip.clip_id)))?;
            let path = PathBuf::from(source.path);
            let has_audio = self.probe_has_audio(ffprobe, &path).await.unwrap_or(true);
            let avatar_path = if let Some(avatar_id) = clip.avatar_asset_id {
                let avatar = self
                    .storage
                    .get_asset(avatar_id)
                    .await
                    .map_err(|error| storage_error(&error))?
                    .ok_or_else(|| DomainError::NotFound(format!("avatar asset {avatar_id}")))?;
                if !avatar.kind.starts_with("image/") && avatar.kind != "image" {
                    return Err(DomainError::InvalidInput(format!(
                        "avatar asset {avatar_id} is not an image"
                    )));
                }
                Some(PathBuf::from(avatar.path))
            } else {
                None
            };
            sources.insert(
                clip.clip_id.to_string(),
                MontageSource {
                    path,
                    duration_seconds: Some(source.duration_seconds),
                    has_audio,
                    avatar_path,
                },
            );
        }
        let encoder = self
            .select_encoder(ffmpeg, &project.settings.encoder)
            .await?;
        build_montage_plan_with_sources(ffmpeg, &project, &sources, output, &encoder)
            .map_err(map_media_error)
    }

    async fn editor_plan(
        &self,
        ffmpeg: &Path,
        ffprobe: Option<&Path>,
        project_id: Uuid,
        output: &Path,
        request: &Value,
    ) -> Result<FilterPlan, DomainError> {
        let project = self
            .storage
            .get_editor_project(project_id)
            .await
            .map_err(|error| storage_error(&error))?
            .ok_or_else(|| DomainError::NotFound("editor project".to_owned()))?;
        let mut assets = HashMap::new();
        let mut referenced_assets = project
            .tracks
            .iter()
            .flat_map(|track| &track.clips)
            .filter_map(|clip| clip.asset_id)
            .collect::<Vec<_>>();
        referenced_assets.extend(
            project
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
                EditorMediaKind::Video => {
                    self.probe_has_audio(ffprobe, &path).await.unwrap_or(true)
                }
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
        let request: EditorExportRequest = if request.is_null() {
            EditorExportRequest::default()
        } else {
            serde_json::from_value(request.clone()).map_err(|error| {
                DomainError::InvalidInput(format!("invalid export options: {error}"))
            })?
        };
        let encoder = self
            .select_encoder(ffmpeg, request.encoder.as_deref().unwrap_or("auto"))
            .await?;
        let options = EditorRenderOptions {
            encoder,
            quality: request.quality.unwrap_or(80),
            range_start: request.range_start_seconds,
            range_end: request.range_end_seconds,
        };
        build_editor_plan_with_sources(ffmpeg, &project, &assets, output, &options)
            .map_err(map_media_error)
    }

    fn resolve_ffprobe(config: &AppConfig) -> Option<PathBuf> {
        let configured =
            (!config.ffprobe_path.trim().is_empty()).then(|| Path::new(&config.ffprobe_path));
        find_executable("ffprobe", configured).ok()
    }

    async fn probe_has_audio(&self, ffprobe: Option<&Path>, path: &Path) -> Option<bool> {
        let ffprobe = ffprobe?;
        let cancellation = ProcessCancellation::default();
        let result = tokio::time::timeout(
            MEDIA_INSPECTION_TIMEOUT,
            probe_media(self.runner.as_ref(), ffprobe, path, &cancellation),
        )
        .await;
        if result.is_err() {
            cancellation.cancel();
        }
        result
            .ok()
            .and_then(Result::ok)
            .map(|probe| probe.streams.iter().any(|stream| stream.kind == "audio"))
    }

    async fn select_encoder(
        &self,
        ffmpeg: &Path,
        requested: &str,
    ) -> Result<EncoderSelection, DomainError> {
        let cancellation = ProcessCancellation::default();
        let inspection = tokio::time::timeout(
            MEDIA_INSPECTION_TIMEOUT,
            inspect_ffmpeg(self.runner.as_ref(), ffmpeg.to_path_buf(), &cancellation),
        )
        .await;
        if inspection.is_err() {
            cancellation.cancel();
        }
        let encoders = match inspection {
            Ok(Ok(info)) => info.encoders,
            Ok(Err(error)) => {
                tracing::warn!(%error, "unable to inspect FFmpeg encoders; using a safe selection");
                Vec::new()
            }
            Err(_) => {
                tracing::warn!("FFmpeg encoder inspection timed out; using a safe selection");
                Vec::new()
            }
        };
        select_video_encoder(requested, &encoders).map_err(map_media_error)
    }

    fn spawn_export(
        &self,
        mut record: ExportJobRecord,
        plan: FilterPlan,
        cancellation: ProcessCancellation,
    ) {
        let storage = self.storage.clone();
        let runner = Arc::clone(&self.runner);
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
            let result = execute_filter_plan_with_progress(
                runner.as_ref(),
                &plan,
                &cancellation,
                progress_callback,
            )
            .await;
            let persisted_progress = progress_task.await.unwrap_or(0.0);
            record.job.updated_at = Utc::now();
            record.job.progress = record.job.progress.max(persisted_progress);
            match (cancellation.is_cancelled(), result) {
                (true, _) | (false, Err(MediaError::Cancelled)) => {
                    record.job.status = JobStatus::Cancelled;
                    record.job.error = Some("export was cancelled".to_owned());
                }
                (false, Ok(())) => {
                    record.job.status = JobStatus::Completed;
                    record.job.progress = 1.0;
                    record.job.error = None;
                }
                (false, Err(error)) => {
                    record.job.status = JobStatus::Failed;
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
        | MediaError::UnsupportedWave(_)
        | MediaError::EmptyOutput(_)
        | MediaError::Io { .. }
        | MediaError::Json(_)) => DomainError::Internal(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use vibe_cs_domain::{
        AppConfig, EditorClip, EditorProject, EditorTrack, MontageClip, MontageProject,
        MontageSettings, RecordedClip, TrackKind, Transform,
    };

    #[derive(Debug)]
    struct FailingRunner;

    #[derive(Debug)]
    struct CancellationRunner;

    #[derive(Debug, Default)]
    struct ProgressRunner {
        reported: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }

    #[async_trait]
    impl ProcessRunner for FailingRunner {
        async fn run(
            &self,
            _command: &vibe_cs_media::CommandSpec,
            _cancellation: &ProcessCancellation,
        ) -> Result<vibe_cs_media::ProcessOutput, MediaError> {
            Err(MediaError::ProcessFailed {
                status: 1,
                message: "encoder failed".to_owned(),
            })
        }
    }

    #[async_trait]
    impl ProcessRunner for CancellationRunner {
        async fn run(
            &self,
            command: &vibe_cs_media::CommandSpec,
            cancellation: &ProcessCancellation,
        ) -> Result<vibe_cs_media::ProcessOutput, MediaError> {
            if command.args.iter().any(|argument| argument == "-version") {
                return Ok(vibe_cs_media::ProcessOutput {
                    stdout: b"ffmpeg version 7.1\n".to_vec(),
                    ..vibe_cs_media::ProcessOutput::default()
                });
            }
            if command.args.iter().any(|argument| argument == "-encoders") {
                return Ok(vibe_cs_media::ProcessOutput {
                    stdout: b" V..... libx264 H.264\n".to_vec(),
                    ..vibe_cs_media::ProcessOutput::default()
                });
            }
            if command.args.iter().any(|argument| argument == "json") {
                return Ok(vibe_cs_media::ProcessOutput {
                    stdout: br#"{"streams":[{"index":0,"codec_type":"video","codec_name":"h264"},{"index":1,"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"1","size":"5"}}"#.to_vec(),
                    ..vibe_cs_media::ProcessOutput::default()
                });
            }
            if cancellation.is_cancelled() {
                return Err(MediaError::Cancelled);
            }
            cancellation.cancelled().await;
            Err(MediaError::Cancelled)
        }
    }

    #[async_trait]
    impl ProcessRunner for ProgressRunner {
        async fn run(
            &self,
            command: &vibe_cs_media::CommandSpec,
            _cancellation: &ProcessCancellation,
        ) -> Result<vibe_cs_media::ProcessOutput, MediaError> {
            if command.args.iter().any(|argument| argument == "-version") {
                return Ok(vibe_cs_media::ProcessOutput {
                    stdout: b"ffmpeg version 7.1\n".to_vec(),
                    ..vibe_cs_media::ProcessOutput::default()
                });
            }
            if command.args.iter().any(|argument| argument == "-encoders") {
                return Ok(vibe_cs_media::ProcessOutput {
                    stdout: b" V..... libx264 H.264\n".to_vec(),
                    ..vibe_cs_media::ProcessOutput::default()
                });
            }
            if command.args.iter().any(|argument| argument == "json") {
                return Ok(vibe_cs_media::ProcessOutput {
                    stdout: br#"{"streams":[{"index":0,"codec_type":"video","codec_name":"h264"},{"index":1,"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"1","size":"5"}}"#.to_vec(),
                    ..vibe_cs_media::ProcessOutput::default()
                });
            }
            Ok(vibe_cs_media::ProcessOutput::default())
        }

        async fn run_with_progress(
            &self,
            command: &vibe_cs_media::CommandSpec,
            cancellation: &ProcessCancellation,
            progress: vibe_cs_media::ProgressCallback,
        ) -> Result<vibe_cs_media::ProcessOutput, MediaError> {
            if !command.args.iter().any(|argument| argument == "-progress") {
                return self.run(command, cancellation).await;
            }
            progress(vibe_cs_media::FfmpegProgress {
                out_time_seconds: 0.5,
                completed: false,
            });
            self.reported.notify_one();
            tokio::select! {
                () = self.release.notified() => {}
                () = cancellation.cancelled() => return Err(MediaError::Cancelled),
            }
            let output = command.args.last().expect("temporary output");
            tokio::fs::write(Path::new(output), b"video")
                .await
                .map_err(|source| MediaError::Io {
                    path: PathBuf::from(output),
                    source,
                })?;
            Ok(vibe_cs_media::ProcessOutput::default())
        }
    }

    async fn montage_fixture(
        runner: Arc<dyn ProcessRunner>,
    ) -> (
        tempfile::TempDir,
        vibe_cs_storage::Storage,
        RuntimeExportPort,
        Uuid,
    ) {
        let root = tempfile::tempdir().expect("temporary directory");
        let ffmpeg = root.path().join("ffmpeg.exe");
        let source = root.path().join("source.mp4");
        tokio::fs::write(&ffmpeg, b"stub")
            .await
            .expect("ffmpeg stub");
        tokio::fs::write(&source, b"video").await.expect("source");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        storage
            .put_config(AppConfig {
                ffmpeg_path: ffmpeg.to_string_lossy().into_owned(),
                ..AppConfig::default()
            })
            .await
            .expect("config");
        let now = Utc::now();
        let clip_id = Uuid::new_v4();
        storage
            .put_recorded_clip(RecordedClip {
                id: clip_id,
                path: source.to_string_lossy().into_owned(),
                title: "Source".to_owned(),
                duration_seconds: 1.0,
                demo_id: None,
                player_name: None,
                category: "test".to_owned(),
                tags: Vec::new(),
                metadata: Value::Null,
                created_at: now,
            })
            .await
            .expect("clip");
        let project_id = Uuid::new_v4();
        storage
            .put_montage_project(MontageProject {
                id: project_id,
                name: "Export".to_owned(),
                clips: vec![MontageClip {
                    clip_id,
                    order: 0,
                    trim_start: 0.0,
                    trim_end: Some(1.0),
                    transition: "cut".to_owned(),
                    title: None,
                    avatar_asset_id: None,
                }],
                settings: MontageSettings::default(),
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("project");
        let port =
            RuntimeExportPort::with_runner(storage.clone(), root.path().to_path_buf(), runner);
        (root, storage, port, project_id)
    }

    #[tokio::test]
    async fn cancellation_persists_cancelling_then_cancelled() {
        let (_root, storage, port, project_id) =
            montage_fixture(Arc::new(CancellationRunner)).await;
        let running = port
            .start("montage", project_id, Value::Null)
            .await
            .expect("start");
        assert_eq!(running.status, JobStatus::Running);

        let cancelling = port.cancel(running.id).await.expect("cancel");
        assert_eq!(cancelling.status, JobStatus::Cancelling);
        for _ in 0..100 {
            let job = storage
                .get_export_job(running.id)
                .await
                .expect("storage")
                .expect("job")
                .job;
            if job.status == JobStatus::Cancelled {
                assert!(
                    job.error
                        .as_deref()
                        .is_some_and(|error| error.contains("cancelled"))
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("cancelled export did not reach a terminal state");
    }

    #[tokio::test]
    async fn machine_progress_is_persisted_before_export_completion() {
        let runner = Arc::new(ProgressRunner::default());
        let (_root, storage, port, project_id) =
            montage_fixture(runner.clone() as Arc<dyn ProcessRunner>).await;
        let running = port
            .start("montage", project_id, Value::Null)
            .await
            .expect("start");
        tokio::time::timeout(Duration::from_secs(1), runner.reported.notified())
            .await
            .expect("progress callback");
        for _ in 0..100 {
            let job = storage
                .get_export_job(running.id)
                .await
                .expect("storage")
                .expect("job")
                .job;
            if job.progress >= 0.49 {
                assert_eq!(job.status, JobStatus::Running);
                runner.release.notify_one();
                for _ in 0..100 {
                    let completed = storage
                        .get_export_job(running.id)
                        .await
                        .expect("storage")
                        .expect("job")
                        .job;
                    if completed.status == JobStatus::Completed {
                        assert!((completed.progress - 1.0).abs() < f64::EPSILON);
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                panic!("export did not complete after releasing the runner");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("machine progress was not persisted while the process was active");
    }

    #[tokio::test]
    async fn restart_recovery_terminalizes_orphaned_exports() {
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let now = Utc::now();
        let running_id = Uuid::new_v4();
        let cancelling_id = Uuid::new_v4();
        for (id, status) in [
            (running_id, JobStatus::Running),
            (cancelling_id, JobStatus::Cancelling),
        ] {
            storage
                .put_export_job(ExportJobRecord {
                    kind: "editor".to_owned(),
                    job: ExportJob {
                        id,
                        project_id: Uuid::new_v4(),
                        status,
                        progress: 0.5,
                        output_path: String::new(),
                        error: None,
                        created_at: now,
                        updated_at: now,
                    },
                })
                .await
                .expect("job");
        }
        let directory = tempfile::tempdir().expect("temporary directory");
        RuntimeExportPort::new(storage.clone(), directory.path().to_path_buf())
            .recover_orphaned_jobs()
            .await;

        assert_eq!(
            storage
                .get_export_job(running_id)
                .await
                .expect("storage")
                .expect("job")
                .job
                .status,
            JobStatus::Failed
        );
        assert_eq!(
            storage
                .get_export_job(cancelling_id)
                .await
                .expect("storage")
                .expect("job")
                .job
                .status,
            JobStatus::Cancelled
        );
    }

    #[tokio::test]
    async fn missing_ffmpeg_is_an_explicit_dependency_error() {
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        storage
            .put_config(AppConfig {
                ffmpeg_path: "Z:/definitely-missing/ffmpeg.exe".to_owned(),
                ..AppConfig::default()
            })
            .await
            .expect("config");
        let root = tempfile::tempdir().expect("temporary directory");
        let port = RuntimeExportPort::new(storage, root.path().to_path_buf());
        let error = port
            .start("montage", Uuid::new_v4(), Value::Null)
            .await
            .expect_err("missing ffmpeg must fail before a process starts");
        assert!(matches!(error, DomainError::DependencyUnavailable(_)));
    }

    #[tokio::test]
    async fn background_export_failure_is_persisted() {
        let root = tempfile::tempdir().expect("temporary directory");
        let ffmpeg = root.path().join("ffmpeg.exe");
        let source = root.path().join("source.mp4");
        tokio::fs::write(&ffmpeg, b"stub")
            .await
            .expect("ffmpeg stub");
        tokio::fs::write(&source, b"video").await.expect("source");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        storage
            .put_config(AppConfig {
                ffmpeg_path: ffmpeg.to_string_lossy().into_owned(),
                ..AppConfig::default()
            })
            .await
            .expect("config");
        let now = Utc::now();
        let clip_id = Uuid::new_v4();
        storage
            .put_recorded_clip(RecordedClip {
                id: clip_id,
                path: source.to_string_lossy().into_owned(),
                title: "Source".to_owned(),
                duration_seconds: 1.0,
                demo_id: None,
                player_name: None,
                category: "test".to_owned(),
                tags: Vec::new(),
                metadata: Value::Null,
                created_at: now,
            })
            .await
            .expect("clip");
        let project_id = Uuid::new_v4();
        storage
            .put_montage_project(MontageProject {
                id: project_id,
                name: "Export".to_owned(),
                clips: vec![MontageClip {
                    clip_id,
                    order: 0,
                    trim_start: 0.0,
                    trim_end: Some(1.0),
                    transition: "cut".to_owned(),
                    title: None,
                    avatar_asset_id: None,
                }],
                settings: MontageSettings::default(),
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("project");
        let port = RuntimeExportPort::with_runner(
            storage.clone(),
            root.path().to_path_buf(),
            Arc::new(FailingRunner),
        );
        let running = port
            .start("montage", project_id, Value::Null)
            .await
            .expect("start export");
        assert_eq!(running.status, JobStatus::Running);

        for _ in 0..100 {
            let record = storage
                .get_export_job(running.id)
                .await
                .expect("read job")
                .expect("job exists");
            if record.job.status == JobStatus::Failed {
                assert!(
                    record
                        .job
                        .error
                        .as_deref()
                        .is_some_and(|error| error.contains("encoder failed"))
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("export failure was not persisted");
    }

    #[tokio::test]
    async fn editor_accepts_a_recorded_clip_as_a_media_source() {
        let root = tempfile::tempdir().expect("temporary directory");
        let ffmpeg = root.path().join("ffmpeg.exe");
        let source = root.path().join("recorded.mp4");
        tokio::fs::write(&ffmpeg, b"stub")
            .await
            .expect("ffmpeg stub");
        tokio::fs::write(&source, b"video").await.expect("source");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        storage
            .put_config(AppConfig {
                ffmpeg_path: ffmpeg.to_string_lossy().into_owned(),
                ..AppConfig::default()
            })
            .await
            .expect("config");
        let now = Utc::now();
        let clip_id = Uuid::new_v4();
        storage
            .put_recorded_clip(RecordedClip {
                id: clip_id,
                path: source.to_string_lossy().into_owned(),
                title: "Recorded source".to_owned(),
                duration_seconds: 1.0,
                demo_id: None,
                player_name: None,
                category: "test".to_owned(),
                tags: Vec::new(),
                metadata: Value::Null,
                created_at: now,
            })
            .await
            .expect("clip");
        let project_id = Uuid::new_v4();
        storage
            .put_editor_project(EditorProject {
                id: project_id,
                name: "Editor export".to_owned(),
                width: 1920,
                height: 1080,
                fps: 60,
                duration_seconds: 1.0,
                tracks: vec![EditorTrack {
                    id: Uuid::new_v4(),
                    name: "Video".to_owned(),
                    kind: TrackKind::Video,
                    order: 0,
                    muted: false,
                    locked: false,
                    hidden: false,
                    clips: vec![EditorClip {
                        id: Uuid::new_v4(),
                        asset_id: Some(clip_id),
                        name: "Recorded source".to_owned(),
                        start: 0.0,
                        duration: 1.0,
                        source_in: 0.0,
                        source_out: 1.0,
                        speed: 1.0,
                        volume: 1.0,
                        transform: Transform::default(),
                        effects: Vec::new(),
                        transition_in: None,
                        transition_out: None,
                        text: None,
                        metadata: Value::Null,
                        group_id: None,
                        link_group_id: None,
                        keyframes: Vec::new(),
                        speed_segments: Vec::new(),
                    }],
                }],
                markers: Vec::new(),
                settings: Value::Null,
                revision: 1,
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("project");
        let port = RuntimeExportPort::with_runner(
            storage,
            root.path().to_path_buf(),
            Arc::new(FailingRunner),
        );

        let job = port
            .start("editor", project_id, Value::Null)
            .await
            .expect("recorded clip resolves as an editor source");
        assert_eq!(job.status, JobStatus::Running);
    }
}
