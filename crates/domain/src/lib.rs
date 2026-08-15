//! Shared, transport-agnostic models for the `Vibe CS` application.

mod agent_proposal;
mod agent_session;
mod analysis;
mod analysis_run;
mod audio_intelligence;
mod config;
mod cosmetics;
mod demo;
mod editor;
mod error;
mod evidence_annotation;
mod evidence_search;
mod insights;
mod match_history;
mod recording;
mod review_metadata;
mod round_replay;

pub use agent_proposal::*;
pub use agent_session::*;
pub use analysis::*;
pub use analysis_run::*;
pub use audio_intelligence::*;
pub use config::*;
pub use cosmetics::*;
pub use demo::*;
pub use editor::*;
pub use error::*;
pub use evidence_annotation::*;
pub use evidence_search::*;
pub use insights::*;
pub use match_history::*;
pub use recording::*;
pub use review_metadata::*;
pub use round_replay::*;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: u64,
    pub page: u32,
    pub page_size: u32,
}

impl<T> Page<T> {
    #[must_use]
    pub const fn empty(page: u32, page_size: u32) -> Self {
        Self {
            items: Vec::new(),
            total: 0,
            page,
            page_size,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_empty_keeps_requested_window() {
        let page = Page::<DemoRecord>::empty(3, 48);
        assert!(page.items.is_empty());
        assert_eq!(page.total, 0);
        assert_eq!(page.page, 3);
        assert_eq!(page.page_size, 48);
    }

    #[test]
    fn config_requires_the_complete_current_shape() {
        assert!(serde_json::from_str::<AppConfig>(r#"{"locale":"en-US"}"#).is_err());
    }

    #[test]
    fn config_rejects_retired_dependency_and_recording_fields() {
        for retired in [
            serde_json::json!({ "obs": { "host": "127.0.0.1" } }),
            serde_json::json!({ "ffmpeg_path": "C:/Tools/ffmpeg.exe" }),
            serde_json::json!({ "ffprobe_path": "C:/Tools/ffprobe.exe" }),
            serde_json::json!({ "preferred_encoder": "h264_nvenc" }),
            serde_json::json!({ "hlae_path": "C:/Tools/HLAE.exe" }),
            serde_json::json!({ "recording": { "show_keyboard": true } }),
            serde_json::json!({ "recording": { "radar_restore_visible": false } }),
            serde_json::json!({ "recording": { "obs_realtime_kill_fx_media": "old.webm" } }),
            serde_json::json!({ "recording": { "capture_delay_ms": 250 } }),
        ] {
            assert!(serde_json::from_value::<AppConfig>(retired).is_err());
        }
    }

    #[test]
    fn config_debug_redacts_secrets() {
        let mut config = AppConfig::default();
        config.llm.api_key = "llm-secret".to_owned();
        config.steam.web_api_key = "steam-api-secret".to_owned();
        config.steam.authentication_code = "steam-auth-secret".to_owned();
        config.steam.known_share_code = "steam-share-secret".to_owned();

        let rendered = format!("{config:?}");
        assert!(!rendered.contains("llm-secret"));
        assert!(!rendered.contains("steam-api-secret"));
        assert!(!rendered.contains("steam-auth-secret"));
        assert!(!rendered.contains("steam-share-secret"));
        assert!(rendered.contains("[REDACTED]"));
    }

    #[test]
    fn player_stats_accept_only_the_current_kill_death_ratio_name() {
        let current = serde_json::json!({
            "steam_id": "76561197960287930",
            "spectator_slot": 7,
            "name": "FalleN",
            "team": "A",
            "kills": 18,
            "deaths": 12,
            "assists": 4,
            "headshots": 7,
            "damage": 1_640,
            "adr": 74.5,
            "kill_death_ratio": 1.5,
            "score": 36
        });
        let stats = serde_json::from_value::<PlayerStats>(current.clone())
            .expect("current player stats shape");
        assert_eq!(
            serde_json::to_value(stats).expect("serialize player stats"),
            current
        );

        let mut retired = current;
        retired["rating"] = retired["kill_death_ratio"].take();
        retired.as_object_mut().unwrap().remove("kill_death_ratio");
        assert!(serde_json::from_value::<PlayerStats>(retired).is_err());
    }

    #[test]
    fn review_metadata_has_one_bounded_contract_for_demo_player_and_round_subjects() {
        let tag_id = uuid::Uuid::new_v4();
        ReviewMetadataUpdate {
            comment: "Review the B retake".to_owned(),
            tag_ids: vec![tag_id],
        }
        .validate()
        .expect("bounded review metadata");

        assert!(
            ReviewMetadataUpdate {
                comment: "x".repeat(REVIEW_COMMENT_MAX_CHARS + 1),
                tag_ids: Vec::new(),
            }
            .validate()
            .is_err()
        );
        assert!(
            ReviewMetadataUpdate {
                comment: String::new(),
                tag_ids: vec![tag_id, tag_id],
            }
            .validate()
            .is_err()
        );

        let round = RoundReviewMetadata {
            demo_id: uuid::Uuid::new_v4(),
            source_sha256: "a".repeat(64),
            round: 13,
            comment: "Late utility".to_owned(),
            tags: Vec::new(),
            updated_at: chrono::Utc::now(),
        };
        let encoded = serde_json::to_value(&round).expect("round review metadata");
        assert_eq!(
            serde_json::from_value::<RoundReviewMetadata>(encoded)
                .expect("strict round review metadata"),
            round
        );
    }
}
