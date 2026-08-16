use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

pub const MAX_DEMO_PLAYER_SUMMARY_NAMES: usize = 64;
pub const DEMO_MAX_PAGE: u32 = 100_000;
pub const DEMO_MAX_PAGE_SIZE: u32 = 200;
pub const DEMO_COMMENT_MAX_CHARS: usize = crate::REVIEW_COMMENT_MAX_CHARS;
pub const DEMO_TAG_MAX_NAME_CHARS: usize = crate::REVIEW_TAG_MAX_NAME_CHARS;
pub const DEMO_TAG_MAX_ASSIGNMENTS: usize = crate::REVIEW_TAG_MAX_ASSIGNMENTS;
pub const DEMO_METADATA_BATCH_MAX_DEMOS: usize = 100;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DemoMatchSource {
    Challengermode,
    Ebot,
    Esl,
    Esplay,
    Esportal,
    Esportligaen,
    Faceit,
    Fastcup,
    FiveEplay,
    Matchzy,
    PerfectWorld,
    Pracc,
    Renown,
    Valve,
}

pub type DemoTag = crate::ReviewTag;
pub type DemoTagCreate = crate::ReviewTagCreate;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct DemoMetadata {
    pub demo_id: Uuid,
    pub match_source: Option<DemoMatchSource>,
    pub comment: String,
    pub tags: Vec<DemoTag>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct DemoMetadataUpdate {
    pub match_source: Option<DemoMatchSource>,
    pub comment: String,
    pub tag_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct DemoMetadataBatchUpdate {
    pub demo_ids: Vec<Uuid>,
    pub set_match_source: bool,
    pub match_source: Option<DemoMatchSource>,
    pub add_tag_ids: Vec<Uuid>,
    pub remove_tag_ids: Vec<Uuid>,
}

impl DemoMetadataUpdate {
    /// Validates the complete replacement document used by the metadata Interface.
    ///
    /// # Errors
    ///
    /// Returns [`crate::DomainError::InvalidInput`] when the comment or tag assignment set is
    /// outside the current bounded contract.
    pub fn validate(&self) -> Result<(), crate::DomainError> {
        if self.comment.chars().count() > DEMO_COMMENT_MAX_CHARS
            || self.comment.chars().any(|character| character == '\0')
        {
            return Err(crate::DomainError::InvalidInput(
                "demo comment must contain at most 4000 characters and no NUL bytes".to_owned(),
            ));
        }
        if self.tag_ids.len() > DEMO_TAG_MAX_ASSIGNMENTS {
            return Err(crate::DomainError::InvalidInput(
                "a demo may have at most 32 tags".to_owned(),
            ));
        }
        let mut unique = std::collections::BTreeSet::new();
        if !self.tag_ids.iter().all(|id| unique.insert(*id)) {
            return Err(crate::DomainError::InvalidInput(
                "demo tag assignments must be unique".to_owned(),
            ));
        }
        Ok(())
    }
}

impl DemoMetadataBatchUpdate {
    /// Validates one bounded, explicit, all-or-nothing metadata batch.
    ///
    /// # Errors
    ///
    /// Returns [`crate::DomainError::InvalidInput`] for empty/oversized or ambiguous requests.
    pub fn validate(&self) -> Result<(), crate::DomainError> {
        if self.demo_ids.is_empty() || self.demo_ids.len() > DEMO_METADATA_BATCH_MAX_DEMOS {
            return Err(crate::DomainError::InvalidInput(
                "demo metadata batch must contain 1..=100 Demo IDs".to_owned(),
            ));
        }
        let demo_ids = self
            .demo_ids
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        if demo_ids.len() != self.demo_ids.len() {
            return Err(crate::DomainError::InvalidInput(
                "demo metadata batch Demo IDs must be unique".to_owned(),
            ));
        }
        if !self.set_match_source && self.match_source.is_some() {
            return Err(crate::DomainError::InvalidInput(
                "match_source requires set_match_source=true".to_owned(),
            ));
        }
        let added = self
            .add_tag_ids
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        let removed = self
            .remove_tag_ids
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        if added.len() != self.add_tag_ids.len() || removed.len() != self.remove_tag_ids.len() {
            return Err(crate::DomainError::InvalidInput(
                "demo metadata batch tag IDs must be unique".to_owned(),
            ));
        }
        if !added.is_disjoint(&removed) {
            return Err(crate::DomainError::InvalidInput(
                "a tag cannot be both added and removed".to_owned(),
            ));
        }
        if !self.set_match_source && added.is_empty() && removed.is_empty() {
            return Err(crate::DomainError::InvalidInput(
                "demo metadata batch must change source or tags".to_owned(),
            ));
        }
        Ok(())
    }
}

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DemoStatus {
    #[default]
    Discovered,
    Indexing,
    Ready,
    Analyzing,
    Failed,
    Missing,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DemoSort {
    #[default]
    UpdatedDesc,
    UpdatedAsc,
    FileAsc,
    FileDesc,
    StatusAsc,
    StatusDesc,
    MapAsc,
    MapDesc,
    ScoreAsc,
    ScoreDesc,
    DurationAsc,
    DurationDesc,
    RoundsAsc,
    RoundsDesc,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct DemoRecord {
    pub id: Uuid,
    pub path: String,
    pub file_name: String,
    pub display_name: String,
    pub source: String,
    pub status: DemoStatus,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub map_name: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub match_date: Option<DateTime<Utc>>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub duration_seconds: Option<f64>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub total_rounds: Option<u32>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub team_a_name: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub team_b_name: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub team_a_score: Option<u32>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub team_b_score: Option<u32>,
    pub player_names: Vec<String>,
    pub remark: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub content_sha256: Option<String>,
    pub file_size: u64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export)]
pub struct DemoQuery {
    #[ts(optional)]
    pub search: Option<String>,
    #[ts(optional)]
    pub source: Option<String>,
    #[ts(optional)]
    pub match_source: Option<DemoMatchSource>,
    #[ts(optional)]
    pub tag_id: Option<Uuid>,
    #[ts(optional)]
    pub map_name: Option<String>,
    #[ts(optional)]
    pub status: Option<DemoStatus>,
    #[ts(optional)]
    pub sort: Option<DemoSort>,
    #[ts(optional)]
    pub page: Option<u32>,
    #[ts(optional)]
    pub page_size: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export)]
pub struct DemoPatch {
    #[ts(optional)]
    pub display_name: Option<String>,
    #[ts(optional)]
    pub remark: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct ScanRequest {
    pub paths: Vec<String>,
    pub recursive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export)]
pub struct ScanResult {
    pub discovered: u64,
    pub imported: u64,
    pub updated: u64,
    pub skipped: u64,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export)]
pub struct PlayerStats {
    pub steam_id: String,
    /// One-based CS2 spectator target derived from `CMsgPlayerInfo.userid`.
    /// It is absent when the parser did not observe one unambiguous slot in 1..=64.
    pub spectator_slot: Option<u8>,
    pub name: String,
    pub team: String,
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
    pub headshots: u32,
    pub damage: u32,
    pub adr: f64,
    /// `kills / max(deaths, 1)` from the parsed scoreboard totals.
    pub kill_death_ratio: f64,
    pub score: i32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlayerStatsInput {
    steam_id: String,
    spectator_slot: RequiredNullable<u8>,
    name: String,
    team: String,
    kills: u32,
    deaths: u32,
    assists: u32,
    headshots: u32,
    damage: u32,
    adr: f64,
    kill_death_ratio: f64,
    score: i32,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RequiredNullable<T> {
    Value(T),
    Null(()),
}

impl<T> RequiredNullable<T> {
    fn into_option(self) -> Option<T> {
        match self {
            Self::Value(value) => Some(value),
            Self::Null(()) => None,
        }
    }
}

impl<'de> Deserialize<'de> for PlayerStats {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let input = PlayerStatsInput::deserialize(deserializer)?;
        Ok(Self {
            steam_id: input.steam_id,
            spectator_slot: input.spectator_slot.into_option(),
            name: input.name,
            team: input.team,
            kills: input.kills,
            deaths: input.deaths,
            assists: input.assists,
            headshots: input.headshots,
            damage: input.damage,
            adr: input.adr,
            kill_death_ratio: input.kill_death_ratio,
            score: input.score,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct TeamSummary {
    pub name: String,
    pub side: String,
    pub score: u32,
    pub players: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn current_demo_record() -> DemoRecord {
        let now = Utc::now();
        DemoRecord {
            id: Uuid::new_v4(),
            path: "C:/demos/match.dem".to_owned(),
            file_name: "match.dem".to_owned(),
            display_name: "Match".to_owned(),
            source: "local".to_owned(),
            status: DemoStatus::Ready,
            map_name: None,
            match_date: None,
            duration_seconds: None,
            total_rounds: None,
            team_a_name: None,
            team_b_name: None,
            team_a_score: None,
            team_b_score: None,
            player_names: Vec::new(),
            remark: String::new(),
            content_sha256: None,
            file_size: 0,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn demo_record_requires_every_current_nullable_field() {
        let current = serde_json::to_value(current_demo_record()).expect("current demo record");
        serde_json::from_value::<DemoRecord>(current.clone()).expect("current demo record shape");

        for field in [
            "map_name",
            "match_date",
            "duration_seconds",
            "total_rounds",
            "team_a_name",
            "team_b_name",
            "team_a_score",
            "team_b_score",
            "content_sha256",
        ] {
            let mut missing = current.clone();
            missing
                .as_object_mut()
                .expect("demo record object")
                .remove(field);
            assert!(
                serde_json::from_value::<DemoRecord>(missing).is_err(),
                "missing current field {field} must be rejected"
            );
        }
    }

    #[test]
    fn demo_metadata_rejects_ambiguous_or_unbounded_user_input() {
        assert_eq!(
            DemoTagCreate {
                name: "  Major  ".to_owned(),
                color: "#DC2626".to_owned(),
            }
            .normalize()
            .expect("valid tag"),
            DemoTagCreate {
                name: "Major".to_owned(),
                color: "#dc2626".to_owned(),
            }
        );
        assert!(
            DemoTagCreate {
                name: "bad\nname".to_owned(),
                color: "#dc2626".to_owned(),
            }
            .normalize()
            .is_err()
        );
        let duplicate = Uuid::new_v4();
        assert!(
            DemoMetadataUpdate {
                match_source: None,
                comment: String::new(),
                tag_ids: vec![duplicate, duplicate],
            }
            .validate()
            .is_err()
        );
        assert!(
            DemoMetadataUpdate {
                match_source: None,
                comment: "x".repeat(DEMO_COMMENT_MAX_CHARS + 1),
                tag_ids: Vec::new(),
            }
            .validate()
            .is_err()
        );
    }
}
