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
    EditingDocument, EditingDocumentSettings, JobStatus, Project, ProjectChangeAuthor,
    ProjectChangeGroup, ProjectEditLease, ProjectEditOperation, ProjectPatch, ProjectPatchScope,
    TimelineClip, TimelineClipMaterial, TimelineClipMaterializationState, TimelineClipTransitions,
    TimelinePlacement, TimelineTrack, TrackKind, Transform,
};
use vibe_cs_storage::ExportJobRecord;

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
            "/api/projects/{id}/render-previews",
            get(list_render_previews)
                .post(render_project_preview)
                .delete(clear_render_previews),
        )
        .route(
            "/api/projects/{id}/nested-sequences",
            get(list_nested_sequence_media).post(create_nested_sequence),
        )
        .route(
            "/api/projects/{id}/nested-sequences/{clip_id}/refresh",
            axum::routing::post(refresh_nested_sequence),
        )
        .route(
            "/api/projects/{id}/change-groups/{change_group_id}/revert",
            axum::routing::post(revert_change_group),
        )
        .route("/api/projects/{id}/edit-lease", get(get_edit_lease))
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectRecordingPlanRequest {
    expected_revision: u64,
    #[serde(default)]
    clip_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectExportRequest {
    expected_revision: u64,
    confirm: bool,
    encoder: String,
    quality: u8,
    #[serde(default)]
    range_start_seconds: Option<f64>,
    #[serde(default)]
    range_end_seconds: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields)]
struct ProjectExportResponse {
    job_id: Uuid,
    status: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectRenderPreviewRequest {
    encoder: String,
    quality: u8,
    range_start_seconds: f64,
    range_end_seconds: f64,
}

#[derive(Debug, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct ProjectRenderPreviewCleanup {
    removed: u32,
    cancellation_requested: u32,
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct CreateNestedSequenceRequest {
    base_revision: u64,
    name: String,
    clip_ids: Vec<Uuid>,
}

#[derive(Debug, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct CreateNestedSequenceResponse {
    parent_project: Project,
    nested_project: Project,
    change_group: ProjectChangeGroup,
    preview_job_id: Option<Uuid>,
}

#[derive(Debug, Clone, Copy, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
enum NestedSequenceMediaStatus {
    Ready,
    Rendering,
    Stale,
    Failed,
    Missing,
}

#[derive(Debug, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct NestedSequenceMedia {
    clip_id: Uuid,
    project_id: Uuid,
    expected_revision: u64,
    current_revision: u64,
    status: NestedSequenceMediaStatus,
    preview_job_id: Option<Uuid>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct RefreshNestedSequenceRequest {
    base_revision: u64,
}

#[derive(Debug, Serialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct RefreshNestedSequenceResponse {
    parent_project: Project,
    change_group: ProjectChangeGroup,
    preview_job_id: Option<Uuid>,
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
    let mut blockers = project
        .delivery_blockers()?
        .into_iter()
        .map(|(clip_id, state)| ProjectDeliveryBlocker { clip_id, state })
        .collect::<Vec<_>>();
    for clip in project
        .document
        .tracks
        .iter()
        .flat_map(|track| &track.clips)
    {
        let TimelineClipMaterial::Sequence {
            project_id,
            project_revision,
            media_duration_seconds,
        } = clip.material
        else {
            continue;
        };
        let nested = state.storage.get_project(project_id).await?;
        let ready = nested
            .as_ref()
            .is_some_and(|nested| nested.revision == project_revision)
            && state
                .storage
                .list_export_jobs(Some(project_id))
                .await?
                .into_iter()
                .any(|record| {
                    record.kind == "project_preview"
                        && record.job.project_revision == project_revision
                        && record.job.status == JobStatus::Completed
                        && record.job.range_start_seconds <= 0.001
                        && record.job.range_end_seconds + 0.001 >= media_duration_seconds
                });
        if !ready {
            blockers.push(ProjectDeliveryBlocker {
                clip_id: clip.id,
                state: TimelineClipMaterializationState::Stale,
            });
        }
    }
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
                solo: false,
                volume: 1.0,
                pan: 0.0,
                keyframes: Vec::new(),
                locked: false,
                hidden: false,
                clips: Vec::new(),
            }],
            markers: Vec::new(),
            settings: EditingDocumentSettings {
                source_demo_ids: request.source_demo_ids,
                ripple_sequence_markers: false,
                use_media_proxies: false,
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
    require_project_revision(
        &project,
        request.expected_revision,
        "recording confirmation",
    )?;
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
    require_project_revision(&project, request.expected_revision, "export confirmation")?;
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

async fn list_render_previews(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Vec<ExportJobRecord>>> {
    let previews = state
        .storage
        .list_export_jobs(Some(id))
        .await?
        .into_iter()
        .filter(|record| record.kind == "project_preview")
        .collect();
    Ok(Json(previews))
}

async fn render_project_preview(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    ApiJson(request): ApiJson<ProjectRenderPreviewRequest>,
) -> ApiResult<Json<ProjectExportResponse>> {
    let project = state
        .storage
        .get_project(id)
        .await?
        .ok_or_else(|| ApiError::not_found("project"))?;
    let export_request = ProjectExportRequest {
        expected_revision: project.revision,
        confirm: true,
        encoder: request.encoder,
        quality: request.quality,
        range_start_seconds: Some(request.range_start_seconds),
        range_end_seconds: Some(request.range_end_seconds),
    };
    validate_project_export_request(&export_request, project.document.duration_seconds)?;
    let unresolved = project.unresolved_delivery_clips()?;
    if !unresolved.is_empty() {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_FAILED,
            "project_preview_delivery_gate_failed",
            format!(
                "{} enabled clips do not have compatible media",
                unresolved.len()
            ),
        ));
    }
    let job = state
        .exports
        .start(
            "project_preview",
            id,
            serde_json::json!({
                "encoder": export_request.encoder,
                "quality": export_request.quality,
                "range_start_seconds": export_request.range_start_seconds,
                "range_end_seconds": export_request.range_end_seconds,
            }),
        )
        .await?;
    state.events.publish("export_job", "created", Some(job.id));
    Ok(Json(ProjectExportResponse {
        job_id: job.id,
        status: format!("{:?}", job.status).to_lowercase(),
    }))
}

fn require_project_revision(project: &Project, expected: u64, operation: &str) -> ApiResult<()> {
    if project.revision == expected {
        return Ok(());
    }
    Err(vibe_cs_domain::DomainError::Conflict(format!(
        "Project is at revision {}, {operation} expects {expected}",
        project.revision
    ))
    .into())
}

async fn clear_render_previews(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<ProjectRenderPreviewCleanup>> {
    let records = state
        .storage
        .list_export_jobs(Some(id))
        .await?
        .into_iter()
        .filter(|record| record.kind == "project_preview")
        .collect::<Vec<_>>();
    let preview_root = state.data_dir().join("previews");
    let mut removed = 0_u32;
    let mut cancellation_requested = 0_u32;
    for record in records {
        if !record.job.status.is_terminal() {
            state.exports.cancel(record.job.id).await?;
            cancellation_requested = cancellation_requested.saturating_add(1);
            continue;
        }
        remove_managed_preview_file(&preview_root, &record.job.output_path).await?;
        if state.storage.delete_export_job(record.job.id).await? {
            removed = removed.saturating_add(1);
        }
    }
    state.events.publish("export_job", "changed", None);
    Ok(Json(ProjectRenderPreviewCleanup {
        removed,
        cancellation_requested,
    }))
}

async fn list_nested_sequence_media(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Vec<NestedSequenceMedia>>> {
    let parent = state
        .storage
        .get_project(id)
        .await?
        .ok_or_else(|| ApiError::not_found("project"))?;
    let mut items = Vec::new();
    for clip in parent.document.tracks.iter().flat_map(|track| &track.clips) {
        let TimelineClipMaterial::Sequence {
            project_id,
            project_revision,
            media_duration_seconds,
        } = clip.material
        else {
            continue;
        };
        let nested = state.storage.get_project(project_id).await?;
        let current_revision = nested.as_ref().map_or(0, |project| project.revision);
        let preview = state
            .storage
            .list_export_jobs(Some(project_id))
            .await?
            .into_iter()
            .find(|record| {
                record.kind == "project_preview"
                    && record.job.project_revision == project_revision
                    && record.job.range_start_seconds <= 0.001
                    && record.job.range_end_seconds + 0.001 >= media_duration_seconds
            });
        let status = if nested.is_none() {
            NestedSequenceMediaStatus::Missing
        } else if current_revision != project_revision {
            NestedSequenceMediaStatus::Stale
        } else {
            match preview.as_ref().map(|record| record.job.status) {
                Some(JobStatus::Completed) => NestedSequenceMediaStatus::Ready,
                Some(
                    JobStatus::Queued
                    | JobStatus::Preparing
                    | JobStatus::Running
                    | JobStatus::Cancelling,
                ) => NestedSequenceMediaStatus::Rendering,
                Some(JobStatus::Failed | JobStatus::Cancelled) => NestedSequenceMediaStatus::Failed,
                None => NestedSequenceMediaStatus::Missing,
            }
        };
        items.push(NestedSequenceMedia {
            clip_id: clip.id,
            project_id,
            expected_revision: project_revision,
            current_revision,
            status,
            preview_job_id: preview.map(|record| record.job.id),
        });
    }
    Ok(Json(items))
}

async fn start_nested_preview(state: &AppState, nested: &Project) -> Option<Uuid> {
    match state
        .exports
        .start(
            "project_preview",
            nested.id,
            serde_json::json!({
                "encoder":"auto",
                "quality":70,
                "range_start_seconds":0.0,
                "range_end_seconds":nested.document.duration_seconds,
            }),
        )
        .await
    {
        Ok(job) => {
            state.events.publish("export_job", "created", Some(job.id));
            Some(job.id)
        }
        Err(error) => {
            tracing::warn!(%error, project_id = %nested.id, "nested sequence preview was not started");
            None
        }
    }
}

async fn refresh_nested_sequence(
    State(state): State<AppState>,
    Path((id, clip_id)): Path<(Uuid, Uuid)>,
    ApiJson(request): ApiJson<RefreshNestedSequenceRequest>,
) -> ApiResult<Json<RefreshNestedSequenceResponse>> {
    let parent = state
        .storage
        .get_project(id)
        .await?
        .ok_or_else(|| ApiError::not_found("project"))?;
    if parent.revision != request.base_revision {
        return Err(vibe_cs_domain::DomainError::Conflict(format!(
            "project is at revision {}, nested refresh expects {}",
            parent.revision, request.base_revision
        ))
        .into());
    }
    let story = parent
        .document
        .tracks
        .iter()
        .find(|track| track.id == parent.document.story_track_id)
        .ok_or_else(|| ApiError::invalid("Story track does not exist"))?;
    let index = story
        .clips
        .iter()
        .position(|clip| clip.id == clip_id)
        .ok_or_else(|| ApiError::not_found("nested sequence clip"))?;
    let TimelineClipMaterial::Sequence { project_id, .. } = story.clips[index].material else {
        return Err(ApiError::invalid("selected clip is not a nested sequence"));
    };
    let nested = state
        .storage
        .get_project(project_id)
        .await?
        .ok_or_else(|| ApiError::not_found("nested sequence"))?;
    let old_duration = story.clips[index].placement.duration;
    let new_duration = nested.document.duration_seconds;
    let delta = new_duration - old_duration;
    let mut clips = story.clips.clone();
    let nested_name = {
        let replacement = &mut clips[index];
        replacement.material = TimelineClipMaterial::Sequence {
            project_id,
            project_revision: nested.revision,
            media_duration_seconds: new_duration,
        };
        replacement.placement.duration = new_duration;
        replacement.placement.source_in = 0.0;
        replacement.placement.source_out = new_duration;
        replacement.speed_segments.clear();
        replacement.name.clone()
    };
    for clip in clips.iter_mut().skip(index + 1) {
        clip.placement.start += delta;
    }
    let patch = ProjectPatch {
        project_id: id,
        base_revision: parent.revision,
        scope: ProjectPatchScope::Project,
        author: ProjectChangeAuthor::Human,
        reverts_change_group_id: None,
        summary: format!("Refresh nested sequence: {nested_name}"),
        operations: vec![ProjectEditOperation::ReplaceTrackClips {
            track_id: story.id,
            clips,
        }],
    };
    let (parent_project, change_group) = state
        .storage
        .apply_project_patch(patch, Uuid::new_v4(), Utc::now())
        .await?;
    state.events.publish(PROJECT_RESOURCE, "edited", Some(id));
    let preview_job_id = start_nested_preview(&state, &nested).await;
    Ok(Json(RefreshNestedSequenceResponse {
        parent_project,
        change_group,
        preview_job_id,
    }))
}

async fn create_nested_sequence(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    ApiJson(request): ApiJson<CreateNestedSequenceRequest>,
) -> ApiResult<Json<CreateNestedSequenceResponse>> {
    let parent = state
        .storage
        .get_project(id)
        .await?
        .ok_or_else(|| ApiError::not_found("project"))?;
    if parent.revision != request.base_revision {
        return Err(vibe_cs_domain::DomainError::Conflict(format!(
            "project is at revision {}, nesting expects {}",
            parent.revision, request.base_revision
        ))
        .into());
    }
    let name = request.name.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(ApiError::invalid(
            "nested sequence name must contain 1 to 200 characters",
        ));
    }
    let selected_ids = request
        .clip_ids
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    if selected_ids.is_empty() || selected_ids.len() > 500 {
        return Err(ApiError::invalid(
            "nested sequence requires between 1 and 500 selected clips",
        ));
    }
    let story = parent
        .document
        .tracks
        .iter()
        .find(|track| track.id == parent.document.story_track_id)
        .ok_or_else(|| ApiError::invalid("Story track does not exist"))?;
    if story.locked {
        return Err(
            vibe_cs_domain::DomainError::Conflict("Story track is locked".to_owned()).into(),
        );
    }
    let selected_indices = story
        .clips
        .iter()
        .enumerate()
        .filter_map(|(index, clip)| selected_ids.contains(&clip.id).then_some(index))
        .collect::<Vec<_>>();
    if selected_indices.len() != selected_ids.len() {
        return Err(ApiError::invalid(
            "nested sequence currently accepts clips from the Story track only",
        ));
    }
    let first_index = *selected_indices.first().expect("non-empty selection");
    let last_index = *selected_indices.last().expect("non-empty selection");
    if last_index - first_index + 1 != selected_indices.len() {
        return Err(ApiError::invalid(
            "nested sequence selection must be consecutive on the Story track",
        ));
    }
    let selected = &story.clips[first_index..=last_index];
    if selected.iter().any(|clip| !clip.placement.enabled) {
        return Err(ApiError::invalid("disabled Story clips cannot be nested"));
    }
    let range_start = selected
        .iter()
        .map(|clip| clip.placement.start)
        .fold(f64::INFINITY, f64::min);
    let range_end = selected
        .iter()
        .map(|clip| clip.placement.start + clip.placement.duration)
        .fold(0.0_f64, f64::max);
    let duration = range_end - range_start;
    if !duration.is_finite() || duration <= 0.0 {
        return Err(ApiError::invalid("nested sequence duration is invalid"));
    }
    let nested_id = Uuid::new_v4();
    let nested_story_id = Uuid::new_v4();
    let now = Utc::now();
    let nested_clips = selected
        .iter()
        .map(|clip| {
            let mut clip = clip.clone();
            clip.id = Uuid::new_v4();
            clip.placement.start -= range_start;
            clip.group_id = None;
            clip.link_group_id = None;
            clip
        })
        .collect::<Vec<_>>();
    let nested_project = Project {
        id: nested_id,
        name: name.to_owned(),
        revision: 1,
        document: EditingDocument {
            width: parent.document.width,
            height: parent.document.height,
            fps: parent.document.fps,
            duration_seconds: duration,
            story_track_id: nested_story_id,
            tracks: vec![TimelineTrack {
                id: nested_story_id,
                name: "Story".to_owned(),
                kind: TrackKind::Video,
                order: 0,
                muted: false,
                solo: false,
                volume: 1.0,
                pan: 0.0,
                keyframes: Vec::new(),
                locked: false,
                hidden: false,
                clips: nested_clips,
            }],
            markers: parent
                .document
                .markers
                .iter()
                .filter(|marker| marker.time >= range_start && marker.time < range_end)
                .cloned()
                .map(|mut marker| {
                    marker.id = Uuid::new_v4();
                    marker.time -= range_start;
                    marker
                })
                .collect(),
            settings: parent.document.settings.clone(),
        },
        created_at: now,
        updated_at: now,
    };
    let nested_clip = TimelineClip {
        id: Uuid::new_v4(),
        name: name.to_owned(),
        capture_intent: None,
        material: TimelineClipMaterial::Sequence {
            project_id: nested_id,
            project_revision: 1,
            media_duration_seconds: duration,
        },
        placement: TimelinePlacement {
            start: range_start,
            duration,
            source_in: 0.0,
            source_out: duration,
            speed: 1.0,
            reverse: false,
            frame_hold_source_time: None,
            volume: 1.0,
            pan: 0.0,
            enabled: true,
        },
        transform: Transform::default(),
        effects: Vec::new(),
        transitions: TimelineClipTransitions::default(),
        text: None,
        metadata: serde_json::json!({"nested_sequence":true}),
        group_id: None,
        link_group_id: None,
        keyframes: Vec::new(),
        speed_segments: Vec::new(),
    };
    let mut parent_clips = story.clips[..first_index].to_vec();
    parent_clips.push(nested_clip);
    parent_clips.extend_from_slice(&story.clips[last_index + 1..]);
    let patch = ProjectPatch {
        project_id: id,
        base_revision: parent.revision,
        scope: ProjectPatchScope::Project,
        author: ProjectChangeAuthor::Human,
        reverts_change_group_id: None,
        summary: format!("Create nested sequence: {name}"),
        operations: vec![ProjectEditOperation::ReplaceTrackClips {
            track_id: story.id,
            clips: parent_clips,
        }],
    };
    let (parent_project, nested_project, change_group) = state
        .storage
        .create_nested_project(nested_project, patch, Uuid::new_v4(), now)
        .await?;
    state
        .events
        .publish(PROJECT_RESOURCE, "created", Some(nested_project.id));
    state.events.publish(PROJECT_RESOURCE, "edited", Some(id));
    let preview_job_id = start_nested_preview(&state, &nested_project).await;
    Ok(Json(CreateNestedSequenceResponse {
        parent_project,
        nested_project,
        change_group,
        preview_job_id,
    }))
}

async fn remove_managed_preview_file(root: &std::path::Path, path: &str) -> ApiResult<()> {
    let requested = std::path::PathBuf::from(path);
    if !requested.exists() {
        return Ok(());
    }
    let canonical_root = tokio::fs::canonicalize(root)
        .await
        .map_err(|_| ApiError::invalid("render preview root is unavailable"))?;
    let canonical_path = tokio::fs::canonicalize(&requested)
        .await
        .map_err(|_| ApiError::invalid("render preview path is unavailable"))?;
    if canonical_path.parent() != Some(canonical_root.as_path()) {
        return Err(ApiError::invalid(
            "render preview path is outside the managed preview directory",
        ));
    }
    tokio::fs::remove_file(canonical_path)
        .await
        .map_err(|error| {
            ApiError::invalid(format!("render preview could not be removed: {error}"))
        })?;
    Ok(())
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

async fn get_edit_lease(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Option<ProjectEditLease>>> {
    Ok(Json(state.storage.get_project_edit_lease(id).await?))
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
    use vibe_cs_domain::{ExportJob, JobStatus};
    use vibe_cs_storage::{ExportJobRecord, Storage};

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

    fn clip_json(id: Uuid, name: &str, start: f64) -> Value {
        json!({
            "id":id,
            "name":name,
            "capture_intent":null,
            "material":{"kind":"asset","asset_id":Uuid::new_v4(),"media_duration_seconds":5.0},
            "placement":{"start":start,"duration":5.0,"source_in":0.0,"source_out":5.0,"speed":1.0,"reverse":false,"frame_hold_source_time":null,"volume":1.0,"pan":0.0,"enabled":true},
            "transform":{"x":0.0,"y":0.0,"scale_x":1.0,"scale_y":1.0,"rotation":0.0,"opacity":1.0},
            "effects":[],
            "transitions":{"video_in":null,"video_out":null,"audio_in":null,"audio_out":null},
            "text":null,
            "metadata":{},
            "group_id":null,
            "link_group_id":null,
            "keyframes":[],
            "speed_segments":[]
        })
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

    #[tokio::test]
    async fn recording_and_export_confirmation_reject_a_stale_project_revision() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let (router, _directory) = dispatcher(storage);
        let (_, created) = call(
            &router,
            Method::POST,
            "/api/projects",
            Some(
                json!({"name":"Consent","width":1920,"height":1080,"fps":60,"source_demo_ids":[]}),
            ),
        )
        .await;
        let project_id = created["id"].as_str().expect("project id");

        let (recording_status, _) = call(
            &router,
            Method::POST,
            &format!("/api/projects/{project_id}/recording-plan"),
            Some(json!({"expected_revision":2,"clip_ids":[]})),
        )
        .await;
        assert_eq!(recording_status, 409);

        let (export_status, _) = call(
            &router,
            Method::POST,
            &format!("/api/projects/{project_id}/export"),
            Some(json!({"expected_revision":2,"confirm":true,"encoder":"auto","quality":80})),
        )
        .await;
        assert_eq!(export_status, 409);
    }

    #[tokio::test]
    async fn consecutive_story_clips_become_one_atomic_nested_project_and_parent_clip() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let (router, _directory) = dispatcher(storage);
        let (_, created) = call(
            &router,
            Method::POST,
            "/api/projects",
            Some(json!({"name":"Parent","width":1920,"height":1080,"fps":60,"source_demo_ids":[]})),
        )
        .await;
        let project_id = created["id"].as_str().expect("project id");
        let story_id = created["document"]["story_track_id"]
            .as_str()
            .expect("story id");
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let (status, patched) = call(
            &router,
            Method::PATCH,
            &format!("/api/projects/{project_id}"),
            Some(json!({
                "project_id":project_id,
                "base_revision":1,
                "scope":{"kind":"project"},
                "author":{"kind":"human"},
                "reverts_change_group_id":null,
                "summary":"Add clips",
                "operations":[{"op":"replace_track_clips","track_id":story_id,"clips":[clip_json(first,"A",0.0),clip_json(second,"B",5.0)]}]
            })),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(patched["project"]["revision"], 2);

        let (status, nested) = call(
            &router,
            Method::POST,
            &format!("/api/projects/{project_id}/nested-sequences"),
            Some(json!({"base_revision":2,"name":"Action core","clip_ids":[first,second]})),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(nested["parent_project"]["revision"], 3);
        assert_eq!(nested["nested_project"]["revision"], 1);
        assert_eq!(
            nested["nested_project"]["document"]["duration_seconds"],
            10.0
        );
        assert_eq!(
            nested["nested_project"]["document"]["tracks"][0]["clips"]
                .as_array()
                .expect("child clips")
                .len(),
            2
        );
        assert_eq!(
            nested["parent_project"]["document"]["tracks"][0]["clips"]
                .as_array()
                .expect("parent clips")
                .len(),
            1
        );
        assert_eq!(
            nested["parent_project"]["document"]["tracks"][0]["clips"][0]["material"]["kind"],
            "sequence"
        );
        assert_eq!(nested["preview_job_id"], Value::Null);
        let nested_id = nested["nested_project"]["id"].as_str().expect("nested id");
        assert_eq!(
            nested["parent_project"]["document"]["tracks"][0]["clips"][0]["material"]["project_id"],
            nested_id
        );

        let (_, media) = call(
            &router,
            Method::GET,
            &format!("/api/projects/{project_id}/nested-sequences"),
            None,
        )
        .await;
        assert_eq!(media[0]["status"], "missing");
        let (_, gate) = call(
            &router,
            Method::GET,
            &format!("/api/projects/{project_id}/delivery-gate"),
            None,
        )
        .await;
        assert_eq!(gate["ready"], false);
        assert_eq!(gate["blockers"][0]["state"], "stale");
        let (_, projects) = call(&router, Method::GET, "/api/projects", None).await;
        assert_eq!(projects.as_array().expect("projects").len(), 2);
    }

    #[test]
    fn export_settings_are_validated_before_a_job_is_created() {
        let valid = ProjectExportRequest {
            expected_revision: 1,
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

    #[tokio::test]
    async fn render_preview_list_and_cleanup_use_only_the_managed_preview_kind() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let (router, directory) = dispatcher(storage.clone());
        let (_, created) = call(
            &router,
            Method::POST,
            "/api/projects",
            Some(json!({
                "name":"Preview",
                "width":1920,
                "height":1080,
                "fps":60,
                "source_demo_ids":[]
            })),
        )
        .await;
        let project_id =
            Uuid::parse_str(created["id"].as_str().expect("project id")).expect("project uuid");
        let preview_dir = directory.path().join("data").join("previews");
        tokio::fs::create_dir_all(&preview_dir)
            .await
            .expect("preview directory");
        let preview_path = preview_dir.join("project_preview.mp4");
        tokio::fs::write(&preview_path, b"preview")
            .await
            .expect("preview file");
        let preview_id = Uuid::new_v4();
        let now = Utc::now();
        storage
            .put_export_job(ExportJobRecord {
                kind: "project_preview".to_owned(),
                job: ExportJob {
                    id: preview_id,
                    project_id,
                    project_revision: 1,
                    range_start_seconds: 1.0,
                    range_end_seconds: 3.0,
                    status: JobStatus::Completed,
                    progress: 1.0,
                    output_path: preview_path.to_string_lossy().into_owned(),
                    error: None,
                    error_code: None,
                    created_at: now,
                    updated_at: now,
                },
            })
            .await
            .expect("preview record");

        let (status, previews) = call(
            &router,
            Method::GET,
            &format!("/api/projects/{project_id}/render-previews"),
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(previews[0]["job"]["id"], preview_id.to_string());

        let (status, cleaned) = call(
            &router,
            Method::DELETE,
            &format!("/api/projects/{project_id}/render-previews"),
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(cleaned, json!({"removed":1,"cancellation_requested":0}));
        assert!(!preview_path.exists());
        assert!(
            storage
                .get_export_job(preview_id)
                .await
                .expect("record read")
                .is_none()
        );
    }

    #[tokio::test]
    async fn render_preview_cleanup_never_removes_an_external_path() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let (router, directory) = dispatcher(storage.clone());
        let (_, created) = call(
            &router,
            Method::POST,
            "/api/projects",
            Some(json!({
                "name":"Preview boundary",
                "width":1920,
                "height":1080,
                "fps":60,
                "source_demo_ids":[]
            })),
        )
        .await;
        let project_id =
            Uuid::parse_str(created["id"].as_str().expect("project id")).expect("project uuid");
        let external = directory.path().join("external.mp4");
        tokio::fs::write(&external, b"keep")
            .await
            .expect("external sentinel");
        let preview_id = Uuid::new_v4();
        let now = Utc::now();
        storage
            .put_export_job(ExportJobRecord {
                kind: "project_preview".to_owned(),
                job: ExportJob {
                    id: preview_id,
                    project_id,
                    project_revision: 1,
                    range_start_seconds: 0.0,
                    range_end_seconds: 1.0,
                    status: JobStatus::Completed,
                    progress: 1.0,
                    output_path: external.to_string_lossy().into_owned(),
                    error: None,
                    error_code: None,
                    created_at: now,
                    updated_at: now,
                },
            })
            .await
            .expect("preview record");

        let (status, _) = call(
            &router,
            Method::DELETE,
            &format!("/api/projects/{project_id}/render-previews"),
            None,
        )
        .await;
        assert_eq!(status, 400);
        assert!(external.exists());
        assert!(
            storage
                .get_export_job(preview_id)
                .await
                .expect("record read")
                .is_some()
        );
    }
}
