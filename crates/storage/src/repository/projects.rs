use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension as _, Transaction, TransactionBehavior, params};
use uuid::Uuid;
use vibe_cs_domain::{
    DomainError, Project, ProjectChangeAuthor, ProjectChangeGroup, ProjectEditLease, ProjectPatch,
    ProjectPatchScope,
};

use super::{Storage, decode, encode, sql_u64};
use crate::{Result, StorageError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectLeaseAcquire {
    Acquired(ProjectEditLease),
    Held(ProjectEditLease),
}

impl Storage {
    pub async fn create_project(&self, project: Project) -> Result<Project> {
        project.validate()?;
        if project.revision != 1 {
            return Err(StorageError::Domain(DomainError::InvalidInput(
                "new project revision must be 1".to_owned(),
            )));
        }
        self.run(move |connection| {
            if read_project(connection, project.id)?.is_some() {
                return Err(StorageError::ProjectAlreadyExists(project.id));
            }
            connection.execute(
                "INSERT INTO projects(id, name, revision, created_at, updated_at, document_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    project.id.to_string(),
                    project.name,
                    sql_u64(project.revision)?,
                    project.created_at.to_rfc3339(),
                    project.updated_at.to_rfc3339(),
                    encode(&project)?,
                ],
            )?;
            Ok(project)
        })
        .await
    }

    pub async fn get_project(&self, project_id: Uuid) -> Result<Option<Project>> {
        self.run(move |connection| read_project(connection, project_id))
            .await
    }

    pub async fn list_projects(&self) -> Result<Vec<Project>> {
        self.run(|connection| {
            let mut statement = connection
                .prepare("SELECT document_json FROM projects ORDER BY updated_at DESC, id")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            let mut projects = Vec::new();
            for row in rows {
                projects.push(decode::<Project>(&row?)?);
            }
            Ok(projects)
        })
        .await
    }

    pub async fn apply_project_patch(
        &self,
        mut patch: ProjectPatch,
        change_group_id: Uuid,
        now: DateTime<Utc>,
    ) -> Result<(Project, ProjectChangeGroup)> {
        allocate_inserted_project_ids(&mut patch);
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            authorize_project_patch(&transaction, &patch)?;
            let mut project = read_project(&transaction, patch.project_id)?
                .ok_or_else(|| StorageError::Domain(DomainError::NotFound("project".to_owned())))?;
            let group = project.apply_patch(patch, change_group_id, now)?;
            let affected = transaction.execute(
                "UPDATE projects SET name = ?2, revision = ?3, updated_at = ?4, document_json = ?5 \
                 WHERE id = ?1 AND revision = ?6",
                params![
                    project.id.to_string(),
                    project.name,
                    sql_u64(project.revision)?,
                    project.updated_at.to_rfc3339(),
                    encode(&project)?,
                    sql_u64(group.from_revision)?,
                ],
            )?;
            if affected != 1 {
                return Err(StorageError::Domain(DomainError::Conflict(
                    "project revision changed while applying patch".to_owned(),
                )));
            }
            insert_change_group(&transaction, &group)?;
            transaction.commit()?;
            Ok((project, group))
        })
        .await
    }

    pub async fn list_project_change_groups(
        &self,
        project_id: Uuid,
        limit: u32,
    ) -> Result<Vec<ProjectChangeGroup>> {
        self.run(move |connection| {
            let mut statement = connection.prepare(
                "SELECT document_json FROM project_change_groups \
                 WHERE project_id = ?1 ORDER BY to_revision DESC LIMIT ?2",
            )?;
            let rows = statement.query_map(
                params![project_id.to_string(), i64::from(limit.min(1_000))],
                |row| row.get::<_, String>(0),
            )?;
            let mut groups = Vec::new();
            for row in rows {
                groups.push(decode::<ProjectChangeGroup>(&row?)?);
            }
            Ok(groups)
        })
        .await
    }

    pub async fn revert_project_change_group(
        &self,
        project_id: Uuid,
        change_group_id: Uuid,
        expected_revision: u64,
        author: ProjectChangeAuthor,
        inverse_group_id: Uuid,
        now: DateTime<Utc>,
    ) -> Result<(Project, ProjectChangeGroup)> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if read_project_edit_lease(&transaction, project_id)?.is_some() {
                return Err(StorageError::Domain(DomainError::Conflict(
                    "Project is read-only while an Agent Operation holds the edit lease".to_owned(),
                )));
            }
            let target =
                read_change_group(&transaction, project_id, change_group_id)?.ok_or_else(|| {
                    StorageError::Domain(DomainError::NotFound("project change group".to_owned()))
                })?;
            let mut project = read_project(&transaction, project_id)?
                .ok_or_else(|| StorageError::Domain(DomainError::NotFound("project".to_owned())))?;
            if project.revision != expected_revision {
                return Err(StorageError::Domain(DomainError::Conflict(format!(
                    "project is at revision {}, revert expects {expected_revision}",
                    project.revision
                ))));
            }
            let patch = ProjectPatch {
                project_id,
                base_revision: project.revision,
                scope: ProjectPatchScope::Project,
                author,
                reverts_change_group_id: Some(target.id),
                summary: format!("Revert: {}", target.summary),
                operations: target.inverse_operations,
            };
            let group = project.apply_patch(patch, inverse_group_id, now)?;
            let affected = transaction.execute(
                "UPDATE projects SET name = ?2, revision = ?3, updated_at = ?4, document_json = ?5 \
                 WHERE id = ?1 AND revision = ?6",
                params![
                    project.id.to_string(),
                    project.name,
                    sql_u64(project.revision)?,
                    project.updated_at.to_rfc3339(),
                    encode(&project)?,
                    sql_u64(group.from_revision)?,
                ],
            )?;
            if affected != 1 {
                return Err(StorageError::Domain(DomainError::Conflict(
                    "project revision changed while reverting change group".to_owned(),
                )));
            }
            insert_change_group(&transaction, &group)?;
            transaction.commit()?;
            Ok((project, group))
        })
        .await
    }

    pub async fn acquire_project_edit_lease(
        &self,
        lease: ProjectEditLease,
    ) -> Result<ProjectLeaseAcquire> {
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let revision = transaction
                .query_row(
                    "SELECT revision FROM projects WHERE id = ?1",
                    [lease.project_id.to_string()],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .ok_or_else(|| StorageError::Domain(DomainError::NotFound("project".to_owned())))?;
            if revision != sql_u64(lease.base_revision)? {
                return Err(StorageError::Domain(DomainError::Conflict(format!(
                    "project is at revision {revision}, lease expects {}",
                    lease.base_revision
                ))));
            }
            let stale_before = lease.acquired_at - chrono::Duration::seconds(30);
            transaction.execute(
                "DELETE FROM project_edit_leases WHERE project_id = ?1 AND heartbeat_at < ?2",
                params![lease.project_id.to_string(), stale_before.to_rfc3339()],
            )?;
            let inserted = transaction.execute(
                "INSERT INTO project_edit_leases(\
                    project_id, id, session_id, turn_id, base_revision, acquired_at, heartbeat_at\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(project_id) DO NOTHING",
                params![
                    lease.project_id.to_string(),
                    lease.id.to_string(),
                    lease.session_id.to_string(),
                    lease.turn_id.to_string(),
                    sql_u64(lease.base_revision)?,
                    lease.acquired_at.to_rfc3339(),
                    lease.heartbeat_at.to_rfc3339(),
                ],
            )?;
            let outcome = if inserted == 1 {
                ProjectLeaseAcquire::Acquired(lease)
            } else {
                ProjectLeaseAcquire::Held(
                    read_project_edit_lease(&transaction, lease.project_id)?.ok_or_else(|| {
                        StorageError::Domain(DomainError::Conflict(
                            "project edit lease disappeared during acquisition".to_owned(),
                        ))
                    })?,
                )
            };
            transaction.commit()?;
            Ok(outcome)
        })
        .await
    }

    pub async fn get_project_edit_lease(
        &self,
        project_id: Uuid,
    ) -> Result<Option<ProjectEditLease>> {
        self.run(move |connection| read_project_edit_lease(connection, project_id))
            .await
    }

    pub async fn heartbeat_project_edit_lease(
        &self,
        project_id: Uuid,
        lease_id: Uuid,
        heartbeat_at: DateTime<Utc>,
    ) -> Result<bool> {
        self.run(move |connection| {
            Ok(connection.execute(
                "UPDATE project_edit_leases SET heartbeat_at = ?3 WHERE project_id = ?1 AND id = ?2",
                params![
                    project_id.to_string(),
                    lease_id.to_string(),
                    heartbeat_at.to_rfc3339(),
                ],
            )? == 1)
        })
        .await
    }

    pub async fn release_project_edit_lease(
        &self,
        project_id: Uuid,
        lease_id: Uuid,
    ) -> Result<bool> {
        self.run(move |connection| {
            Ok(connection.execute(
                "DELETE FROM project_edit_leases WHERE project_id = ?1 AND id = ?2",
                params![project_id.to_string(), lease_id.to_string()],
            )? == 1)
        })
        .await
    }

    pub async fn bind_project_recording_run(
        &self,
        recording_job_id: Uuid,
        project_id: Uuid,
    ) -> Result<()> {
        self.run(move |connection| {
            connection.execute(
                "INSERT INTO project_recording_runs(recording_job_id, project_id, created_at) \
                 VALUES (?1, ?2, ?3)",
                params![
                    recording_job_id.to_string(),
                    project_id.to_string(),
                    Utc::now().to_rfc3339(),
                ],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn get_project_recording_run(&self, recording_job_id: Uuid) -> Result<Option<Uuid>> {
        self.run(move |connection| {
            connection
                .query_row(
                    "SELECT project_id FROM project_recording_runs WHERE recording_job_id = ?1",
                    [recording_job_id.to_string()],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .map(|id| Uuid::parse_str(&id).map_err(|_| invalid_stored("recording Project id")))
                .transpose()
        })
        .await
    }
}

fn allocate_inserted_project_ids(patch: &mut ProjectPatch) {
    for operation in &mut patch.operations {
        match operation {
            vibe_cs_domain::ProjectEditOperation::InsertTrack { track, .. } => {
                track.id = Uuid::new_v4();
                for clip in &mut track.clips {
                    clip.id = Uuid::new_v4();
                }
            }
            vibe_cs_domain::ProjectEditOperation::InsertClip { clip, .. } => {
                clip.id = Uuid::new_v4();
            }
            _ => {}
        }
    }
}

fn authorize_project_patch(transaction: &Transaction<'_>, patch: &ProjectPatch) -> Result<()> {
    let lease = read_project_edit_lease(transaction, patch.project_id)?;
    match (&patch.author, lease) {
        (ProjectChangeAuthor::Human | ProjectChangeAuthor::System { .. }, None) => Ok(()),
        (ProjectChangeAuthor::Human, Some(_)) => Err(StorageError::Domain(DomainError::Conflict(
            "Project is read-only while an Agent Operation holds the edit lease".to_owned(),
        ))),
        (ProjectChangeAuthor::Agent { .. }, None) => Err(StorageError::Domain(
            DomainError::Conflict("Agent Project Patch has no edit lease".to_owned()),
        )),
        (
            ProjectChangeAuthor::Agent {
                session_id,
                turn_id,
            },
            Some(lease),
        ) if *session_id == lease.session_id && *turn_id == lease.turn_id => Ok(()),
        (ProjectChangeAuthor::Agent { .. }, Some(_)) => Err(StorageError::Domain(
            DomainError::Conflict("Agent Project Patch does not own the edit lease".to_owned()),
        )),
        (ProjectChangeAuthor::System { .. }, Some(_)) => Err(StorageError::Domain(
            DomainError::Conflict("Project has an active Agent edit lease".to_owned()),
        )),
    }
}

fn read_project(connection: &rusqlite::Connection, project_id: Uuid) -> Result<Option<Project>> {
    let document = connection
        .query_row(
            "SELECT document_json FROM projects WHERE id = ?1",
            [project_id.to_string()],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    document.map(|json| decode::<Project>(&json)).transpose()
}

fn insert_change_group(transaction: &Transaction<'_>, group: &ProjectChangeGroup) -> Result<()> {
    transaction.execute(
        "INSERT INTO project_change_groups(\
            id, project_id, from_revision, to_revision, status, reverts_change_group_id, \
            created_at, completed_at, document_json\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            group.id.to_string(),
            group.project_id.to_string(),
            sql_u64(group.from_revision)?,
            sql_u64(group.to_revision)?,
            match group.status {
                vibe_cs_domain::ProjectChangeGroupStatus::Completed => "completed",
                vibe_cs_domain::ProjectChangeGroupStatus::Interrupted => "interrupted",
            },
            group.reverts_change_group_id.map(|id| id.to_string()),
            group.created_at.to_rfc3339(),
            group.completed_at.to_rfc3339(),
            encode(group)?,
        ],
    )?;
    Ok(())
}

fn read_change_group(
    connection: &rusqlite::Connection,
    project_id: Uuid,
    change_group_id: Uuid,
) -> Result<Option<ProjectChangeGroup>> {
    let document = connection
        .query_row(
            "SELECT document_json FROM project_change_groups WHERE project_id = ?1 AND id = ?2",
            params![project_id.to_string(), change_group_id.to_string()],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    document
        .map(|json| decode::<ProjectChangeGroup>(&json))
        .transpose()
}

fn read_project_edit_lease(
    connection: &rusqlite::Connection,
    project_id: Uuid,
) -> Result<Option<ProjectEditLease>> {
    connection
        .query_row(
            "SELECT id, session_id, turn_id, base_revision, acquired_at, heartbeat_at \
             FROM project_edit_leases WHERE project_id = ?1",
            [project_id.to_string()],
            |row| {
                let id = row.get::<_, String>(0)?;
                let session_id = row.get::<_, String>(1)?;
                let turn_id = row.get::<_, String>(2)?;
                let base_revision = row.get::<_, i64>(3)?;
                let acquired_at = row.get::<_, String>(4)?;
                let heartbeat_at = row.get::<_, String>(5)?;
                Ok((
                    id,
                    session_id,
                    turn_id,
                    base_revision,
                    acquired_at,
                    heartbeat_at,
                ))
            },
        )
        .optional()?
        .map(
            |(id, session_id, turn_id, base_revision, acquired_at, heartbeat_at)| {
                Ok(ProjectEditLease {
                    id: Uuid::parse_str(&id).map_err(|_| invalid_stored("project lease id"))?,
                    project_id,
                    session_id: Uuid::parse_str(&session_id)
                        .map_err(|_| invalid_stored("project lease session id"))?,
                    turn_id: Uuid::parse_str(&turn_id)
                        .map_err(|_| invalid_stored("project lease turn id"))?,
                    base_revision: u64::try_from(base_revision)
                        .map_err(|_| invalid_stored("project lease base revision"))?,
                    acquired_at: DateTime::parse_from_rfc3339(&acquired_at)
                        .map_err(|_| invalid_stored("project lease acquired_at"))?
                        .with_timezone(&Utc),
                    heartbeat_at: DateTime::parse_from_rfc3339(&heartbeat_at)
                        .map_err(|_| invalid_stored("project lease heartbeat_at"))?
                        .with_timezone(&Utc),
                })
            },
        )
        .transpose()
}

fn invalid_stored(field: &str) -> StorageError {
    StorageError::Domain(DomainError::InvalidInput(format!(
        "stored {field} is invalid"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibe_cs_domain::{
        EditingDocument, ProjectChangeGroupStatus, ProjectEditOperation, TimelineClip,
        TimelineClipMaterial, TimelinePlacement, TimelineTrack, TrackKind, Transform,
    };

    fn project() -> Project {
        let project_id = Uuid::from_u128(100);
        let story_track_id = Uuid::from_u128(101);
        Project {
            id: project_id,
            name: "Unified project".to_owned(),
            revision: 1,
            document: EditingDocument {
                width: 1920,
                height: 1080,
                fps: 60,
                duration_seconds: 5.0,
                story_track_id,
                tracks: vec![TimelineTrack {
                    id: story_track_id,
                    name: "Story".to_owned(),
                    kind: TrackKind::Video,
                    order: 0,
                    muted: false,
                    locked: false,
                    hidden: false,
                    clips: vec![TimelineClip {
                        id: Uuid::from_u128(102),
                        name: "Imported clip".to_owned(),
                        capture_intent: None,
                        material: TimelineClipMaterial::Asset {
                            asset_id: Uuid::from_u128(103),
                            media_duration_seconds: 10.0,
                        },
                        placement: TimelinePlacement {
                            start: 0.0,
                            duration: 5.0,
                            source_in: 0.0,
                            source_out: 5.0,
                            speed: 1.0,
                            volume: 1.0,
                            enabled: true,
                        },
                        transform: Transform::default(),
                        effects: Vec::new(),
                        transition_in: None,
                        transition_out: None,
                        text: None,
                        metadata: serde_json::json!({}),
                        group_id: None,
                        link_group_id: None,
                        keyframes: Vec::new(),
                        speed_segments: Vec::new(),
                    }],
                }],
                markers: Vec::new(),
                settings: vibe_cs_domain::EditingDocumentSettings::default(),
            },
            created_at: DateTime::UNIX_EPOCH,
            updated_at: DateTime::UNIX_EPOCH,
        }
    }

    #[tokio::test]
    async fn project_patch_and_revert_share_one_revisioned_head() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let created = storage.create_project(project()).await.expect("create");
        let group_id = Uuid::from_u128(110);
        let (updated, group) = storage
            .apply_project_patch(
                ProjectPatch {
                    project_id: created.id,
                    base_revision: 1,
                    scope: ProjectPatchScope::Project,
                    author: ProjectChangeAuthor::Human,
                    reverts_change_group_id: None,
                    summary: "Rename project".to_owned(),
                    operations: vec![ProjectEditOperation::RenameProject {
                        name: "Renamed".to_owned(),
                    }],
                },
                group_id,
                DateTime::UNIX_EPOCH + chrono::Duration::seconds(1),
            )
            .await
            .expect("patch");
        assert_eq!(updated.revision, 2);
        assert_eq!(updated.name, "Renamed");
        assert_eq!(group.status, ProjectChangeGroupStatus::Completed);

        let (reverted, inverse) = storage
            .revert_project_change_group(
                created.id,
                group_id,
                2,
                ProjectChangeAuthor::Human,
                Uuid::from_u128(111),
                DateTime::UNIX_EPOCH + chrono::Duration::seconds(2),
            )
            .await
            .expect("revert");
        assert_eq!(reverted.revision, 3);
        assert_eq!(reverted.name, "Unified project");
        assert_eq!(inverse.reverts_change_group_id, Some(group_id));
    }

    #[tokio::test]
    async fn one_project_edit_lease_excludes_another_agent_turn() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let created = storage.create_project(project()).await.expect("create");
        let first = ProjectEditLease {
            id: Uuid::from_u128(120),
            project_id: created.id,
            session_id: Uuid::from_u128(121),
            turn_id: Uuid::from_u128(122),
            base_revision: 1,
            acquired_at: DateTime::UNIX_EPOCH,
            heartbeat_at: DateTime::UNIX_EPOCH,
        };
        assert!(matches!(
            storage
                .acquire_project_edit_lease(first.clone())
                .await
                .expect("first lease"),
            ProjectLeaseAcquire::Acquired(_)
        ));
        let second = ProjectEditLease {
            id: Uuid::from_u128(123),
            turn_id: Uuid::from_u128(124),
            ..first.clone()
        };
        assert_eq!(
            storage
                .acquire_project_edit_lease(second)
                .await
                .expect("held lease"),
            ProjectLeaseAcquire::Held(first.clone())
        );
        assert!(
            storage
                .release_project_edit_lease(created.id, first.id)
                .await
                .expect("release")
        );
    }
}
