use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const MAX_EDITOR_KEYFRAMES_PER_CLIP: usize = 128;
pub const MAX_EDITOR_SPEED_SEGMENTS: usize = 16;
pub const MAX_EDITOR_PROJECT_DURATION_SECONDS: f64 = 86_400.0;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EditorProject {
    pub id: Uuid,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub duration_seconds: f64,
    pub tracks: Vec<EditorTrack>,
    pub markers: Vec<EditorMarker>,
    pub settings: serde_json::Value,
    pub revision: u64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorAudioSeparation {
    pub source_clip_id: Uuid,
    pub source_asset_id: Uuid,
    pub audio_asset_id: Uuid,
    pub audio_clip_id: Uuid,
    pub audio_track_id: Uuid,
    pub link_group_id: Uuid,
    pub audio_name: String,
    pub mute_source: bool,
}

/// Metadata for a persisted point-in-time editor project version.
///
/// The full project document is retained by storage and restored through the
/// snapshot identifier; list operations can therefore stay lightweight.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EditorProjectSnapshot {
    pub id: Uuid,
    pub project_id: Uuid,
    pub revision: u64,
    pub name: String,
    pub created_at: DateTime<Utc>,
}

impl EditorProject {
    /// Returns the linked audio child previously created by audio separation.
    /// Both the current structured origin and the earlier flat metadata shape
    /// are accepted so persisted projects remain compatible.
    #[must_use]
    pub fn separated_audio_clip_id(&self, source_clip_id: Uuid) -> Option<Uuid> {
        let source_link_group = self
            .tracks
            .iter()
            .flat_map(|track| &track.clips)
            .find(|clip| clip.id == source_clip_id)?
            .link_group_id?;
        self.tracks
            .iter()
            .filter(|track| track.kind == TrackKind::Audio)
            .flat_map(|track| &track.clips)
            .find(|clip| {
                clip.link_group_id == Some(source_link_group)
                    && separated_audio_origin(&clip.metadata) == Some(source_clip_id)
            })
            .map(|clip| clip.id)
    }

    /// Check invariants required by preview and export engines.
    ///
    /// # Errors
    ///
    /// Returns [`crate::DomainError::InvalidInput`] when canvas, frame-rate,
    /// identifier, timing, or playback-speed constraints are violated.
    pub fn validate(&self) -> Result<(), crate::DomainError> {
        use std::collections::HashSet;

        if self.name.trim().is_empty() {
            return Err(crate::DomainError::InvalidInput(
                "project name cannot be empty".to_owned(),
            ));
        }
        if self.width == 0 || self.height == 0 || self.width > 16_384 || self.height > 16_384 {
            return Err(crate::DomainError::InvalidInput(
                "canvas dimensions must be between 1 and 16384".to_owned(),
            ));
        }
        if !(1..=240).contains(&self.fps) {
            return Err(crate::DomainError::InvalidInput(
                "frame rate must be between 1 and 240".to_owned(),
            ));
        }
        if !self.duration_seconds.is_finite()
            || !(0.0..=MAX_EDITOR_PROJECT_DURATION_SECONDS).contains(&self.duration_seconds)
        {
            return Err(crate::DomainError::InvalidInput(
                "project duration must be finite and at most 86400 seconds".to_owned(),
            ));
        }

        let mut track_ids = HashSet::new();
        let mut clip_ids = HashSet::new();
        let mut keyframe_ids = HashSet::new();
        let mut speed_segment_ids = HashSet::new();
        let mut group_members = std::collections::HashMap::<Uuid, usize>::new();
        let mut link_members = std::collections::HashMap::<Uuid, (usize, HashSet<Uuid>)>::new();
        for track in &self.tracks {
            if !track_ids.insert(track.id) {
                return Err(crate::DomainError::InvalidInput(
                    "track identifiers must be unique".to_owned(),
                ));
            }
            for clip in &track.clips {
                if !clip_ids.insert(clip.id) {
                    return Err(crate::DomainError::InvalidInput(
                        "clip identifiers must be unique across tracks".to_owned(),
                    ));
                }
                if !clip.start.is_finite()
                    || !clip.duration.is_finite()
                    || !clip.source_in.is_finite()
                    || !clip.source_out.is_finite()
                    || clip.start < 0.0
                    || clip.duration <= 0.0
                    || clip.source_in < 0.0
                    || clip.source_out <= clip.source_in
                    || clip.start + clip.duration > MAX_EDITOR_PROJECT_DURATION_SECONDS
                    || clip.start + clip.duration > self.duration_seconds + 0.000_001
                {
                    return Err(crate::DomainError::InvalidInput(format!(
                        "clip {} has invalid timing",
                        clip.id
                    )));
                }
                if !clip.speed.is_finite() || !(0.05..=16.0).contains(&clip.speed) {
                    return Err(crate::DomainError::InvalidInput(format!(
                        "clip {} has invalid speed",
                        clip.id
                    )));
                }
                validate_clip_automation(
                    clip,
                    track.kind,
                    &mut keyframe_ids,
                    &mut speed_segment_ids,
                )?;
                if let Some(group_id) = clip.group_id {
                    *group_members.entry(group_id).or_default() += 1;
                }
                if let Some(link_group_id) = clip.link_group_id {
                    let entry = link_members.entry(link_group_id).or_default();
                    entry.0 += 1;
                    entry.1.insert(track.id);
                }
            }
        }
        if group_members.values().any(|count| *count < 2) {
            return Err(crate::DomainError::InvalidInput(
                "clip groups must contain at least two clips".to_owned(),
            ));
        }
        if link_members
            .values()
            .any(|(count, tracks)| *count < 2 || tracks.len() < 2)
        {
            return Err(crate::DomainError::InvalidInput(
                "linked clips must contain at least two clips on different tracks".to_owned(),
            ));
        }

        let mut marker_ids = HashSet::new();
        for marker in &self.markers {
            if !marker_ids.insert(marker.id) {
                return Err(crate::DomainError::InvalidInput(
                    "marker identifiers must be unique".to_owned(),
                ));
            }
            if !marker.time.is_finite() || marker.time < 0.0 || marker.time > self.duration_seconds
            {
                return Err(crate::DomainError::InvalidInput(format!(
                    "marker {} is outside the project timeline",
                    marker.id
                )));
            }
            if marker.label.trim().is_empty() || marker.label.chars().count() > 200 {
                return Err(crate::DomainError::InvalidInput(format!(
                    "marker {} has an invalid label",
                    marker.id
                )));
            }
            if !is_editor_color(&marker.color) {
                return Err(crate::DomainError::InvalidInput(format!(
                    "marker {} has an invalid color",
                    marker.id
                )));
            }
        }
        Ok(())
    }

    /// Adds a timeline-aligned audio clip for a video clip and optionally
    /// removes the source clip's audio contribution.
    ///
    /// The edit is applied to a clone and committed to `self` only after the
    /// complete project validates, so callers never observe a partial edit.
    ///
    /// # Errors
    ///
    /// Returns [`crate::DomainError::InvalidInput`] when the source clip is
    /// missing, locked, not a video clip, references another asset, or the
    /// resulting editor document would violate an invariant.
    pub fn separate_audio(
        &mut self,
        request: EditorAudioSeparation,
    ) -> Result<(), crate::DomainError> {
        let mut updated = self.clone();
        let Some((source_track_index, source_clip_index)) = updated
            .tracks
            .iter()
            .enumerate()
            .find_map(|(track_index, track)| {
                track
                    .clips
                    .iter()
                    .position(|clip| clip.id == request.source_clip_id)
                    .map(|clip_index| (track_index, clip_index))
            })
        else {
            return Err(crate::DomainError::InvalidInput(
                "source editor clip was not found".to_owned(),
            ));
        };
        let source_track = &updated.tracks[source_track_index];
        if source_track.kind != TrackKind::Video {
            return Err(crate::DomainError::InvalidInput(
                "audio can only be separated from a video track".to_owned(),
            ));
        }
        if source_track.locked {
            return Err(crate::DomainError::InvalidInput(
                "source video track is locked".to_owned(),
            ));
        }
        let source = source_track.clips[source_clip_index].clone();
        if source.asset_id != Some(request.source_asset_id) || source.text.is_some() {
            return Err(crate::DomainError::InvalidInput(
                "source video clip does not reference the requested media asset".to_owned(),
            ));
        }
        if request.audio_name.trim().is_empty() {
            return Err(crate::DomainError::InvalidInput(
                "separated audio name cannot be empty".to_owned(),
            ));
        }
        if let Some(audio_clip_id) = updated.separated_audio_clip_id(request.source_clip_id) {
            return Err(crate::DomainError::Conflict(format!(
                "source editor clip already has separated audio clip {audio_clip_id}"
            )));
        }
        if updated
            .tracks
            .iter()
            .flat_map(|track| &track.clips)
            .any(|clip| clip.id == request.audio_clip_id)
        {
            return Err(crate::DomainError::InvalidInput(
                "separated audio clip identifier is already in use".to_owned(),
            ));
        }

        let link_group_id = source.link_group_id.unwrap_or(request.link_group_id);
        let audio_clip = EditorClip {
            id: request.audio_clip_id,
            asset_id: Some(request.audio_asset_id),
            name: request.audio_name,
            start: source.start,
            duration: source.duration,
            source_in: source.source_in,
            source_out: source.source_out,
            speed: source.speed,
            volume: source.volume,
            transform: Transform::default(),
            effects: Vec::new(),
            transition_in: None,
            transition_out: None,
            text: None,
            metadata: serde_json::json!({
                "separated_from_clip_id": source.id,
                "separated_from_asset_id": request.source_asset_id,
                "audio_origin": {
                    "kind": "separated_from_video",
                    "source_clip_id": source.id,
                    "source_asset_id": request.source_asset_id,
                },
            }),
            group_id: None,
            link_group_id: Some(link_group_id),
            keyframes: source
                .keyframes
                .iter()
                .filter(|keyframe| keyframe.property == EditorKeyframeProperty::Volume)
                .map(|keyframe| EditorKeyframe {
                    id: Uuid::new_v4(),
                    ..keyframe.clone()
                })
                .collect(),
            speed_segments: source
                .speed_segments
                .iter()
                .map(|segment| EditorSpeedSegment {
                    id: Uuid::new_v4(),
                    ..segment.clone()
                })
                .collect(),
        };

        let source_clip = &mut updated.tracks[source_track_index].clips[source_clip_index];
        source_clip.link_group_id = Some(link_group_id);
        if request.mute_source {
            source_clip.volume = 0.0;
            source_clip
                .keyframes
                .retain(|keyframe| keyframe.property != EditorKeyframeProperty::Volume);
        }

        if let Some(audio_track) = updated.tracks.iter_mut().find(|track| {
            track.kind == TrackKind::Audio && !track.locked && !track.muted && !track.hidden
        }) {
            audio_track.clips.push(audio_clip);
        } else {
            let order = updated
                .tracks
                .iter()
                .map(|track| track.order)
                .max()
                .map_or(0, |order| order.saturating_add(1));
            updated.tracks.push(EditorTrack {
                id: request.audio_track_id,
                name: "Separated audio".to_owned(),
                kind: TrackKind::Audio,
                order,
                muted: false,
                locked: false,
                hidden: false,
                clips: vec![audio_clip],
            });
        }
        updated.validate()?;
        *self = updated;
        Ok(())
    }
}

fn separated_audio_origin(metadata: &serde_json::Value) -> Option<Uuid> {
    let structured = metadata
        .get("audio_origin")
        .filter(|origin| {
            origin.get("kind").and_then(serde_json::Value::as_str) == Some("separated_from_video")
        })
        .and_then(|origin| origin.get("source_clip_id"))
        .and_then(serde_json::Value::as_str);
    let legacy = metadata
        .get("separated_from_clip_id")
        .and_then(serde_json::Value::as_str);
    structured
        .or(legacy)
        .and_then(|value| Uuid::parse_str(value).ok())
}

fn validate_clip_automation(
    clip: &EditorClip,
    track_kind: TrackKind,
    keyframe_ids: &mut std::collections::HashSet<Uuid>,
    speed_segment_ids: &mut std::collections::HashSet<Uuid>,
) -> Result<(), crate::DomainError> {
    if !clip.volume.is_finite() || !(0.0..=4.0).contains(&clip.volume) {
        return Err(crate::DomainError::InvalidInput(format!(
            "clip {} has invalid volume",
            clip.id
        )));
    }
    validate_editor_transform(&clip.transform, clip.id)?;
    if clip.keyframes.len() > MAX_EDITOR_KEYFRAMES_PER_CLIP {
        return Err(crate::DomainError::InvalidInput(format!(
            "clip {} has too many keyframes",
            clip.id
        )));
    }
    let mut previous_time = -1.0_f64;
    let mut property_times = std::collections::HashSet::new();
    for keyframe in &clip.keyframes {
        if !keyframe_ids.insert(keyframe.id) {
            return Err(crate::DomainError::InvalidInput(
                "keyframe identifiers must be unique across the project".to_owned(),
            ));
        }
        if !keyframe.time.is_finite()
            || keyframe.time < 0.0
            || keyframe.time > clip.duration
            || keyframe.time + 0.000_001 < previous_time
        {
            return Err(crate::DomainError::InvalidInput(format!(
                "clip {} keyframes must be finite, ordered, and inside the clip",
                clip.id
            )));
        }
        previous_time = keyframe.time;
        let canonical_time = if keyframe.time == 0.0 {
            0.0_f64.to_bits()
        } else {
            keyframe.time.to_bits()
        };
        let property_time = (keyframe.property, canonical_time);
        if !property_times.insert(property_time) {
            return Err(crate::DomainError::InvalidInput(format!(
                "clip {} has duplicate keyframes for one property and time",
                clip.id
            )));
        }
        let supported = match track_kind {
            TrackKind::Audio => keyframe.property == EditorKeyframeProperty::Volume,
            TrackKind::Text => matches!(
                keyframe.property,
                EditorKeyframeProperty::X
                    | EditorKeyframeProperty::Y
                    | EditorKeyframeProperty::Opacity
            ),
            TrackKind::Video | TrackKind::Overlay => true,
        };
        if !supported {
            return Err(crate::DomainError::InvalidInput(format!(
                "clip {} has a keyframe property unsupported by its track",
                clip.id
            )));
        }
        validate_keyframe_value(keyframe.property, keyframe.value, clip.id)?;
    }

    if clip.speed_segments.is_empty() {
        return Ok(());
    }
    if clip.asset_id.is_none() || clip.text.is_some() {
        return Err(crate::DomainError::InvalidInput(format!(
            "clip {} cannot apply speed segments without a media source",
            clip.id
        )));
    }
    if (clip.speed - 1.0).abs() > 0.000_001 {
        return Err(crate::DomainError::InvalidInput(format!(
            "clip {} cannot combine a base speed with speed segments",
            clip.id
        )));
    }
    if clip.speed_segments.len() > MAX_EDITOR_SPEED_SEGMENTS {
        return Err(crate::DomainError::InvalidInput(format!(
            "clip {} has too many speed segments",
            clip.id
        )));
    }
    let mut cursor = 0.0_f64;
    let mut consumed_source = 0.0_f64;
    for segment in &clip.speed_segments {
        if !speed_segment_ids.insert(segment.id) {
            return Err(crate::DomainError::InvalidInput(
                "speed segment identifiers must be unique across the project".to_owned(),
            ));
        }
        if !segment.start.is_finite()
            || !segment.end.is_finite()
            || !segment.speed.is_finite()
            || (segment.start - cursor).abs() > 0.000_001
            || segment.end <= segment.start
            || !(0.05..=16.0).contains(&segment.speed)
        {
            return Err(crate::DomainError::InvalidInput(format!(
                "clip {} speed segments must be contiguous, ordered, finite, and bounded",
                clip.id
            )));
        }
        consumed_source += (segment.end - segment.start) * segment.speed;
        cursor = segment.end;
    }
    if (cursor - clip.duration).abs() > 0.000_001
        || consumed_source > clip.source_out - clip.source_in + 0.001
    {
        return Err(crate::DomainError::InvalidInput(format!(
            "clip {} speed segments must cover the clip and remain inside its source range",
            clip.id
        )));
    }
    Ok(())
}

fn validate_editor_transform(
    transform: &Transform,
    clip_id: Uuid,
) -> Result<(), crate::DomainError> {
    let values = [transform.x, transform.y, transform.rotation];
    if values.iter().any(|value| !value.is_finite())
        || !transform.scale_x.is_finite()
        || !(0.01..=10.0).contains(&transform.scale_x)
        || !transform.scale_y.is_finite()
        || !(0.01..=10.0).contains(&transform.scale_y)
        || !transform.opacity.is_finite()
        || !(0.0..=1.0).contains(&transform.opacity)
    {
        return Err(crate::DomainError::InvalidInput(format!(
            "clip {clip_id} has an invalid transform"
        )));
    }
    Ok(())
}

fn validate_keyframe_value(
    property: EditorKeyframeProperty,
    value: f64,
    clip_id: Uuid,
) -> Result<(), crate::DomainError> {
    let valid = value.is_finite()
        && match property {
            EditorKeyframeProperty::X | EditorKeyframeProperty::Y => {
                (-100_000.0..=100_000.0).contains(&value)
            }
            EditorKeyframeProperty::ScaleX | EditorKeyframeProperty::ScaleY => {
                (0.01..=10.0).contains(&value)
            }
            EditorKeyframeProperty::Rotation => (-3_600.0..=3_600.0).contains(&value),
            EditorKeyframeProperty::Opacity => (0.0..=1.0).contains(&value),
            EditorKeyframeProperty::Volume => (0.0..=4.0).contains(&value),
        };
    if valid {
        Ok(())
    } else {
        Err(crate::DomainError::InvalidInput(format!(
            "clip {clip_id} has an invalid keyframe value"
        )))
    }
}

fn is_editor_color(value: &str) -> bool {
    matches!(value.len(), 7 | 9)
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EditorTrack {
    pub id: Uuid,
    pub name: String,
    pub kind: TrackKind,
    pub order: u32,
    pub muted: bool,
    pub locked: bool,
    pub hidden: bool,
    pub clips: Vec<EditorClip>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TrackKind {
    Video,
    Audio,
    Text,
    Overlay,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EditorClip {
    pub id: Uuid,
    pub asset_id: Option<Uuid>,
    pub name: String,
    pub start: f64,
    pub duration: f64,
    pub source_in: f64,
    pub source_out: f64,
    pub speed: f64,
    pub volume: f64,
    pub transform: Transform,
    pub effects: Vec<EditorEffect>,
    pub transition_in: Option<String>,
    pub transition_out: Option<String>,
    pub text: Option<TextStyle>,
    pub metadata: serde_json::Value,
    #[serde(default)]
    pub group_id: Option<Uuid>,
    #[serde(default)]
    pub link_group_id: Option<Uuid>,
    #[serde(default)]
    pub keyframes: Vec<EditorKeyframe>,
    #[serde(default)]
    pub speed_segments: Vec<EditorSpeedSegment>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum EditorKeyframeProperty {
    X,
    Y,
    ScaleX,
    ScaleY,
    Rotation,
    Opacity,
    Volume,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EditorKeyframe {
    pub id: Uuid,
    pub time: f64,
    pub property: EditorKeyframeProperty,
    pub value: f64,
}

/// One constant-speed interval on the clip-local output timeline.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EditorSpeedSegment {
    pub id: Uuid,
    pub start: f64,
    pub end: f64,
    pub speed: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Transform {
    pub x: f64,
    pub y: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    pub rotation: f64,
    pub opacity: f64,
}

impl Default for Transform {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            rotation: 0.0,
            opacity: 1.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EditorEffect {
    pub id: String,
    pub kind: String,
    pub enabled: bool,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TextStyle {
    pub content: String,
    pub font_family: String,
    /// Optional managed font asset. Exporters resolve the identifier through
    /// the media library instead of accepting an ambient filesystem path.
    #[serde(default)]
    pub font_asset_id: Option<Uuid>,
    pub font_size: f64,
    pub color: String,
    pub background: Option<String>,
    pub align: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EditorMarker {
    pub id: Uuid,
    pub time: f64,
    pub label: String,
    pub color: String,
}

pub const EDITOR_PRESET_SCHEMA_VERSION: u32 = 1;

/// A versioned, closed set of clip properties that the renderer supports.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EditorPresetDocument {
    pub schema_version: u32,
    pub transform: Transform,
    pub volume: f64,
    pub color_adjust: Option<EditorColorAdjustPreset>,
    pub grayscale: bool,
    pub blur_radius: Option<f64>,
    pub transition_in: Option<EditorTransitionPreset>,
    pub transition_out: Option<EditorTransitionPreset>,
}

impl EditorPresetDocument {
    /// Validates the preset schema and every renderer-facing value.
    ///
    /// # Errors
    ///
    /// Returns [`crate::DomainError::InvalidInput`] when the schema version or
    /// any renderer-facing value is unsupported.
    pub fn validate(&self) -> Result<(), crate::DomainError> {
        if self.schema_version != EDITOR_PRESET_SCHEMA_VERSION {
            return Err(crate::DomainError::InvalidInput(
                "editor preset schema version is unsupported".to_owned(),
            ));
        }
        validate_editor_transform(&self.transform, Uuid::nil())?;
        if !self.volume.is_finite() || !(0.0..=4.0).contains(&self.volume) {
            return Err(crate::DomainError::InvalidInput(
                "editor preset volume must be between 0 and 4".to_owned(),
            ));
        }
        if let Some(adjustment) = &self.color_adjust
            && (!adjustment.brightness.is_finite()
                || !(-1.0..=1.0).contains(&adjustment.brightness)
                || !adjustment.contrast.is_finite()
                || !(0.0..=3.0).contains(&adjustment.contrast)
                || !adjustment.saturation.is_finite()
                || !(0.0..=3.0).contains(&adjustment.saturation))
        {
            return Err(crate::DomainError::InvalidInput(
                "editor preset color adjustment is invalid".to_owned(),
            ));
        }
        if self
            .blur_radius
            .is_some_and(|radius| !radius.is_finite() || !(0.0..=20.0).contains(&radius))
        {
            return Err(crate::DomainError::InvalidInput(
                "editor preset blur radius must be between 0 and 20".to_owned(),
            ));
        }
        Ok(())
    }

    /// Ensures that every property represented by this preset is rendered by
    /// the selected target rather than being silently ignored or rejected at
    /// export time.
    ///
    /// # Errors
    ///
    /// Returns [`crate::DomainError::InvalidInput`] when the selected track or
    /// clip cannot faithfully render one or more preset properties.
    pub fn validate_for_target(
        &self,
        track_kind: TrackKind,
        clip: &EditorClip,
    ) -> Result<(), crate::DomainError> {
        self.validate()?;
        let identity_color = self.color_adjust.as_ref().is_none_or(|adjustment| {
            adjustment.brightness.abs() <= 0.000_001
                && (adjustment.contrast - 1.0).abs() <= 0.000_001
                && (adjustment.saturation - 1.0).abs() <= 0.000_001
        });
        let no_visual_effect = identity_color
            && !self.grayscale
            && self.blur_radius.is_none_or(|radius| radius <= 0.000_001);
        let identity_visual_transform = self.transform.x.abs() <= 0.000_001
            && self.transform.y.abs() <= 0.000_001
            && (self.transform.scale_x - 1.0).abs() <= 0.000_001
            && (self.transform.scale_y - 1.0).abs() <= 0.000_001
            && self.transform.rotation.abs() <= 0.000_001
            && (self.transform.opacity - 1.0).abs() <= 0.000_001;

        if track_kind == TrackKind::Audio {
            if !identity_visual_transform || !no_visual_effect {
                return Err(crate::DomainError::InvalidInput(
                    "audio clips cannot apply visual preset properties".to_owned(),
                ));
            }
            return Ok(());
        }

        if track_kind == TrackKind::Text || clip.text.is_some() {
            let supported_text_transform = (self.transform.scale_x - 1.0).abs() <= 0.000_001
                && (self.transform.scale_y - 1.0).abs() <= 0.000_001
                && self.transform.rotation.abs() <= 0.000_001;
            if !supported_text_transform
                || !no_visual_effect
                || self.transition_in.is_some()
                || self.transition_out.is_some()
                || (self.volume - clip.volume).abs() > 0.000_001
            {
                return Err(crate::DomainError::InvalidInput(
                    "text clips support only preset position and opacity".to_owned(),
                ));
            }
        }
        Ok(())
    }

    /// Replaces only the closed set of base clip properties represented by a
    /// preset. Existing automation remains explicit and untouched.
    pub fn apply_to_clip(&self, clip: &mut EditorClip) {
        clip.transform = self.transform.clone();
        clip.volume = self.volume;
        clip.transition_in = self.transition_in.map(|transition| match transition {
            EditorTransitionPreset::Fade => "fade".to_owned(),
            EditorTransitionPreset::Flash => "flash".to_owned(),
            EditorTransitionPreset::Dip => "dip".to_owned(),
            EditorTransitionPreset::Zoom => "zoom".to_owned(),
            EditorTransitionPreset::Wipe => "wipe".to_owned(),
            EditorTransitionPreset::Slide => "slide".to_owned(),
            EditorTransitionPreset::Blur => "blur".to_owned(),
            EditorTransitionPreset::Glitch => "glitch".to_owned(),
            EditorTransitionPreset::Spin => "spin".to_owned(),
        });
        clip.transition_out = self.transition_out.map(|transition| match transition {
            EditorTransitionPreset::Fade => "fade".to_owned(),
            EditorTransitionPreset::Flash => "flash".to_owned(),
            EditorTransitionPreset::Dip => "dip".to_owned(),
            EditorTransitionPreset::Zoom => "zoom".to_owned(),
            EditorTransitionPreset::Wipe => "wipe".to_owned(),
            EditorTransitionPreset::Slide => "slide".to_owned(),
            EditorTransitionPreset::Blur => "blur".to_owned(),
            EditorTransitionPreset::Glitch => "glitch".to_owned(),
            EditorTransitionPreset::Spin => "spin".to_owned(),
        });
        let mut effects = clip
            .effects
            .iter()
            .filter(|effect| !matches!(effect.kind.as_str(), "color_adjust" | "grayscale" | "blur"))
            .cloned()
            .collect::<Vec<_>>();
        if let Some(adjustment) = &self.color_adjust {
            effects.push(EditorEffect {
                id: "preset-color-adjust".to_owned(),
                kind: "color_adjust".to_owned(),
                enabled: true,
                parameters: serde_json::json!({
                    "brightness": adjustment.brightness,
                    "contrast": adjustment.contrast,
                    "saturation": adjustment.saturation,
                }),
            });
        }
        if self.grayscale {
            effects.push(EditorEffect {
                id: "preset-grayscale".to_owned(),
                kind: "grayscale".to_owned(),
                enabled: true,
                parameters: serde_json::json!({}),
            });
        }
        if let Some(radius) = self.blur_radius {
            effects.push(EditorEffect {
                id: "preset-blur".to_owned(),
                kind: "blur".to_owned(),
                enabled: true,
                parameters: serde_json::json!({ "radius": radius }),
            });
        }
        clip.effects = effects;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EditorColorAdjustPreset {
    pub brightness: f64,
    pub contrast: f64,
    pub saturation: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EditorTransitionPreset {
    Fade,
    Flash,
    Dip,
    Zoom,
    Wipe,
    Slide,
    Blur,
    Glitch,
    Spin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MediaAsset {
    pub id: Uuid,
    pub project_id: Option<Uuid>,
    pub path: String,
    pub name: String,
    pub kind: String,
    pub duration_seconds: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub file_size: u64,
    #[serde(default)]
    pub has_audio: bool,
    pub proxy_path: Option<String>,
    #[serde(default)]
    pub proxy_status: MediaProxyStatus,
    pub waveform: Option<Vec<f32>>,
    #[serde(default)]
    pub metadata_status: MediaMetadataStatus,
    pub created_at: DateTime<Utc>,
}

/// Lifecycle of the optional low-resolution editing proxy.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum MediaProxyStatus {
    #[default]
    NotRequested,
    Generating {
        started_at: DateTime<Utc>,
        #[serde(default)]
        lease_id: Uuid,
        #[serde(default)]
        expires_at: DateTime<Utc>,
    },
    Ready {
        generated_at: DateTime<Utc>,
    },
    Failed {
        message: String,
        failed_at: DateTime<Utc>,
    },
}

/// Versioned manifest stored at the root of a portable editor package.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EditorPackageManifest {
    pub format: String,
    pub version: u32,
    pub created_at: DateTime<Utc>,
    pub project_sha256: String,
    pub assets: Vec<EditorPackageAsset>,
}

/// Integrity and reconnection metadata for one packaged source file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EditorPackageAsset {
    pub source_asset_id: Uuid,
    pub archive_path: String,
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub sha256: String,
}

/// Describes whether media metadata probing has completed successfully.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum MediaMetadataStatus {
    #[default]
    Pending,
    Ready,
    Unavailable {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExportJob {
    pub id: Uuid,
    pub project_id: Uuid,
    pub status: crate::JobStatus,
    pub progress: f64,
    pub output_path: String,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_metadata_status_is_backward_compatible_and_reports_failures() {
        let mut value = serde_json::to_value(MediaAsset {
            id: Uuid::new_v4(),
            project_id: None,
            path: "C:/clips/round.mp4".to_owned(),
            name: "Round".to_owned(),
            kind: "video".to_owned(),
            duration_seconds: None,
            width: None,
            height: None,
            file_size: 42,
            has_audio: true,
            proxy_path: None,
            proxy_status: MediaProxyStatus::NotRequested,
            waveform: None,
            metadata_status: MediaMetadataStatus::Pending,
            created_at: Utc::now(),
        })
        .expect("serialize asset");
        value
            .as_object_mut()
            .expect("asset is an object")
            .remove("metadata_status");

        let legacy: MediaAsset = serde_json::from_value(value).expect("deserialize legacy asset");
        assert_eq!(legacy.metadata_status, MediaMetadataStatus::Pending);

        let unavailable = MediaMetadataStatus::Unavailable {
            message: "unsupported codec".to_owned(),
        };
        let value = serde_json::to_value(&unavailable).expect("serialize unavailable status");
        assert_eq!(value["status"], "unavailable");
        assert_eq!(value["message"], "unsupported codec");

        let legacy_generating: MediaProxyStatus = serde_json::from_value(serde_json::json!({
            "status": "generating",
            "started_at": "2026-01-01T00:00:00Z"
        }))
        .expect("deserialize legacy generating status");
        assert!(matches!(
            legacy_generating,
            MediaProxyStatus::Generating {
                lease_id,
                expires_at,
                ..
            } if lease_id == Uuid::nil() && expires_at == DateTime::<Utc>::default()
        ));
    }

    #[test]
    fn project_duration_has_a_finite_export_bound() {
        let now = Utc::now();
        let mut project = EditorProject {
            id: Uuid::new_v4(),
            name: "bounded".to_owned(),
            width: 1_920,
            height: 1_080,
            fps: 60,
            duration_seconds: MAX_EDITOR_PROJECT_DURATION_SECONDS,
            tracks: Vec::new(),
            markers: Vec::new(),
            settings: serde_json::json!({}),
            revision: 1,
            created_at: now,
            updated_at: now,
        };
        project.validate().expect("maximum duration is valid");
        project.duration_seconds = MAX_EDITOR_PROJECT_DURATION_SECONDS + 0.001;
        assert!(matches!(
            project.validate(),
            Err(crate::DomainError::InvalidInput(message))
                if message.contains("at most 86400")
        ));
    }

    #[test]
    fn separating_audio_preserves_timing_and_commits_atomically() {
        let now = Utc::now();
        let source_asset_id = Uuid::new_v4();
        let source_clip_id = Uuid::new_v4();
        let volume_keyframe_id = Uuid::new_v4();
        let speed_segment_id = Uuid::new_v4();
        let mut project = EditorProject {
            id: Uuid::new_v4(),
            name: "separation".to_owned(),
            width: 1_920,
            height: 1_080,
            fps: 60,
            duration_seconds: 4.0,
            tracks: vec![EditorTrack {
                id: Uuid::new_v4(),
                name: "Video".to_owned(),
                kind: TrackKind::Video,
                order: 0,
                muted: false,
                locked: false,
                hidden: false,
                clips: vec![EditorClip {
                    id: source_clip_id,
                    asset_id: Some(source_asset_id),
                    name: "Source".to_owned(),
                    start: 1.0,
                    duration: 2.0,
                    source_in: 3.0,
                    source_out: 5.0,
                    speed: 1.0,
                    volume: 0.75,
                    transform: Transform::default(),
                    effects: Vec::new(),
                    transition_in: None,
                    transition_out: None,
                    text: None,
                    metadata: serde_json::json!({}),
                    group_id: None,
                    link_group_id: None,
                    keyframes: vec![EditorKeyframe {
                        id: volume_keyframe_id,
                        time: 1.0,
                        property: EditorKeyframeProperty::Volume,
                        value: 0.5,
                    }],
                    speed_segments: vec![EditorSpeedSegment {
                        id: speed_segment_id,
                        start: 0.0,
                        end: 2.0,
                        speed: 1.0,
                    }],
                }],
            }],
            markers: Vec::new(),
            settings: serde_json::json!({}),
            revision: 1,
            created_at: now,
            updated_at: now,
        };
        let audio_asset_id = Uuid::new_v4();
        let audio_clip_id = Uuid::new_v4();
        project
            .separate_audio(EditorAudioSeparation {
                source_clip_id,
                source_asset_id,
                audio_asset_id,
                audio_clip_id,
                audio_track_id: Uuid::new_v4(),
                link_group_id: Uuid::new_v4(),
                audio_name: "Source audio".to_owned(),
                mute_source: true,
            })
            .expect("separate audio");

        let source = &project.tracks[0].clips[0];
        let audio_track = project
            .tracks
            .iter()
            .find(|track| track.kind == TrackKind::Audio)
            .expect("audio track");
        let audio = &audio_track.clips[0];
        assert!(source.volume.abs() < f64::EPSILON);
        assert!(source.keyframes.is_empty());
        assert_eq!(audio.asset_id, Some(audio_asset_id));
        assert!((audio.start - 1.0).abs() < f64::EPSILON);
        assert!((audio.duration - 2.0).abs() < f64::EPSILON);
        assert!((audio.source_in - 3.0).abs() < f64::EPSILON);
        assert!((audio.source_out - 5.0).abs() < f64::EPSILON);
        assert!((audio.volume - 0.75).abs() < f64::EPSILON);
        assert!((audio.keyframes[0].value - 0.5).abs() < f64::EPSILON);
        assert_ne!(audio.keyframes[0].id, volume_keyframe_id);
        assert_ne!(audio.speed_segments[0].id, speed_segment_id);
        assert_eq!(audio.link_group_id, source.link_group_id);
        project.validate().expect("separated project validates");

        let separated = project.clone();
        let duplicate = project
            .separate_audio(EditorAudioSeparation {
                source_clip_id,
                source_asset_id,
                audio_asset_id: Uuid::new_v4(),
                audio_clip_id: Uuid::new_v4(),
                audio_track_id: Uuid::new_v4(),
                link_group_id: Uuid::new_v4(),
                audio_name: "Duplicate audio".to_owned(),
                mute_source: true,
            })
            .expect_err("duplicate separation is rejected");
        assert!(matches!(
            duplicate,
            crate::DomainError::Conflict(message) if message.contains("already has separated audio")
        ));
        assert_eq!(project, separated);

        let before_failure = project.clone();
        project.tracks[0].locked = true;
        let locked = project.clone();
        assert!(
            project
                .separate_audio(EditorAudioSeparation {
                    source_clip_id,
                    source_asset_id,
                    audio_asset_id: Uuid::new_v4(),
                    audio_clip_id: Uuid::new_v4(),
                    audio_track_id: Uuid::new_v4(),
                    link_group_id: Uuid::new_v4(),
                    audio_name: "Second audio".to_owned(),
                    mute_source: true,
                })
                .is_err()
        );
        assert_eq!(project, locked);
        assert_ne!(project, before_failure);
    }

    #[test]
    fn preset_target_validation_rejects_properties_the_renderer_cannot_apply() {
        let mut document = EditorPresetDocument {
            schema_version: EDITOR_PRESET_SCHEMA_VERSION,
            transform: Transform::default(),
            volume: 1.0,
            color_adjust: Some(EditorColorAdjustPreset {
                brightness: 0.0,
                contrast: 1.0,
                saturation: 1.0,
            }),
            grayscale: false,
            blur_radius: None,
            transition_in: None,
            transition_out: None,
        };
        let text_clip = EditorClip {
            id: Uuid::new_v4(),
            asset_id: None,
            name: "caption".to_owned(),
            start: 0.0,
            duration: 1.0,
            source_in: 0.0,
            source_out: 1.0,
            speed: 1.0,
            volume: 1.0,
            transform: Transform::default(),
            effects: Vec::new(),
            transition_in: None,
            transition_out: None,
            text: Some(TextStyle {
                content: "caption".to_owned(),
                font_family: "Arial".to_owned(),
                font_asset_id: None,
                font_size: 24.0,
                color: "#ffffff".to_owned(),
                background: None,
                align: "center".to_owned(),
            }),
            metadata: serde_json::json!({}),
            group_id: None,
            link_group_id: None,
            keyframes: Vec::new(),
            speed_segments: Vec::new(),
        };
        document
            .validate_for_target(TrackKind::Text, &text_clip)
            .expect("position and opacity defaults are supported");

        document.transform.rotation = 12.0;
        assert!(matches!(
            document.validate_for_target(TrackKind::Text, &text_clip),
            Err(crate::DomainError::InvalidInput(message))
                if message.contains("text clips support only")
        ));
        document.transform.rotation = 0.0;
        document
            .validate_for_target(TrackKind::Video, &text_clip)
            .expect("text payload keeps text restrictions on an overlay track");

        document.transform.x = 5.0;
        assert!(matches!(
            document.validate_for_target(TrackKind::Audio, &text_clip),
            Err(crate::DomainError::InvalidInput(message))
                if message.contains("audio clips cannot")
        ));
    }
}
