use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DemoStatus {
    #[default]
    Discovered,
    Indexing,
    Ready,
    Analyzing,
    Failed,
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DemoRecord {
    pub id: Uuid,
    pub path: String,
    pub file_name: String,
    pub display_name: String,
    pub source: String,
    pub status: DemoStatus,
    pub map_name: Option<String>,
    pub match_date: Option<DateTime<Utc>>,
    pub duration_seconds: Option<f64>,
    pub total_rounds: Option<u32>,
    pub team_a_name: Option<String>,
    pub team_b_name: Option<String>,
    pub team_a_score: Option<u32>,
    pub team_b_score: Option<u32>,
    pub remark: String,
    pub content_sha256: Option<String>,
    pub file_size: u64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct DemoQuery {
    pub search: Option<String>,
    pub source: Option<String>,
    pub map_name: Option<String>,
    pub status: Option<DemoStatus>,
    pub page: Option<u32>,
    pub page_size: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DemoPatch {
    pub display_name: Option<String>,
    pub remark: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScanRequest {
    pub paths: Vec<String>,
    #[serde(default = "default_true")]
    pub recursive: bool,
}

const fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScanResult {
    pub discovered: u64,
    pub imported: u64,
    pub updated: u64,
    pub skipped: u64,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlayerStats {
    pub steam_id: String,
    pub name: String,
    pub team: String,
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
    pub headshots: u32,
    pub damage: u32,
    pub adr: f64,
    pub rating: f64,
    pub score: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TeamSummary {
    pub name: String,
    pub side: String,
    pub score: u32,
    pub players: Vec<String>,
}
