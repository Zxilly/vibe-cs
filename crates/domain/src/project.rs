use std::collections::HashSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::{
    DomainError, EditorEffect, EditorKeyframe, EditorMarker, EditorSpeedSegment, HlaeCameraStyle,
    MAX_EDITOR_CLIP_SPEED, MAX_EDITOR_KEYFRAMES_PER_CLIP, MAX_EDITOR_PROJECT_DURATION_SECONDS,
    MAX_EDITOR_SPEED_SEGMENTS, MIN_EDITOR_CLIP_SPEED, RecordingPresentation, RecordingRequest,
    TextStyle, TrackKind, Transform,
};

const MAX_PROJECT_PATCH_OPERATIONS: usize = 1_024;
pub const MAX_PROJECT_SOURCE_DEMOS: usize = 12;

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

/// The one persisted editing authority for a video project.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct Project {
    pub id: Uuid,
    pub name: String,
    pub revision: u64,
    pub document: EditingDocument,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A multitrack document shared by every editing lens and the Agent panel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct EditingDocument {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub duration_seconds: f64,
    pub story_track_id: Uuid,
    pub tracks: Vec<TimelineTrack>,
    pub markers: Vec<EditorMarker>,
    pub settings: EditingDocumentSettings,
}

/// Project-wide editing inputs that are not Timeline placements.
///
/// Source Demos are explicit because an empty Story Track must still give the
/// Agent enough evidence to plan the first set of capture-ready clips.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct EditingDocumentSettings {
    pub source_demo_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct TimelineTrack {
    pub id: Uuid,
    pub name: String,
    pub kind: TrackKind,
    pub order: u32,
    pub muted: bool,
    pub locked: bool,
    pub hidden: bool,
    pub clips: Vec<TimelineClip>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EditorTransitionKind {
    Fade,
    Dip,
    Flash,
    Zoom,
    Wipe,
    Slide,
    Blur,
    Glitch,
    Spin,
    ConstantPower,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct EditorTransition {
    pub kind: EditorTransitionKind,
    pub duration_seconds: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct TimelineClipTransitions {
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub video_in: Option<EditorTransition>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub video_out: Option<EditorTransition>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub audio_in: Option<EditorTransition>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub audio_out: Option<EditorTransition>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct TimelineClip {
    pub id: Uuid,
    pub name: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub capture_intent: Option<CaptureIntent>,
    pub material: TimelineClipMaterial,
    pub placement: TimelinePlacement,
    pub transform: Transform,
    pub effects: Vec<EditorEffect>,
    pub transitions: TimelineClipTransitions,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub text: Option<TextStyle>,
    pub metadata: serde_json::Value,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub group_id: Option<Uuid>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub link_group_id: Option<Uuid>,
    pub keyframes: Vec<EditorKeyframe>,
    pub speed_segments: Vec<EditorSpeedSegment>,
}

/// Footage-producing fields. Timeline placement is deliberately absent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct CaptureIntent {
    pub demo_id: Uuid,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub highlight_id: Option<String>,
    pub player_id: String,
    pub start_tick: u64,
    pub end_tick: u64,
    pub pre_roll_seconds: f64,
    pub post_roll_seconds: f64,
    pub victim_pov: bool,
    pub camera_style: HlaeCameraStyle,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub presentation: Option<RecordingPresentation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct TimelinePlacement {
    pub start: f64,
    pub duration: f64,
    pub source_in: f64,
    pub source_out: f64,
    pub speed: f64,
    pub volume: f64,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum TimelineClipMaterial {
    Planned,
    Take {
        take_id: Uuid,
        asset_id: Uuid,
        capture_fingerprint: String,
        media_duration_seconds: f64,
    },
    Asset {
        asset_id: Uuid,
        media_duration_seconds: f64,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TimelineClipMaterializationState {
    Unbound,
    Unrecorded,
    Recorded,
    Stale,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct ProjectPatch {
    pub project_id: Uuid,
    pub base_revision: u64,
    pub scope: ProjectPatchScope,
    pub author: ProjectChangeAuthor,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub reverts_change_group_id: Option<Uuid>,
    pub summary: String,
    pub operations: Vec<ProjectEditOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum ProjectPatchScope {
    Project,
    Track { track_id: Uuid },
    TimeRange { start: f64, end: f64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum ProjectChangeAuthor {
    Human,
    Agent { session_id: Uuid, turn_id: Uuid },
    System { operation_id: Uuid },
}

/// Closed editing vocabulary shared by human controls and high-level Agent operations.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "op", rename_all = "snake_case")]
#[ts(export)]
pub enum ProjectEditOperation {
    RenameProject {
        name: String,
    },
    ReplaceSettings {
        settings: EditingDocumentSettings,
    },
    ReplaceMarkers {
        markers: Vec<EditorMarker>,
    },
    InsertTrack {
        index: usize,
        track: Box<TimelineTrack>,
    },
    RemoveTrack {
        track_id: Uuid,
    },
    ReplaceTrack {
        track_id: Uuid,
        track: Box<TimelineTrack>,
    },
    ReorderTracks {
        track_ids: Vec<Uuid>,
    },
    InsertClip {
        track_id: Uuid,
        index: usize,
        clip: Box<TimelineClip>,
    },
    RemoveClip {
        clip_id: Uuid,
    },
    ReplaceClip {
        clip_id: Uuid,
        clip: Box<TimelineClip>,
    },
    MoveClip {
        clip_id: Uuid,
        to_track_id: Uuid,
        index: usize,
    },
    ReplaceTrackClips {
        track_id: Uuid,
        clips: Vec<TimelineClip>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ProjectChangeGroupStatus {
    Completed,
    Interrupted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct ProjectChangeGroup {
    pub id: Uuid,
    pub project_id: Uuid,
    pub from_revision: u64,
    pub to_revision: u64,
    pub author: ProjectChangeAuthor,
    pub status: ProjectChangeGroupStatus,
    pub summary: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub reverts_change_group_id: Option<Uuid>,
    pub operations: Vec<ProjectEditOperation>,
    pub inverse_operations: Vec<ProjectEditOperation>,
    pub created_at: DateTime<Utc>,
    pub completed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct ProjectEditLease {
    pub id: Uuid,
    pub project_id: Uuid,
    pub session_id: Uuid,
    pub turn_id: Uuid,
    pub base_revision: u64,
    pub acquired_at: DateTime<Utc>,
    pub heartbeat_at: DateTime<Utc>,
}

impl CaptureIntent {
    fn recording_request(&self, id: Uuid, title: &str) -> RecordingRequest {
        RecordingRequest {
            id: Some(id),
            demo_id: self.demo_id,
            highlight_id: self.highlight_id.clone(),
            player_id: self.player_id.clone(),
            title: title.to_owned(),
            start_tick: self.start_tick,
            end_tick: self.end_tick,
            pre_roll_seconds: self.pre_roll_seconds,
            post_roll_seconds: self.post_roll_seconds,
            victim_pov: self.victim_pov,
            camera_style: self.camera_style,
            presentation: self.presentation,
        }
    }

    /// Validates recording-facing fields.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when the capture intent cannot be recorded.
    pub fn validate(&self) -> Result<(), DomainError> {
        self.recording_request(Uuid::nil(), "capture intent")
            .validate()
    }

    /// Returns the stable footage-producing fingerprint.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::Internal`] only when the closed capture document cannot be serialized.
    pub fn fingerprint(&self) -> Result<String, DomainError> {
        self.recording_request(Uuid::nil(), "capture intent")
            .spec_fingerprint()
    }

    #[must_use]
    pub fn into_recording_request(self, id: Uuid, title: &str) -> RecordingRequest {
        self.recording_request(id, title)
    }
}

impl TimelineClip {
    /// Computes materialization from capture identity and real media coverage.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::Internal`] only when a capture fingerprint cannot be produced.
    pub fn materialization_state(&self) -> Result<TimelineClipMaterializationState, DomainError> {
        match &self.material {
            TimelineClipMaterial::Planned => Ok(if self.capture_intent.is_some() {
                TimelineClipMaterializationState::Unrecorded
            } else {
                TimelineClipMaterializationState::Unbound
            }),
            TimelineClipMaterial::Take {
                capture_fingerprint,
                media_duration_seconds,
                ..
            } => {
                let Some(intent) = &self.capture_intent else {
                    return Ok(TimelineClipMaterializationState::Stale);
                };
                Ok(
                    if intent.fingerprint()? == *capture_fingerprint
                        && placement_fits_media(&self.placement, *media_duration_seconds)
                    {
                        TimelineClipMaterializationState::Recorded
                    } else {
                        TimelineClipMaterializationState::Stale
                    },
                )
            }
            TimelineClipMaterial::Asset {
                media_duration_seconds,
                ..
            } => Ok(
                if placement_fits_media(&self.placement, *media_duration_seconds) {
                    TimelineClipMaterializationState::Recorded
                } else {
                    TimelineClipMaterializationState::Stale
                },
            ),
        }
    }

    /// Attaches one verified recording while preserving the edited Timeline duration.
    ///
    /// A managed capture may start a few ticks after its scheduled boundary. When the
    /// resulting file is slightly shorter than the planned source range, the Take is
    /// fitted by narrowing `source_out` and applying the matching constant speed. This
    /// keeps Story timing stable without claiming media coverage the file does not have.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when the clip has no Capture Intent, the
    /// media cannot cover its source-in point, or fitting would require segmented or
    /// unsupported speed.
    pub fn with_recorded_take(
        &self,
        take_id: Uuid,
        asset_id: Uuid,
        media_duration_seconds: f64,
    ) -> Result<Self, DomainError> {
        validate_media_duration(media_duration_seconds)?;
        let intent = self
            .capture_intent
            .as_ref()
            .ok_or_else(|| invalid("recorded Take requires a Capture Intent"))?;
        let mut recorded = self.clone();
        if recorded.placement.source_out > media_duration_seconds {
            if !recorded.speed_segments.is_empty() {
                return Err(invalid(
                    "a short recorded Take cannot fit a segmented-speed clip",
                ));
            }
            let source_span = media_duration_seconds - recorded.placement.source_in;
            if source_span <= 0.0 || recorded.placement.duration <= 0.0 {
                return Err(invalid(
                    "recorded Take does not cover the clip source range",
                ));
            }
            let fitted_speed = source_span / recorded.placement.duration;
            if !(MIN_EDITOR_CLIP_SPEED..=MAX_EDITOR_CLIP_SPEED).contains(&fitted_speed) {
                return Err(invalid(
                    "recorded Take requires an unsupported fitted speed",
                ));
            }
            recorded.placement.source_out = media_duration_seconds;
            recorded.placement.speed = fitted_speed;
        }
        recorded.material = TimelineClipMaterial::Take {
            take_id,
            asset_id,
            capture_fingerprint: intent.fingerprint()?,
            media_duration_seconds,
        };
        validate_clip(&recorded)?;
        Ok(recorded)
    }
}

impl Project {
    /// Checks the complete current project document.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when the project or timeline is inconsistent.
    pub fn validate(&self) -> Result<(), DomainError> {
        if self.name.trim().is_empty() {
            return Err(invalid("project name cannot be empty"));
        }
        if self.revision == 0 {
            return Err(invalid("project revision must be positive"));
        }
        self.document.validate()
    }

    /// Returns whether any canonical Timeline Clip resolves through the asset.
    #[must_use]
    pub fn references_media_asset(&self, asset_id: Uuid) -> bool {
        self.document.tracks.iter().any(|track| {
            track.clips.iter().any(|clip| match &clip.material {
                TimelineClipMaterial::Take {
                    asset_id: current, ..
                }
                | TimelineClipMaterial::Asset {
                    asset_id: current, ..
                } => *current == asset_id,
                TimelineClipMaterial::Planned => false,
            })
        })
    }

    /// Applies one revision-bound patch and returns its undoable Change Group.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::Conflict`] for a stale revision and
    /// [`DomainError::InvalidInput`] for an invalid operation or resulting document.
    pub fn apply_patch(
        &mut self,
        patch: ProjectPatch,
        change_group_id: Uuid,
        now: DateTime<Utc>,
    ) -> Result<ProjectChangeGroup, DomainError> {
        if patch.project_id != self.id {
            return Err(invalid("project patch targets another project"));
        }
        if patch.base_revision != self.revision {
            return Err(DomainError::Conflict(format!(
                "project is at revision {}, patch was based on {}",
                self.revision, patch.base_revision
            )));
        }
        let summary = patch.summary.trim();
        if summary.is_empty() || summary.chars().count() > 400 {
            return Err(invalid(
                "project patch summary must contain 1 to 400 characters",
            ));
        }
        if patch.operations.is_empty() || patch.operations.len() > MAX_PROJECT_PATCH_OPERATIONS {
            return Err(invalid("project patch must contain 1 to 1024 operations"));
        }
        validate_patch_scope(&patch.scope)?;

        let from_revision = self.revision;
        let mut staged = self.clone();
        let mut inverse_operations = Vec::with_capacity(patch.operations.len());
        for operation in &patch.operations {
            inverse_operations.push(staged.apply_operation(operation.clone())?);
        }
        staged.normalize_track_order();
        staged.normalize_document_duration();
        staged.revision = staged
            .revision
            .checked_add(1)
            .ok_or_else(|| invalid("project revision overflow"))?;
        staged.updated_at = now;
        staged.validate()?;
        inverse_operations.reverse();

        let to_revision = staged.revision;
        *self = staged;
        Ok(ProjectChangeGroup {
            id: change_group_id,
            project_id: self.id,
            from_revision,
            to_revision,
            author: patch.author,
            status: ProjectChangeGroupStatus::Completed,
            summary: summary.to_owned(),
            reverts_change_group_id: patch.reverts_change_group_id,
            operations: patch.operations,
            inverse_operations,
            created_at: now,
            completed_at: now,
        })
    }

    /// Returns enabled clips that block final delivery.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::Internal`] only when a capture fingerprint cannot be produced.
    pub fn unresolved_delivery_clips(&self) -> Result<Vec<Uuid>, DomainError> {
        Ok(self
            .delivery_blockers()?
            .into_iter()
            .map(|(clip_id, _state)| clip_id)
            .collect())
    }

    /// Returns enabled media clips and their materialization state when they block delivery.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::Internal`] when a clip's capture fingerprint cannot be produced.
    pub fn delivery_blockers(
        &self,
    ) -> Result<Vec<(Uuid, TimelineClipMaterializationState)>, DomainError> {
        let mut blockers = Vec::new();
        for clip in self.document.tracks.iter().flat_map(|track| &track.clips) {
            if !clip.placement.enabled || clip.text.is_some() {
                continue;
            }
            let state = clip.materialization_state()?;
            if state != TimelineClipMaterializationState::Recorded {
                blockers.push((clip.id, state));
            }
        }
        Ok(blockers)
    }

    fn apply_operation(
        &mut self,
        operation: ProjectEditOperation,
    ) -> Result<ProjectEditOperation, DomainError> {
        match operation {
            ProjectEditOperation::RenameProject { name } => {
                let previous = std::mem::replace(&mut self.name, name);
                Ok(ProjectEditOperation::RenameProject { name: previous })
            }
            ProjectEditOperation::ReplaceSettings { settings } => {
                let previous = std::mem::replace(&mut self.document.settings, settings);
                Ok(ProjectEditOperation::ReplaceSettings { settings: previous })
            }
            ProjectEditOperation::ReplaceMarkers { markers } => {
                let previous = std::mem::replace(&mut self.document.markers, markers);
                Ok(ProjectEditOperation::ReplaceMarkers { markers: previous })
            }
            ProjectEditOperation::InsertTrack { index, track } => {
                if index > self.document.tracks.len() {
                    return Err(invalid("track insertion index is out of range"));
                }
                let track_id = track.id;
                self.document.tracks.insert(index, *track);
                Ok(ProjectEditOperation::RemoveTrack { track_id })
            }
            ProjectEditOperation::RemoveTrack { track_id } => {
                let index = self
                    .document
                    .tracks
                    .iter()
                    .position(|track| track.id == track_id)
                    .ok_or_else(|| invalid("track does not exist"))?;
                let track = self.document.tracks.remove(index);
                Ok(ProjectEditOperation::InsertTrack {
                    index,
                    track: Box::new(track),
                })
            }
            ProjectEditOperation::ReplaceTrack { track_id, track } => {
                if track.id != track_id {
                    return Err(invalid("replacement track identity changed"));
                }
                let current = self
                    .document
                    .tracks
                    .iter_mut()
                    .find(|candidate| candidate.id == track_id)
                    .ok_or_else(|| invalid("track does not exist"))?;
                let previous = std::mem::replace(current, *track);
                Ok(ProjectEditOperation::ReplaceTrack {
                    track_id,
                    track: Box::new(previous),
                })
            }
            ProjectEditOperation::ReorderTracks { track_ids } => {
                let previous = self.document.tracks.iter().map(|track| track.id).collect();
                reorder_tracks(&mut self.document.tracks, &track_ids)?;
                Ok(ProjectEditOperation::ReorderTracks {
                    track_ids: previous,
                })
            }
            ProjectEditOperation::InsertClip {
                track_id,
                index,
                clip,
            } => {
                let track = find_track_mut(&mut self.document, track_id)?;
                if index > track.clips.len() {
                    return Err(invalid("clip insertion index is out of range"));
                }
                let clip_id = clip.id;
                track.clips.insert(index, *clip);
                Ok(ProjectEditOperation::RemoveClip { clip_id })
            }
            ProjectEditOperation::RemoveClip { clip_id } => {
                let (track_id, index) = find_clip_location(&self.document, clip_id)?;
                let track = find_track_mut(&mut self.document, track_id)?;
                let clip = track.clips.remove(index);
                Ok(ProjectEditOperation::InsertClip {
                    track_id,
                    index,
                    clip: Box::new(clip),
                })
            }
            ProjectEditOperation::ReplaceClip { clip_id, clip } => {
                if clip.id != clip_id {
                    return Err(invalid("replacement clip identity changed"));
                }
                let (track_id, index) = find_clip_location(&self.document, clip_id)?;
                let track = find_track_mut(&mut self.document, track_id)?;
                let previous = std::mem::replace(&mut track.clips[index], *clip);
                Ok(ProjectEditOperation::ReplaceClip {
                    clip_id,
                    clip: Box::new(previous),
                })
            }
            ProjectEditOperation::MoveClip {
                clip_id,
                to_track_id,
                index,
            } => {
                let (from_track_id, from_index) = find_clip_location(&self.document, clip_id)?;
                let clip = find_track_mut(&mut self.document, from_track_id)?
                    .clips
                    .remove(from_index);
                let target = find_track_mut(&mut self.document, to_track_id)?;
                if index > target.clips.len() {
                    return Err(invalid("clip move index is out of range"));
                }
                target.clips.insert(index, clip);
                Ok(ProjectEditOperation::MoveClip {
                    clip_id,
                    to_track_id: from_track_id,
                    index: from_index,
                })
            }
            ProjectEditOperation::ReplaceTrackClips { track_id, clips } => {
                let track = find_track_mut(&mut self.document, track_id)?;
                let previous = std::mem::replace(&mut track.clips, clips);
                Ok(ProjectEditOperation::ReplaceTrackClips {
                    track_id,
                    clips: previous,
                })
            }
        }
    }

    fn normalize_track_order(&mut self) {
        for (index, track) in self.document.tracks.iter_mut().enumerate() {
            track.order = u32::try_from(index).unwrap_or(u32::MAX);
        }
    }

    fn normalize_document_duration(&mut self) {
        self.document.duration_seconds = derived_document_duration(&self.document);
    }
}

impl EditingDocument {
    /// Checks renderer and identity invariants for the canonical document.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when the timeline cannot be edited or rendered.
    pub fn validate(&self) -> Result<(), DomainError> {
        if self.width == 0 || self.height == 0 || self.width > 16_384 || self.height > 16_384 {
            return Err(invalid("canvas dimensions must be between 1 and 16384"));
        }
        if !(1..=240).contains(&self.fps) {
            return Err(invalid("frame rate must be between 1 and 240"));
        }
        if !self.duration_seconds.is_finite()
            || !(0.0..=MAX_EDITOR_PROJECT_DURATION_SECONDS).contains(&self.duration_seconds)
        {
            return Err(invalid("project duration is outside the supported range"));
        }
        if (self.duration_seconds - derived_document_duration(self)).abs() > 0.001 {
            return Err(invalid(
                "project duration does not match the enabled timeline clips",
            ));
        }
        let story = self
            .tracks
            .iter()
            .find(|track| track.id == self.story_track_id)
            .ok_or_else(|| invalid("story track does not exist"))?;
        if story.kind != TrackKind::Video {
            return Err(invalid("story track must be a video track"));
        }
        if self.settings.source_demo_ids.len() > MAX_PROJECT_SOURCE_DEMOS {
            return Err(invalid(
                "project cannot reference more than 12 source demos",
            ));
        }
        if self
            .settings
            .source_demo_ids
            .iter()
            .copied()
            .collect::<HashSet<_>>()
            .len()
            != self.settings.source_demo_ids.len()
        {
            return Err(invalid("project source demo identities must be unique"));
        }

        let mut track_ids = HashSet::new();
        let mut clip_ids = HashSet::new();
        for track in &self.tracks {
            if !track_ids.insert(track.id) {
                return Err(invalid("track identities must be unique"));
            }
            if track.name.trim().is_empty() {
                return Err(invalid("track name cannot be empty"));
            }
            for clip in &track.clips {
                if !clip_ids.insert(clip.id) {
                    return Err(invalid("clip identities must be unique"));
                }
                validate_clip(clip)?;
            }
        }
        Ok(())
    }
}

fn validate_clip(clip: &TimelineClip) -> Result<(), DomainError> {
    if clip.name.trim().is_empty() {
        return Err(invalid("clip name cannot be empty"));
    }
    let placement = &clip.placement;
    if ![
        placement.start,
        placement.duration,
        placement.source_in,
        placement.source_out,
        placement.speed,
        placement.volume,
    ]
    .into_iter()
    .all(f64::is_finite)
        || placement.start < 0.0
        || placement.duration < 0.0
        || placement.source_in < 0.0
        || placement.source_out < placement.source_in
        || !(MIN_EDITOR_CLIP_SPEED..=MAX_EDITOR_CLIP_SPEED).contains(&placement.speed)
        || placement.volume < 0.0
        || placement.volume > 4.0
    {
        return Err(invalid("clip placement is invalid"));
    }
    if clip.keyframes.len() > MAX_EDITOR_KEYFRAMES_PER_CLIP {
        return Err(invalid("clip has too many keyframes"));
    }
    let video_transitions = [
        clip.transitions.video_in.as_ref(),
        clip.transitions.video_out.as_ref(),
    ];
    let audio_transitions = [
        clip.transitions.audio_in.as_ref(),
        clip.transitions.audio_out.as_ref(),
    ];
    for transition in video_transitions.into_iter().flatten() {
        if !transition.duration_seconds.is_finite()
            || !(0.05..=5.0).contains(&transition.duration_seconds)
            || transition.duration_seconds >= placement.duration
            || transition.kind == EditorTransitionKind::ConstantPower
        {
            return Err(invalid("video transition is invalid"));
        }
    }
    for transition in audio_transitions.into_iter().flatten() {
        if !transition.duration_seconds.is_finite()
            || !(0.05..=5.0).contains(&transition.duration_seconds)
            || transition.duration_seconds >= placement.duration
            || !matches!(
                transition.kind,
                EditorTransitionKind::Fade | EditorTransitionKind::ConstantPower
            )
        {
            return Err(invalid("audio transition is invalid"));
        }
    }
    if clip
        .transitions
        .video_in
        .as_ref()
        .zip(clip.transitions.video_out.as_ref())
        .is_some_and(|(left, right)| {
            left.duration_seconds + right.duration_seconds >= placement.duration
        })
        || clip
            .transitions
            .audio_in
            .as_ref()
            .zip(clip.transitions.audio_out.as_ref())
            .is_some_and(|(left, right)| {
                left.duration_seconds + right.duration_seconds >= placement.duration
            })
    {
        return Err(invalid("clip transitions overlap across the whole clip"));
    }
    if clip.speed_segments.len() > MAX_EDITOR_SPEED_SEGMENTS {
        return Err(invalid("clip has too many speed segments"));
    }
    if clip.speed_segments.is_empty() {
        if ((placement.source_out - placement.source_in) - placement.duration * placement.speed)
            .abs()
            > 0.001
        {
            return Err(invalid(
                "constant-speed clip duration must match its source range",
            ));
        }
    } else {
        let mut segment_ids = HashSet::new();
        let mut expected_start = 0.0;
        let mut source_duration = 0.0;
        for segment in &clip.speed_segments {
            if !segment_ids.insert(segment.id)
                || ![segment.start, segment.end, segment.speed]
                    .into_iter()
                    .all(f64::is_finite)
                || (segment.start - expected_start).abs() > 0.001
                || segment.end <= segment.start
                || !(MIN_EDITOR_CLIP_SPEED..=MAX_EDITOR_CLIP_SPEED).contains(&segment.speed)
            {
                return Err(invalid("clip speed segments are invalid"));
            }
            source_duration += (segment.end - segment.start) * segment.speed;
            expected_start = segment.end;
        }
        if (expected_start - placement.duration).abs() > 0.001
            || (source_duration - (placement.source_out - placement.source_in)).abs() > 0.001
        {
            return Err(invalid(
                "clip speed segments must cover the Timeline and source range",
            ));
        }
    }
    if let Some(intent) = &clip.capture_intent {
        intent.validate()?;
    }
    match &clip.material {
        TimelineClipMaterial::Take {
            capture_fingerprint,
            media_duration_seconds,
            ..
        } => {
            if !valid_fingerprint(capture_fingerprint) {
                return Err(invalid("take fingerprint must be lowercase SHA-256"));
            }
            validate_media_duration(*media_duration_seconds)?;
        }
        TimelineClipMaterial::Asset {
            media_duration_seconds,
            ..
        } => validate_media_duration(*media_duration_seconds)?,
        TimelineClipMaterial::Planned => {}
    }
    Ok(())
}

fn validate_media_duration(duration: f64) -> Result<(), DomainError> {
    if !duration.is_finite() || !(0.0..=MAX_EDITOR_PROJECT_DURATION_SECONDS).contains(&duration) {
        return Err(invalid("media duration is outside the supported range"));
    }
    Ok(())
}

fn placement_fits_media(placement: &TimelinePlacement, media_duration: f64) -> bool {
    placement.source_in >= 0.0
        && placement.source_out >= placement.source_in
        && placement.source_out <= media_duration
}

fn valid_fingerprint(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_patch_scope(scope: &ProjectPatchScope) -> Result<(), DomainError> {
    if let ProjectPatchScope::TimeRange { start, end } = scope
        && (!start.is_finite() || !end.is_finite() || *start < 0.0 || *end <= *start)
    {
        return Err(invalid("project patch time range is invalid"));
    }
    Ok(())
}

fn find_track_mut(
    document: &mut EditingDocument,
    track_id: Uuid,
) -> Result<&mut TimelineTrack, DomainError> {
    document
        .tracks
        .iter_mut()
        .find(|track| track.id == track_id)
        .ok_or_else(|| invalid("track does not exist"))
}

fn find_clip_location(
    document: &EditingDocument,
    clip_id: Uuid,
) -> Result<(Uuid, usize), DomainError> {
    document
        .tracks
        .iter()
        .find_map(|track| {
            track
                .clips
                .iter()
                .position(|clip| clip.id == clip_id)
                .map(|index| (track.id, index))
        })
        .ok_or_else(|| invalid("clip does not exist"))
}

fn reorder_tracks(tracks: &mut Vec<TimelineTrack>, track_ids: &[Uuid]) -> Result<(), DomainError> {
    if track_ids.len() != tracks.len()
        || track_ids.iter().copied().collect::<HashSet<_>>().len() != tracks.len()
    {
        return Err(invalid("track reorder must name every track exactly once"));
    }
    let mut reordered = Vec::with_capacity(tracks.len());
    for id in track_ids {
        let index = tracks
            .iter()
            .position(|track| track.id == *id)
            .ok_or_else(|| invalid("track reorder names an unknown track"))?;
        reordered.push(tracks.remove(index));
    }
    *tracks = reordered;
    Ok(())
}

fn invalid(message: &str) -> DomainError {
    DomainError::InvalidInput(message.to_owned())
}

fn derived_document_duration(document: &EditingDocument) -> f64 {
    document
        .tracks
        .iter()
        .flat_map(|track| &track.clips)
        .filter(|clip| clip.placement.enabled)
        .map(|clip| clip.placement.start + clip.placement.duration)
        .fold(0.0, f64::max)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RecordingVoicePolicy;

    fn capture() -> CaptureIntent {
        CaptureIntent {
            demo_id: Uuid::from_u128(1),
            highlight_id: Some("highlight-1".to_owned()),
            player_id: "76561198041683378".to_owned(),
            start_tick: 100,
            end_tick: 200,
            pre_roll_seconds: 1.0,
            post_roll_seconds: 1.0,
            victim_pov: false,
            camera_style: HlaeCameraStyle::Pov,
            presentation: Some(RecordingPresentation {
                camera_fov: 90.0,
                viewmodel_fov: 68.0,
                flash_alpha: u8::MAX,
                show_hud: true,
                show_radar: true,
                voice: RecordingVoicePolicy::AllPlayers,
            }),
        }
    }

    fn clip(id: u128) -> TimelineClip {
        TimelineClip {
            id: Uuid::from_u128(id),
            name: format!("clip-{id}"),
            capture_intent: Some(capture()),
            material: TimelineClipMaterial::Planned,
            placement: TimelinePlacement {
                start: 0.0,
                duration: 5.0,
                source_in: 0.0,
                source_out: 5.0,
                speed: 1.0,
                volume: 1.0,
                enabled: true,
            },
            transform: Transform::default(),
            effects: Vec::new(),
            transitions: TimelineClipTransitions::default(),
            text: None,
            metadata: serde_json::json!({}),
            group_id: None,
            link_group_id: None,
            keyframes: Vec::new(),
            speed_segments: Vec::new(),
        }
    }

    fn project() -> Project {
        let track_id = Uuid::from_u128(10);
        Project {
            id: Uuid::from_u128(20),
            name: "NiKo reel".to_owned(),
            revision: 1,
            document: EditingDocument {
                width: 1920,
                height: 1080,
                fps: 60,
                duration_seconds: 5.0,
                story_track_id: track_id,
                tracks: vec![TimelineTrack {
                    id: track_id,
                    name: "Story".to_owned(),
                    kind: TrackKind::Video,
                    order: 0,
                    muted: false,
                    locked: false,
                    hidden: false,
                    clips: vec![clip(100), clip(101)],
                }],
                markers: Vec::new(),
                settings: EditingDocumentSettings::default(),
            },
            created_at: DateTime::UNIX_EPOCH,
            updated_at: DateTime::UNIX_EPOCH,
        }
    }

    fn patch(project: &Project, operations: Vec<ProjectEditOperation>) -> ProjectPatch {
        ProjectPatch {
            project_id: project.id,
            base_revision: project.revision,
            scope: ProjectPatchScope::Project,
            author: ProjectChangeAuthor::Agent {
                session_id: Uuid::from_u128(30),
                turn_id: Uuid::from_u128(31),
            },
            summary: "Replan story".to_owned(),
            reverts_change_group_id: None,
            operations,
        }
    }

    #[test]
    fn placement_edits_keep_a_take_compatible_but_capture_edits_make_it_stale() {
        let mut timeline_clip = clip(100);
        let fingerprint = timeline_clip
            .capture_intent
            .as_ref()
            .expect("capture")
            .fingerprint()
            .expect("fingerprint");
        timeline_clip.material = TimelineClipMaterial::Take {
            take_id: Uuid::from_u128(40),
            asset_id: Uuid::from_u128(41),
            capture_fingerprint: fingerprint,
            media_duration_seconds: 8.0,
        };
        timeline_clip.placement.start = 30.0;
        timeline_clip.placement.source_in = 1.0;
        timeline_clip.placement.source_out = 4.0;
        assert_eq!(
            timeline_clip.materialization_state().expect("state"),
            TimelineClipMaterializationState::Recorded
        );

        timeline_clip
            .capture_intent
            .as_mut()
            .expect("capture")
            .start_tick += 1;
        assert_eq!(
            timeline_clip.materialization_state().expect("state"),
            TimelineClipMaterializationState::Stale
        );
    }

    #[test]
    fn short_recorded_take_fits_source_truth_without_changing_timeline_duration() {
        let current = clip(100);
        let recorded = current
            .with_recorded_take(Uuid::from_u128(40), Uuid::from_u128(41), 4.98)
            .expect("fit Take");

        assert!((recorded.placement.duration - 5.0).abs() < f64::EPSILON);
        assert!((recorded.placement.source_out - 4.98).abs() < f64::EPSILON);
        assert!((recorded.placement.speed - 0.996).abs() < 1e-12);
        assert_eq!(
            recorded.materialization_state().expect("state"),
            TimelineClipMaterializationState::Recorded
        );
    }

    #[test]
    fn short_recorded_take_rejects_uncoverable_or_segmented_source_ranges() {
        let mut current = clip(100);
        current.placement.source_in = 2.0;
        current.placement.source_out = 7.0;
        assert!(
            current
                .with_recorded_take(Uuid::from_u128(40), Uuid::from_u128(41), 2.0)
                .is_err()
        );

        current.speed_segments.push(EditorSpeedSegment {
            id: Uuid::from_u128(42),
            start: 0.0,
            end: 5.0,
            speed: 1.0,
        });
        assert!(
            current
                .with_recorded_take(Uuid::from_u128(40), Uuid::from_u128(41), 6.0)
                .is_err()
        );
    }

    #[test]
    fn constant_speed_placement_requires_renderer_and_timeline_to_share_one_duration() {
        let mut current = project();
        current.document.tracks[0].clips[0].placement.speed = MIN_EDITOR_CLIP_SPEED / 2.0;
        assert!(current.validate().is_err());

        current.document.tracks[0].clips[0].placement.speed = MAX_EDITOR_CLIP_SPEED + 1.0;
        assert!(current.validate().is_err());

        current.document.tracks[0].clips[0].placement.speed = 2.0;
        assert!(current.validate().is_err());

        current.document.tracks[0].clips[0].placement.duration = 2.5;
        assert!(current.validate().is_ok());
    }

    #[test]
    fn transition_channels_have_independent_typed_duration_invariants() {
        let mut value = project();
        {
            let clip = &mut value.document.tracks[0].clips[0];
            clip.transitions.video_in = Some(EditorTransition {
                kind: EditorTransitionKind::Fade,
                duration_seconds: 1.0,
            });
            clip.transitions.audio_in = Some(EditorTransition {
                kind: EditorTransitionKind::ConstantPower,
                duration_seconds: 0.5,
            });
        }
        assert!(value.validate().is_ok());

        value.document.tracks[0].clips[0].transitions.video_in = Some(EditorTransition {
            kind: EditorTransitionKind::ConstantPower,
            duration_seconds: 1.0,
        });
        assert!(value.validate().is_err());

        value.document.tracks[0].clips[0].transitions.video_in = None;
        value.document.tracks[0].clips[0].transitions.audio_out = Some(EditorTransition {
            kind: EditorTransitionKind::Fade,
            duration_seconds: 4.5,
        });
        assert!(value.validate().is_err());
    }

    #[test]
    fn speed_segments_must_cover_one_contiguous_timeline_and_source_range() {
        let mut current = project();
        let clip = &mut current.document.tracks[0].clips[0];
        clip.speed_segments = vec![
            EditorSpeedSegment {
                id: Uuid::from_u128(41),
                start: 0.0,
                end: 2.0,
                speed: 0.5,
            },
            EditorSpeedSegment {
                id: Uuid::from_u128(42),
                start: 2.0,
                end: 4.0,
                speed: 1.5,
            },
            EditorSpeedSegment {
                id: Uuid::from_u128(43),
                start: 4.0,
                end: 5.0,
                speed: 1.0,
            },
        ];
        assert!(current.validate().is_ok());

        let mut gap = current.clone();
        gap.document.tracks[0].clips[0].speed_segments[1].start = 2.5;
        assert!(gap.validate().is_err());

        let mut duplicate = current.clone();
        duplicate.document.tracks[0].clips[0].speed_segments[1].id = Uuid::from_u128(41);
        assert!(duplicate.validate().is_err());

        let mut wrong_source = current;
        wrong_source.document.tracks[0].clips[0].speed_segments[1].speed = 1.0;
        assert!(wrong_source.validate().is_err());
    }

    #[test]
    fn whole_story_replan_commits_once_and_its_inverse_restores_the_head() {
        let mut current = project();
        let original = current.clone();
        let track_id = current.document.story_track_id;
        let mut replacement = clip(102);
        replacement.placement.start = 12.0;
        let group = current
            .apply_patch(
                patch(
                    &current,
                    vec![ProjectEditOperation::ReplaceTrackClips {
                        track_id,
                        clips: vec![replacement],
                    }],
                ),
                Uuid::from_u128(50),
                DateTime::UNIX_EPOCH + chrono::Duration::seconds(1),
            )
            .expect("replan");
        assert_eq!(current.revision, 2);
        assert_eq!(current.document.tracks[0].clips.len(), 1);
        assert!((current.document.duration_seconds - 17.0).abs() < f64::EPSILON);
        assert_eq!(group.from_revision, 1);
        assert_eq!(group.to_revision, 2);

        current
            .apply_patch(
                ProjectPatch {
                    project_id: current.id,
                    base_revision: current.revision,
                    scope: ProjectPatchScope::Project,
                    author: ProjectChangeAuthor::Human,
                    reverts_change_group_id: Some(group.id),
                    summary: "Undo Agent replan".to_owned(),
                    operations: group.inverse_operations,
                },
                Uuid::from_u128(51),
                DateTime::UNIX_EPOCH + chrono::Duration::seconds(2),
            )
            .expect("undo");
        assert_eq!(current.document, original.document);
        assert_eq!(current.revision, 3);
    }

    #[test]
    fn invalid_staged_result_never_changes_the_project_head() {
        let mut current = project();
        let original = current.clone();
        let duplicate = current.document.tracks[0].clips[0].clone();
        let result = current.apply_patch(
            patch(
                &current,
                vec![ProjectEditOperation::InsertClip {
                    track_id: current.document.story_track_id,
                    index: 2,
                    clip: Box::new(duplicate),
                }],
            ),
            Uuid::from_u128(52),
            DateTime::UNIX_EPOCH,
        );
        assert!(result.is_err());
        assert_eq!(current, original);
    }

    #[test]
    fn delivery_gate_names_only_enabled_unresolved_clips() {
        let mut current = project();
        current.document.tracks[0].clips[1].placement.enabled = false;
        assert_eq!(
            current.unresolved_delivery_clips().expect("gate"),
            vec![Uuid::from_u128(100)]
        );

        current.document.tracks[0].clips[0].text = Some(TextStyle {
            content: "Title".to_owned(),
            font_family: "Arial".to_owned(),
            font_asset_id: None,
            font_size: 64.0,
            color: "white".to_owned(),
            background: None,
            align: "center".to_owned(),
        });
        assert!(
            current
                .unresolved_delivery_clips()
                .expect("text delivery gate")
                .is_empty()
        );
    }

    #[test]
    fn project_document_rejects_a_non_video_story_track() {
        let mut current = project();
        current.document.tracks[0].kind = TrackKind::Audio;
        assert!(current.validate().is_err());
    }

    #[test]
    fn project_source_demos_are_explicit_bounded_unique_inputs() {
        let mut current = project();
        current.document.settings.source_demo_ids = vec![Uuid::from_u128(1), Uuid::from_u128(2)];
        assert!(current.validate().is_ok());

        current.document.settings.source_demo_ids = vec![Uuid::from_u128(1), Uuid::from_u128(1)];
        assert!(current.validate().is_err());

        current.document.settings.source_demo_ids = (1..=13).map(Uuid::from_u128).collect();
        assert!(current.validate().is_err());
    }

    #[test]
    fn media_asset_references_follow_every_timeline_track_material() {
        let mut current = project();
        let asset_id = Uuid::from_u128(800);
        current.document.tracks[0].clips[0].material = TimelineClipMaterial::Asset {
            asset_id,
            media_duration_seconds: 10.0,
        };

        assert!(current.references_media_asset(asset_id));
        assert!(!current.references_media_asset(Uuid::from_u128(801)));
    }
}
