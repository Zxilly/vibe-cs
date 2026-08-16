//! Saved recording shot settings: the shot inspector's save-as-preset action.
//!
//! These four routes are deliberately shaped like `/api/editor/presets` with
//! one difference: they carry no `expected_revision`.
//!
//! An editor preset needs one because it has a second writer.
//! `/api/editor/projects/{id}/clips/{id}/apply-preset` is a *server-side* write
//! that reads a preset and mutates a project with it, so the applier pins the
//! exact preset version it read; without that pin, a preset edited between the
//! read and the apply would change a project nobody edited.
//!
//! A recording shot preset has no such writer. Applying one is a client-side
//! copy of six values into the shot inspector, and the resulting
//! [`RecordingRequest`](vibe_cs_domain::RecordingRequest) carries those values
//! by value: nothing on the server ever dereferences a preset id afterwards, so
//! no stored object can be changed out from under its owner. What remains is
//! two windows editing one named settings blob, where the loser loses only the
//! settings they just typed and can see the winner's document in the response.
//! [`RecordingShotPreset`] accordingly carries no revision field, and a
//! concurrency token that the wire contract has nowhere to put would be a token
//! no client could honestly send back.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::get,
};
use serde::Serialize;
use uuid::Uuid;
use vibe_cs_domain::{RecordingShotPreset, RecordingShotPresetDraft};

use crate::{ApiError, ApiJson, ApiResult, AppState};

/// The resource name this module publishes change events under.
const PRESET_RESOURCE: &str = "recording_shot_preset";

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/recording/shot-presets",
            get(list_shot_presets).post(create_shot_preset),
        )
        .route(
            "/api/recording/shot-presets/{id}",
            get(get_shot_preset)
                .put(put_shot_preset)
                .delete(delete_shot_preset),
        )
}

#[derive(Debug, Serialize)]
struct ShotPresetList {
    items: Vec<RecordingShotPreset>,
}

/// Lists every saved preset, most recently changed first.
async fn list_shot_presets(State(state): State<AppState>) -> ApiResult<Json<ShotPresetList>> {
    Ok(Json(ShotPresetList {
        items: state.storage.list_recording_shot_presets().await?,
    }))
}

async fn get_shot_preset(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<RecordingShotPreset>> {
    state
        .storage
        .get_recording_shot_preset(id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("recording shot preset"))
}

/// Saves a new preset. A draft whose camera style and presentation could not be
/// recorded together is rejected here, at the moment the user can still see
/// what they chose, rather than when the preset is applied.
async fn create_shot_preset(
    State(state): State<AppState>,
    ApiJson(draft): ApiJson<RecordingShotPresetDraft>,
) -> ApiResult<(StatusCode, Json<RecordingShotPreset>)> {
    let preset = state.storage.create_recording_shot_preset(draft).await?;
    state
        .events
        .publish(PRESET_RESOURCE, "created", Some(preset.id));
    Ok((StatusCode::CREATED, Json(preset)))
}

/// Replaces one preset's settings. Its identity and creation time are kept.
async fn put_shot_preset(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    ApiJson(draft): ApiJson<RecordingShotPresetDraft>,
) -> ApiResult<Json<RecordingShotPreset>> {
    let preset = state
        .storage
        .update_recording_shot_preset(id, draft)
        .await?
        .ok_or_else(|| ApiError::not_found("recording shot preset"))?;
    state.events.publish(PRESET_RESOURCE, "updated", Some(id));
    Ok(Json(preset))
}

/// Deletes one preset. Recordings that were made with it keep their settings:
/// applying a preset copies its values, it does not reference it.
async fn delete_shot_preset(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    if state.storage.delete_recording_shot_preset(id).await? {
        state.events.publish(PRESET_RESOURCE, "deleted", Some(id));
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("recording shot preset"))
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

    fn pov_draft() -> Value {
        json!({
            "name": "选手 POV · 三杀",
            "camera_style": "pov",
            "victim_pov": false,
            "pre_roll_seconds": 1.5,
            "post_roll_seconds": 1.0,
            "presentation": {
                "camera_fov": 106.0,
                "viewmodel_fov": 60.0,
                "flash_alpha": 102,
                "show_hud": false,
                "show_radar": true,
                "voice": "target_only"
            }
        })
    }

    #[tokio::test]
    async fn shot_presets_are_listed_created_replaced_and_deleted() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let (router, _directory) = dispatcher(storage);

        let (status, empty) = call(&router, Method::GET, "/api/recording/shot-presets", None).await;
        assert_eq!(status, 200);
        assert_eq!(empty["items"], json!([]));

        let (status, created) = call(
            &router,
            Method::POST,
            "/api/recording/shot-presets",
            Some(pov_draft()),
        )
        .await;
        assert_eq!(status, 201);
        assert_eq!(created["name"], "选手 POV · 三杀");
        assert_eq!(created["presentation"]["camera_fov"], 106.0);
        assert_eq!(created["presentation"]["voice"], "target_only");
        let id: Uuid = serde_json::from_value(created["id"].clone()).expect("preset id");

        let (status, listed) =
            call(&router, Method::GET, "/api/recording/shot-presets", None).await;
        assert_eq!(status, 200);
        assert_eq!(listed["items"][0]["id"], json!(id));

        let (status, fetched) = call(
            &router,
            Method::GET,
            &format!("/api/recording/shot-presets/{id}"),
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(fetched, created);

        let (status, replaced) = call(
            &router,
            Method::PUT,
            &format!("/api/recording/shot-presets/{id}"),
            Some(json!({
                "name": "观察者 · 建立镜头",
                "camera_style": "crane",
                "victim_pov": false,
                "pre_roll_seconds": 2.0,
                "post_roll_seconds": 1.5,
                "presentation": {
                    "camera_fov": 90.0,
                    "viewmodel_fov": 68.0,
                    "flash_alpha": 255,
                    "show_hud": false,
                    "show_radar": false,
                    "voice": "muted"
                }
            })),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(replaced["id"], json!(id));
        assert_eq!(replaced["camera_style"], "crane");
        assert_eq!(replaced["created_at"], created["created_at"]);

        let (status, _) = call(
            &router,
            Method::DELETE,
            &format!("/api/recording/shot-presets/{id}"),
            None,
        )
        .await;
        assert_eq!(status, 204);

        for (method, body) in [
            (Method::GET, None),
            (Method::PUT, Some(pov_draft())),
            (Method::DELETE, None),
        ] {
            let (status, error) = call(
                &router,
                method,
                &format!("/api/recording/shot-presets/{id}"),
                body,
            )
            .await;
            assert_eq!(status, 404);
            assert_eq!(error["code"], "not_found");
        }
    }

    #[tokio::test]
    async fn a_preset_whose_presentation_fights_its_camera_style_is_rejected() {
        let storage = Storage::open_in_memory().await.expect("storage");
        let (router, _directory) = dispatcher(storage);

        // An observer shot takes its field of view from the camera path, so a
        // preset that carried one would be a slider that does nothing.
        let (status, error) = call(
            &router,
            Method::POST,
            "/api/recording/shot-presets",
            Some(json!({
                "name": "跟随 · 120 FOV",
                "camera_style": "tracking",
                "victim_pov": false,
                "pre_roll_seconds": 1.0,
                "post_roll_seconds": 1.0,
                "presentation": {
                    "camera_fov": 120.0,
                    "viewmodel_fov": 68.0,
                    "flash_alpha": 255,
                    "show_hud": true,
                    "show_radar": true,
                    "voice": "all_players"
                }
            })),
        )
        .await;
        assert_eq!(status, 400);
        assert_eq!(error["code"], "invalid_input");

        // Victim POV is a POV-only choice, and an empty name is not a name.
        for invalid in [
            json!({ "camera_style": "tracking", "victim_pov": true }),
            json!({ "name": "   " }),
            json!({ "pre_roll_seconds": 61.0 }),
        ] {
            let mut body = pov_draft();
            for (key, value) in invalid.as_object().expect("overrides") {
                body[key] = value.clone();
            }
            let (status, _) = call(
                &router,
                Method::POST,
                "/api/recording/shot-presets",
                Some(body),
            )
            .await;
            assert_eq!(status, 400);
        }

        // A preset must not be able to retarget the recording it is applied to.
        let mut retargeting = pov_draft();
        retargeting["demo_id"] = json!(Uuid::new_v4());
        let (status, _) = call(
            &router,
            Method::POST,
            "/api/recording/shot-presets",
            Some(retargeting),
        )
        .await;
        assert_eq!(status, 400);

        let (status, listed) =
            call(&router, Method::GET, "/api/recording/shot-presets", None).await;
        assert_eq!(status, 200);
        assert_eq!(listed["items"], json!([]));
    }
}
