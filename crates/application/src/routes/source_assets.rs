use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Serialize;
use ts_rs::TS;

use crate::{ApiError, ApiResult, AppState, MapGeometryStatus, RadarOverviewData};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/maps/{map_name}/radar", get(radar_image))
        .route("/api/maps/{map_name}/radar/metadata", get(radar_metadata))
        .route("/api/source-assets/map-geometry", get(map_geometry_status))
        .route(
            "/api/source-assets/map-geometry/{map_name}",
            get(map_geometry),
        )
        .route(
            "/api/source-assets/map-geometry/{map_name}/rebuild",
            post(rebuild_map_geometry),
        )
}

async fn map_geometry_status(
    State(state): State<AppState>,
) -> ApiResult<Json<Vec<MapGeometryStatus>>> {
    Ok(Json(state.source_assets.map_geometry_status().await?))
}

async fn rebuild_map_geometry(
    State(state): State<AppState>,
    Path(map_name): Path<String>,
) -> ApiResult<Json<MapGeometryStatus>> {
    Ok(Json(
        state
            .source_assets
            .map_geometry(map_name, true)
            .await?
            .status,
    ))
}

async fn map_geometry(
    State(state): State<AppState>,
    Path(map_name): Path<String>,
) -> ApiResult<Response> {
    let geometry = state.source_assets.map_geometry(map_name, false).await?;
    let mut response = Body::from(geometry.bytes).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.vibe-cs.map-geometry"),
    );
    // The source package fingerprint is checked on every request. A browser's
    // day-long cache must not hide a CS2 map update or an explicit rebuild.
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

/// The radar overview transform published by `/api/maps/{map}/radar/metadata`.
#[derive(Debug, Serialize, TS)]
#[ts(export)]
struct RadarTransformResponse {
    pos_x: f64,
    pos_y: f64,
    scale: f64,
    rotate: bool,
    zoom: Option<f64>,
}

/// Radar overview metadata. `image_url` points at this service's own radar
/// route, never at a third-party image host.
#[derive(Debug, Serialize, TS)]
#[ts(export)]
struct RadarMetadataResponse {
    map_name: String,
    transform: Option<RadarTransformResponse>,
    image_url: Option<String>,
    image_mime: Option<String>,
    browser_displayable: bool,
}

async fn load_overview(state: &AppState, map_name: String) -> ApiResult<RadarOverviewData> {
    state
        .source_assets
        .radar_overview(map_name)
        .await
        .map_err(Into::into)
}

async fn radar_metadata(
    State(state): State<AppState>,
    Path(map_name): Path<String>,
) -> ApiResult<Json<RadarMetadataResponse>> {
    let overview = load_overview(&state, map_name).await?;
    let image_url = overview
        .image
        .as_ref()
        .map(|_| format!("/api/maps/{}/radar", overview.map_name));
    let image_mime = overview
        .image
        .as_ref()
        .map(|image| image.content_type.clone());
    let browser_displayable = overview
        .image
        .as_ref()
        .is_some_and(|image| image.browser_displayable);
    Ok(Json(RadarMetadataResponse {
        map_name: overview.map_name,
        transform: overview.transform.map(|transform| RadarTransformResponse {
            pos_x: transform.position_x,
            pos_y: transform.position_y,
            scale: transform.scale,
            rotate: transform.rotate,
            zoom: transform.zoom,
        }),
        image_url,
        image_mime,
        browser_displayable,
    }))
}

async fn radar_image(
    State(state): State<AppState>,
    Path(map_name): Path<String>,
) -> ApiResult<Response> {
    let overview = load_overview(&state, map_name).await?;
    let image = overview
        .image
        .ok_or_else(|| ApiError::not_found("radar image"))?;
    let content_type = HeaderValue::from_str(&image.content_type).map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid_asset_content_type",
            "Radar asset adapter returned an invalid content type",
        )
    })?;
    let mut response = Body::from(image.bytes).into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, content_type);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=86400"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use async_trait::async_trait;
    use axum::body::to_bytes;
    use vibe_cs_domain::DomainError;

    use super::*;
    use crate::{
        MapGeometryCacheState, MapGeometryData, RadarImageData, RadarTransformData, SourceAssetPort,
    };

    #[derive(Debug)]
    struct FixtureAssets;

    #[async_trait]
    impl SourceAssetPort for FixtureAssets {
        async fn map_geometry(
            &self,
            map_name: String,
            rebuild: bool,
        ) -> Result<MapGeometryData, DomainError> {
            Ok(MapGeometryData {
                bytes: b"VMAPfixture".to_vec(),
                status: MapGeometryStatus {
                    map_name,
                    state: MapGeometryCacheState::Ready,
                    bytes: Some(11),
                    reason: rebuild.then(|| "rebuilt".to_owned()),
                },
            })
        }

        async fn map_geometry_status(&self) -> Result<Vec<MapGeometryStatus>, DomainError> {
            Ok(vec![MapGeometryStatus {
                map_name: "de_safe".to_owned(),
                state: MapGeometryCacheState::Missing,
                bytes: None,
                reason: None,
            }])
        }

        async fn radar_overview(&self, map_name: String) -> Result<RadarOverviewData, DomainError> {
            Ok(RadarOverviewData {
                map_name: map_name.to_ascii_lowercase(),
                transform: Some(RadarTransformData {
                    position_x: -2_048.0,
                    position_y: 3_072.0,
                    scale: 4.0,
                    rotate: false,
                    zoom: None,
                }),
                image: Some(RadarImageData {
                    bytes: b"\x89PNGfixture".to_vec(),
                    content_type: "image/png".to_owned(),
                    browser_displayable: true,
                }),
            })
        }
    }

    async fn test_state() -> (tempfile::TempDir, AppState) {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage, directory.path().to_path_buf())
            .with_source_assets(Arc::new(FixtureAssets));
        (directory, state)
    }

    #[tokio::test]
    async fn metadata_exposes_only_the_local_asset_route_and_transform() {
        let (_directory, state) = test_state().await;
        let Json(metadata) = radar_metadata(State(state), Path("DE_SAFE".to_owned()))
            .await
            .expect("metadata");

        assert_eq!(metadata.map_name, "de_safe");
        assert_eq!(
            metadata.image_url.as_deref(),
            Some("/api/maps/de_safe/radar")
        );
        assert_eq!(metadata.image_mime.as_deref(), Some("image/png"));
        assert!(metadata.browser_displayable);
        assert!((metadata.transform.expect("transform").scale - 4.0).abs() < f64::EPSILON);
    }

    #[tokio::test]
    async fn image_response_preserves_verified_mime_and_hardening_headers() {
        let (_directory, state) = test_state().await;
        let response = radar_image(State(state), Path("de_safe".to_owned()))
            .await
            .expect("image");

        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
        assert_eq!(
            to_bytes(response.into_body(), 64).await.expect("body"),
            &b"\x89PNGfixture"[..]
        );
    }

    #[tokio::test]
    async fn geometry_routes_dispatch_binary_status_and_explicit_rebuild() {
        use axum::http::Request;
        use tower::ServiceExt;
        let (_directory, state) = test_state().await;
        let app = router().with_state(state);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/source-assets/map-geometry/de_safe")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/vnd.vibe-cs.map-geometry"
        );
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            to_bytes(response.into_body(), 64).await.unwrap(),
            &b"VMAPfixture"[..]
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/source-assets/map-geometry")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status: Vec<MapGeometryStatus> =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(status[0].state, MapGeometryCacheState::Missing);
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/source-assets/map-geometry/de_safe/rebuild")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status: MapGeometryStatus =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(status.state, MapGeometryCacheState::Ready);
        assert_eq!(status.reason.as_deref(), Some("rebuilt"));
    }
}
