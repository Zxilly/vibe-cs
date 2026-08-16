//! Closed command grammar for the presentation controls that hold for every
//! camera style.
//!
//! Radar, HUD, flash and voice describe the recorded *scene*, not the camera:
//! an observer shot draws the same HUD a first-person shot does. Both
//! compilers - [`crate::compile_hlae_player_pov_capture`] for player POV and
//! [`crate::compile_hlae_plan`] for camera paths - therefore emit these
//! commands through this one generator instead of assembling their own
//! strings. A single generator is what keeps the grammar closed: a caller
//! picks between typed variants and can never inject console text of its own,
//! and a correction to the grammar cannot land in one compiler while the other
//! keeps the old text.

use serde::{Deserialize, Serialize};

use crate::HlaeError;

/// Highest one-based CS2 spectator slot the managed grammar accepts. It
/// matches the bound `compile_hlae_player_pov_capture` enforces for
/// `spec_player`.
const MAXIMUM_SPECTATOR_SLOT: u8 = 64;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HlaeRadarVisibility {
    Visible,
    Hidden,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HlaeHudVisibility {
    Visible,
    DeathNoticesOnly,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HlaeVoicePolicy {
    AllPlayers,
    Muted,
    TargetOnly,
}

/// The presentation controls that mean the same thing in a first-person take
/// and in an observer take.
///
/// Field of view is deliberately absent: it belongs to
/// [`crate::HlaePlayerPovPresentation`] because a camera path already carries a
/// field of view on every keyframe and draws no viewmodel at all.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct HlaeScenePresentation {
    pub radar: HlaeRadarVisibility,
    pub hud: HlaeHudVisibility,
    /// Desired remaining flash alpha in the CS2 `0..=255` scale.
    pub flash_alpha: u8,
    pub voice: HlaeVoicePolicy,
    /// Parser-backed one-based CS2 spectator slot of the recorded player.
    ///
    /// [`HlaeVoicePolicy::TargetOnly`] cannot be compiled without it, because
    /// `tv_listen_voice_indices` addresses players by slot bit. Every other
    /// policy ignores it. It is never inferred from a name or a `SteamID`.
    pub voice_target_slot: Option<u8>,
}

impl Default for HlaeScenePresentation {
    fn default() -> Self {
        Self {
            radar: HlaeRadarVisibility::Visible,
            hud: HlaeHudVisibility::Visible,
            flash_alpha: u8::MAX,
            voice: HlaeVoicePolicy::AllPlayers,
            voice_target_slot: None,
        }
    }
}

impl HlaeScenePresentation {
    /// Validates the one value this presentation cannot express as a type.
    ///
    /// # Errors
    ///
    /// Returns [`HlaeError::InvalidPlan`] when the spectator slot is outside
    /// `1..=64`, or when [`HlaeVoicePolicy::TargetOnly`] carries no slot at
    /// all.
    pub(crate) fn validate(self) -> Result<(), HlaeError> {
        if let Some(slot) = self.voice_target_slot
            && !(1..=MAXIMUM_SPECTATOR_SLOT).contains(&slot)
        {
            return Err(HlaeError::InvalidPlan(
                "voiceTargetSlot must be a parser-backed value between 1 and 64".to_owned(),
            ));
        }
        if self.voice == HlaeVoicePolicy::TargetOnly && self.voice_target_slot.is_none() {
            return Err(HlaeError::InvalidPlan(
                "isolating the recorded player's voice requires a parser-backed spectator slot"
                    .to_owned(),
            ));
        }
        Ok(())
    }
}

/// Compiles the fixed scene commands issued before a capture starts.
///
/// # Errors
///
/// Returns [`HlaeError::InvalidPlan`] when the presentation fails
/// [`HlaeScenePresentation::validate`].
pub(crate) fn scene_setup_commands(scene: HlaeScenePresentation) -> Result<String, HlaeError> {
    scene.validate()?;
    let noflash = 1.0 - f64::from(scene.flash_alpha) / f64::from(u8::MAX);
    let (voice_volume, voice_low, voice_high) = match scene.voice {
        HlaeVoicePolicy::Muted => (0_u8, 0_i32, 0_i32),
        HlaeVoicePolicy::TargetOnly => {
            let slot = scene.voice_target_slot.ok_or_else(|| {
                HlaeError::InvalidPlan(
                    "isolating the recorded player's voice requires a parser-backed spectator slot"
                        .to_owned(),
                )
            })?;
            let bit = u32::from(slot - 1);
            let (low, high) = if bit < 32 {
                (1_i32.wrapping_shl(bit), 0)
            } else {
                (0, 1_i32.wrapping_shl(bit - 32))
            };
            (1, low, high)
        }
        HlaeVoicePolicy::AllPlayers => (1, -1, -1),
    };
    Ok(format!(
        "cl_drawhud_force_radar {}; cl_drawhud 1; cl_draw_only_deathnotices {}; mirv_noflash {}; snd_voipvolume {voice_volume}; tv_listen_voice_indices {voice_low}; tv_listen_voice_indices_h {voice_high}",
        match scene.radar {
            HlaeRadarVisibility::Visible => 1,
            HlaeRadarVisibility::Hidden => -1,
        },
        match scene.hud {
            HlaeHudVisibility::Visible => 0,
            HlaeHudVisibility::DeathNoticesOnly => 1,
        },
        bounded_decimal(noflash),
    ))
}

/// Restores every scene control [`scene_setup_commands`] can change.
///
/// The managed session records several takes inside one CS2 process, so a take
/// that hid the radar must not leave the next one without it.
pub(crate) const SCENE_RESET_COMMANDS: &str = "cl_drawhud_force_radar 0; cl_draw_only_deathnotices 0; mirv_noflash 0; snd_voipvolume 1; tv_listen_voice_indices 0; tv_listen_voice_indices_h 0";

pub(crate) fn bounded_decimal(value: f64) -> String {
    let mut rendered = format!("{value:.6}");
    while rendered.ends_with('0') {
        rendered.pop();
    }
    if rendered.ends_with('.') {
        rendered.pop();
    }
    rendered
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_neutral_scene_leaves_every_control_at_its_game_default() {
        let commands =
            scene_setup_commands(HlaeScenePresentation::default()).expect("the neutral scene");

        assert!(commands.contains("cl_drawhud_force_radar 1"));
        assert!(commands.contains("cl_drawhud 1; cl_draw_only_deathnotices 0"));
        assert!(commands.contains("mirv_noflash 0"));
        assert!(commands.contains("snd_voipvolume 1"));
        assert!(commands.contains("tv_listen_voice_indices -1"));
        assert!(commands.contains("tv_listen_voice_indices_h -1"));
    }

    #[test]
    fn a_hidden_scene_hides_the_radar_keeps_only_death_notices_and_mutes_voice() {
        let commands = scene_setup_commands(HlaeScenePresentation {
            radar: HlaeRadarVisibility::Hidden,
            hud: HlaeHudVisibility::DeathNoticesOnly,
            flash_alpha: 102,
            voice: HlaeVoicePolicy::Muted,
            voice_target_slot: None,
        })
        .expect("a hidden scene");

        assert!(commands.contains("cl_drawhud_force_radar -1"));
        assert!(commands.contains("cl_draw_only_deathnotices 1"));
        assert!(commands.contains("snd_voipvolume 0"));
        assert!(commands.contains("tv_listen_voice_indices 0"));
        assert!(commands.contains("tv_listen_voice_indices_h 0"));
        // 40% remaining flash alpha is 60% suppression.
        assert!(commands.contains("mirv_noflash 0.6"));
    }

    #[test]
    fn isolating_a_voice_addresses_exactly_one_slot_bit() {
        let low = scene_setup_commands(HlaeScenePresentation {
            voice: HlaeVoicePolicy::TargetOnly,
            voice_target_slot: Some(7),
            ..HlaeScenePresentation::default()
        })
        .expect("a low spectator slot");
        assert!(low.contains("tv_listen_voice_indices 64"));
        assert!(low.contains("tv_listen_voice_indices_h 0"));

        let high = scene_setup_commands(HlaeScenePresentation {
            voice: HlaeVoicePolicy::TargetOnly,
            voice_target_slot: Some(34),
            ..HlaeScenePresentation::default()
        })
        .expect("a high spectator slot");
        assert!(high.contains("tv_listen_voice_indices 0;"));
        assert!(high.contains("tv_listen_voice_indices_h 2"));
    }

    #[test]
    fn a_voice_target_is_never_inferred_and_never_out_of_range() {
        assert!(
            scene_setup_commands(HlaeScenePresentation {
                voice: HlaeVoicePolicy::TargetOnly,
                voice_target_slot: None,
                ..HlaeScenePresentation::default()
            })
            .is_err()
        );
        for slot in [0, MAXIMUM_SPECTATOR_SLOT + 1, u8::MAX] {
            assert!(
                scene_setup_commands(HlaeScenePresentation {
                    voice: HlaeVoicePolicy::TargetOnly,
                    voice_target_slot: Some(slot),
                    ..HlaeScenePresentation::default()
                })
                .is_err(),
                "spectator slot {slot} is outside the managed grammar"
            );
        }
    }

    #[test]
    fn the_reset_restores_every_control_the_setup_can_change() {
        for control in [
            "cl_drawhud_force_radar",
            "cl_draw_only_deathnotices",
            "mirv_noflash",
            "snd_voipvolume",
            "tv_listen_voice_indices",
            "tv_listen_voice_indices_h",
        ] {
            assert!(
                SCENE_RESET_COMMANDS.contains(control),
                "{control} stays applied to the next take of the same session"
            );
        }
    }

    #[test]
    fn the_scene_document_keeps_its_current_shape_and_defaults_to_neutral() {
        let scene = HlaeScenePresentation {
            radar: HlaeRadarVisibility::Hidden,
            hud: HlaeHudVisibility::DeathNoticesOnly,
            flash_alpha: 40,
            voice: HlaeVoicePolicy::TargetOnly,
            voice_target_slot: Some(7),
        };
        let wire = serde_json::to_value(scene).expect("scene wire");
        assert_eq!(wire["radar"], serde_json::json!("hidden"));
        assert_eq!(wire["hud"], serde_json::json!("deathNoticesOnly"));
        assert_eq!(wire["flashAlpha"], serde_json::json!(40));
        assert_eq!(wire["voice"], serde_json::json!("targetOnly"));
        assert_eq!(wire["voiceTargetSlot"], serde_json::json!(7));
        assert_eq!(
            serde_json::from_value::<HlaeScenePresentation>(wire.clone()).expect("scene document"),
            scene
        );

        let mut unknown = wire;
        unknown["retiredField"] = serde_json::json!(true);
        assert!(serde_json::from_value::<HlaeScenePresentation>(unknown).is_err());
    }
}
