//! Saved recording shot settings - the "save as preset" action on the shot
//! inspector.
//!
//! This is deliberately **not** [`crate::EditorPreset`]. That type stores a
//! multi-track editor clip's transform, effects and speed segments, and it is
//! keyed to an editor project's revision. A recording preset stores the inputs
//! of a capture: which camera the game runs, whose eyes it looks through, how
//! much air to leave around the action, and how the frame is presented. The two
//! share neither a field nor a consumer, so folding them together would only
//! produce one type where half the fields are always absent.
//!
//! A preset holds exactly the shot-scoped inputs of a [`crate::RecordingRequest`]
//! and none of its bindings. `demo_id`, `player_id`, `highlight_id`, the tick
//! window and the title all describe *this* shot of *this* match; a preset that
//! carried them would be a saved shot, not saved settings, and applying it
//! would silently retarget the recording.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{DomainError, HlaeCameraStyle, RecordingPresentation};
use ts_rs::TS;

/// Longest preset name. Matches the label bound used across the Agent workspace
/// so one text field cannot be valid in one pane and rejected in another.
pub const RECORDING_SHOT_PRESET_MAX_NAME_CHARS: usize = 200;
/// Largest pre- or post-roll a preset may store, in seconds. Identical to the
/// bound [`crate::RecordingRequest::validate`] enforces, because a preset that
/// could hold a value the request rejects would be a preset that cannot be
/// applied.
pub const RECORDING_SHOT_PRESET_MAX_ROLL_SECONDS: f64 = 60.0;

/// A named, reusable set of shot settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct RecordingShotPreset {
    pub id: Uuid,
    pub name: String,
    pub camera_style: HlaeCameraStyle,
    pub victim_pov: bool,
    pub pre_roll_seconds: f64,
    pub post_roll_seconds: f64,
    /// Always concrete, never `Option`. On a [`crate::RecordingRequest`],
    /// `None` means "follow the global defaults" and is a meaningful choice; a
    /// preset whose presentation were `None` would carry no presentation at
    /// all, which is what *not* saving a preset already expresses.
    pub presentation: RecordingPresentation,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl RecordingShotPreset {
    /// Normalizes the preset name and validates that the saved combination is
    /// one a recording request could actually carry.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when the name is empty or too
    /// long, a roll is out of range, victim POV is paired with a cinematic
    /// camera, or the presentation is invalid for the camera style. A
    /// combination that cannot be recorded must not be storable as a preset:
    /// the failure belongs at "save", where the user can still see what they
    /// typed, not at "apply" weeks later.
    pub fn normalize(mut self) -> Result<Self, DomainError> {
        self.name = normalize_preset_name(&self.name)?;
        validate_shot_settings(
            self.camera_style,
            self.victim_pov,
            self.pre_roll_seconds,
            self.post_roll_seconds,
            &self.presentation,
        )?;
        Ok(self)
    }
}

/// The caller-supplied half of a preset. Identity and timestamps stay
/// server-owned, exactly as they do for plans and sessions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct RecordingShotPresetDraft {
    pub name: String,
    pub camera_style: HlaeCameraStyle,
    pub victim_pov: bool,
    pub pre_roll_seconds: f64,
    pub post_roll_seconds: f64,
    pub presentation: RecordingPresentation,
}

impl RecordingShotPresetDraft {
    /// Normalizes the draft under the same rules as a stored preset.
    ///
    /// # Errors
    ///
    /// See [`RecordingShotPreset::normalize`].
    pub fn normalize(mut self) -> Result<Self, DomainError> {
        self.name = normalize_preset_name(&self.name)?;
        validate_shot_settings(
            self.camera_style,
            self.victim_pov,
            self.pre_roll_seconds,
            self.post_roll_seconds,
            &self.presentation,
        )?;
        Ok(self)
    }

    /// Materializes a stored preset from this draft.
    #[must_use]
    pub fn into_preset(
        self,
        id: Uuid,
        created_at: DateTime<Utc>,
        updated_at: DateTime<Utc>,
    ) -> RecordingShotPreset {
        RecordingShotPreset {
            id,
            name: self.name,
            camera_style: self.camera_style,
            victim_pov: self.victim_pov,
            pre_roll_seconds: self.pre_roll_seconds,
            post_roll_seconds: self.post_roll_seconds,
            presentation: self.presentation,
            created_at,
            updated_at,
        }
    }
}

fn normalize_preset_name(value: &str) -> Result<String, DomainError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > RECORDING_SHOT_PRESET_MAX_NAME_CHARS {
        return Err(DomainError::InvalidInput(format!(
            "preset name must contain 1 to {RECORDING_SHOT_PRESET_MAX_NAME_CHARS} characters"
        )));
    }
    Ok(value.to_owned())
}

fn validate_shot_settings(
    camera_style: HlaeCameraStyle,
    victim_pov: bool,
    pre_roll_seconds: f64,
    post_roll_seconds: f64,
    presentation: &RecordingPresentation,
) -> Result<(), DomainError> {
    if victim_pov && camera_style != HlaeCameraStyle::Pov {
        return Err(DomainError::InvalidInput(
            "victim POV cannot be combined with cinematic camera movement".to_owned(),
        ));
    }
    validate_roll_seconds(pre_roll_seconds, post_roll_seconds)?;
    presentation.validate_for(camera_style)
}

fn validate_roll_seconds(pre_roll_seconds: f64, post_roll_seconds: f64) -> Result<(), DomainError> {
    if !pre_roll_seconds.is_finite()
        || !post_roll_seconds.is_finite()
        || pre_roll_seconds < 0.0
        || post_roll_seconds < 0.0
        || pre_roll_seconds > RECORDING_SHOT_PRESET_MAX_ROLL_SECONDS
        || post_roll_seconds > RECORDING_SHOT_PRESET_MAX_ROLL_SECONDS
    {
        return Err(DomainError::InvalidInput(format!(
            "pre-roll and post-roll must be finite values from 0 to {RECORDING_SHOT_PRESET_MAX_ROLL_SECONDS} seconds"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RecordingVoicePolicy;

    fn draft() -> RecordingShotPresetDraft {
        RecordingShotPresetDraft {
            name: "选手 POV · 三杀".to_owned(),
            camera_style: HlaeCameraStyle::Pov,
            victim_pov: false,
            pre_roll_seconds: 1.5,
            post_roll_seconds: 1.0,
            presentation: RecordingPresentation::default(),
        }
    }

    #[test]
    fn preset_names_are_trimmed_and_bounded() {
        assert_eq!(
            RecordingShotPresetDraft {
                name: "  紧凑 POV  ".to_owned(),
                ..draft()
            }
            .normalize()
            .expect("trimmed name")
            .name,
            "紧凑 POV"
        );
        for name in [
            String::new(),
            "   ".to_owned(),
            "x".repeat(RECORDING_SHOT_PRESET_MAX_NAME_CHARS + 1),
        ] {
            assert!(
                RecordingShotPresetDraft { name, ..draft() }
                    .normalize()
                    .is_err()
            );
        }
    }

    #[test]
    fn a_combination_that_cannot_be_recorded_cannot_be_saved() {
        // An observer preset must not smuggle a field of view that the camera
        // path would override.
        assert!(
            RecordingShotPresetDraft {
                camera_style: HlaeCameraStyle::Crane,
                presentation: RecordingPresentation {
                    camera_fov: 110.0,
                    ..RecordingPresentation::default()
                },
                ..draft()
            }
            .normalize()
            .is_err()
        );
        // ... and the four style-independent controls stay saveable on it.
        RecordingShotPresetDraft {
            camera_style: HlaeCameraStyle::Crane,
            presentation: RecordingPresentation {
                show_hud: false,
                show_radar: false,
                flash_alpha: 102,
                voice: RecordingVoicePolicy::Muted,
                ..RecordingPresentation::default()
            },
            ..draft()
        }
        .normalize()
        .expect("observer presets keep HUD, radar, flash and voice");

        assert!(
            RecordingShotPresetDraft {
                camera_style: HlaeCameraStyle::Tracking,
                victim_pov: true,
                ..draft()
            }
            .normalize()
            .is_err()
        );
        assert!(
            RecordingShotPresetDraft {
                camera_style: HlaeCameraStyle::Pov,
                presentation: RecordingPresentation {
                    viewmodel_fov: 70.0,
                    ..RecordingPresentation::default()
                },
                ..draft()
            }
            .normalize()
            .is_err()
        );
    }

    #[test]
    fn roll_seconds_match_the_recording_request_bound() {
        for (pre, post) in [(0.0, 0.0), (60.0, 60.0)] {
            RecordingShotPresetDraft {
                pre_roll_seconds: pre,
                post_roll_seconds: post,
                ..draft()
            }
            .normalize()
            .expect("in-range rolls");
        }
        for (pre, post) in [
            (-0.1, 0.0),
            (0.0, -0.1),
            (60.1, 0.0),
            (0.0, 60.1),
            (f64::NAN, 0.0),
            (0.0, f64::INFINITY),
        ] {
            assert!(
                RecordingShotPresetDraft {
                    pre_roll_seconds: pre,
                    post_roll_seconds: post,
                    ..draft()
                }
                .normalize()
                .is_err(),
                "({pre}, {post}) must be rejected"
            );
        }
    }

    #[test]
    fn a_stored_preset_accepts_only_the_current_document() {
        let now = Utc::now();
        let preset = draft()
            .normalize()
            .expect("valid draft")
            .into_preset(Uuid::new_v4(), now, now)
            .normalize()
            .expect("valid preset");

        let wire = serde_json::to_value(&preset).expect("preset wire");
        assert_eq!(
            serde_json::from_value::<RecordingShotPreset>(wire.clone()).expect("current shape"),
            preset
        );
        for field in wire
            .as_object()
            .expect("preset object")
            .keys()
            .cloned()
            .collect::<Vec<_>>()
        {
            let mut missing = wire.clone();
            missing
                .as_object_mut()
                .expect("preset object")
                .remove(&field);
            assert!(
                serde_json::from_value::<RecordingShotPreset>(missing).is_err(),
                "missing current field {field} must be rejected"
            );
        }
        let mut unknown = wire;
        unknown["demo_id"] = serde_json::json!(Uuid::new_v4());
        assert!(
            serde_json::from_value::<RecordingShotPreset>(unknown).is_err(),
            "a preset must not be able to retarget the recording it is applied to"
        );
    }
}
