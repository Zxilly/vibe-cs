use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Lowest camera field of view the managed capture grammar accepts.
///
/// Copied from `vibe_cs_hlae::player_pov_capture::validate_player_pov_plan`,
/// which rejects anything outside `60.0..=140.0`. It is repeated here, at the
/// API boundary, on purpose: the HLAE compiler only runs once a recording job
/// has already prepared its managed roots, verified the Demo content and
/// launched CS2, so a `140.1` accepted at `POST` time would surface as a
/// failure minutes later, after the user has been waiting. The two ranges must
/// stay identical - this one is the early, cheap copy, never a looser one.
pub const RECORDING_CAMERA_FOV_MIN: f64 = 60.0;
/// Highest camera field of view the managed capture grammar accepts.
/// See [`RECORDING_CAMERA_FOV_MIN`] for why the range is duplicated here.
pub const RECORDING_CAMERA_FOV_MAX: f64 = 140.0;
/// Lowest viewmodel field of view the managed capture grammar accepts.
/// See [`RECORDING_CAMERA_FOV_MIN`] for why the range is duplicated here.
pub const RECORDING_VIEWMODEL_FOV_MIN: f64 = 54.0;
/// Highest viewmodel field of view the managed capture grammar accepts.
/// See [`RECORDING_CAMERA_FOV_MIN`] for why the range is duplicated here.
pub const RECORDING_VIEWMODEL_FOV_MAX: f64 = 68.0;

/// Neutral camera field of view. Matches `HlaePlayerPovPresentation::default()`
/// and [`crate::RecordingDefaults::default`].
pub const RECORDING_NEUTRAL_CAMERA_FOV: f64 = 90.0;
/// Neutral viewmodel field of view. Matches `HlaePlayerPovPresentation::default()`
/// and [`crate::RecordingDefaults::default`].
pub const RECORDING_NEUTRAL_VIEWMODEL_FOV: f64 = 68.0;

/// Whose voice communication is audible in a capture.
///
/// This is one closed three-state choice rather than the two independent bools
/// (`mute_voice` + `isolate_target_voice`) that [`crate::RecordingDefaults`]
/// still carries. Two bools express four combinations, and the runtime's
/// `presentation(config)` rejects one of them ("mute everyone" together with
/// "isolate the target") as its very first act. Encoding the same choice as an
/// enum removes the illegal state instead of validating it away, so no
/// per-shot value can ever reach the capture pipeline in that combination.
///
/// [`crate::RecordingDefaults`] is deliberately left unchanged: it is read and
/// written by the configuration file and the settings pane, and folding its two
/// bools into this enum belongs with runtime, which already owns the mapping.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecordingVoicePolicy {
    /// Every player's voice is audible.
    #[default]
    AllPlayers,
    /// No voice communication is captured.
    Muted,
    /// Only the recorded player's voice is captured.
    TargetOnly,
}

impl RecordingVoicePolicy {
    /// The canonical persisted discriminator for this policy.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AllPlayers => "all_players",
            Self::Muted => "muted",
            Self::TargetOnly => "target_only",
        }
    }

    /// Parses the canonical persisted discriminator.
    #[must_use]
    pub fn from_str_exact(value: &str) -> Option<Self> {
        match value {
            "all_players" => Some(Self::AllPlayers),
            "muted" => Some(Self::Muted),
            "target_only" => Some(Self::TargetOnly),
            _ => None,
        }
    }
}

/// Per-shot capture presentation: the six controls the shot inspector exposes
/// beyond timing and camera choice.
///
/// These six values exist today only on [`crate::RecordingDefaults`], where they
/// are one global default for the whole application. Carrying them per shot is
/// what lets one plan mix, say, a HUD-less establishing shot with a HUD-on POV
/// shot.
///
/// A [`RecordingRequest`] holds this as `Option<RecordingPresentation>`, and
/// `None` means "use the global [`crate::RecordingDefaults`]". The defaults are
/// deliberately **not** expanded at this layer: once expanded, "the user never
/// touched these controls" and "the user set them to exactly today's global
/// default" are the same bytes in storage, so a later change to the global
/// default would silently stop applying to shots that were only ever meant to
/// follow it. Expansion happens in runtime, at the point the capture program is
/// compiled and the configuration is in hand.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RecordingPresentation {
    /// Camera field of view, `60.0..=140.0`. POV shots only.
    pub camera_fov: f64,
    /// Viewmodel (held weapon) field of view, `54.0..=68.0`. POV shots only.
    pub viewmodel_fov: f64,
    /// Remaining flash alpha in the CS2 `0..=255` scale. Every `u8` is valid,
    /// which is why the type carries no range check for it.
    pub flash_alpha: u8,
    pub show_hud: bool,
    pub show_radar: bool,
    pub voice: RecordingVoicePolicy,
}

impl Default for RecordingPresentation {
    fn default() -> Self {
        Self {
            camera_fov: RECORDING_NEUTRAL_CAMERA_FOV,
            viewmodel_fov: RECORDING_NEUTRAL_VIEWMODEL_FOV,
            flash_alpha: u8::MAX,
            show_hud: true,
            show_radar: true,
            voice: RecordingVoicePolicy::AllPlayers,
        }
    }
}

impl RecordingPresentation {
    /// Validates the fields that are meaningful for every camera style.
    ///
    /// # Errors
    ///
    /// Returns [`crate::DomainError::InvalidInput`] when a field of view is not
    /// finite or leaves the range the managed capture grammar accepts.
    pub fn validate(&self) -> Result<(), crate::DomainError> {
        if !self.camera_fov.is_finite()
            || !(RECORDING_CAMERA_FOV_MIN..=RECORDING_CAMERA_FOV_MAX).contains(&self.camera_fov)
        {
            return Err(crate::DomainError::InvalidInput(format!(
                "camera_fov must be finite and between {RECORDING_CAMERA_FOV_MIN} and {RECORDING_CAMERA_FOV_MAX}"
            )));
        }
        if !self.viewmodel_fov.is_finite()
            || !(RECORDING_VIEWMODEL_FOV_MIN..=RECORDING_VIEWMODEL_FOV_MAX)
                .contains(&self.viewmodel_fov)
        {
            return Err(crate::DomainError::InvalidInput(format!(
                "viewmodel_fov must be finite and between {RECORDING_VIEWMODEL_FOV_MIN} and {RECORDING_VIEWMODEL_FOV_MAX}"
            )));
        }
        Ok(())
    }

    /// Validates this presentation against the camera style that will render it.
    ///
    /// `camera_fov` and `viewmodel_fov` only mean something for
    /// [`crate::HlaeCameraStyle::Pov`]. Every other style compiles through the
    /// cinematic camera-path compiler, where the field of view comes from each
    /// keyframe of the path and no viewmodel is drawn at all. A non-POV shot
    /// must therefore leave both at their neutral value; a non-neutral one is
    /// rejected rather than ignored, because silently ignoring it is exactly
    /// "the interface offered a slider that does nothing".
    ///
    /// The remaining four fields (`flash_alpha`, `show_hud`, `show_radar`,
    /// `voice`) apply to both kinds of shot and are not constrained here.
    ///
    /// # Errors
    ///
    /// Returns [`crate::DomainError::InvalidInput`] when [`Self::validate`]
    /// fails, or when an observer shot carries a non-neutral field of view.
    pub fn validate_for(
        &self,
        camera_style: crate::HlaeCameraStyle,
    ) -> Result<(), crate::DomainError> {
        self.validate()?;
        if camera_style == crate::HlaeCameraStyle::Pov {
            return Ok(());
        }
        if !is_neutral(self.camera_fov, RECORDING_NEUTRAL_CAMERA_FOV)
            || !is_neutral(self.viewmodel_fov, RECORDING_NEUTRAL_VIEWMODEL_FOV)
        {
            return Err(crate::DomainError::InvalidInput(
                "observer shots take their field of view from the camera path, so camera_fov and viewmodel_fov must stay at their neutral values".to_owned(),
            ));
        }
        Ok(())
    }
}

fn is_neutral(value: f64, neutral: f64) -> bool {
    (value - neutral).abs() <= f64::EPSILON
}

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
#[serde(deny_unknown_fields)]
pub struct RecordingRequest {
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub id: Option<Uuid>,
    pub demo_id: Uuid,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub highlight_id: Option<String>,
    pub player_id: String,
    pub title: String,
    pub start_tick: u64,
    pub end_tick: u64,
    pub pre_roll_seconds: f64,
    pub post_roll_seconds: f64,
    pub victim_pov: bool,
    #[serde(default)]
    pub camera_style: crate::HlaeCameraStyle,
    /// Per-shot capture presentation. `None` means "use the global
    /// [`crate::RecordingDefaults`]" and is the shape of every document written
    /// before this field existed, which is why it is `#[serde(default)]`
    /// despite `deny_unknown_fields` on the rest of the struct.
    #[serde(default)]
    pub presentation: Option<RecordingPresentation>,
}

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
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

impl RecordingRequest {
    /// Validate the transport-independent timing constraints before planning.
    ///
    /// # Errors
    ///
    /// Returns [`crate::DomainError::InvalidInput`] when the player, tick
    /// window or pre/post-roll values are invalid.
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
        if self.victim_pov && self.camera_style != crate::HlaeCameraStyle::Pov {
            return Err(crate::DomainError::InvalidInput(
                "victim POV cannot be combined with cinematic camera movement".to_owned(),
            ));
        }
        if let Some(presentation) = &self.presentation {
            presentation.validate_for(self.camera_style)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RecordingJob {
    pub id: Uuid,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub retry_of: Option<Uuid>,
    pub status: JobStatus,
    pub items: Vec<RecordingRequest>,
    pub current_index: usize,
    pub progress: f64,
    pub message: String,
    pub outputs: Vec<RecordedClip>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl RecordingJob {
    /// Returns the exact unpublished suffix that may be retried as a new job.
    ///
    /// Every published prefix clip must prove which request produced it. A
    /// missing or changed request identity makes recovery ambiguous and is
    /// rejected rather than replaying an unknown portion of the job.
    ///
    /// # Errors
    ///
    /// Returns [`crate::DomainError::Conflict`] unless this is a failed or
    /// cancelled job with a valid unpublished suffix and an exact durable
    /// request identity for every already-published clip.
    pub fn retryable_suffix(&self) -> Result<&[RecordingRequest], crate::DomainError> {
        if !matches!(self.status, JobStatus::Failed | JobStatus::Cancelled) {
            return Err(crate::DomainError::Conflict(
                "only failed or cancelled recording jobs can be retried".to_owned(),
            ));
        }
        if self.outputs.len() > self.current_index || self.current_index >= self.items.len() {
            return Err(crate::DomainError::Conflict(
                "recording retry cursor does not identify an unpublished suffix".to_owned(),
            ));
        }
        for (request, clip) in self.items.iter().zip(&self.outputs) {
            let request_id = request.id.ok_or_else(|| {
                crate::DomainError::Conflict(
                    "published recording request has no durable identity".to_owned(),
                )
            })?;
            let expected = request_id.to_string();
            if clip
                .metadata
                .get("request_id")
                .and_then(serde_json::Value::as_str)
                != Some(expected.as_str())
            {
                return Err(crate::DomainError::Conflict(
                    "published recording clip does not match its request identity".to_owned(),
                ));
            }
        }
        Ok(&self.items[self.outputs.len()..])
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RecordedClip {
    pub id: Uuid,
    pub path: String,
    pub title: String,
    pub duration_seconds: f64,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub demo_id: Option<Uuid>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub player_name: Option<String>,
    pub category: String,
    pub tags: Vec<String>,
    pub metadata: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MontageProject {
    pub id: Uuid,
    pub name: String,
    pub clips: Vec<MontageClip>,
    pub settings: MontageSettings,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MontageClip {
    pub clip_id: Uuid,
    pub order: u32,
    pub trim_start: f64,
    pub trim_end: Option<f64>,
    pub transition: String,
    pub title: Option<String>,
    /// Optional managed image asset used by the name card.
    pub avatar_asset_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MontageSettings {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub encoder: String,
    pub quality: u8,
    pub background_music: Option<String>,
    pub music_volume: f64,
    /// Duration shared by cross-fade and slide transitions.
    pub transition_seconds: f64,
    /// Optional opening title rendered on a generated title card.
    pub intro_title: Option<String>,
    /// Opening title-card duration. A zero value disables the card.
    pub intro_duration_seconds: f64,
    /// Burn the per-clip title into the beginning of each clip.
    pub include_name_cards: bool,
    /// Maximum time for which a clip name card remains visible.
    pub name_card_duration_seconds: f64,
    /// Optional closing title rendered after the final clip.
    pub outro_title: Option<String>,
    /// Closing title-card duration. A zero value disables the card.
    pub outro_duration_seconds: f64,
    /// Reusable built-in visual package. The renderer owns the exact palette
    /// and typography so projects remain portable.
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
    use std::fmt::Debug;

    use serde::de::DeserializeOwned;

    use super::*;

    fn assert_exact_current_document<T>(document: &T)
    where
        T: Clone + Debug + DeserializeOwned + PartialEq + Serialize,
    {
        let current = serde_json::to_value(document).expect("serialize current document");
        let decoded = serde_json::from_value::<T>(current.clone()).expect("current document shape");
        assert_eq!(&decoded, document);

        let fields = current
            .as_object()
            .expect("root document object")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for field in fields {
            let mut missing = current.clone();
            missing
                .as_object_mut()
                .expect("root document object")
                .remove(&field);
            assert!(
                serde_json::from_value::<T>(missing).is_err(),
                "missing current field {field} must be rejected"
            );
        }

        let mut unknown = current;
        unknown["retired_field"] = serde_json::json!(true);
        assert!(
            serde_json::from_value::<T>(unknown).is_err(),
            "unknown root fields must be rejected"
        );
    }

    #[test]
    fn recording_job_accepts_only_the_complete_current_document() {
        let now = Utc::now();
        let job = RecordingJob {
            id: Uuid::new_v4(),
            retry_of: None,
            status: JobStatus::Queued,
            items: Vec::new(),
            current_index: 0,
            progress: 0.0,
            message: "queued".to_owned(),
            outputs: Vec::new(),
            created_at: now,
            updated_at: now,
        };

        assert_exact_current_document(&job);
    }

    #[test]
    fn failed_recording_retry_uses_only_the_proven_unpublished_suffix() {
        let now = Utc::now();
        let demo_id = Uuid::new_v4();
        let first_id = Uuid::new_v4();
        let second_id = Uuid::new_v4();
        let request = |id| RecordingRequest {
            id: Some(id),
            demo_id,
            highlight_id: None,
            player_id: "76561198000000000".to_owned(),
            title: format!("Capture {id}"),
            start_tick: 100,
            end_tick: 200,
            pre_roll_seconds: 1.0,
            post_roll_seconds: 2.0,
            victim_pov: false,
            camera_style: crate::HlaeCameraStyle::default(),
            presentation: None,
        };
        let job = RecordingJob {
            id: Uuid::new_v4(),
            retry_of: None,
            status: JobStatus::Failed,
            items: vec![request(first_id), request(second_id)],
            current_index: 1,
            progress: 0.5,
            message: "capture interrupted".to_owned(),
            outputs: vec![RecordedClip {
                id: Uuid::new_v4(),
                path: "recordings/first.mp4".to_owned(),
                title: "First".to_owned(),
                duration_seconds: 2.0,
                demo_id: Some(demo_id),
                player_name: Some("Player".to_owned()),
                category: "highlight".to_owned(),
                tags: Vec::new(),
                metadata: serde_json::json!({ "request_id": first_id }),
                created_at: now,
            }],
            created_at: now,
            updated_at: now,
        };

        assert_eq!(
            job.retryable_suffix().expect("retryable suffix"),
            &job.items[1..]
        );
    }

    #[test]
    fn recording_retry_fails_closed_for_unproven_prefixes_and_invalid_cursors() {
        let now = Utc::now();
        let demo_id = Uuid::new_v4();
        let first_id = Uuid::new_v4();
        let request = |id| RecordingRequest {
            id: Some(id),
            demo_id,
            highlight_id: None,
            player_id: "76561198000000000".to_owned(),
            title: format!("Capture {id}"),
            start_tick: 100,
            end_tick: 200,
            pre_roll_seconds: 0.0,
            post_roll_seconds: 0.0,
            victim_pov: false,
            camera_style: crate::HlaeCameraStyle::default(),
            presentation: None,
        };
        let valid = RecordingJob {
            id: Uuid::new_v4(),
            retry_of: None,
            status: JobStatus::Failed,
            items: vec![request(first_id), request(Uuid::new_v4())],
            current_index: 1,
            progress: 0.5,
            message: "capture interrupted".to_owned(),
            outputs: vec![RecordedClip {
                id: Uuid::new_v4(),
                path: "recordings/first.mp4".to_owned(),
                title: "First".to_owned(),
                duration_seconds: 2.0,
                demo_id: Some(demo_id),
                player_name: Some("Player".to_owned()),
                category: "highlight".to_owned(),
                tags: Vec::new(),
                metadata: serde_json::json!({ "request_id": first_id }),
                created_at: now,
            }],
            created_at: now,
            updated_at: now,
        };

        let mut active = valid.clone();
        active.status = JobStatus::Running;
        let mut completed = valid.clone();
        completed.status = JobStatus::Completed;
        let mut output_ahead_of_cursor = valid.clone();
        output_ahead_of_cursor.current_index = 0;
        let mut cursor_after_items = valid.clone();
        cursor_after_items.current_index = cursor_after_items.items.len();
        let mut missing_request_id = valid.clone();
        missing_request_id.outputs[0].metadata = serde_json::json!({});
        let mut changed_request_id = valid.clone();
        changed_request_id.outputs[0].metadata =
            serde_json::json!({ "request_id": Uuid::new_v4() });
        let mut anonymous_prefix = valid;
        anonymous_prefix.items[0].id = None;

        for ambiguous in [
            active,
            completed,
            output_ahead_of_cursor,
            cursor_after_items,
            missing_request_id,
            changed_request_id,
            anonymous_prefix,
        ] {
            assert!(ambiguous.retryable_suffix().is_err());
        }
    }

    #[test]
    fn recording_request_accepts_only_the_complete_current_document() {
        let request = RecordingRequest {
            id: None,
            demo_id: Uuid::new_v4(),
            highlight_id: None,
            player_id: "76561198000000000".to_owned(),
            title: "Round 12".to_owned(),
            start_tick: 100,
            end_tick: 200,
            pre_roll_seconds: 1.0,
            post_roll_seconds: 2.0,
            victim_pov: false,
            camera_style: crate::HlaeCameraStyle::default(),
            presentation: None,
        };

        let wire = serde_json::to_value(&request).expect("recording request wire");
        for retired in ["playback_speed", "show_keyboard", "show_kill_fx", "fade"] {
            assert!(
                wire.get(retired).is_none(),
                "retired recording field remained public: {retired}"
            );

            let mut retired_wire = wire.clone();
            retired_wire[retired] = serde_json::json!(false);
            assert!(
                serde_json::from_value::<RecordingRequest>(retired_wire).is_err(),
                "retired recording field remained accepted: {retired}"
            );
        }

        let decoded = serde_json::from_value::<RecordingRequest>(wire.clone())
            .expect("current recording request shape");
        assert_eq!(decoded, request);
        for field in wire
            .as_object()
            .expect("recording request object")
            .keys()
            .filter(|field| !matches!(field.as_str(), "camera_style" | "presentation"))
        {
            let mut missing = wire.clone();
            missing
                .as_object_mut()
                .expect("recording request object")
                .remove(field);
            assert!(
                serde_json::from_value::<RecordingRequest>(missing).is_err(),
                "missing current field {field} must be rejected"
            );
        }
        let mut without_presentation = wire.clone();
        without_presentation
            .as_object_mut()
            .expect("recording request object")
            .remove("presentation");
        assert_eq!(
            serde_json::from_value::<RecordingRequest>(without_presentation)
                .expect("a document written before per-shot presentation existed")
                .presentation,
            None
        );
        let mut legacy = wire.clone();
        legacy
            .as_object_mut()
            .expect("recording request object")
            .remove("camera_style");
        assert_eq!(
            serde_json::from_value::<RecordingRequest>(legacy)
                .expect("legacy recording request")
                .camera_style,
            crate::HlaeCameraStyle::Pov
        );
        let mut unknown = wire;
        unknown["retired_field"] = serde_json::json!(true);
        assert!(serde_json::from_value::<RecordingRequest>(unknown).is_err());
    }

    #[test]
    fn recorded_clip_accepts_only_the_complete_current_document() {
        let clip = RecordedClip {
            id: Uuid::new_v4(),
            path: "recordings/round-12.mp4".to_owned(),
            title: "Round 12".to_owned(),
            duration_seconds: 4.5,
            demo_id: None,
            player_name: None,
            category: "highlight".to_owned(),
            tags: vec!["round-12".to_owned()],
            metadata: serde_json::json!({"backend": "windows_media_foundation"}),
            created_at: Utc::now(),
        };

        assert_exact_current_document(&clip);
    }

    #[test]
    fn presentation_field_of_view_is_bounded_by_the_managed_capture_grammar() {
        RecordingPresentation::default()
            .validate()
            .expect("the neutral presentation is inside every bound");

        for camera_fov in [
            RECORDING_CAMERA_FOV_MIN,
            RECORDING_CAMERA_FOV_MAX,
            RECORDING_NEUTRAL_CAMERA_FOV,
        ] {
            RecordingPresentation {
                camera_fov,
                ..RecordingPresentation::default()
            }
            .validate()
            .expect("an in-range camera FOV");
        }
        for camera_fov in [
            RECORDING_CAMERA_FOV_MIN - 0.1,
            RECORDING_CAMERA_FOV_MAX + 0.1,
            f64::NAN,
            f64::INFINITY,
        ] {
            assert!(
                RecordingPresentation {
                    camera_fov,
                    ..RecordingPresentation::default()
                }
                .validate()
                .is_err(),
                "camera_fov {camera_fov} must be rejected at the API boundary"
            );
        }

        for viewmodel_fov in [RECORDING_VIEWMODEL_FOV_MIN, RECORDING_VIEWMODEL_FOV_MAX] {
            RecordingPresentation {
                viewmodel_fov,
                ..RecordingPresentation::default()
            }
            .validate()
            .expect("an in-range viewmodel FOV");
        }
        for viewmodel_fov in [
            RECORDING_VIEWMODEL_FOV_MIN - 0.1,
            RECORDING_VIEWMODEL_FOV_MAX + 0.1,
            f64::NAN,
        ] {
            assert!(
                RecordingPresentation {
                    viewmodel_fov,
                    ..RecordingPresentation::default()
                }
                .validate()
                .is_err(),
                "viewmodel_fov {viewmodel_fov} must be rejected at the API boundary"
            );
        }
    }

    #[test]
    fn voice_policy_is_one_closed_choice_and_never_two_bools() {
        for policy in [
            RecordingVoicePolicy::AllPlayers,
            RecordingVoicePolicy::Muted,
            RecordingVoicePolicy::TargetOnly,
        ] {
            assert_eq!(
                RecordingVoicePolicy::from_str_exact(policy.as_str()),
                Some(policy)
            );
            assert_eq!(
                serde_json::to_value(policy).expect("voice policy wire"),
                serde_json::json!(policy.as_str())
            );
        }
        assert_eq!(RecordingVoicePolicy::from_str_exact("mute_voice"), None);
        // The combination the runtime has to reject when it reads two bools
        // cannot even be spelled here.
        assert!(
            serde_json::from_value::<RecordingVoicePolicy>(serde_json::json!(
                "muted_and_target_only"
            ))
            .is_err()
        );
    }

    #[test]
    fn observer_shots_reject_a_field_of_view_that_would_never_be_applied() {
        let neutral = RecordingPresentation::default();
        let zoomed = RecordingPresentation {
            camera_fov: 110.0,
            ..neutral
        };
        let narrow_viewmodel = RecordingPresentation {
            viewmodel_fov: 54.0,
            ..neutral
        };

        neutral
            .validate_for(crate::HlaeCameraStyle::Pov)
            .expect("POV keeps the neutral values");
        zoomed
            .validate_for(crate::HlaeCameraStyle::Pov)
            .expect("POV is the only style a camera FOV reaches");
        narrow_viewmodel
            .validate_for(crate::HlaeCameraStyle::Pov)
            .expect("POV is the only style a viewmodel FOV reaches");

        for style in [
            crate::HlaeCameraStyle::Orbit,
            crate::HlaeCameraStyle::Dolly,
            crate::HlaeCameraStyle::Static,
            crate::HlaeCameraStyle::Tracking,
            crate::HlaeCameraStyle::Crane,
            crate::HlaeCameraStyle::Flyby,
        ] {
            neutral
                .validate_for(style)
                .expect("observer shots accept the neutral field of view");
            assert!(
                zoomed.validate_for(style).is_err(),
                "{style:?} takes its field of view from the camera path"
            );
            assert!(
                narrow_viewmodel.validate_for(style).is_err(),
                "{style:?} draws no viewmodel at all"
            );

            // The four style-independent controls stay free on both kinds.
            RecordingPresentation {
                flash_alpha: 102,
                show_hud: false,
                show_radar: false,
                voice: RecordingVoicePolicy::TargetOnly,
                ..neutral
            }
            .validate_for(style)
            .expect("flash, HUD, radar and voice apply to observer shots too");
        }
    }

    #[test]
    fn a_request_carries_its_presentation_through_its_own_validation() {
        let request = RecordingRequest {
            id: None,
            demo_id: Uuid::new_v4(),
            highlight_id: None,
            player_id: "76561198000000000".to_owned(),
            title: "02 跟随突破".to_owned(),
            start_tick: 148_812,
            end_tick: 149_356,
            pre_roll_seconds: 1.5,
            post_roll_seconds: 1.0,
            victim_pov: false,
            camera_style: crate::HlaeCameraStyle::Tracking,
            presentation: None,
        };
        request
            .validate()
            .expect("no presentation means the global defaults apply");

        let with_hidden_hud = RecordingRequest {
            presentation: Some(RecordingPresentation {
                show_hud: false,
                ..RecordingPresentation::default()
            }),
            ..request.clone()
        };
        with_hidden_hud
            .validate()
            .expect("HUD visibility is meaningful for an observer shot");

        let with_zoom = RecordingRequest {
            presentation: Some(RecordingPresentation {
                camera_fov: 120.0,
                ..RecordingPresentation::default()
            }),
            ..request.clone()
        };
        assert!(with_zoom.validate().is_err());

        let out_of_range = RecordingRequest {
            camera_style: crate::HlaeCameraStyle::Pov,
            presentation: Some(RecordingPresentation {
                camera_fov: 140.1,
                ..RecordingPresentation::default()
            }),
            ..request
        };
        assert!(out_of_range.validate().is_err());
    }

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
