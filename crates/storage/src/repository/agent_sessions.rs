//! Agent sessions, the bidirectional session/object reference index and the
//! server-authoritative plan revision.
//!
//! Three rules are enforced here rather than in the presentation layer:
//!
//! 1. Deleting a session deletes the conversation only. Plans, recording jobs,
//!    editor projects and outputs it touched are never cascaded into, and the
//!    plan origin trail keeps the deleted session's identity and title.
//! 2. `agent_plans.revision` is owned by `SQLite`. Every edit is conditional on
//!    the caller's base revision inside one immediate transaction, so two
//!    sessions editing the same plan cannot silently overwrite each other.
//! 3. A `workspace_edit` session entry is produced by the authoritative plan
//!    write itself and carries the revision that write produced.

use chrono::{DateTime, Duration, Utc};
use rusqlite::{Connection, OptionalExtension as _, Transaction, TransactionBehavior, params};
use uuid::Uuid;
use vibe_cs_domain::{
    AgentObjectKind, AgentObjectLocator, AgentObjectRef, AgentObjectRefTouch,
    AgentObjectSessionRef, AgentPlan, AgentPlanBaseline, AgentPlanCreate, AgentPlanEdit,
    AgentPlanOrigin, AgentPlanOriginDraft, AgentPlanQuery, AgentPlanRestore, AgentPlanShot,
    AgentPlanStatus, AgentPlanSummary, AgentPlanUpdate, AgentSession, AgentSessionEntry,
    AgentSessionEntryDraft, AgentSessionExport, AgentSessionPage, AgentSessionQuery,
    AgentSessionRetention, AgentSessionStorageStats, AgentSessionSummary, AgentWorkspaceSettings,
    DomainError, WorkspaceEditAuthor, WorkspaceEditNotice, normalize_session_title,
};

use super::{Storage, decode, encode, parse_repository_datetime};
use crate::{Result, StorageError};

/// `app_config` key holding the Agent workspace settings document.
const AGENT_SETTINGS_KEY: &str = "agent";

impl Storage {
    /// Creates one conversation thread. It neither inherits nor locks any task.
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
                refs: Vec::new(),
            };
            connection.execute(
                "INSERT INTO agent_sessions(id, title, title_key, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
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

    /// Reads one exact session with its ordered entries and current references.
    pub async fn get_agent_session(&self, id: Uuid) -> Result<Option<AgentSession>> {
        self.run(move |connection| read_session(connection, id))
            .await
    }

    /// Lists sessions for the drawer, newest first, with the objects each one
    /// touched. `q` matches the session title and its conversation text.
    pub async fn list_agent_sessions(&self, query: AgentSessionQuery) -> Result<AgentSessionPage> {
        query.validate()?;
        self.run(move |connection| {
            let limit = i64::from(query.effective_limit());
            let search = query.q.as_deref().map(like_pattern);
            let total = connection.query_row(
                "SELECT COUNT(*) FROM agent_sessions \
                 WHERE ?1 IS NULL OR title_key LIKE ?1 ESCAPE '\\' OR EXISTS ( \
                     SELECT 1 FROM agent_session_entries \
                     WHERE agent_session_entries.session_id = agent_sessions.id \
                       AND agent_session_entries.search_text LIKE ?1 ESCAPE '\\' \
                 )",
                params![search],
                |row| row.get::<_, i64>(0),
            )?;
            let mut statement = connection.prepare(
                "SELECT id, title, created_at, updated_at, \
                    (SELECT COUNT(*) FROM agent_session_entries \
                     WHERE agent_session_entries.session_id = agent_sessions.id) \
                 FROM agent_sessions \
                 WHERE ?1 IS NULL OR title_key LIKE ?1 ESCAPE '\\' OR EXISTS ( \
                     SELECT 1 FROM agent_session_entries \
                     WHERE agent_session_entries.session_id = agent_sessions.id \
                       AND agent_session_entries.search_text LIKE ?1 ESCAPE '\\' \
                 ) \
                 ORDER BY updated_at DESC, id \
                 LIMIT ?2",
            )?;
            let rows = statement
                .query_map(params![search, limit], |row| {
                    Ok((
                        parse_uuid(&row.get::<_, String>(0)?)?,
                        row.get::<_, String>(1)?,
                        parse_repository_datetime(&row.get::<_, String>(2)?)?,
                        parse_repository_datetime(&row.get::<_, String>(3)?)?,
                        row.get::<_, i64>(4)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut items = Vec::with_capacity(rows.len());
            for (id, title, created_at, updated_at, entry_count) in rows {
                items.push(AgentSessionSummary {
                    id,
                    title,
                    created_at,
                    updated_at,
                    entry_count: u32::try_from(entry_count).unwrap_or(u32::MAX),
                    refs: read_session_refs(connection, id)?,
                });
            }
            Ok(AgentSessionPage {
                items,
                total: u64::try_from(total).unwrap_or_default(),
            })
        })
        .await
    }

    /// Renames one exact session. Renaming never touches referenced objects.
    pub async fn rename_agent_session(
        &self,
        id: Uuid,
        title: String,
    ) -> Result<Option<AgentSession>> {
        let title = normalize_session_title(&title)?;
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let changed = transaction.execute(
                "UPDATE agent_sessions SET title = ?2, title_key = ?3, updated_at = ?4 \
                 WHERE id = ?1",
                params![
                    id.to_string(),
                    title,
                    title.to_lowercase(),
                    Utc::now().to_rfc3339(),
                ],
            )?;
            if changed == 0 {
                return Ok(None);
            }
            let session = read_session(&transaction, id)?;
            transaction.commit()?;
            Ok(session)
        })
        .await
    }

    /// Deletes one conversation thread.
    ///
    /// This removes the session, its entries and its reference rows. It never
    /// reaches the referenced plans, recording jobs, editor projects or outputs,
    /// and it never rewrites a plan's origin trail.
    pub async fn delete_agent_session(&self, id: Uuid) -> Result<bool> {
        self.run(move |connection| {
            let changed = connection.execute(
                "DELETE FROM agent_sessions WHERE id = ?1",
                params![id.to_string()],
            )?;
            Ok(changed > 0)
        })
        .await
    }

    /// Appends one authored entry to a session. `workspace_edit` entries are not
    /// draftable: they are produced by [`Storage::apply_agent_plan_edit`].
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
            let now = Utc::now();
            let entry = match draft {
                AgentSessionEntryDraft::User { content } => AgentSessionEntry::User {
                    id: Uuid::new_v4(),
                    at: now,
                    content,
                },
                AgentSessionEntryDraft::Assistant {
                    content,
                    tool_calls,
                    proposals,
                } => AgentSessionEntry::Assistant {
                    id: Uuid::new_v4(),
                    at: now,
                    content,
                    tool_calls,
                    proposals,
                },
            };
            append_entry(&transaction, session_id, &entry)?;
            touch_session(&transaction, session_id, now)?;
            transaction.commit()?;
            Ok(Some(entry))
        })
        .await
    }

    /// Records that a session touched one workspace object. Repeating the same
    /// object updates its presentation and increments the server-owned touch
    /// count behind the "changed it N times" label.
    pub async fn touch_agent_object_ref(
        &self,
        session_id: Uuid,
        touch: AgentObjectRefTouch,
    ) -> Result<Option<AgentObjectRef>> {
        let touch = touch.normalize()?;
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if !session_exists(&transaction, session_id)? {
                return Ok(None);
            }
            let now = Utc::now();
            upsert_object_ref(&transaction, session_id, &touch, now)?;
            touch_session(&transaction, session_id, now)?;
            let reference = read_object_ref(&transaction, session_id, touch.kind, touch.id)?;
            transaction.commit()?;
            Ok(reference)
        })
        .await
    }

    /// Reads the reverse direction of the reference index: which sessions
    /// touched one exact object, newest first. A row whose session has been
    /// deleted is not returned; the object itself is never affected.
    pub async fn list_agent_object_sessions(
        &self,
        kind: AgentObjectKind,
        id: Uuid,
    ) -> Result<Vec<AgentObjectSessionRef>> {
        self.run(move |connection| {
            let mut statement = connection.prepare(
                "SELECT refs.session_id, sessions.title, refs.label, refs.summary, refs.status, \
                    refs.touch_count, refs.touched_at \
                 FROM agent_session_object_refs AS refs \
                 LEFT JOIN agent_sessions AS sessions ON sessions.id = refs.session_id \
                 WHERE refs.object_kind = ?1 AND refs.object_id = ?2 \
                 ORDER BY refs.touched_at DESC, refs.session_id",
            )?;
            let rows = statement
                .query_map(params![kind.as_str(), id.to_string()], |row| {
                    Ok(AgentObjectSessionRef {
                        session_id: parse_uuid(&row.get::<_, String>(0)?)?,
                        session_title: row.get::<_, Option<String>>(1)?,
                        kind,
                        id,
                        label: row.get(2)?,
                        summary: row.get(3)?,
                        status: row.get(4)?,
                        touch_count: u32::try_from(row.get::<_, i64>(5)?).unwrap_or(u32::MAX),
                        touched_at: parse_repository_datetime(&row.get::<_, String>(6)?)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await
    }

    /// Reads the current Agent workspace settings, falling back to the product
    /// defaults when nothing has been saved yet.
    pub async fn get_agent_workspace_settings(&self) -> Result<AgentWorkspaceSettings> {
        self.run(|connection| read_agent_settings(connection)).await
    }

    /// Saves the Agent workspace settings.
    pub async fn set_agent_workspace_settings(
        &self,
        settings: AgentWorkspaceSettings,
    ) -> Result<AgentWorkspaceSettings> {
        settings.validate()?;
        self.run(move |connection| {
            connection.execute(
                "INSERT INTO app_config(key, document_json, updated_at) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(key) DO UPDATE SET document_json = excluded.document_json, \
                    updated_at = excluded.updated_at",
                params![
                    AGENT_SETTINGS_KEY,
                    encode(&settings)?,
                    Utc::now().to_rfc3339()
                ],
            )?;
            Ok(settings)
        })
        .await
    }

    /// Applies the configured session retention policy and reports how many
    /// conversations were removed. Plans, tasks and outputs are untouched.
    pub async fn apply_agent_session_retention(&self) -> Result<u64> {
        self.run(|connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let settings = read_agent_settings(&transaction)?;
            let removed = match settings.session_retention {
                AgentSessionRetention::All => 0,
                AgentSessionRetention::None => {
                    transaction.execute("DELETE FROM agent_sessions", [])?
                }
                AgentSessionRetention::RecentCount { count } => transaction.execute(
                    "DELETE FROM agent_sessions WHERE id NOT IN ( \
                         SELECT id FROM agent_sessions ORDER BY updated_at DESC, id LIMIT ?1 \
                     )",
                    params![i64::from(count)],
                )?,
                AgentSessionRetention::MaxAgeDays { days } => {
                    let horizon = Utc::now() - Duration::days(i64::from(days));
                    transaction.execute(
                        "DELETE FROM agent_sessions WHERE updated_at < ?1",
                        params![horizon.to_rfc3339()],
                    )?
                }
            };
            transaction.commit()?;
            Ok(u64::try_from(removed).unwrap_or_default())
        })
        .await
    }

    /// Creates a plan at revision 1 and captures its immutable Agent baseline.
    pub async fn create_agent_plan(&self, create: AgentPlanCreate) -> Result<AgentPlan> {
        let create = create.normalize()?;
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now = Utc::now();
            let plan = AgentPlan {
                id: Uuid::new_v4(),
                title: create.title,
                status: create.status,
                revision: 1,
                shots: create.shots.clone(),
                origin: Vec::new(),
                agent_baseline: AgentPlanBaseline {
                    revision: 1,
                    captured_at: now,
                    shots: create.shots,
                },
                created_at: now,
                updated_at: now,
            };
            transaction.execute(
                "INSERT INTO agent_plans(\
                    id, title, status, revision, baseline_revision, created_at, updated_at, \
                    shots_json, agent_baseline_json\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    plan.id.to_string(),
                    plan.title,
                    plan.status.as_str(),
                    plan.revision,
                    plan.agent_baseline.revision,
                    plan.created_at.to_rfc3339(),
                    plan.updated_at.to_rfc3339(),
                    encode(&plan.shots)?,
                    encode(&plan.agent_baseline)?,
                ],
            )?;
            if let Some(origin) = create.origin.as_ref() {
                append_plan_origin(&transaction, plan.id, origin, now)?;
            }
            let plan = read_plan(&transaction, plan.id)?.ok_or_else(|| {
                StorageError::Domain(DomainError::Internal(
                    "the created plan disappeared inside its transaction".to_owned(),
                ))
            })?;
            transaction.commit()?;
            Ok(plan)
        })
        .await
    }

    /// Reads one exact plan with its origin trail and Agent baseline.
    pub async fn get_agent_plan(&self, id: Uuid) -> Result<Option<AgentPlan>> {
        self.run(move |connection| read_plan(connection, id)).await
    }

    /// Applies one manual plan edit.
    ///
    /// The write is conditional on `expected_revision` inside one immediate
    /// transaction. On success the revision is incremented by exactly one, the
    /// origin trail gains an entry, and - when the editing session still exists -
    /// a `workspace_edit` entry carrying the new authoritative revision is
    /// appended to it together with the session/plan reference.
    pub async fn apply_agent_plan_edit(&self, edit: AgentPlanEdit) -> Result<AgentPlanUpdate> {
        let edit = edit.normalize()?;
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(current) = read_plan_head(&transaction, edit.plan_id)? else {
                return Ok(AgentPlanUpdate::NotFound);
            };
            if current.revision != edit.expected_revision {
                return Ok(AgentPlanUpdate::Conflict {
                    current_revision: current.revision,
                });
            }
            let revision = next_revision(edit.plan_id, current.revision)?;
            let now = Utc::now();
            let changed = transaction.execute(
                "UPDATE agent_plans SET status = ?2, revision = ?3, updated_at = ?4, \
                    shots_json = ?5 WHERE id = ?1 AND revision = ?6",
                params![
                    edit.plan_id.to_string(),
                    edit.status.as_str(),
                    revision,
                    now.to_rfc3339(),
                    encode(&edit.shots)?,
                    edit.expected_revision,
                ],
            )?;
            if changed != 1 {
                return conflict_from_current(&transaction, edit.plan_id, edit.expected_revision);
            }
            append_plan_origin(&transaction, edit.plan_id, &edit.origin, now)?;
            notify_workspace_edit(
                &transaction,
                &edit.origin,
                &WorkspaceEditNotice {
                    object: AgentObjectLocator {
                        kind: AgentObjectKind::Plan,
                        id: edit.plan_id,
                    },
                    revision,
                    by: WorkspaceEditAuthor::User,
                    at: now,
                    changes: edit.changes.clone(),
                    note: edit.note.clone(),
                },
                &current.title,
                edit.status,
                now,
            )?;
            let plan = read_plan(&transaction, edit.plan_id)?.ok_or_else(|| {
                StorageError::Domain(DomainError::Internal(
                    "the edited plan disappeared inside its transaction".to_owned(),
                ))
            })?;
            transaction.commit()?;
            Ok(AgentPlanUpdate::Updated {
                plan: Box::new(plan),
            })
        })
        .await
    }

    /// Restores a plan to the Agent version captured when it was created.
    ///
    /// The restore is an ordinary user edit: it is conditional on the caller's
    /// base revision, increments the revision and reports one workspace edit.
    pub async fn restore_agent_plan_baseline(
        &self,
        restore: AgentPlanRestore,
    ) -> Result<AgentPlanUpdate> {
        let restore = restore.normalize()?;
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(current) = read_plan_head(&transaction, restore.plan_id)? else {
                return Ok(AgentPlanUpdate::NotFound);
            };
            if current.revision != restore.expected_revision {
                return Ok(AgentPlanUpdate::Conflict {
                    current_revision: current.revision,
                });
            }
            let baseline: AgentPlanBaseline = decode(&current.agent_baseline_json)?;
            let revision = next_revision(restore.plan_id, current.revision)?;
            let now = Utc::now();
            let changed = transaction.execute(
                "UPDATE agent_plans SET revision = ?2, updated_at = ?3, shots_json = ?4 \
                 WHERE id = ?1 AND revision = ?5",
                params![
                    restore.plan_id.to_string(),
                    revision,
                    now.to_rfc3339(),
                    encode(&baseline.shots)?,
                    restore.expected_revision,
                ],
            )?;
            if changed != 1 {
                return conflict_from_current(
                    &transaction,
                    restore.plan_id,
                    restore.expected_revision,
                );
            }
            append_plan_origin(&transaction, restore.plan_id, &restore.origin, now)?;
            notify_workspace_edit(
                &transaction,
                &restore.origin,
                &WorkspaceEditNotice {
                    object: AgentObjectLocator {
                        kind: AgentObjectKind::Plan,
                        id: restore.plan_id,
                    },
                    revision,
                    by: WorkspaceEditAuthor::User,
                    at: now,
                    changes: Vec::new(),
                    note: restore.note.clone(),
                },
                &current.title,
                current.status,
                now,
            )?;
            let plan = read_plan(&transaction, restore.plan_id)?.ok_or_else(|| {
                StorageError::Domain(DomainError::Internal(
                    "the restored plan disappeared inside its transaction".to_owned(),
                ))
            })?;
            transaction.commit()?;
            Ok(AgentPlanUpdate::Updated {
                plan: Box::new(plan),
            })
        })
        .await
    }

    /// Lists plan heads newest first, optionally narrowed to one status. This is
    /// the "awaiting confirmation" half of the workspace reference picker.
    pub async fn list_agent_plans(&self, query: AgentPlanQuery) -> Result<Vec<AgentPlanSummary>> {
        query.validate()?;
        self.run(move |connection| {
            let limit = i64::from(query.effective_limit());
            let status = query.status.map(AgentPlanStatus::as_str);
            let mut statement = connection.prepare(
                "SELECT id, title, status, revision, created_at, updated_at, shots_json, \
                    (SELECT COUNT(*) FROM agent_plan_origins \
                     WHERE agent_plan_origins.plan_id = agent_plans.id) \
                 FROM agent_plans \
                 WHERE ?1 IS NULL OR status = ?1 \
                 ORDER BY updated_at DESC, id \
                 LIMIT ?2",
            )?;
            let rows = statement
                .query_map(params![status, limit], |row| {
                    Ok((
                        parse_uuid(&row.get::<_, String>(0)?)?,
                        row.get::<_, String>(1)?,
                        parse_plan_status(&row.get::<_, String>(2)?)?,
                        row.get::<_, i64>(3)?,
                        parse_repository_datetime(&row.get::<_, String>(4)?)?,
                        parse_repository_datetime(&row.get::<_, String>(5)?)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, i64>(7)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut summaries = Vec::with_capacity(rows.len());
            for (id, title, status, revision, created_at, updated_at, shots_json, origin_count) in
                rows
            {
                let shots: Vec<AgentPlanShot> = decode(&shots_json)?;
                summaries.push(AgentPlanSummary {
                    id,
                    title,
                    status,
                    revision,
                    shot_count: u32::try_from(shots.len()).unwrap_or(u32::MAX),
                    origin_count: u32::try_from(origin_count).unwrap_or(u32::MAX),
                    created_at,
                    updated_at,
                });
            }
            Ok(summaries)
        })
        .await
    }

    /// Measures what the Agent conversation layer occupies locally.
    ///
    /// Conversation bytes and plan bytes are reported separately because a clear
    /// removes only the former.
    pub async fn agent_session_storage_stats(&self) -> Result<AgentSessionStorageStats> {
        self.run(|connection| {
            let (session_count, conversation_title_bytes, oldest, newest) = connection.query_row(
                "SELECT COUNT(*), COALESCE(SUM(LENGTH(CAST(title AS BLOB))), 0), \
                    MIN(updated_at), MAX(updated_at) FROM agent_sessions",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )?;
            let (entry_count, entry_bytes) = connection.query_row(
                "SELECT COUNT(*), COALESCE(SUM(LENGTH(CAST(document_json AS BLOB))), 0) \
                 FROM agent_session_entries",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )?;
            let (object_ref_count, object_ref_bytes) = connection.query_row(
                "SELECT COUNT(*), COALESCE(SUM( \
                    LENGTH(CAST(label AS BLOB)) + LENGTH(CAST(summary AS BLOB)) \
                    + LENGTH(CAST(status AS BLOB))), 0) \
                 FROM agent_session_object_refs",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )?;
            let (plan_count, plan_document_bytes) = connection.query_row(
                "SELECT COUNT(*), COALESCE(SUM( \
                    LENGTH(CAST(shots_json AS BLOB)) \
                    + LENGTH(CAST(agent_baseline_json AS BLOB))), 0) \
                 FROM agent_plans",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )?;
            let (plan_origin_count, plan_origin_bytes) = connection.query_row(
                "SELECT COUNT(*), COALESCE(SUM( \
                    LENGTH(CAST(session_title AS BLOB)) + LENGTH(CAST(summary AS BLOB))), 0) \
                 FROM agent_plan_origins",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )?;
            Ok(AgentSessionStorageStats {
                session_count: to_unsigned(session_count),
                entry_count: to_unsigned(entry_count),
                object_ref_count: to_unsigned(object_ref_count),
                plan_count: to_unsigned(plan_count),
                plan_origin_count: to_unsigned(plan_origin_count),
                conversation_bytes: to_unsigned(conversation_title_bytes)
                    .saturating_add(to_unsigned(entry_bytes))
                    .saturating_add(to_unsigned(object_ref_bytes)),
                plan_bytes: to_unsigned(plan_document_bytes)
                    .saturating_add(to_unsigned(plan_origin_bytes)),
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

    /// Exports every conversation with its entries and references.
    ///
    /// Plans are deliberately not part of the dump: they outlive the sessions
    /// that touched them and are exported through their own routes.
    pub async fn export_agent_sessions(&self) -> Result<AgentSessionExport> {
        self.run(|connection| {
            let settings = read_agent_settings(connection)?;
            let mut statement =
                connection.prepare("SELECT id FROM agent_sessions ORDER BY updated_at DESC, id")?;
            let ids = statement
                .query_map([], |row| parse_uuid(&row.get::<_, String>(0)?))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);
            let mut sessions = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some(session) = read_session(connection, id)? {
                    sessions.push(session);
                }
            }
            Ok(AgentSessionExport {
                exported_at: Utc::now(),
                settings,
                sessions,
            })
        })
        .await
    }

    /// Removes every conversation and reports how many were removed.
    ///
    /// Like [`Storage::delete_agent_session`], this never reaches the plans,
    /// recording jobs, editor projects or outputs those conversations touched,
    /// and it never rewrites a plan's origin trail.
    pub async fn clear_agent_sessions(&self) -> Result<u64> {
        self.run(|connection| {
            let removed = connection.execute("DELETE FROM agent_sessions", [])?;
            Ok(u64::try_from(removed).unwrap_or_default())
        })
        .await
    }
}

/// `SQLite` counts and sums are signed; a negative value is not representable.
fn to_unsigned(value: i64) -> u64 {
    u64::try_from(value).unwrap_or_default()
}

struct PlanHead {
    revision: i64,
    title: String,
    status: AgentPlanStatus,
    agent_baseline_json: String,
}

fn next_revision(plan_id: Uuid, current: i64) -> Result<i64> {
    current
        .checked_add(1)
        .ok_or(StorageError::AgentPlanRevisionOverflow(plan_id))
}

fn conflict_from_current(
    connection: &Connection,
    plan_id: Uuid,
    expected_revision: i64,
) -> Result<AgentPlanUpdate> {
    let current_revision = connection
        .query_row(
            "SELECT revision FROM agent_plans WHERE id = ?1",
            params![plan_id.to_string()],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(expected_revision);
    Ok(AgentPlanUpdate::Conflict { current_revision })
}

fn read_plan_head(connection: &Connection, id: Uuid) -> Result<Option<PlanHead>> {
    connection
        .query_row(
            "SELECT revision, title, status, agent_baseline_json FROM agent_plans WHERE id = ?1",
            params![id.to_string()],
            |row| {
                Ok(PlanHead {
                    revision: row.get(0)?,
                    title: row.get(1)?,
                    status: parse_plan_status(&row.get::<_, String>(2)?)?,
                    agent_baseline_json: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

fn read_plan(connection: &Connection, id: Uuid) -> Result<Option<AgentPlan>> {
    let Some((title, status, revision, created_at, updated_at, shots_json, baseline_json)) =
        connection
            .query_row(
                "SELECT title, status, revision, created_at, updated_at, shots_json, \
                    agent_baseline_json FROM agent_plans WHERE id = ?1",
                params![id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        parse_plan_status(&row.get::<_, String>(1)?)?,
                        row.get::<_, i64>(2)?,
                        parse_repository_datetime(&row.get::<_, String>(3)?)?,
                        parse_repository_datetime(&row.get::<_, String>(4)?)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .optional()?
    else {
        return Ok(None);
    };
    Ok(Some(AgentPlan {
        id,
        title,
        status,
        revision,
        shots: decode(&shots_json)?,
        origin: read_plan_origins(connection, id)?,
        agent_baseline: decode(&baseline_json)?,
        created_at,
        updated_at,
    }))
}

fn read_plan_origins(connection: &Connection, plan_id: Uuid) -> Result<Vec<AgentPlanOrigin>> {
    let mut statement = connection.prepare(
        "SELECT at, session_id, session_title, summary FROM agent_plan_origins \
         WHERE plan_id = ?1 ORDER BY at DESC, sequence DESC",
    )?;
    let origins = statement
        .query_map(params![plan_id.to_string()], |row| {
            Ok(AgentPlanOrigin {
                at: parse_repository_datetime(&row.get::<_, String>(0)?)?,
                session_id: parse_uuid(&row.get::<_, String>(1)?)?,
                session_title: row.get(2)?,
                summary: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(origins)
}

fn append_plan_origin(
    connection: &Connection,
    plan_id: Uuid,
    origin: &AgentPlanOriginDraft,
    at: DateTime<Utc>,
) -> Result<()> {
    let sequence = connection.query_row(
        "SELECT COALESCE(MAX(sequence) + 1, 0) FROM agent_plan_origins WHERE plan_id = ?1",
        params![plan_id.to_string()],
        |row| row.get::<_, i64>(0),
    )?;
    connection.execute(
        "INSERT INTO agent_plan_origins(plan_id, sequence, at, session_id, session_title, summary) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            plan_id.to_string(),
            sequence,
            at.to_rfc3339(),
            origin.session_id.to_string(),
            origin.session_title,
            origin.summary,
        ],
    )?;
    Ok(())
}

/// Writes the workspace edit notice and the session/plan reference when the
/// editing session still exists. A manual edit is never rejected because its
/// session is gone: the plan write has already been committed to.
fn notify_workspace_edit(
    transaction: &Transaction<'_>,
    origin: &AgentPlanOriginDraft,
    notice: &WorkspaceEditNotice,
    plan_title: &str,
    status: AgentPlanStatus,
    now: DateTime<Utc>,
) -> Result<()> {
    if !session_exists(transaction, origin.session_id)? {
        return Ok(());
    }
    let entry = AgentSessionEntry::WorkspaceEdit {
        id: Uuid::new_v4(),
        at: now,
        notice: notice.clone(),
    };
    append_entry(transaction, origin.session_id, &entry)?;
    upsert_object_ref(
        transaction,
        origin.session_id,
        &AgentObjectRefTouch {
            kind: notice.object.kind,
            id: notice.object.id,
            label: plan_title.to_owned(),
            summary: origin.summary.clone(),
            status: status.as_str().to_owned(),
        },
        now,
    )?;
    touch_session(transaction, origin.session_id, now)?;
    Ok(())
}

fn session_exists(connection: &Connection, id: Uuid) -> Result<bool> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM agent_sessions WHERE id = ?1",
            params![id.to_string()],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    Ok(exists)
}

fn touch_session(connection: &Connection, id: Uuid, at: DateTime<Utc>) -> Result<()> {
    connection.execute(
        "UPDATE agent_sessions SET updated_at = ?2 WHERE id = ?1",
        params![id.to_string(), at.to_rfc3339()],
    )?;
    Ok(())
}

fn append_entry(
    connection: &Connection,
    session_id: Uuid,
    entry: &AgentSessionEntry,
) -> Result<()> {
    let sequence = connection.query_row(
        "SELECT COALESCE(MAX(sequence) + 1, 0) FROM agent_session_entries WHERE session_id = ?1",
        params![session_id.to_string()],
        |row| row.get::<_, i64>(0),
    )?;
    connection.execute(
        "INSERT INTO agent_session_entries(\
            session_id, sequence, kind, created_at, search_text, document_json\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            session_id.to_string(),
            sequence,
            entry.kind(),
            entry.at().to_rfc3339(),
            entry.search_text(),
            encode(entry)?,
        ],
    )?;
    Ok(())
}

fn upsert_object_ref(
    connection: &Connection,
    session_id: Uuid,
    touch: &AgentObjectRefTouch,
    at: DateTime<Utc>,
) -> Result<()> {
    connection.execute(
        "INSERT INTO agent_session_object_refs(\
            session_id, object_kind, object_id, label, summary, status, touch_count, touched_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7) \
         ON CONFLICT(session_id, object_kind, object_id) DO UPDATE SET \
            label = excluded.label, summary = excluded.summary, status = excluded.status, \
            touch_count = agent_session_object_refs.touch_count + 1, \
            touched_at = excluded.touched_at",
        params![
            session_id.to_string(),
            touch.kind.as_str(),
            touch.id.to_string(),
            touch.label,
            touch.summary,
            touch.status,
            at.to_rfc3339(),
        ],
    )?;
    Ok(())
}

fn read_object_ref(
    connection: &Connection,
    session_id: Uuid,
    kind: AgentObjectKind,
    id: Uuid,
) -> Result<Option<AgentObjectRef>> {
    connection
        .query_row(
            "SELECT label, summary, status, touch_count, touched_at \
             FROM agent_session_object_refs \
             WHERE session_id = ?1 AND object_kind = ?2 AND object_id = ?3",
            params![session_id.to_string(), kind.as_str(), id.to_string()],
            |row| {
                Ok(AgentObjectRef {
                    kind,
                    id,
                    label: row.get(0)?,
                    summary: row.get(1)?,
                    status: row.get(2)?,
                    touch_count: u32::try_from(row.get::<_, i64>(3)?).unwrap_or(u32::MAX),
                    touched_at: parse_repository_datetime(&row.get::<_, String>(4)?)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

fn read_session_refs(connection: &Connection, session_id: Uuid) -> Result<Vec<AgentObjectRef>> {
    let mut statement = connection.prepare(
        "SELECT object_kind, object_id, label, summary, status, touch_count, touched_at \
         FROM agent_session_object_refs WHERE session_id = ?1 \
         ORDER BY touched_at DESC, object_kind, object_id",
    )?;
    let refs = statement
        .query_map(params![session_id.to_string()], |row| {
            let kind_text = row.get::<_, String>(0)?;
            Ok(AgentObjectRef {
                kind: parse_object_kind(&kind_text)?,
                id: parse_uuid(&row.get::<_, String>(1)?)?,
                label: row.get(2)?,
                summary: row.get(3)?,
                status: row.get(4)?,
                touch_count: u32::try_from(row.get::<_, i64>(5)?).unwrap_or(u32::MAX),
                touched_at: parse_repository_datetime(&row.get::<_, String>(6)?)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(refs)
}

fn read_session(connection: &Connection, id: Uuid) -> Result<Option<AgentSession>> {
    let Some((title, created_at, updated_at)) = connection
        .query_row(
            "SELECT title, created_at, updated_at FROM agent_sessions WHERE id = ?1",
            params![id.to_string()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    parse_repository_datetime(&row.get::<_, String>(1)?)?,
                    parse_repository_datetime(&row.get::<_, String>(2)?)?,
                ))
            },
        )
        .optional()?
    else {
        return Ok(None);
    };
    let mut statement = connection.prepare(
        "SELECT document_json FROM agent_session_entries WHERE session_id = ?1 ORDER BY sequence",
    )?;
    let documents = statement
        .query_map(params![id.to_string()], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut entries = Vec::with_capacity(documents.len());
    for document in &documents {
        entries.push(decode::<AgentSessionEntry>(document)?);
    }
    Ok(Some(AgentSession {
        id,
        title,
        created_at,
        updated_at,
        entries,
        refs: read_session_refs(connection, id)?,
    }))
}

fn read_agent_settings(connection: &Connection) -> Result<AgentWorkspaceSettings> {
    let Some(document) = connection
        .query_row(
            "SELECT document_json FROM app_config WHERE key = ?1",
            params![AGENT_SETTINGS_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    else {
        return Ok(AgentWorkspaceSettings::default());
    };
    decode(&document)
}

fn like_pattern(value: &str) -> String {
    let escaped = value
        .trim()
        .to_lowercase()
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

fn parse_uuid(value: &str) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

fn parse_object_kind(value: &str) -> rusqlite::Result<AgentObjectKind> {
    AgentObjectKind::from_str_exact(value).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!("invalid agent object kind {value}").into(),
        )
    })
}

fn parse_plan_status(value: &str) -> rusqlite::Result<AgentPlanStatus> {
    AgentPlanStatus::from_str_exact(value).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!("invalid agent plan status {value}").into(),
        )
    })
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use uuid::Uuid;
    use vibe_cs_domain::{
        AgentObjectKind, AgentObjectRefTouch, AgentPlanAuthor, AgentPlanCreate, AgentPlanEdit,
        AgentPlanOriginDraft, AgentPlanRestore, AgentPlanShot, AgentPlanStatus, AgentPlanUpdate,
        AgentSessionEntry, AgentSessionEntryDraft, AgentSessionQuery, AgentSessionRetention,
        AgentShotView, AgentWorkspaceSettings, EditorProject, HlaeCameraStyle, JobStatus,
        RecordedClip, RecordingJob, WorkspaceEditChange, WorkspaceEditOperation,
    };

    use crate::Storage;

    fn shot(title: &str, seconds: f64, source: AgentPlanAuthor) -> AgentPlanShot {
        AgentPlanShot {
            id: Uuid::new_v4(),
            title: title.to_owned(),
            kind: HlaeCameraStyle::Tracking,
            view: AgentShotView::Observer,
            start_tick: 148_812,
            end_tick: 149_132,
            duration_seconds: seconds,
            rationale: "沿他的真实移动轴从中路跟到 A 大道".to_owned(),
            evidence_refs: Vec::new(),
            risks: Vec::new(),
            source,
            removed_by: None,
            params: serde_json::json!({}),
        }
    }

    fn origin(session_id: Uuid, summary: &str) -> AgentPlanOriginDraft {
        AgentPlanOriginDraft {
            session_id,
            session_title: "Kael 的 1v3".to_owned(),
            summary: summary.to_owned(),
        }
    }

    fn editor_project(name: &str) -> EditorProject {
        let now = Utc::now();
        EditorProject {
            id: Uuid::new_v4(),
            name: name.to_owned(),
            width: 1920,
            height: 1080,
            fps: 60,
            duration_seconds: 12.5,
            tracks: Vec::new(),
            markers: Vec::new(),
            settings: serde_json::Value::Object(serde_json::Map::new()),
            revision: 1,
            created_at: now,
            updated_at: now,
        }
    }

    fn recorded_clip(path: &str) -> RecordedClip {
        RecordedClip {
            id: Uuid::new_v4(),
            path: path.to_owned(),
            title: "Rhea_double.mp4".to_owned(),
            duration_seconds: 42.0,
            demo_id: None,
            player_name: None,
            category: "highlight".to_owned(),
            tags: Vec::new(),
            metadata: serde_json::json!({}),
            created_at: Utc::now(),
        }
    }

    fn recording_job() -> RecordingJob {
        let now = Utc::now();
        RecordingJob {
            id: Uuid::new_v4(),
            retry_of: None,
            status: JobStatus::Queued,
            items: Vec::new(),
            current_index: 0,
            progress: 0.0,
            message: String::new(),
            outputs: Vec::new(),
            created_at: now,
            updated_at: now,
        }
    }

    #[tokio::test]
    async fn deleting_a_session_keeps_every_object_it_touched() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let session = storage
            .create_agent_session("Kael 的 1v3".to_owned())
            .await
            .expect("create session");
        let plan = storage
            .create_agent_plan(AgentPlanCreate {
                title: "Kael Mirage 1v3".to_owned(),
                status: AgentPlanStatus::AwaitingConfirmation,
                shots: vec![shot("02 跟随突破", 8.5, AgentPlanAuthor::Agent)],
                origin: Some(origin(session.id, "生成初版方案 · 1 个镜头")),
            })
            .await
            .expect("create plan");
        let job = storage
            .put_recording_job(recording_job())
            .await
            .expect("recording job");
        let project = storage
            .put_editor_project(editor_project("Aurora 赛点集锦"))
            .await
            .expect("editor project");
        let clip = storage
            .put_recorded_clip(recorded_clip("C:/outputs/Rhea_double.mp4"))
            .await
            .expect("recorded clip");

        for (kind, id, label) in [
            (AgentObjectKind::Plan, plan.id, "方案 #P-118"),
            (AgentObjectKind::RecordingTask, job.id, "录制任务 #A-2481"),
            (AgentObjectKind::EditProject, project.id, "剪辑工程"),
            (AgentObjectKind::Output, clip.id, "Rhea_double.mp4"),
        ] {
            storage
                .touch_agent_object_ref(
                    session.id,
                    AgentObjectRefTouch {
                        kind,
                        id,
                        label: label.to_owned(),
                        summary: "改过 1 次".to_owned(),
                        status: "等待确认".to_owned(),
                    },
                )
                .await
                .expect("touch reference")
                .expect("session exists");
        }

        assert!(
            storage
                .delete_agent_session(session.id)
                .await
                .expect("delete session")
        );

        assert!(
            storage
                .get_agent_session(session.id)
                .await
                .expect("read session")
                .is_none()
        );
        let surviving_plan = storage
            .get_agent_plan(plan.id)
            .await
            .expect("read plan")
            .expect("the plan survives its session");
        assert_eq!(surviving_plan.revision, 1);
        assert_eq!(surviving_plan.origin.len(), 1);
        assert_eq!(surviving_plan.origin[0].session_id, session.id);
        assert_eq!(surviving_plan.origin[0].session_title, "Kael 的 1v3");
        assert!(
            storage
                .get_recording_job(job.id)
                .await
                .expect("read recording job")
                .is_some()
        );
        assert!(
            storage
                .get_editor_project(project.id)
                .await
                .expect("read editor project")
                .is_some()
        );
        assert!(
            storage
                .get_recorded_clip(clip.id)
                .await
                .expect("read output")
                .is_some()
        );
        assert!(
            storage
                .list_agent_object_sessions(AgentObjectKind::Plan, plan.id)
                .await
                .expect("reverse index")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn references_are_bidirectional_and_count_every_touch() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let first = storage
            .create_agent_session("Kael 的 1v3".to_owned())
            .await
            .expect("first session");
        let second = storage
            .create_agent_session("赛点集锦 · 三场".to_owned())
            .await
            .expect("second session");
        let plan = storage
            .create_agent_plan(AgentPlanCreate {
                title: "Kael Mirage 1v3".to_owned(),
                status: AgentPlanStatus::AwaitingConfirmation,
                shots: vec![shot("02 跟随突破", 8.5, AgentPlanAuthor::Agent)],
                origin: None,
            })
            .await
            .expect("create plan");

        for session in [first.id, first.id, second.id] {
            storage
                .touch_agent_object_ref(
                    session,
                    AgentObjectRefTouch {
                        kind: AgentObjectKind::Plan,
                        id: plan.id,
                        label: "方案 #P-118".to_owned(),
                        summary: "改过 2 次".to_owned(),
                        status: "等待确认".to_owned(),
                    },
                )
                .await
                .expect("touch")
                .expect("session exists");
        }

        let session = storage
            .get_agent_session(first.id)
            .await
            .expect("read session")
            .expect("session");
        assert_eq!(session.refs.len(), 1);
        assert_eq!(session.refs[0].touch_count, 2);
        assert_eq!(session.refs[0].kind, AgentObjectKind::Plan);

        let sessions = storage
            .list_agent_object_sessions(AgentObjectKind::Plan, plan.id)
            .await
            .expect("reverse index");
        assert_eq!(sessions.len(), 2);
        assert!(sessions.iter().any(|item| item.session_id == first.id));
        assert!(sessions.iter().any(|item| item.session_id == second.id));

        // An unknown session cannot create a reference.
        assert!(
            storage
                .touch_agent_object_ref(
                    Uuid::new_v4(),
                    AgentObjectRefTouch {
                        kind: AgentObjectKind::Plan,
                        id: plan.id,
                        label: "方案 #P-118".to_owned(),
                        summary: String::new(),
                        status: String::new(),
                    },
                )
                .await
                .expect("touch unknown session")
                .is_none()
        );
    }

    #[tokio::test]
    async fn concurrent_edits_of_one_plan_cannot_silently_overwrite_each_other() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let first = storage
            .create_agent_session("Kael 的 1v3".to_owned())
            .await
            .expect("first session");
        let second = storage
            .create_agent_session("Rhea 双杀合集".to_owned())
            .await
            .expect("second session");
        let plan = storage
            .create_agent_plan(AgentPlanCreate {
                title: "Kael Mirage 1v3".to_owned(),
                status: AgentPlanStatus::AwaitingConfirmation,
                shots: vec![shot("02 跟随突破", 8.5, AgentPlanAuthor::Agent)],
                origin: None,
            })
            .await
            .expect("create plan");
        assert_eq!(plan.revision, 1);

        let edit = |session_id: Uuid, seconds: f64, summary: &str| AgentPlanEdit {
            plan_id: plan.id,
            expected_revision: 1,
            status: AgentPlanStatus::AwaitingConfirmation,
            shots: vec![shot("02 跟随突破", seconds, AgentPlanAuthor::User)],
            origin: origin(session_id, summary),
            changes: vec![WorkspaceEditChange {
                shot: 2,
                op: WorkspaceEditOperation::Updated,
                field: Some("duration".to_owned()),
                from: Some("8.5s".to_owned()),
                to: Some(format!("{seconds}s")),
            }],
            note: Some("起手那段留给建立镜头交代".to_owned()),
        };

        let winner = storage
            .apply_agent_plan_edit(edit(first.id, 5.0, "镜头 02 由 8.5 秒改为 5.0 秒"))
            .await
            .expect("first edit");
        let AgentPlanUpdate::Updated { plan: updated } = winner else {
            panic!("the first edit must win");
        };
        assert_eq!(updated.revision, 2);
        assert!((updated.shots[0].duration_seconds - 5.0).abs() < f64::EPSILON);

        // The second session still holds revision 1 and must be rejected instead
        // of overwriting the first edit.
        let loser = storage
            .apply_agent_plan_edit(edit(second.id, 3.0, "镜头 02 由 8.5 秒改为 3.0 秒"))
            .await
            .expect("second edit");
        assert_eq!(
            loser,
            AgentPlanUpdate::Conflict {
                current_revision: 2
            }
        );

        let current = storage
            .get_agent_plan(plan.id)
            .await
            .expect("read plan")
            .expect("plan");
        assert_eq!(current.revision, 2);
        assert!((current.shots[0].duration_seconds - 5.0).abs() < f64::EPSILON);
        assert_eq!(current.origin.len(), 1);
        assert_eq!(current.origin[0].session_id, first.id);

        // Rebasing on the current revision succeeds and moves it forward again.
        let rebased = storage
            .apply_agent_plan_edit(AgentPlanEdit {
                expected_revision: 2,
                ..edit(second.id, 3.0, "镜头 02 由 5.0 秒改为 3.0 秒")
            })
            .await
            .expect("rebased edit");
        let AgentPlanUpdate::Updated { plan: rebased } = rebased else {
            panic!("the rebased edit must win");
        };
        assert_eq!(rebased.revision, 3);
        assert_eq!(rebased.origin.len(), 2);
        assert_eq!(rebased.origin[0].session_id, second.id);

        assert_eq!(
            storage
                .apply_agent_plan_edit(AgentPlanEdit {
                    plan_id: Uuid::new_v4(),
                    ..edit(first.id, 4.0, "未知方案")
                })
                .await
                .expect("missing plan"),
            AgentPlanUpdate::NotFound
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_sessions_editing_at_the_same_moment_produce_one_winner_and_one_conflict() {
        let storage = std::sync::Arc::new(Storage::open_in_memory().await.expect("open storage"));
        let first = storage
            .create_agent_session("Kael 的 1v3".to_owned())
            .await
            .expect("first session");
        let second = storage
            .create_agent_session("Rhea 双杀合集".to_owned())
            .await
            .expect("second session");
        let plan = storage
            .create_agent_plan(AgentPlanCreate {
                title: "Kael Mirage 1v3".to_owned(),
                status: AgentPlanStatus::AwaitingConfirmation,
                shots: vec![shot("02 跟随突破", 8.5, AgentPlanAuthor::Agent)],
                origin: None,
            })
            .await
            .expect("create plan");

        let edit = |session_id: Uuid, seconds: f64| AgentPlanEdit {
            plan_id: plan.id,
            expected_revision: 1,
            status: AgentPlanStatus::AwaitingConfirmation,
            shots: vec![shot("02 跟随突破", seconds, AgentPlanAuthor::User)],
            origin: origin(session_id, "并发编辑"),
            changes: Vec::new(),
            note: None,
        };

        let left = tokio::spawn({
            let storage = std::sync::Arc::clone(&storage);
            let edit = edit(first.id, 5.0);
            async move { storage.apply_agent_plan_edit(edit).await }
        });
        let right = tokio::spawn({
            let storage = std::sync::Arc::clone(&storage);
            let edit = edit(second.id, 3.0);
            async move { storage.apply_agent_plan_edit(edit).await }
        });
        let outcomes = [
            left.await.expect("join left").expect("left edit"),
            right.await.expect("join right").expect("right edit"),
        ];

        let updated = outcomes
            .iter()
            .filter(|outcome| matches!(outcome, AgentPlanUpdate::Updated { .. }))
            .count();
        assert_eq!(updated, 1, "exactly one concurrent edit may win");
        assert!(
            outcomes.iter().any(|outcome| matches!(
                outcome,
                AgentPlanUpdate::Conflict {
                    current_revision: 2
                }
            )),
            "the loser must observe the winner's revision instead of overwriting it"
        );

        let current = storage
            .get_agent_plan(plan.id)
            .await
            .expect("read plan")
            .expect("plan");
        assert_eq!(current.revision, 2, "revision advances by exactly one");
        assert_eq!(
            current.origin.len(),
            1,
            "only the winning edit is recorded in the origin trail"
        );
    }

    #[tokio::test]
    async fn a_plan_edit_writes_one_typed_workspace_edit_entry_into_its_session() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let session = storage
            .create_agent_session("Kael 的 1v3".to_owned())
            .await
            .expect("session");
        storage
            .append_agent_session_entry(
                session.id,
                AgentSessionEntryDraft::User {
                    content: "把它压到 30 秒以内".to_owned(),
                },
            )
            .await
            .expect("append user entry")
            .expect("session exists");
        let plan = storage
            .create_agent_plan(AgentPlanCreate {
                title: "Kael Mirage 1v3".to_owned(),
                status: AgentPlanStatus::AwaitingConfirmation,
                shots: vec![shot("02 跟随突破", 8.5, AgentPlanAuthor::Agent)],
                origin: None,
            })
            .await
            .expect("plan");

        storage
            .apply_agent_plan_edit(AgentPlanEdit {
                plan_id: plan.id,
                expected_revision: 1,
                status: AgentPlanStatus::AwaitingConfirmation,
                shots: vec![shot("02 跟随突破", 5.0, AgentPlanAuthor::User)],
                origin: origin(session.id, "镜头 02 由 8.5 秒改为 5.0 秒"),
                changes: vec![WorkspaceEditChange {
                    shot: 2,
                    op: WorkspaceEditOperation::Updated,
                    field: Some("duration".to_owned()),
                    from: Some("8.5s".to_owned()),
                    to: Some("5.0s".to_owned()),
                }],
                note: Some("起手那段留给建立镜头交代".to_owned()),
            })
            .await
            .expect("edit");

        let session = storage
            .get_agent_session(session.id)
            .await
            .expect("read session")
            .expect("session");
        assert_eq!(session.entries.len(), 2);
        let AgentSessionEntry::WorkspaceEdit { notice, .. } = &session.entries[1] else {
            panic!("the second entry must be a workspace edit notice");
        };
        assert_eq!(notice.object.kind, AgentObjectKind::Plan);
        assert_eq!(notice.object.id, plan.id);
        assert_eq!(notice.revision, 2);
        assert_eq!(notice.changes.len(), 1);
        assert_eq!(notice.note.as_deref(), Some("起手那段留给建立镜头交代"));
        assert_eq!(session.refs.len(), 1);
        assert_eq!(session.refs[0].id, plan.id);
    }

    #[tokio::test]
    async fn a_plan_can_be_restored_to_its_agent_version() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let session = storage
            .create_agent_session("Kael 的 1v3".to_owned())
            .await
            .expect("session");
        let plan = storage
            .create_agent_plan(AgentPlanCreate {
                title: "Kael Mirage 1v3".to_owned(),
                status: AgentPlanStatus::AwaitingConfirmation,
                shots: vec![shot("02 跟随突破", 8.5, AgentPlanAuthor::Agent)],
                origin: None,
            })
            .await
            .expect("plan");

        storage
            .apply_agent_plan_edit(AgentPlanEdit {
                plan_id: plan.id,
                expected_revision: 1,
                status: AgentPlanStatus::AwaitingConfirmation,
                shots: vec![shot("02 跟随突破", 5.0, AgentPlanAuthor::User)],
                origin: origin(session.id, "镜头 02 由 8.5 秒改为 5.0 秒"),
                changes: Vec::new(),
                note: None,
            })
            .await
            .expect("edit");

        let restored = storage
            .restore_agent_plan_baseline(AgentPlanRestore {
                plan_id: plan.id,
                expected_revision: 2,
                origin: origin(session.id, "还原为 Agent 版本"),
                note: None,
            })
            .await
            .expect("restore");
        let AgentPlanUpdate::Updated { plan: restored } = restored else {
            panic!("the restore must apply");
        };
        assert_eq!(restored.revision, 3);
        assert_eq!(restored.shots.len(), 1);
        assert!((restored.shots[0].duration_seconds - 8.5).abs() < f64::EPSILON);
        assert_eq!(restored.shots[0].source, AgentPlanAuthor::Agent);
        assert_eq!(restored.agent_baseline.revision, 1);

        assert_eq!(
            storage
                .restore_agent_plan_baseline(AgentPlanRestore {
                    plan_id: plan.id,
                    expected_revision: 2,
                    origin: origin(session.id, "还原为 Agent 版本"),
                    note: None,
                })
                .await
                .expect("stale restore"),
            AgentPlanUpdate::Conflict {
                current_revision: 3
            }
        );
    }

    #[tokio::test]
    async fn sessions_are_searchable_by_title_and_conversation_text() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let first = storage
            .create_agent_session("Kael 的 1v3".to_owned())
            .await
            .expect("first");
        storage
            .create_agent_session("Rhea 双杀合集".to_owned())
            .await
            .expect("second");
        storage
            .append_agent_session_entry(
                first.id,
                AgentSessionEntryDraft::User {
                    content: "Aurora vs Meridian 的赛点".to_owned(),
                },
            )
            .await
            .expect("entry")
            .expect("session exists");

        let all = storage
            .list_agent_sessions(AgentSessionQuery::default())
            .await
            .expect("list");
        assert_eq!(all.total, 2);
        assert_eq!(all.items.len(), 2);
        assert_eq!(all.items[0].id, first.id, "newest first");
        assert_eq!(all.items[0].entry_count, 1);

        let by_title = storage
            .list_agent_sessions(AgentSessionQuery {
                q: Some("rhea".to_owned()),
                limit: None,
            })
            .await
            .expect("search by title");
        assert_eq!(by_title.total, 1);

        let by_content = storage
            .list_agent_sessions(AgentSessionQuery {
                q: Some("meridian".to_owned()),
                limit: None,
            })
            .await
            .expect("search by content");
        assert_eq!(by_content.total, 1);
        assert_eq!(by_content.items[0].id, first.id);

        let renamed = storage
            .rename_agent_session(first.id, "Kael 的 1v3 残局".to_owned())
            .await
            .expect("rename")
            .expect("session exists");
        assert_eq!(renamed.title, "Kael 的 1v3 残局");
        assert!(
            storage
                .rename_agent_session(Uuid::new_v4(), "missing".to_owned())
                .await
                .expect("rename missing")
                .is_none()
        );
    }

    #[tokio::test]
    async fn retention_policy_removes_only_conversations() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        assert_eq!(
            storage
                .get_agent_workspace_settings()
                .await
                .expect("default settings"),
            AgentWorkspaceSettings::default()
        );

        let session = storage
            .create_agent_session("Kael 的 1v3".to_owned())
            .await
            .expect("session");
        let plan = storage
            .create_agent_plan(AgentPlanCreate {
                title: "Kael Mirage 1v3".to_owned(),
                status: AgentPlanStatus::AwaitingConfirmation,
                shots: vec![shot("02 跟随突破", 8.5, AgentPlanAuthor::Agent)],
                origin: Some(origin(session.id, "生成初版方案")),
            })
            .await
            .expect("plan");
        storage
            .create_agent_session("Rhea 双杀合集".to_owned())
            .await
            .expect("second session");

        assert_eq!(
            storage
                .apply_agent_session_retention()
                .await
                .expect("retain all"),
            0
        );

        storage
            .set_agent_workspace_settings(AgentWorkspaceSettings {
                session_retention: AgentSessionRetention::RecentCount { count: 1 },
                take_limit: 5,
            })
            .await
            .expect("save settings");
        assert_eq!(
            storage
                .apply_agent_session_retention()
                .await
                .expect("retain recent"),
            1
        );
        assert_eq!(
            storage
                .list_agent_sessions(AgentSessionQuery::default())
                .await
                .expect("list")
                .total,
            1
        );

        storage
            .set_agent_workspace_settings(AgentWorkspaceSettings {
                session_retention: AgentSessionRetention::None,
                take_limit: 5,
            })
            .await
            .expect("save settings");
        assert_eq!(
            storage
                .apply_agent_session_retention()
                .await
                .expect("retain none"),
            1
        );

        let surviving = storage
            .get_agent_plan(plan.id)
            .await
            .expect("read plan")
            .expect("the plan survives retention");
        assert_eq!(surviving.origin.len(), 1);
        assert_eq!(surviving.origin[0].session_id, session.id);

        assert!(
            storage
                .set_agent_workspace_settings(AgentWorkspaceSettings {
                    session_retention: AgentSessionRetention::MaxAgeDays { days: 0 },
                    take_limit: 5,
                })
                .await
                .is_err()
        );
    }
}
