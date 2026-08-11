use std::{collections::BTreeMap, path::PathBuf};

use serde::{Deserialize, Serialize};

/// Current stable JSON contract understood by the HLAE planner.
pub const HLAE_PLAN_SCHEMA_VERSION: u32 = 2;
/// Current integrity-manifest contract for a completed exported bundle.
pub const HLAE_BUNDLE_MANIFEST_SCHEMA_VERSION: u32 = 1;
pub const HLAE_BUNDLE_MANIFEST_FILE: &str = "vibe_cs_bundle.complete.json";
pub const HLAE_BUNDLE_MANIFEST_PRODUCER: &str = "vibe-cs-hlae";
pub const HLAE_BUNDLE_README_FILE: &str = "README.txt";
pub const HLAE_BUNDLE_LAUNCH_PROFILE_FILE: &str = "vibe_cs_launch_profile.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HlaeInstallation {
    pub root: PathBuf,
    pub executable: PathBuf,
    pub source2_hook: PathBuf,
    pub source: HlaeDiscoverySource,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HlaeDiscoverySource {
    Configured,
    CommonLocation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HlaeDiscovery {
    pub installation: Option<HlaeInstallation>,
    pub checked_locations: Vec<PathBuf>,
    pub messages: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HlaePlanMode {
    /// Loads and draws camera paths without starting a recording.
    Preview,
    /// Records lossless image sequences and optional WAV audio.
    Capture,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PositionInterpolation {
    Linear,
    Cubic,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RotationInterpolation {
    SphericalLinear,
    SphericalCubic,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CameraPosition {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CameraRotation {
    pub pitch: f64,
    pub yaw: f64,
    pub roll: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CameraKeyframe {
    pub tick: u64,
    pub position: CameraPosition,
    pub rotation: CameraRotation,
    pub fov: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CameraShot {
    /// Stable ASCII identifier used only to derive artifact file names.
    pub id: String,
    pub start_tick: u64,
    pub end_tick: u64,
    pub position_interpolation: PositionInterpolation,
    pub rotation_interpolation: RotationInterpolation,
    pub keyframes: Vec<CameraKeyframe>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CaptureLayers {
    /// Final game presentation, including Panorama UI when visible.
    pub screen: bool,
    /// A normal stream captured before Panorama UI.
    pub world: bool,
    /// A floating-point, grayscale linear depth stream.
    pub depth: bool,
}

impl Default for CaptureLayers {
    fn default() -> Self {
        Self {
            screen: true,
            world: false,
            depth: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CaptureSettings {
    pub fps: u32,
    pub width: u32,
    pub height: u32,
    pub record_wav: bool,
    pub layers: CaptureLayers,
}

impl Default for CaptureSettings {
    fn default() -> Self {
        Self {
            fps: 60,
            width: 1920,
            height: 1080,
            record_wav: true,
            layers: CaptureLayers::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct HlaePlan {
    pub schema_version: u32,
    pub mode: HlaePlanMode,
    /// Tick rate parsed from the selected demo. Camera times are derived from
    /// this evidence instead of assuming a 64 tick demo.
    pub tick_rate: f64,
    /// Existing local `.dem` file selected by the user.
    pub demo_path: PathBuf,
    /// Absolute output directory consumed by HLAE's recording system.
    pub output_directory: PathBuf,
    /// Number of demo ticks to seek before the first scheduled command.
    pub pre_roll_ticks: u64,
    pub capture: CaptureSettings,
    pub shots: Vec<CameraShot>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HlaeNoticeCode {
    ShortKeyframeGap,
    ShotGap,
    PreviewDoesNotRecord,
    CaptureProducesImageSequences,
    CameraCollisionNotChecked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HlaeNotice {
    pub code: HlaeNoticeCode,
    pub message: String,
    pub shot_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedArtifact {
    pub path: PathBuf,
    pub media_type: String,
    pub contents: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompiledHlaePlan {
    pub schema_version: u32,
    pub mode: HlaePlanMode,
    pub first_tick: u64,
    pub last_tick: u64,
    pub bootstrap_config: GeneratedArtifact,
    pub command_system: GeneratedArtifact,
    pub camera_paths: Vec<GeneratedArtifact>,
    pub notices: Vec<HlaeNotice>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportedHlaePlan {
    pub directory: PathBuf,
    pub files: Vec<PathBuf>,
    pub completion_marker: PathBuf,
    pub compiled: CompiledHlaePlan,
}

/// One immutable artifact covered by the bundle completion manifest.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HlaeBundleArtifactManifest {
    /// Safe direct-child path relative to the bundle directory.
    pub path: String,
    pub size: u64,
    /// Lower-case SHA-256 encoded as exactly 64 hexadecimal characters.
    pub sha256: String,
}

/// Written and synchronized only after every planner artifact is durable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HlaeBundleManifest {
    pub schema_version: u32,
    pub state: String,
    pub producer: String,
    pub artifacts: Vec<HlaeBundleArtifactManifest>,
}

/// Trusted local inputs used to produce a typed, process-free handoff.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HlaeBundleLaunchInputs {
    pub installation: HlaeInstallation,
    pub game_executable: PathBuf,
    pub resolution: LaunchResolution,
}

/// Reviewable launch fields and offline-only consumption instructions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HlaeBundleLaunchHandoff {
    pub schema_version: u32,
    pub launch_profile: HlaeLaunchProfile,
    pub demo_path: PathBuf,
    pub bootstrap_config: String,
    pub instructions: Vec<String>,
}

/// Values to enter into HLAE's official CS2 launcher / custom loader UI.
///
/// Arguments remain separate values so downstream callers do not need a shell.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HlaeLaunchProfile {
    pub hlae_executable: PathBuf,
    pub hook_library: PathBuf,
    pub game_executable: PathBuf,
    pub arguments: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub safety: HlaeSafetyPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HlaeSafetyPolicy {
    pub insecure_mode_required: bool,
    pub vac_servers_prohibited: bool,
    pub demo_playback_only: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResolution {
    pub width: u32,
    pub height: u32,
}
