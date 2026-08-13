use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use vibe_cs_domain::DomainError;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlayerDirectorySort {
    Player,
    Team,
    Matches,
    Kd,
    Kills,
    Deaths,
    Assists,
    Headshots,
    Adr,
    Damage,
    LastMatch,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlayerDirectorySortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PlayerDirectoryQuery {
    pub search: Option<String>,
    pub page: Option<u32>,
    pub page_size: Option<u32>,
    pub sort: PlayerDirectorySort,
    pub direction: PlayerDirectorySortDirection,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PlayerComparisonQuery {
    pub left: String,
    pub right: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SteamProfileState {
    Available,
    NotConfigured,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlayerSteamProfile {
    pub state: SteamProfileState,
    pub persona_name: Option<String>,
    pub real_name: Option<String>,
    pub profile_url: Option<String>,
    pub country_code: Option<String>,
    pub persona_state: Option<u8>,
    pub last_logoff: Option<DateTime<Utc>>,
    pub created_at: Option<DateTime<Utc>>,
    pub avatar_url: Option<String>,
    pub reason: Option<String>,
}

impl PlayerSteamProfile {
    #[must_use]
    pub fn not_configured() -> Self {
        Self {
            state: SteamProfileState::NotConfigured,
            persona_name: None,
            real_name: None,
            profile_url: None,
            country_code: None,
            persona_state: None,
            last_logoff: None,
            created_at: None,
            avatar_url: None,
            reason: Some("Steam Web API key is not configured".to_owned()),
        }
    }

    #[must_use]
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            state: SteamProfileState::Unavailable,
            persona_name: None,
            real_name: None,
            profile_url: None,
            country_code: None,
            persona_state: None,
            last_logoff: None,
            created_at: None,
            avatar_url: None,
            reason: Some(reason.into()),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PlayerAggregateStats {
    pub matches: u32,
    pub kills: u64,
    pub deaths: u64,
    pub assists: u64,
    pub headshots: u64,
    pub damage: u64,
    pub average_adr: Option<f64>,
    pub average_kill_death_ratio: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlayerDirectoryItem {
    pub steam_id: String,
    pub name: String,
    pub aliases: Vec<String>,
    pub last_team: Option<String>,
    pub last_match_at: DateTime<Utc>,
    pub stats: PlayerAggregateStats,
    pub steam: PlayerSteamProfile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PlayerRecentMatch {
    pub demo_id: Uuid,
    pub demo_name: String,
    pub map_name: Option<String>,
    pub played_at: DateTime<Utc>,
    pub team: Option<String>,
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
    pub headshots: u32,
    pub damage: u32,
    pub adr: Option<f64>,
    pub kill_death_ratio: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlayerDirectoryPage {
    pub items: Vec<PlayerDirectoryItem>,
    pub total: u64,
    pub page: u32,
    pub page_size: u32,
    pub scanned_demos: u32,
    pub scan_complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PlayerComparison {
    pub players: [PlayerDirectoryItem; 2],
    pub scanned_demos: u32,
    pub scan_complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlayerProfile {
    pub player: PlayerDirectoryItem,
    pub recent_matches: Vec<PlayerRecentMatch>,
    pub scanned_demos: u32,
    pub scan_complete: bool,
}

#[derive(Clone, PartialEq, Eq)]
pub struct PlayerAvatar {
    pub bytes: Vec<u8>,
    pub content_type: String,
    pub etag: String,
    pub last_modified: DateTime<Utc>,
    pub cached: bool,
}

impl std::fmt::Debug for PlayerAvatar {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PlayerAvatar")
            .field("bytes", &self.bytes.len())
            .field("content_type", &self.content_type)
            .field("etag", &self.etag)
            .field("last_modified", &self.last_modified)
            .field("cached", &self.cached)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AvatarCacheStatus {
    pub entries: u64,
    pub bytes: u64,
    pub maximum_entries: u64,
    pub maximum_bytes: u64,
    pub scan_complete: bool,
    pub checked_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AvatarCacheCleanup {
    pub removed_entries: u64,
    pub freed_bytes: u64,
    pub failed_entries: u64,
    pub scan_complete: bool,
    pub completed_at: DateTime<Utc>,
}

#[async_trait]
pub trait PlayerPort: Send + Sync + std::fmt::Debug {
    async fn list(&self, query: PlayerDirectoryQuery) -> Result<PlayerDirectoryPage, DomainError>;
    async fn get(&self, steam_id: String) -> Result<PlayerProfile, DomainError>;
    async fn compare(&self, query: PlayerComparisonQuery) -> Result<PlayerComparison, DomainError>;
    async fn avatar(&self, steam_id: String) -> Result<PlayerAvatar, DomainError>;
    async fn avatar_cache_status(&self) -> Result<AvatarCacheStatus, DomainError>;
    async fn clear_avatar_cache(&self) -> Result<AvatarCacheCleanup, DomainError>;
}

#[derive(Debug, Default)]
pub struct DisabledPlayerPort;

#[async_trait]
impl PlayerPort for DisabledPlayerPort {
    async fn list(&self, _query: PlayerDirectoryQuery) -> Result<PlayerDirectoryPage, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "player directory adapter".to_owned(),
        ))
    }

    async fn get(&self, _steam_id: String) -> Result<PlayerProfile, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "player directory adapter".to_owned(),
        ))
    }

    async fn compare(
        &self,
        _query: PlayerComparisonQuery,
    ) -> Result<PlayerComparison, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "player directory adapter".to_owned(),
        ))
    }

    async fn avatar(&self, _steam_id: String) -> Result<PlayerAvatar, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "Steam avatar adapter".to_owned(),
        ))
    }

    async fn avatar_cache_status(&self) -> Result<AvatarCacheStatus, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "avatar cache adapter".to_owned(),
        ))
    }

    async fn clear_avatar_cache(&self) -> Result<AvatarCacheCleanup, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "avatar cache adapter".to_owned(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_comparison_query_requires_exact_current_fields() {
        let query = serde_json::from_value::<PlayerComparisonQuery>(serde_json::json!({
            "left": "76561198000000001",
            "right": "76561198000000002"
        }))
        .expect("current comparison query");

        assert_eq!(query.left, "76561198000000001");
        assert_eq!(query.right, "76561198000000002");
        assert!(
            serde_json::from_value::<PlayerComparisonQuery>(serde_json::json!({
                "left": "76561198000000001"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<PlayerComparisonQuery>(serde_json::json!({
                "left": "76561198000000001",
                "right": "76561198000000002",
                "players": ["76561198000000001", "76561198000000002"]
            }))
            .is_err()
        );
    }

    #[test]
    fn player_directory_metrics_use_only_explicit_kill_death_ratio_names() {
        let aggregate = serde_json::json!({
            "matches": 2,
            "kills": 30,
            "deaths": 20,
            "assists": 7,
            "headshots": 12,
            "damage": 2_800,
            "average_adr": 70.0,
            "average_kill_death_ratio": 1.5
        });
        assert!(serde_json::from_value::<PlayerAggregateStats>(aggregate.clone()).is_ok());

        let mut retired = aggregate;
        retired["average_rating"] = retired["average_kill_death_ratio"].take();
        retired
            .as_object_mut()
            .unwrap()
            .remove("average_kill_death_ratio");
        assert!(serde_json::from_value::<PlayerAggregateStats>(retired).is_err());
    }
}
