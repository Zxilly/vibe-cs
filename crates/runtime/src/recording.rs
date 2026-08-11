use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use chrono::Utc;
use serde_json::json;
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;
use vibe_cs_api::RecordingPort;
use vibe_cs_domain::{
    AppConfig, DemoRecord, DomainError, EventKind, Highlight, HighlightKind, JobStatus,
    MatchAnalysis, RecordedClip, RecordingInputBus, RecordingInputEvent, RecordingJob,
    RecordingRequest, TimelineEvent,
};
use vibe_cs_integrations::{
    GsiState, IntegrationError, ObsClient, ObsRealtimeMediaInput, ObsTransport, ObsTransportLimits,
    SecretString, WebSocketObsTransport, discover_paths,
};
use vibe_cs_media::{
    MediaError, SingleInputTranscodeOptions, SystemProcessRunner as MediaProcessRunner,
    TimedTextOverlay, build_single_input_transcode_plan, execute_filter_plan_with_progress,
    find_executable, inspect_ffmpeg, probe_media, select_video_encoder,
};
use vibe_cs_platform_windows::{
    BackupManager, DesktopBackend, FirstPersonHudInstaller, PlatformError,
    ProcessCancellation as PlatformRecordingCancellation, SystemDesktopBackend,
    SystemProcessRunner as PlatformProcessRunner,
};
use vibe_cs_recording::{
    CommandAcknowledgedPlaybackSynchronizer, CommandEvidenceGameController, CommandEvidenceStore,
    EngineConfig, GsiStateSnapshotSource, PlatformGameController, RecordingEngine, RecordingError,
    SegmentPlan,
};
use vibe_cs_storage::Storage;

pub type RecordingCancellation = vibe_cs_media::ProcessCancellation;

#[derive(Debug, Clone)]
pub struct PreparedRecording {
    pub request: RecordingRequest,
    pub demo: DemoRecord,
    pub segment: SegmentPlan,
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
    ) -> Result<RecordedClip, DomainError>;

    async fn begin_job(
        &self,
        _config: &AppConfig,
        _items: &[PreparedRecording],
    ) -> Result<(), DomainError> {
        Ok(())
    }

    async fn finish_job(&self, _config: &AppConfig) -> Result<(), DomainError> {
        Ok(())
    }
}

type SystemGameController = CommandEvidenceGameController<
    PlatformGameController<SystemDesktopBackend, PlatformProcessRunner>,
>;
type SystemPlaybackSynchronizer = CommandAcknowledgedPlaybackSynchronizer<GsiStateSnapshotSource>;
type SystemEngine = RecordingEngine<
    SystemGameController,
    ObsClient<WebSocketObsTransport>,
    SystemPlaybackSynchronizer,
    BackupManager,
>;

/// Real system adapter for deterministic demo playback and OBS capture.
#[derive(Clone)]
pub struct SystemRecordingBackend {
    data_dir: PathBuf,
    gsi: Arc<RwLock<GsiState>>,
    hud_session: Arc<Mutex<Option<FirstPersonHudInstaller>>>,
}

impl std::fmt::Debug for SystemRecordingBackend {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SystemRecordingBackend")
            .field("data_dir", &self.data_dir)
            .field("shared_gsi_state", &true)
            .finish_non_exhaustive()
    }
}

impl SystemRecordingBackend {
    #[must_use]
    pub fn new(data_dir: PathBuf, gsi: Arc<RwLock<GsiState>>) -> Self {
        Self {
            data_dir,
            gsi,
            hud_session: Arc::new(Mutex::new(None)),
        }
    }

    async fn build_engine(&self, config: &AppConfig) -> Result<SystemEngine, DomainError> {
        validate_system_configuration(config)?;
        self.ensure_runtime_recovery_is_clean().await?;

        let executable = discover_paths(config).cs2.ok_or_else(|| {
            DomainError::DependencyUnavailable("CS2 executable was not found".to_owned())
        })?;
        let executable = std::path::absolute(executable).map_err(|error| {
            io_dependency_error("resolve the configured CS2 executable", &error)
        })?;
        let output_directory = self.managed_directory("recordings").await?;
        let recovery_directory = self.managed_directory("recovery").await?;
        let recovery = BackupManager::new(recovery_directory).map_err(platform_error)?;

        let password = SecretString::new(config.obs.password.clone());
        let obs = ObsClient::connect_websocket(
            config.obs.host.trim(),
            config.obs.port,
            &password,
            ObsTransportLimits::default(),
        )
        .await
        .map_err(integration_error)?;

        let evidence = CommandEvidenceStore::default();
        let game = CommandEvidenceGameController::new(
            PlatformGameController::new(SystemDesktopBackend, PlatformProcessRunner),
            evidence.clone(),
        );
        let source =
            GsiStateSnapshotSource::new(Arc::clone(&self.gsi), chrono::Duration::seconds(3));
        let synchronizer = CommandAcknowledgedPlaybackSynchronizer::new(evidence, source)
            .with_limits(Duration::from_millis(50), Duration::from_secs(3))
            .map_err(recording_error)?;
        let engine_config = EngineConfig::new(executable, output_directory);
        Ok(RecordingEngine::new(
            engine_config,
            game,
            obs,
            synchronizer,
            recovery,
        ))
    }

    async fn managed_directory(&self, name: &str) -> Result<PathBuf, DomainError> {
        let directory = self.data_dir.join(name);
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(|error| io_dependency_error("create managed directory", &error))?;
        tokio::fs::canonicalize(&directory)
            .await
            .map_err(|error| io_dependency_error("resolve managed directory", &error))
    }

    async fn first_person_hud_installer(
        &self,
        config: &AppConfig,
    ) -> Result<Option<FirstPersonHudInstaller>, DomainError> {
        let source = config.recording.first_person_hud_assets.trim();
        if source.is_empty() {
            return Ok(None);
        }
        let executable = discover_paths(config).cs2.ok_or_else(|| {
            DomainError::DependencyUnavailable("CS2 executable was not found".to_owned())
        })?;
        let game_directory = executable
            .ancestors()
            .find(|path| {
                path.file_name()
                    .is_some_and(|name| name.eq_ignore_ascii_case("game"))
            })
            .ok_or_else(|| {
                DomainError::InvalidInput(
                    "CS2 executable is outside a recognizable game directory".to_owned(),
                )
            })?;
        let target = game_directory.join("csgo/custom/vibe_cs_hud");
        let recovery = self.managed_directory("recovery/hud").await?;
        FirstPersonHudInstaller::new(PathBuf::from(source), target, recovery)
            .map(Some)
            .map_err(platform_error)
    }

    fn ensure_hud_can_load_before_launch(config: &AppConfig) -> Result<(), DomainError> {
        if config.recording.first_person_hud_assets.trim().is_empty() {
            return Ok(());
        }
        let running = SystemDesktopBackend
            .discover_processes("cs2.exe")
            .map_err(platform_error)?;
        if running.is_empty() {
            Ok(())
        } else {
            Err(DomainError::Conflict(
                "first-person HUD assets require the game to be closed so the managed launch can load and later restore them"
                    .to_owned(),
            ))
        }
    }

    async fn configured_scene(
        engine: &mut SystemEngine,
        config: &AppConfig,
    ) -> Result<Option<String>, DomainError> {
        let requested = config.obs.scene.trim();
        if requested.is_empty() {
            return Ok(None);
        }
        let status = engine
            .recorder_mut()
            .scene_status()
            .await
            .map_err(integration_error)?;
        if !status.scenes.iter().any(|scene| scene == requested) {
            return Err(DomainError::DependencyUnavailable(format!(
                "configured OBS scene {requested:?} does not exist"
            )));
        }
        Ok(Some(status.current_program_scene))
    }

    async fn activate_configured_scene(
        engine: &mut SystemEngine,
        config: &AppConfig,
    ) -> Result<Option<String>, DomainError> {
        let Some(previous) = Self::configured_scene(engine, config).await? else {
            return Ok(None);
        };
        let requested = config.obs.scene.trim();
        if previous == requested {
            return Ok(None);
        }
        if let Err(error) = engine
            .recorder_mut()
            .set_current_program_scene(requested)
            .await
        {
            let primary = integration_error(error);
            let cleanup = Self::restore_obs_scene(engine, Some(&previous)).await;
            return Err(scene_activation_error(primary, cleanup));
        }
        let confirmed = match engine.recorder_mut().scene_status().await {
            Ok(confirmed) => confirmed,
            Err(error) => {
                let primary = integration_error(error);
                let cleanup = Self::restore_obs_scene(engine, Some(&previous)).await;
                return Err(scene_activation_error(primary, cleanup));
            }
        };
        if confirmed.current_program_scene != requested {
            let primary = DomainError::Conflict(format!(
                "OBS did not switch to configured scene {requested:?}"
            ));
            let cleanup = Self::restore_obs_scene(engine, Some(&previous)).await;
            return Err(scene_activation_error(primary, cleanup));
        }
        Ok(Some(previous))
    }

    async fn restore_obs_scene(
        engine: &mut SystemEngine,
        previous: Option<&str>,
    ) -> Result<(), DomainError> {
        let Some(previous) = previous else {
            return Ok(());
        };
        engine
            .recorder_mut()
            .set_current_program_scene(previous)
            .await
            .map_err(integration_error)?;
        let confirmed = engine
            .recorder_mut()
            .scene_status()
            .await
            .map_err(integration_error)?;
        if confirmed.current_program_scene != previous {
            return Err(DomainError::Conflict(format!(
                "OBS did not restore the previous scene {previous:?}"
            )));
        }
        Ok(())
    }

    async fn activate_realtime_overlays(
        engine: &mut SystemEngine,
        config: &AppConfig,
        item: &PreparedRecording,
        cues: &[RealtimeOverlayCue],
    ) -> Result<RealtimeOverlaySession, DomainError> {
        let kill_path = config.recording.obs_realtime_kill_fx_media.trim();
        let keyboard_path = config.recording.obs_realtime_keyboard_media.trim();
        let has_kill_cue = has_realtime_kill_cue(cues);
        if (!has_kill_cue || kill_path.is_empty()) && !item.request.show_keyboard {
            return Ok(RealtimeOverlaySession::default());
        }
        let scene = engine
            .recorder_mut()
            .scene_status()
            .await
            .map_err(integration_error)?
            .current_program_scene;
        let mut session = RealtimeOverlaySession {
            scene,
            inputs: Vec::new(),
            kill: None,
            keyboard_text: None,
            keyboard_background: None,
        };
        let prefix = format!("VibeCS-{}", Uuid::new_v4().simple());
        if has_kill_cue && !kill_path.is_empty() {
            let input_name = format!("{prefix}-kill-fx");
            let scene_item_id = match engine
                .recorder_mut()
                .create_realtime_media_input(ObsRealtimeMediaInput {
                    scene: session.scene.clone(),
                    input_name: input_name.clone(),
                    media_path: PathBuf::from(kill_path),
                    loop_media: false,
                })
                .await
            {
                Ok(id) => id,
                Err(error) => {
                    let cleanup = session.cleanup(engine).await;
                    return Err(scene_activation_error(integration_error(error), cleanup));
                }
            };
            session.inputs.push(input_name.clone());
            session.kill = Some(RealtimeSceneInput {
                name: input_name,
                scene_item_id,
            });
        }
        if item.request.show_keyboard {
            let input_name = format!("{prefix}-keyboard-state");
            let scene_item_id = match engine
                .recorder_mut()
                .create_realtime_text_input(&session.scene, &input_name)
                .await
            {
                Ok(id) => id,
                Err(error) => {
                    let cleanup = session.cleanup(engine).await;
                    return Err(scene_activation_error(integration_error(error), cleanup));
                }
            };
            session.inputs.push(input_name.clone());
            session.keyboard_text = Some(RealtimeSceneInput {
                name: input_name,
                scene_item_id,
            });
            if !keyboard_path.is_empty() {
                let input_name = format!("{prefix}-keyboard-background");
                let scene_item_id = match engine
                    .recorder_mut()
                    .create_realtime_media_input(ObsRealtimeMediaInput {
                        scene: session.scene.clone(),
                        input_name: input_name.clone(),
                        media_path: PathBuf::from(keyboard_path),
                        loop_media: true,
                    })
                    .await
                {
                    Ok(id) => id,
                    Err(error) => {
                        let cleanup = session.cleanup(engine).await;
                        return Err(scene_activation_error(integration_error(error), cleanup));
                    }
                };
                session.inputs.push(input_name.clone());
                session.keyboard_background = Some(RealtimeSceneInput {
                    name: input_name,
                    scene_item_id,
                });
            }
        }
        Ok(session)
    }

    async fn connect_realtime_overlay_driver(
        config: &AppConfig,
        session: &RealtimeOverlaySession,
    ) -> Result<Option<ObsClient<WebSocketObsTransport>>, DomainError> {
        if session.inputs.is_empty() {
            return Ok(None);
        }
        let password = SecretString::new(config.obs.password.clone());
        ObsClient::connect_websocket(
            config.obs.host.trim(),
            config.obs.port,
            &password,
            ObsTransportLimits::default(),
        )
        .await
        .map(Some)
        .map_err(integration_error)
    }

    async fn drive_realtime_overlays<T: ObsTransport>(
        client: &mut ObsClient<T>,
        session: &RealtimeOverlaySession,
        cues: &[RealtimeOverlayCue],
        cancellation: &RecordingCancellation,
        stop: &RecordingCancellation,
    ) -> Result<(), DomainError> {
        let started_deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            if cancellation.is_cancelled() || stop.is_cancelled() {
                return Self::disable_realtime_overlays(client, session).await;
            }
            if client
                .record_status()
                .await
                .map_err(integration_error)?
                .active
            {
                break;
            }
            if tokio::time::Instant::now() >= started_deadline {
                return Err(DomainError::DependencyUnavailable(
                    "OBS recording did not become active before the realtime overlay deadline"
                        .to_owned(),
                ));
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }

        let started = tokio::time::Instant::now();
        let mut result = Ok(());
        for cue in cues {
            let deadline = started + cue.at;
            loop {
                if cancellation.is_cancelled() || stop.is_cancelled() {
                    break;
                }
                let now = tokio::time::Instant::now();
                if now >= deadline {
                    break;
                }
                tokio::time::sleep((deadline - now).min(Duration::from_millis(25))).await;
            }
            if cancellation.is_cancelled() || stop.is_cancelled() {
                break;
            }
            if let Err(error) = Self::apply_realtime_cue(client, session, cue).await {
                result = Err(error);
                break;
            }
        }
        let disabled = Self::disable_realtime_overlays(client, session).await;
        match (result, disabled) {
            (Ok(()), disabled) => disabled,
            (Err(primary), Ok(())) => Err(primary),
            (Err(primary), Err(cleanup)) => Err(DomainError::Internal(format!(
                "{primary}; additionally failed to disable realtime OBS inputs: {cleanup}"
            ))),
        }
    }

    async fn apply_realtime_cue<T: ObsTransport>(
        client: &mut ObsClient<T>,
        session: &RealtimeOverlaySession,
        cue: &RealtimeOverlayCue,
    ) -> Result<(), DomainError> {
        match &cue.action {
            RealtimeOverlayAction::ShowKill => {
                if let Some(input) = &session.kill {
                    client
                        .set_realtime_media_enabled(&session.scene, input.scene_item_id, true)
                        .await
                        .map_err(integration_error)?;
                    client
                        .restart_realtime_media(&input.name)
                        .await
                        .map_err(integration_error)?;
                }
            }
            RealtimeOverlayAction::HideKill => {
                if let Some(input) = &session.kill {
                    client
                        .set_realtime_media_enabled(&session.scene, input.scene_item_id, false)
                        .await
                        .map_err(integration_error)?;
                }
            }
            RealtimeOverlayAction::Keyboard(text) => {
                if let Some(input) = &session.keyboard_text {
                    client
                        .set_realtime_text(&input.name, text)
                        .await
                        .map_err(integration_error)?;
                    client
                        .set_realtime_media_enabled(&session.scene, input.scene_item_id, true)
                        .await
                        .map_err(integration_error)?;
                }
                if let Some(input) = &session.keyboard_background {
                    client
                        .set_realtime_media_enabled(&session.scene, input.scene_item_id, true)
                        .await
                        .map_err(integration_error)?;
                }
            }
            RealtimeOverlayAction::Finish => {}
        }
        Ok(())
    }

    async fn disable_realtime_overlays<T: ObsTransport>(
        client: &mut ObsClient<T>,
        session: &RealtimeOverlaySession,
    ) -> Result<(), DomainError> {
        let mut errors = Vec::new();
        for input in [
            session.kill.as_ref(),
            session.keyboard_text.as_ref(),
            session.keyboard_background.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            if let Err(error) = client
                .set_realtime_media_enabled(&session.scene, input.scene_item_id, false)
                .await
            {
                errors.push(integration_error(error).to_string());
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(DomainError::Internal(errors.join("; ")))
        }
    }

    async fn ensure_runtime_recovery_is_clean(&self) -> Result<(), DomainError> {
        let marker = self.data_dir.join("recovery/config-backup.json");
        match tokio::fs::symlink_metadata(&marker).await {
            Ok(_) => Err(DomainError::Conflict(
                "configuration recovery is pending and must be resolved before recording"
                    .to_owned(),
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(io_dependency_error("inspect recovery marker", &error)),
        }
    }

    async fn remove_unpublished_output(&self, item: &PreparedRecording) {
        let path = self
            .data_dir
            .join("recordings")
            .join(&item.segment.output_file_name);
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {
                tracing::info!(path = %path.display(), "removed unpublished recording output");
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "unable to remove unpublished recording output");
            }
        }
    }

    async fn postprocess_clip(
        &self,
        config: &AppConfig,
        item: &PreparedRecording,
        mut clip: RecordedClip,
        cancellation: &RecordingCancellation,
    ) -> Result<RecordedClip, DomainError> {
        let configured =
            (!config.ffmpeg_path.trim().is_empty()).then(|| Path::new(config.ffmpeg_path.trim()));
        let ffmpeg = find_executable("ffmpeg", configured).map_err(media_error)?;
        let source = PathBuf::from(&clip.path);
        let stem = source
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                DomainError::Internal("recording output has no valid stem".to_owned())
            })?;
        let rendered = source.with_file_name(format!("{stem}-rendered.mp4"));
        let (width, height) = parse_recording_resolution(&config.recording.resolution)?;
        let overlays = build_recording_overlays(item, width, height, clip.duration_seconds);
        let fade_seconds = if item.request.fade {
            config
                .recording
                .transition_seconds
                .clamp(0.0, clip.duration_seconds / 2.0)
        } else {
            0.0
        };
        let runner = MediaProcessRunner::default();
        let has_audio = self
            .recording_has_audio(config, &runner, &source, cancellation)
            .await?;
        let encoder = self
            .recording_encoder(config, &runner, &ffmpeg, cancellation)
            .await?;
        let options = SingleInputTranscodeOptions {
            duration_seconds: clip.duration_seconds,
            width,
            height,
            fps: config.recording.fps,
            has_audio,
            fade_in_seconds: fade_seconds,
            fade_out_seconds: fade_seconds,
            overlays,
            encoder,
            quality: 80,
        };
        let plan = build_single_input_transcode_plan(&ffmpeg, &source, &rendered, &options)
            .map_err(media_error)?;
        execute_filter_plan_with_progress(&runner, &plan, cancellation, Arc::new(|_| {}))
            .await
            .map_err(media_error)?;
        if cancellation.is_cancelled() {
            let _ = tokio::fs::remove_file(&rendered).await;
            return Err(DomainError::Conflict("recording was cancelled".to_owned()));
        }
        if let Err(error) = tokio::fs::remove_file(&source).await {
            let _ = tokio::fs::remove_file(&rendered).await;
            return Err(DomainError::Internal(format!(
                "unable to retire the unprocessed recording: {error}"
            )));
        }
        clip.path = rendered.to_string_lossy().into_owned();
        promote_render_metadata(&mut clip, item, &options);
        Ok(clip)
    }

    async fn recording_has_audio(
        &self,
        config: &AppConfig,
        runner: &MediaProcessRunner,
        source: &Path,
        cancellation: &RecordingCancellation,
    ) -> Result<bool, DomainError> {
        let configured =
            (!config.ffprobe_path.trim().is_empty()).then(|| Path::new(config.ffprobe_path.trim()));
        let Ok(ffprobe) = find_executable("ffprobe", configured) else {
            return Ok(true);
        };
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            probe_media(runner, &ffprobe, source, cancellation),
        )
        .await;
        match result {
            Ok(Ok(probe)) => Ok(probe.streams.iter().any(|stream| stream.kind == "audio")),
            Ok(Err(MediaError::Cancelled)) => {
                Err(DomainError::Conflict("recording was cancelled".to_owned()))
            }
            Ok(Err(error)) => {
                tracing::warn!(%error, "unable to inspect OBS audio stream; preserving audio mapping");
                Ok(true)
            }
            Err(_) => {
                tracing::warn!("timed out inspecting OBS audio stream; preserving audio mapping");
                Ok(true)
            }
        }
    }

    async fn recording_encoder(
        &self,
        config: &AppConfig,
        runner: &MediaProcessRunner,
        ffmpeg: &Path,
        cancellation: &RecordingCancellation,
    ) -> Result<vibe_cs_media::EncoderSelection, DomainError> {
        let inspection = tokio::time::timeout(
            Duration::from_secs(10),
            inspect_ffmpeg(runner, ffmpeg.to_path_buf(), cancellation),
        )
        .await;
        let encoders = match inspection {
            Ok(Ok(info)) => info.encoders,
            Ok(Err(MediaError::Cancelled)) => {
                return Err(DomainError::Conflict("recording was cancelled".to_owned()));
            }
            Ok(Err(error)) => {
                tracing::warn!(%error, "unable to inspect recording encoders; retaining software fallback");
                Vec::new()
            }
            Err(_) => {
                tracing::warn!(
                    "timed out inspecting recording encoders; retaining software fallback"
                );
                Vec::new()
            }
        };
        select_video_encoder(&config.preferred_encoder, &encoders).map_err(media_error)
    }
}

#[derive(Debug, Clone)]
struct RealtimeSceneInput {
    name: String,
    scene_item_id: i64,
}

#[derive(Debug, Clone, Default)]
struct RealtimeOverlaySession {
    scene: String,
    inputs: Vec<String>,
    kill: Option<RealtimeSceneInput>,
    keyboard_text: Option<RealtimeSceneInput>,
    keyboard_background: Option<RealtimeSceneInput>,
}

impl RealtimeOverlaySession {
    async fn cleanup(&mut self, engine: &mut SystemEngine) -> Result<(), DomainError> {
        let mut errors = Vec::new();
        for name in self.inputs.drain(..).rev() {
            if let Err(error) = engine
                .recorder_mut()
                .remove_realtime_media_input(&name)
                .await
            {
                errors.push(integration_error(error).to_string());
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(DomainError::Internal(format!(
                "unable to remove OBS realtime inputs: {}",
                errors.join("; ")
            )))
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct RealtimeOverlayCue {
    at: Duration,
    action: RealtimeOverlayAction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RealtimeOverlayAction {
    ShowKill,
    HideKill,
    Keyboard(String),
    Finish,
}

fn scene_activation_error(primary: DomainError, cleanup: Result<(), DomainError>) -> DomainError {
    match cleanup {
        Ok(()) => primary,
        Err(cleanup) => DomainError::Internal(format!(
            "{primary}; additionally failed to restore the previous OBS scene: {cleanup}"
        )),
    }
}

#[async_trait]
impl RecordingBackend for SystemRecordingBackend {
    async fn begin_job(
        &self,
        config: &AppConfig,
        _items: &[PreparedRecording],
    ) -> Result<(), DomainError> {
        Self::ensure_hud_can_load_before_launch(config)?;
        let Some(installer) = self.first_person_hud_installer(config).await? else {
            return Ok(());
        };
        match installer.status().map_err(platform_error)? {
            vibe_cs_platform_windows::RecoveryStatus::Clean => {}
            vibe_cs_platform_windows::RecoveryStatus::Pending {
                restorable: true, ..
            } => {
                installer.restore().map_err(platform_error)?;
            }
            vibe_cs_platform_windows::RecoveryStatus::Pending {
                restorable: false, ..
            } => {
                return Err(DomainError::Conflict(
                    "first-person HUD recovery is pending but its backup cannot be verified"
                        .to_owned(),
                ));
            }
        }
        installer.preflight().map_err(platform_error)?;
        if let Err(error) = installer.install() {
            let primary = platform_error(error);
            let recovery = match installer.status().map_err(platform_error)? {
                vibe_cs_platform_windows::RecoveryStatus::Clean => Ok(()),
                vibe_cs_platform_windows::RecoveryStatus::Pending {
                    restorable: true, ..
                } => installer.restore().map_err(platform_error),
                vibe_cs_platform_windows::RecoveryStatus::Pending {
                    restorable: false, ..
                } => Err(DomainError::Conflict(
                    "HUD installation failed and its recovery state cannot be verified".to_owned(),
                )),
            };
            return Err(match recovery {
                Ok(()) => primary,
                Err(cleanup) => DomainError::Internal(format!(
                    "{primary}; additionally failed to restore first-person HUD resources: {cleanup}"
                )),
            });
        }
        *self.hud_session.lock().await = Some(installer);
        Ok(())
    }

    async fn finish_job(&self, _config: &AppConfig) -> Result<(), DomainError> {
        let installer = self.hud_session.lock().await.take();
        installer.map_or(Ok(()), |installer| {
            installer.restore().map_err(platform_error)
        })
    }

    async fn preflight(
        &self,
        config: &AppConfig,
        items: &[PreparedRecording],
    ) -> Result<(), DomainError> {
        validate_system_configuration(config)?;
        Self::ensure_hud_can_load_before_launch(config)?;
        let configured =
            (!config.ffmpeg_path.trim().is_empty()).then(|| Path::new(config.ffmpeg_path.trim()));
        let _ffmpeg = find_executable("ffmpeg", configured).map_err(media_error)?;
        let _dimensions = parse_recording_resolution(&config.recording.resolution)?;
        if !matches!(config.recording.fps, 30 | 60) {
            return Err(DomainError::InvalidInput(
                "recording frame rate must be 30 or 60 FPS".to_owned(),
            ));
        }
        let _encoder = select_video_encoder(&config.preferred_encoder, &[]).map_err(media_error)?;
        if let Some(installer) = self.first_person_hud_installer(config).await? {
            installer.preflight().map_err(platform_error)?;
        }
        for (enabled, configured) in [
            (
                items.iter().any(|item| item.request.show_kill_fx),
                config.recording.obs_realtime_kill_fx_media.trim(),
            ),
            (
                items.iter().any(|item| item.request.show_keyboard),
                config.recording.obs_realtime_keyboard_media.trim(),
            ),
        ] {
            if enabled && !configured.is_empty() {
                ObsRealtimeMediaInput {
                    scene: if config.obs.scene.trim().is_empty() {
                        "current-scene-preflight".to_owned()
                    } else {
                        config.obs.scene.trim().to_owned()
                    },
                    input_name: "VibeCS-preflight".to_owned(),
                    media_path: PathBuf::from(configured),
                    loop_media: false,
                }
                .validate()
                .map_err(integration_error)?;
            }
        }
        let plans = items
            .iter()
            .map(|item| item.segment.clone())
            .collect::<Vec<_>>();
        let mut engine = self.build_engine(config).await?;
        Self::configured_scene(&mut engine, config).await?;
        engine
            .preflight(&plans)
            .await
            .map(|_| ())
            .map_err(recording_error)
    }

    async fn record(
        &self,
        config: &AppConfig,
        item: &PreparedRecording,
        cancellation: &RecordingCancellation,
    ) -> Result<RecordedClip, DomainError> {
        let mut engine = self.build_engine(config).await?;
        let previous_scene = Self::activate_configured_scene(&mut engine, config).await?;
        let overlay_cues = build_realtime_overlay_cues(item);
        let mut realtime_overlays = match Self::activate_realtime_overlays(
            &mut engine,
            config,
            item,
            &overlay_cues,
        )
        .await
        {
            Ok(session) => session,
            Err(error) => {
                let scene_restore =
                    Self::restore_obs_scene(&mut engine, previous_scene.as_deref()).await;
                return Err(scene_activation_error(error, scene_restore));
            }
        };
        let mut overlay_driver =
            match Self::connect_realtime_overlay_driver(config, &realtime_overlays).await {
                Ok(driver) => driver,
                Err(error) => {
                    let overlay_cleanup = realtime_overlays.cleanup(&mut engine).await;
                    let scene_restore =
                        Self::restore_obs_scene(&mut engine, previous_scene.as_deref()).await;
                    return Err(scene_activation_error(
                        scene_activation_error(error, overlay_cleanup),
                        scene_restore,
                    ));
                }
            };
        let overlay_stop = RecordingCancellation::default();
        let platform_cancellation = PlatformRecordingCancellation::default();
        let (result, overlay_result) = {
            let recording = async {
                let recording = engine
                    .record_segments(std::slice::from_ref(&item.segment), &platform_cancellation);
                tokio::pin!(recording);
                tokio::select! {
                    biased;
                    () = wait_for_cancellation(cancellation) => {
                        platform_cancellation.cancel();
                        recording.await
                    }
                    result = &mut recording => result,
                }
            };
            let driving = async {
                if let Some(client) = overlay_driver.as_mut() {
                    Self::drive_realtime_overlays(
                        client,
                        &realtime_overlays,
                        &overlay_cues,
                        cancellation,
                        &overlay_stop,
                    )
                    .await
                } else {
                    Ok(())
                }
            };
            tokio::pin!(recording);
            tokio::pin!(driving);
            tokio::select! {
                result = &mut recording => {
                    overlay_stop.cancel();
                    (result, driving.await)
                }
                overlay_result = &mut driving => {
                    if overlay_result.is_err() {
                        platform_cancellation.cancel();
                    }
                    (recording.await, overlay_result)
                }
            }
        };
        let overlay_cleanup = realtime_overlays.cleanup(&mut engine).await;
        let scene_restore = Self::restore_obs_scene(&mut engine, previous_scene.as_deref()).await;
        if cancellation.is_cancelled()
            || result.is_err()
            || overlay_result.is_err()
            || overlay_cleanup.is_err()
            || scene_restore.is_err()
        {
            self.remove_unpublished_output(item).await;
        }
        if cancellation.is_cancelled() {
            return Err(DomainError::Conflict("recording was cancelled".to_owned()));
        }
        let mut clips = result.map_err(recording_error)?;
        overlay_result?;
        overlay_cleanup?;
        scene_restore?;
        if clips.len() != 1 {
            self.remove_unpublished_output(item).await;
            return Err(DomainError::Internal(
                "recording engine returned an unexpected output count".to_owned(),
            ));
        }
        let clip = clips.pop().ok_or_else(|| {
            DomainError::Internal("recording engine returned no output".to_owned())
        })?;
        match self
            .postprocess_clip(config, item, clip, cancellation)
            .await
        {
            Ok(clip) => Ok(clip),
            Err(error) => {
                self.remove_unpublished_output(item).await;
                Err(error)
            }
        }
    }
}

#[derive(Clone)]
pub struct RuntimeRecordingPort {
    storage: Storage,
    backend: Arc<dyn RecordingBackend>,
    active: Arc<Mutex<HashMap<Uuid, RecordingCancellation>>>,
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
            job.status = match job.status {
                JobStatus::Queued | JobStatus::Preparing | JobStatus::Running => JobStatus::Failed,
                JobStatus::Cancelling => JobStatus::Cancelled,
                JobStatus::Completed | JobStatus::Failed | JobStatus::Cancelled => continue,
            };
            job.message = match job.status {
                JobStatus::Cancelled => {
                    "Recording cancellation completed after service restart".to_owned()
                }
                JobStatus::Failed => "Recording was interrupted by service restart".to_owned(),
                _ => unreachable!("orphan reconciliation produces a terminal state"),
            };
            job.updated_at = Utc::now();
            if let Err(error) = self.storage.put_recording_job(job.clone()).await {
                tracing::error!(job_id = %job.id, %error, "unable to persist orphaned recording terminal state");
            }
        }
    }

    async fn prepare(&self, job: &RecordingJob) -> Result<Vec<PreparedRecording>, DomainError> {
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
        for request in &job.items {
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
            let (tick_rate, tick_rate_source) = select_tick_rate(analysis.as_ref());
            let demo_path = std::path::absolute(Path::new(&demo.path)).map_err(|error| {
                DomainError::InvalidInput(format!(
                    "recording demo path could not be made absolute: {error}"
                ))
            })?;
            let segment = build_segment_plan(
                request,
                &demo,
                analysis.as_ref(),
                demo_path,
                tick_rate,
                tick_rate_source,
                Uuid::new_v4(),
            )?;
            prepared.push(PreparedRecording {
                request: request.clone(),
                demo,
                segment,
            });
        }
        Ok(prepared)
    }

    async fn run_job(
        storage: Storage,
        backend: Arc<dyn RecordingBackend>,
        active: Arc<Mutex<HashMap<Uuid, RecordingCancellation>>>,
        config: AppConfig,
        mut job: RecordingJob,
        prepared: Vec<PreparedRecording>,
        cancellation: RecordingCancellation,
    ) {
        let result = match backend.begin_job(&config, &prepared).await {
            Ok(()) => {
                Self::record_all(
                    &storage,
                    backend.as_ref(),
                    &config,
                    &mut job,
                    &prepared,
                    &cancellation,
                )
                .await
            }
            Err(error) => Err(error),
        };
        let cleanup = backend.finish_job(&config).await;
        let result = match (result, cleanup) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(primary), Ok(())) => Err(primary),
            (Ok(()), Err(cleanup)) => Err(cleanup),
            (Err(primary), Err(cleanup)) => Err(DomainError::Internal(format!(
                "{primary}; additionally failed to restore recording job resources: {cleanup}"
            ))),
        };
        let mut active_jobs = active.lock().await;
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
            Err(error) if cancellation.is_cancelled() => {
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
        active_jobs.remove(&job.id);
    }

    async fn record_all(
        storage: &Storage,
        backend: &dyn RecordingBackend,
        config: &AppConfig,
        job: &mut RecordingJob,
        prepared: &[PreparedRecording],
        cancellation: &RecordingCancellation,
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

            let clip = backend.record(config, item, cancellation).await?;
            if cancellation.is_cancelled() {
                remove_unpublished_clip(&clip).await;
                return Ok(());
            }
            if let Err(error) = validate_clip(&clip, item).await {
                remove_unpublished_clip(&clip).await;
                return Err(error);
            }
            if let Err(error) = storage.put_recorded_clip(clip.clone()).await {
                remove_unpublished_clip(&clip).await;
                return Err(storage_error(&error));
            }
            job.outputs.push(clip);
            job.progress = f64::from(progress_index + 1) / f64::from(total);
            job.updated_at = Utc::now();
            storage
                .put_recording_job(job.clone())
                .await
                .map_err(|error| storage_error(&error))?;
        }
        Ok(())
    }
}

#[async_trait]
impl RecordingPort for RuntimeRecordingPort {
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
        for item in &mut prepared {
            let voice_participants = item
                .segment
                .metadata
                .get("voice_participants")
                .cloned()
                .unwrap_or_else(|| json!([]));
            item.segment.metadata["capture"] = json!({
                "obs_scene": config.obs.scene.trim(),
                "show_radar": config.recording.show_radar,
                "radar_restore_visible": config.recording.radar_restore_visible,
                "mute_voice": config.recording.mute_voice,
                "voice_restore_volume": config.recording.voice_restore_volume,
                "camera_fov": config.recording.camera_fov,
                "camera_fov_restore": config.recording.camera_fov_restore,
                "viewmodel_fov": config.recording.viewmodel_fov,
                "viewmodel_fov_restore": config.recording.viewmodel_fov_restore,
                "flash_alpha": config.recording.flash_alpha,
                "flash_alpha_restore": config.recording.flash_alpha_restore,
                "grenade_trajectory": config.recording.grenade_trajectory,
                "grenade_trajectory_restore": config.recording.grenade_trajectory_restore,
                "show_hud": config.recording.show_hud,
                "hud_restore_visible": config.recording.hud_restore_visible,
                "isolate_target_voice": config.recording.isolate_target_voice,
                "voice_participants": voice_participants,
                "capture_delay_ms": config.recording.capture_delay_ms,
            });
        }
        self.backend.preflight(&config, &prepared).await?;

        let cancellation = RecordingCancellation::default();
        {
            let mut active = self.active.lock().await;
            if !active.is_empty() {
                return Err(DomainError::Conflict(
                    "another recording job is already active".to_owned(),
                ));
            }
            active.insert(job.id, cancellation.clone());
        }
        job.status = JobStatus::Running;
        "Running".clone_into(&mut job.message);
        job.updated_at = Utc::now();
        if let Err(error) = self.storage.put_recording_job(job.clone()).await {
            self.active.lock().await.remove(&job.id);
            return Err(storage_error(&error));
        }

        let storage = self.storage.clone();
        let backend = Arc::clone(&self.backend);
        let active = Arc::clone(&self.active);
        let background_job = job.clone();
        tokio::spawn(async move {
            Self::run_job(
                storage,
                backend,
                active,
                config,
                background_job,
                prepared,
                cancellation,
            )
            .await;
        });
        Ok(job)
    }

    async fn cancel(&self, mut job: RecordingJob) -> Result<RecordingJob, DomainError> {
        if job.status.is_terminal() {
            return Err(DomainError::Conflict(
                "recording job is already terminal".to_owned(),
            ));
        }
        let active = self.active.lock().await;
        let Some(cancellation) = active.get(&job.id) else {
            return Err(DomainError::Conflict(
                "recording job is not active in this runtime".to_owned(),
            ));
        };
        cancellation.cancel();
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

async fn wait_for_cancellation(cancellation: &RecordingCancellation) {
    while !cancellation.is_cancelled() {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn select_tick_rate(analysis: Option<&MatchAnalysis>) -> (f64, &'static str) {
    analysis
        .map(|analysis| analysis.tick_rate)
        .filter(|tick_rate| tick_rate.is_finite() && (1.0..=256.0).contains(tick_rate))
        .map_or((64.0, "fallback_64"), |tick_rate| {
            (tick_rate, "persisted_analysis")
        })
}

fn build_segment_plan(
    request: &RecordingRequest,
    demo: &DemoRecord,
    analysis: Option<&MatchAnalysis>,
    demo_path: PathBuf,
    tick_rate: f64,
    tick_rate_source: &'static str,
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
    let pre_roll_ticks =
        seconds_to_ticks(request.pre_roll_seconds, tick_rate, request.playback_speed)?;
    let post_roll_ticks =
        seconds_to_ticks(request.post_roll_seconds, tick_rate, request.playback_speed)?;
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
    let category = highlight.map_or("custom", |highlight| highlight_category(highlight.kind));
    let mut tags = highlight.map_or_else(Vec::new, |highlight| highlight.tags.clone());
    if request.victim_pov && !tags.iter().any(|tag| tag == "victim_pov") {
        tags.push("victim_pov".to_owned());
    }
    let kill_track = analysis.map_or_else(Vec::new, |analysis| {
        build_kill_track(
            analysis,
            &request.player_id,
            start_tick,
            end_tick,
            tick_rate,
            request.playback_speed,
        )
    });
    let input_bus = if request.show_keyboard {
        let analysis = analysis.ok_or_else(|| {
            DomainError::DependencyUnavailable(
                "keyboard rendering requires a persisted demo analysis".to_owned(),
            )
        })?;
        let track = build_input_track(analysis, &camera_player_id, start_tick, end_tick)?;
        if track.is_empty() {
            return Err(DomainError::DependencyUnavailable(
                "the demo does not expose a trustworthy player input mask for this segment"
                    .to_owned(),
            ));
        }
        Some(RecordingInputBus {
            version: 1,
            player_id: camera_player_id.clone(),
            source: "demo_button_mask".to_owned(),
            events: track,
        })
    } else {
        None
    };
    let input_track = input_bus
        .as_ref()
        .map_or_else(Vec::new, |bus| bus.events.clone());
    let output_file_name = format!("{}-{}.mkv", safe_output_stem(title), output_id.simple());
    Ok(SegmentPlan {
        demo_id: demo.id,
        demo_path,
        title: title.to_owned(),
        player_id: camera_player_id.clone(),
        player_name: Some(player_name.clone()),
        start_tick,
        end_tick,
        tick_rate,
        playback_speed: request.playback_speed,
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
            "tick_rate_source": tick_rate_source,
            "tick_rate_fallback": tick_rate_source == "fallback_64",
            "victim_pov_requested": request.victim_pov,
            "perspective": if request.victim_pov { "victim" } else { "player" },
            "camera_player_id": camera_player_id,
            "camera_player_name": player_name,
            "show_keyboard_requested": request.show_keyboard,
            "show_kill_fx_requested": request.show_kill_fx,
            "fade_requested": request.fade,
            "kill_track": kill_track,
            "input_track": input_track,
            "input_state_bus": input_bus,
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

fn analysis_events(analysis: &MatchAnalysis) -> Vec<TimelineEvent> {
    analysis
        .rounds
        .iter()
        .flat_map(|round| round.events.iter().cloned())
        .collect()
}

#[allow(clippy::cast_precision_loss)] // Demo ticks are bounded to u32 spans above before timing conversion.
fn build_kill_track(
    analysis: &MatchAnalysis,
    player_id: &str,
    start_tick: u64,
    end_tick: u64,
    tick_rate: f64,
    playback_speed: f64,
) -> Vec<serde_json::Value> {
    analysis
        .rounds
        .iter()
        .flat_map(|round| round.events.iter().map(move |event| (round.number, event)))
        .filter(|(_, event)| {
            event.kind == EventKind::Kill
                && event.tick >= start_tick
                && event.tick <= end_tick
                && event.actor.as_deref() == Some(player_id)
        })
        .map(|(round, event)| {
            let video_seconds =
                (event.tick.saturating_sub(start_tick) as f64) / tick_rate / playback_speed;
            let mut tags = Vec::new();
            if event.headshot {
                tags.push("headshot");
            }
            if event.penetrated {
                tags.push("wallbang");
            }
            if event
                .detail
                .get("noscope")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
            {
                tags.push("no_scope");
            }
            json!({
                "tick": event.tick,
                "video_seconds": video_seconds,
                "round": round,
                "victim_id": event.target,
                "weapon": event.weapon,
                "tags": tags,
            })
        })
        .collect()
}

fn build_input_track(
    analysis: &MatchAnalysis,
    player_id: &str,
    start_tick: u64,
    end_tick: u64,
) -> Result<Vec<RecordingInputEvent>, DomainError> {
    const MAXIMUM_TRACK_FRAMES: usize = 2_000;
    let events = analysis_events(analysis);
    let frames = vibe_cs_demo::replay_frames_from_events(&events).map_err(|error| {
        DomainError::DependencyUnavailable(format!(
            "player input track could not be decoded: {error}"
        ))
    })?;
    let samples = frames
        .into_iter()
        .filter(|frame| frame.tick >= start_tick && frame.tick <= end_tick)
        .filter_map(|frame| {
            frame
                .players
                .into_iter()
                .find(|player| player.id == player_id)
                .and_then(|player| player.input.map(|input| (frame.tick, input)))
        })
        .collect::<Vec<_>>();
    let stride = samples.len().div_ceil(MAXIMUM_TRACK_FRAMES).max(1);
    Ok(samples
        .into_iter()
        .step_by(stride)
        .enumerate()
        .map(|(sequence, (tick, input))| RecordingInputEvent {
            sequence: u64::try_from(sequence).unwrap_or(u64::MAX),
            tick,
            input,
        })
        .collect())
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss
)]
fn seconds_to_ticks(seconds: f64, tick_rate: f64, playback_speed: f64) -> Result<u64, DomainError> {
    let ticks = seconds * tick_rate * playback_speed;
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

fn parse_recording_resolution(value: &str) -> Result<(u32, u32), DomainError> {
    let (width, height) = value.trim().split_once('x').ok_or_else(|| {
        DomainError::InvalidInput("recording resolution must use WIDTHxHEIGHT".to_owned())
    })?;
    let width = width.parse::<u32>().map_err(|_| {
        DomainError::InvalidInput("recording width is not a valid integer".to_owned())
    })?;
    let height = height.parse::<u32>().map_err(|_| {
        DomainError::InvalidInput("recording height is not a valid integer".to_owned())
    })?;
    if width == 0 || height == 0 || width > 16_384 || height > 16_384 {
        return Err(DomainError::InvalidInput(
            "recording resolution is outside the supported range".to_owned(),
        ));
    }
    Ok((width, height))
}

fn build_recording_overlays(
    item: &PreparedRecording,
    width: u32,
    height: u32,
    duration_seconds: f64,
) -> Vec<TimedTextOverlay> {
    const MAXIMUM_DYNAMIC_OVERLAYS: usize = 256;
    let mut overlays = Vec::new();
    let delay_ms = item
        .segment
        .metadata
        .pointer("/capture/capture_delay_ms")
        .and_then(serde_json::Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .filter(|value| (-5_000..=5_000).contains(value))
        .unwrap_or_default();
    let delay_seconds = f64::from(delay_ms) / 1_000.0;
    if duration_seconds > 0.01 {
        let map = item
            .segment
            .metadata
            .pointer("/hud/map_name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown map");
        let player = item
            .segment
            .player_name
            .as_deref()
            .unwrap_or("unknown player");
        overlays.push(TimedTextOverlay {
            text: bounded_overlay_text(&format!(
                "{}  |  {}  |  {}",
                item.segment.title, player, map
            )),
            start_seconds: 0.0,
            end_seconds: duration_seconds.min(2.75),
            x: 32.0,
            y: (f64::from(height) - 72.0).max(16.0),
            font_size: (f64::from(height) * 0.027).clamp(18.0, 42.0),
            color: "#FFFFFF".to_owned(),
            background: Some("#101419".to_owned()),
        });
    }
    if item.request.show_kill_fx {
        overlays.extend(build_kill_overlays(
            &item.segment.metadata,
            width,
            duration_seconds,
            delay_seconds,
        ));
    }
    if item.request.show_keyboard {
        overlays.extend(build_keyboard_overlays(
            &item.segment,
            height,
            duration_seconds,
            delay_seconds,
        ));
    }
    if overlays.len() > MAXIMUM_DYNAMIC_OVERLAYS + 1 {
        overlays.truncate(MAXIMUM_DYNAMIC_OVERLAYS + 1);
    }
    overlays
}

fn build_kill_overlays(
    metadata: &serde_json::Value,
    width: u32,
    duration_seconds: f64,
    delay_seconds: f64,
) -> Vec<TimedTextOverlay> {
    metadata
        .get("kill_track")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let start = entry.get("video_seconds")?.as_f64()? + delay_seconds;
            if !start.is_finite() || start < 0.0 || start >= duration_seconds {
                return None;
            }
            let weapon = entry
                .get("weapon")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("weapon");
            let tags = entry
                .get("tags")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_ascii_uppercase)
                .collect::<Vec<_>>();
            let suffix = if tags.is_empty() {
                String::new()
            } else {
                format!("  |  {}", tags.join(" + "))
            };
            Some(TimedTextOverlay {
                text: bounded_overlay_text(&format!(
                    "KILL  |  {}{suffix}",
                    weapon.to_ascii_uppercase()
                )),
                start_seconds: start,
                end_seconds: (start + 0.9).min(duration_seconds),
                x: (f64::from(width) * 0.68).max(32.0),
                y: 48.0,
                font_size: 30.0,
                color: "#FFB15C".to_owned(),
                background: Some("#180E08".to_owned()),
            })
        })
        .filter(|overlay| overlay.end_seconds > overlay.start_seconds)
        .collect()
}

fn build_keyboard_overlays(
    segment: &SegmentPlan,
    height: u32,
    duration_seconds: f64,
    delay_seconds: f64,
) -> Vec<TimedTextOverlay> {
    let Some(samples) = segment
        .metadata
        .get("input_track")
        .and_then(serde_json::Value::as_array)
    else {
        return Vec::new();
    };
    let stride = samples.len().div_ceil(200).max(1);
    let timeline = samples
        .iter()
        .step_by(stride)
        .filter_map(|sample| {
            let tick = sample.get("tick")?.as_u64()?;
            let delta = u32::try_from(tick.saturating_sub(segment.start_tick)).ok()?;
            let seconds =
                f64::from(delta) / segment.tick_rate / segment.playback_speed + delay_seconds;
            let input = sample.get("input")?.as_object()?;
            Some((seconds, keyboard_text(input)))
        })
        .filter(|(seconds, _)| {
            seconds.is_finite() && *seconds >= 0.0 && *seconds < duration_seconds
        })
        .collect::<Vec<_>>();
    let mut intervals: Vec<TimedTextOverlay> = Vec::new();
    for (index, (start, text)) in timeline.iter().enumerate() {
        let end = timeline
            .get(index + 1)
            .map_or(duration_seconds, |(seconds, _)| *seconds)
            .clamp(*start, duration_seconds);
        if end <= *start {
            continue;
        }
        if let Some(previous) = intervals.last_mut()
            && previous.text == *text
            && (previous.end_seconds - *start).abs() < 0.02
        {
            previous.end_seconds = end;
            continue;
        }
        intervals.push(TimedTextOverlay {
            text: text.clone(),
            start_seconds: *start,
            end_seconds: end,
            x: 32.0,
            y: (f64::from(height) - 132.0).max(16.0),
            font_size: 24.0,
            color: "#9ED7FF".to_owned(),
            background: Some("#071018".to_owned()),
        });
    }
    intervals
}

fn keyboard_text(input: &serde_json::Map<String, serde_json::Value>) -> String {
    let key = |name: &str, active: &'static str| -> &'static str {
        if input
            .get(name)
            .and_then(serde_json::Value::as_bool)
            .is_some_and(|value| value)
        {
            active
        } else {
            "·"
        }
    };
    format!(
        "{} {} {} {}  |  {} {} {} {}  |  {} {}",
        key("forward", "W"),
        key("left", "A"),
        key("backward", "S"),
        key("right", "D"),
        key("jump", "SPACE"),
        key("crouch", "CTRL"),
        key("walk", "SHIFT"),
        key("reload", "R"),
        key("fire", "M1"),
        key("secondary_fire", "M2")
    )
}

fn build_realtime_overlay_cues(item: &PreparedRecording) -> Vec<RealtimeOverlayCue> {
    const KILL_VISIBILITY_SECONDS: f64 = 0.9;
    const MAXIMUM_KEYBOARD_CUES: usize = 512;

    let duration_seconds = u32::try_from(
        item.segment
            .end_tick
            .saturating_sub(item.segment.start_tick),
    )
    .map_or(0.0, |ticks| {
        f64::from(ticks) / item.segment.tick_rate / item.segment.playback_speed
    });
    if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return Vec::new();
    }
    let delay_ms = item
        .segment
        .metadata
        .pointer("/capture/capture_delay_ms")
        .and_then(serde_json::Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .filter(|value| (-5_000..=5_000).contains(value))
        .unwrap_or_default();
    let delay_seconds = f64::from(delay_ms) / 1_000.0;
    let mut cues = Vec::new();

    if item.request.show_kill_fx {
        let mut intervals = item
            .segment
            .metadata
            .get("kill_track")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                let start = entry.get("video_seconds")?.as_f64()? + delay_seconds;
                (start.is_finite() && start >= 0.0 && start < duration_seconds).then_some((
                    start,
                    (start + KILL_VISIBILITY_SECONDS).min(duration_seconds),
                ))
            })
            .collect::<Vec<_>>();
        intervals.sort_by(|left, right| left.0.total_cmp(&right.0));
        let mut merged: Vec<(f64, f64)> = Vec::new();
        for (start, end) in intervals {
            if let Some(previous) = merged.last_mut()
                && start <= previous.1
            {
                previous.1 = previous.1.max(end);
            } else {
                merged.push((start, end));
            }
        }
        for (start, end) in merged {
            if let (Ok(start), Ok(end)) = (
                Duration::try_from_secs_f64(start),
                Duration::try_from_secs_f64(end),
            ) {
                cues.push(RealtimeOverlayCue {
                    at: start,
                    action: RealtimeOverlayAction::ShowKill,
                });
                cues.push(RealtimeOverlayCue {
                    at: end,
                    action: RealtimeOverlayAction::HideKill,
                });
            }
        }
    }

    if item.request.show_keyboard {
        let samples = item
            .segment
            .metadata
            .get("input_track")
            .and_then(serde_json::Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let stride = samples.len().div_ceil(MAXIMUM_KEYBOARD_CUES).max(1);
        let mut previous_text = None;
        for sample in samples.iter().step_by(stride) {
            let Some(tick) = sample.get("tick").and_then(serde_json::Value::as_u64) else {
                continue;
            };
            let Ok(delta) = u32::try_from(tick.saturating_sub(item.segment.start_tick)) else {
                continue;
            };
            let seconds = f64::from(delta) / item.segment.tick_rate / item.segment.playback_speed
                + delay_seconds;
            let Some(input) = sample.get("input").and_then(serde_json::Value::as_object) else {
                continue;
            };
            let text = keyboard_text(input);
            if !seconds.is_finite()
                || seconds < 0.0
                || seconds >= duration_seconds
                || previous_text.as_ref() == Some(&text)
            {
                continue;
            }
            let Ok(at) = Duration::try_from_secs_f64(seconds) else {
                continue;
            };
            previous_text = Some(text.clone());
            cues.push(RealtimeOverlayCue {
                at,
                action: RealtimeOverlayAction::Keyboard(text),
            });
        }
    }
    cues.sort_by(|left, right| {
        left.at.cmp(&right.at).then_with(|| {
            realtime_action_order(&left.action).cmp(&realtime_action_order(&right.action))
        })
    });
    cues.push(RealtimeOverlayCue {
        at: Duration::try_from_secs_f64(duration_seconds).unwrap_or(Duration::ZERO),
        action: RealtimeOverlayAction::Finish,
    });
    cues
}

fn has_realtime_kill_cue(cues: &[RealtimeOverlayCue]) -> bool {
    cues.iter()
        .any(|cue| cue.action == RealtimeOverlayAction::ShowKill)
}

const fn realtime_action_order(action: &RealtimeOverlayAction) -> u8 {
    match action {
        RealtimeOverlayAction::HideKill => 0,
        RealtimeOverlayAction::ShowKill => 1,
        RealtimeOverlayAction::Keyboard(_) => 2,
        RealtimeOverlayAction::Finish => 3,
    }
}

fn bounded_overlay_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(480)
        .collect()
}

fn promote_render_metadata(
    clip: &mut RecordedClip,
    item: &PreparedRecording,
    options: &SingleInputTranscodeOptions,
) {
    if !clip.metadata.is_object() {
        clip.metadata = json!({});
    }
    let Some(metadata) = clip.metadata.as_object_mut() else {
        return;
    };
    metadata.insert(
        "perspective".to_owned(),
        item.segment
            .metadata
            .get("perspective")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    );
    metadata.insert(
        "camera_player_id".to_owned(),
        item.segment
            .metadata
            .get("camera_player_id")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    );
    metadata.insert(
        "kill_axis".to_owned(),
        item.segment
            .metadata
            .get("kill_track")
            .cloned()
            .unwrap_or_else(|| json!([])),
    );
    metadata.insert(
        "hud".to_owned(),
        item.segment
            .metadata
            .get("hud")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    );
    metadata.insert(
        "input_state_bus".to_owned(),
        item.segment
            .metadata
            .get("input_state_bus")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    );
    metadata.insert(
        "capture_delay_ms".to_owned(),
        item.segment
            .metadata
            .pointer("/capture/capture_delay_ms")
            .cloned()
            .unwrap_or_else(|| json!(0)),
    );
    let kill_event_count = item
        .segment
        .metadata
        .get("kill_track")
        .and_then(serde_json::Value::as_array)
        .map_or(0, Vec::len);
    let kill_fx_rendered = item.request.show_kill_fx && kill_event_count > 0;
    metadata.insert(
        "render".to_owned(),
        json!({
            "container": "mp4",
            "width": options.width,
            "height": options.height,
            "fps": options.fps,
            "encoder": options.encoder.primary,
            "quality": options.quality,
            "audio_preserved": options.has_audio,
            "fade_in_seconds": options.fade_in_seconds,
            "fade_out_seconds": options.fade_out_seconds,
            "keyboard_rendered": item.request.show_keyboard,
            "kill_fx_requested": item.request.show_kill_fx,
            "kill_fx_rendered": kill_fx_rendered,
            "kill_fx_event_count": kill_event_count,
            "kill_fx_degraded_reason": if item.request.show_kill_fx && !kill_fx_rendered {
                Some("no trustworthy kill event was available for this segment")
            } else {
                None
            },
            "overlay_count": options.overlays.len(),
        }),
    );
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

async fn remove_unpublished_clip(clip: &RecordedClip) {
    match tokio::fs::remove_file(&clip.path).await {
        Ok(()) => tracing::info!(clip_id = %clip.id, "removed cancelled unpublished clip"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            tracing::warn!(clip_id = %clip.id, %error, "unable to remove cancelled unpublished clip");
        }
    }
}

fn truncate_message(message: &str) -> String {
    message.chars().take(1_000).collect()
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
        IntegrationError::Cancelled => {
            DomainError::Conflict("integration was cancelled".to_owned())
        }
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

fn media_error(error: MediaError) -> DomainError {
    match error {
        MediaError::ExecutableNotFound(executable) => DomainError::DependencyUnavailable(format!(
            "recording post-processing requires {executable}"
        )),
        MediaError::InvalidInput(message) | MediaError::InvalidToolOutput(message) => {
            DomainError::InvalidInput(message)
        }
        MediaError::Cancelled => DomainError::Conflict("recording was cancelled".to_owned()),
        MediaError::OutputExists(path) => DomainError::Conflict(format!(
            "recording post-processing output already exists: {}",
            path.display()
        )),
        MediaError::ProcessFailed { status, message } => DomainError::DependencyUnavailable(
            format!("recording post-processing failed with status {status}: {message}"),
        ),
        MediaError::OutputLimit { limit } => DomainError::Internal(format!(
            "recording post-processing output exceeded {limit} bytes"
        )),
        MediaError::UnsupportedWave(message) => DomainError::InvalidInput(message),
        MediaError::EmptyOutput(path) => DomainError::Internal(format!(
            "recording post-processing produced no output: {}",
            path.display()
        )),
        MediaError::Io { path, source } => DomainError::Internal(format!(
            "recording post-processing I/O failed for {}: {source}",
            path.display()
        )),
        MediaError::Json(error) => DomainError::Internal(format!(
            "recording post-processing metadata failed: {error}"
        )),
    }
}

fn recording_error(error: RecordingError) -> DomainError {
    match error {
        RecordingError::InvalidInput(message) => DomainError::InvalidInput(message),
        RecordingError::Domain(error) => error,
        RecordingError::Integration(error) => integration_error(error),
        RecordingError::Platform(error) => platform_error(error),
        RecordingError::Cancelled { .. } => {
            DomainError::Conflict("recording was cancelled".to_owned())
        }
        RecordingError::ObsBusy => DomainError::Conflict("OBS is already recording".to_owned()),
        RecordingError::RecoveryPending => DomainError::Conflict(
            "configuration recovery is pending and must be resolved before recording".to_owned(),
        ),
        RecordingError::ObserverMismatch { expected, actual } => DomainError::Conflict(format!(
            "recording observer mismatch: expected {expected}, received {actual}"
        )),
        RecordingError::Preflight(message) => DomainError::DependencyUnavailable(format!(
            "recording preflight could not be satisfied: {message}"
        )),
        RecordingError::Timeout { stage } => DomainError::DependencyUnavailable(format!(
            "recording timed out while waiting for {stage}"
        )),
        RecordingError::OutputMissing => {
            DomainError::Internal("OBS did not return a recording output path".to_owned())
        }
        RecordingError::OutputInvalid { path, reason } => DomainError::Internal(format!(
            "recording output {} is invalid: {reason}",
            path.display()
        )),
        RecordingError::Cleanup { primary, cleanup } => DomainError::Internal(format!(
            "recording failed: {}; cleanup also failed: {cleanup}",
            truncate_message(&primary.to_string())
        )),
        RecordingError::CleanupFailed(message) => {
            DomainError::Internal(format!("recording cleanup failed: {message}"))
        }
        RecordingError::Io {
            operation,
            path,
            source,
        } => DomainError::Internal(format!(
            "recording I/O failed while {operation} {}: {source}",
            path.display()
        )),
        RecordingError::Task(message) => {
            DomainError::Internal(format!("recording task failed: {message}"))
        }
    }
}

fn platform_error(error: PlatformError) -> DomainError {
    match error {
        PlatformError::InvalidInput(message) => DomainError::InvalidInput(message),
        PlatformError::RecoveryPending
        | PlatformError::RecoveryNotPending
        | PlatformError::BackupIntegrity { .. }
        | PlatformError::RecoveryConflict { .. } => DomainError::Conflict(error.to_string()),
        PlatformError::Cancelled { .. } => {
            DomainError::Conflict("recording platform operation was cancelled".to_owned())
        }
        PlatformError::Unsupported
        | PlatformError::ProcessNotFound(_)
        | PlatformError::ForegroundMismatch { .. }
        | PlatformError::Windows(_)
        | PlatformError::Io { .. } => DomainError::DependencyUnavailable(error.to_string()),
        PlatformError::Json(error) => {
            DomainError::InvalidInput(format!("invalid platform configuration: {error}"))
        }
        PlatformError::Url(error) => {
            DomainError::InvalidInput(format!("invalid platform URL: {error}"))
        }
    }
}

fn validate_system_configuration(config: &AppConfig) -> Result<(), DomainError> {
    if config.obs.host.trim().is_empty() || config.obs.port == 0 {
        return Err(DomainError::DependencyUnavailable(
            "OBS WebSocket is not configured".to_owned(),
        ));
    }
    if config.recording.mute_voice && config.recording.isolate_target_voice {
        return Err(DomainError::InvalidInput(
            "global voice muting and target-player voice isolation are mutually exclusive"
                .to_owned(),
        ));
    }
    if !(-5_000..=5_000).contains(&config.recording.capture_delay_ms) {
        return Err(DomainError::InvalidInput(
            "recording capture delay must be between -5000 and 5000 milliseconds".to_owned(),
        ));
    }
    Ok(())
}

fn io_dependency_error(operation: &str, error: &std::io::Error) -> DomainError {
    DomainError::DependencyUnavailable(format!("unable to {operation}: {error}"))
}

fn storage_error(error: &vibe_cs_storage::StorageError) -> DomainError {
    DomainError::Internal(format!("storage operation failed: {error}"))
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        path::PathBuf,
        sync::{
            Arc as StdArc, Mutex as StdMutex,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use super::*;

    #[derive(Debug)]
    struct RuntimeObsTransport {
        incoming: VecDeque<String>,
        sent: StdArc<StdMutex<Vec<serde_json::Value>>>,
        fail_restart: bool,
    }

    impl RuntimeObsTransport {
        fn new(sent: StdArc<StdMutex<Vec<serde_json::Value>>>, fail_restart: bool) -> Self {
            Self {
                incoming: VecDeque::from([
                    r#"{"op":0,"d":{"rpcVersion":1}}"#.to_owned(),
                    r#"{"op":2,"d":{"negotiatedRpcVersion":1}}"#.to_owned(),
                ]),
                sent,
                fail_restart,
            }
        }
    }

    #[async_trait]
    impl ObsTransport for RuntimeObsTransport {
        async fn send_text(&mut self, message: String) -> Result<(), IntegrationError> {
            let wire: serde_json::Value = serde_json::from_str(&message)?;
            if wire["op"] == 6 {
                let request_id = wire["d"]["requestId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                let request_type = wire["d"]["requestType"].as_str().unwrap_or_default();
                let failed = self.fail_restart && request_type == "TriggerMediaInputAction";
                let response_data = if request_type == "GetRecordStatus" {
                    json!({ "outputActive": true, "outputPaused": false })
                } else {
                    json!({})
                };
                self.incoming.push_back(
                    json!({ "op": 5, "d": { "eventType": "InputSettingsChanged" } }).to_string(),
                );
                self.incoming.push_back(
                    json!({
                        "op": 7,
                        "d": {
                            "requestType": request_type,
                            "requestId": request_id,
                            "requestStatus": {
                                "result": !failed,
                                "code": if failed { 500 } else { 100 },
                                "comment": if failed { "injected restart failure" } else { "ok" }
                            },
                            "responseData": response_data
                        }
                    })
                    .to_string(),
                );
            }
            self.sent.lock().unwrap().push(wire);
            Ok(())
        }

        async fn receive_text(&mut self) -> Result<String, IntegrationError> {
            self.incoming.pop_front().ok_or_else(|| {
                IntegrationError::Protocol("runtime fake transport exhausted".to_owned())
            })
        }
    }

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
    struct FailingLifecycleBackend {
        begins: AtomicUsize,
        finishes: AtomicUsize,
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
        ) -> Result<RecordedClip, DomainError> {
            Err(DomainError::DependencyUnavailable(
                "injected recording failure".to_owned(),
            ))
        }

        async fn finish_job(&self, _config: &AppConfig) -> Result<(), DomainError> {
            self.finishes.fetch_add(1, Ordering::SeqCst);
            Ok(())
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
                remark: String::new(),
                content_sha256: None,
                file_size: 4,
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("demo");
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
                playback_speed: 1.0,
                pre_roll_seconds: 0.0,
                post_roll_seconds: 0.0,
                victim_pov: false,
                show_keyboard: false,
                show_kill_fx: false,
                fade: false,
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
    async fn job_resources_are_finished_after_a_recording_failure() {
        let (_root, storage, port, mut job) = fixture(false).await;
        let prepared = port.prepare(&job).await.expect("prepared job");
        let backend = Arc::new(FailingLifecycleBackend {
            begins: AtomicUsize::new(0),
            finishes: AtomicUsize::new(0),
        });
        let active = Arc::new(Mutex::new(HashMap::from([(
            job.id,
            RecordingCancellation::default(),
        )])));
        job.status = JobStatus::Running;
        storage.put_recording_job(job.clone()).await.expect("job");
        RuntimeRecordingPort::run_job(
            storage.clone(),
            backend.clone(),
            active,
            AppConfig::default(),
            job.clone(),
            prepared,
            RecordingCancellation::default(),
        )
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
    async fn system_backend_rejects_missing_obs_configuration_before_external_io() {
        let root = tempfile::tempdir().expect("temporary directory");
        let backend = SystemRecordingBackend::new(
            root.path().to_path_buf(),
            Arc::new(RwLock::new(GsiState::default())),
        );
        let mut config = AppConfig::default();
        config.obs.host.clear();
        config.obs.password = "must-not-appear".to_owned();

        let error = backend
            .preflight(&config, &[])
            .await
            .expect_err("missing OBS configuration");
        assert!(matches!(&error, DomainError::DependencyUnavailable(_)));
        assert!(!error.to_string().contains("must-not-appear"));
        assert!(!format!("{backend:?}").contains("must-not-appear"));
        assert!(!root.path().join("recordings").exists());
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
        request.playback_speed = 2.0;
        let analysis = MatchAnalysis {
            demo_id: demo.id,
            map_name: "de_test".to_owned(),
            tick_rate: 128.0,
            duration_seconds: 30.0,
            teams: Vec::new(),
            players: Vec::new(),
            rounds: Vec::new(),
            highlights: Vec::new(),
        };
        let (tick_rate, source) = select_tick_rate(Some(&analysis));
        assert_eq!((tick_rate, source), (128.0, "persisted_analysis"));
        assert_eq!(select_tick_rate(None), (64.0, "fallback_64"));

        let demo_path = std::path::absolute(&demo.path).expect("absolute demo path");
        let first = build_segment_plan(
            &request,
            &demo,
            Some(&analysis),
            demo_path.clone(),
            tick_rate,
            source,
            Uuid::from_u128(1),
        )
        .expect("first segment");
        let second = build_segment_plan(
            &request,
            &demo,
            Some(&analysis),
            demo_path.clone(),
            tick_rate,
            source,
            Uuid::from_u128(2),
        )
        .expect("second segment");
        let fallback = build_segment_plan(
            &request,
            &demo,
            None,
            demo_path,
            64.0,
            "fallback_64",
            Uuid::from_u128(3),
        )
        .expect("fallback segment");

        assert_eq!(first.start_tick, 384);
        assert_eq!(first.end_tick, 1_408);
        assert!((first.tick_rate - 128.0).abs() < f64::EPSILON);
        assert!((first.playback_speed - 2.0).abs() < f64::EPSILON);
        assert_eq!(first.metadata["tick_rate_source"], "persisted_analysis");
        assert_eq!(first.metadata["tick_rate_fallback"], false);
        assert_eq!(fallback.metadata["tick_rate_source"], "fallback_64");
        assert_eq!(fallback.metadata["tick_rate_fallback"], true);
        assert!((fallback.tick_rate - 64.0).abs() < f64::EPSILON);
        assert_ne!(first.output_file_name, second.output_file_name);
        assert!(
            Path::new(&first.output_file_name)
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("mkv"))
        );
        assert_eq!(
            Path::new(&first.output_file_name)
                .file_name()
                .and_then(|name| name.to_str()),
            Some(first.output_file_name.as_str())
        );
        assert!(!first.output_file_name.contains(['/', '\\', ':']));

        let mut render_item = PreparedRecording {
            request: RecordingRequest {
                show_keyboard: true,
                show_kill_fx: true,
                ..request
            },
            demo,
            segment: first,
        };
        render_item.segment.metadata["kill_track"] = json!([{
            "video_seconds": 1.25,
            "weapon": "ak47",
            "tags": ["headshot"]
        }]);
        render_item.segment.metadata["input_track"] = json!([
            {"tick": 384, "input": {"forward": true, "fire": false}},
            {"tick": 640, "input": {"forward": true, "fire": true}},
            {"tick": 896, "input": {"forward": false, "fire": false}}
        ]);
        let overlays = build_recording_overlays(&render_item, 1920, 1080, 4.0);
        assert!(overlays.iter().any(|overlay| overlay.text.contains("KILL")));
        assert!(overlays.iter().any(|overlay| overlay.text.contains('W')));
        assert!(overlays.iter().any(|overlay| overlay.text.contains("M1")));
        let realtime = build_realtime_overlay_cues(&render_item);
        assert!(realtime.iter().any(|cue| {
            cue.action == RealtimeOverlayAction::ShowKill && cue.at == Duration::from_secs_f64(1.25)
        }));
        assert!(realtime.iter().any(|cue| {
            matches!(cue.action, RealtimeOverlayAction::Keyboard(ref text) if text.contains('W'))
        }));
        assert!(matches!(
            realtime.last(),
            Some(RealtimeOverlayCue {
                at,
                action: RealtimeOverlayAction::Finish,
            }) if *at == Duration::from_secs(4)
        ));
        render_item.segment.metadata["capture"] = json!({ "capture_delay_ms": 500 });
        let delayed = build_recording_overlays(&render_item, 1920, 1080, 4.0);
        assert!(delayed.iter().any(|overlay| {
            overlay.text.contains("KILL") && (overlay.start_seconds - 1.75).abs() < f64::EPSILON
        }));
        assert!(build_realtime_overlay_cues(&render_item).iter().any(|cue| {
            cue.action == RealtimeOverlayAction::ShowKill && cue.at == Duration::from_secs_f64(1.75)
        }));
        render_item.segment.metadata["capture"] = json!({ "capture_delay_ms": i64::MAX });
        let rejected_delay = build_recording_overlays(&render_item, 1920, 1080, 4.0);
        assert!(rejected_delay.iter().any(|overlay| {
            overlay.text.contains("KILL") && (overlay.start_seconds - 1.25).abs() < f64::EPSILON
        }));
        assert_eq!(
            parse_recording_resolution("1920x1080").expect("valid resolution"),
            (1920, 1080)
        );
        assert!(parse_recording_resolution("automatic").is_err());
    }

    fn realtime_test_session() -> RealtimeOverlaySession {
        RealtimeOverlaySession {
            scene: "Gameplay".to_owned(),
            inputs: vec!["kill".to_owned(), "keys".to_owned()],
            kill: Some(RealtimeSceneInput {
                name: "kill".to_owned(),
                scene_item_id: 10,
            }),
            keyboard_text: Some(RealtimeSceneInput {
                name: "keys".to_owned(),
                scene_item_id: 11,
            }),
            keyboard_background: None,
        }
    }

    fn render_metadata_fixture(kill_track: &serde_json::Value) -> PreparedRecording {
        let demo_id = Uuid::new_v4();
        let now = Utc::now();
        PreparedRecording {
            request: RecordingRequest {
                id: Some(Uuid::new_v4()),
                demo_id,
                highlight_id: None,
                player_id: "player-1".to_owned(),
                title: "Fixture".to_owned(),
                start_tick: 0,
                end_tick: 256,
                playback_speed: 1.0,
                pre_roll_seconds: 0.0,
                post_roll_seconds: 0.0,
                victim_pov: false,
                show_keyboard: false,
                show_kill_fx: true,
                fade: false,
            },
            demo: DemoRecord {
                id: demo_id,
                path: "fixture.dem".to_owned(),
                file_name: "fixture.dem".to_owned(),
                display_name: "Fixture".to_owned(),
                source: "test".to_owned(),
                status: vibe_cs_domain::DemoStatus::Ready,
                map_name: None,
                match_date: None,
                duration_seconds: Some(4.0),
                total_rounds: None,
                team_a_name: None,
                team_b_name: None,
                team_a_score: None,
                team_b_score: None,
                remark: String::new(),
                content_sha256: None,
                file_size: 1,
                created_at: now,
                updated_at: now,
            },
            segment: SegmentPlan {
                demo_id,
                demo_path: PathBuf::from("fixture.dem"),
                title: "Fixture".to_owned(),
                player_id: "player-1".to_owned(),
                player_name: Some("Player One".to_owned()),
                start_tick: 0,
                end_tick: 256,
                tick_rate: 64.0,
                playback_speed: 1.0,
                output_file_name: "fixture.mkv".to_owned(),
                category: "highlight".to_owned(),
                tags: Vec::new(),
                metadata: json!({
                    "perspective": "player",
                    "camera_player_id": "player-1",
                    "kill_track": kill_track.clone(),
                }),
            },
        }
    }

    fn render_metadata_options(item: &PreparedRecording) -> SingleInputTranscodeOptions {
        SingleInputTranscodeOptions {
            duration_seconds: 4.0,
            width: 1920,
            height: 1080,
            fps: 60,
            has_audio: true,
            fade_in_seconds: 0.0,
            fade_out_seconds: 0.0,
            overlays: build_recording_overlays(item, 1920, 1080, 4.0),
            encoder: select_video_encoder("libx264", &[]).expect("software encoder"),
            quality: 80,
        }
    }

    fn render_metadata_clip(item: &PreparedRecording) -> RecordedClip {
        RecordedClip {
            id: Uuid::new_v4(),
            path: "fixture.mp4".to_owned(),
            title: item.request.title.clone(),
            duration_seconds: 4.0,
            demo_id: Some(item.demo.id),
            player_name: item.segment.player_name.clone(),
            category: item.segment.category.clone(),
            tags: Vec::new(),
            metadata: serde_json::Value::Null,
            created_at: Utc::now(),
        }
    }

    #[test]
    fn requested_kill_fx_without_events_is_reported_as_degraded_and_has_no_realtime_source() {
        let item = render_metadata_fixture(&json!([]));
        let cues = build_realtime_overlay_cues(&item);
        assert!(!has_realtime_kill_cue(&cues));
        assert!(cues.iter().all(|cue| !matches!(
            cue.action,
            RealtimeOverlayAction::ShowKill | RealtimeOverlayAction::HideKill
        )));

        let mut clip = render_metadata_clip(&item);
        promote_render_metadata(&mut clip, &item, &render_metadata_options(&item));
        assert_eq!(clip.metadata["render"]["kill_fx_requested"], true);
        assert_eq!(clip.metadata["render"]["kill_fx_rendered"], false);
        assert_eq!(clip.metadata["render"]["kill_fx_event_count"], 0);
        assert_eq!(
            clip.metadata["render"]["kill_fx_degraded_reason"],
            "no trustworthy kill event was available for this segment"
        );
    }

    #[test]
    fn requested_kill_fx_with_an_event_is_reported_as_rendered_and_drives_realtime() {
        let item = render_metadata_fixture(&json!([{
            "video_seconds": 1.0,
            "weapon": "ak47",
            "tags": ["headshot"]
        }]));
        let cues = build_realtime_overlay_cues(&item);
        assert!(has_realtime_kill_cue(&cues));
        assert!(cues.iter().any(|cue| {
            cue.action == RealtimeOverlayAction::HideKill && cue.at == Duration::from_secs_f64(1.9)
        }));

        let mut clip = render_metadata_clip(&item);
        promote_render_metadata(&mut clip, &item, &render_metadata_options(&item));
        assert_eq!(clip.metadata["render"]["kill_fx_requested"], true);
        assert_eq!(clip.metadata["render"]["kill_fx_rendered"], true);
        assert_eq!(clip.metadata["render"]["kill_fx_event_count"], 1);
        assert!(clip.metadata["render"]["kill_fx_degraded_reason"].is_null());
    }

    async fn realtime_test_client(
        sent: StdArc<StdMutex<Vec<serde_json::Value>>>,
        fail_restart: bool,
    ) -> ObsClient<RuntimeObsTransport> {
        ObsClient::connect(
            RuntimeObsTransport::new(sent, fail_restart),
            &SecretString::default(),
        )
        .await
        .expect("fake OBS handshake")
    }

    fn sent_request_types(sent: &StdArc<StdMutex<Vec<serde_json::Value>>>) -> Vec<String> {
        sent.lock()
            .unwrap()
            .iter()
            .filter_map(|wire| wire.pointer("/d/requestType")?.as_str().map(str::to_owned))
            .collect()
    }

    #[tokio::test]
    async fn realtime_overlay_driver_follows_cue_timing_and_disables_exact_inputs() {
        let sent = StdArc::new(StdMutex::new(Vec::new()));
        let mut client = realtime_test_client(StdArc::clone(&sent), false).await;
        let session = realtime_test_session();
        let cues = vec![
            RealtimeOverlayCue {
                at: Duration::from_millis(1),
                action: RealtimeOverlayAction::Keyboard("W · · D".to_owned()),
            },
            RealtimeOverlayCue {
                at: Duration::from_millis(2),
                action: RealtimeOverlayAction::ShowKill,
            },
            RealtimeOverlayCue {
                at: Duration::from_millis(4),
                action: RealtimeOverlayAction::HideKill,
            },
        ];
        let cancellation = RecordingCancellation::default();
        let stop = RecordingCancellation::default();
        let started = tokio::time::Instant::now();
        SystemRecordingBackend::drive_realtime_overlays(
            &mut client,
            &session,
            &cues,
            &cancellation,
            &stop,
        )
        .await
        .expect("driven overlays");
        assert!(started.elapsed() >= Duration::from_millis(3));
        let requests = sent_request_types(&sent);
        assert_eq!(
            requests.first().map(String::as_str),
            Some("GetRecordStatus")
        );
        assert!(
            requests
                .windows(2)
                .any(|pair| { pair == ["SetSceneItemEnabled", "TriggerMediaInputAction"] })
        );
        let disabled = sent
            .lock()
            .unwrap()
            .iter()
            .filter(|wire| {
                wire.pointer("/d/requestType")
                    .and_then(serde_json::Value::as_str)
                    == Some("SetSceneItemEnabled")
                    && wire.pointer("/d/requestData/sceneItemEnabled")
                        == Some(&serde_json::Value::Bool(false))
            })
            .count();
        assert!(disabled >= 3, "hide plus final cleanup must be explicit");
    }

    #[tokio::test]
    async fn realtime_overlay_driver_cancellation_and_failure_both_cleanup() {
        let cancelled_sent = StdArc::new(StdMutex::new(Vec::new()));
        let mut cancelled_client =
            realtime_test_client(StdArc::clone(&cancelled_sent), false).await;
        let session = realtime_test_session();
        let cancellation = RecordingCancellation::default();
        cancellation.cancel();
        SystemRecordingBackend::drive_realtime_overlays(
            &mut cancelled_client,
            &session,
            &[],
            &cancellation,
            &RecordingCancellation::default(),
        )
        .await
        .expect("cancel cleanup");
        assert_eq!(
            sent_request_types(&cancelled_sent),
            ["SetSceneItemEnabled", "SetSceneItemEnabled"]
        );

        let failed_sent = StdArc::new(StdMutex::new(Vec::new()));
        let mut failed_client = realtime_test_client(StdArc::clone(&failed_sent), true).await;
        let failure = SystemRecordingBackend::drive_realtime_overlays(
            &mut failed_client,
            &session,
            &[RealtimeOverlayCue {
                at: Duration::ZERO,
                action: RealtimeOverlayAction::ShowKill,
            }],
            &RecordingCancellation::default(),
            &RecordingCancellation::default(),
        )
        .await;
        assert!(failure.is_err());
        let failed_messages = failed_sent.lock().unwrap();
        assert!(failed_messages.iter().any(|wire| {
            wire.pointer("/d/requestType")
                .and_then(serde_json::Value::as_str)
                == Some("SetSceneItemEnabled")
                && wire.pointer("/d/requestData/sceneItemEnabled")
                    == Some(&serde_json::Value::Bool(false))
        }));
    }
}
