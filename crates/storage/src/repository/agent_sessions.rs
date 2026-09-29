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
            let AgentSessionEntryDraft::ToolDecision {
                tool_call_id,
                decision,
                content,
            } = draft;
            let entry = AgentSessionEntry::ToolDecision {
                id: Uuid::new_v4(),
                at,
                tool_call_id,
                decision,
                content,
            };
            append_entry(&transaction, session_id, &entry)?;
            touch_session(&transaction, session_id)?;
            transaction.commit()?;
            Ok(Some(entry))
        })
        .await
    }

    /// Starts one host-owned turn. Its request and placeholder are always adjacent and atomic.
    pub async fn begin_agent_turn(
        &self,
        session_id: Uuid,
        request_id: Uuid,
        message: String,
        retry_of: Option<Uuid>,
    ) -> Result<AgentSessionEntry> {
        let message = message.trim().to_owned();
        if message.is_empty() || message.chars().count() > 8_000 {
            return Err(StorageError::Domain(DomainError::InvalidInput(
                "agent message must contain 1 to 8000 characters".to_owned(),
            )));
        }
        self.run(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let session = read_session(&transaction, session_id)?.ok_or_else(|| StorageError::Domain(DomainError::NotFound("agent session".to_owned())))?;
            if session.entries.iter().any(|entry| matches!(entry, AgentSessionEntry::Assistant {request_id:Some(id),..} if *id == request_id)) {
                return Err(StorageError::Domain(DomainError::Conflict("Agent request already exists".to_owned())));
            }
            if retry_of.is_some_and(|id| !session.entries.iter().any(|entry| matches!(entry, AgentSessionEntry::Assistant {id:candidate,status:Some(AgentTurnStatus::Failed | AgentTurnStatus::Cancelled),..} if *candidate == id))) {
                return Err(StorageError::Domain(DomainError::InvalidInput("retry must refer to a failed or cancelled turn in this session".to_owned())));
            }
            let at = Utc::now();
            let user = AgentSessionEntry::User {id:Uuid::new_v4(), at, content:message};
            let turn = AgentSessionEntry::Assistant {
                id:Uuid::new_v4(), at, content:String::new(), tool_calls:Vec::new(),
                status:Some(AgentTurnStatus::Streaming), request_id:Some(request_id), retry_of,
                error:None, metadata:None,
            };
            append_entry(&transaction, session_id, &user)?;
            append_entry(&transaction, session_id, &turn)?;
            touch_session(&transaction, session_id)?;
            transaction.commit()?;
            Ok(turn)
        }).await
    }

    pub async fn finish_agent_turn(
        &self,
        session_id: Uuid,
        request_id: Uuid,
        entry_id: Uuid,
        update: AgentTurnUpdate,
    ) -> Result<Option<AgentSessionEntry>> {
        let update = update.normalize()?;
        if !matches!(
            update.status,
            AgentTurnStatus::Completed | AgentTurnStatus::Failed | AgentTurnStatus::Cancelled
        ) {
            return Err(StorageError::Domain(DomainError::InvalidInput(
                "Agent turn must finish in a terminal state".to_owned(),
            )));
        }
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if !session_exists(&transaction, session_id)? {
                release_turn_lease(&transaction, session_id, request_id)?;
                transaction.commit()?;
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
                request_id: stored_request_id,
                retry_of,
                ..
            } = entry else {
                return Err(StorageError::Domain(DomainError::InvalidInput(
                    "agent turn is not an assistant entry".to_owned(),
                )));
            };
            if stored_request_id != Some(request_id) {
                return Err(StorageError::Domain(DomainError::Conflict("Agent turn belongs to a different request".to_owned())));
            }
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
                request_id: Some(request_id),
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
            release_turn_lease(&transaction, session_id, request_id)?;
            touch_session(&transaction, session_id)?;
            transaction.commit()?;
            Ok(Some(next))
        })
        .await
    }

    pub async fn release_agent_turn_lease(&self, session_id: Uuid, request_id: Uuid) -> Result<()> {
        self.run(move |connection| release_turn_lease(connection, session_id, request_id))
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

fn release_turn_lease(connection: &Connection, session_id: Uuid, request_id: Uuid) -> Result<()> {
    connection.execute(
        "DELETE FROM project_edit_leases WHERE session_id = ?1 AND turn_id = ?2",
        params![session_id.to_string(), request_id.to_string()],
    )?;
    Ok(())
}

pub(super) fn recover_interrupted_turns(connection: &mut Connection) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut statement = transaction.prepare("SELECT session_id, sequence, document_json FROM agent_session_entries WHERE kind = 'assistant'")?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    for (session_id, sequence, document) in rows {
        let mut entry: AgentSessionEntry = decode(&document)?;
        if let AgentSessionEntry::Assistant { status, error, .. } = &mut entry
            && matches!(
                status,
                Some(AgentTurnStatus::Pending | AgentTurnStatus::Streaming)
            )
        {
            *status = Some(AgentTurnStatus::Cancelled);
            *error = Some("Agent turn was interrupted when the application stopped".to_owned());
            transaction.execute("UPDATE agent_session_entries SET document_json = ?3 WHERE session_id = ?1 AND sequence = ?2",params![session_id,sequence,encode(&entry)?])?;
        }
    }
    transaction.execute("DELETE FROM project_edit_leases", [])?;
    transaction.commit()?;
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn terminal(status: AgentTurnStatus) -> AgentTurnUpdate {
        AgentTurnUpdate {
            expected_status: AgentTurnStatus::Streaming,
            status,
            content: "saved partial text".to_owned(),
            tool_calls: Vec::new(),
            error: None,
            metadata: None,
        }
    }

    #[tokio::test]
    async fn host_turn_start_is_atomic_and_retry_is_session_owned() {
        let storage = Storage::open_in_memory().await.unwrap();
        let session = storage
            .create_agent_session("Session".to_owned())
            .await
            .unwrap();
        storage.run(|connection| {
            connection.execute_batch("CREATE TEMP TRIGGER fail_agent_placeholder BEFORE INSERT ON agent_session_entries WHEN NEW.kind = 'assistant' BEGIN SELECT RAISE(ABORT, 'test placeholder failure'); END;")?;
            Ok(())
        }).await.unwrap();
        assert!(
            storage
                .begin_agent_turn(session.id, Uuid::new_v4(), "hello".to_owned(), None)
                .await
                .is_err()
        );
        assert!(
            storage
                .get_agent_session(session.id)
                .await
                .unwrap()
                .unwrap()
                .entries
                .is_empty()
        );
        storage
            .run(|connection| {
                connection.execute_batch("DROP TRIGGER fail_agent_placeholder")?;
                Ok(())
            })
            .await
            .unwrap();
        let request = Uuid::new_v4();
        let turn = storage
            .begin_agent_turn(session.id, request, "hello".to_owned(), None)
            .await
            .unwrap();
        let entries = storage
            .get_agent_session(session.id)
            .await
            .unwrap()
            .unwrap()
            .entries;
        assert!(matches!(
            &entries[..],
            [
                AgentSessionEntry::User { .. },
                AgentSessionEntry::Assistant { .. }
            ]
        ));
        assert!(
            storage
                .begin_agent_turn(session.id, request, "duplicate".to_owned(), None)
                .await
                .is_err()
        );
        assert!(
            storage
                .begin_agent_turn(
                    session.id,
                    Uuid::new_v4(),
                    "retry".to_owned(),
                    Some(turn.id())
                )
                .await
                .is_err()
        );
        storage
            .finish_agent_turn(
                session.id,
                request,
                turn.id(),
                terminal(AgentTurnStatus::Failed),
            )
            .await
            .unwrap();
        storage
            .begin_agent_turn(
                session.id,
                Uuid::new_v4(),
                "retry".to_owned(),
                Some(turn.id()),
            )
            .await
            .unwrap();
        assert_eq!(
            storage
                .get_agent_session(session.id)
                .await
                .unwrap()
                .unwrap()
                .entries
                .len(),
            4
        );
    }

    #[tokio::test]
    async fn deleted_session_is_not_recreated_by_a_late_terminal_write() {
        let storage = Storage::open_in_memory().await.unwrap();
        let session = storage
            .create_agent_session("deleted".to_owned())
            .await
            .unwrap();
        let request = Uuid::new_v4();
        let turn = storage
            .begin_agent_turn(session.id, request, "hello".to_owned(), None)
            .await
            .unwrap();
        let project_id = Uuid::new_v4();
        storage.run(move |connection| {
            connection.execute("INSERT INTO projects(id,name,revision,document_json,created_at,updated_at) VALUES (?1,'test',1,'{}','2026-09-30T00:00:00Z','2026-09-30T00:00:00Z')",[project_id.to_string()])?;
            connection.execute("INSERT INTO project_edit_leases(project_id,id,session_id,turn_id,base_revision,acquired_at,heartbeat_at) VALUES (?1,?2,?3,?4,1,?5,?5)",params![project_id.to_string(),Uuid::new_v4().to_string(),session.id.to_string(),request.to_string(),Utc::now().to_rfc3339()])?;
            Ok(())
        }).await.unwrap();
        storage.delete_agent_session(session.id).await.unwrap();
        assert!(
            storage
                .finish_agent_turn(
                    session.id,
                    request,
                    turn.id(),
                    terminal(AgentTurnStatus::Cancelled)
                )
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            storage
                .get_agent_session(session.id)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn reopening_storage_terminalizes_interrupted_host_turns() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agent.db");
        let storage = Storage::open(&path).await.unwrap();
        let session = storage
            .create_agent_session("Session".to_owned())
            .await
            .unwrap();
        storage
            .begin_agent_turn(session.id, Uuid::new_v4(), "unfinished".to_owned(), None)
            .await
            .unwrap();
        drop(storage);
        let reopened = Storage::open(&path).await.unwrap();
        let entries = reopened
            .get_agent_session(session.id)
            .await
            .unwrap()
            .unwrap()
            .entries;
        assert!(matches!(
            &entries[1],
            AgentSessionEntry::Assistant {
                status: Some(AgentTurnStatus::Cancelled),
                error: Some(_),
                ..
            }
        ));
    }

    #[tokio::test]
    async fn terminal_failure_rolls_back_turn_and_lease_then_retry_commits_both() {
        let storage = Storage::open_in_memory().await.unwrap();
        let session = storage
            .create_agent_session("Session".to_owned())
            .await
            .unwrap();
        let request = Uuid::new_v4();
        let turn = storage
            .begin_agent_turn(session.id, request, "hello".to_owned(), None)
            .await
            .unwrap();
        let project_id = Uuid::new_v4();
        storage.run(move |connection| {
            connection.execute("INSERT INTO projects(id,name,revision,document_json,created_at,updated_at) VALUES (?1,'test',1,'{}','2026-09-30T00:00:00Z','2026-09-30T00:00:00Z')",[project_id.to_string()])?;
            connection.execute("INSERT INTO project_edit_leases(project_id,id,session_id,turn_id,base_revision,acquired_at,heartbeat_at) VALUES (?1,?2,?3,?4,1,?5,?5)",params![project_id.to_string(),Uuid::new_v4().to_string(),session.id.to_string(),request.to_string(),Utc::now().to_rfc3339()])?;
            connection.execute_batch("CREATE TEMP TRIGGER fail_agent_finish BEFORE UPDATE ON agent_session_entries BEGIN SELECT RAISE(ABORT,'test terminal failure'); END;")?;
            Ok(())
        }).await.unwrap();
        assert!(
            storage
                .finish_agent_turn(
                    session.id,
                    request,
                    turn.id(),
                    terminal(AgentTurnStatus::Completed)
                )
                .await
                .is_err()
        );
        assert!(
            storage
                .get_project_edit_lease(project_id)
                .await
                .unwrap()
                .is_some()
        );
        assert!(matches!(
            &storage
                .get_agent_session(session.id)
                .await
                .unwrap()
                .unwrap()
                .entries[1],
            AgentSessionEntry::Assistant {
                status: Some(AgentTurnStatus::Streaming),
                ..
            }
        ));
        storage
            .run(|connection| {
                connection.execute_batch("DROP TRIGGER fail_agent_finish")?;
                Ok(())
            })
            .await
            .unwrap();
        storage
            .finish_agent_turn(
                session.id,
                request,
                turn.id(),
                terminal(AgentTurnStatus::Completed),
            )
            .await
            .unwrap();
        assert!(
            storage
                .get_project_edit_lease(project_id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(matches!(
            &storage
                .get_agent_session(session.id)
                .await
                .unwrap()
                .unwrap()
                .entries[1],
            AgentSessionEntry::Assistant {
                status: Some(AgentTurnStatus::Completed),
                ..
            }
        ));
    }
}
