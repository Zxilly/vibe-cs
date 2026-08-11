use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    routing::{get, post},
};
use uuid::Uuid;

use crate::{
    ApiError, ApiJson, ApiResult, AppState, ObsVideoApplyRequest, ObsVideoApplyResult,
    ObsVideoBackup, ObsVideoBackupDeleteResult, ObsVideoRestoreRequest, ObsVideoRestoreResult,
    ObsVideoTuningPlan,
};

const MAXIMUM_OBS_TUNING_PAYLOAD_BYTES: usize = 1024;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/obs/video-tuning/plan", get(plan))
        .route(
            "/api/obs/video-tuning/apply",
            post(apply).layer(DefaultBodyLimit::max(MAXIMUM_OBS_TUNING_PAYLOAD_BYTES)),
        )
        .route("/api/obs/video-tuning/backups", get(list_backups))
        .route(
            "/api/obs/video-tuning/backups/{id}",
            axum::routing::delete(delete_backup),
        )
        .route(
            "/api/obs/video-tuning/backups/{id}/restore",
            post(restore).layer(DefaultBodyLimit::max(MAXIMUM_OBS_TUNING_PAYLOAD_BYTES)),
        )
}

async fn plan(State(state): State<AppState>) -> ApiResult<Json<ObsVideoTuningPlan>> {
    Ok(Json(state.obs_tuning.plan().await?))
}

async fn apply(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<ObsVideoApplyRequest>,
) -> ApiResult<Json<ObsVideoApplyResult>> {
    require_confirmation(request.confirm)?;
    validate_fingerprint(&request.expected_fingerprint)?;
    let result = state.obs_tuning.apply(request).await?;
    state.events.publish(
        "obs_video_settings",
        "applied",
        result.backup.as_ref().map(|backup| backup.id),
    );
    Ok(Json(result))
}

async fn list_backups(State(state): State<AppState>) -> ApiResult<Json<Vec<ObsVideoBackup>>> {
    Ok(Json(state.obs_tuning.list_backups().await?))
}

async fn restore(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    ApiJson(request): ApiJson<ObsVideoRestoreRequest>,
) -> ApiResult<Json<ObsVideoRestoreResult>> {
    require_confirmation(request.confirm)?;
    let result = state.obs_tuning.restore(id, request).await?;
    state
        .events
        .publish("obs_video_settings", "restored", Some(id));
    Ok(Json(result))
}

async fn delete_backup(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<ObsVideoBackupDeleteResult>> {
    let result = state.obs_tuning.delete_backup(id).await?;
    state
        .events
        .publish("obs_video_backup", "deleted", Some(id));
    Ok(Json(result))
}

fn require_confirmation(confirm: bool) -> ApiResult<()> {
    if confirm {
        Ok(())
    } else {
        Err(ApiError::invalid("explicit confirmation is required"))
    }
}

fn validate_fingerprint(fingerprint: &str) -> ApiResult<()> {
    if fingerprint.len() == 64
        && fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(ApiError::invalid(
            "expected_fingerprint must be a lowercase SHA-256 value",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_requests_reject_targets_unknown_fields_and_missing_confirmation() {
        assert!(
            serde_json::from_value::<ObsVideoApplyRequest>(serde_json::json!({
                "confirm": true,
                "expected_fingerprint": "a".repeat(64),
                "target": { "output_width": 1 }
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<ObsVideoRestoreRequest>(serde_json::json!({
                "confirm": true,
                "path": "../outside.json"
            }))
            .is_err()
        );
        assert!(require_confirmation(false).is_err());
        assert!(validate_fingerprint(&"a".repeat(64)).is_ok());
        assert!(validate_fingerprint(&"A".repeat(64)).is_err());
    }

    #[tokio::test]
    async fn mutating_routes_reject_payloads_larger_than_one_kibibyte() {
        let directory = tempfile::tempdir().expect("directory");
        let state = AppState::new(
            vibe_cs_storage::Storage::open_in_memory()
                .await
                .expect("storage"),
            directory.path().to_path_buf(),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            axum::serve(listener, router().with_state(state))
                .await
                .expect("server");
        });
        let response = reqwest::Client::new()
            .post(format!("http://{address}/api/obs/video-tuning/apply"))
            .json(&serde_json::json!({
                "confirm": true,
                "expected_fingerprint": "a".repeat(64),
                "padding": "x".repeat(MAXIMUM_OBS_TUNING_PAYLOAD_BYTES)
            }))
            .send()
            .await
            .expect("response");
        server.abort();

        assert_eq!(response.status(), reqwest::StatusCode::PAYLOAD_TOO_LARGE);
    }
}
