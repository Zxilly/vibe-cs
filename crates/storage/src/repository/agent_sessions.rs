//! Persistence for durable Agent conversations embedded in Projects.

use chrono::{Duration, Utc};
use rusqlite::{Connection, OptionalExtension as _, TransactionBehavior, params};
use uuid::Uuid;
use vibe_cs_domain::{
    AgentSession, AgentSessionEntry, AgentSessionEntryDraft, AgentSessionExport, AgentSessionPage,
    AgentSessionQuery, AgentSessionRetention, AgentSessionStorageStats, AgentSessionSummary,
    AgentTurnStatus, AgentTurnUpdate, AgentWorkspaceSettings, DomainError, normalize_session_title,
};

use super::{Storage, decode, encode, parse_repository_datetime};
use crate::{Result, StorageError};

const AGENT_SETTINGS_KEY: &str = "agent";

impl Storage {
    pub async fn create_agent_session(&self, title: String) -> Result<AgentSession> {
        let title = normalize_session_title(&title)?;
        self.run(move |connection| {
            let now = Utc::now();
            let session = AgentSession {
                id: Uuid::new_v4(),
                title,
                created_at: now,
                updated_at: now,
                entries: Vec::new(),
            };
            connection.execute(
                "INSERT INTO agent_sessions(id, title, title_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    session.id.to_string(),
                    session.title,
                    session.title.to_lowercase(),
                    session.created_at.to_rfc3339(),
                    session.updated_at.to_rfc3339(),
                ],
            )?;
            Ok(session)
        })
        .await
    }

    pub async fn get_agent_session(&self, id: Uuid) -> Result<Option<AgentSession>> {
        self.run(move |connection| read_session(connection, id))
            .await
    }

    pub async fn list_agent_sessions(&self, query: AgentSessionQuery) -> Result<AgentSessionPage> {
        query.validate()?;
        self.run(move |connection| {
            let search = query.q.as_deref().map(like_pattern);
            let total = connection.query_row(
                r"SELECT COUNT(*) FROM agent_sessions WHERE ?1 IS NULL OR title_key LIKE ?1 ESCAPE '\' OR EXISTS (SELECT 1 FROM agent_session_entries WHERE session_id = agent_sessions.id AND search_text LIKE ?1 ESCAPE '\')",
                params![search],
                |row| row.get::<_, i64>(0),
            )?;
            let mut statement = connection.prepare(
                r"SELECT id, title, created_at, updated_at, (SELECT COUNT(*) FROM agent_session_entries WHERE session_id = agent_sessions.id) FROM agent_sessions WHERE ?1 IS NULL OR title_key LIKE ?1 ESCAPE '\' OR EXISTS (SELECT 1 FROM agent_session_entries WHERE session_id = agent_sessions.id AND search_text LIKE ?1 ESCAPE '\') ORDER BY updated_at DESC, id LIMIT ?2",
            )?;
            let rows = statement.query_map(
                params![search, i64::from(query.effective_limit())],
                |row| {
                    Ok(AgentSessionSummary {
                        id: parse_uuid(&row.get::<_, String>(0)?)?,
                        title: row.get(1)?,
                        created_at: parse_repository_datetime(&row.get::<_, String>(2)?)?,
                        updated_at: parse_repository_datetime(&row.get::<_, String>(3)?)?,
                        entry_count: u32::try_from(row.get::<_, i64>(4)?).unwrap_or(u32::MAX),
                    })
                },
            )?;
            let items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(AgentSessionPage {
                items,
                total: u64::try_from(total).unwrap_or_default(),
            })
        })
        .await
    }

    pub async fn rename_agent_session(
        &self,
        id: Uuid,
        title: String,
    ) -> Result<Option<AgentSession>> {
        let title = normalize_session_title(&title)?;
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if transaction.execute(
                "UPDATE agent_sessions SET title = ?2, title_key = ?3, updated_at = ?4 WHERE id = ?1",
                params![
                    id.to_string(),
                    title,
                    title.to_lowercase(),
                    Utc::now().to_rfc3339(),
                ],
            )? == 0 {
                return Ok(None);
            }
            let session = read_session(&transaction, id)?;
            transaction.commit()?;
            Ok(session)
        })
        .await
    }

    pub async fn delete_agent_session(&self, id: Uuid) -> Result<bool> {
        self.run(move |connection| {
            Ok(
                connection.execute("DELETE FROM agent_sessions WHERE id = ?1", [id.to_string()])?
                    > 0,
            )
        })
        .await
    }

    pub async fn append_agent_session_entry(
        &self,
        session_id: Uuid,
        draft: AgentSessionEntryDraft,
    ) -> Result<Option<AgentSessionEntry>> {
        let draft = draft.normalize()?;
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if !session_exists(&transaction, session_id)? {
                return Ok(None);
            }
            let at = Utc::now();
            let entry = match draft {
                AgentSessionEntryDraft::User { content } => AgentSessionEntry::User {
                    id: Uuid::new_v4(),
                    at,
                    content,
                },
                AgentSessionEntryDraft::ToolDecision {
                    tool_call_id,
                    decision,
                    content,
                } => AgentSessionEntry::ToolDecision {
                    id: Uuid::new_v4(),
                    at,
                    tool_call_id,
                    decision,
                    content,
                },
                AgentSessionEntryDraft::Assistant {
                    content,
                    tool_calls,
                    status,
                    request_id,
                    retry_of,
                    error,
                    metadata,
                } => AgentSessionEntry::Assistant {
                    id: Uuid::new_v4(),
                    at,
                    content,
                    tool_calls,
                    status,
                    request_id,
                    retry_of,
                    error,
                    metadata,
                },
            };
            append_entry(&transaction, session_id, &entry)?;
            touch_session(&transaction, session_id)?;
            transaction.commit()?;
            Ok(Some(entry))
        })
        .await
    }

    pub async fn update_agent_turn(
        &self,
        session_id: Uuid,
        entry_id: Uuid,
        update: AgentTurnUpdate,
    ) -> Result<Option<AgentSessionEntry>> {
        let update = update.normalize()?;
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if !session_exists(&transaction, session_id)? {
                return Ok(None);
            }
            let mut statement = transaction.prepare(
                "SELECT sequence, document_json FROM agent_session_entries WHERE session_id = ?1 AND kind = 'assistant' ORDER BY sequence",
            )?;
            let rows = statement
                .query_map([session_id.to_string()], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);
            let (sequence, entry) = rows
                .into_iter()
                .map(|(sequence, json)| Ok((sequence, decode::<AgentSessionEntry>(&json)?)))
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .find(|(_, entry)| entry.id() == entry_id)
                .ok_or_else(|| StorageError::Domain(DomainError::NotFound("agent turn".to_owned())))?;
            let AgentSessionEntry::Assistant {
                id,
                at,
                status,
                request_id,
                retry_of,
                ..
            } = entry else {
                return Err(StorageError::Domain(DomainError::InvalidInput(
                    "agent turn is not an assistant entry".to_owned(),
                )));
            };
            let current = status.unwrap_or(AgentTurnStatus::Completed);
            if current != update.expected_status {
                return Err(StorageError::Domain(DomainError::Conflict(format!(
                    "agent turn is {current:?}, not {:?}",
                    update.expected_status
                ))));
            }
            let next = AgentSessionEntry::Assistant {
                id,
                at,
                content: update.content,
                tool_calls: update.tool_calls,
                status: Some(update.status),
                request_id,
                retry_of,
                error: update.error,
                metadata: update.metadata,
            };
            transaction.execute(
                "UPDATE agent_session_entries SET search_text = ?3, document_json = ?4 WHERE session_id = ?1 AND sequence = ?2",
                params![
                    session_id.to_string(),
                    sequence,
                    next.search_text(),
                    encode(&next)?,
                ],
            )?;
            touch_session(&transaction, session_id)?;
            transaction.commit()?;
            Ok(Some(next))
        })
        .await
    }

    pub async fn get_agent_workspace_settings(&self) -> Result<AgentWorkspaceSettings> {
        self.run(|connection| read_agent_settings(connection)).await
    }

    pub async fn set_agent_workspace_settings(
        &self,
        settings: AgentWorkspaceSettings,
    ) -> Result<AgentWorkspaceSettings> {
        settings.validate()?;
        self.run(move |connection| {
            connection.execute(
                "INSERT INTO app_config(key, document_json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET document_json = excluded.document_json, updated_at = excluded.updated_at",
                params![AGENT_SETTINGS_KEY, encode(&settings)?, Utc::now().to_rfc3339()],
            )?;
            Ok(settings)
        })
        .await
    }

    pub async fn apply_agent_session_retention(&self) -> Result<u64> {
        let settings = self.get_agent_workspace_settings().await?;
        self.run(move |connection| match settings.session_retention {
            AgentSessionRetention::All => Ok(0),
            AgentSessionRetention::None => {
                Ok(u64::try_from(connection.execute("DELETE FROM agent_sessions", [])?)
                    .unwrap_or_default())
            }
            AgentSessionRetention::RecentCount { count } => {
                let removed = connection.execute(
                    "DELETE FROM agent_sessions WHERE id NOT IN (SELECT id FROM agent_sessions ORDER BY updated_at DESC, id LIMIT ?1)",
                    [i64::from(count)],
                )?;
                Ok(u64::try_from(removed).unwrap_or_default())
            }
            AgentSessionRetention::MaxAgeDays { days } => {
                let cutoff = Utc::now() - Duration::days(i64::from(days));
                let removed = connection.execute(
                    "DELETE FROM agent_sessions WHERE updated_at < ?1",
                    [cutoff.to_rfc3339()],
                )?;
                Ok(u64::try_from(removed).unwrap_or_default())
            }
        })
        .await
    }

    pub async fn agent_session_storage_stats(&self) -> Result<AgentSessionStorageStats> {
        self.run(|connection| {
            let (session_count, title_bytes, oldest, newest) = connection.query_row(
                "SELECT COUNT(*), COALESCE(SUM(LENGTH(CAST(title AS BLOB))), 0), MIN(updated_at), MAX(updated_at) FROM agent_sessions",
                [],
                |row| Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                )),
            )?;
            let (entry_count, entry_bytes) = connection.query_row(
                "SELECT COUNT(*), COALESCE(SUM(LENGTH(CAST(document_json AS BLOB))), 0) FROM agent_session_entries",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )?;
            Ok(AgentSessionStorageStats {
                session_count: unsigned(session_count),
                entry_count: unsigned(entry_count),
                conversation_bytes: unsigned(title_bytes).saturating_add(unsigned(entry_bytes)),
                oldest_session_at: oldest
                    .as_deref()
                    .map(parse_repository_datetime)
                    .transpose()?,
                newest_session_at: newest
                    .as_deref()
                    .map(parse_repository_datetime)
                    .transpose()?,
            })
        })
        .await
    }

    pub async fn export_agent_sessions(&self) -> Result<AgentSessionExport> {
        self.run(|connection| {
            let mut statement =
                connection.prepare("SELECT id FROM agent_sessions ORDER BY updated_at DESC, id")?;
            let ids = statement
                .query_map([], |row| parse_uuid(&row.get::<_, String>(0)?))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let sessions = ids
                .into_iter()
                .map(|id| read_session(connection, id))
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .flatten()
                .collect();
            Ok(AgentSessionExport {
                exported_at: Utc::now(),
                settings: read_agent_settings(connection)?,
                sessions,
            })
        })
        .await
    }

    pub async fn clear_agent_sessions(&self) -> Result<u64> {
        self.run(|connection| {
            Ok(
                u64::try_from(connection.execute("DELETE FROM agent_sessions", [])?)
                    .unwrap_or_default(),
            )
        })
        .await
    }
}

fn session_exists(connection: &Connection, id: Uuid) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_sessions WHERE id = ?1)",
        [id.to_string()],
        |row| row.get::<_, bool>(0),
    )?)
}

fn touch_session(connection: &Connection, id: Uuid) -> Result<()> {
    connection.execute(
        "UPDATE agent_sessions SET updated_at = ?2 WHERE id = ?1",
        params![id.to_string(), Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

fn append_entry(
    connection: &Connection,
    session_id: Uuid,
    entry: &AgentSessionEntry,
) -> Result<()> {
    let sequence = connection.query_row(
        "SELECT COALESCE(MAX(sequence), -1) + 1 FROM agent_session_entries WHERE session_id = ?1",
        [session_id.to_string()],
        |row| row.get::<_, i64>(0),
    )?;
    connection.execute(
        "INSERT INTO agent_session_entries(session_id, sequence, kind, created_at, search_text, document_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            session_id.to_string(),
            sequence,
            match entry {
                AgentSessionEntry::User { .. } => "user",
                AgentSessionEntry::ToolDecision { .. } => "tool_decision",
                AgentSessionEntry::Assistant { .. } => "assistant",
            },
            entry.at().to_rfc3339(),
            entry.search_text(),
            encode(entry)?,
        ],
    )?;
    Ok(())
}

fn read_session(connection: &Connection, id: Uuid) -> Result<Option<AgentSession>> {
    let header = connection
        .query_row(
            "SELECT title, created_at, updated_at FROM agent_sessions WHERE id = ?1",
            [id.to_string()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((title, created_at, updated_at)) = header else {
        return Ok(None);
    };
    let mut statement = connection.prepare(
        "SELECT document_json FROM agent_session_entries WHERE session_id = ?1 ORDER BY sequence",
    )?;
    let rows = statement.query_map([id.to_string()], |row| row.get::<_, String>(0))?;
    let mut entries = Vec::new();
    for row in rows {
        entries.push(decode(&row?)?);
    }
    Ok(Some(AgentSession {
        id,
        title,
        created_at: parse_repository_datetime(&created_at)?,
        updated_at: parse_repository_datetime(&updated_at)?,
        entries,
    }))
}

fn read_agent_settings(connection: &Connection) -> Result<AgentWorkspaceSettings> {
    let json = connection
        .query_row(
            "SELECT document_json FROM app_config WHERE key = ?1",
            [AGENT_SETTINGS_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    json.map_or_else(
        || Ok(AgentWorkspaceSettings::default()),
        |json| decode(&json),
    )
}

fn like_pattern(value: &str) -> String {
    format!(
        "%{}%",
        value
            .to_lowercase()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}

fn parse_uuid(value: &str) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            value.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn unsigned(value: i64) -> u64 {
    u64::try_from(value).unwrap_or_default()
}
