//! Shared timeline value types used by the canonical Editing Document.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::DomainError;

pub const MAX_EDITOR_KEYFRAMES_PER_CLIP: usize = 128;
pub const MAX_EDITOR_SPEED_SEGMENTS: usize = 16;
pub const MAX_EDITOR_PROJECT_DURATION_SECONDS: f64 = 86_400.0;
pub const MIN_EDITOR_CLIP_SPEED: f64 = 0.0625;
pub const MAX_EDITOR_CLIP_SPEED: f64 = 16.0;

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TrackKind {
    Video,
    Audio,
    Text,
    Overlay,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EditorKeyframeProperty {
    X,
    Y,
    ScaleX,
    ScaleY,
    Rotation,
    Opacity,
    Volume,
    Pan,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EditorKeyframeInterpolation {
    Hold,
    Linear,
    Bezier,
    EaseIn,
    EaseOut,
    EaseInOut,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct EditorKeyframe {
    pub id: Uuid,
    pub time: f64,
    pub property: EditorKeyframeProperty,
    pub value: f64,
    pub interpolation: EditorKeyframeInterpolation,
    pub in_tangent: f64,
    pub out_tangent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct EditorSpeedSegment {
    pub id: Uuid,
    pub start: f64,
    pub end: f64,
    pub speed: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct EditorEffect {
    pub id: String,
    pub kind: String,
    pub enabled: bool,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct TextStyle {
    pub content: String,
    pub font_family: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub font_asset_id: Option<Uuid>,
    pub font_size: f64,
    pub color: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub background: Option<String>,
    pub align: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EditorMarkerKind {
    Comment,
    Chapter,
    Segmentation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct EditorMarker {
    pub id: Uuid,
    pub time: f64,
    pub duration: f64,
    pub label: String,
    pub color: String,
    pub kind: EditorMarkerKind,
    pub comment: String,
}

/// Validates one complete marker collection at its owning sequence or source boundary.
pub fn validate_editor_markers(
    markers: &[EditorMarker],
    maximum_time: f64,
) -> Result<(), DomainError> {
    if !maximum_time.is_finite()
        || !(0.0..=MAX_EDITOR_PROJECT_DURATION_SECONDS).contains(&maximum_time)
    {
        return Err(DomainError::InvalidInput(
            "marker time boundary is invalid".to_owned(),
        ));
    }
    let mut marker_ids = HashSet::new();
    for marker in markers {
        let color = marker.color.as_bytes();
        if !marker_ids.insert(marker.id)
            || !marker.time.is_finite()
            || !marker.duration.is_finite()
            || marker.time < 0.0
            || marker.duration < 0.0
            || marker.time + marker.duration > maximum_time + 0.001
            || marker.label.trim().is_empty()
            || color.len() != 7
            || color[0] != b'#'
            || !color[1..].iter().all(u8::is_ascii_hexdigit)
        {
            return Err(DomainError::InvalidInput(
                "editor marker collection is invalid".to_owned(),
            ));
        }
    }
    Ok(())
}
