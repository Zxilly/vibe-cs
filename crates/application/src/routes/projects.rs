use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::get,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;
use vibe_cs_domain::{
    EditingDocument, EditingDocumentSettings, Project, ProjectChangeAuthor, ProjectChangeGroup,
    ProjectEditLease, ProjectPatch, TimelineClipMaterializationState, TimelineTrack, TrackKind,
};
use vibe_cs_storage::ProjectLeaseAcquire;

use crate::{ApiError, ApiJson, ApiResult, AppState};

const PROJECT_RESOURCE: &str = "project";

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/projects", get(list_projects).post(create_project))
        .route("/api/projects/{id}", get(get_project).patch(apply_patch))
        .route("/api/projects/{id}/delivery-gate", get(get_delivery_gate))
        .route("/api/projects/{id}/change-groups", get(list_change_groups))
        .route(
            "/api/projects/{id}/recording-plan",
            axum::routing::post(create_project_recording_plan),
        )
        .route(
            "/api/projects/{id}/export",
            axum::routing::post(export_project),
        )
        .route(
            "/api/projects/{id}/change-groups/{change_group_id}/revert",
            axum::routing::post(revert_change_group),
        )
        .route(
            "/api/projects/{id}/edit-lease",
            get(get_edit_lease).post(acquire_edit_lease),
        )
        .route(
            "/api/projects/{id}/edit-lease/{lease_id}",
            axum::routing::put(heartbeat_edit_lease).delete(release_edit_lease),
        )
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct CreateProjectRequest {
    name: String,
    width: u32,
    height: u32,
    fps: u32,
    source_demo_ids: Vec<Uuid>,
}

#[derive(Debug, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct ProjectPatchResult {
    project: Project,
    change_group: ProjectChangeGroup,
}

#[derive(Debug, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct ProjectDeliveryBlocker {
    clip_id: Uuid,
    state: TimelineClipMaterializationState,
}

#[derive(Debug, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct ProjectDeliveryGate {
    project_id: Uuid,
    revision: u64,
    ready: bool,
    blockers: Vec<ProjectDeliveryBlocker>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct RevertProjectChangeGroupRequest {
    expected_revision: u64,
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct AcquireProjectEditLeaseRequest {
    session_id: Uuid,
    turn_id: Uuid,
    base_revision: u64,
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct HeartbeatProjectEditLeaseRequest {
    heartbeat_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct ProjectEditLeaseResponse {
    acquired: bool,
    lease: ProjectEditLease,
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct ProjectRecordingPlanRequest {
    #[serde(default)]
    clip_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct ProjectExportRequest {
    confirm: bool,
    encoder: String,
    quality: u8,
    #[serde(default)]
    range_start_seconds: Option<f64>,
    #[serde(default)]
    range_end_seconds: Option<f64>,
}

#[derive(Debug, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct ProjectExportResponse {
    job_id: Uuid,
    status: String,
}

async fn list_projects(State(state): State<AppState>) -> ApiResult<Json<Vec<Project>>> {
    Ok(Json(state.storage.list_projects().await?))
}

async fn get_project(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Project>> {
    state
        .storage
        .get_project(id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("project"))
}

async fn get_delivery_gate(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<ProjectDeliveryGate>> {
    let project = state
        .storage
        .get_project(id)
        .await?
        .ok_or_else(|| ApiError::not_found("project"))?;
    let blockers = project
        .delivery_blockers()?
        .into_iter()
        .map(|(clip_id, state)| ProjectDeliveryBlocker { clip_id, state })
        .collect::<Vec<_>>();
    Ok(Json(ProjectDeliveryGate {
        project_id: project.id,
        revision: project.revision,
        ready: blockers.is_empty(),
        blockers,
    }))
}

async fn create_project(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<CreateProjectRequest>,
) -> ApiResult<(StatusCode, Json<Project>)> {
    let now = Utc::now();
    let story_track_id = Uuid::new_v4();
    let project = Project {
        id: Uuid::new_v4(),
        name: request.name,
        revision: 1,
        document: EditingDocument {
            width: request.width,
            height: request.height,
            fps: request.fps,
            duration_seconds: 0.0,
            story_track_id,
            tracks: vec![TimelineTrack {
                id: story_track_id,
                name: "Story".to_owned(),
                kind: TrackKind::Video,
                order: 0,
                muted: false,
                locked: false,
                hidden: false,
                clips: Vec::new(),
            }],
            markers: Vec::new(),
            settings: EditingDocumentSettings {
                source_demo_ids: request.source_demo_ids,
            },
        },
        created_at: now,
        updated_at: now,
    };
    let project = state.storage.create_project(project).await?;
    state
        .events
        .publish(PROJECT_RESOURCE, "created", Some(project.id));
    Ok((StatusCode::CREATED, Json(project)))
}

async fn apply_patch(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    ApiJson(patch): ApiJson<ProjectPatch>,
) -> ApiResult<Json<ProjectPatchResult>> {
    if patch.project_id != id {
        return Err(ApiError::invalid(
            "project patch id does not match the route",
        ));
    }
    let (project, change_group) = state
        .storage
        .apply_project_patch(patch, Uuid::new_v4(), Utc::now())
        .await?;
    state.events.publish(PROJECT_RESOURCE, "edited", Some(id));
    Ok(Json(ProjectPatchResult {
        project,
        change_group,
    }))
}

async fn list_change_groups(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Vec<ProjectChangeGroup>>> {
    Ok(Json(
        state.storage.list_project_change_groups(id, 200).await?,
    ))
}

async fn create_project_recording_plan(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    ApiJson(request): ApiJson<ProjectRecordingPlanRequest>,
) -> ApiResult<Json<super::recording::RecordingPlanResponse>> {
    let project = state
        .storage
        .get_project(id)
        .await?
        .ok_or_else(|| ApiError::not_found("project"))?;
    let selected = request
        .clip_ids
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    let mut items = Vec::new();
    for clip in project
        .document
        .tracks
        .iter()
        .flat_map(|track| &track.clips)
    {
        if !clip.placement.enabled || (!selected.is_empty() && !selected.contains(&clip.id)) {
            continue;
        }
        if !matches!(
            clip.materialization_state()?,
            vibe_cs_domain::TimelineClipMaterializationState::Unrecorded
                | vibe_cs_domain::TimelineClipMaterializationState::Stale
        ) {
            continue;
        }
        let intent = clip
            .capture_intent
            .clone()
            .ok_or_else(|| ApiError::invalid(format!("clip {} has no Capture Intent", clip.id)))?;
        items.push(intent.into_recording_request(clip.id, &clip.name));
    }
    super::recording::create_recording_plan(
        &state,
        items,
        None,
        Some(super::recording::ProjectRecordingSource { project_id: id }),
    )
    .await
}

async fn export_project(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    ApiJson(request): ApiJson<ProjectExportRequest>,
) -> ApiResult<Json<ProjectExportResponse>> {
    if !request.confirm {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_REQUIRED,
            "project_export_confirmation_required",
            "Final export requires explicit human confirmation",
        ));
    }
    let project = state
        .storage
        .get_project(id)
        .await?
        .ok_or_else(|| ApiError::not_found("project"))?;
    validate_project_export_request(&request, project.document.duration_seconds)?;
    let unresolved = project.unresolved_delivery_clips()?;
    if !unresolved.is_empty() {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_FAILED,
            "project_delivery_gate_failed",
            format!(
                "{} enabled clips do not have compatible media",
                unresolved.len()
            ),
        ));
    }
    let job = state
        .exports
        .start(
            "project",
            id,
            serde_json::json!({
                "encoder": request.encoder,
                "quality": request.quality,
                "range_start_seconds": request.range_start_seconds,
                "range_end_seconds": request.range_end_seconds,
            }),
        )
        .await?;
    state.events.publish("export_job", "created", Some(job.id));
    Ok(Json(ProjectExportResponse {
        job_id: job.id,
        status: format!("{:?}", job.status).to_lowercase(),
    }))
}

fn validate_project_export_request(
    request: &ProjectExportRequest,
    duration_seconds: f64,
) -> ApiResult<()> {
    if !(1..=100).contains(&request.quality) {
        return Err(ApiError::invalid(
            "export quality must be between 1 and 100",
        ));
    }
    if !matches!(
        request.encoder.trim().to_ascii_lowercase().as_str(),
        "auto" | "libopenh264" | "h264_mf" | "h264_nvenc" | "hevc_nvenc" | "h264_amf" | "h264_qsv"
    ) {
        return Err(ApiError::invalid("export encoder is not supported"));
    }
    let start = request.range_start_seconds.unwrap_or(0.0);
    let end = request.range_end_seconds.unwrap_or(duration_seconds);
    if !start.is_finite()
        || !end.is_finite()
        || start < 0.0
        || end <= start
        || end > duration_seconds + 0.001
    {
        return Err(ApiError::invalid("export range is outside the project"));
    }
    Ok(())
}

async fn revert_change_group(
    State(state): State<AppState>,
    Path((id, change_group_id)): Path<(Uuid, Uuid)>,
    ApiJson(request): ApiJson<RevertProjectChangeGroupRequest>,
) -> ApiResult<Json<ProjectPatchResult>> {
    let (project, change_group) = state
        .storage
        .revert_project_change_group(
            id,
            change_group_id,
            request.expected_revision,
            ProjectChangeAuthor::Human,
            Uuid::new_v4(),
            Utc::now(),
        )
        .await?;
    state.events.publish(PROJECT_RESOURCE, "edited", Some(id));
    Ok(Json(ProjectPatchResult {
        project,
        change_group,
    }))
}

async fn acquire_edit_lease(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    ApiJson(request): ApiJson<AcquireProjectEditLeaseRequest>,
) -> ApiResult<Json<ProjectEditLeaseResponse>> {
    let now = Utc::now();
    let lease = ProjectEditLease {
        id: Uuid::new_v4(),
        project_id: id,
        session_id: request.session_id,
        turn_id: request.turn_id,
        base_revision: request.base_revision,
        acquired_at: now,
        heartbeat_at: now,
    };
    let response = match state.storage.acquire_project_edit_lease(lease).await? {
        ProjectLeaseAcquire::Acquired(lease) => ProjectEditLeaseResponse {
            acquired: true,
            lease,
        },
        ProjectLeaseAcquire::Held(lease) => ProjectEditLeaseResponse {
            acquired: false,
            lease,
        },
    };
    Ok(Json(response))
}

async fn get_edit_lease(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Option<ProjectEditLease>>> {
    Ok(Json(state.storage.get_project_edit_lease(id).await?))
}

async fn heartbeat_edit_lease(
    State(state): State<AppState>,
    Path((id, lease_id)): Path<(Uuid, Uuid)>,
    ApiJson(request): ApiJson<HeartbeatProjectEditLeaseRequest>,
) -> ApiResult<StatusCode> {
    if state
        .storage
        .heartbeat_project_edit_lease(id, lease_id, request.heartbeat_at)
        .await?
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("project edit lease"))
    }
}

async fn release_edit_lease(
    State(state): State<AppState>,
    Path((id, lease_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    if state
        .storage
        .release_project_edit_lease(id, lease_id)
        .await?
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("project edit lease"))
    }
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

    #[tokio::test]
    async fn project_head_patch_and_revert_use_one_route_family() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let (router, _directory) = dispatcher(storage);
        let (status, created) = call(
            &router,
            Method::POST,
            "/api/projects",
            Some(json!({
                "name":"Unified",
                "width":1920,
                "height":1080,
                "fps":60,
                "source_demo_ids":["00000000-0000-0000-0000-000000000001"]
            })),
        )
        .await;
        assert_eq!(status, 201);
        let project_id = created["id"].as_str().expect("project id");
        assert_eq!(
            created["document"]["settings"]["source_demo_ids"],
            json!(["00000000-0000-0000-0000-000000000001"])
        );

        let (status, patched) = call(
            &router,
            Method::PATCH,
            &format!("/api/projects/{project_id}"),
            Some(json!({
                "project_id": project_id,
                "base_revision": 1,
                "scope": {"kind":"project"},
                "author": {"kind":"human"},
                "reverts_change_group_id": null,
                "summary": "Rename",
                "operations": [{"op":"rename_project","name":"Renamed"}]
            })),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(patched["project"]["name"], "Renamed");
        let group_id = patched["change_group"]["id"]
            .as_str()
            .expect("change group id");

        let (status, reverted) = call(
            &router,
            Method::POST,
            &format!("/api/projects/{project_id}/change-groups/{group_id}/revert"),
            Some(json!({"expected_revision":2})),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(reverted["project"]["name"], "Unified");
        assert_eq!(reverted["project"]["revision"], 3);
    }

    #[test]
    fn export_settings_are_validated_before_a_job_is_created() {
        let valid = ProjectExportRequest {
            confirm: true,
            encoder: "auto".to_owned(),
            quality: 80,
            range_start_seconds: Some(1.0),
            range_end_seconds: Some(5.0),
        };
        assert!(validate_project_export_request(&valid, 10.0).is_ok());

        assert!(
            validate_project_export_request(
                &ProjectExportRequest {
                    quality: 0,
                    ..valid.clone()
                },
                10.0,
            )
            .is_err()
        );
        assert!(
            validate_project_export_request(
                &ProjectExportRequest {
                    encoder: "unknown".to_owned(),
                    ..valid.clone()
                },
                10.0,
            )
            .is_err()
        );
        assert!(
            validate_project_export_request(
                &ProjectExportRequest {
                    range_start_seconds: Some(8.0),
                    range_end_seconds: Some(12.0),
                    ..valid
                },
                10.0,
            )
            .is_err()
        );
    }
}
