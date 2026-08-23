use std::{collections::BTreeMap, path::PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::HlaeScenePresentation;

pub const HLAE_BUNDLE_MANIFEST_FILE: &str = "vibe_cs_bundle.complete.json";
pub const HLAE_BUNDLE_MANIFEST_PRODUCER: &str = "vibe-cs-hlae";
pub const HLAE_BUNDLE_README_FILE: &str = "README.txt";
pub const HLAE_BUNDLE_LAUNCH_PROFILE_FILE: &str = "vibe_cs_launch_profile.json";

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HlaeInstallation {
    pub root: PathBuf,
    pub executable: PathBuf,
    pub source2_hook: PathBuf,
    pub source: HlaeDiscoverySource,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HlaeDiscoverySource {
    Managed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HlaeDiscovery {
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub installation: Option<HlaeInstallation>,
    pub checked_locations: Vec<PathBuf>,
    pub messages: Vec<String>,
}

/// Whether a compiled plan only draws its camera paths or records frames.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum HlaePlanMode {
    /// Loads and draws camera paths without starting a recording.
    Preview,
    /// Records lossless image sequences and optional WAV audio.
    Capture,
}

/// How camera positions are interpolated between two keyframes.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PositionInterpolation {
    Linear,
    Cubic,
}

/// How camera orientations are interpolated between two keyframes.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RotationInterpolation {
    SphericalLinear,
    SphericalCubic,
}

/// A camera location in CS2 world coordinates.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct CameraPosition {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// A camera orientation in degrees.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct CameraRotation {
    pub pitch: f64,
    pub yaw: f64,
    pub roll: f64,
}

/// One sampled camera state, anchored to a demo tick.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct CameraKeyframe {
    pub tick: u64,
    pub position: CameraPosition,
    pub rotation: CameraRotation,
    /// Horizontal field of view at this keyframe, in degrees.
    pub fov: f64,
}

/// One camera path covering a closed tick window.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct CameraShot {
    /// Stable ASCII identifier used only to derive artifact file names.
    pub id: String,
    pub start_tick: u64,
    pub end_tick: u64,
    pub position_interpolation: PositionInterpolation,
    pub rotation_interpolation: RotationInterpolation,
    pub keyframes: Vec<CameraKeyframe>,
}

/// The image streams HLAE writes for a capture.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
#[ts(export)]
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

/// Resolution, frame rate and streams for one capture.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
#[ts(export)]
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

/// The closed camera-plan contract. This is exactly what an HLAE proposal
/// preview carries in `typed_plan`, and exactly what an export compiles.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct HlaePlan {
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
    /// Radar, HUD, flash and voice for the whole capture. These four controls
    /// describe the recorded scene rather than the camera, so an observer take
    /// honours them exactly as a first-person take does.
    ///
    /// `#[serde(default)]` keeps every plan document written before the field
    /// existed readable, and the default is the neutral, unchanged scene.
    #[serde(default)]
    pub presentation: HlaeScenePresentation,
    pub shots: Vec<CameraShot>,
}

/// The closed set of non-blocking review notices a plan can raise.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum HlaeNoticeCode {
    ShortKeyframeGap,
    ShotGap,
    PreviewDoesNotRecord,
    CaptureProducesImageSequences,
    CameraCollisionNotChecked,
}

/// One review notice. The English `message` is the free half; `code` is what a
/// client looks up.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct HlaeNotice {
    pub code: HlaeNoticeCode,
    pub message: String,
    /// The shot this notice speaks about, when it speaks about only one.
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub shot_id: Option<String>,
}

/// One file a compiled plan would write, with its full contents.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct GeneratedArtifact {
    pub path: PathBuf,
    pub media_type: String,
    pub contents: String,
}

/// A dry-run bundle: every artifact a plan would produce, before anything is
/// written. This is what an HLAE proposal preview carries in `compiled_preview`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct CompiledHlaePlan {
    pub mode: HlaePlanMode,
    pub first_tick: u64,
    pub last_tick: u64,
    pub bootstrap_config: GeneratedArtifact,
    pub command_system: GeneratedArtifact,
    pub camera_paths: Vec<GeneratedArtifact>,
    pub notices: Vec<HlaeNotice>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
    /// Existing Steam client executable used to reproduce HLAE's official
    /// Source 2 launch environment without relying on inherited variables.
    pub steam_executable: PathBuf,
    /// Existing active Steam user's CS2 configuration directory. Managed
    /// launches snapshot this directory into their disposable HLAE root and
    /// never write through to the source.
    #[serde(default)]
    pub user_config_directory: Option<PathBuf>,
    pub resolution: LaunchResolution,
}

/// Reviewable launch fields and offline-only consumption instructions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HlaeBundleLaunchHandoff {
    pub launch_profile: HlaeLaunchProfile,
    pub demo_path: PathBuf,
    pub bootstrap_config: String,
    pub instructions: Vec<String>,
}

/// Values to enter into HLAE's official CS2 launcher / custom loader UI.
///
/// Arguments remain separate values so downstream callers do not need a shell.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HlaeLaunchProfile {
    pub hlae_executable: PathBuf,
    pub hook_library: PathBuf,
    pub game_executable: PathBuf,
    pub arguments: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub safety: HlaeSafetyPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HlaeSafetyPolicy {
    pub insecure_mode_required: bool,
    pub vac_servers_prohibited: bool,
    pub demo_playback_only: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchResolution {
    pub width: u32,
    pub height: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_hlae_documents_reject_fields_outside_the_current_contract() {
        let installation = HlaeInstallation {
            root: PathBuf::from("C:/VibeCS/hlae"),
            executable: PathBuf::from("C:/VibeCS/hlae/HLAE.exe"),
            source2_hook: PathBuf::from("C:/VibeCS/hlae/AfxHookSource2.dll"),
            source: HlaeDiscoverySource::Managed,
        };
        let inputs = HlaeBundleLaunchInputs {
            installation,
            game_executable: PathBuf::from("C:/Steam/cs2.exe"),
            steam_executable: PathBuf::from("C:/Steam/steam.exe"),
            user_config_directory: None,
            resolution: LaunchResolution {
                width: 1_920,
                height: 1_080,
            },
        };
        let current = serde_json::to_value(inputs).expect("serialize current launch inputs");

        for pointer in ["/installation", "/resolution"] {
            let mut invalid = current.clone();
            invalid.pointer_mut(pointer).expect("nested HLAE node")["retiredField"] =
                serde_json::json!(true);
            assert!(
                serde_json::from_value::<HlaeBundleLaunchInputs>(invalid).is_err(),
                "unknown field at {pointer} must be rejected"
            );
        }
        let mut prior_launch_inputs = current;
        prior_launch_inputs
            .as_object_mut()
            .expect("launch inputs object")
            .remove("userConfigDirectory");
        assert!(
            serde_json::from_value::<HlaeBundleLaunchInputs>(prior_launch_inputs)
                .expect("launch inputs written before user config inheritance remain readable")
                .user_config_directory
                .is_none()
        );

        let discovery = HlaeDiscovery {
            installation: None,
            checked_locations: Vec::new(),
            messages: Vec::new(),
        };
        let mut missing_installation =
            serde_json::to_value(discovery).expect("serialize current discovery");
        missing_installation
            .as_object_mut()
            .expect("discovery object")
            .remove("installation");
        assert!(serde_json::from_value::<HlaeDiscovery>(missing_installation).is_err());

        let compiled = CompiledHlaePlan {
            mode: HlaePlanMode::Preview,
            first_tick: 1,
            last_tick: 2,
            bootstrap_config: GeneratedArtifact {
                path: PathBuf::from("bootstrap.cfg"),
                media_type: "text/plain".to_owned(),
                contents: "exec".to_owned(),
            },
            command_system: GeneratedArtifact {
                path: PathBuf::from("commands.xml"),
                media_type: "application/xml".to_owned(),
                contents: "<commandSystem/>".to_owned(),
            },
            camera_paths: Vec::new(),
            notices: vec![HlaeNotice {
                code: HlaeNoticeCode::PreviewDoesNotRecord,
                message: "preview".to_owned(),
                shot_id: None,
            }],
        };
        let current = serde_json::to_value(compiled).expect("serialize current compiled plan");
        for pointer in ["/bootstrapConfig", "/notices/0"] {
            let mut invalid = current.clone();
            invalid.pointer_mut(pointer).expect("nested compiled node")["retiredField"] =
                serde_json::json!(true);
            assert!(
                serde_json::from_value::<CompiledHlaePlan>(invalid).is_err(),
                "unknown field at {pointer} must be rejected"
            );
        }
        let mut missing_notice_target = current;
        missing_notice_target["notices"][0]
            .as_object_mut()
            .expect("notice object")
            .remove("shotId");
        assert!(serde_json::from_value::<CompiledHlaePlan>(missing_notice_target).is_err());
    }
}
