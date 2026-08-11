use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    #[default]
    Queued,
    Preparing,
    Running,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
}

impl JobStatus {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    #[must_use]
    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (
                Self::Queued,
                Self::Preparing | Self::Cancelling | Self::Cancelled | Self::Failed
            ) | (
                Self::Preparing,
                Self::Running | Self::Cancelling | Self::Cancelled | Self::Failed
            ) | (
                Self::Running,
                Self::Cancelling | Self::Completed | Self::Failed
            ) | (Self::Cancelling, Self::Cancelled | Self::Failed)
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[allow(clippy::struct_excessive_bools)] // Independent user-facing recording toggles.
pub struct RecordingRequest {
    pub id: Option<Uuid>,
    pub demo_id: Uuid,
    pub highlight_id: Option<String>,
    pub player_id: String,
    pub title: String,
    pub start_tick: u64,
    pub end_tick: u64,
    pub playback_speed: f64,
    pub pre_roll_seconds: f64,
    pub post_roll_seconds: f64,
    pub victim_pov: bool,
    pub show_keyboard: bool,
    pub show_kill_fx: bool,
    pub fade: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DirectorShotKind {
    Player,
    VictimReaction,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectorShot {
    pub demo_id: Uuid,
    pub source_item_ids: Vec<Uuid>,
    pub player_id: String,
    pub kind: DirectorShotKind,
    pub start_tick: u64,
    pub end_tick: u64,
    pub score: f64,
    pub evidence: Vec<String>,
    pub explanation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectorPlan {
    pub shots: Vec<DirectorShot>,
    pub warnings: Vec<String>,
    pub source_item_count: usize,
    pub merged_item_count: usize,
    pub victim_reaction_count: usize,
    pub unresolved_victim_requests: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct CaptureLatencySample {
    pub game_observed_ms: i64,
    pub obs_observed_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CaptureLatencyCalibration {
    pub sample_count: usize,
    pub recommended_delay_ms: i64,
    pub median_offset_ms: i64,
    pub jitter_ms: u64,
    pub confidence: String,
    pub diagnostic: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecordingInputEvent {
    pub sequence: u64,
    pub tick: u64,
    pub input: crate::ReplayInputState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecordingInputBus {
    pub version: u32,
    pub player_id: String,
    pub source: String,
    pub events: Vec<RecordingInputEvent>,
}

impl RecordingRequest {
    /// Validate the transport-independent timing constraints before planning.
    ///
    /// # Errors
    ///
    /// Returns [`crate::DomainError::InvalidInput`] when the player, tick
    /// window, playback speed, or pre/post-roll values are invalid.
    pub fn validate(&self) -> Result<(), crate::DomainError> {
        if self.player_id.trim().is_empty() {
            return Err(crate::DomainError::InvalidInput(
                "player_id cannot be empty".to_owned(),
            ));
        }
        if self.end_tick <= self.start_tick {
            return Err(crate::DomainError::InvalidInput(
                "end_tick must be greater than start_tick".to_owned(),
            ));
        }
        if !(0.1..=8.0).contains(&self.playback_speed) {
            return Err(crate::DomainError::InvalidInput(
                "playback_speed must be between 0.1 and 8.0".to_owned(),
            ));
        }
        if !self.pre_roll_seconds.is_finite()
            || !self.post_roll_seconds.is_finite()
            || self.pre_roll_seconds < 0.0
            || self.post_roll_seconds < 0.0
            || self.pre_roll_seconds > 60.0
            || self.post_roll_seconds > 60.0
        {
            return Err(crate::DomainError::InvalidInput(
                "pre-roll and post-roll must be finite values from 0 to 60 seconds".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecordingJob {
    pub id: Uuid,
    pub status: JobStatus,
    pub items: Vec<RecordingRequest>,
    pub current_index: usize,
    pub progress: f64,
    pub message: String,
    pub outputs: Vec<RecordedClip>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecordedClip {
    pub id: Uuid,
    pub path: String,
    pub title: String,
    pub duration_seconds: f64,
    pub demo_id: Option<Uuid>,
    pub player_name: Option<String>,
    pub category: String,
    pub tags: Vec<String>,
    pub metadata: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MontageProject {
    pub id: Uuid,
    pub name: String,
    pub clips: Vec<MontageClip>,
    pub settings: MontageSettings,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MontageClip {
    pub clip_id: Uuid,
    pub order: u32,
    pub trim_start: f64,
    pub trim_end: Option<f64>,
    pub transition: String,
    pub title: Option<String>,
    /// Optional managed image asset used by the name card.
    #[serde(default)]
    pub avatar_asset_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MontageSettings {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub encoder: String,
    pub quality: u8,
    pub background_music: Option<String>,
    pub music_volume: f64,
    /// Duration shared by cross-fade and slide transitions.
    #[serde(default = "default_montage_transition_seconds")]
    pub transition_seconds: f64,
    /// Optional opening title rendered on a generated title card.
    #[serde(default)]
    pub intro_title: Option<String>,
    /// Opening title-card duration. A zero value disables the card.
    #[serde(default)]
    pub intro_duration_seconds: f64,
    /// Burn the per-clip title into the beginning of each clip.
    #[serde(default)]
    pub include_name_cards: bool,
    /// Maximum time for which a clip name card remains visible.
    #[serde(default = "default_name_card_seconds")]
    pub name_card_duration_seconds: f64,
    /// Optional closing title rendered after the final clip.
    #[serde(default)]
    pub outro_title: Option<String>,
    /// Closing title-card duration. A zero value disables the card.
    #[serde(default)]
    pub outro_duration_seconds: f64,
    /// Reusable built-in visual package. The renderer owns the exact palette
    /// and typography so projects remain portable.
    #[serde(default)]
    pub branding_theme: MontageBrandingTheme,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MontageBrandingTheme {
    #[default]
    Vibe,
    Broadcast,
    Minimal,
    Neon,
}

const fn default_montage_transition_seconds() -> f64 {
    0.35
}

const fn default_name_card_seconds() -> f64 {
    2.5
}

impl Default for MontageSettings {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: 60,
            encoder: "auto".to_owned(),
            quality: 80,
            background_music: None,
            music_volume: 0.25,
            transition_seconds: default_montage_transition_seconds(),
            intro_title: None,
            intro_duration_seconds: 0.0,
            include_name_cards: false,
            name_card_duration_seconds: default_name_card_seconds(),
            outro_title: None,
            outro_duration_seconds: 0.0,
            branding_theme: MontageBrandingTheme::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_jobs_do_not_transition() {
        for state in [
            JobStatus::Completed,
            JobStatus::Failed,
            JobStatus::Cancelled,
        ] {
            assert!(state.is_terminal());
            for next in [
                JobStatus::Queued,
                JobStatus::Preparing,
                JobStatus::Running,
                JobStatus::Cancelling,
                JobStatus::Completed,
                JobStatus::Failed,
                JobStatus::Cancelled,
            ] {
                assert!(!state.can_transition_to(next));
            }
        }
    }

    #[test]
    fn active_job_transitions_follow_the_state_machine() {
        assert!(JobStatus::Queued.can_transition_to(JobStatus::Preparing));
        assert!(JobStatus::Preparing.can_transition_to(JobStatus::Running));
        assert!(JobStatus::Running.can_transition_to(JobStatus::Completed));
        assert!(JobStatus::Running.can_transition_to(JobStatus::Cancelling));
        assert!(JobStatus::Cancelling.can_transition_to(JobStatus::Cancelled));
        assert!(!JobStatus::Queued.can_transition_to(JobStatus::Completed));
    }
}
