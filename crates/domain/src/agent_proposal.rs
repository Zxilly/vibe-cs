use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    BeatAlignedClip, BeatAlignmentDraft, DomainError, EditorClip, EditorProject, EditorTrack,
    Highlight, ReplayFrame, TrackKind, Transform,
};

pub const AGENT_PROPOSAL_SCHEMA_VERSION: u32 = 1;

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HlaeProposalIntent {
    pub demo_id: Uuid,
    pub highlight_ids: Vec<String>,
    pub camera_style: HlaeCameraStyle,
    pub mode: HlaeProposalMode,
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
pub struct HlaeProposalPreview {
    pub schema_version: u32,
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
}

impl HlaeProposalPreview {
    #[must_use]
    pub fn prerequisites(items: Vec<ProposalPrerequisite>) -> Self {
        Self {
            schema_version: AGENT_PROPOSAL_SCHEMA_VERSION,
            proposal_revision: 1,
            ready: false,
            prerequisites: items,
            base_fingerprint: None,
            proposal_fingerprint: None,
            confirmation_token: None,
            typed_plan: None,
            compiled_preview: None,
            notices: Vec::new(),
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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
    pub draft: BeatAlignmentDraft,
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
    pub changes: Vec<BeatAlignedClip>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BeatAlignmentApplyRequest {
    pub project_id: Uuid,
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
    pub snapshot_created: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HighlightEditProposalRequest {
    pub demo_id: Uuid,
    pub highlight_ids: Vec<String>,
    /// When omitted, preview prepares a new editor project. Existing projects
    /// are always revision-bound and must provide `expected_revision`.
    #[serde(default)]
    pub target_project_id: Option<Uuid>,
    #[serde(default)]
    pub expected_revision: Option<u64>,
    #[serde(default)]
    pub new_project_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HighlightAssetMapping {
    pub highlight_id: String,
    pub recorded_clip_id: Uuid,
    pub path: String,
    pub duration_seconds: f64,
    pub file_size: u64,
    pub content_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HighlightEditClipInsert {
    pub highlight_id: String,
    pub recorded_clip_id: Uuid,
    pub editor_clip_id: Uuid,
    pub timeline_start_seconds: f64,
    pub timeline_end_seconds: f64,
    pub source_in_seconds: f64,
    pub source_out_seconds: f64,
    pub transition_in: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HighlightEditPlan {
    pub demo_id: Uuid,
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
        for (mapping, insertion) in plan.mappings.iter().zip(&plan.insertions) {
            if mapping.highlight_id != insertion.highlight_id
                || mapping.recorded_clip_id != insertion.recorded_clip_id
                || !highlight_ids.insert(&insertion.highlight_id)
                || !source_ids.insert(insertion.recorded_clip_id)
                || !editor_ids.insert(insertion.editor_clip_id)
                || !mapping.duration_seconds.is_finite()
                || mapping.duration_seconds <= 0.0
                || !insertion.timeline_start_seconds.is_finite()
                || !insertion.timeline_end_seconds.is_finite()
                || !insertion.source_in_seconds.is_finite()
                || !insertion.source_out_seconds.is_finite()
                || insertion.timeline_start_seconds < 0.0
                || insertion.timeline_end_seconds <= insertion.timeline_start_seconds
                || insertion.source_in_seconds < 0.0
                || insertion.source_out_seconds <= insertion.source_in_seconds
                || (insertion.source_out_seconds
                    - insertion.source_in_seconds
                    - mapping.duration_seconds)
                    .abs()
                    > 0.001
                || (insertion.timeline_end_seconds
                    - insertion.timeline_start_seconds
                    - mapping.duration_seconds)
                    .abs()
                    > 0.001
                || insertion
                    .transition_in
                    .as_deref()
                    .is_some_and(|transition| transition != "fade")
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
        for (mapping, insertion) in plan.mappings.iter().zip(&plan.insertions) {
            target.clips.push(EditorClip {
                id: insertion.editor_clip_id,
                asset_id: Some(insertion.recorded_clip_id),
                name: format!("精选 · {}", insertion.highlight_id),
                start: insertion.timeline_start_seconds,
                duration: mapping.duration_seconds,
                source_in: insertion.source_in_seconds,
                source_out: insertion.source_out_seconds,
                speed: 1.0,
                volume: 1.0,
                transform: Transform::default(),
                effects: Vec::new(),
                transition_in: insertion.transition_in.clone(),
                transition_out: None,
                text: None,
                metadata: serde_json::json!({
                    "origin": "highlight_edit_proposal",
                    "demo_id": plan.demo_id,
                    "highlight_id": insertion.highlight_id,
                    "recorded_clip_id": insertion.recorded_clip_id,
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
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;
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
            }],
            insertions: vec![HighlightEditClipInsert {
                highlight_id: "h-1".to_owned(),
                recorded_clip_id,
                editor_clip_id,
                timeline_start_seconds: 0.0,
                timeline_end_seconds: 3.0,
                source_in_seconds: 0.0,
                source_out_seconds: 3.0,
                transition_in: None,
            }],
        };
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
