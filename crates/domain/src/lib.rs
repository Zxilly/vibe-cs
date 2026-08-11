//! Shared, transport-agnostic models for the `Vibe CS` application.

mod agent_proposal;
mod analysis;
mod audio_intelligence;
mod config;
mod cosmetics;
mod demo;
mod editor;
mod error;
mod insights;
mod match_history;
mod recording;

pub use agent_proposal::*;
pub use analysis::*;
pub use audio_intelligence::*;
pub use config::*;
pub use cosmetics::*;
pub use demo::*;
pub use editor::*;
pub use error::*;
pub use insights::*;
pub use match_history::*;
pub use recording::*;

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
    fn config_deserializes_missing_fields_from_defaults() {
        let config: AppConfig = serde_json::from_str(r#"{"locale":"en-US"}"#).unwrap();
        assert_eq!(config.locale, "en-US");
        assert_eq!(config.obs.port, 4455);
        assert_eq!(config.recording.fps, 60);
    }

    #[test]
    fn config_debug_redacts_secrets() {
        let mut config = AppConfig::default();
        config.obs.password = "obs-secret".to_owned();
        config.llm.api_key = "llm-secret".to_owned();
        config.steam.web_api_key = "steam-api-secret".to_owned();
        config.steam.authentication_code = "steam-auth-secret".to_owned();
        config.steam.known_share_code = "steam-share-secret".to_owned();

        let rendered = format!("{config:?}");
        assert!(!rendered.contains("obs-secret"));
        assert!(!rendered.contains("llm-secret"));
        assert!(!rendered.contains("steam-api-secret"));
        assert!(!rendered.contains("steam-auth-secret"));
        assert!(!rendered.contains("steam-share-secret"));
        assert!(rendered.contains("[REDACTED]"));
    }
}
