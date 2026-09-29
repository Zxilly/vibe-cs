use axum::{
    Json, Router,
    extract::{Path, State},
    routing::post,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;
use vibe_cs_domain::RecordingRequest;

use crate::{ApiError, ApiJson, ApiResult, AppState, CameraPreview};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/camera-preview", post(preview_proposal))
        .route(
            "/api/projects/{project_id}/clips/{clip_id}/camera-preview",
            post(preview_project_clip),
        )
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
struct CameraPreviewRequest {
    capture: RecordingRequest,
}

async fn preview_proposal(
    State(state): State<AppState>,
    ApiJson(input): ApiJson<CameraPreviewRequest>,
) -> ApiResult<Json<CameraPreview>> {
    Ok(Json(state.camera_preview.preview(input.capture).await?))
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct ProjectCameraPreviewRequest {
    revision: u64,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
struct ProjectCameraPreviewResponse {
    project_id: Uuid,
    revision: u64,
    clip_id: Uuid,
    preview: CameraPreview,
    inspection: Option<crate::CameraInspection>,
}

async fn preview_project_clip(
    State(state): State<AppState>,
    Path((project_id, clip_id)): Path<(Uuid, Uuid)>,
    ApiJson(input): ApiJson<ProjectCameraPreviewRequest>,
) -> ApiResult<Json<ProjectCameraPreviewResponse>> {
    let project = state
        .storage
        .get_project(project_id)
        .await?
        .ok_or_else(|| ApiError::not_found("project"))?;
    if project.revision != input.revision {
        return Err(ApiError::from(vibe_cs_domain::DomainError::Conflict(
            "Project revision changed before camera preview".to_owned(),
        )));
    }
    let clip = project
        .document
        .tracks
        .iter()
        .flat_map(|track| &track.clips)
        .find(|clip| clip.id == clip_id)
        .ok_or_else(|| ApiError::not_found("Timeline Clip"))?;
    let capture = clip
        .capture_intent
        .clone()
        .ok_or_else(|| ApiError::invalid("Timeline Clip has no Capture Intent".to_owned()))?
        .into_recording_request(clip.id, &clip.name);
    let preview = state.camera_preview.preview(capture).await?;
    let current = state
        .storage
        .get_project(project_id)
        .await?
        .ok_or_else(|| ApiError::not_found("project"))?;
    if current.revision != input.revision {
        return Err(ApiError::from(vibe_cs_domain::DomainError::Conflict(
            "Project revision changed during camera preview".to_owned(),
        )));
    }
    Ok(Json(ProjectCameraPreviewResponse {
        project_id,
        revision: input.revision,
        clip_id,
        inspection: preview.plan.as_ref().map(crate::CameraPlan::inspection),
        preview,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;
    use vibe_cs_domain::{DomainError, HlaeCameraStyle, Project};

    #[derive(Debug, Default)]
    struct ProbePreview {
        calls: Mutex<Vec<RecordingRequest>>,
        mutate: Option<(vibe_cs_storage::Storage, Uuid)>,
    }

    #[async_trait::async_trait]
    impl crate::CameraPreviewPort for ProbePreview {
        async fn preview(&self, request: RecordingRequest) -> Result<CameraPreview, DomainError> {
            let demo_id = request.demo_id;
            let style = request.camera_style;
            self.calls.lock().unwrap().push(request);
            if let Some((storage, id)) = &self.mutate {
                storage
                    .apply_project_patch(
                        vibe_cs_domain::ProjectPatch {
                            project_id: *id,
                            base_revision: 1,
                            scope: vibe_cs_domain::ProjectPatchScope::Project,
                            author: vibe_cs_domain::ProjectChangeAuthor::Human,
                            reverts_change_group_id: None,
                            summary: "Concurrent edit".to_owned(),
                            operations: vec![vibe_cs_domain::ProjectEditOperation::RenameProject {
                                name: "Updated".to_owned(),
                            }],
                        },
                        Uuid::new_v4(),
                        chrono::Utc::now(),
                    )
                    .await
                    .unwrap();
            }
            Ok(CameraPreview {
                replay: crate::CameraReplaySource {
                    demo_id,
                    producer_run_id: Uuid::nil(),
                },
                map_name: "de_mirage".to_owned(),
                player_id: "target".to_owned(),
                start_tick: 100,
                end_tick: 200,
                tick_rate: 64.0,
                aspect_ratio: 16.0 / 9.0,
                plan: (style != HlaeCameraStyle::Pov).then_some(crate::CameraPlan {
                    requested_style: HlaeCameraStyle::Flyby,
                    effective_style: HlaeCameraStyle::Flyby,
                    adjusted: false,
                    shot: vibe_cs_hlae::CameraShot {
                        id: "preview".to_owned(),
                        start_tick: 100,
                        end_tick: 200,
                        position_interpolation: vibe_cs_hlae::PositionInterpolation::Cubic,
                        rotation_interpolation: vibe_cs_hlae::RotationInterpolation::SphericalCubic,
                        keyframes: vec![],
                    },
                    samples: vec![],
                    diagnostics: vec![],
                    original_diagnostics: vec![],
                    geometry_unavailable: Some("fixture has no geometry".to_owned()),
                }),
            })
        }
    }

    fn project_fixture() -> (Project, Uuid) {
        let project_id = Uuid::new_v4();
        let track_id = Uuid::new_v4();
        let clip_id = Uuid::new_v4();
        let now = chrono::Utc::now();
        let clip = json!({"id":clip_id,"name":"FalleN","capture_intent":{
            "demo_id":Uuid::new_v4(),"highlight_id":"20:kill","player_id":"target", "start_tick":100,"end_tick":200,
            "pre_roll_seconds":0.0,"post_roll_seconds":0.0,"victim_pov":false,"camera_style":"flyby","presentation":null},
            "material":{"kind":"planned"}, "placement":{"start":0.0,"duration":2.0,"source_in":0.0,"source_out":2.0,"speed":1.0,
                "reverse":false,"frame_hold_source_time":null,"volume":1.0,"pan":0.0,"enabled":true},
            "transform":{"x":0.0,"y":0.0,"scale_x":1.0,"scale_y":1.0,"rotation":0.0,"opacity":1.0},
            "effects":[],"transitions":{"video_in":null,"video_out":null,"audio_in":null,"audio_out":null},
            "text":null,"metadata":{},"group_id":null,"link_group_id":null,"keyframes":[],"speed_segments":[]
        });
        let project = serde_json::from_value(json!({
            "id":project_id,"name":"Camera","revision":1,"created_at":now,"updated_at":now,
            "document":{"width":1920,"height":1080,"fps":60,"duration_seconds":2.0,"story_track_id":track_id,
                "markers":[],"settings":{"source_demo_ids":[],"ripple_sequence_markers":false,"use_media_proxies":false},
                "tracks":[{"id":track_id,"name":"Story","kind":"video","order":0,"muted":false,"solo":false,
                    "volume":1.0,"pan":0.0,"keyframes":[],"locked":false,"hidden":false,
                    "clips":[clip]}]}
        })).unwrap();
        (project, clip_id)
    }

    async fn call(app: &Router, path: &str, revision: u64) -> (u16, Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"revision":revision}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status().as_u16();
        (
            status,
            serde_json::from_slice(&to_bytes(response.into_body(), 100_000).await.unwrap())
                .unwrap(),
        )
    }

    #[tokio::test]
    async fn preview_is_bound_to_project_head_and_clip_without_creating_an_edit() {
        let storage = vibe_cs_storage::Storage::open_in_memory().await.unwrap();
        let (project, clip_id) = project_fixture();
        let id = project.id;
        storage.create_project(project.clone()).await.unwrap();
        let port = Arc::new(ProbePreview::default());
        let root = tempfile::tempdir().unwrap();
        let app = crate::build_dispatcher(
            AppState::new(storage.clone(), root.path().to_path_buf())
                .with_camera_preview(port.clone()),
        );
        let path = format!("/api/projects/{id}/clips/{clip_id}/camera-preview");
        assert_eq!(call(&app, &path, 2).await.0, 409);
        assert!(port.calls.lock().unwrap().is_empty());
        assert_eq!(
            call(
                &app,
                &format!("/api/projects/{id}/clips/{}/camera-preview", Uuid::new_v4()),
                1
            )
            .await
            .0,
            404
        );
        let (status, result) = call(&app, &path, 1).await;
        assert_eq!(status, 200);
        assert_eq!(result["projectId"], json!(id));
        assert_eq!(result["clipId"], json!(clip_id));
        assert_eq!(result["revision"], 1);
        assert_eq!(port.calls.lock().unwrap()[0].id, Some(clip_id));
        assert_eq!(storage.get_project(id).await.unwrap().unwrap(), project);
    }

    #[tokio::test]
    async fn a_head_change_during_planning_rejects_the_stale_preview() {
        let storage = vibe_cs_storage::Storage::open_in_memory().await.unwrap();
        let (project, clip_id) = project_fixture();
        let id = project.id;
        storage.create_project(project).await.unwrap();
        let port = Arc::new(ProbePreview {
            mutate: Some((storage.clone(), id)),
            ..ProbePreview::default()
        });
        let root = tempfile::tempdir().unwrap();
        let app = crate::build_dispatcher(
            AppState::new(storage, root.path().to_path_buf()).with_camera_preview(port),
        );
        assert_eq!(
            call(
                &app,
                &format!("/api/projects/{id}/clips/{clip_id}/camera-preview"),
                1
            )
            .await
            .0,
            409
        );
    }
}
