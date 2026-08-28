use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
use uuid::Uuid;

use crate::{DomainError, HlaeCameraStyle};

pub const AGENT_SESSION_MAX_TITLE_CHARS: usize = 200;
const AGENT_SESSION_MAX_CONTENT_CHARS: usize = 32_000;
const AGENT_SESSION_MAX_QUERY_CHARS: usize = 200;
const AGENT_SESSION_MAX_TOOL_CALLS: usize = 256;

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
pub struct AgentToolCall {
    pub name: String,
    pub input: Value,
    pub output: Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AgentTurnStatus {
    Pending,
    Streaming,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentTurnMetadata {
    pub provider: String,
    pub model: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub input_tokens: Option<u64>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub output_tokens: Option<u64>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub total_tokens: Option<u64>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub cached_input_tokens: Option<u64>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub reasoning_tokens: Option<u64>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub estimated_cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum AgentSessionEntry {
    User {
        id: Uuid,
        at: DateTime<Utc>,
        content: String,
    },
    Assistant {
        id: Uuid,
        at: DateTime<Utc>,
        content: String,
        tool_calls: Vec<AgentToolCall>,
        #[serde(deserialize_with = "deserialize_required_nullable")]
        status: Option<AgentTurnStatus>,
        #[serde(deserialize_with = "deserialize_required_nullable")]
        request_id: Option<Uuid>,
        #[serde(deserialize_with = "deserialize_required_nullable")]
        retry_of: Option<Uuid>,
        #[serde(deserialize_with = "deserialize_required_nullable")]
        error: Option<String>,
        #[serde(deserialize_with = "deserialize_required_nullable")]
        metadata: Option<Box<AgentTurnMetadata>>,
    },
}

impl AgentSessionEntry {
    #[must_use]
    pub const fn id(&self) -> Uuid {
        match self {
            Self::User { id, .. } | Self::Assistant { id, .. } => *id,
        }
    }

    #[must_use]
    pub const fn at(&self) -> DateTime<Utc> {
        match self {
            Self::User { at, .. } | Self::Assistant { at, .. } => *at,
        }
    }

    #[must_use]
    pub fn search_text(&self) -> String {
        match self {
            Self::User { content, .. } | Self::Assistant { content, .. } => content.to_lowercase(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum AgentSessionEntryDraft {
    User {
        content: String,
    },
    Assistant {
        content: String,
        tool_calls: Vec<AgentToolCall>,
        #[serde(deserialize_with = "deserialize_required_nullable")]
        status: Option<AgentTurnStatus>,
        #[serde(deserialize_with = "deserialize_required_nullable")]
        request_id: Option<Uuid>,
        #[serde(deserialize_with = "deserialize_required_nullable")]
        retry_of: Option<Uuid>,
        #[serde(deserialize_with = "deserialize_required_nullable")]
        error: Option<String>,
        #[serde(deserialize_with = "deserialize_required_nullable")]
        metadata: Option<Box<AgentTurnMetadata>>,
    },
}

impl AgentSessionEntryDraft {
    /// Normalizes one untrusted session entry before persistence.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when content or tool calls exceed the current bounds.
    pub fn normalize(mut self) -> Result<Self, DomainError> {
        match &mut self {
            Self::User { content } => {
                *content = content.trim().to_owned();
                if content.chars().count() > AGENT_SESSION_MAX_CONTENT_CHARS {
                    return Err(invalid("agent entry content is too long"));
                }
            }
            Self::Assistant {
                content,
                tool_calls,
                error,
                ..
            } => {
                *content = content.trim().to_owned();
                if content.chars().count() > AGENT_SESSION_MAX_CONTENT_CHARS {
                    return Err(invalid("agent entry content is too long"));
                }
                if tool_calls.len() > AGENT_SESSION_MAX_TOOL_CALLS {
                    return Err(invalid("agent entry has too many tool calls"));
                }
                for call in tool_calls {
                    if call.name.trim().is_empty() || call.name.len() > 128 {
                        return Err(invalid("agent tool call name is invalid"));
                    }
                }
                if let Some(error) = error {
                    *error = error.trim().chars().take(2_000).collect();
                }
            }
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentTurnUpdate {
    pub expected_status: AgentTurnStatus,
    pub status: AgentTurnStatus,
    pub content: String,
    pub tool_calls: Vec<AgentToolCall>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub error: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub metadata: Option<Box<AgentTurnMetadata>>,
}

impl AgentTurnUpdate {
    /// Normalizes one conditional Assistant-turn update.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when content or tool calls exceed the current bounds.
    pub fn normalize(self) -> Result<Self, DomainError> {
        let draft = AgentSessionEntryDraft::Assistant {
            content: self.content,
            tool_calls: self.tool_calls,
            status: Some(self.status),
            request_id: None,
            retry_of: None,
            error: self.error,
            metadata: self.metadata,
        }
        .normalize()?;
        let AgentSessionEntryDraft::Assistant {
            content,
            tool_calls,
            error,
            metadata,
            ..
        } = draft
        else {
            unreachable!()
        };
        Ok(Self {
            expected_status: self.expected_status,
            status: self.status,
            content,
            tool_calls,
            error,
            metadata,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentSession {
    pub id: Uuid,
    pub title: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub entries: Vec<AgentSessionEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentSessionSummary {
    pub id: Uuid,
    pub title: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub entry_count: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentSessionQuery {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub q: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
}

impl AgentSessionQuery {
    /// Validates bounded session list filters.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when the search text is too long.
    pub fn validate(&self) -> Result<(), DomainError> {
        if self
            .q
            .as_deref()
            .is_some_and(|q| q.chars().count() > AGENT_SESSION_MAX_QUERY_CHARS)
        {
            return Err(invalid("agent session query is too long"));
        }
        Ok(())
    }

    #[must_use]
    pub fn effective_limit(&self) -> u32 {
        self.limit.unwrap_or(50).clamp(1, 200)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentSessionPage {
    pub items: Vec<AgentSessionSummary>,
    pub total: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(tag = "mode", rename_all = "snake_case")]
#[ts(export)]
pub enum AgentSessionRetention {
    All,
    RecentCount { count: u32 },
    MaxAgeDays { days: u32 },
    None,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CommentaryTone {
    Professional,
    Broadcast,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentWorkspaceSettings {
    pub session_retention: AgentSessionRetention,
    pub show_evidence_reads: bool,
    pub default_video_seconds: u32,
    pub default_camera_style: HlaeCameraStyle,
    pub commentary_tone: CommentaryTone,
}

impl Default for AgentWorkspaceSettings {
    fn default() -> Self {
        Self {
            session_retention: AgentSessionRetention::RecentCount { count: 50 },
            show_evidence_reads: true,
            default_video_seconds: 180,
            default_camera_style: HlaeCameraStyle::Pov,
            commentary_tone: CommentaryTone::Professional,
        }
    }
}

impl AgentWorkspaceSettings {
    /// Validates current Agent workspace settings.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::InvalidInput`] when retention or duration is out of range.
    pub fn validate(&self) -> Result<(), DomainError> {
        match self.session_retention {
            AgentSessionRetention::RecentCount { count } if !(1..=10_000).contains(&count) => {
                return Err(invalid("agent session retention count is out of range"));
            }
            AgentSessionRetention::MaxAgeDays { days } if !(1..=3_650).contains(&days) => {
                return Err(invalid("agent session retention age is out of range"));
            }
            _ => {}
        }
        if !(5..=3_600).contains(&self.default_video_seconds) {
            return Err(invalid("default video duration is out of range"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentSessionStorageStats {
    pub session_count: u64,
    pub entry_count: u64,
    pub conversation_bytes: u64,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub oldest_session_at: Option<DateTime<Utc>>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub newest_session_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentSessionExport {
    pub exported_at: DateTime<Utc>,
    pub settings: AgentWorkspaceSettings,
    pub sessions: Vec<AgentSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct AgentSessionPurge {
    pub removed_sessions: u64,
}

/// Normalizes one Agent session title.
///
/// # Errors
///
/// Returns [`DomainError::InvalidInput`] when the trimmed title is empty or too long.
pub fn normalize_session_title(value: &str) -> Result<String, DomainError> {
    let title = value.trim();
    if title.is_empty() || title.chars().count() > AGENT_SESSION_MAX_TITLE_CHARS {
        return Err(invalid("agent session title is invalid"));
    }
    Ok(title.to_owned())
}

fn invalid(message: &str) -> DomainError {
    DomainError::InvalidInput(message.to_owned())
}
