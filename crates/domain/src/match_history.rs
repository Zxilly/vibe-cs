use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchHistoryResult {
    Win,
    Loss,
    Draw,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchDemoStatus {
    #[default]
    Available,
    Downloading,
    Downloaded,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SteamMatchRecord {
    pub id: String,
    pub steam_id: String,
    pub match_id: String,
    pub outcome_id: String,
    pub token: u16,
    pub map_name: Option<String>,
    pub played_at: Option<DateTime<Utc>>,
    pub score: Option<String>,
    pub result: MatchHistoryResult,
    pub demo_status: MatchDemoStatus,
    pub demo_id: Option<Uuid>,
    pub last_error: Option<String>,
    pub synced_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MatchHistoryQuery {
    pub steam_id: Option<String>,
    pub page: Option<u32>,
    pub page_size: Option<u32>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchDownloadStatus {
    #[default]
    Queued,
    Downloading,
    Decompressing,
    Importing,
    Completed,
    Cancelling,
    Cancelled,
    Failed,
}

impl MatchDownloadStatus {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled | Self::Failed)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MatchDownloadJob {
    pub id: Uuid,
    pub match_record_id: String,
    pub status: MatchDownloadStatus,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub progress: f64,
    pub demo_id: Option<Uuid>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
