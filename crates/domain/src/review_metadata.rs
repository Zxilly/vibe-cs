use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::DomainError;
use ts_rs::TS;

pub const REVIEW_COMMENT_MAX_CHARS: usize = 4_000;
pub const REVIEW_TAG_MAX_NAME_CHARS: usize = 64;
pub const REVIEW_TAG_MAX_ASSIGNMENTS: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct ReviewTag {
    pub id: Uuid,
    pub name: String,
    pub color: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct ReviewTagCreate {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct ReviewMetadataUpdate {
    pub comment: String,
    pub tag_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct PlayerReviewMetadata {
    pub steam_id: String,
    pub comment: String,
    pub tags: Vec<ReviewTag>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct RoundReviewMetadata {
    pub demo_id: Uuid,
    pub source_sha256: String,
    pub round: u32,
    pub comment: String,
    pub tags: Vec<ReviewTag>,
    pub updated_at: DateTime<Utc>,
}

impl ReviewTagCreate {
    /// Normalizes one tag in the shared review catalog while preserving display case.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] for an empty, oversized, control-character, or
    /// non-hex-color tag.
    pub fn normalize(mut self) -> Result<Self, DomainError> {
        self.name = self.name.trim().to_owned();
        if self.name.is_empty()
            || self.name.chars().count() > REVIEW_TAG_MAX_NAME_CHARS
            || self.name.chars().any(char::is_control)
        {
            return Err(DomainError::InvalidInput(
                "review tag name must contain 1..=64 printable characters".to_owned(),
            ));
        }
        if self.color.len() != 7
            || !self.color.starts_with('#')
            || !self.color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(DomainError::InvalidInput(
                "review tag color must be a #RRGGBB value".to_owned(),
            ));
        }
        self.color.make_ascii_lowercase();
        Ok(self)
    }
}

impl ReviewMetadataUpdate {
    /// Validates one complete replacement document shared by Demo, Player, and Round review
    /// metadata.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when the comment or tag assignment set is outside
    /// the bounded current contract.
    pub fn validate(&self) -> Result<(), DomainError> {
        if self.comment.chars().count() > REVIEW_COMMENT_MAX_CHARS || self.comment.contains('\0') {
            return Err(DomainError::InvalidInput(
                "review comment must contain at most 4000 characters and no NUL bytes".to_owned(),
            ));
        }
        if self.tag_ids.len() > REVIEW_TAG_MAX_ASSIGNMENTS {
            return Err(DomainError::InvalidInput(
                "a review subject may have at most 32 tags".to_owned(),
            ));
        }
        let mut unique = std::collections::BTreeSet::new();
        if !self.tag_ids.iter().all(|id| unique.insert(*id)) {
            return Err(DomainError::InvalidInput(
                "review tag assignments must be unique".to_owned(),
            ));
        }
        Ok(())
    }
}

/// Returns whether a string is one canonical public individual Steam64 identity.
#[must_use]
pub fn is_canonical_review_steam64(value: &str) -> bool {
    if value.len() != 17 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let Ok(steam_id) = value.parse::<u64>() else {
        return false;
    };
    let universe = (steam_id >> 56) & 0xff;
    let account_type = (steam_id >> 52) & 0x0f;
    let instance = (steam_id >> 32) & 0x000f_ffff;
    let account_id = steam_id & u64::from(u32::MAX);
    universe == 1 && account_type == 1 && instance == 1 && account_id != 0
}

/// Returns whether a string is one lowercase SHA-256 digest.
#[must_use]
pub fn is_review_source_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
