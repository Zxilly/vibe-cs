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
    response::{IntoResponse as _, Response},
    routing::{delete, get, post},
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
use ts_rs::TS;

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
            "/api/agent/sessions/{id}/refs/{kind}/{object_id}",
            delete(delete_object_ref),
        )
        .route(
            "/api/agent/objects/{kind}/{id}/sessions",
            get(list_object_sessions),
        )
        .route("/api/agent/plans", get(list_plans).post(create_plan))
        .route("/api/agent/plans/{id}", get(get_plan).patch(edit_plan))
        .route("/api/agent/plans/{id}/restore", post(restore_plan))
        .route("/api/agent/plans/{id}/recording-plan", post(plan_recording))
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

/// §10.5 gap 9: a reference could be added and never taken back, so the
/// artboard's 「取消引用」 button had nothing to call and was not drawn.
///
/// The response is `204` whether or not a reference was there to remove. That
/// is deliberate: pressing 「取消引用」 twice, or on a reference another window
/// already removed, is not a failure — the caller asked for the reference to be
/// gone and it is gone. A 404 is kept for the one thing that really is missing,
/// the session itself.
async fn delete_object_ref(
    State(state): State<AppState>,
    Path((id, kind, object_id)): Path<(Uuid, String, Uuid)>,
) -> ApiResult<StatusCode> {
    let kind = AgentObjectKind::from_str_exact(&kind)
        .ok_or_else(|| ApiError::invalid(format!("unknown agent object kind {kind}")))?;
    let removed = state
        .storage
        .delete_agent_object_ref(id, kind, object_id)
        .await?
        .ok_or_else(|| ApiError::not_found("agent session"))?;
    if removed {
        state
            .events
            .publish("agent_session", "ref_removed", Some(id));
    }
    Ok(StatusCode::NO_CONTENT)
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

/// The plan still holds shots that name no footage. Closed set, so the page can
/// look the reason up rather than read the English sentence.
const AGENT_PLAN_SHOTS_UNBOUND: &str = "agent_plan_shots_unbound";
/// The plan holds nothing that could be recorded at all.
const AGENT_PLAN_NOT_RECORDABLE: &str = "agent_plan_not_recordable";

/// One shot that keeps the plan from becoming a recording queue.
#[derive(Debug, Serialize)]
struct UnboundPlanShot {
    id: Uuid,
    title: String,
}

/// The 422 body of [`plan_recording`].
///
/// It is a superset of [`vibe_cs_domain::ErrorBody`]: `code` and `message` sit
/// where every other error in this application puts them, and `shots` names the
/// exact cards that are still unbound, because "some shots are not bound" is
/// not something a user can act on.
///
/// # Known transport limitation
///
/// The desktop bridge (`apps/desktop/src-tauri/src/bridge.rs`,
/// `DesktopCommandError::from_problem`) flattens every error body to
/// `{status, code, message}`, so `shots` does not reach the renderer today.
/// Until that changes the page must read the same fact from the plan it is
/// already displaying - a shot whose `recording` is `null` is an unbound shot -
/// and use `code` to decide what to say about it.
#[derive(Debug, Serialize)]
struct UnrecordablePlan {
    code: &'static str,
    message: String,
    shots: Vec<UnboundPlanShot>,
}

impl UnrecordablePlan {
    fn response(self) -> Response {
        (StatusCode::UNPROCESSABLE_ENTITY, Json(self)).into_response()
    }
}

/// Design §10.6 gap 1: the one step from an Agent plan to a recording plan.
///
/// The plan is what the recording page names at its top ("from plan #P-118"),
/// so this route answers with exactly the same document as
/// `/api/recording/plan`: the page after this call is the same page, whichever
/// door it was reached through. Nothing here reimplements the queue - the
/// assembled requests go straight into
/// [`super::recording::create_recording_plan`], which owns the director
/// orchestration, the duration estimate and the plan lease.
///
/// The two 422 answers exist so the page never has to explain a message written
/// for a different screen: told only "recording queue must contain at least one
/// executable item", a user looking at four shot cards has no way to learn that
/// none of them names a Demo.
async fn plan_recording(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Response> {
    let plan = state
        .storage
        .get_agent_plan(id)
        .await?
        .ok_or_else(|| ApiError::not_found("agent plan"))?;
    // A soft-removed shot stays in the plan so the removal can be undone. It is
    // not material to record, and honouring `removed_by` here is what keeps
    // "undo" and "record" from disagreeing about what the plan contains.
    let recordable = plan
        .shots
        .iter()
        .filter(|shot| shot.removed_by.is_none())
        .collect::<Vec<_>>();
    if recordable.is_empty() {
        let message = if plan.shots.is_empty() {
            "this plan contains no shot to record".to_owned()
        } else {
            format!(
                "this plan has no shot left to record: all {} of its shots are removed",
                plan.shots.len()
            )
        };
        return Ok(UnrecordablePlan {
            code: AGENT_PLAN_NOT_RECORDABLE,
            message,
            shots: Vec::new(),
        }
        .response());
    }
    let unbound = recordable
        .iter()
        .filter(|shot| shot.recording.is_none())
        .map(|shot| UnboundPlanShot {
            id: shot.id,
            title: shot.title.clone(),
        })
        .collect::<Vec<_>>();
    if !unbound.is_empty() {
        return Ok(UnrecordablePlan {
            code: AGENT_PLAN_SHOTS_UNBOUND,
            message: format!(
                "{} of the {} shots in this plan are not bound to a Demo and a player yet",
                unbound.len(),
                recordable.len()
            ),
            shots: unbound,
        }
        .response());
    }
    let mut items = Vec::with_capacity(recordable.len());
    for shot in recordable {
        // The shot identity becomes the request identity, so a queue item stays
        // traceable to the card the user is looking at.
        items.push(shot.recording_request(shot.id)?);
    }
    Ok(super::recording::create_recording_plan(&state, items, None)
        .await?
        .into_response())
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
#[derive(Debug, Serialize, TS)]
#[ts(export)]
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
#[derive(Debug, Serialize, TS)]
#[ts(export)]
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
    use vibe_cs_domain::{DomainError, ExportJob, RecordingRequest};
    use vibe_cs_storage::Storage;

    use super::*;

    fn dispatcher(storage: Storage) -> (Router, tempfile::TempDir) {
        let directory = tempfile::tempdir().expect("temporary directory");
        let state = AppState::new(storage, directory.path().join("data"));
        (crate::build_dispatcher(state), directory)
    }

    /// A recording port that accepts whatever the plan route hands it. Managed
    /// HLAE is the only thing stubbed out; everything the plan route decides -
    /// which shots survive, what they are bound to - is still the real code.
    #[derive(Debug)]
    struct AcceptingRecordingPort;

    #[async_trait::async_trait]
    impl crate::RecordingPort for AcceptingRecordingPort {
        async fn preflight(&self, _items: &[RecordingRequest]) -> Result<(), DomainError> {
            Ok(())
        }

        async fn execute(&self, job: RecordingJob) -> Result<RecordingJob, DomainError> {
            Ok(job)
        }

        async fn cancel(&self, job: RecordingJob) -> Result<RecordingJob, DomainError> {
            Ok(job)
        }
    }

    fn recording_dispatcher(storage: Storage) -> (Router, tempfile::TempDir) {
        let directory = tempfile::tempdir().expect("temporary directory");
        let recording: std::sync::Arc<dyn crate::RecordingPort> =
            std::sync::Arc::new(AcceptingRecordingPort);
        let state = AppState::new(storage, directory.path().join("data")).with_recording(recording);
        (crate::build_dispatcher(state), directory)
    }

    /// The recording plan binds itself to the Demo row, so the row has to exist.
    /// No file is touched: nothing in this test reaches a parser or CS2.
    async fn persist_demo(storage: &Storage, demo_id: Uuid) {
        let now = Utc::now();
        storage
            .put_demo(vibe_cs_domain::DemoRecord {
                id: demo_id,
                path: format!("C:/demos/{demo_id}.dem"),
                file_name: format!("{demo_id}.dem"),
                display_name: "Plan fixture".to_owned(),
                source: "test".to_owned(),
                status: vibe_cs_domain::DemoStatus::Ready,
                map_name: Some("de_mirage".to_owned()),
                match_date: None,
                duration_seconds: Some(10.0),
                total_rounds: Some(1),
                team_a_name: None,
                team_b_name: None,
                team_a_score: None,
                team_b_score: None,
                player_names: vec!["Kael".to_owned()],
                remark: String::new(),
                content_sha256: Some("ab".repeat(32)),
                file_size: 1_024,
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("plan demo");
    }

    fn binding(demo_id: Uuid) -> Value {
        json!({
            "demo_id": demo_id,
            "player_id": "76561197960690195",
            "highlight_id": null,
            "victim_pov": false,
            "pre_roll_seconds": 1.5,
            "post_roll_seconds": 1.0,
            "presentation": null
        })
    }

    fn bound_shot(title: &str, demo_id: Uuid) -> Value {
        let mut value = shot(title, 5.0);
        value["recording"] = binding(demo_id);
        value
    }

    fn removed(mut value: Value) -> Value {
        value["removed_by"] = json!("user");
        value
    }

    /// Moves a shot far enough away that the director cannot merge it into its
    /// neighbour, so a shot that leaks into the queue shows up as an extra item
    /// instead of disappearing into a merge.
    fn at_ticks(mut value: Value, start: u64, end: u64) -> Value {
        value["start_tick"] = json!(start);
        value["end_tick"] = json!(end);
        value
    }

    async fn plan_with_shots(router: &Router, shots: Vec<Value>) -> Uuid {
        let (status, plan) = call(
            router,
            Method::POST,
            "/api/agent/plans",
            Some(json!({
                "title": "Kael Mirage 1v3",
                "status": "awaiting_confirmation",
                "shots": shots,
                "origin": null
            })),
        )
        .await;
        assert_eq!(status, 201);
        serde_json::from_value(plan["id"].clone()).expect("plan id")
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

        // §10.5 gap 9: a reference can be taken back, so the artboard's
        // 「取消引用」 has something to call.
        let (status, _) = call(
            &router,
            Method::DELETE,
            &format!("/api/agent/sessions/{session_id}/refs/plan/{plan_id}"),
            None,
        )
        .await;
        assert_eq!(status, 204);
        let (status, session) = call(
            &router,
            Method::GET,
            &format!("/api/agent/sessions/{session_id}"),
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(session["refs"].as_array().expect("refs").len(), 0);

        // Idempotent: pressing it twice, or on a reference another window
        // already removed, is not a failure.
        let (status, _) = call(
            &router,
            Method::DELETE,
            &format!("/api/agent/sessions/{session_id}/refs/plan/{plan_id}"),
            None,
        )
        .await;
        assert_eq!(status, 204);

        // …but a session that does not exist still 404s: that is the one
        // thing that really is missing.
        let (status, _) = call(
            &router,
            Method::DELETE,
            &format!("/api/agent/sessions/{}/refs/plan/{plan_id}", Uuid::new_v4()),
            None,
        )
        .await;
        assert_eq!(status, 404);

        // Put it back, so the reverse index below still has something to find.
        let (status, _) = call(
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
                    presentation: None,
                }],
                current_index: 0,
                progress: 0.42,
                message: String::new(),
                outputs: Vec::new(),
                error_code: None,
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
                error_code: None,
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
                    error_code: None,
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
                "take_limit": 5,
                // The five switches of 「设置 · AI 与 Agent」. Every one is a
                // required key: the route replaces the settings document, and
                // a partial body would silently reset whatever it omitted.
                "auto_attach_context": false,
                "preview_before_apply": false,
                "show_evidence_reads": true,
                "default_video_seconds": 90,
                "commentary_tone": "broadcast"
            })),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(settings["session_retention"]["count"], 50);
        assert_eq!(settings["auto_attach_context"], json!(false));
        assert_eq!(settings["preview_before_apply"], json!(false));
        assert_eq!(settings["show_evidence_reads"], json!(true));
        assert_eq!(settings["default_video_seconds"], json!(90));
        assert_eq!(settings["commentary_tone"], json!("broadcast"));

        // …and they survive a read, which is the point of persisting them.
        let (status, stored) =
            call(&router, Method::GET, "/api/agent/workspace/settings", None).await;
        assert_eq!(status, 200);
        assert_eq!(stored["commentary_tone"], json!("broadcast"));
        assert_eq!(stored["default_video_seconds"], json!(90));

        // A length outside 5…3600 is refused rather than stored: it is a
        // target the Agent aims at, and 0 seconds is not a target.
        let (status, _) = call(
            &router,
            Method::PUT,
            "/api/agent/workspace/settings",
            Some(json!({
                "session_retention": { "mode": "all" },
                "take_limit": 5,
                "auto_attach_context": true,
                "preview_before_apply": true,
                "show_evidence_reads": true,
                "default_video_seconds": 0,
                "commentary_tone": "professional"
            })),
        )
        .await;
        assert_eq!(status, 400);

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

    /// The handover stage 3e depends on: the highlight page creates a plan and
    /// navigates to `?plan=`. Unless the Demo and the player survive that write
    /// verbatim, the recording page has a plan it cannot record.
    #[tokio::test]
    async fn a_recording_binding_survives_plan_create_read_and_edit_field_for_field() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let (router, _directory) = dispatcher(storage);
        let demo_id = Uuid::new_v4();

        let (status, session) = call(
            &router,
            Method::POST,
            "/api/agent/sessions",
            Some(json!({ "title": "Kael 的 1v3" })),
        )
        .await;
        assert_eq!(status, 201);
        let session_id: Uuid = serde_json::from_value(session["id"].clone()).expect("session id");

        let plan_id = plan_with_shots(
            &router,
            vec![bound_shot("02 跟随突破", demo_id), shot("03 收尾", 4.0)],
        )
        .await;

        let (status, stored) = call(
            &router,
            Method::GET,
            &format!("/api/agent/plans/{plan_id}"),
            None,
        )
        .await;
        assert_eq!(status, 200);
        let recording = &stored["shots"][0]["recording"];
        assert_eq!(recording["demo_id"], json!(demo_id));
        assert_eq!(recording["player_id"], "76561197960690195");
        assert_eq!(recording["highlight_id"], Value::Null);
        assert_eq!(recording["victim_pov"], false);
        assert_eq!(recording["pre_roll_seconds"], 1.5);
        assert_eq!(recording["post_roll_seconds"], 1.0);
        assert_eq!(recording["presentation"], Value::Null);
        // A plan is meaningful before it is bound, so the second shot keeps its
        // absent binding rather than being rejected or filled in.
        assert_eq!(stored["shots"][1]["recording"], Value::Null);

        // The same door on the edit path: landing a shot on footage is an
        // ordinary conditional plan edit.
        let mut landed = stored["shots"][1].clone();
        landed["recording"] = binding(demo_id);
        landed["recording"]["highlight_id"] = json!("demo:match/event:kill-7");
        landed["recording"]["presentation"] = json!({
            "camera_fov": 90.0,
            "viewmodel_fov": 68.0,
            "flash_alpha": 102,
            "show_hud": false,
            "show_radar": true,
            "voice": "target_only"
        });
        let (status, edited) = call(
            &router,
            Method::PATCH,
            &format!("/api/agent/plans/{plan_id}"),
            Some(json!({
                "plan_id": plan_id,
                "expected_revision": 1,
                "status": "awaiting_confirmation",
                "shots": [stored["shots"][0].clone(), landed],
                "origin": {
                    "session_id": session_id,
                    "session_title": "Kael 的 1v3",
                    "summary": "镜头 03 落到 Demo 上"
                },
                "changes": [],
                "note": null
            })),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(edited["revision"], 2);
        let landed = &edited["shots"][1]["recording"];
        assert_eq!(landed["demo_id"], json!(demo_id));
        assert_eq!(landed["highlight_id"], "demo:match/event:kill-7");
        assert_eq!(landed["presentation"]["flash_alpha"], 102);
        assert_eq!(landed["presentation"]["show_hud"], false);
        assert_eq!(landed["presentation"]["voice"], "target_only");
    }

    /// Design §10.6 gap 1, the blocking case: the answer has to name the shots,
    /// because "some shots are not bound" leaves a user staring at four cards
    /// with no way to learn which ones.
    #[tokio::test]
    async fn a_plan_with_unbound_shots_names_every_shot_that_blocks_the_recording() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let (router, _directory) = dispatcher(storage);
        let demo_id = Uuid::new_v4();
        let plan_id = plan_with_shots(
            &router,
            vec![
                bound_shot("02 跟随突破", demo_id),
                shot("03 换点", 4.0),
                shot("04 收尾", 3.0),
            ],
        )
        .await;

        let (status, plan) = call(
            &router,
            Method::GET,
            &format!("/api/agent/plans/{plan_id}"),
            None,
        )
        .await;
        assert_eq!(status, 200);
        let shots = plan["shots"].as_array().expect("shots");

        let (status, problem) = call(
            &router,
            Method::POST,
            &format!("/api/agent/plans/{plan_id}/recording-plan"),
            None,
        )
        .await;
        assert_eq!(status, 422);
        assert_eq!(problem["code"], "agent_plan_shots_unbound");
        let blocking = problem["shots"].as_array().expect("blocking shots");
        assert_eq!(blocking.len(), 2);
        assert_eq!(blocking[0]["id"], shots[1]["id"]);
        assert_eq!(blocking[0]["title"], "03 换点");
        assert_eq!(blocking[1]["id"], shots[2]["id"]);
        assert_eq!(blocking[1]["title"], "04 收尾");

        let (status, _) = call(
            &router,
            Method::POST,
            &format!("/api/agent/plans/{}/recording-plan", Uuid::new_v4()),
            None,
        )
        .await;
        assert_eq!(status, 404);
    }

    /// A soft-removed shot stays in the plan so the removal can be undone. It
    /// must not reach the capture queue, and it must not block the queue either.
    #[tokio::test]
    async fn a_soft_removed_shot_neither_records_nor_blocks_the_recording_plan() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let demo_id = Uuid::new_v4();
        persist_demo(&storage, demo_id).await;
        let (router, _directory) = recording_dispatcher(storage);
        let plan_id = plan_with_shots(
            &router,
            vec![
                bound_shot("02 跟随突破", demo_id),
                // Removed and unbound: were `removed_by` ignored, this shot
                // would block the whole plan.
                removed(shot("03 换点", 4.0)),
                // Removed and bound: were `removed_by` ignored, this shot would
                // be recorded as a second, unmergeable queue item.
                removed(at_ticks(bound_shot("04 收尾", demo_id), 200_000, 200_500)),
            ],
        )
        .await;

        let (status, planned) = call(
            &router,
            Method::POST,
            &format!("/api/agent/plans/{plan_id}/recording-plan"),
            None,
        )
        .await;
        assert_eq!(status, 200, "unexpected body: {planned}");
        let items = planned["items"].as_array().expect("queue items");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["title"], "02 跟随突破");
        assert_eq!(items[0]["demo_id"], json!(demo_id));
        assert_eq!(items[0]["player_id"], "76561197960690195");
        // The three fields the binding deliberately does not duplicate come
        // from the shot itself.
        assert_eq!(items[0]["camera_style"], "tracking");
        assert_eq!(items[0]["start_tick"], 148_812);
        assert_eq!(items[0]["end_tick"], 149_132);
        assert_eq!(items[0]["pre_roll_seconds"], 1.5);
        // The answer is the same document `/api/recording/plan` returns, so the
        // page after this call is the same page.
        assert!(planned["plan_id"].is_string());
        assert!(planned["director"]["shots"].is_array());
    }

    /// An empty queue must never be explained with the recording queue's own
    /// wording: "must contain at least one executable item" is unreadable in
    /// front of a plan whose shots were all removed.
    #[tokio::test]
    async fn a_plan_with_nothing_left_to_record_says_so_in_its_own_terms() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let (router, _directory) = dispatcher(storage);
        let demo_id = Uuid::new_v4();

        let all_removed = plan_with_shots(
            &router,
            vec![
                removed(bound_shot("02 跟随突破", demo_id)),
                removed(shot("03 换点", 4.0)),
            ],
        )
        .await;
        let (status, problem) = call(
            &router,
            Method::POST,
            &format!("/api/agent/plans/{all_removed}/recording-plan"),
            None,
        )
        .await;
        assert_eq!(status, 422);
        assert_eq!(problem["code"], "agent_plan_not_recordable");
        assert!(problem["shots"].as_array().expect("shots").is_empty());
        let message = problem["message"].as_str().expect("message");
        assert!(
            message.contains("all 2 of its shots are removed"),
            "{message}"
        );
        assert!(!message.contains("executable item"), "{message}");

        let empty = plan_with_shots(&router, Vec::new()).await;
        let (status, problem) = call(
            &router,
            Method::POST,
            &format!("/api/agent/plans/{empty}/recording-plan"),
            None,
        )
        .await;
        assert_eq!(status, 422);
        assert_eq!(problem["code"], "agent_plan_not_recordable");
        let message = problem["message"].as_str().expect("message");
        assert!(message.contains("no shot to record"), "{message}");
        assert!(!message.contains("executable item"), "{message}");
    }
}
