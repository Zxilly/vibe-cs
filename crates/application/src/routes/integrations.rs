use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path as AxumPath, State},
    http::StatusCode,
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{ApiError, ApiJson, ApiQuery, ApiResult, AppState};

const MAXIMUM_GSI_PAYLOAD_BYTES: usize = 512 * 1024;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/match-history/matches", get(match_history))
        .route("/api/match-history/sync", post(match_history_sync))
        .route("/api/match-history/download", post(match_history_download))
        .route(
            "/api/match-history/downloads/active",
            get(match_history_active_downloads),
        )
        .route(
            "/api/match-history/download/{job_id}",
            get(match_history_download_status).delete(match_history_download_cancel),
        )
        .route(
            "/api/match-history/credentials",
            axum::routing::delete(match_history_disconnect),
        )
        .route("/api/match-history/test", post(match_history_test))
        .route("/api/llm/status", get(llm_status))
        .route("/api/llm/test", post(llm_test))
        .route(
            "/api/gsi/cs2",
            post(gsi_ingest).layer(DefaultBodyLimit::max(MAXIMUM_GSI_PAYLOAD_BYTES)),
        )
        .route("/api/gsi/status", get(gsi_status))
        .route("/api/playback/status", get(playback_status))
        .route("/api/gsi/install", post(gsi_install))
        .route("/api/gsi/remove", post(gsi_remove))
        .route("/api/config-backup/status", get(recovery_status))
        .route("/api/config-backup/restore", post(recovery_restore))
}

pub(crate) fn gsi_router() -> Router<AppState> {
    Router::new().route(
        "/api/gsi/cs2",
        post(gsi_ingest).layer(DefaultBodyLimit::max(MAXIMUM_GSI_PAYLOAD_BYTES)),
    )
}

#[derive(Debug, Deserialize)]
struct MatchHistoryQuery {
    #[serde(default)]
    steam_id: Option<String>,
    #[serde(default)]
    search: Option<String>,
    #[serde(default = "default_page")]
    page: u32,
    #[serde(default = "default_page_size")]
    page_size: u32,
}

const fn default_page() -> u32 {
    1
}
const fn default_page_size() -> u32 {
    50
}

async fn match_history(
    State(state): State<AppState>,
    ApiQuery(query): ApiQuery<MatchHistoryQuery>,
) -> ApiResult<Json<Value>> {
    let request = json!({
        "steam_id": query.steam_id,
        "search": query.search,
        "page": query.page.max(1),
        "page_size": query.page_size.clamp(1, 200),
    });
    Ok(Json(
        state.integrations.request("match_history", request).await?,
    ))
}

async fn match_history_sync(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(
        state
            .integrations
            .request("match_history_sync", Value::Null)
            .await?,
    ))
}

async fn match_history_test(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<Value>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        state
            .integrations
            .request("match_history_test", request)
            .await?,
    ))
}

async fn match_history_download(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<Value>,
) -> ApiResult<Json<Value>> {
    let match_id = request
        .get("match_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ApiError::invalid("match_id is required"))?;
    Ok(Json(
        state
            .integrations
            .request("match_history_download", json!({ "match_id": match_id }))
            .await?,
    ))
}

async fn match_history_download_status(
    State(state): State<AppState>,
    AxumPath(job_id): AxumPath<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        state
            .integrations
            .request("match_history_download_status", json!({ "job_id": job_id }))
            .await?,
    ))
}

async fn match_history_active_downloads(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(
        state
            .integrations
            .request("match_history_downloads_active", Value::Null)
            .await?,
    ))
}

async fn match_history_download_cancel(
    State(state): State<AppState>,
    AxumPath(job_id): AxumPath<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        state
            .integrations
            .request("match_history_download_cancel", json!({ "job_id": job_id }))
            .await?,
    ))
}

async fn match_history_disconnect(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(
        state
            .integrations
            .request("match_history_disconnect", Value::Null)
            .await?,
    ))
}

async fn llm_status(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    ensure_llm_configured(&state).await?;
    Ok(Json(
        state
            .integrations
            .request("llm_status", Value::Null)
            .await?,
    ))
}

async fn llm_test(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<Value>,
) -> ApiResult<Json<Value>> {
    Ok(Json(state.integrations.request("llm_test", request).await?))
}

async fn gsi_status(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(
        state
            .integrations
            .request("gsi_status", Value::Null)
            .await?,
    ))
}

async fn playback_status(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(
        state
            .integrations
            .request("demo_playback_status", Value::Null)
            .await?,
    ))
}

async fn gsi_ingest(
    State(state): State<AppState>,
    ApiJson(mut request): ApiJson<Value>,
) -> ApiResult<Json<Value>> {
    let timestamp = authenticate_gsi_payload(&state, &mut request)?;
    let mut last_timestamp = state.gsi_last_timestamp.try_lock().map_err(|_| {
        ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "gsi_busy",
            "A previous GSI update is still being processed",
        )
    })?;
    if timestamp.is_some_and(|timestamp| {
        last_timestamp.is_some_and(|last_timestamp| timestamp < last_timestamp)
    }) {
        return Ok(Json(json!({ "accepted": false, "stale": true })));
    }
    let response = state.integrations.request("gsi_ingest", request).await?;
    if let Some(timestamp) = timestamp {
        *last_timestamp = Some(last_timestamp.map_or(timestamp, |current| current.max(timestamp)));
    }
    Ok(Json(response))
}

async fn gsi_install(
    State(state): State<AppState>,
    ApiJson(mut request): ApiJson<Value>,
) -> ApiResult<Json<Value>> {
    let object = request
        .as_object_mut()
        .ok_or_else(|| ApiError::invalid("GSI installation request must be a JSON object"))?;
    object.insert(
        "token".to_owned(),
        Value::String(state.gsi_token().to_owned()),
    );
    Ok(Json(
        state.integrations.request("gsi_install", request).await?,
    ))
}

async fn gsi_remove(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<Value>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        state.integrations.request("gsi_remove", request).await?,
    ))
}

async fn recovery_status(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(
        state
            .integrations
            .request("config_backup_status", Value::Null)
            .await?,
    ))
}

async fn recovery_restore(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<Value>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        state
            .integrations
            .request("config_backup_restore", request)
            .await?,
    ))
}

async fn ensure_llm_configured(state: &AppState) -> ApiResult<()> {
    let config = state.storage.get_config().await?.unwrap_or_default();
    if config.llm.provider.trim().is_empty()
        || config.llm.model.trim().is_empty()
        || config.llm.api_key.trim().is_empty()
    {
        return Err(ApiError::dependency("LLM provider"));
    }
    Ok(())
}

fn authenticate_gsi_payload(state: &AppState, request: &mut Value) -> ApiResult<Option<i64>> {
    let object = request
        .as_object_mut()
        .ok_or_else(|| ApiError::invalid("GSI payload must be a JSON object"))?;
    let supplied_token = object
        .get("auth")
        .and_then(|auth| auth.get("token"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !constant_time_token_eq(supplied_token.as_bytes(), state.gsi_token().as_bytes()) {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_gsi_token",
            "GSI payload authentication failed",
        ));
    }
    object.remove("auth");
    let app_id = object
        .get("provider")
        .and_then(|provider| provider.get("appid"))
        .and_then(Value::as_u64);
    if app_id != Some(730) {
        return Err(ApiError::invalid(
            "GSI payload must identify the CS2 application",
        ));
    }
    Ok(object
        .get("provider")
        .and_then(|provider| provider.get("timestamp"))
        .and_then(Value::as_i64))
}

fn constant_time_token_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use async_trait::async_trait;
    use axum::response::IntoResponse;
    use tokio::sync::Mutex;
    use vibe_cs_domain::DomainError;

    use super::*;
    use crate::IntegrationPort;

    #[derive(Debug, Default)]
    struct CapturingIntegrations {
        calls: AtomicUsize,
        requests: Mutex<Vec<(String, Value)>>,
    }

    #[async_trait]
    impl IntegrationPort for CapturingIntegrations {
        async fn request(&self, capability: &str, request: Value) -> Result<Value, DomainError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            self.requests
                .lock()
                .await
                .push((capability.to_owned(), request));
            if capability == "llm_test" {
                return Ok(json!({
                    "ok": true,
                    "capabilities": {
                        "protocol": "openai_chat_completions",
                        "chat": true,
                        "stream": true,
                        "tools": true
                    }
                }));
            }
            Ok(json!({ "accepted": true }))
        }
    }

    async fn test_state(integrations: Arc<CapturingIntegrations>) -> (tempfile::TempDir, AppState) {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state =
            AppState::new(storage, directory.path().to_path_buf()).with_integrations(integrations);
        (directory, state)
    }

    #[tokio::test]
    async fn playback_status_is_a_read_only_integration_capability() {
        let integrations = Arc::new(CapturingIntegrations::default());
        let (_directory, state) = test_state(Arc::clone(&integrations)).await;

        let response = playback_status(State(state)).await.expect("status");

        assert_eq!(response.0["accepted"], true);
        let requests = integrations.requests.lock().await;
        assert_eq!(
            requests.as_slice(),
            &[("demo_playback_status".to_owned(), Value::Null)]
        );
    }

    #[tokio::test]
    async fn recovery_status_does_not_require_a_persisted_game_path() {
        let integrations = Arc::new(CapturingIntegrations::default());
        let (_directory, state) = test_state(Arc::clone(&integrations)).await;

        let response = recovery_status(State(state))
            .await
            .expect("recovery status");

        assert_eq!(response.0["accepted"], true);
        let requests = integrations.requests.lock().await;
        assert_eq!(
            requests.as_slice(),
            &[("config_backup_status".to_owned(), Value::Null)]
        );
    }

    #[tokio::test]
    async fn gsi_ingest_authenticates_strips_secret_and_rejects_stale_payloads() {
        let integrations = Arc::new(CapturingIntegrations::default());
        let (_directory, state) = test_state(Arc::clone(&integrations)).await;

        let error = gsi_ingest(
            State(state.clone()),
            ApiJson(json!({
                "auth": { "token": "wrong" },
                "provider": { "appid": 730, "timestamp": 10 }
            })),
        )
        .await
        .expect_err("wrong token must fail");
        assert_eq!(error.into_response().status(), StatusCode::UNAUTHORIZED);
        assert_eq!(integrations.calls.load(Ordering::Relaxed), 0);

        let token = state.gsi_token().to_owned();
        let accepted = gsi_ingest(
            State(state.clone()),
            ApiJson(json!({
                "auth": { "token": token },
                "provider": { "appid": 730, "timestamp": 10 },
                "map": { "name": "de_mirage" }
            })),
        )
        .await
        .expect("valid payload");
        assert_eq!(accepted.0["accepted"], true);
        let requests = integrations.requests.lock().await;
        assert_eq!(requests.len(), 1);
        assert!(requests[0].1.get("auth").is_none());
        drop(requests);

        let stale_response = gsi_ingest(
            State(state.clone()),
            ApiJson(json!({
                "auth": { "token": state.gsi_token() },
                "provider": { "appid": 730, "timestamp": 9 }
            })),
        )
        .await
        .expect("stale payload response");
        assert_eq!(stale_response.0["accepted"], false);
        assert_eq!(stale_response.0["stale"], true);
        assert_eq!(integrations.calls.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn gsi_install_overrides_client_token_with_server_secret() {
        let integrations = Arc::new(CapturingIntegrations::default());
        let (_directory, state) = test_state(Arc::clone(&integrations)).await;
        state
            .storage
            .put_config(vibe_cs_domain::AppConfig {
                cs2_path: "configured".to_owned(),
                ..vibe_cs_domain::AppConfig::default()
            })
            .await
            .expect("config");
        let _response = gsi_install(
            State(state.clone()),
            ApiJson(json!({
                "uri": "http://127.0.0.1:47831/api/gsi/cs2",
                "token": "client-controlled"
            })),
        )
        .await
        .expect("install request");
        let requests = integrations.requests.lock().await;
        assert_eq!(requests[0].0, "gsi_install");
        assert_eq!(requests[0].1["token"], state.gsi_token());
        assert_ne!(requests[0].1["token"], "client-controlled");
    }

    #[tokio::test]
    async fn llm_connection_test_forwards_unsaved_form_configuration() {
        let integrations = Arc::new(CapturingIntegrations::default());
        let (_directory, state) = test_state(Arc::clone(&integrations)).await;
        let llm_request = json!({
            "provider": "openai-compatible",
            "model": "test-model",
            "base_url": "https://example.test/v1",
            "api_key": "temporary",
            "prompt": ""
        });

        let llm_response = llm_test(State(state), ApiJson(llm_request.clone()))
            .await
            .expect("LLM test request");
        assert_eq!(llm_response.0["capabilities"]["chat"], true);
        assert_eq!(llm_response.0["capabilities"]["stream"], true);
        assert_eq!(llm_response.0["capabilities"]["tools"], true);

        let requests = integrations.requests.lock().await;
        assert_eq!(requests[0], ("llm_test".to_owned(), llm_request));
    }

    #[tokio::test]
    async fn match_history_routes_forward_paging_sync_and_job_controls() {
        let integrations = Arc::new(CapturingIntegrations::default());
        let (_directory, state) = test_state(Arc::clone(&integrations)).await;
        let steam_request = json!({
            "steam_id": "76561198000000000",
            "web_api_key": "ephemeral-key",
            "authentication_code": "ABCD-EFGHI-JKLM",
            "known_share_code": "CSGO-ABCDE-ABCDE-ABCDE-ABCDE-ABCDE",
            "maximum_results": 20
        });

        let _ = match_history(
            State(state.clone()),
            ApiQuery(MatchHistoryQuery {
                steam_id: None,
                search: Some("nuke".to_owned()),
                page: 2,
                page_size: 25,
            }),
        )
        .await
        .expect("list history");
        let _ = match_history_sync(State(state.clone()))
            .await
            .expect("sync history");
        let _ = match_history_test(State(state.clone()), ApiJson(steam_request.clone()))
            .await
            .expect("test history");
        let _ = match_history_download(
            State(state.clone()),
            ApiJson(json!({ "match_id": "account:match" })),
        )
        .await
        .expect("start download");
        let _ = match_history_active_downloads(State(state.clone()))
            .await
            .expect("list active downloads");
        let job_id = uuid::Uuid::new_v4().to_string();
        let _ = match_history_download_status(State(state.clone()), AxumPath(job_id.clone()))
            .await
            .expect("download status");
        let _ = match_history_download_cancel(State(state), AxumPath(job_id.clone()))
            .await
            .expect("cancel download");

        let requests = integrations.requests.lock().await;
        assert_eq!(requests[0].0, "match_history");
        assert_eq!(requests[0].1["page"], 2);
        assert_eq!(requests[0].1["page_size"], 25);
        assert_eq!(requests[0].1["search"], "nuke");
        assert_eq!(requests[1].0, "match_history_sync");
        assert_eq!(
            requests[2],
            ("match_history_test".to_owned(), steam_request)
        );
        assert_eq!(requests[3].1["match_id"], "account:match");
        assert_eq!(requests[4].0, "match_history_downloads_active");
        assert_eq!(requests[5].1["job_id"], job_id);
        assert_eq!(requests[6].0, "match_history_download_cancel");
    }
}
