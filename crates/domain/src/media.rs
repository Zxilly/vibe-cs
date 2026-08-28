use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct MediaAsset {
    pub id: Uuid,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub project_id: Option<Uuid>,
    pub path: String,
    pub name: String,
    pub kind: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub duration_seconds: Option<f64>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub width: Option<u32>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub height: Option<u32>,
    pub file_size: u64,
    pub has_audio: bool,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub proxy_path: Option<String>,
    pub proxy_status: MediaProxyStatus,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub waveform: Option<Vec<f32>>,
    pub metadata_status: MediaMetadataStatus,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
#[ts(export)]
pub enum MediaProxyStatus {
    NotRequested,
    Generating {
        started_at: DateTime<Utc>,
        lease_id: Uuid,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
#[ts(export)]
pub enum MediaMetadataStatus {
    Pending,
    Ready,
    Unavailable { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct ExportJob {
    pub id: Uuid,
    pub project_id: Uuid,
    pub status: crate::JobStatus,
    pub progress: f64,
    pub output_path: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub error: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub error_code: Option<crate::JobFailureCode>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
