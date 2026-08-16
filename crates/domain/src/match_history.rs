use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MatchHistoryResult {
    Win,
    Loss,
    Draw,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MatchDemoStatus {
    #[default]
    Available,
    Downloading,
    Downloaded,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct SteamMatchRecord {
    pub id: String,
    pub steam_id: String,
    pub match_id: String,
    pub outcome_id: String,
    pub token: u16,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub map_name: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub played_at: Option<DateTime<Utc>>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub score: Option<String>,
    pub result: MatchHistoryResult,
    pub demo_status: MatchDemoStatus,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub demo_id: Option<Uuid>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub last_error: Option<String>,
    pub synced_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MatchHistoryQuery {
    pub steam_id: Option<String>,
    pub search: Option<String>,
    pub page: Option<u32>,
    pub page_size: Option<u32>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct MatchDownloadJob {
    pub id: Uuid,
    pub match_record_id: String,
    pub status: MatchDownloadStatus,
    pub downloaded_bytes: u64,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub total_bytes: Option<u64>,
    pub progress: f64,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub demo_id: Option<Uuid>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub error: Option<String>,
    /// The classified reason beside the free-text one — see
    /// [`crate::JobFailureCode`].
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub error_code: Option<crate::JobFailureCode>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
    use std::fmt::Debug;

    use serde::de::DeserializeOwned;

    use super::*;

    fn assert_exact_current_document<T>(document: &T)
    where
        T: Clone + Debug + DeserializeOwned + PartialEq + Serialize,
    {
        let current = serde_json::to_value(document).expect("serialize current document");
        let decoded = serde_json::from_value::<T>(current.clone()).expect("current document shape");
        assert_eq!(&decoded, document);

        let fields = current
            .as_object()
            .expect("root document object")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for field in fields {
            let mut missing = current.clone();
            missing
                .as_object_mut()
                .expect("root document object")
                .remove(&field);
            assert!(
                serde_json::from_value::<T>(missing).is_err(),
                "missing current field {field} must be rejected"
            );
        }

        let mut unknown = current;
        unknown["retired_field"] = serde_json::json!(true);
        assert!(
            serde_json::from_value::<T>(unknown).is_err(),
            "unknown root fields must be rejected"
        );
    }

    #[test]
    fn steam_match_record_accepts_only_the_complete_current_document() {
        let now = Utc::now();
        let record = SteamMatchRecord {
            id: "match-record".to_owned(),
            steam_id: "76561198000000000".to_owned(),
            match_id: "123".to_owned(),
            outcome_id: "456".to_owned(),
            token: 7,
            map_name: None,
            played_at: None,
            score: None,
            result: MatchHistoryResult::Unknown,
            demo_status: MatchDemoStatus::Available,
            demo_id: None,
            last_error: None,
            synced_at: now,
            updated_at: now,
        };

        assert_exact_current_document(&record);
    }

    #[test]
    fn match_download_job_accepts_only_the_complete_current_document() {
        let now = Utc::now();
        let job = MatchDownloadJob {
            id: Uuid::new_v4(),
            match_record_id: "match-record".to_owned(),
            status: MatchDownloadStatus::Queued,
            downloaded_bytes: 0,
            total_bytes: None,
            progress: 0.0,
            demo_id: None,
            error: None,
            error_code: None,
            created_at: now,
            updated_at: now,
        };

        assert_exact_current_document(&job);
    }
}
