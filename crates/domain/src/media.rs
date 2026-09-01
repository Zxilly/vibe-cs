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
    pub markers: Vec<crate::EditorMarker>,
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
    pub project_revision: u64,
    pub range_start_seconds: f64,
    pub range_end_seconds: f64,
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::ExportJob;

    #[test]
    fn export_job_requires_its_source_project_revision_and_render_range() {
        let mut value = json!({
            "id":"00000000-0000-4000-8000-000000000001",
            "project_id":"00000000-0000-4000-8000-000000000002",
            "status":"completed",
            "progress":1.0,
            "output_path":"C:/exports/result.mp4",
            "error":null,
            "error_code":null,
            "created_at":"2026-08-31T00:00:00Z",
            "updated_at":"2026-08-31T00:01:00Z"
        });
        assert!(serde_json::from_value::<ExportJob>(value.clone()).is_err());

        value["project_revision"] = json!(7);
        assert!(serde_json::from_value::<ExportJob>(value.clone()).is_err());
        value["range_start_seconds"] = json!(1.0);
        value["range_end_seconds"] = json!(5.0);
        let job = serde_json::from_value::<ExportJob>(value).expect("current Export Job");
        assert_eq!(job.project_revision, 7);
        assert_eq!((job.range_start_seconds, job.range_end_seconds), (1.0, 5.0));
    }
}
