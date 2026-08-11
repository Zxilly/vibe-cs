//! Loopback HTTP API for desktop and standalone hosts.

mod error;
mod extract;
mod player;
mod ports;
mod routes;
mod state;

pub(crate) use extract::{ApiJson, ApiMultipart, ApiQuery};

use std::{future::Future, sync::Arc};

use axum::{
    Router,
    body::Body,
    http::{HeaderValue, Method, Request, StatusCode, header},
    middleware,
    middleware::Next,
    response::{IntoResponse, Response},
};
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    services::ServeDir,
    trace::TraceLayer,
};

pub use error::{ApiError, ApiResult};
pub use player::*;
pub use ports::{
    AnalysisPort, CosmeticCatalogDto, CosmeticCatalogItemDto, CosmeticImageOutput,
    CosmeticPaintKitDto, CosmeticRewriteOutput, CosmeticsPort, DemoWatchPort, DemoWatchRootStatus,
    DemoWatchStatus, DisabledAnalysisPort, DisabledCosmeticsPort, DisabledDemoWatchPort,
    DisabledExportPort, DisabledIntegrationPort, DisabledMediaPort, DisabledObsTuningPort,
    DisabledRecordingPort, DisabledReviewPort, DisabledSourceAssetPort, ExportPort,
    IntegrationPort, LlmReviewRequest, LlmReviewResult, MediaPort, MediaProxyRequest,
    ObsTuningPort, ObsVideoApplyRequest, ObsVideoApplyResult, ObsVideoBackup,
    ObsVideoBackupDeleteResult, ObsVideoBackupReason, ObsVideoField, ObsVideoFieldDiff,
    ObsVideoRestoreRequest, ObsVideoRestoreResult, ObsVideoSettingsSnapshot, ObsVideoTuningPlan,
    ProbedMediaMetadata, RadarImageData, RadarOverviewData, RadarTransformData, RecordingPort,
    ReplayCacheCleanup, ReplayCacheMetadata, ReplayCacheState, ReplayCacheStatus, ReplayPayload,
    ReviewPort, ReviewScope, ReviewTone, SourceAssetPort,
};
pub use state::{AppState, ChangedEvent, EventHub, ServerConfig};

pub fn build_router(state: AppState) -> Router {
    let web_dist = state.web_dist().map(Arc::unwrap_or_clone);
    let mut router = routes::router();
    if let Some(directory) = web_dist {
        router = router.fallback_service(
            ServeDir::new(directory)
                .append_index_html_on_directories(true)
                .fallback(ServeDir::new(state.data_dir().join("__missing_static__"))),
        );
    } else {
        router = router.fallback(routes::not_found);
    }

    let request_id_header = header::HeaderName::from_static("x-request-id");
    router
        .with_state(state)
        .layer(PropagateRequestIdLayer::new(request_id_header.clone()))
        .layer(SetRequestIdLayer::new(request_id_header, MakeRequestUuid))
        .layer(TraceLayer::new_for_http())
        .layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::predicate(is_allowed_origin))
                .allow_methods([
                    Method::GET,
                    Method::HEAD,
                    Method::POST,
                    Method::PUT,
                    Method::PATCH,
                    Method::DELETE,
                    Method::OPTIONS,
                ])
                .allow_headers([
                    header::ACCEPT,
                    header::CONTENT_TYPE,
                    header::RANGE,
                    header::HeaderName::from_static("x-vibe-cs-locale"),
                ])
                .expose_headers([
                    header::CONTENT_LENGTH,
                    header::CONTENT_RANGE,
                    header::ACCEPT_RANGES,
                    header::HeaderName::from_static("x-request-id"),
                ]),
        )
        .layer(middleware::from_fn(enforce_local_request))
}

/// Starts a standalone server backed by the configured data directory.
///
/// # Errors
///
/// Returns an error when the data directory, database, listener, or HTTP server cannot start.
pub async fn serve(
    config: ServerConfig,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> Result<(), error::ServeError> {
    tokio::fs::create_dir_all(&config.data_dir).await?;
    let storage = vibe_cs_storage::Storage::open(config.data_dir.join("vibe-cs.db")).await?;
    if storage.get_config().await?.is_none() {
        let default = vibe_cs_domain::AppConfig {
            data_dir: config.data_dir.to_string_lossy().into_owned(),
            ..vibe_cs_domain::AppConfig::default()
        };
        storage.put_config(default).await?;
    }
    let state = AppState::new(storage, config.data_dir.clone()).with_web_dist(config.web_dist);
    serve_state(config.bind_addr, state, shutdown).await
}

/// Starts a server with an already composed application state.
///
/// # Errors
///
/// Returns an error when the listener cannot bind or the HTTP server terminates unexpectedly.
pub async fn serve_state(
    bind_addr: std::net::SocketAddr,
    state: AppState,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> Result<(), error::ServeError> {
    if !bind_addr.ip().is_loopback() {
        return Err(error::ServeError::NonLoopback(bind_addr));
    }
    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    tracing::info!(address = %listener.local_addr()?, "local API listening");
    axum::serve(listener, build_router(state))
        .with_graceful_shutdown(shutdown)
        .await?;
    Ok(())
}

async fn enforce_local_request(request: Request<Body>, next: Next) -> Response {
    let host_is_allowed = request
        .headers()
        .get(header::HOST)
        .is_some_and(is_allowed_host);
    if !host_is_allowed {
        return ApiError::new(
            StatusCode::MISDIRECTED_REQUEST,
            "invalid_host",
            "The local API only accepts loopback hosts",
        )
        .into_response();
    }
    if request
        .headers()
        .get(header::ORIGIN)
        .is_some_and(|origin| !is_allowed_origin_value(origin))
    {
        return ApiError::new(
            StatusCode::FORBIDDEN,
            "origin_forbidden",
            "The request origin is not allowed",
        )
        .into_response();
    }
    next.run(request).await
}

fn is_allowed_host(host: &HeaderValue) -> bool {
    let Ok(host) = host.to_str() else {
        return false;
    };
    let Ok(authority) = host.parse::<http::uri::Authority>() else {
        return false;
    };
    let host = authority
        .host()
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or_else(|| authority.host());
    host.eq_ignore_ascii_case("localhost")
        || host.eq_ignore_ascii_case("tauri.localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn is_allowed_origin(origin: &HeaderValue, _request: &axum::http::request::Parts) -> bool {
    is_allowed_origin_value(origin)
}

fn is_allowed_origin_value(origin: &HeaderValue) -> bool {
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let Ok(origin) = url::Url::parse(origin) else {
        return false;
    };
    if !origin.username().is_empty()
        || origin.password().is_some()
        || origin.query().is_some()
        || origin.fragment().is_some()
        || !matches!(origin.path(), "" | "/")
    {
        return false;
    }
    match (origin.scheme(), origin.host()) {
        ("tauri", Some(url::Host::Domain("localhost")))
        | ("http" | "https", Some(url::Host::Domain("tauri.localhost"))) => origin.port().is_none(),
        ("http" | "https", Some(url::Host::Domain("localhost"))) => true,
        ("http" | "https", Some(url::Host::Ipv4(address))) => address.is_loopback(),
        ("http" | "https", Some(url::Host::Ipv6(address))) => address.is_loopback(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn health_endpoint_is_runnable() {
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("open storage");
        let directory = tempfile::tempdir().expect("temporary data directory");
        let app = build_router(AppState::new(storage, directory.path().to_path_buf()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("local address");
        let task = tokio::spawn(async move { axum::serve(listener, app).await });

        let response = reqwest::get(format!("http://{address}/api/health"))
            .await
            .expect("request health");
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        task.abort();
    }

    #[tokio::test]
    async fn forbidden_origin_cannot_execute_a_simple_multipart_upload() {
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("open storage");
        let directory = tempfile::tempdir().expect("temporary data directory");
        let app = build_router(AppState::new(storage, directory.path().to_path_buf()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("local address");
        let task = tokio::spawn(async move { axum::serve(listener, app).await });

        let form = reqwest::multipart::Form::new().part(
            "files",
            reqwest::multipart::Part::bytes(b"demo".to_vec()).file_name("match.dem"),
        );
        let response = reqwest::Client::new()
            .post(format!("http://{address}/api/demo/upload-multiple"))
            .header(reqwest::header::ORIGIN, "https://evil.test")
            .multipart(form)
            .send()
            .await
            .expect("send upload");
        assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
        assert!(!directory.path().join("uploads/demos").exists());
        task.abort();
    }

    #[tokio::test]
    async fn dns_rebinding_host_is_rejected() {
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("open storage");
        let directory = tempfile::tempdir().expect("temporary data directory");
        let app = build_router(AppState::new(storage, directory.path().to_path_buf()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("local address");
        let task = tokio::spawn(async move { axum::serve(listener, app).await });

        let response = reqwest::Client::new()
            .get(format!("http://{address}/api/health"))
            .header(reqwest::header::HOST, "evil.test:47831")
            .send()
            .await
            .expect("send request");
        assert_eq!(response.status(), reqwest::StatusCode::MISDIRECTED_REQUEST);
        task.abort();
    }

    #[tokio::test]
    async fn serve_state_refuses_non_loopback_bindings() {
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("open storage");
        let directory = tempfile::tempdir().expect("temporary data directory");
        let state = AppState::new(storage, directory.path().to_path_buf());

        let error = serve_state(
            std::net::SocketAddr::from(([0, 0, 0, 0], 47_831)),
            state,
            async {},
        )
        .await
        .expect_err("non-loopback bind must fail");

        assert!(matches!(error, error::ServeError::NonLoopback(_)));
    }

    #[test]
    fn cors_accepts_tauri_origins_but_not_arbitrary_websites() {
        let request = axum::http::Request::new(());
        let (parts, ()) = request.into_parts();
        assert!(is_allowed_origin(
            &HeaderValue::from_static("tauri://localhost"),
            &parts,
        ));
        assert!(is_allowed_origin(
            &HeaderValue::from_static("http://tauri.localhost"),
            &parts,
        ));
        assert!(is_allowed_origin(
            &HeaderValue::from_static("http://127.0.0.1:5173"),
            &parts,
        ));
        assert!(!is_allowed_origin(
            &HeaderValue::from_static("https://example.test"),
            &parts,
        ));
        for origin in [
            "http://localhost.evil.test:5173",
            "http://127.0.0.1.evil.test:5173",
            "http://localhost:5173/path",
            "http://user@localhost:5173",
            "tauri://localhost.evil.test",
        ] {
            assert!(
                !is_allowed_origin(&HeaderValue::from_str(origin).expect("origin"), &parts),
                "unexpectedly allowed {origin}"
            );
        }
    }

    #[test]
    fn host_validation_accepts_only_loopback_authorities() {
        for host in [
            "127.0.0.1:47831",
            "[::1]:47831",
            "localhost:47831",
            "tauri.localhost",
        ] {
            assert!(is_allowed_host(&HeaderValue::from_str(host).expect("host")));
        }
        for host in ["evil.test:47831", "127.0.0.1.evil.test", "0.0.0.0:47831"] {
            assert!(!is_allowed_host(
                &HeaderValue::from_str(host).expect("host")
            ));
        }
    }
}
