//! Durable footage choices behind the Agent's one-sentence video workflow.
//!
//! A [`Take`] is one recording result for one plan shot. A [`Composition`]
//! selects exactly one take per included shot and fixes their order. Keeping
//! these as domain objects prevents export from guessing at files in a folder.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::{DomainError, JobStatus};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct Take {
    pub id: Uuid,
    pub plan_id: Uuid,
    pub shot_id: Uuid,
    pub recorded_clip_id: Uuid,
    pub recording_job_id: Uuid,
    /// Hash of the footage-producing [`crate::RecordingRequest`] fields.
    /// `None` keeps older takes readable; the workbench may recover their
    /// fingerprint from the immutable recording job request.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub shot_spec_fingerprint: Option<String>,
    pub ordinal: u32,
    pub label: String,
    pub duration_seconds: f64,
    pub created_at: DateTime<Utc>,
}

impl Take {
    /// Validates the stable identity and presentation fields of a recorded take.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when an identity is nil, the
    /// ordinal/label/duration is invalid, or a supplied shot fingerprint is not
    /// a lowercase SHA-256 digest.
    pub fn validate(&self) -> Result<(), DomainError> {
        if self.id.is_nil()
            || self.plan_id.is_nil()
            || self.shot_id.is_nil()
            || self.recorded_clip_id.is_nil()
            || self.recording_job_id.is_nil()
        {
            return Err(DomainError::InvalidInput(
                "take identities must be non-nil".to_owned(),
            ));
        }
        if self.ordinal == 0 {
            return Err(DomainError::InvalidInput(
                "take ordinal must be positive".to_owned(),
            ));
        }
        if self.shot_spec_fingerprint.as_ref().is_some_and(|value| {
            value.len() != 64
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        }) {
            return Err(DomainError::InvalidInput(
                "take shot_spec_fingerprint must be a lowercase SHA-256".to_owned(),
            ));
        }
        if self.label.trim().is_empty() || self.label.chars().count() > 80 {
            return Err(DomainError::InvalidInput(
                "take label must contain between 1 and 80 characters".to_owned(),
            ));
        }
        if !self.duration_seconds.is_finite() || self.duration_seconds < 0.0 {
            return Err(DomainError::InvalidInput(
                "take duration must be a finite non-negative number".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CompositionStatus {
    Draft,
    Confirmed,
    Exporting,
    Exported,
    Failed,
}

impl CompositionStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Confirmed => "confirmed",
            Self::Exporting => "exporting",
            Self::Exported => "exported",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct CompositionItem {
    pub shot_id: Uuid,
    pub take_id: Uuid,
    pub order: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct Composition {
    pub id: Uuid,
    pub plan_id: Uuid,
    pub plan_revision: i64,
    pub title: String,
    pub status: CompositionStatus,
    pub items: Vec<CompositionItem>,
    pub export_job_id: Option<Uuid>,
    pub export_status: Option<JobStatus>,
    pub output_path: Option<String>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Composition {
    /// Validates the document-local invariants. Storage additionally checks
    /// that every take belongs to this plan and to the paired shot.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when identities, revision, title,
    /// item order/uniqueness or a non-draft empty selection is invalid.
    pub fn validate(&self) -> Result<(), DomainError> {
        if self.id.is_nil() || self.plan_id.is_nil() {
            return Err(DomainError::InvalidInput(
                "composition identities must be non-nil".to_owned(),
            ));
        }
        if self.plan_revision < 1 {
            return Err(DomainError::InvalidInput(
                "composition plan_revision must be positive".to_owned(),
            ));
        }
        if self.title.trim().is_empty() || self.title.chars().count() > 200 {
            return Err(DomainError::InvalidInput(
                "composition title must contain between 1 and 200 characters".to_owned(),
            ));
        }
        let mut shot_ids = std::collections::HashSet::new();
        let mut take_ids = std::collections::HashSet::new();
        for (index, item) in self.items.iter().enumerate() {
            if item.shot_id.is_nil() || item.take_id.is_nil() {
                return Err(DomainError::InvalidInput(
                    "composition item identities must be non-nil".to_owned(),
                ));
            }
            if item.order != u32::try_from(index).unwrap_or(u32::MAX) {
                return Err(DomainError::InvalidInput(
                    "composition item order must be contiguous from zero".to_owned(),
                ));
            }
            if !shot_ids.insert(item.shot_id) {
                return Err(DomainError::InvalidInput(
                    "a composition may select only one take per shot".to_owned(),
                ));
            }
            if !take_ids.insert(item.take_id) {
                return Err(DomainError::InvalidInput(
                    "a take may appear only once in a composition".to_owned(),
                ));
            }
        }
        if matches!(
            self.status,
            CompositionStatus::Confirmed
                | CompositionStatus::Exporting
                | CompositionStatus::Exported
        ) && self.items.is_empty()
        {
            return Err(DomainError::InvalidInput(
                "a confirmed composition must contain at least one take".to_owned(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn composition(items: Vec<CompositionItem>) -> Composition {
        let now = Utc::now();
        Composition {
            id: Uuid::new_v4(),
            plan_id: Uuid::new_v4(),
            plan_revision: 1,
            title: "Final".to_owned(),
            status: CompositionStatus::Draft,
            items,
            export_job_id: None,
            export_status: None,
            output_path: None,
            error: None,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn composition_requires_one_take_per_shot_in_contiguous_order() {
        let shot = Uuid::new_v4();
        let first = Uuid::new_v4();
        let duplicate_shot = composition(vec![
            CompositionItem {
                shot_id: shot,
                take_id: first,
                order: 0,
            },
            CompositionItem {
                shot_id: shot,
                take_id: Uuid::new_v4(),
                order: 1,
            },
        ]);
        assert!(duplicate_shot.validate().is_err());

        let skipped = composition(vec![CompositionItem {
            shot_id: Uuid::new_v4(),
            take_id: Uuid::new_v4(),
            order: 1,
        }]);
        assert!(skipped.validate().is_err());
    }

    #[test]
    fn confirmed_composition_cannot_be_empty() {
        let mut value = composition(Vec::new());
        value.status = CompositionStatus::Confirmed;
        assert!(value.validate().is_err());
    }
}
