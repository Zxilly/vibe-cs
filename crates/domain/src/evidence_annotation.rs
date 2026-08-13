use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

pub const EVIDENCE_ANNOTATION_MAX_BODY_CHARS: usize = 4_000;
pub const EVIDENCE_ANNOTATION_MAX_TAGS: usize = 16;
pub const EVIDENCE_ANNOTATION_MAX_TAG_CHARS: usize = 64;
pub const EVIDENCE_ANNOTATION_MAX_QUERY_CHARS: usize = 256;
pub const EVIDENCE_ANNOTATION_DEFAULT_PAGE_SIZE: u32 = 50;
pub const EVIDENCE_ANNOTATION_MAX_PAGE_SIZE: u32 = 100;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceAnnotationReviewState {
    Open,
    Resolved,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EvidenceAnnotation {
    pub id: Uuid,
    pub demo_id: Uuid,
    pub evidence_id: String,
    pub round: u32,
    pub tick: u64,
    pub body: String,
    pub tags: Vec<String>,
    pub review_state: EvidenceAnnotationReviewState,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CreateEvidenceAnnotation {
    pub demo_id: Uuid,
    pub evidence_id: String,
    pub round: u32,
    pub tick: u64,
    pub body: String,
    pub tags: Vec<String>,
}

impl CreateEvidenceAnnotation {
    /// Normalizes user-authored text and validates the current annotation contract.
    ///
    /// # Errors
    ///
    /// Returns [`crate::DomainError::InvalidInput`] when the body, tags, or evidence locator is
    /// outside the public contract.
    pub fn normalize(mut self) -> Result<Self, crate::DomainError> {
        self.evidence_id = normalized_evidence_id(&self.evidence_id)?;
        self.body = normalized_body(&self.body)?;
        self.tags = normalized_tags(self.tags)?;
        if !(1..=crate::EVIDENCE_SEARCH_MAX_ROUND).contains(&self.round) {
            return Err(crate::DomainError::InvalidInput(format!(
                "round must be between 1 and {}",
                crate::EVIDENCE_SEARCH_MAX_ROUND
            )));
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UpdateEvidenceAnnotation {
    pub body: String,
    pub tags: Vec<String>,
    pub review_state: EvidenceAnnotationReviewState,
}

impl UpdateEvidenceAnnotation {
    /// Normalizes user-authored text and validates the current annotation update contract.
    ///
    /// # Errors
    ///
    /// Returns [`crate::DomainError::InvalidInput`] when the body or tags are invalid.
    pub fn normalize(mut self) -> Result<Self, crate::DomainError> {
        self.body = normalized_body(&self.body)?;
        self.tags = normalized_tags(self.tags)?;
        Ok(self)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EvidenceAnnotationQuery {
    pub q: Option<String>,
    pub tag: Option<String>,
    pub demo_id: Option<Uuid>,
    pub evidence_id: Option<String>,
    pub state: Option<EvidenceAnnotationReviewState>,
    pub page: Option<u32>,
    pub page_size: Option<u32>,
}

impl EvidenceAnnotationQuery {
    /// Validates filters and pagination before querying persistence.
    ///
    /// # Errors
    ///
    /// Returns [`crate::DomainError::InvalidInput`] when a filter or page is invalid.
    pub fn validate(&self) -> Result<(), crate::DomainError> {
        if self.q.as_deref().is_some_and(|value| {
            value.trim().is_empty()
                || value.trim().chars().count() > EVIDENCE_ANNOTATION_MAX_QUERY_CHARS
        }) {
            return Err(crate::DomainError::InvalidInput(format!(
                "q must contain 1 to {EVIDENCE_ANNOTATION_MAX_QUERY_CHARS} characters"
            )));
        }
        if self.tag.as_deref().is_some_and(|value| {
            value.trim().is_empty()
                || value.trim().chars().count() > EVIDENCE_ANNOTATION_MAX_TAG_CHARS
        }) {
            return Err(crate::DomainError::InvalidInput(format!(
                "tag must contain 1 to {EVIDENCE_ANNOTATION_MAX_TAG_CHARS} characters"
            )));
        }
        if self
            .evidence_id
            .as_deref()
            .is_some_and(|value| value.trim().is_empty() || value.chars().count() > 512)
        {
            return Err(crate::DomainError::InvalidInput(
                "evidence_id must contain 1 to 512 characters".to_owned(),
            ));
        }
        if self.page.is_some_and(|page| page == 0) {
            return Err(crate::DomainError::InvalidInput(
                "page must be greater than zero".to_owned(),
            ));
        }
        if self
            .page_size
            .is_some_and(|size| !(1..=EVIDENCE_ANNOTATION_MAX_PAGE_SIZE).contains(&size))
        {
            return Err(crate::DomainError::InvalidInput(format!(
                "page_size must be between 1 and {EVIDENCE_ANNOTATION_MAX_PAGE_SIZE}"
            )));
        }
        Ok(())
    }
}

fn normalized_evidence_id(value: &str) -> Result<String, crate::DomainError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 512 {
        return Err(crate::DomainError::InvalidInput(
            "evidence_id must contain 1 to 512 characters".to_owned(),
        ));
    }
    Ok(value.to_owned())
}

fn normalized_body(value: &str) -> Result<String, crate::DomainError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > EVIDENCE_ANNOTATION_MAX_BODY_CHARS {
        return Err(crate::DomainError::InvalidInput(format!(
            "annotation body must contain 1 to {EVIDENCE_ANNOTATION_MAX_BODY_CHARS} characters"
        )));
    }
    Ok(value.to_owned())
}

fn normalized_tags(tags: Vec<String>) -> Result<Vec<String>, crate::DomainError> {
    if tags.len() > EVIDENCE_ANNOTATION_MAX_TAGS {
        return Err(crate::DomainError::InvalidInput(format!(
            "an annotation may contain at most {EVIDENCE_ANNOTATION_MAX_TAGS} tags"
        )));
    }
    let mut normalized = Vec::with_capacity(tags.len());
    let mut unique = HashSet::with_capacity(tags.len());
    for tag in tags {
        let tag = tag.trim();
        if tag.is_empty() || tag.chars().count() > EVIDENCE_ANNOTATION_MAX_TAG_CHARS {
            return Err(crate::DomainError::InvalidInput(format!(
                "annotation tags must contain 1 to {EVIDENCE_ANNOTATION_MAX_TAG_CHARS} characters"
            )));
        }
        if !unique.insert(tag.to_lowercase()) {
            return Err(crate::DomainError::InvalidInput(
                "annotation tags must be unique".to_owned(),
            ));
        }
        normalized.push(tag.to_owned());
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn annotation_draft_normalizes_user_text_and_rejects_duplicate_tags() {
        let normalized = CreateEvidenceAnnotation {
            demo_id: Uuid::new_v4(),
            evidence_id: " demo:match/event:kill-7 ".to_owned(),
            round: 7,
            tick: 42_000,
            body: "  Hold the crossfire before the retake.  ".to_owned(),
            tags: vec![" Retake ".to_owned(), "Utility".to_owned()],
        }
        .normalize()
        .expect("valid annotation");

        assert_eq!(normalized.evidence_id, "demo:match/event:kill-7");
        assert_eq!(normalized.body, "Hold the crossfire before the retake.");
        assert_eq!(normalized.tags, ["Retake", "Utility"]);

        let duplicate = CreateEvidenceAnnotation {
            tags: vec!["Retake".to_owned(), " retake ".to_owned()],
            ..normalized
        };
        assert!(duplicate.normalize().is_err());
    }

    #[test]
    fn annotation_query_exposes_only_the_current_state_filter() {
        let query: EvidenceAnnotationQuery = serde_json::from_value(serde_json::json!({
            "state": "resolved"
        }))
        .expect("current state filter");
        assert_eq!(query.state, Some(EvidenceAnnotationReviewState::Resolved));

        assert!(
            serde_json::from_value::<EvidenceAnnotationQuery>(serde_json::json!({
                "review_state": "resolved"
            }))
            .is_err()
        );
    }
}
