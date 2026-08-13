use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    BeatAlignedClip, BeatAlignmentDraft, DomainError, EditorClip, EditorProject, EditorTrack,
    Highlight, ReplayFrame, TrackKind, Transform,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentProposalAction {
    ExportHlaePlan,
    ApplyBeatAlignment,
    ApplyHighlightEdit,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HlaeCameraStyle {
    Pov,
    Orbit,
    Dolly,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HlaeProposalMode {
    Preview,
    Capture,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HlaeProposalIntent {
    pub demo_id: Uuid,
    pub highlight_ids: Vec<String>,
    pub camera_style: HlaeCameraStyle,
    pub mode: HlaeProposalMode,
    pub lead_seconds: f64,
    pub tail_seconds: f64,
}

/// Trusted evidence loaded by the Rust application boundary, never authored by
/// the model or accepted from the proposal transport.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HlaeProposalEvidence {
    pub demo_path: String,
    pub demo_content_sha256: Option<String>,
    pub tick_rate: f64,
    pub highlights: Vec<Highlight>,
    pub replay_frames: Vec<ReplayFrame>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProposalPrerequisite {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HlaeProposalPreview {
    pub proposal_revision: u64,
    pub ready: bool,
    pub prerequisites: Vec<ProposalPrerequisite>,
    pub base_fingerprint: Option<String>,
    pub proposal_fingerprint: Option<String>,
    pub confirmation_token: Option<String>,
    /// The closed `vibe_cs_hlae::HlaePlan` JSON contract. Unknown command
    /// fields cannot pass the runtime parser.
    pub typed_plan: Option<serde_json::Value>,
    pub compiled_preview: Option<serde_json::Value>,
    pub notices: Vec<String>,
    /// Read-only managed-release readiness and launch-safety state loaded by
    /// the application boundary. Preview/export remain available for review
    /// even when HLAE is not installed; execution is never implied.
    pub installation_status: Option<crate::HlaeStatus>,
}

impl HlaeProposalPreview {
    #[must_use]
    pub fn prerequisites(items: Vec<ProposalPrerequisite>) -> Self {
        Self {
            proposal_revision: 2,
            ready: false,
            prerequisites: items,
            base_fingerprint: None,
            proposal_fingerprint: None,
            confirmation_token: None,
            typed_plan: None,
            compiled_preview: None,
            notices: Vec::new(),
            installation_status: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProposalConfirmation {
    pub base_fingerprint: String,
    pub proposal_fingerprint: String,
    pub confirmation_token: String,
    pub expected_revision: u64,
    pub confirm: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HlaeProposalExportRequest {
    pub intent: HlaeProposalIntent,
    #[serde(flatten)]
    pub confirmation: ProposalConfirmation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HlaeProposalExportResult {
    pub base_fingerprint: String,
    pub proposal_fingerprint: String,
    pub directory: String,
    pub files: Vec<String>,
    pub completion_marker: String,
    /// HLAE remains process-free: exporting never launches CS2 or HLAE.
    pub launched: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BeatAlignmentProposalRequest {
    pub project_id: Uuid,
    pub expected_revision: u64,
    pub audio_asset_id: Uuid,
    pub audio_placement: BeatAlignmentAudioPlacementIntent,
    pub draft: BeatAlignmentDraft,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BeatAlignmentAudioPlacementIntent {
    pub timeline_start_seconds: f64,
    pub source_in_seconds: f64,
    pub volume: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BeatAlignmentAudioBinding {
    pub asset_id: Uuid,
    pub name: String,
    pub kind: String,
    pub file_size: u64,
    pub duration_seconds: f64,
    pub asset_fingerprint: String,
    pub content_sha256: String,
    pub analysis_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BeatAlignmentAudioPlacement {
    pub track_id: Uuid,
    pub clip_id: Uuid,
    pub timeline_start_seconds: f64,
    pub timeline_end_seconds: f64,
    pub source_in_seconds: f64,
    pub source_out_seconds: f64,
    pub volume: f64,
    pub insert_audio_track: bool,
    pub insert_audio_clip: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BeatAlignmentProposalPreview {
    pub ready: bool,
    pub prerequisites: Vec<ProposalPrerequisite>,
    pub project_id: Uuid,
    pub expected_revision: u64,
    pub base_fingerprint: Option<String>,
    pub proposal_fingerprint: Option<String>,
    pub confirmation_token: Option<String>,
    pub audio: Option<BeatAlignmentAudioBinding>,
    pub audio_placement: Option<BeatAlignmentAudioPlacement>,
    pub changes: Vec<BeatAlignedClip>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BeatAlignmentApplyRequest {
    pub project_id: Uuid,
    pub audio_asset_id: Uuid,
    pub audio_placement: BeatAlignmentAudioPlacementIntent,
    pub draft: BeatAlignmentDraft,
    #[serde(flatten)]
    pub confirmation: ProposalConfirmation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BeatAlignmentApplyResult {
    pub project_id: Uuid,
    pub previous_revision: u64,
    pub revision: u64,
    pub applied_clip_ids: Vec<Uuid>,
    pub audio_track_id: Uuid,
    pub audio_clip_id: Uuid,
    pub audio_clip_inserted: bool,
    pub snapshot_created: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HighlightEditProposalIntent {
    pub pacing: HighlightEditPacing,
    pub include_context_seconds: f64,
    pub transition: HighlightEditTransition,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HighlightEditPacing {
    Measured,
    Energetic,
    Impact,
}

impl HighlightEditPacing {
    #[must_use]
    pub const fn playback_speed(self) -> f64 {
        match self {
            Self::Measured => 1.0,
            Self::Energetic => 1.15,
            Self::Impact => 0.85,
        }
    }

    #[must_use]
    pub const fn transition_duration_seconds(self) -> f64 {
        match self {
            Self::Measured => 0.45,
            Self::Energetic => 0.20,
            Self::Impact => 0.12,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HighlightEditTransition {
    Cut,
    Fade,
    Flash,
    Slide,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HighlightEditProposalRequest {
    pub demo_id: Uuid,
    pub highlight_ids: Vec<String>,
    pub intent: HighlightEditProposalIntent,
    /// `null` prepares a new editor project. Existing projects are always
    /// revision-bound and must provide `expected_revision`.
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub target_project_id: Option<Uuid>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub expected_revision: Option<u64>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub new_project_name: Option<String>,
}

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HighlightAssetMapping {
    pub highlight_id: String,
    pub recorded_clip_id: Uuid,
    pub path: String,
    pub duration_seconds: f64,
    pub file_size: u64,
    pub content_sha256: String,
    /// Trusted capture boundaries retained in the managed recording metadata.
    pub capture_start_tick: u64,
    pub capture_end_tick: u64,
    pub tick_rate: f64,
    /// Playback speed used while the demo was captured. This maps demo ticks
    /// to exact source-media seconds without trusting model-authored timing.
    pub capture_playback_speed: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HighlightEditClipInsert {
    pub highlight_id: String,
    pub recorded_clip_id: Uuid,
    pub editor_clip_id: Uuid,
    pub timeline_start_seconds: f64,
    pub timeline_end_seconds: f64,
    pub source_start_tick: u64,
    pub source_end_tick: u64,
    pub source_in_seconds: f64,
    pub source_out_seconds: f64,
    pub playback_speed: f64,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub transition_in: Option<HighlightEditTransition>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub transition_duration_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HighlightEditPlan {
    pub demo_id: Uuid,
    pub intent: HighlightEditProposalIntent,
    pub project_id: Uuid,
    pub project_name: String,
    pub create_project: bool,
    /// Zero is the create-new sentinel. Existing projects use their exact
    /// persisted revision.
    pub expected_revision: u64,
    pub target_track_id: Uuid,
    pub create_track: bool,
    pub mappings: Vec<HighlightAssetMapping>,
    pub insertions: Vec<HighlightEditClipInsert>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HighlightEditProposalPreview {
    pub ready: bool,
    pub prerequisites: Vec<ProposalPrerequisite>,
    pub mappings: Vec<HighlightAssetMapping>,
    pub insertions: Vec<HighlightEditClipInsert>,
    pub target_project_id: Option<Uuid>,
    pub creates_new_project: bool,
    pub expected_revision: u64,
    pub base_fingerprint: Option<String>,
    pub proposal_fingerprint: Option<String>,
    pub confirmation_token: Option<String>,
    pub plan: Option<HighlightEditPlan>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HighlightEditApplyRequest {
    pub request: HighlightEditProposalRequest,
    pub plan: HighlightEditPlan,
    #[serde(flatten)]
    pub confirmation: ProposalConfirmation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HighlightEditApplyResult {
    pub project_id: Uuid,
    pub previous_revision: u64,
    pub revision: u64,
    pub inserted_clip_ids: Vec<Uuid>,
    pub project_created: bool,
    pub snapshot_created: bool,
    pub already_applied: bool,
}

impl EditorProject {
    /// Inserts the exact, closed highlight-edit plan into this project.
    /// Recorded clips remain first-class managed sources and are referenced by
    /// their durable identifiers; filesystem evidence is verified by the
    /// application boundary before this method is called.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] or [`DomainError::Conflict`] when
    /// the signed plan is malformed, stale, or targets a locked/non-video
    /// track.
    pub fn apply_highlight_edit_plan(
        &mut self,
        plan: &HighlightEditPlan,
    ) -> Result<Vec<Uuid>, DomainError> {
        use std::collections::HashSet;

        if self.id != plan.project_id
            || plan.insertions.is_empty()
            || plan.insertions.len() > 16
            || plan.insertions.len() != plan.mappings.len()
            || !plan.intent.include_context_seconds.is_finite()
            || !(0.0..=8.0).contains(&plan.intent.include_context_seconds)
        {
            return Err(DomainError::InvalidInput(
                "highlight edit plan is not bound to this project".to_owned(),
            ));
        }
        let mut highlight_ids = HashSet::new();
        let mut source_ids = HashSet::new();
        let mut editor_ids = self
            .tracks
            .iter()
            .flat_map(|track| track.clips.iter().map(|clip| clip.id))
            .collect::<HashSet<_>>();
        for (index, (mapping, insertion)) in plan.mappings.iter().zip(&plan.insertions).enumerate()
        {
            let expected_transition =
                if index == 0 || plan.intent.transition == HighlightEditTransition::Cut {
                    None
                } else {
                    Some(plan.intent.transition)
                };
            let timeline_duration =
                insertion.timeline_end_seconds - insertion.timeline_start_seconds;
            let source_start_delta = insertion
                .source_start_tick
                .checked_sub(mapping.capture_start_tick)
                .and_then(|ticks| u32::try_from(ticks).ok());
            let source_end_delta = insertion
                .source_end_tick
                .checked_sub(mapping.capture_start_tick)
                .and_then(|ticks| u32::try_from(ticks).ok());
            let expected_source_in = source_start_delta.map_or(f64::NAN, f64::from)
                / mapping.tick_rate
                / mapping.capture_playback_speed;
            let expected_source_out = source_end_delta.map_or(f64::NAN, f64::from)
                / mapping.tick_rate
                / mapping.capture_playback_speed;
            let expected_transition_duration = expected_transition.map(|_| {
                plan.intent
                    .pacing
                    .transition_duration_seconds()
                    .min(timeline_duration / 2.0)
            });
            let transition_duration_matches = match (
                insertion.transition_duration_seconds,
                expected_transition_duration,
            ) {
                (None, None) => true,
                (Some(actual), Some(expected)) => {
                    actual.is_finite()
                        && (0.05..timeline_duration).contains(&actual)
                        && (actual - expected).abs() <= 0.000_001
                }
                _ => false,
            };
            if mapping.highlight_id != insertion.highlight_id
                || mapping.recorded_clip_id != insertion.recorded_clip_id
                || !highlight_ids.insert(&insertion.highlight_id)
                || !source_ids.insert(insertion.recorded_clip_id)
                || !editor_ids.insert(insertion.editor_clip_id)
                || !mapping.duration_seconds.is_finite()
                || mapping.duration_seconds <= 0.0
                || mapping.capture_end_tick <= mapping.capture_start_tick
                || !mapping.tick_rate.is_finite()
                || !(1.0..=256.0).contains(&mapping.tick_rate)
                || !mapping.capture_playback_speed.is_finite()
                || !(0.05..=16.0).contains(&mapping.capture_playback_speed)
                || !insertion.timeline_start_seconds.is_finite()
                || !insertion.timeline_end_seconds.is_finite()
                || !insertion.source_in_seconds.is_finite()
                || !insertion.source_out_seconds.is_finite()
                || insertion.source_start_tick < mapping.capture_start_tick
                || insertion.source_end_tick <= insertion.source_start_tick
                || insertion.source_end_tick > mapping.capture_end_tick
                || source_start_delta.is_none()
                || source_end_delta.is_none()
                || insertion.timeline_start_seconds < 0.0
                || insertion.timeline_end_seconds <= insertion.timeline_start_seconds
                || insertion.source_in_seconds < 0.0
                || insertion.source_out_seconds <= insertion.source_in_seconds
                || insertion.source_out_seconds > mapping.duration_seconds + 0.001
                || (insertion.source_in_seconds - expected_source_in).abs() > 0.001
                || (insertion.source_out_seconds - expected_source_out).abs() > 0.001
                || !insertion.playback_speed.is_finite()
                || !(0.05..=16.0).contains(&insertion.playback_speed)
                || (insertion.playback_speed - plan.intent.pacing.playback_speed()).abs()
                    > 0.000_001
                || (timeline_duration
                    - (insertion.source_out_seconds - insertion.source_in_seconds)
                        / insertion.playback_speed)
                    .abs()
                    > 0.001
                || insertion.transition_in != expected_transition
                || !transition_duration_matches
            {
                return Err(DomainError::InvalidInput(
                    "highlight edit plan contains an invalid clip insertion".to_owned(),
                ));
            }
        }
        if plan.insertions.windows(2).any(|pair| {
            (pair[0].timeline_end_seconds - pair[1].timeline_start_seconds).abs() > 0.001
        }) {
            return Err(DomainError::InvalidInput(
                "highlight edit insertions must form one ordered sequence".to_owned(),
            ));
        }

        let mut updated = self.clone();
        if plan.create_track {
            if updated
                .tracks
                .iter()
                .any(|track| track.id == plan.target_track_id)
            {
                return Err(DomainError::Conflict(
                    "highlight edit target track already exists".to_owned(),
                ));
            }
            let order = u32::try_from(updated.tracks.len()).map_err(|_| {
                DomainError::InvalidInput("editor project has too many tracks".to_owned())
            })?;
            updated.tracks.push(EditorTrack {
                id: plan.target_track_id,
                name: "AI 精选".to_owned(),
                kind: TrackKind::Video,
                order,
                muted: false,
                locked: false,
                hidden: false,
                clips: Vec::new(),
            });
        }
        let target = updated
            .tracks
            .iter_mut()
            .find(|track| track.id == plan.target_track_id)
            .ok_or_else(|| {
                DomainError::Conflict("highlight edit target track is missing".to_owned())
            })?;
        if target.kind != TrackKind::Video || target.locked {
            return Err(DomainError::Conflict(
                "highlight edit target must be an unlocked video track".to_owned(),
            ));
        }
        for insertion in &plan.insertions {
            target.clips.push(EditorClip {
                id: insertion.editor_clip_id,
                asset_id: Some(insertion.recorded_clip_id),
                name: format!("精选 · {}", insertion.highlight_id),
                start: insertion.timeline_start_seconds,
                duration: insertion.timeline_end_seconds - insertion.timeline_start_seconds,
                source_in: insertion.source_in_seconds,
                source_out: insertion.source_out_seconds,
                speed: insertion.playback_speed,
                volume: 1.0,
                transform: Transform::default(),
                effects: Vec::new(),
                transition_in: insertion.transition_in.map(|transition| match transition {
                    HighlightEditTransition::Cut => "cut".to_owned(),
                    HighlightEditTransition::Fade => "fade".to_owned(),
                    HighlightEditTransition::Flash => "flash".to_owned(),
                    HighlightEditTransition::Slide => "slide".to_owned(),
                }),
                transition_out: None,
                text: None,
                metadata: serde_json::json!({
                    "origin": "highlight_edit_proposal",
                    "demo_id": plan.demo_id,
                    "highlight_id": insertion.highlight_id,
                    "recorded_clip_id": insertion.recorded_clip_id,
                    "source_start_tick": insertion.source_start_tick,
                    "source_end_tick": insertion.source_end_tick,
                    "pacing": plan.intent.pacing,
                    "include_context_seconds": plan.intent.include_context_seconds,
                    "transition_duration": insertion.transition_duration_seconds,
                }),
                group_id: None,
                link_group_id: None,
                keyframes: Vec::new(),
                speed_segments: Vec::new(),
            });
        }
        updated.duration_seconds = updated.duration_seconds.max(
            plan.insertions
                .last()
                .map_or(0.0, |insertion| insertion.timeline_end_seconds),
        );
        updated.validate()?;
        *self = updated;
        Ok(plan
            .insertions
            .iter()
            .map(|insertion| insertion.editor_clip_id)
            .collect())
    }

    /// Applies only the closed timing fields represented by a beat-alignment
    /// draft. The edit is first validated on a clone, so persistence can retain
    /// one coherent before-snapshot and never observe a partial project.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] or [`DomainError::Conflict`] when
    /// a clip is missing, stale, locked, linked, automated, or would leave the
    /// project timeline or supported playback-speed bounds.
    pub fn apply_beat_alignment_draft(
        &mut self,
        draft: &BeatAlignmentDraft,
    ) -> Result<Vec<Uuid>, DomainError> {
        use std::collections::HashSet;

        if !draft.advisory_only || draft.clips.is_empty() || draft.clips.len() > 256 {
            return Err(DomainError::InvalidInput(
                "beat alignment must be a bounded advisory draft".to_owned(),
            ));
        }
        let mut ids = HashSet::new();
        let mut parsed = Vec::with_capacity(draft.clips.len());
        for alignment in &draft.clips {
            let clip_id = Uuid::parse_str(&alignment.clip_id).map_err(|_| {
                DomainError::InvalidInput(format!(
                    "beat alignment clip id {} is invalid",
                    alignment.clip_id
                ))
            })?;
            if !ids.insert(clip_id) {
                return Err(DomainError::InvalidInput(
                    "beat alignment contains a duplicate clip id".to_owned(),
                ));
            }
            if !alignment.timeline_start_seconds.is_finite()
                || !alignment.timeline_end_seconds.is_finite()
                || !alignment.planned_duration_seconds.is_finite()
                || !alignment.source_duration_seconds.is_finite()
                || alignment.timeline_start_seconds < 0.0
                || alignment.planned_duration_seconds <= 0.0
                || alignment.source_duration_seconds <= 0.0
                || (alignment.timeline_end_seconds
                    - alignment.timeline_start_seconds
                    - alignment.planned_duration_seconds)
                    .abs()
                    > 0.000_001
                || alignment.timeline_end_seconds > self.duration_seconds + 0.000_001
            {
                return Err(DomainError::InvalidInput(format!(
                    "beat alignment for clip {clip_id} is outside the project timeline"
                )));
            }
            parsed.push((clip_id, alignment));
        }

        let mut updated = self.clone();
        for (clip_id, alignment) in &parsed {
            let Some((track_locked, clip)) = updated.tracks.iter_mut().find_map(|track| {
                track
                    .clips
                    .iter_mut()
                    .find(|clip| clip.id == *clip_id)
                    .map(|clip| (track.locked, clip))
            }) else {
                return Err(DomainError::InvalidInput(format!(
                    "beat alignment clip {clip_id} does not exist in the project"
                )));
            };
            if track_locked {
                return Err(DomainError::Conflict(format!(
                    "beat alignment clip {clip_id} belongs to a locked track"
                )));
            }
            if clip.asset_id.is_none()
                || clip.text.is_some()
                || clip.group_id.is_some()
                || clip.link_group_id.is_some()
                || !clip.speed_segments.is_empty()
                || clip
                    .keyframes
                    .iter()
                    .any(|keyframe| keyframe.time > alignment.planned_duration_seconds + 0.000_001)
            {
                return Err(DomainError::InvalidInput(format!(
                    "beat alignment clip {clip_id} has unsupported links or timeline automation"
                )));
            }
            if (clip.duration - alignment.source_duration_seconds).abs() > 0.001 {
                return Err(DomainError::Conflict(format!(
                    "beat alignment clip {clip_id} duration no longer matches its proposal"
                )));
            }
            let source_span = clip.source_out - clip.source_in;
            let speed = source_span / alignment.planned_duration_seconds;
            if !speed.is_finite() || !(0.05..=16.0).contains(&speed) {
                return Err(DomainError::InvalidInput(format!(
                    "beat alignment clip {clip_id} requires an unsupported playback speed"
                )));
            }
            clip.start = alignment.timeline_start_seconds;
            clip.duration = alignment.planned_duration_seconds;
            clip.speed = speed;
        }
        updated.validate()?;
        *self = updated;
        Ok(parsed.into_iter().map(|(id, _)| id).collect())
    }

    /// Applies a signed BGM placement and the associated video timing as one
    /// in-memory document mutation. Persistence is responsible for verifying
    /// the bound media asset before committing this document and its snapshot.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] or [`DomainError::Conflict`] when
    /// the audio binding, placement, target track, clip identity, or video
    /// timing no longer matches the reviewed proposal.
    pub fn apply_beat_alignment_with_audio(
        &mut self,
        draft: &BeatAlignmentDraft,
        audio: &BeatAlignmentAudioBinding,
        placement: &BeatAlignmentAudioPlacement,
    ) -> Result<(Vec<Uuid>, bool), DomainError> {
        let valid_hash =
            |value: &str| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
        let duration = placement.timeline_end_seconds - placement.timeline_start_seconds;
        let source_duration = placement.source_out_seconds - placement.source_in_seconds;
        if audio.name.trim().is_empty()
            || audio.name.chars().count() > 512
            || audio.kind.trim().is_empty()
            || audio.file_size == 0
            || !audio.duration_seconds.is_finite()
            || audio.duration_seconds <= 0.0
            || !valid_hash(&audio.asset_fingerprint)
            || !valid_hash(&audio.content_sha256)
            || !valid_hash(&audio.analysis_sha256)
            || !placement.timeline_start_seconds.is_finite()
            || !placement.timeline_end_seconds.is_finite()
            || !placement.source_in_seconds.is_finite()
            || !placement.source_out_seconds.is_finite()
            || !placement.volume.is_finite()
            || placement.timeline_start_seconds < 0.0
            || placement.source_in_seconds < 0.0
            || duration <= 0.0
            || source_duration <= 0.0
            || (duration - source_duration).abs() > 0.000_001
            || placement.source_out_seconds > audio.duration_seconds + 0.001
            || placement.timeline_end_seconds > self.duration_seconds + 0.000_001
            || !(0.0..=4.0).contains(&placement.volume)
        {
            return Err(DomainError::InvalidInput(
                "beat alignment contains an invalid BGM binding or placement".to_owned(),
            ));
        }

        let mut updated = self.clone();
        let applied_clip_ids = updated.apply_beat_alignment_draft(draft)?;
        let matching = updated.tracks.iter().find_map(|track| {
            track
                .clips
                .iter()
                .find(|clip| clip.id == placement.clip_id)
                .map(|clip| (track, clip))
        });
        let inserted = if let Some((track, clip)) = matching {
            if placement.insert_audio_clip
                || track.id != placement.track_id
                || track.kind != TrackKind::Audio
                || track.locked
                || track.muted
                || track.hidden
                || clip.asset_id != Some(audio.asset_id)
                || clip.text.is_some()
                || (clip.start - placement.timeline_start_seconds).abs() > 0.000_001
                || (clip.duration - duration).abs() > 0.000_001
                || (clip.source_in - placement.source_in_seconds).abs() > 0.000_001
                || (clip.source_out - placement.source_out_seconds).abs() > 0.000_001
                || (clip.volume - placement.volume).abs() > 0.000_001
            {
                return Err(DomainError::Conflict(
                    "the bound BGM placement changed; preview it again".to_owned(),
                ));
            }
            let Some(clip) = updated
                .tracks
                .iter_mut()
                .find(|candidate| candidate.id == placement.track_id)
                .and_then(|candidate| {
                    candidate
                        .clips
                        .iter_mut()
                        .find(|candidate| candidate.id == placement.clip_id)
                })
            else {
                return Err(DomainError::Conflict(
                    "the bound BGM clip changed; preview it again".to_owned(),
                ));
            };
            let metadata = serde_json::json!({
                "asset_fingerprint": audio.asset_fingerprint,
                "content_sha256": audio.content_sha256,
                "analysis_sha256": audio.analysis_sha256,
            });
            if let Some(object) = clip.metadata.as_object_mut() {
                object.insert(
                    "origin".to_owned(),
                    serde_json::Value::String("beat_alignment_bgm".to_owned()),
                );
                object.insert("beat_alignment_bgm".to_owned(), metadata);
            } else {
                clip.metadata = serde_json::json!({
                    "origin": "beat_alignment_bgm",
                    "beat_alignment_bgm": metadata,
                });
            }
            false
        } else {
            if !placement.insert_audio_clip {
                return Err(DomainError::Conflict(
                    "the bound BGM clip no longer exists; preview it again".to_owned(),
                ));
            }
            if updated
                .tracks
                .iter()
                .any(|track| track.id == placement.track_id && track.kind != TrackKind::Audio)
            {
                return Err(DomainError::Conflict(
                    "the selected BGM track changed; preview it again".to_owned(),
                ));
            }
            let clip = EditorClip {
                id: placement.clip_id,
                asset_id: Some(audio.asset_id),
                name: audio.name.clone(),
                start: placement.timeline_start_seconds,
                duration,
                source_in: placement.source_in_seconds,
                source_out: placement.source_out_seconds,
                speed: 1.0,
                volume: placement.volume,
                transform: crate::Transform::default(),
                effects: Vec::new(),
                transition_in: None,
                transition_out: None,
                text: None,
                metadata: serde_json::json!({
                    "origin": "beat_alignment_bgm",
                    "beat_alignment_bgm": {
                        "asset_fingerprint": audio.asset_fingerprint,
                        "content_sha256": audio.content_sha256,
                        "analysis_sha256": audio.analysis_sha256,
                    }
                }),
                group_id: None,
                link_group_id: None,
                keyframes: Vec::new(),
                speed_segments: Vec::new(),
            };
            if let Some(track) = updated
                .tracks
                .iter_mut()
                .find(|track| track.id == placement.track_id)
            {
                if placement.insert_audio_track || track.locked || track.muted || track.hidden {
                    return Err(DomainError::Conflict(
                        "the selected BGM track changed; preview it again".to_owned(),
                    ));
                }
                track.clips.push(clip);
            } else {
                if !placement.insert_audio_track {
                    return Err(DomainError::Conflict(
                        "the selected BGM track no longer exists; preview it again".to_owned(),
                    ));
                }
                let order = updated
                    .tracks
                    .iter()
                    .map(|track| track.order)
                    .max()
                    .map_or(0, |order| order.saturating_add(1));
                updated.tracks.push(EditorTrack {
                    id: placement.track_id,
                    name: "BGM".to_owned(),
                    kind: TrackKind::Audio,
                    order,
                    muted: false,
                    locked: false,
                    hidden: false,
                    clips: vec![clip],
                });
            }
            true
        };
        updated.validate()?;
        *self = updated;
        Ok((applied_clip_ids, inserted))
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;

    fn current_preview_with_managed_status() -> serde_json::Value {
        let mut current = serde_json::to_value(HlaeProposalPreview::prerequisites(Vec::new()))
            .expect("serialize current proposal preview");
        current["installation_status"] = serde_json::json!({
            "available": false,
            "executable": null,
            "source2_hook": null,
            "source": null,
            "managed_release": {
                "version": "reviewed-release",
                "archive_sha256": "a".repeat(64),
                "signing_fingerprint": "reviewed-fingerprint",
                "prepared": false
            },
            "messages": ["prepare the managed movie engine"],
            "cs2_executable": null,
            "launch_profile_ready": false,
            "automatic_launch_enabled": false,
            "insecure_mode_required": true,
            "vac_servers_prohibited": true,
            "demo_playback_only": true
        });
        current
    }

    #[test]
    fn hlae_preview_accepts_only_the_current_exact_shape() {
        let preview = HlaeProposalPreview::prerequisites(Vec::new());
        let current = serde_json::to_value(&preview).expect("serialize current proposal preview");
        assert_eq!(
            serde_json::from_value::<HlaeProposalPreview>(current.clone())
                .expect("current proposal preview shape"),
            preview
        );

        let mut invalid = current;
        invalid["unexpected"] = serde_json::json!(true);
        assert!(serde_json::from_value::<HlaeProposalPreview>(invalid).is_err());
    }

    #[test]
    fn hlae_preview_serializes_only_the_current_managed_status() {
        let mut preview = HlaeProposalPreview::prerequisites(Vec::new());
        preview.installation_status = Some(crate::HlaeStatus {
            available: false,
            executable: None,
            source2_hook: None,
            source: None,
            managed_release: crate::ManagedHlaeReleaseStatus {
                version: "reviewed-release".to_owned(),
                archive_sha256: "a".repeat(64),
                signing_fingerprint: "reviewed-fingerprint".to_owned(),
                prepared: false,
            },
            messages: vec!["prepare the managed movie engine".to_owned()],
            cs2_executable: None,
            launch_profile_ready: false,
            automatic_launch_enabled: false,
            insecure_mode_required: true,
            vac_servers_prohibited: true,
            demo_playback_only: true,
        });

        let encoded = serde_json::to_value(preview).expect("serialize HLAE proposal preview");
        let status = encoded["installation_status"]
            .as_object()
            .expect("managed HLAE status object");

        assert!(!status.contains_key("configured_path"));
        assert!(!status.contains_key("checked_locations"));
        assert_eq!(status["source"], serde_json::Value::Null);
        assert!(status.contains_key("managed_release"));
    }

    #[test]
    fn hlae_preview_rejects_unknown_managed_status_fields() {
        let mut current = current_preview_with_managed_status();
        serde_json::from_value::<HlaeProposalPreview>(current.clone())
            .expect("current managed HLAE status");

        current["installation_status"]["configured_path"] =
            serde_json::json!("retired-manual-path");

        assert!(serde_json::from_value::<HlaeProposalPreview>(current).is_err());
    }

    #[test]
    fn hlae_preview_rejects_unknown_managed_release_fields() {
        let mut current = current_preview_with_managed_status();
        current["installation_status"]["managed_release"]["legacy_source"] =
            serde_json::json!("manual");

        assert!(serde_json::from_value::<HlaeProposalPreview>(current).is_err());
    }

    #[test]
    fn highlight_intent_rejects_untyped_renderer_transitions() {
        let request = serde_json::json!({
            "demo_id": Uuid::new_v4(),
            "highlight_ids": ["h-1"],
            "intent": {
                "pacing": "energetic",
                "include_context_seconds": 2.0,
                "transition": "whip"
            }
        });
        assert!(serde_json::from_value::<HighlightEditProposalRequest>(request).is_err());
    }

    #[test]
    fn highlight_edit_request_requires_the_current_explicit_nullable_shape() {
        let current = serde_json::json!({
            "demo_id": Uuid::new_v4(),
            "highlight_ids": ["h-1"],
            "intent": {
                "pacing": "energetic",
                "include_context_seconds": 2.0,
                "transition": "slide"
            },
            "target_project_id": null,
            "expected_revision": null,
            "new_project_name": null
        });
        let parsed = serde_json::from_value::<HighlightEditProposalRequest>(current.clone())
            .expect("current request shape");
        assert_eq!(parsed.target_project_id, None);
        assert_eq!(parsed.expected_revision, None);
        assert_eq!(parsed.new_project_name, None);

        for field in ["target_project_id", "expected_revision", "new_project_name"] {
            let mut missing = current.clone();
            missing
                .as_object_mut()
                .expect("request object")
                .remove(field);
            assert!(
                serde_json::from_value::<HighlightEditProposalRequest>(missing).is_err(),
                "missing {field} must not select an implicit retired default"
            );
        }
    }

    #[test]
    fn highlight_edit_plan_accepts_only_the_current_exact_shape() {
        let current = serde_json::json!({
            "demo_id": Uuid::new_v4(),
            "intent": {
                "pacing": "measured",
                "include_context_seconds": 0.0,
                "transition": "cut"
            },
            "project_id": Uuid::new_v4(),
            "project_name": "Current edit",
            "create_project": false,
            "expected_revision": 1,
            "target_track_id": Uuid::new_v4(),
            "create_track": false,
            "mappings": [{
                "highlight_id": "h-1",
                "recorded_clip_id": Uuid::new_v4(),
                "path": "managed.mp4",
                "duration_seconds": 3.0,
                "file_size": 5,
                "content_sha256": "00".repeat(32),
                "capture_start_tick": 0,
                "capture_end_tick": 192,
                "tick_rate": 64.0,
                "capture_playback_speed": 1.0
            }],
            "insertions": [{
                "highlight_id": "h-1",
                "recorded_clip_id": Uuid::new_v4(),
                "editor_clip_id": Uuid::new_v4(),
                "timeline_start_seconds": 0.0,
                "timeline_end_seconds": 3.0,
                "source_start_tick": 0,
                "source_end_tick": 192,
                "source_in_seconds": 0.0,
                "source_out_seconds": 3.0,
                "playback_speed": 1.0,
                "transition_in": null,
                "transition_duration_seconds": null
            }]
        });
        serde_json::from_value::<HighlightEditPlan>(current.clone())
            .expect("current highlight edit plan");

        let mut retired = current.clone();
        retired["insertions"][0]["legacy_transition"] = serde_json::json!("fade");
        assert!(serde_json::from_value::<HighlightEditPlan>(retired).is_err());

        for field in ["transition_in", "transition_duration_seconds"] {
            let mut missing = current.clone();
            missing["insertions"][0]
                .as_object_mut()
                .expect("highlight insertion")
                .remove(field);
            assert!(
                serde_json::from_value::<HighlightEditPlan>(missing).is_err(),
                "missing {field} must not select an implicit retired default"
            );
        }
    }

    use crate::{BeatAlignedClip, EditorClip, EditorTrack, TrackKind, Transform};

    fn project() -> EditorProject {
        let now = Utc::now();
        EditorProject {
            id: Uuid::new_v4(),
            name: "Edit".to_owned(),
            width: 1920,
            height: 1080,
            fps: 60,
            duration_seconds: 10.0,
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
                    asset_id: Some(Uuid::new_v4()),
                    name: "Clip".to_owned(),
                    start: 0.0,
                    duration: 4.0,
                    source_in: 0.0,
                    source_out: 4.0,
                    speed: 1.0,
                    volume: 1.0,
                    transform: Transform::default(),
                    effects: Vec::new(),
                    transition_in: None,
                    transition_out: None,
                    text: None,
                    metadata: serde_json::json!({}),
                    group_id: None,
                    link_group_id: None,
                    keyframes: Vec::new(),
                    speed_segments: Vec::new(),
                }],
            }],
            markers: Vec::new(),
            settings: serde_json::json!({}),
            revision: 1,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn missing_clip_rejects_the_entire_alignment_without_mutation() {
        let mut project = project();
        let original = project.clone();
        let draft = BeatAlignmentDraft {
            advisory_only: true,
            clips: vec![BeatAlignedClip {
                clip_id: Uuid::new_v4().to_string(),
                timeline_start_seconds: 1.0,
                timeline_end_seconds: 4.0,
                planned_duration_seconds: 3.0,
                source_duration_seconds: 4.0,
                duration_change_ratio: -0.25,
                start_beat_index: 0,
                end_beat_index: 4,
                rationale: Vec::new(),
            }],
            unplaced_clip_ids: Vec::new(),
            constraints: Vec::new(),
        };
        assert!(project.apply_beat_alignment_draft(&draft).is_err());
        assert_eq!(project, original);
    }

    #[test]
    fn alignment_changes_only_timing_and_playback_speed() {
        let mut project = project();
        let original_clip = project.tracks[0].clips[0].clone();
        let draft = BeatAlignmentDraft {
            advisory_only: true,
            clips: vec![BeatAlignedClip {
                clip_id: original_clip.id.to_string(),
                timeline_start_seconds: 2.0,
                timeline_end_seconds: 5.0,
                planned_duration_seconds: 3.0,
                source_duration_seconds: 4.0,
                duration_change_ratio: -0.25,
                start_beat_index: 0,
                end_beat_index: 4,
                rationale: Vec::new(),
            }],
            unplaced_clip_ids: Vec::new(),
            constraints: Vec::new(),
        };
        project.apply_beat_alignment_draft(&draft).unwrap();
        let updated = &project.tracks[0].clips[0];
        assert!((updated.start - 2.0).abs() < 0.000_001);
        assert!((updated.duration - 3.0).abs() < 0.000_001);
        assert!((updated.speed - 4.0 / 3.0).abs() < 0.000_001);
        assert_eq!(updated.asset_id, original_clip.asset_id);
        assert!((updated.source_in - original_clip.source_in).abs() < 0.000_001);
        assert!((updated.source_out - original_clip.source_out).abs() < 0.000_001);
    }

    #[test]
    fn highlight_plan_inserts_only_the_signed_recorded_sources() {
        let mut project = project();
        project.tracks[0].clips.clear();
        project.duration_seconds = 0.0;
        let track_id = project.tracks[0].id;
        let recorded_clip_id = Uuid::new_v4();
        let editor_clip_id = Uuid::new_v4();
        let plan = HighlightEditPlan {
            demo_id: Uuid::new_v4(),
            intent: HighlightEditProposalIntent {
                pacing: HighlightEditPacing::Measured,
                include_context_seconds: 0.0,
                transition: HighlightEditTransition::Cut,
            },
            project_id: project.id,
            project_name: project.name.clone(),
            create_project: false,
            expected_revision: project.revision,
            target_track_id: track_id,
            create_track: false,
            mappings: vec![HighlightAssetMapping {
                highlight_id: "h-1".to_owned(),
                recorded_clip_id,
                path: "managed.mp4".to_owned(),
                duration_seconds: 3.0,
                file_size: 5,
                content_sha256: "00".repeat(32),
                capture_start_tick: 0,
                capture_end_tick: 192,
                tick_rate: 64.0,
                capture_playback_speed: 1.0,
            }],
            insertions: vec![HighlightEditClipInsert {
                highlight_id: "h-1".to_owned(),
                recorded_clip_id,
                editor_clip_id,
                timeline_start_seconds: 0.0,
                timeline_end_seconds: 3.0,
                source_start_tick: 0,
                source_end_tick: 192,
                source_in_seconds: 0.0,
                source_out_seconds: 3.0,
                playback_speed: 1.0,
                transition_in: None,
                transition_duration_seconds: None,
            }],
        };
        let original = project.clone();
        let mut tampered_speed = plan.clone();
        tampered_speed.insertions[0].playback_speed = 1.15;
        assert!(project.apply_highlight_edit_plan(&tampered_speed).is_err());
        assert_eq!(project, original);
        let mut tampered_transition = plan.clone();
        tampered_transition.insertions[0].transition_in = Some(HighlightEditTransition::Flash);
        tampered_transition.insertions[0].transition_duration_seconds = Some(0.12);
        assert!(
            project
                .apply_highlight_edit_plan(&tampered_transition)
                .is_err()
        );
        assert_eq!(project, original);
        assert_eq!(
            project.apply_highlight_edit_plan(&plan).unwrap(),
            vec![editor_clip_id]
        );
        let inserted = &project.tracks[0].clips[0];
        assert_eq!(inserted.asset_id, Some(recorded_clip_id));
        assert_eq!(inserted.id, editor_clip_id);
        assert!((project.duration_seconds - 3.0).abs() < 0.000_001);
    }
}
