//! The Agent session layer: conversation threads, the bidirectional
//! session/object reference index, the server-authoritative plan revision and
//! the conversation retention surface.
//!
//! Everything here is an ordinary axum route reached through the single
//! `desktop_call` bridge. No capability in this module streams, so none of them
//! needs a dedicated Tauri command.

use std::path::Path as FilePath;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use vibe_cs_domain::{
    AGENT_SESSION_MAX_TITLE_CHARS, AgentObjectKind, AgentObjectRef, AgentObjectRefTouch,
    AgentObjectSessionRef, AgentPlan, AgentPlanCreate, AgentPlanEdit, AgentPlanQuery,
    AgentPlanRestore, AgentPlanStatus, AgentPlanSummary, AgentPlanUpdate, AgentSession,
    AgentSessionEntry, AgentSessionEntryDraft, AgentSessionExport, AgentSessionPage,
    AgentSessionPurge, AgentSessionQuery, AgentSessionStorageStats, AgentWorkspaceSettings,
    EditorProject, JobStatus, RecordingJob,
};
use vibe_cs_storage::ExportJobRecord;

use crate::{ApiError, ApiJson, ApiQuery, ApiResult, AppState};

/// How many rows of one kind the reference picker shows. The picker is a
/// shortlist of what is currently in progress, not a directory.
const REFERENCE_PICKER_LIMIT: usize = 20;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/agent/sessions",
            get(list_sessions).post(create_session),
        )
        .route(
            "/api/agent/sessions/{id}",
            get(get_session)
                .patch(rename_session)
                .delete(delete_session),
        )
        .route("/api/agent/sessions/{id}/entries", post(append_entry))
        .route("/api/agent/sessions/{id}/refs", post(touch_object_ref))
        .route(
            "/api/agent/objects/{kind}/{id}/sessions",
            get(list_object_sessions),
        )
        .route("/api/agent/plans", get(list_plans).post(create_plan))
        .route("/api/agent/plans/{id}", get(get_plan).patch(edit_plan))
        .route("/api/agent/plans/{id}/restore", post(restore_plan))
        .route("/api/agent/workspace/referencable", get(list_referencable))
        .route(
            "/api/agent/workspace/settings",
            get(get_workspace_settings).put(set_workspace_settings),
        )
        .route(
            "/api/agent/workspace/storage",
            get(get_session_storage).delete(clear_sessions),
        )
        .route("/api/agent/workspace/storage/export", get(export_sessions))
        .route(
            "/api/agent/workspace/storage/retention",
            post(apply_session_retention),
        )
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionTitleBody {
    title: String,
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/// Contract gap 1: the drawer's "14 sessions" count plus its search field.
async fn list_sessions(
    State(state): State<AppState>,
    ApiQuery(query): ApiQuery<AgentSessionQuery>,
) -> ApiResult<Json<AgentSessionPage>> {
    query.validate()?;
    Ok(Json(state.storage.list_agent_sessions(query).await?))
}

async fn create_session(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<SessionTitleBody>,
) -> ApiResult<(StatusCode, Json<AgentSession>)> {
    let session = state.storage.create_agent_session(body.title).await?;
    Ok((StatusCode::CREATED, Json(session)))
}

async fn get_session(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<AgentSession>> {
    state
        .storage
        .get_agent_session(id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("agent session"))
}

/// Contract gap 2: a session carries its own title and can be renamed.
async fn rename_session(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    ApiJson(body): ApiJson<SessionTitleBody>,
) -> ApiResult<Json<AgentSession>> {
    if body.title.trim().is_empty() {
        return Err(ApiError::invalid(format!(
            "session title must contain 1 to {AGENT_SESSION_MAX_TITLE_CHARS} characters"
        )));
    }
    state
        .storage
        .rename_agent_session(id, body.title)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("agent session"))
}

/// Contract gap 3: deleting a session removes the conversation only. The plans,
/// recording tasks, editor projects and outputs it touched keep their own
/// lifecycles, and a plan's origin trail keeps this session's identity.
async fn delete_session(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    if state.storage.delete_agent_session(id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("agent session"))
    }
}

async fn append_entry(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    ApiJson(draft): ApiJson<AgentSessionEntryDraft>,
) -> ApiResult<(StatusCode, Json<AgentSessionEntry>)> {
    let entry = state
        .storage
        .append_agent_session_entry(id, draft)
        .await?
        .ok_or_else(|| ApiError::not_found("agent session"))?;
    Ok((StatusCode::CREATED, Json(entry)))
}

/// Contract gap 4, forward direction: record that this session touched an
/// object so the drawer can list it underneath the thread.
async fn touch_object_ref(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    ApiJson(touch): ApiJson<AgentObjectRefTouch>,
) -> ApiResult<Json<AgentObjectRef>> {
    state
        .storage
        .touch_agent_object_ref(id, touch)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("agent session"))
}

/// Contract gap 4, reverse direction: which sessions touched one object.
async fn list_object_sessions(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, Uuid)>,
) -> ApiResult<Json<Vec<AgentObjectSessionRef>>> {
    let kind = AgentObjectKind::from_str_exact(&kind)
        .ok_or_else(|| ApiError::invalid(format!("unknown agent object kind {kind}")))?;
    Ok(Json(
        state.storage.list_agent_object_sessions(kind, id).await?,
    ))
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

async fn list_plans(
    State(state): State<AppState>,
    ApiQuery(query): ApiQuery<AgentPlanQuery>,
) -> ApiResult<Json<Vec<AgentPlanSummary>>> {
    query.validate()?;
    Ok(Json(state.storage.list_agent_plans(query).await?))
}

/// Contracts gaps 6, 7 and 10 read side: the plan carries its authoritative
/// revision, its change-origin trail and the immutable Agent baseline.
async fn get_plan(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<AgentPlan>> {
    state
        .storage
        .get_agent_plan(id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("agent plan"))
}

async fn create_plan(
    State(state): State<AppState>,
    ApiJson(create): ApiJson<AgentPlanCreate>,
) -> ApiResult<(StatusCode, Json<AgentPlan>)> {
    let plan = state.storage.create_agent_plan(create).await?;
    Ok((StatusCode::CREATED, Json(plan)))
}

/// Contract gaps 5 and 6 write side.
///
/// One manual edit is one conditional write. It bumps the plan revision, adds
/// an origin entry and injects the `workspace_edit` notice into the editing
/// session - all inside a single transaction. The notice is produced here
/// rather than accepted from the caller because its revision must be the one
/// this write actually produced; a client-authored revision would reintroduce
/// exactly the silent overwrite this route exists to prevent.
async fn edit_plan(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    ApiJson(edit): ApiJson<AgentPlanEdit>,
) -> ApiResult<Json<AgentPlan>> {
    if edit.plan_id != id {
        return Err(ApiError::invalid(
            "the plan identity in the path and the body must match",
        ));
    }
    plan_update(state.storage.apply_agent_plan_edit(edit).await?)
}

/// Contract gap 10: revert to the version the Agent originally produced. The
/// revert is an ordinary conditional edit, so it also bumps the revision and
/// reports one workspace edit.
async fn restore_plan(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    ApiJson(restore): ApiJson<AgentPlanRestore>,
) -> ApiResult<Json<AgentPlan>> {
    if restore.plan_id != id {
        return Err(ApiError::invalid(
            "the plan identity in the path and the body must match",
        ));
    }
    plan_update(state.storage.restore_agent_plan_baseline(restore).await?)
}

fn plan_update(update: AgentPlanUpdate) -> ApiResult<Json<AgentPlan>> {
    match update {
        AgentPlanUpdate::Updated { plan } => Ok(Json(*plan)),
        AgentPlanUpdate::Conflict { current_revision } => Err(ApiError::new(
            StatusCode::CONFLICT,
            "plan_revision_conflict",
            format!("the plan has already moved on to revision {current_revision}"),
        )),
        AgentPlanUpdate::NotFound => Err(ApiError::not_found("agent plan")),
    }
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/// One row of the "currently in progress" reference picker.
#[derive(Debug, Serialize)]
struct WorkspaceReference {
    /// The persisted [`AgentObjectKind`] discriminator, so the value can be sent
    /// straight back when the session records the reference.
    kind: &'static str,
    id: Uuid,
    label: String,
    status: &'static str,
    progress_percent: Option<u8>,
    item_count: Option<u32>,
    error: Option<String>,
    updated_at: DateTime<Utc>,
}

/// Contract gap 8: the cross-source query behind "what is going on in the
/// workspace right now", answered from four independent lifecycles.
#[derive(Debug, Serialize)]
struct WorkspaceReferences {
    /// Plans waiting for the user to confirm them.
    pending_plans: Vec<WorkspaceReference>,
    /// Recording tasks that have not reached a terminal state.
    running_recording_tasks: Vec<WorkspaceReference>,
    /// Editor projects, newest first.
    edit_projects: Vec<WorkspaceReference>,
    /// Exports that failed and are still worth talking about.
    failed_outputs: Vec<WorkspaceReference>,
}

async fn list_referencable(State(state): State<AppState>) -> ApiResult<Json<WorkspaceReferences>> {
    let plans = state
        .storage
        .list_agent_plans(AgentPlanQuery {
            status: Some(AgentPlanStatus::AwaitingConfirmation),
            limit: u32::try_from(REFERENCE_PICKER_LIMIT).ok(),
        })
        .await?;
    let recording_jobs = state.storage.list_recording_jobs().await?;
    let editor_projects = state.storage.list_editor_projects().await?;
    let export_jobs = state.storage.list_export_jobs(None).await?;

    Ok(Json(WorkspaceReferences {
        pending_plans: plans.into_iter().map(plan_reference).collect(),
        running_recording_tasks: recording_jobs
            .into_iter()
            .filter(|job| !job.status.is_terminal())
            .take(REFERENCE_PICKER_LIMIT)
            .map(recording_reference)
            .collect(),
        edit_projects: editor_projects
            .into_iter()
            .take(REFERENCE_PICKER_LIMIT)
            .map(editor_reference)
            .collect(),
        failed_outputs: export_jobs
            .into_iter()
            .filter(|record| record.job.status == JobStatus::Failed)
            .take(REFERENCE_PICKER_LIMIT)
            .map(export_reference)
            .collect(),
    }))
}

fn plan_reference(plan: AgentPlanSummary) -> WorkspaceReference {
    WorkspaceReference {
        kind: AgentObjectKind::Plan.as_str(),
        id: plan.id,
        label: plan.title,
        status: plan.status.as_str(),
        progress_percent: None,
        item_count: Some(plan.shot_count),
        error: None,
        updated_at: plan.updated_at,
    }
}

fn recording_reference(job: RecordingJob) -> WorkspaceReference {
    let RecordingJob {
        id,
        status,
        items,
        current_index,
        progress,
        updated_at,
        ..
    } = job;
    let item_count = u32::try_from(items.len()).unwrap_or(u32::MAX);
    // The item being recorded names the task; a finished or empty job falls back
    // to the first item and then to the bare identity.
    let index = if current_index < items.len() {
        current_index
    } else {
        0
    };
    let label = items
        .into_iter()
        .nth(index)
        .map_or_else(|| id.to_string(), |item| item.title);
    WorkspaceReference {
        kind: AgentObjectKind::RecordingTask.as_str(),
        id,
        label,
        status: job_status_text(status),
        progress_percent: Some(progress_percent(progress)),
        item_count: Some(item_count),
        error: None,
        updated_at,
    }
}

fn editor_reference(project: EditorProject) -> WorkspaceReference {
    let clip_count = project
        .tracks
        .iter()
        .map(|track| track.clips.len())
        .sum::<usize>();
    WorkspaceReference {
        kind: AgentObjectKind::EditProject.as_str(),
        id: project.id,
        label: project.name,
        status: "open",
        progress_percent: None,
        item_count: Some(u32::try_from(clip_count).unwrap_or(u32::MAX)),
        error: None,
        updated_at: project.updated_at,
    }
}

fn export_reference(record: ExportJobRecord) -> WorkspaceReference {
    let label = FilePath::new(&record.job.output_path)
        .file_name()
        .map_or_else(
            || record.job.output_path.clone(),
            |name| name.to_string_lossy().into_owned(),
        );
    WorkspaceReference {
        kind: AgentObjectKind::Output.as_str(),
        id: record.job.id,
        label,
        status: job_status_text(record.job.status),
        progress_percent: Some(progress_percent(record.job.progress)),
        item_count: None,
        error: record.job.error,
        updated_at: record.job.updated_at,
    }
}

/// The canonical discriminator [`JobStatus`] serializes to.
const fn job_status_text(status: JobStatus) -> &'static str {
    match status {
        JobStatus::Queued => "queued",
        JobStatus::Preparing => "preparing",
        JobStatus::Running => "running",
        JobStatus::Cancelling => "cancelling",
        JobStatus::Completed => "completed",
        JobStatus::Failed => "failed",
        JobStatus::Cancelled => "cancelled",
    }
}

/// Job progress is a 0..=1 ratio; anything outside that is clamped rather than
/// reported as a nonsensical percentage.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "the value is clamped into 0..=100 before the cast"
)]
fn progress_percent(progress: f64) -> u8 {
    if progress.is_nan() {
        return 0;
    }
    (progress * 100.0).clamp(0.0, 100.0).round() as u8
}

/// Contract gap 9 read side.
async fn get_workspace_settings(
    State(state): State<AppState>,
) -> ApiResult<Json<AgentWorkspaceSettings>> {
    Ok(Json(state.storage.get_agent_workspace_settings().await?))
}

async fn set_workspace_settings(
    State(state): State<AppState>,
    ApiJson(settings): ApiJson<AgentWorkspaceSettings>,
) -> ApiResult<Json<AgentWorkspaceSettings>> {
    settings.validate()?;
    Ok(Json(
        state.storage.set_agent_workspace_settings(settings).await?,
    ))
}

async fn get_session_storage(
    State(state): State<AppState>,
) -> ApiResult<Json<AgentSessionStorageStats>> {
    Ok(Json(state.storage.agent_session_storage_stats().await?))
}

async fn export_sessions(State(state): State<AppState>) -> ApiResult<Json<AgentSessionExport>> {
    Ok(Json(state.storage.export_agent_sessions().await?))
}

/// Runs the configured retention policy. Only conversations are removed.
async fn apply_session_retention(
    State(state): State<AppState>,
) -> ApiResult<Json<AgentSessionPurge>> {
    Ok(Json(AgentSessionPurge {
        removed_sessions: state.storage.apply_agent_session_retention().await?,
    }))
}

/// Removes every conversation. Plans, recording tasks, editor projects and
/// outputs are untouched, exactly as with a single session delete.
async fn clear_sessions(State(state): State<AppState>) -> ApiResult<Json<AgentSessionPurge>> {
    Ok(Json(AgentSessionPurge {
        removed_sessions: state.storage.clear_agent_sessions().await?,
    }))
}

#[cfg(test)]
mod tests {
    use axum::{
        Router,
        body::{Body, to_bytes},
        http::{Method, Request, header},
    };
    use serde_json::{Value, json};
    use tower::ServiceExt as _;
    use vibe_cs_domain::{ExportJob, RecordingRequest};
    use vibe_cs_storage::Storage;

    use super::*;

    fn dispatcher(storage: Storage) -> (Router, tempfile::TempDir) {
        let directory = tempfile::tempdir().expect("temporary directory");
        let state = AppState::new(storage, directory.path().join("data"));
        (crate::build_dispatcher(state), directory)
    }

    async fn call(router: &Router, method: Method, uri: &str, body: Option<Value>) -> (u16, Value) {
        let mut request = Request::builder().method(method).uri(uri);
        if body.is_some() {
            request = request.header(header::CONTENT_TYPE, "application/json");
        }
        let response = router
            .clone()
            .oneshot(
                request
                    .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                    .expect("request"),
            )
            .await
            .expect("response");
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), 8 * 1024 * 1024)
            .await
            .expect("body");
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).expect("json body")
        };
        (status, value)
    }

    fn shot(title: &str, seconds: f64) -> Value {
        json!({
            "id": Uuid::new_v4(),
            "title": title,
            "kind": "tracking",
            "view": "observer",
            "start_tick": 148_812,
            "end_tick": 149_132,
            "duration_seconds": seconds,
            "rationale": "沿他的真实移动轴跟到 A 大道",
            "evidence_refs": [],
            "risks": [],
            "source": "agent",
            "removed_by": null,
            "params": {}
        })
    }

    async fn seeded_session_and_plan(router: &Router) -> (Uuid, Uuid) {
        let (status, session) = call(
            router,
            Method::POST,
            "/api/agent/sessions",
            Some(json!({ "title": "Kael 的 1v3" })),
        )
        .await;
        assert_eq!(status, 201);
        let session_id: Uuid = serde_json::from_value(session["id"].clone()).expect("session id");

        let (status, plan) = call(
            router,
            Method::POST,
            "/api/agent/plans",
            Some(json!({
                "title": "Kael Mirage 1v3",
                "status": "awaiting_confirmation",
                "shots": [shot("02 跟随突破", 8.5)],
                "origin": {
                    "session_id": session_id,
                    "session_title": "Kael 的 1v3",
                    "summary": "生成初版方案 · 1 个镜头"
                }
            })),
        )
        .await;
        assert_eq!(status, 201);
        assert_eq!(plan["revision"], 1);
        let plan_id: Uuid = serde_json::from_value(plan["id"].clone()).expect("plan id");
        (session_id, plan_id)
    }

    #[tokio::test]
    async fn session_routes_search_rename_and_delete_without_reaching_referenced_objects() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let (router, _directory) = dispatcher(storage);
        let (session_id, plan_id) = seeded_session_and_plan(&router).await;

        let (status, reference) = call(
            &router,
            Method::POST,
            &format!("/api/agent/sessions/{session_id}/refs"),
            Some(json!({
                "kind": "plan",
                "id": plan_id,
                "label": "方案 #P-118",
                "summary": "改过 1 次",
                "status": "等待确认"
            })),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(reference["touch_count"], 1);

        let (status, page) = call(&router, Method::GET, "/api/agent/sessions?q=kael", None).await;
        assert_eq!(status, 200);
        assert_eq!(page["total"], 1);
        assert_eq!(page["items"][0]["refs"][0]["id"], json!(plan_id));

        let (status, page) = call(&router, Method::GET, "/api/agent/sessions?q=zzz", None).await;
        assert_eq!(status, 200);
        assert_eq!(page["total"], 0);

        // The reverse index answers "which sessions touched this plan".
        let (status, sessions) = call(
            &router,
            Method::GET,
            &format!("/api/agent/objects/plan/{plan_id}/sessions"),
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(sessions[0]["session_id"], json!(session_id));

        let (status, renamed) = call(
            &router,
            Method::PATCH,
            &format!("/api/agent/sessions/{session_id}"),
            Some(json!({ "title": "Mirage 收尾" })),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(renamed["title"], "Mirage 收尾");

        let (status, _) = call(
            &router,
            Method::DELETE,
            &format!("/api/agent/sessions/{session_id}"),
            None,
        )
        .await;
        assert_eq!(status, 204);

        // Deleting the conversation never reaches the plan, and the plan keeps
        // the identity and title of the session as captured at edit time.
        let (status, plan) = call(
            &router,
            Method::GET,
            &format!("/api/agent/plans/{plan_id}"),
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(plan["origin"][0]["session_id"], json!(session_id));
        assert_eq!(plan["origin"][0]["session_title"], "Kael 的 1v3");

        let (status, _) = call(
            &router,
            Method::DELETE,
            &format!("/api/agent/sessions/{session_id}"),
            None,
        )
        .await;
        assert_eq!(status, 404);
    }

    #[tokio::test]
    async fn a_plan_edit_bumps_the_revision_notifies_the_session_and_rejects_a_stale_base() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let (router, _directory) = dispatcher(storage);
        let (session_id, plan_id) = seeded_session_and_plan(&router).await;

        let edit = json!({
            "plan_id": plan_id,
            "expected_revision": 1,
            "status": "awaiting_confirmation",
            "shots": [shot("02 跟随突破", 5.0)],
            "origin": {
                "session_id": session_id,
                "session_title": "Kael 的 1v3",
                "summary": "镜头 02 由 8.5 秒改为 5.0 秒"
            },
            "changes": [{
                "shot": 2,
                "op": "updated",
                "field": "duration",
                "from": "8.5s",
                "to": "5.0s"
            }],
            "note": null
        });

        let (status, updated) = call(
            &router,
            Method::PATCH,
            &format!("/api/agent/plans/{plan_id}"),
            Some(edit.clone()),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(updated["revision"], 2);

        // The workspace edit notice is the session's third entry kind, and it
        // carries the revision this write produced rather than a client value.
        let (status, session) = call(
            &router,
            Method::GET,
            &format!("/api/agent/sessions/{session_id}"),
            None,
        )
        .await;
        assert_eq!(status, 200);
        let notice = session["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .find(|entry| entry["kind"] == "workspace_edit")
            .expect("one workspace edit entry");
        assert_eq!(notice["notice"]["revision"], 2);
        assert_eq!(notice["notice"]["by"], "user");
        assert_eq!(notice["notice"]["object"]["kind"], "plan");
        assert_eq!(notice["notice"]["changes"][0]["to"], "5.0s");

        // A second session still holding revision 1 cannot silently overwrite it.
        let (status, conflict) = call(
            &router,
            Method::PATCH,
            &format!("/api/agent/plans/{plan_id}"),
            Some(edit),
        )
        .await;
        assert_eq!(status, 409);
        assert_eq!(conflict["code"], "plan_revision_conflict");

        // Restoring the Agent baseline is an ordinary conditional edit.
        let (status, restored) = call(
            &router,
            Method::POST,
            &format!("/api/agent/plans/{plan_id}/restore"),
            Some(json!({
                "plan_id": plan_id,
                "expected_revision": 2,
                "origin": {
                    "session_id": session_id,
                    "session_title": "Kael 的 1v3",
                    "summary": "还原为 Agent 版本"
                },
                "note": null
            })),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(restored["revision"], 3);
        assert_eq!(restored["shots"][0]["duration_seconds"], 8.5);
        assert_eq!(restored["agent_baseline"]["revision"], 1);
    }

    #[tokio::test]
    async fn the_reference_picker_answers_from_four_independent_sources() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let now = Utc::now();
        let running = storage
            .put_recording_job(RecordingJob {
                id: Uuid::new_v4(),
                retry_of: None,
                status: JobStatus::Running,
                items: vec![RecordingRequest {
                    id: Some(Uuid::new_v4()),
                    demo_id: Uuid::new_v4(),
                    highlight_id: None,
                    player_id: "76561198000000000".to_owned(),
                    title: "Kael 的 1v3".to_owned(),
                    start_tick: 148_812,
                    end_tick: 149_132,
                    pre_roll_seconds: 1.0,
                    post_roll_seconds: 1.0,
                    victim_pov: false,
                    camera_style: vibe_cs_domain::HlaeCameraStyle::Tracking,
                }],
                current_index: 0,
                progress: 0.42,
                message: String::new(),
                outputs: Vec::new(),
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("running recording job");
        storage
            .put_recording_job(RecordingJob {
                id: Uuid::new_v4(),
                retry_of: None,
                status: JobStatus::Completed,
                items: Vec::new(),
                current_index: 0,
                progress: 1.0,
                message: String::new(),
                outputs: Vec::new(),
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("completed recording job");
        let project = storage
            .put_editor_project(EditorProject {
                id: Uuid::new_v4(),
                name: "Aurora 赛点集锦".to_owned(),
                width: 1920,
                height: 1080,
                fps: 60,
                duration_seconds: 12.5,
                tracks: Vec::new(),
                markers: Vec::new(),
                settings: Value::Object(serde_json::Map::new()),
                revision: 1,
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("editor project");
        let failed_export = Uuid::new_v4();
        storage
            .put_export_job(ExportJobRecord {
                kind: "editor".to_owned(),
                job: ExportJob {
                    id: failed_export,
                    project_id: project.id,
                    status: JobStatus::Failed,
                    progress: 0.65,
                    output_path: "C:/outputs/Aurora_final.mp4".to_owned(),
                    error: Some("ffmpeg exited with 1".to_owned()),
                    created_at: now,
                    updated_at: now,
                },
            })
            .await
            .expect("failed export job");

        let (router, _directory) = dispatcher(storage);
        // One plan awaiting confirmation, plus one draft that must not appear.
        let (session_id, plan_id) = seeded_session_and_plan(&router).await;
        let (status, _) = call(
            &router,
            Method::POST,
            "/api/agent/plans",
            Some(json!({
                "title": "草稿",
                "status": "draft",
                "shots": [],
                "origin": null
            })),
        )
        .await;
        assert_eq!(status, 201);
        assert!(!session_id.is_nil());

        let (status, references) = call(
            &router,
            Method::GET,
            "/api/agent/workspace/referencable",
            None,
        )
        .await;
        assert_eq!(status, 200);

        let pending = references["pending_plans"].as_array().expect("plans");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0]["id"], json!(plan_id));
        assert_eq!(pending[0]["kind"], "plan");
        assert_eq!(pending[0]["status"], "awaiting_confirmation");
        assert_eq!(pending[0]["item_count"], 1);

        let recordings = references["running_recording_tasks"]
            .as_array()
            .expect("recording tasks");
        assert_eq!(recordings.len(), 1);
        assert_eq!(recordings[0]["id"], json!(running.id));
        assert_eq!(recordings[0]["kind"], "recording_task");
        assert_eq!(recordings[0]["label"], "Kael 的 1v3");
        assert_eq!(recordings[0]["progress_percent"], 42);

        let projects = references["edit_projects"].as_array().expect("projects");
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0]["kind"], "edit_project");
        assert_eq!(projects[0]["label"], "Aurora 赛点集锦");

        let outputs = references["failed_outputs"].as_array().expect("outputs");
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0]["id"], json!(failed_export));
        assert_eq!(outputs[0]["kind"], "output");
        assert_eq!(outputs[0]["label"], "Aurora_final.mp4");
        assert_eq!(outputs[0]["error"], "ffmpeg exited with 1");
    }

    #[tokio::test]
    async fn storage_export_and_clear_cover_conversations_only() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let (router, _directory) = dispatcher(storage);
        let (session_id, plan_id) = seeded_session_and_plan(&router).await;
        let (status, _) = call(
            &router,
            Method::POST,
            &format!("/api/agent/sessions/{session_id}/entries"),
            Some(json!({ "kind": "user", "content": "把它压到 30 秒以内" })),
        )
        .await;
        assert_eq!(status, 201);

        let (status, settings) = call(
            &router,
            Method::PUT,
            "/api/agent/workspace/settings",
            Some(json!({
                "session_retention": { "mode": "recent_count", "count": 50 },
                "take_limit": 5
            })),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(settings["session_retention"]["count"], 50);

        let (status, invalid) = call(
            &router,
            Method::PUT,
            "/api/agent/workspace/settings",
            Some(json!({
                "session_retention": { "mode": "all" },
                "take_limit": 0
            })),
        )
        .await;
        assert_eq!(status, 400);
        assert_eq!(invalid["code"], "invalid_input");

        let (status, occupancy) =
            call(&router, Method::GET, "/api/agent/workspace/storage", None).await;
        assert_eq!(status, 200);
        assert_eq!(occupancy["session_count"], 1);
        assert_eq!(occupancy["entry_count"], 1);
        assert_eq!(occupancy["plan_count"], 1);
        assert!(occupancy["conversation_bytes"].as_u64().expect("bytes") > 0);
        assert!(occupancy["plan_bytes"].as_u64().expect("plan bytes") > 0);

        let (status, export) = call(
            &router,
            Method::GET,
            "/api/agent/workspace/storage/export",
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(export["sessions"].as_array().expect("sessions").len(), 1);
        assert_eq!(export["sessions"][0]["entries"][0]["kind"], "user");
        assert_eq!(export["settings"]["take_limit"], 5);

        let (status, purge) = call(
            &router,
            Method::DELETE,
            "/api/agent/workspace/storage",
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(purge["removed_sessions"], 1);

        let (status, page) = call(&router, Method::GET, "/api/agent/sessions", None).await;
        assert_eq!(status, 200);
        assert_eq!(page["total"], 0);

        // Clearing conversations leaves the plan and its origin trail intact.
        let (status, plan) = call(
            &router,
            Method::GET,
            &format!("/api/agent/plans/{plan_id}"),
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(plan["origin"][0]["session_title"], "Kael 的 1v3");

        let (status, purged) = call(
            &router,
            Method::POST,
            "/api/agent/workspace/storage/retention",
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(purged["removed_sessions"], 0);
    }

    #[tokio::test]
    async fn the_plan_list_query_parses_its_status_filter_and_bounds_its_limit() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let (router, _directory) = dispatcher(storage);
        let (_session_id, plan_id) = seeded_session_and_plan(&router).await;

        let (status, plans) = call(
            &router,
            Method::GET,
            "/api/agent/plans?status=awaiting_confirmation&limit=10",
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(plans.as_array().expect("plans").len(), 1);
        assert_eq!(plans[0]["id"], json!(plan_id));
        assert_eq!(plans[0]["shot_count"], 1);
        assert_eq!(plans[0]["origin_count"], 1);

        let (status, plans) =
            call(&router, Method::GET, "/api/agent/plans?status=draft", None).await;
        assert_eq!(status, 200);
        assert!(plans.as_array().expect("plans").is_empty());

        let (status, error) = call(&router, Method::GET, "/api/agent/plans?limit=0", None).await;
        assert_eq!(status, 400);
        assert_eq!(error["code"], "invalid_input");

        // The path identity is authoritative: a mismatched body is rejected.
        let (status, error) = call(
            &router,
            Method::PATCH,
            &format!("/api/agent/plans/{plan_id}"),
            Some(json!({
                "plan_id": Uuid::new_v4(),
                "expected_revision": 1,
                "status": "draft",
                "shots": [],
                "origin": {
                    "session_id": Uuid::new_v4(),
                    "session_title": "别的会话",
                    "summary": "改动"
                },
                "changes": [],
                "note": null
            })),
        )
        .await;
        assert_eq!(status, 400);
        assert_eq!(error["code"], "invalid_input");
    }
}
