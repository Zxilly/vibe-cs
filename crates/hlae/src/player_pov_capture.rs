//! Closed compiler for deterministic player-POV movie capture.
//!
//! This is intentionally separate from the cinematic camera-plan compiler:
//! player POV must never be represented by invented camera coordinates.

use std::{fmt::Write as _, fs, path::Path};

use crate::{
    CaptureLayers, CaptureSettings, GeneratedArtifact, HLAE_TAKE_MAX_ESTIMATED_BYTES,
    HlaeCaptureResourceEstimate, HlaeError, HlaeHudVisibility, HlaeRadarVisibility,
    HlaeScenePresentation, HlaeVoicePolicy, estimate_hlae_capture_span_resources,
    scene_presentation::{SCENE_RESET_COMMANDS, bounded_decimal, scene_setup_commands},
    validate::validate_safe_path,
};

/// Fixed file name consumed by the managed-session bootstrap.
pub const HLAE_MANAGED_COMMAND_SYSTEM_FILE_NAME: &str = "vibe_cs_commands.xml";
const MAXIMUM_TICK: u64 = i32::MAX as u64;
const MAXIMUM_COMMAND_SYSTEM_BYTES: usize = 64 * 1_024;

/// Closed, typed presentation controls supported by the managed CS2 movie
/// session. Every field compiles to a fixed command grammar; callers cannot
/// inject free-form console input.
///
/// The four style-independent controls are the same ones
/// [`HlaeScenePresentation`] carries, and they compile through that one shared
/// generator. Only `camera_fov` and `viewmodel_fov` are specific to a
/// first-person take.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HlaePlayerPovPresentation {
    pub radar: HlaeRadarVisibility,
    pub hud: HlaeHudVisibility,
    pub camera_fov: f64,
    pub viewmodel_fov: f64,
    /// Desired remaining flash alpha in the CS2 0..=255 scale.
    pub flash_alpha: u8,
    pub voice: HlaeVoicePolicy,
}

impl Default for HlaePlayerPovPresentation {
    fn default() -> Self {
        Self {
            radar: HlaeRadarVisibility::Visible,
            hud: HlaeHudVisibility::Visible,
            camera_fov: 90.0,
            viewmodel_fov: 68.0,
            flash_alpha: u8::MAX,
            voice: HlaeVoicePolicy::AllPlayers,
        }
    }
}

impl HlaePlayerPovPresentation {
    /// The style-independent half of this presentation.
    ///
    /// `voice_target_slot` is the parser-backed spectator slot the recorded
    /// player occupies; [`HlaeVoicePolicy::TargetOnly`] cannot compile without
    /// it. A first-person plan always knows the slot, so it passes `Some`.
    #[must_use]
    pub const fn scene(self, voice_target_slot: Option<u8>) -> HlaeScenePresentation {
        HlaeScenePresentation {
            radar: self.radar,
            hud: self.hud,
            flash_alpha: self.flash_alpha,
            voice: self.voice,
            voice_target_slot,
        }
    }
}

/// Trusted fields required to record one bounded first-person player view.
#[derive(Debug, Clone, PartialEq)]
pub struct HlaePlayerPovCapturePlan {
    pub demo_path: std::path::PathBuf,
    pub output_directory: std::path::PathBuf,
    /// Parser-verified player identifier passed only to the fixed
    /// evidence metadata. It is never sent to the game console.
    pub player_id: String,
    /// Parser-backed CS2 spectator slot (`userinfo.userid + 1`) used by the
    /// fixed `spec_player` command.
    pub spectator_slot: u8,
    pub start_tick: u64,
    pub end_tick: u64,
    pub pre_roll_ticks: u64,
    pub tick_rate: f64,
    pub capture: CaptureSettings,
    pub presentation: HlaePlayerPovPresentation,
}

/// Immutable program accepted by the managed HLAE runtime.
///
/// Fields stay private so runtime code cannot smuggle arbitrary console text
/// into a capture session.
#[derive(Debug, Clone, PartialEq)]
pub struct CompiledHlaePlayerPovCapture {
    demo_path: std::path::PathBuf,
    output_directory: std::path::PathBuf,
    player_id: String,
    spectator_slot: u8,
    seek_tick: u32,
    setup_tick: u32,
    first_tick: u32,
    last_tick: u32,
    tick_rate: f64,
    capture: CaptureSettings,
    command_system: GeneratedArtifact,
    resource_estimate: HlaeCaptureResourceEstimate,
}

impl CompiledHlaePlayerPovCapture {
    #[must_use]
    pub fn demo_path(&self) -> &Path {
        &self.demo_path
    }

    #[must_use]
    pub fn output_directory(&self) -> &Path {
        &self.output_directory
    }

    #[must_use]
    pub fn player_id(&self) -> &str {
        &self.player_id
    }

    #[must_use]
    pub const fn spectator_slot(&self) -> u8 {
        self.spectator_slot
    }

    #[must_use]
    pub const fn seek_tick(&self) -> u32 {
        self.seek_tick
    }

    /// Returns the tick used to establish first-person spectator state before
    /// capture. It is deliberately the first tick after seek, distinct from
    /// both the seek and record ticks: CS2 can ignore `spec_player` when it
    /// shares a seek tick, and one tick immediately before recording does not
    /// leave enough deterministic time for observer identity to settle.
    #[must_use]
    pub const fn setup_tick(&self) -> u32 {
        self.setup_tick
    }

    #[must_use]
    pub const fn first_tick(&self) -> u32 {
        self.first_tick
    }

    #[must_use]
    pub const fn last_tick(&self) -> u32 {
        self.last_tick
    }

    #[must_use]
    pub const fn tick_rate(&self) -> f64 {
        self.tick_rate
    }

    #[must_use]
    pub const fn capture(&self) -> &CaptureSettings {
        &self.capture
    }

    #[must_use]
    pub const fn command_system(&self) -> &GeneratedArtifact {
        &self.command_system
    }

    /// Player POV does not produce cinematic camera-path artifacts.
    #[must_use]
    pub const fn camera_paths(&self) -> &[GeneratedArtifact] {
        &[]
    }

    #[must_use]
    pub const fn resource_estimate(&self) -> HlaeCaptureResourceEstimate {
        self.resource_estimate
    }
}

/// Compiles one player-POV plan into a fixed `mirv_cmd` schedule.
///
/// The compiler accepts no free-form console command. The current contract is
/// screen-only because the native encoder consumes one screen TGA sequence;
/// world/depth layers require a separate typed product contract.
///
/// # Errors
///
/// Returns [`HlaeError`] for unsafe or missing paths, an untrusted player ID,
/// unsupported capture settings, invalid ticks, or resource-budget overflow.
pub fn compile_hlae_player_pov_capture(
    plan: &HlaePlayerPovCapturePlan,
    artifact_directory: &Path,
) -> Result<CompiledHlaePlayerPovCapture, HlaeError> {
    validate_player_pov_plan(plan, artifact_directory)?;
    let first_tick = u32::try_from(plan.start_tick)
        .map_err(|_| invalid_error("capture start tick is unsupported"))?;
    let last_tick = u32::try_from(plan.end_tick)
        .map_err(|_| invalid_error("capture end tick is unsupported"))?;
    let pre_roll_ticks = u32::try_from(plan.pre_roll_ticks)
        .map_err(|_| invalid_error("capture pre-roll is unsupported"))?;
    let seek_tick = first_tick.saturating_sub(pre_roll_ticks);
    let setup_tick = seek_tick + 1;
    let resource_estimate =
        estimate_hlae_capture_span_resources(first_tick, last_tick, plan.tick_rate, &plan.capture)?;
    if resource_estimate.total_bytes > HLAE_TAKE_MAX_ESTIMATED_BYTES {
        return Err(invalid_error(format!(
            "capture exceeds the {HLAE_TAKE_MAX_ESTIMATED_BYTES} byte staging budget"
        )));
    }

    let contents = compile_player_pov_command_system(plan, setup_tick)?;
    if contents.len() > MAXIMUM_COMMAND_SYSTEM_BYTES {
        return Err(invalid_error(
            "player POV command system exceeds its 64 KiB limit",
        ));
    }
    Ok(CompiledHlaePlayerPovCapture {
        demo_path: plan.demo_path.clone(),
        output_directory: plan.output_directory.clone(),
        player_id: plan.player_id.clone(),
        spectator_slot: plan.spectator_slot,
        seek_tick,
        setup_tick,
        first_tick,
        last_tick,
        tick_rate: plan.tick_rate,
        capture: plan.capture.clone(),
        command_system: GeneratedArtifact {
            path: artifact_directory.join(HLAE_MANAGED_COMMAND_SYSTEM_FILE_NAME),
            media_type: "application/xml".to_owned(),
            contents,
        },
        resource_estimate,
    })
}

fn validate_player_pov_plan(
    plan: &HlaePlayerPovCapturePlan,
    artifact_directory: &Path,
) -> Result<(), HlaeError> {
    validate_regular_path(&plan.demo_path, "demoPath", false)?;
    validate_regular_path(&plan.output_directory, "outputDirectory", true)?;
    validate_regular_path(artifact_directory, "artifactDirectory", true)?;
    if !plan
        .demo_path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("dem"))
    {
        return invalid("demoPath must have a .dem extension");
    }
    if plan.player_id.len() != 17
        || !plan.player_id.bytes().all(|byte| byte.is_ascii_digit())
        || !matches!(plan.player_id.parse::<u64>(), Ok(value) if value != 0)
    {
        return invalid("playerId must be a canonical non-zero 17-digit SteamID64");
    }
    if !(1..=64).contains(&plan.spectator_slot) {
        return invalid("spectatorSlot must be a parser-backed value between 1 and 64");
    }
    if plan.start_tick <= 1 || plan.start_tick >= plan.end_tick || plan.end_tick > MAXIMUM_TICK {
        return invalid("player POV capture has an invalid tick range");
    }
    if plan.pre_roll_ticks < 2
        || plan.pre_roll_ticks > MAXIMUM_TICK
        || plan.start_tick.saturating_sub(plan.pre_roll_ticks) >= plan.start_tick - 1
    {
        return invalid("player POV capture requires a distinct pre-roll and setup tick");
    }
    if !plan.tick_rate.is_finite() || !(1.0..=256.0).contains(&plan.tick_rate) {
        return invalid("tickRate must be finite and between 1 and 256");
    }
    if !(1..=1_000).contains(&plan.capture.fps) {
        return invalid("capture fps must be between 1 and 1000");
    }
    if !(320..=4_096).contains(&plan.capture.width)
        || !(240..=2_304).contains(&plan.capture.height)
        || !plan.capture.width.is_multiple_of(2)
        || !plan.capture.height.is_multiple_of(2)
    {
        return invalid("capture dimensions must be even and within the native MP4 pipeline range");
    }
    if plan.capture.layers
        != (CaptureLayers {
            screen: true,
            world: false,
            depth: false,
        })
    {
        return invalid("managed player POV capture is screen-only");
    }
    if !plan.presentation.camera_fov.is_finite()
        || !(60.0..=140.0).contains(&plan.presentation.camera_fov)
    {
        return invalid("camera FOV must be finite and between 60 and 140");
    }
    if !plan.presentation.viewmodel_fov.is_finite()
        || !(54.0..=68.0).contains(&plan.presentation.viewmodel_fov)
    {
        return invalid("viewmodel FOV must be finite and between 54 and 68");
    }
    Ok(())
}

fn validate_regular_path(
    path: &Path,
    field: &'static str,
    directory: bool,
) -> Result<(), HlaeError> {
    validate_safe_path(path, field, true)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| HlaeError::ArtifactIo {
        operation: "inspect player POV capture path",
        message: error.to_string(),
    })?;
    if metadata.file_type().is_symlink()
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        return invalid(format!("{field} must be a regular non-link path"));
    }
    Ok(())
}

fn compile_player_pov_command_system(
    plan: &HlaePlayerPovCapturePlan,
    setup_tick: u32,
) -> Result<String, HlaeError> {
    let presentation = compile_presentation_setup(plan)?;
    let spectator = format!(
        "mirv_campath enabled 0; mirv_campath draw enabled 0; spec_mode 2; spec_player {}; {presentation}",
        plan.spectator_slot,
    );
    let capture_start = format!(
        "demo_ui_mode 0; gameui_hide; cl_showdemooverlay 0; spec_autodirector 0; spec_show_xray 0; mirv_streams record name \"{}\"; mirv_streams record fps {}; mirv_streams record startMovieWav {}; mirv_streams settings edit afxDefault settings afxClassic; mirv_streams record screen enabled 1; mirv_streams record start",
        console_path(&plan.output_directory),
        plan.capture.fps,
        u8::from(plan.capture.record_wav),
    );
    let capture_stop = format!(
        "mirv_streams record end; demo_pause; mirv_streams record screen enabled 0; mirv_fov default; mirv_viewmodel enabled 0; {SCENE_RESET_COMMANDS}"
    );
    let mut xml =
        String::from("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<commandSystem>\n<commands>\n");
    for (tick, command) in [
        (u64::from(setup_tick), spectator.as_str()),
        (plan.start_tick, capture_start.as_str()),
        (plan.end_tick, capture_stop.as_str()),
    ] {
        writeln!(
            xml,
            "<c tick=\"{tick}\"><body>{}</body></c>",
            xml_text(command)
        )
        .expect("writing to String cannot fail");
    }
    xml.push_str("</commands>\n</commandSystem>\n");
    Ok(xml)
}

fn compile_presentation_setup(plan: &HlaePlayerPovCapturePlan) -> Result<String, HlaeError> {
    let presentation = plan.presentation;
    // The four style-independent controls come from the one shared generator,
    // so a first-person take and an observer take can never drift apart.
    let scene = scene_setup_commands(presentation.scene(Some(plan.spectator_slot)))?;
    Ok(format!(
        "{scene}; mirv_fov handleZoom minUnzoomedFov 90; mirv_fov handleZoom enabled 1; mirv_fov {}; mirv_viewmodel set * * * {} *; mirv_viewmodel enabled 1",
        bounded_decimal(presentation.camera_fov),
        bounded_decimal(presentation.viewmodel_fov),
    ))
}

fn console_path(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\")
}

fn xml_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn invalid<T>(message: impl Into<String>) -> Result<T, HlaeError> {
    Err(invalid_error(message))
}

fn invalid_error(message: impl Into<String>) -> HlaeError {
    HlaeError::InvalidPlan(message.into())
}
