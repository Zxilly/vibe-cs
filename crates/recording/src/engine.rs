use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Component, Path},
    time::Duration,
};

use chrono::Utc;
use serde_json::json;
use uuid::Uuid;
use vibe_cs_domain::RecordedClip;
use vibe_cs_platform_windows::{ConsoleCommand, ProcessCancellation, RecoveryStatus};

use crate::{
    CaptureRecorder, EngineConfig, GameController, PlaybackSynchronizer, PreflightReport,
    RecordingError, RecordingResult, RecoveryGate, SegmentPlan, io_error, publish_capture_artifact,
};

#[derive(Debug)]
pub struct RecordingEngine<G, C, S, J> {
    config: EngineConfig,
    game: G,
    capture: C,
    synchronizer: S,
    recovery: J,
}

impl<G, C, S, J> RecordingEngine<G, C, S, J>
where
    G: GameController,
    C: CaptureRecorder,
    S: PlaybackSynchronizer,
    J: RecoveryGate,
{
    #[must_use]
    pub const fn new(
        config: EngineConfig,
        game: G,
        capture: C,
        synchronizer: S,
        recovery: J,
    ) -> Self {
        Self {
            config,
            game,
            capture,
            synchronizer,
            recovery,
        }
    }

    /// Returns the recorder adapter so a composition layer can perform
    /// session-scoped setup and restoration around a recording run.
    #[must_use]
    pub fn recorder_mut(&mut self) -> &mut C {
        &mut self.capture
    }

    /// Validates all immutable inputs and external idle state before launching
    /// a process or issuing a playback command.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid demos, CS2/output paths, a pending recovery
    /// journal, ambiguous processes, unsafe commands, or an active capture.
    pub async fn preflight(
        &mut self,
        segments: &[SegmentPlan],
    ) -> RecordingResult<PreflightReport> {
        validate_engine_config(&self.config)?;
        validate_output_directory(&self.config.output_directory)?;
        if !matches!(self.recovery.recovery_status()?, RecoveryStatus::Clean) {
            return Err(RecordingError::RecoveryPending);
        }
        if segments.is_empty() || segments.len() > 256 {
            return Err(RecordingError::InvalidInput(
                "recording plan must contain 1..=256 segments".to_owned(),
            ));
        }
        let mut outputs = HashSet::with_capacity(segments.len());
        for segment in segments {
            validate_segment(segment, &self.config)?;
            validate_segment_commands(segment)?;
            let key = if cfg!(windows) {
                segment.output_file_name.to_lowercase()
            } else {
                segment.output_file_name.clone()
            };
            if !outputs.insert(key) {
                return Err(RecordingError::InvalidInput(
                    "recording plan contains duplicate output file names".to_owned(),
                ));
            }
            let destination = self.config.output_directory.join(&segment.output_file_name);
            if destination.try_exists().map_err(|error| {
                io_error("checking managed recording output", &destination, error)
            })? {
                return Err(RecordingError::OutputInvalid {
                    path: destination,
                    reason: "managed output already exists".to_owned(),
                });
            }
        }
        if self.capture.capture_status().await?.active {
            return Err(RecordingError::capture_busy());
        }
        let processes = self.game.discover_cs2()?;
        let running_process_id = select_process(&processes, self.config.preferred_process_id)?;
        Ok(PreflightReport {
            segment_count: segments.len(),
            running_process_id,
        })
    }

    /// Records every segment with one reused CS2 process and one independently
    /// published output per segment.
    ///
    /// # Errors
    ///
    /// Returns the first validation, playback, capture, cancellation,
    /// publication, or cleanup failure. Capture stop and game cleanup are
    /// attempted on every path.
    pub async fn record_segments(
        &mut self,
        segments: &[SegmentPlan],
        cancellation: &ProcessCancellation,
    ) -> RecordingResult<Vec<RecordedClip>> {
        let report = self.preflight(segments).await?;
        if cancellation.is_cancelled() {
            return Err(RecordingError::Cancelled {
                stage: "recording preflight",
            });
        }
        let process_id = match report.running_process_id {
            Some(process_id) => process_id,
            None => {
                self.game
                    .launch_cs2(
                        &self.config.cs2_executable,
                        self.config.launch_policy,
                        self.config.launch_timeout,
                        cancellation,
                    )
                    .await?
            }
        };
        let mut clips = Vec::with_capacity(segments.len());
        for segment in segments {
            if cancellation.is_cancelled() {
                return Err(RecordingError::Cancelled {
                    stage: "recording segment dispatch",
                });
            }
            clips.push(
                self.record_segment(process_id, segment, cancellation)
                    .await?,
            );
        }
        Ok(clips)
    }

    async fn record_segment(
        &mut self,
        process_id: u32,
        segment: &SegmentPlan,
        cancellation: &ProcessCancellation,
    ) -> RecordingResult<RecordedClip> {
        let mut session = SessionState {
            process_id,
            capture_maybe_active: false,
            restore_commands: Vec::new(),
        };
        let execution = self
            .execute_segment(&mut session, segment, cancellation)
            .await;
        let cleanup = self.cleanup_session(&mut session).await;
        match (execution, cleanup) {
            (Ok(clip), Ok(())) => Ok(clip),
            (Ok(_), Err(cleanup)) => Err(RecordingError::CleanupFailed(cleanup)),
            (Err(primary), Ok(())) => Err(primary),
            (Err(primary), Err(cleanup)) => Err(RecordingError::Cleanup {
                primary: Box::new(primary),
                cleanup,
            }),
        }
    }

    async fn execute_segment(
        &mut self,
        session: &mut SessionState,
        segment: &SegmentPlan,
        cancellation: &ProcessCancellation,
    ) -> RecordingResult<RecordedClip> {
        self.send(
            session.process_id,
            &ConsoleCommand::PlayDemo(segment.demo_path.clone()),
            cancellation,
            "playdemo command",
        )?;
        self.synchronizer
            .confirm_demo_ready(
                &segment.demo_path,
                self.config.synchronization_timeout,
                cancellation,
            )
            .await?;
        self.send(
            session.process_id,
            &ConsoleCommand::Pause,
            cancellation,
            "pause command",
        )?;
        self.send(
            session.process_id,
            &ConsoleCommand::GoToTick(segment.start_tick),
            cancellation,
            "seek command",
        )?;
        self.synchronizer
            .confirm_tick(
                segment.start_tick,
                self.config.synchronization_timeout,
                cancellation,
            )
            .await?;
        self.send(
            session.process_id,
            &ConsoleCommand::SpectatePlayer(segment.player_id.clone()),
            cancellation,
            "spectator command",
        )?;
        self.synchronizer
            .confirm_observer(
                &segment.player_id,
                self.config.synchronization_timeout,
                cancellation,
            )
            .await?;
        for (target, restore) in capture_command_pairs(segment)? {
            self.send(
                session.process_id,
                &target,
                cancellation,
                "capture preheat command",
            )?;
            session.restore_commands.push(restore);
        }
        if self.capture.capture_status().await?.active {
            return Err(RecordingError::capture_busy());
        }
        // Mark active before awaiting the response: the backend may have
        // started even when a transport error loses the acknowledgement.
        session.capture_maybe_active = true;
        self.capture.start_capture().await?;
        if !self.capture.capture_status().await?.active {
            return Err(RecordingError::Preflight(
                "capture backend did not report an active session after start".to_owned(),
            ));
        }
        self.send(
            session.process_id,
            &ConsoleCommand::Resume,
            cancellation,
            "resume command",
        )?;
        let planned_duration = planned_duration(segment)?;
        let end_timeout = planned_duration
            .checked_add(self.config.synchronization_timeout)
            .ok_or_else(|| RecordingError::InvalidInput("segment timeout overflow".to_owned()))?;
        self.synchronizer
            .wait_until_tick(
                segment.end_tick,
                segment.tick_rate,
                end_timeout,
                cancellation,
            )
            .await?;
        let output = self.capture.stop_capture().await?;
        session.capture_maybe_active = false;
        let artifact = output.ok_or(RecordingError::OutputMissing)?;
        let destination = self.config.output_directory.join(&segment.output_file_name);
        let published = publish_capture_artifact(
            &artifact,
            &destination,
            self.config.maximum_clip_bytes,
            cancellation,
        )
        .await?;
        let path = published
            .path
            .to_str()
            .ok_or_else(|| RecordingError::OutputInvalid {
                path: published.path.clone(),
                reason: "managed output path is not valid Unicode".to_owned(),
            })?;
        Ok(RecordedClip {
            id: Uuid::new_v4(),
            path: path.to_owned(),
            title: segment.title.clone(),
            duration_seconds: planned_duration.as_secs_f64(),
            demo_id: Some(segment.demo_id),
            player_name: segment.player_name.clone(),
            category: segment.category.clone(),
            tags: segment.tags.clone(),
            metadata: json!({
                "player_id": segment.player_id,
                "start_tick": segment.start_tick,
                "end_tick": segment.end_tick,
                "tick_rate": segment.tick_rate,
                "bytes": published.bytes,
                "sha256": published.sha256,
                "custom": segment.metadata,
            }),
            created_at: Utc::now(),
        })
    }

    fn send(
        &self,
        process_id: u32,
        command: &ConsoleCommand,
        cancellation: &ProcessCancellation,
        stage: &'static str,
    ) -> RecordingResult<()> {
        if cancellation.is_cancelled() {
            return Err(RecordingError::Cancelled { stage });
        }
        self.game.send_command(process_id, command)
    }

    async fn cleanup_session(&mut self, session: &mut SessionState) -> Result<(), String> {
        let mut errors = Vec::new();
        if session.capture_maybe_active {
            match self.capture.stop_capture().await {
                Ok(_) => session.capture_maybe_active = false,
                Err(error) => errors.push(format!("stopping capture backend: {error}")),
            }
        }
        let mut cleanup_commands = session
            .restore_commands
            .drain(..)
            .rev()
            .map(|command| ("restoring capture setting", command))
            .collect::<Vec<_>>();
        cleanup_commands.extend([
            ("pausing playback", ConsoleCommand::Pause),
            ("disconnecting demo", ConsoleCommand::Disconnect),
        ]);
        for (label, command) in cleanup_commands {
            if let Err(error) = self.game.send_command(session.process_id, &command) {
                errors.push(format!("{label}: {error}"));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

#[derive(Debug)]
struct SessionState {
    process_id: u32,
    capture_maybe_active: bool,
    restore_commands: Vec<ConsoleCommand>,
}

fn validate_engine_config(config: &EngineConfig) -> RecordingResult<()> {
    if !config.cs2_executable.is_absolute() || !config.cs2_executable.is_file() {
        return Err(RecordingError::Preflight(
            "CS2 executable must be an existing absolute file".to_owned(),
        ));
    }
    let name = config
        .cs2_executable
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if !name.eq_ignore_ascii_case("cs2.exe") {
        return Err(RecordingError::Preflight(
            "Windows CS2 executable must be named cs2.exe".to_owned(),
        ));
    }
    let metadata = fs::symlink_metadata(&config.cs2_executable).map_err(|error| {
        io_error(
            "reading CS2 executable metadata",
            &config.cs2_executable,
            error,
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(RecordingError::Preflight(
            "CS2 executable must be a regular non-symlink file".to_owned(),
        ));
    }
    if config.launch_timeout.is_zero()
        || config.synchronization_timeout.is_zero()
        || config.maximum_segment_duration.is_zero()
        || config.maximum_demo_bytes < 8
        || config.maximum_clip_bytes == 0
        || config.preferred_process_id == Some(0)
    {
        return Err(RecordingError::InvalidInput(
            "recording engine limits are invalid".to_owned(),
        ));
    }
    Ok(())
}

fn validate_output_directory(path: &Path) -> RecordingResult<()> {
    if !path.is_absolute() || !path.is_dir() {
        return Err(RecordingError::Preflight(
            "recording output directory must be an existing absolute directory".to_owned(),
        ));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| io_error("reading output directory metadata", path, error))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return Err(RecordingError::Preflight(
            "recording output directory must not be a symlink".to_owned(),
        ));
    }
    let probe = path.join(format!(".recording-preflight-{}.tmp", Uuid::new_v4()));
    let result: RecordingResult<()> = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&probe)
            .map_err(|error| io_error("creating output directory probe", &probe, error))?;
        file.write_all(b"preflight")
            .and_then(|()| file.flush())
            .and_then(|()| file.sync_all())
            .map_err(|error| io_error("synchronizing output directory probe", &probe, error))?;
        Ok(())
    })();
    let cleanup = fs::remove_file(&probe);
    result?;
    cleanup.map_err(|error| io_error("removing output directory probe", &probe, error))
}

fn validate_segment(segment: &SegmentPlan, config: &EngineConfig) -> RecordingResult<()> {
    validate_demo(&segment.demo_path, config.maximum_demo_bytes)?;
    if segment.title.trim().is_empty()
        || segment.title.len() > 256
        || segment.title.chars().any(char::is_control)
        || segment.player_id.trim().is_empty()
        || segment.category.trim().is_empty()
        || segment.category.len() > 64
        || segment.category.chars().any(char::is_control)
        || segment.end_tick <= segment.start_tick
        || !segment.tick_rate.is_finite()
        || !(1.0..=256.0).contains(&segment.tick_rate)
    {
        return Err(RecordingError::InvalidInput(
            "segment title, player, ticks, or tick rate is invalid".to_owned(),
        ));
    }
    if segment.player_name.as_ref().is_some_and(|name| {
        name.trim().is_empty() || name.len() > 128 || name.chars().any(char::is_control)
    }) || segment.tags.len() > 32
        || segment
            .tags
            .iter()
            .any(|tag| tag.trim().is_empty() || tag.len() > 64 || tag.chars().any(char::is_control))
        || serde_json::to_vec(&segment.metadata).map_or(true, |bytes| bytes.len() > 256 * 1024)
    {
        return Err(RecordingError::InvalidInput(
            "segment player name, category, tags, or metadata exceeds its safety limit".to_owned(),
        ));
    }
    if planned_duration(segment)? > config.maximum_segment_duration {
        return Err(RecordingError::InvalidInput(
            "planned segment exceeds the configured duration limit".to_owned(),
        ));
    }
    validate_capture_metadata(segment)?;
    validate_output_file_name(&segment.output_file_name)?;
    Ok(())
}

fn validate_capture_metadata(segment: &SegmentPlan) -> RecordingResult<()> {
    let Some(capture) = segment.metadata.get("capture") else {
        return Ok(());
    };
    let capture = capture.as_object().ok_or_else(|| {
        RecordingError::InvalidInput("segment capture metadata must be an object".to_owned())
    })?;
    let _ = capture;
    for (target, restore) in capture_command_pairs(segment)? {
        vibe_cs_platform_windows::build_console_input(&target)?;
        vibe_cs_platform_windows::build_console_input(&restore)?;
    }
    Ok(())
}

fn capture_command_pairs(
    segment: &SegmentPlan,
) -> RecordingResult<Vec<(ConsoleCommand, ConsoleCommand)>> {
    let Some(capture) = segment.metadata.get("capture") else {
        return Ok(Vec::new());
    };
    let capture = capture.as_object().ok_or_else(|| {
        RecordingError::InvalidInput("segment capture metadata must be an object".to_owned())
    })?;
    let mut commands = Vec::new();
    let boolean_pair = |target: &str, restore: &str| -> RecordingResult<Option<(bool, bool)>> {
        if !capture.contains_key(target) {
            return Ok(None);
        }
        let target = capture.get(target).and_then(serde_json::Value::as_bool);
        let restore = capture.get(restore).and_then(serde_json::Value::as_bool);
        target.zip(restore).map(Some).ok_or_else(|| {
            RecordingError::InvalidInput(
                "capture changes require explicit boolean target and restore states".to_owned(),
            )
        })
    };
    let number_pair = |target: &str, restore: &str| -> RecordingResult<Option<(f64, f64)>> {
        if !capture.contains_key(target) {
            return Ok(None);
        }
        let target = capture.get(target).and_then(serde_json::Value::as_f64);
        let restore = capture.get(restore).and_then(serde_json::Value::as_f64);
        target.zip(restore).map(Some).ok_or_else(|| {
            RecordingError::InvalidInput(
                "capture changes require explicit numeric target and restore states".to_owned(),
            )
        })
    };
    if let Some((target, restore)) = boolean_pair("show_radar", "radar_restore_visible")? {
        commands.push((
            ConsoleCommand::RadarVisibility(target),
            ConsoleCommand::RadarVisibility(restore),
        ));
    }
    if let Some((target, restore)) = boolean_pair("show_hud", "hud_restore_visible")? {
        commands.push((
            ConsoleCommand::HudVisibility(target),
            ConsoleCommand::HudVisibility(restore),
        ));
    }
    if let Some((target, restore)) =
        boolean_pair("grenade_trajectory", "grenade_trajectory_restore")?
    {
        commands.push((
            ConsoleCommand::GrenadeTrajectory(target),
            ConsoleCommand::GrenadeTrajectory(restore),
        ));
    }
    if let Some((target, restore)) = number_pair("camera_fov", "camera_fov_restore")? {
        commands.push((
            ConsoleCommand::CameraFov(target),
            ConsoleCommand::CameraFov(restore),
        ));
    }
    if let Some((target, restore)) = number_pair("viewmodel_fov", "viewmodel_fov_restore")? {
        commands.push((
            ConsoleCommand::ViewmodelFov(target),
            ConsoleCommand::ViewmodelFov(restore),
        ));
    }
    if capture.contains_key("flash_alpha") {
        let target = capture
            .get("flash_alpha")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| u8::try_from(value).ok())
            .ok_or_else(|| {
                RecordingError::InvalidInput(
                    "flash alpha must be an integer from 0 to 255".to_owned(),
                )
            })?;
        let restore = capture
            .get("flash_alpha_restore")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| u8::try_from(value).ok())
            .ok_or_else(|| {
                RecordingError::InvalidInput(
                    "flash restore alpha must be an integer from 0 to 255".to_owned(),
                )
            })?;
        commands.push((
            ConsoleCommand::FlashAlpha(target),
            ConsoleCommand::FlashAlpha(restore),
        ));
    }
    let restore_volume = capture
        .get("voice_restore_volume")
        .and_then(serde_json::Value::as_f64);
    if capture
        .get("mute_voice")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        let restore = restore_volume.ok_or_else(|| {
            RecordingError::InvalidInput(
                "voice muting requires an explicit restore volume".to_owned(),
            )
        })?;
        commands.push((
            ConsoleCommand::VoiceVolume(0.0),
            ConsoleCommand::VoiceVolume(restore),
        ));
    }
    if capture
        .get("isolate_target_voice")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        let restore = restore_volume.ok_or_else(|| {
            RecordingError::InvalidInput(
                "voice isolation requires an explicit restore volume".to_owned(),
            )
        })?;
        let participants = capture
            .get("voice_participants")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| {
                RecordingError::InvalidInput(
                    "voice isolation requires evidence-backed participant identities".to_owned(),
                )
            })?;
        if participants.is_empty() || participants.len() > 64 {
            return Err(RecordingError::InvalidInput(
                "voice isolation requires 1..=64 participant identities".to_owned(),
            ));
        }
        for participant in participants {
            let player_id = participant.as_str().ok_or_else(|| {
                RecordingError::InvalidInput(
                    "voice participant identity must be a string".to_owned(),
                )
            })?;
            let target = if player_id == segment.player_id {
                1.0
            } else {
                0.0
            };
            commands.push((
                ConsoleCommand::VoicePlayerVolume {
                    player_id: player_id.to_owned(),
                    volume: target,
                },
                ConsoleCommand::VoicePlayerVolume {
                    player_id: player_id.to_owned(),
                    volume: restore,
                },
            ));
        }
    }
    Ok(commands)
}

fn validate_demo(path: &Path, maximum_bytes: u64) -> RecordingResult<()> {
    if !path.is_absolute()
        || path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("dem"))
    {
        return Err(RecordingError::InvalidInput(
            "demo must be an existing absolute .dem file".to_owned(),
        ));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| io_error("reading demo metadata", path, error))?;
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_file()
        || metadata.len() < 7
        || metadata.len() > maximum_bytes
    {
        return Err(RecordingError::InvalidInput(
            "demo must be a bounded regular non-symlink file".to_owned(),
        ));
    }
    let mut magic = [0_u8; 7];
    fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut magic))
        .map_err(|error| io_error("reading demo magic", path, error))?;
    if &magic != b"PBDEMS2" {
        return Err(RecordingError::InvalidInput(
            "demo does not contain the CS2 PBDEMS2 magic".to_owned(),
        ));
    }
    Ok(())
}

fn validate_output_file_name(name: &str) -> RecordingResult<()> {
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or_default();
    let reserved = matches!(
        stem.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    );
    let extension_allowed = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "mkv" | "mp4" | "mov" | "webm" | "flv"
            )
        });
    if name.is_empty()
        || name.len() > 240
        || path.file_name().and_then(|value| value.to_str()) != Some(name)
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || name.chars().any(char::is_control)
        || name.contains(['/', '\\', ':'])
        || name.ends_with(['.', ' '])
        || reserved
        || !extension_allowed
    {
        return Err(RecordingError::InvalidInput(
            "output must be one safe file name with a supported video extension".to_owned(),
        ));
    }
    Ok(())
}

fn validate_segment_commands(segment: &SegmentPlan) -> RecordingResult<()> {
    for command in [
        ConsoleCommand::PlayDemo(segment.demo_path.clone()),
        ConsoleCommand::Pause,
        ConsoleCommand::GoToTick(segment.start_tick),
        ConsoleCommand::SpectatePlayer(segment.player_id.clone()),
        ConsoleCommand::RadarVisibility(true),
        ConsoleCommand::RadarVisibility(false),
        ConsoleCommand::VoiceVolume(0.0),
        ConsoleCommand::VoiceVolume(1.0),
        ConsoleCommand::Resume,
        ConsoleCommand::Disconnect,
    ] {
        vibe_cs_platform_windows::build_console_input(&command)?;
    }
    for (target, restore) in capture_command_pairs(segment)? {
        vibe_cs_platform_windows::build_console_input(&target)?;
        vibe_cs_platform_windows::build_console_input(&restore)?;
    }
    Ok(())
}

fn planned_duration(segment: &SegmentPlan) -> RecordingResult<Duration> {
    let ticks =
        u32::try_from(segment.end_tick.saturating_sub(segment.start_tick)).map_err(|_| {
            RecordingError::InvalidInput("segment tick span exceeds the supported range".to_owned())
        })?;
    let ticks = f64::from(ticks);
    let seconds = ticks / segment.tick_rate;
    if !seconds.is_finite() || seconds <= 0.0 {
        return Err(RecordingError::InvalidInput(
            "planned segment duration is invalid".to_owned(),
        ));
    }
    Duration::try_from_secs_f64(seconds).map_err(|_| {
        RecordingError::InvalidInput("planned segment duration is out of range".to_owned())
    })
}

fn select_process(
    processes: &[vibe_cs_platform_windows::ProcessInfo],
    preferred: Option<u32>,
) -> RecordingResult<Option<u32>> {
    if processes.iter().any(|process| {
        process.process_id == 0 || !process.executable_name.eq_ignore_ascii_case("cs2.exe")
    }) {
        return Err(RecordingError::Preflight(
            "game controller returned an invalid CS2 process identity".to_owned(),
        ));
    }
    if let Some(preferred) = preferred {
        return processes
            .iter()
            .any(|process| process.process_id == preferred)
            .then_some(Some(preferred))
            .ok_or_else(|| {
                RecordingError::Preflight(format!(
                    "preferred CS2 process {preferred} is not running"
                ))
            });
    }
    match processes {
        [] => Ok(None),
        [process] => Ok(Some(process.process_id)),
        _ => Err(RecordingError::Preflight(
            "multiple CS2 processes are running; select one explicitly".to_owned(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    use async_trait::async_trait;
    use vibe_cs_platform_windows::ProcessInfo;

    use super::*;
    use crate::{CaptureArtifact, CaptureStatus};

    #[derive(Debug, Default)]
    struct MockGame {
        processes: Mutex<Vec<ProcessInfo>>,
        commands: Mutex<Vec<ConsoleCommand>>,
        launches: AtomicUsize,
    }

    #[async_trait]
    impl GameController for MockGame {
        fn discover_cs2(&self) -> RecordingResult<Vec<ProcessInfo>> {
            Ok(self.processes.lock().unwrap().clone())
        }

        async fn launch_cs2(
            &self,
            _executable: &Path,
            _policy: crate::LaunchPolicy,
            _timeout: Duration,
            _cancellation: &ProcessCancellation,
        ) -> RecordingResult<u32> {
            self.launches.fetch_add(1, Ordering::SeqCst);
            Ok(77)
        }

        fn send_command(&self, _process_id: u32, command: &ConsoleCommand) -> RecordingResult<()> {
            self.commands.lock().unwrap().push(command.clone());
            Ok(())
        }
    }

    #[derive(Debug)]
    struct MockCapture {
        active: bool,
        output: Option<PathBuf>,
        starts: usize,
        stops: usize,
        fail_start: bool,
    }

    #[async_trait]
    impl CaptureRecorder for MockCapture {
        async fn capture_status(&mut self) -> RecordingResult<CaptureStatus> {
            Ok(CaptureStatus {
                active: self.active,
                paused: false,
                timecode: None,
                artifact_path: self.output.clone(),
            })
        }

        async fn start_capture(&mut self) -> RecordingResult<()> {
            self.starts += 1;
            self.active = true;
            if self.fail_start {
                Err(RecordingError::Preflight(
                    "StartRecord acknowledgement was lost".to_owned(),
                ))
            } else {
                Ok(())
            }
        }

        async fn stop_capture(&mut self) -> RecordingResult<Option<CaptureArtifact>> {
            self.stops += 1;
            self.active = false;
            Ok(self.output.clone().map(|path| CaptureArtifact { path }))
        }
    }

    #[derive(Debug, Clone, Copy)]
    enum SyncMode {
        Normal,
        FailAtEnd,
        CancelAtEnd,
        WrongObserver,
    }

    #[derive(Debug)]
    struct MockSynchronizer {
        mode: SyncMode,
    }

    #[async_trait]
    impl PlaybackSynchronizer for MockSynchronizer {
        async fn confirm_demo_ready(
            &self,
            _demo_path: &Path,
            _timeout: Duration,
            _cancellation: &ProcessCancellation,
        ) -> RecordingResult<()> {
            Ok(())
        }

        async fn confirm_tick(
            &self,
            _tick: u64,
            _timeout: Duration,
            _cancellation: &ProcessCancellation,
        ) -> RecordingResult<()> {
            Ok(())
        }

        async fn confirm_observer(
            &self,
            player_id: &str,
            _timeout: Duration,
            _cancellation: &ProcessCancellation,
        ) -> RecordingResult<()> {
            if matches!(self.mode, SyncMode::WrongObserver) {
                Err(RecordingError::ObserverMismatch {
                    expected: player_id.to_owned(),
                    actual: "another-player".to_owned(),
                })
            } else {
                Ok(())
            }
        }

        async fn wait_until_tick(
            &self,
            _tick: u64,
            _tick_rate: f64,
            _timeout: Duration,
            cancellation: &ProcessCancellation,
        ) -> RecordingResult<()> {
            match self.mode {
                SyncMode::Normal | SyncMode::WrongObserver => Ok(()),
                SyncMode::FailAtEnd => Err(RecordingError::Preflight(
                    "playback evidence failed".to_owned(),
                )),
                SyncMode::CancelAtEnd => {
                    cancellation.cancel();
                    Err(RecordingError::Cancelled {
                        stage: "segment end tick",
                    })
                }
            }
        }
    }

    #[derive(Debug, Clone, Copy)]
    struct MockRecovery {
        clean: bool,
    }

    impl RecoveryGate for MockRecovery {
        fn recovery_status(&self) -> RecordingResult<RecoveryStatus> {
            if self.clean {
                Ok(RecoveryStatus::Clean)
            } else {
                Ok(RecoveryStatus::Pending {
                    transaction_id: Uuid::nil(),
                    restorable: true,
                    files: Vec::new(),
                })
            }
        }
    }

    struct Fixture {
        _root: tempfile::TempDir,
        config: EngineConfig,
        segment: SegmentPlan,
        capture_output: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let executable = root.path().join("cs2.exe");
            let demo = root.path().join("match.dem");
            let output = root.path().join("managed");
            let capture_output = root.path().join("capture.mkv");
            fs::write(&executable, b"stub").unwrap();
            fs::write(&demo, b"PBDEMS2 payload").unwrap();
            fs::create_dir(&output).unwrap();
            fs::write(&capture_output, b"recorded-video").unwrap();
            Self {
                config: EngineConfig::new(executable, output),
                segment: SegmentPlan {
                    demo_id: Uuid::new_v4(),
                    demo_path: demo,
                    title: "Round highlight".to_owned(),
                    player_id: "76561198000000000".to_owned(),
                    player_name: Some("Player".to_owned()),
                    spectator_slot: None,
                    verified_total_ticks: None,
                    start_tick: 100,
                    end_tick: 164,
                    tick_rate: 64.0,
                    output_file_name: "segment-a.mkv".to_owned(),
                    category: "highlight".to_owned(),
                    tags: vec!["test".to_owned()],
                    metadata: json!({"fixture": true}),
                },
                capture_output,
                _root: root,
            }
        }

        fn engine(
            &self,
            mode: SyncMode,
            output: Option<PathBuf>,
        ) -> RecordingEngine<MockGame, MockCapture, MockSynchronizer, MockRecovery> {
            RecordingEngine::new(
                self.config.clone(),
                MockGame::default(),
                MockCapture {
                    active: false,
                    output,
                    starts: 0,
                    stops: 0,
                    fail_start: false,
                },
                MockSynchronizer { mode },
                MockRecovery { clean: true },
            )
        }
    }

    #[tokio::test]
    async fn records_multiple_segments_with_one_launched_process() {
        let fixture = Fixture::new();
        let mut first = fixture.segment.clone();
        first.metadata = json!({"capture": {
            "show_radar": false,
            "radar_restore_visible": true,
            "mute_voice": true,
            "voice_restore_volume": 0.42,
            "camera_fov": 105.0,
            "camera_fov_restore": 90.0,
            "viewmodel_fov": 60.0,
            "viewmodel_fov_restore": 68.0,
            "flash_alpha": 96,
            "flash_alpha_restore": 255,
            "grenade_trajectory": true,
            "grenade_trajectory_restore": false,
            "show_hud": false,
            "hud_restore_visible": true,
            "isolate_target_voice": true,
            "voice_participants": ["76561198000000000", "76561198000000001"],
        }});
        let mut second = fixture.segment.clone();
        second.output_file_name = "segment-b.mkv".to_owned();
        second.start_tick = 200;
        second.end_tick = 264;
        let mut engine = fixture.engine(SyncMode::Normal, Some(fixture.capture_output.clone()));

        let clips = engine
            .record_segments(&[first, second], &ProcessCancellation::default())
            .await
            .unwrap();

        assert_eq!(clips.len(), 2);
        assert_eq!(engine.game.launches.load(Ordering::SeqCst), 1);
        assert_eq!(engine.capture.starts, 2);
        assert_eq!(engine.capture.stops, 2);
        assert!(Path::new(&clips[0].path).is_file());
        assert!(Path::new(&clips[1].path).is_file());
        assert_eq!(
            engine
                .game
                .commands
                .lock()
                .unwrap()
                .iter()
                .filter(|command| matches!(command, ConsoleCommand::PlayDemo(_)))
                .count(),
            2
        );
        let commands = engine.game.commands.lock().unwrap();
        assert!(commands.contains(&ConsoleCommand::RadarVisibility(false)));
        assert!(commands.contains(&ConsoleCommand::RadarVisibility(true)));
        assert!(commands.contains(&ConsoleCommand::VoiceVolume(0.0)));
        assert!(commands.contains(&ConsoleCommand::VoiceVolume(0.42)));
        assert!(commands.contains(&ConsoleCommand::CameraFov(105.0)));
        assert!(commands.contains(&ConsoleCommand::CameraFov(90.0)));
        assert!(commands.contains(&ConsoleCommand::ViewmodelFov(60.0)));
        assert!(commands.contains(&ConsoleCommand::ViewmodelFov(68.0)));
        assert!(commands.contains(&ConsoleCommand::FlashAlpha(96)));
        assert!(commands.contains(&ConsoleCommand::FlashAlpha(255)));
        assert!(commands.contains(&ConsoleCommand::GrenadeTrajectory(true)));
        assert!(commands.contains(&ConsoleCommand::GrenadeTrajectory(false)));
        assert!(commands.contains(&ConsoleCommand::HudVisibility(false)));
        assert!(commands.contains(&ConsoleCommand::HudVisibility(true)));
        assert!(commands.contains(&ConsoleCommand::VoicePlayerVolume {
            player_id: "76561198000000001".to_owned(),
            volume: 0.0,
        }));
        assert!(commands.contains(&ConsoleCommand::VoicePlayerVolume {
            player_id: "76561198000000001".to_owned(),
            volume: 0.42,
        }));
    }

    #[tokio::test]
    async fn capture_mutations_require_explicit_restore_values_during_preflight() {
        let fixture = Fixture::new();
        let mut segment = fixture.segment.clone();
        segment.metadata = json!({"capture": {
            "show_radar": false,
            "mute_voice": true,
        }});
        let mut engine = fixture.engine(SyncMode::Normal, Some(fixture.capture_output.clone()));

        let error = engine
            .preflight(std::slice::from_ref(&segment))
            .await
            .expect_err("restore metadata must be required");

        assert!(matches!(error, RecordingError::InvalidInput(_)));
        assert!(engine.game.commands.lock().unwrap().is_empty());
        assert_eq!(engine.capture.starts, 0);
    }

    #[tokio::test]
    async fn playback_error_after_start_always_stops_capture() {
        let fixture = Fixture::new();
        let mut engine = fixture.engine(SyncMode::FailAtEnd, Some(fixture.capture_output.clone()));
        let result = engine
            .record_segments(
                std::slice::from_ref(&fixture.segment),
                &ProcessCancellation::default(),
            )
            .await;
        assert!(result.is_err());
        assert_eq!(engine.capture.starts, 1);
        assert_eq!(engine.capture.stops, 1);
        assert!(!engine.capture.active);
    }

    #[tokio::test]
    async fn ambiguous_start_failure_still_attempts_capture_stop() {
        let fixture = Fixture::new();
        let mut engine = fixture.engine(SyncMode::Normal, Some(fixture.capture_output.clone()));
        engine.capture.fail_start = true;
        let result = engine
            .record_segments(
                std::slice::from_ref(&fixture.segment),
                &ProcessCancellation::default(),
            )
            .await;
        assert!(result.is_err());
        assert_eq!(engine.capture.starts, 1);
        assert_eq!(engine.capture.stops, 1);
        assert!(!engine.capture.active);
    }

    #[tokio::test]
    async fn cancellation_after_start_always_stops_capture() {
        let fixture = Fixture::new();
        let mut engine =
            fixture.engine(SyncMode::CancelAtEnd, Some(fixture.capture_output.clone()));
        let cancellation = ProcessCancellation::default();
        let result = engine
            .record_segments(std::slice::from_ref(&fixture.segment), &cancellation)
            .await;
        assert!(matches!(result, Err(RecordingError::Cancelled { .. })));
        assert!(cancellation.is_cancelled());
        assert_eq!(engine.capture.stops, 1);
        assert!(!engine.capture.active);
    }

    #[tokio::test]
    async fn wrong_observer_is_rejected_before_recording() {
        let fixture = Fixture::new();
        let mut engine = fixture.engine(
            SyncMode::WrongObserver,
            Some(fixture.capture_output.clone()),
        );
        let result = engine
            .record_segments(
                std::slice::from_ref(&fixture.segment),
                &ProcessCancellation::default(),
            )
            .await;
        assert!(matches!(
            result,
            Err(RecordingError::ObserverMismatch { .. })
        ));
        assert_eq!(engine.capture.starts, 0);
        assert_eq!(engine.capture.stops, 0);
    }

    #[tokio::test]
    async fn missing_capture_artifact_is_an_explicit_error() {
        let fixture = Fixture::new();
        let mut engine = fixture.engine(SyncMode::Normal, None);
        let result = engine
            .record_segments(
                std::slice::from_ref(&fixture.segment),
                &ProcessCancellation::default(),
            )
            .await;
        assert!(matches!(result, Err(RecordingError::OutputMissing)));
        assert_eq!(engine.capture.stops, 1);
    }

    #[tokio::test]
    async fn pending_recovery_fails_preflight_without_external_actions() {
        let fixture = Fixture::new();
        let mut engine = RecordingEngine::new(
            fixture.config.clone(),
            MockGame::default(),
            MockCapture {
                active: false,
                output: Some(fixture.capture_output.clone()),
                starts: 0,
                stops: 0,
                fail_start: false,
            },
            MockSynchronizer {
                mode: SyncMode::Normal,
            },
            MockRecovery { clean: false },
        );
        assert!(matches!(
            engine
                .preflight(std::slice::from_ref(&fixture.segment))
                .await,
            Err(RecordingError::RecoveryPending)
        ));
        assert_eq!(engine.capture.starts, 0);
        assert_eq!(engine.game.launches.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn active_capture_fails_preflight_without_launching_cs2() {
        let fixture = Fixture::new();
        let mut engine = fixture.engine(SyncMode::Normal, Some(fixture.capture_output.clone()));
        engine.capture.active = true;
        let error = engine
            .preflight(std::slice::from_ref(&fixture.segment))
            .await
            .expect_err("an active capture must fail preflight");
        assert!(error.is_capture_busy());
        assert_eq!(engine.capture.starts, 0);
        assert_eq!(engine.game.launches.load(Ordering::SeqCst), 0);
    }
}
