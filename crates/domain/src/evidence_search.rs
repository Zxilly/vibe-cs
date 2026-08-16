use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
use uuid::Uuid;

pub const EVIDENCE_SEARCH_DEFAULT_PAGE_SIZE: u32 = 50;
pub const EVIDENCE_SEARCH_MAX_PAGE_SIZE: u32 = 100;
pub const EVIDENCE_SEARCH_MAX_PAGE: u32 = 100_000;
pub const EVIDENCE_SEARCH_MAX_QUERY_CHARS: usize = 128;
pub const EVIDENCE_SEARCH_MAX_FILTER_CHARS: usize = 128;
pub const EVIDENCE_SEARCH_MAX_ROUND: u32 = 256;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EvidenceEventFamily {
    Kill,
    MultiKill,
    Objective,
    RoundStart,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EvidenceSourceKind {
    Event,
    Highlight,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct EvidenceSearchQuery {
    #[ts(optional)]
    pub q: Option<String>,
    #[ts(optional)]
    pub event_family: Option<EvidenceEventFamily>,
    #[ts(optional)]
    pub actor: Option<String>,
    #[ts(optional)]
    pub victim: Option<String>,
    #[ts(optional)]
    pub player: Option<String>,
    #[ts(optional)]
    pub weapon: Option<String>,
    #[ts(optional)]
    pub map: Option<String>,
    #[ts(optional)]
    pub source: Option<String>,
    #[ts(optional)]
    pub headshot: Option<bool>,
    #[ts(optional)]
    pub round: Option<u32>,
    #[ts(optional)]
    pub match_date_from: Option<DateTime<Utc>>,
    #[ts(optional)]
    pub match_date_to: Option<DateTime<Utc>>,
    #[ts(optional)]
    pub source_kind: Option<EvidenceSourceKind>,
    #[ts(optional)]
    pub demo_id: Option<Uuid>,
    #[ts(optional)]
    pub page: Option<u32>,
    #[ts(optional)]
    pub page_size: Option<u32>,
}

impl EvidenceSearchQuery {
    /// Validates request bounds before the query reaches `SQLite`.
    ///
    /// # Errors
    ///
    /// Returns [`crate::DomainError::InvalidInput`] when a supplied query,
    /// filter, date window, round, or page lies outside the public contract.
    pub fn validate(&self) -> Result<(), crate::DomainError> {
        if self.q.as_deref().is_some_and(|value| {
            !(1..=EVIDENCE_SEARCH_MAX_QUERY_CHARS).contains(&value.trim().chars().count())
        }) {
            return Err(crate::DomainError::InvalidInput(format!(
                "q must contain 1 to {EVIDENCE_SEARCH_MAX_QUERY_CHARS} characters"
            )));
        }
        if self
            .page
            .is_some_and(|page| !(1..=EVIDENCE_SEARCH_MAX_PAGE).contains(&page))
        {
            return Err(crate::DomainError::InvalidInput(format!(
                "page must be between 1 and {EVIDENCE_SEARCH_MAX_PAGE}"
            )));
        }
        if self
            .page_size
            .is_some_and(|size| !(1..=EVIDENCE_SEARCH_MAX_PAGE_SIZE).contains(&size))
        {
            return Err(crate::DomainError::InvalidInput(format!(
                "page_size must be between 1 and {EVIDENCE_SEARCH_MAX_PAGE_SIZE}"
            )));
        }
        for (name, value) in [
            ("actor", self.actor.as_deref()),
            ("victim", self.victim.as_deref()),
            ("player", self.player.as_deref()),
            ("weapon", self.weapon.as_deref()),
            ("map", self.map.as_deref()),
            ("source", self.source.as_deref()),
        ] {
            let Some(value) = value else {
                continue;
            };
            let length = value.trim().chars().count();
            if !(1..=EVIDENCE_SEARCH_MAX_FILTER_CHARS).contains(&length) {
                return Err(crate::DomainError::InvalidInput(format!(
                    "{name} must contain 1 to {EVIDENCE_SEARCH_MAX_FILTER_CHARS} characters"
                )));
            }
        }
        if self
            .round
            .is_some_and(|round| !(1..=EVIDENCE_SEARCH_MAX_ROUND).contains(&round))
        {
            return Err(crate::DomainError::InvalidInput(format!(
                "round must be between 1 and {EVIDENCE_SEARCH_MAX_ROUND}"
            )));
        }
        if matches!(
            (self.match_date_from, self.match_date_to),
            (Some(from), Some(to)) if from > to
        ) {
            return Err(crate::DomainError::InvalidInput(
                "match_date_from must not be later than match_date_to".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
pub struct EvidenceSearchItem {
    pub evidence_id: String,
    pub demo_id: Uuid,
    pub demo_display_name: String,
    pub map_name: String,
    pub match_date: Option<DateTime<Utc>>,
    pub round: u32,
    pub tick: u64,
    pub end_tick: u64,
    pub event_type: String,
    pub actor_id: Option<String>,
    pub actor_name: Option<String>,
    pub target_id: Option<String>,
    pub target_name: Option<String>,
    pub weapon: Option<String>,
    pub headshot: Option<bool>,
    pub penetrated: Option<bool>,
    pub source_kind: EvidenceSourceKind,
    pub source_id: String,
    pub attributes: Value,
    pub analysis_href: String,
    pub replay_href: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export)]
pub struct EvidenceSearchCapability {
    pub available: bool,
    pub indexed_items: u64,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export)]
pub struct EvidenceSearchAvailability {
    pub indexed_items: u64,
    /// Analyses whose durable projection timestamp and row count are current.
    pub indexed_demos: u64,
    pub total_analyses: u64,
    /// True only when every stored analysis has a complete durable projection.
    pub scan_complete: bool,
    pub match_date: EvidenceSearchCapability,
    pub source: EvidenceSearchCapability,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
pub struct EvidenceSearchPage {
    pub items: Vec<EvidenceSearchItem>,
    pub total: u64,
    pub page: u32,
    pub page_size: u32,
    pub availability: EvidenceSearchAvailability,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evidence_search_rejects_empty_or_oversized_search_text() {
        for q in [
            String::new(),
            " ".to_owned(),
            "x".repeat(EVIDENCE_SEARCH_MAX_QUERY_CHARS + 1),
        ] {
            assert!(
                EvidenceSearchQuery {
                    q: Some(q),
                    ..EvidenceSearchQuery::default()
                }
                .validate()
                .is_err()
            );
        }
    }

    #[test]
    fn evidence_search_rejects_pagination_outside_the_documented_window() {
        let invalid = [
            EvidenceSearchQuery {
                page: Some(0),
                ..EvidenceSearchQuery::default()
            },
            EvidenceSearchQuery {
                page: Some(EVIDENCE_SEARCH_MAX_PAGE + 1),
                ..EvidenceSearchQuery::default()
            },
            EvidenceSearchQuery {
                page_size: Some(0),
                ..EvidenceSearchQuery::default()
            },
            EvidenceSearchQuery {
                page_size: Some(EVIDENCE_SEARCH_MAX_PAGE_SIZE + 1),
                ..EvidenceSearchQuery::default()
            },
        ];

        assert!(invalid.iter().all(|query| query.validate().is_err()));
    }

    #[test]
    fn evidence_search_rejects_empty_or_oversized_text_filters() {
        let invalid = [
            EvidenceSearchQuery {
                actor: Some("   ".to_owned()),
                ..EvidenceSearchQuery::default()
            },
            EvidenceSearchQuery {
                victim: Some("x".repeat(EVIDENCE_SEARCH_MAX_FILTER_CHARS + 1)),
                ..EvidenceSearchQuery::default()
            },
            EvidenceSearchQuery {
                player: Some(String::new()),
                ..EvidenceSearchQuery::default()
            },
            EvidenceSearchQuery {
                weapon: Some(String::new()),
                ..EvidenceSearchQuery::default()
            },
            EvidenceSearchQuery {
                map: Some(String::new()),
                ..EvidenceSearchQuery::default()
            },
            EvidenceSearchQuery {
                source: Some(String::new()),
                ..EvidenceSearchQuery::default()
            },
        ];

        assert!(invalid.iter().all(|query| query.validate().is_err()));
    }

    #[test]
    fn evidence_search_rejects_invalid_round_or_date_windows() {
        let later = "2025-01-02T00:00:00Z".parse().expect("later date");
        let earlier = "2025-01-01T00:00:00Z".parse().expect("earlier date");
        let invalid = [
            EvidenceSearchQuery {
                round: Some(0),
                ..EvidenceSearchQuery::default()
            },
            EvidenceSearchQuery {
                round: Some(EVIDENCE_SEARCH_MAX_ROUND + 1),
                ..EvidenceSearchQuery::default()
            },
            EvidenceSearchQuery {
                match_date_from: Some(later),
                match_date_to: Some(earlier),
                ..EvidenceSearchQuery::default()
            },
        ];

        assert!(invalid.iter().all(|query| query.validate().is_err()));
    }
}
