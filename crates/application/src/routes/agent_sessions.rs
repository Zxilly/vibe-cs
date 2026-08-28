//! Durable Agent conversations embedded in the unified Project workspace.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post, put},
};
use serde::Deserialize;
use uuid::Uuid;
use vibe_cs_domain::{
    AGENT_SESSION_MAX_TITLE_CHARS, AgentSession, AgentSessionEntry, AgentSessionEntryDraft,
    AgentSessionExport, AgentSessionPage, AgentSessionPurge, AgentSessionQuery,
    AgentSessionStorageStats, AgentTurnUpdate, AgentWorkspaceSettings,
};

use crate::{ApiError, ApiJson, ApiQuery, ApiResult, AppState};

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
        .route(
            "/api/agent/sessions/{id}/turns/{entry_id}",
            put(update_turn),
        )
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
    Ok((
        StatusCode::CREATED,
        Json(state.storage.create_agent_session(body.title).await?),
    ))
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

async fn update_turn(
    State(state): State<AppState>,
    Path((id, entry_id)): Path<(Uuid, Uuid)>,
    ApiJson(update): ApiJson<AgentTurnUpdate>,
) -> ApiResult<Json<AgentSessionEntry>> {
    state
        .storage
        .update_agent_turn(id, entry_id, update)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("agent session"))
}

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

async fn apply_session_retention(
    State(state): State<AppState>,
) -> ApiResult<Json<AgentSessionPurge>> {
    Ok(Json(AgentSessionPurge {
        removed_sessions: state.storage.apply_agent_session_retention().await?,
    }))
}

async fn clear_sessions(State(state): State<AppState>) -> ApiResult<Json<AgentSessionPurge>> {
    Ok(Json(AgentSessionPurge {
        removed_sessions: state.storage.clear_agent_sessions().await?,
    }))
}
