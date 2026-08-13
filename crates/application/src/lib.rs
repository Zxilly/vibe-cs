//! In-process application command dispatcher used by the Tauri desktop host.

mod error;
mod extract;
mod player;
mod ports;
mod routes;
mod state;

pub(crate) use extract::{ApiJson, ApiMultipart, ApiQuery};

use axum::Router;

pub use error::{ApiError, ApiResult};
pub use player::*;
pub use ports::{
    AnalysisPort, CosmeticCatalogDto, CosmeticCatalogItemDto, CosmeticImageOutput,
    CosmeticPaintKitDto, CosmeticRewriteOutput, CosmeticsPort, DemoWatchPort, DemoWatchRootStatus,
    DemoWatchStatus, DisabledAnalysisPort, DisabledCosmeticsPort, DisabledDemoWatchPort,
    DisabledExportPort, DisabledIntegrationPort, DisabledMediaPort, DisabledProposalExecutionPort,
    DisabledRecordingPort, DisabledReviewPort, DisabledSourceAssetPort, ExportPort,
    IntegrationPort, LlmReviewRequest, LlmReviewResult, MediaPort, MediaProxyRequest,
    ProbedMediaMetadata, ProposalExecutionPort, RadarImageData, RadarOverviewData,
    RadarTransformData, RecordingPort, ReplayCacheCleanup, ReplayCacheMetadata, ReplayCacheState,
    ReplayCacheStatus, ReplayPayload, ReviewPort, ReviewScope, ReviewTone, SourceAssetPort,
};
pub use state::{AppState, ChangedEvent, EventHub};
pub use vibe_cs_domain::{
    CreateEvidenceAnnotation, EvidenceAnnotation, EvidenceAnnotationQuery,
    EvidenceAnnotationReviewState, EvidenceEventFamily, EvidenceSearchAvailability,
    EvidenceSearchCapability, EvidenceSearchItem, EvidenceSearchPage, EvidenceSearchQuery,
    EvidenceSourceKind, ReplayFidelityMetadata, ReplayFidelityMode, UpdateEvidenceAnnotation,
};

/// Builds the private command dispatcher hosted inside the desktop process.
pub fn build_dispatcher(state: AppState) -> Router {
    routes::router()
        .fallback(routes::not_found)
        .with_state(state)
}

/// Builds the loopback-only receiver required by the CS2 GSI protocol.
///
/// This router intentionally exposes only the authenticated GSI ingestion route. Product and UI
/// commands remain available exclusively through Tauri IPC.
pub fn build_gsi_receiver(state: AppState) -> Router {
    routes::gsi_router()
        .fallback(routes::not_found)
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{Body, to_bytes},
        http::{Method, Request},
    };
    use chrono::Utc;
    use tower::ServiceExt as _;
    use uuid::Uuid;
    use vibe_cs_domain::{
        DemoRecord, DemoStatus, ExportJob, JobStatus, MatchAnalysis, MatchDemoStatus,
        MatchDownloadJob, MatchDownloadStatus, MatchHistoryResult, RecordingJob, SteamMatchRecord,
    };
    use vibe_cs_storage::ExportJobRecord;

    use super::*;

    async fn configure_steam_downloads(storage: &vibe_cs_storage::Storage, steam_id: &str) {
        let mut config = vibe_cs_domain::AppConfig::default();
        config.steam.steam_id = steam_id.to_owned();
        config.steam.web_api_key = "a".repeat(32);
        storage.put_config(config).await.expect("Steam config");
    }

    #[tokio::test]
    async fn dispatcher_does_not_expose_retired_obs_control_routes() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        for path in [
            "/api/obs/status",
            "/api/obs/test",
            "/api/obs/start",
            "/api/obs/diagnose",
            "/api/obs/video-tuning/plan",
            "/api/obs/video-tuning/apply",
            "/api/obs/video-tuning/backups",
            "/api/media-runtime",
            "/api/recording/queue",
            "/api/recording/execute",
        ] {
            let response = dispatcher
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .body(Body::empty())
                        .expect("request"),
                )
                .await
                .expect("response");
            assert_eq!(
                response.status(),
                axum::http::StatusCode::NOT_FOUND,
                "retired control route remained reachable: {path}"
            );
        }
    }

    #[tokio::test]
    async fn dispatcher_does_not_expose_retired_unscoped_export_routes() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        for path in ["/api/montage/export", "/api/editor/export/start"] {
            let response = dispatcher
                .clone()
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri(path)
                        .header(axum::http::header::CONTENT_TYPE, "application/json")
                        .body(Body::from("{}"))
                        .expect("request"),
                )
                .await
                .expect("response");
            assert_eq!(
                response.status(),
                axum::http::StatusCode::NOT_FOUND,
                "retired unscoped export route remained reachable: {path}"
            );
        }
    }

    #[tokio::test]
    async fn player_directory_rejects_missing_or_unknown_current_sort_contract() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        for path in [
            "/api/players?page=1&page_size=24",
            "/api/players?page=1&page_size=24&sort=rating&direction=desc",
            "/api/players?page=1&page_size=24&sort=kills&direction=sideways",
        ] {
            let response = dispatcher
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .body(Body::empty())
                        .expect("request"),
                )
                .await
                .expect("response");
            assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        }
    }

    #[tokio::test]
    async fn recorded_clip_collection_is_a_runtime_owned_read_model() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let list_response = dispatcher
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/api/recorded-clips")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(list_response.status(), axum::http::StatusCode::OK);

        let create_response = dispatcher
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/recorded-clips")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from("{}"))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(
            create_response.status(),
            axum::http::StatusCode::METHOD_NOT_ALLOWED
        );
    }

    #[tokio::test]
    async fn recorded_clip_patch_rejects_fields_outside_the_current_contract() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));
        let missing_id = Uuid::new_v4();

        let current_response = dispatcher
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::PATCH)
                    .uri(format!("/api/recorded-clips/{missing_id}"))
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"title":"renamed"}"#))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(current_response.status(), axum::http::StatusCode::NOT_FOUND);

        let unknown_response = dispatcher
            .oneshot(
                Request::builder()
                    .method(Method::PATCH)
                    .uri(format!("/api/recorded-clips/{missing_id}"))
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"title":"renamed","unexpected":true}"#))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(
            unknown_response.status(),
            axum::http::StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn evidence_annotation_routes_persist_only_canonical_evidence_locators() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let demo_id = Uuid::new_v4();
        let now = Utc::now();
        storage
            .put_demo(DemoRecord {
                id: demo_id,
                path: "C:/matches/annotated.dem".to_owned(),
                file_name: "annotated.dem".to_owned(),
                display_name: "Annotated match".to_owned(),
                source: "local".to_owned(),
                status: DemoStatus::Ready,
                map_name: Some("de_mirage".to_owned()),
                match_date: None,
                duration_seconds: Some(10.0),
                total_rounds: Some(1),
                team_a_name: None,
                team_b_name: None,
                team_a_score: None,
                team_b_score: None,
                player_names: vec![],
                remark: String::new(),
                content_sha256: None,
                file_size: 1,
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("persist demo");
        storage
            .put_analysis(MatchAnalysis {
                demo_id,
                map_name: "de_mirage".to_owned(),
                tick_rate: 64.0,
                duration_seconds: 10.0,
                verified_total_ticks: Some(640),
                teams: vec![],
                players: vec![],
                rounds: vec![vibe_cs_domain::RoundSummary {
                    number: 1,
                    start_tick: 1,
                    end_tick: 640,
                    winner: String::new(),
                    reason: String::new(),
                    team_a_score: 0,
                    team_b_score: 0,
                    events: vec![vibe_cs_domain::TimelineEvent {
                        id: "player_death-320-1".to_owned(),
                        tick: 320,
                        seconds: 5.0,
                        kind: vibe_cs_domain::EventKind::Kill,
                        actor: None,
                        target: None,
                        weapon: None,
                        headshot: false,
                        penetrated: false,
                        position: None,
                        detail: serde_json::json!({}),
                    }],
                }],
                highlights: vec![],
            })
            .await
            .expect("persist analysis");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));
        let evidence_id = format!("demo:{demo_id}/event:player_death-320-1");

        let create_response = dispatcher
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/evidence/annotations")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "demo_id": demo_id,
                            "evidence_id": evidence_id,
                            "round": 1,
                            "tick": 320,
                            "body": "Review the crossfire",
                            "tags": ["retake"]
                        })
                        .to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(create_response.status(), axum::http::StatusCode::CREATED);
        let body = to_bytes(create_response.into_body(), 64 * 1024)
            .await
            .expect("created annotation body");
        let created: EvidenceAnnotation =
            serde_json::from_slice(&body).expect("created annotation");

        let update_response = dispatcher
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::PATCH)
                    .uri(format!("/api/evidence/annotations/{}", created.id))
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "body": "  Review the saved utility timing  ",
                            "tags": [" Utility ", "Reviewed"],
                            "review_state": "resolved"
                        })
                        .to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(update_response.status(), axum::http::StatusCode::OK);
        let body = to_bytes(update_response.into_body(), 64 * 1024)
            .await
            .expect("updated annotation body");
        let updated: EvidenceAnnotation =
            serde_json::from_slice(&body).expect("updated annotation");
        assert_eq!(updated.body, "Review the saved utility timing");
        assert_eq!(updated.tags, ["Utility", "Reviewed"]);
        assert_eq!(
            updated.review_state,
            EvidenceAnnotationReviewState::Resolved
        );
        assert_eq!(updated.demo_id, created.demo_id);
        assert_eq!(updated.evidence_id, created.evidence_id);
        assert_eq!(updated.round, created.round);
        assert_eq!(updated.tick, created.tick);

        for invalid_update in [
            serde_json::json!({
                "body": "   ",
                "tags": [],
                "review_state": "resolved"
            }),
            serde_json::json!({
                "body": "Review the saved utility timing",
                "tags": ["utility", " UTILITY "],
                "review_state": "resolved"
            }),
            serde_json::json!({
                "body": "Move this annotation",
                "tags": [],
                "review_state": "open",
                "demo_id": Uuid::new_v4()
            }),
        ] {
            let response = dispatcher
                .clone()
                .oneshot(
                    Request::builder()
                        .method(Method::PATCH)
                        .uri(format!("/api/evidence/annotations/{}", created.id))
                        .header(axum::http::header::CONTENT_TYPE, "application/json")
                        .body(Body::from(invalid_update.to_string()))
                        .expect("request"),
                )
                .await
                .expect("response");
            assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        }

        let list_response = dispatcher
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/evidence/annotations?q=saved&tag=utility&state=resolved&demo_id={demo_id}&evidence_id={evidence_id}&page=1&page_size=1"
                    ))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(list_response.status(), axum::http::StatusCode::OK);
        let body = to_bytes(list_response.into_body(), 64 * 1024)
            .await
            .expect("body");
        let page: vibe_cs_domain::Page<EvidenceAnnotation> =
            serde_json::from_slice(&body).expect("annotation page");
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].evidence_id, evidence_id);
        assert_eq!(page.items[0].body, updated.body);
        assert_eq!(page.items[0].tags, updated.tags);
        assert_eq!(
            page.items[0].review_state,
            EvidenceAnnotationReviewState::Resolved
        );
    }

    #[tokio::test]
    async fn evidence_annotation_query_reports_invalid_filters_at_the_api_boundary() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/evidence/annotations?q=%20%20&page=1&page_size=10")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);

        let response = dispatcher
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/evidence/annotations?review_state=resolved")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/evidence/annotations")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "demo_id": Uuid::new_v4(),
                            "evidence_id": "demo:missing/event:missing",
                            "round": 1,
                            "tick": 1,
                            "body": "Invalid duplicate tags",
                            "tags": ["review", " REVIEW "]
                        })
                        .to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn dispatcher_exposes_only_the_current_collection_analysis_and_replay_routes() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));
        let missing_id = Uuid::new_v4();

        for (method, path, body) in [
            (Method::GET, "/api/demos/compact".to_owned(), ""),
            (
                Method::POST,
                format!("/api/demos/{missing_id}/analysis"),
                "{}",
            ),
            (Method::GET, "/api/match-history/matches".to_owned(), ""),
            (
                Method::PATCH,
                format!("/api/editor/projects/{missing_id}"),
                "{}",
            ),
            (
                Method::GET,
                format!("/api/demos/{missing_id}/replay.bin"),
                "",
            ),
        ] {
            let response = dispatcher
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(&path)
                        .header(axum::http::header::CONTENT_TYPE, "application/json")
                        .body(Body::from(body))
                        .expect("request"),
                )
                .await
                .expect("response");
            let status = response.status();
            let body = to_bytes(response.into_body(), 64 * 1024)
                .await
                .expect("response body");
            let code = serde_json::from_slice::<serde_json::Value>(&body)
                .ok()
                .and_then(|value| value["code"].as_str().map(ToOwned::to_owned));
            assert_ne!(
                status,
                axum::http::StatusCode::METHOD_NOT_ALLOWED,
                "current route rejected its method: {path}"
            );
            assert_ne!(
                code.as_deref(),
                Some("route_not_found"),
                "current route was not registered: {path}"
            );
        }

        for (method, path) in [
            (Method::GET, "/api/demos".to_owned()),
            (Method::POST, format!("/api/demos/{missing_id}/analyze")),
            (Method::GET, "/api/steam/matches".to_owned()),
            (Method::GET, format!("/api/demos/{missing_id}/replay")),
        ] {
            let response = dispatcher
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(&path)
                        .header(axum::http::header::CONTENT_TYPE, "application/json")
                        .body(Body::from("{}"))
                        .expect("request"),
                )
                .await
                .expect("response");
            let body = to_bytes(response.into_body(), 64 * 1024)
                .await
                .expect("response body");
            let payload: serde_json::Value = serde_json::from_slice(&body).expect("error payload");
            assert_eq!(
                payload["code"], "route_not_found",
                "retired route remained reachable: {path}"
            );
        }

        let retired_put = dispatcher
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri(format!("/api/editor/projects/{missing_id}"))
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from("{}"))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(
            retired_put.status(),
            axum::http::StatusCode::METHOD_NOT_ALLOWED
        );
    }

    #[tokio::test]
    async fn demo_collection_returns_only_the_current_summary_shape() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let now = Utc::now();
        storage
            .put_demo(DemoRecord {
                id: Uuid::new_v4(),
                path: "C:/matches/major-m1.dem".to_owned(),
                file_name: "major-m1.dem".to_owned(),
                display_name: "Major M1".to_owned(),
                source: "local".to_owned(),
                status: DemoStatus::Ready,
                map_name: Some("de_mirage".to_owned()),
                match_date: Some(now),
                duration_seconds: Some(2_400.0),
                total_rounds: Some(24),
                team_a_name: Some("Spirit".to_owned()),
                team_b_name: Some("Vitality".to_owned()),
                team_a_score: Some(13),
                team_b_score: Some(11),
                player_names: vec!["donk".to_owned(), "ZywOo".to_owned()],
                remark: String::new(),
                content_sha256: Some("ab".repeat(32)),
                file_size: 42,
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("persist demo");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .uri("/api/demos/compact?page=1&page_size=20")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("response body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("demo page");
        let item = payload["items"][0].as_object().expect("demo summary");
        let mut keys = item.keys().map(String::as_str).collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "content_sha256",
                "created_at",
                "display_name",
                "duration_seconds",
                "file_name",
                "file_size",
                "id",
                "map_name",
                "match_date",
                "path",
                "players",
                "remark",
                "source",
                "status",
                "team_a_name",
                "team_a_score",
                "team_b_name",
                "team_b_score",
                "total_rounds",
                "updated_at",
            ]
        );
        assert_eq!(item["players"], serde_json::json!(["donk", "ZywOo"]));
    }

    #[tokio::test]
    async fn editor_project_creation_accepts_only_the_current_four_field_shape() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/editor/projects")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"name":"Current","width":1920,"height":1080,"fps":60}"#,
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), axum::http::StatusCode::CREATED);

        for body in [
            r#"{"name":"Implicit defaults"}"#,
            r#"{"id":"00000000-0000-4000-8000-000000000001","name":"Injected","width":1920,"height":1080,"fps":60,"duration_seconds":9,"tracks":[],"markers":[],"settings":{},"revision":99,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}"#,
        ] {
            let response = dispatcher
                .clone()
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri("/api/editor/projects")
                        .header(axum::http::header::CONTENT_TYPE, "application/json")
                        .body(Body::from(body))
                        .expect("request"),
                )
                .await
                .expect("response");
            assert_eq!(
                response.status(),
                axum::http::StatusCode::BAD_REQUEST,
                "retired editor creation shape remained accepted: {body}"
            );
        }
    }

    #[tokio::test]
    async fn mutation_routes_reject_requests_missing_current_required_fields() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));
        let missing_id = Uuid::new_v4();

        for (path, body) in [
            (
                "/api/demos/import".to_owned(),
                r#"{"paths":["C:/missing.dem"]}"#,
            ),
            (
                "/api/demos/scan".to_owned(),
                r#"{"paths":["C:/missing.dem"]}"#,
            ),
            (
                "/api/montage/projects".to_owned(),
                r#"{"name":"Missing shape"}"#,
            ),
            (
                format!("/api/editor/projects/{missing_id}/duplicate"),
                r#"{"name":"Copy"}"#,
            ),
            (
                format!("/api/editor/projects/{missing_id}/clips/{missing_id}/separate-audio"),
                r#"{"expected_revision":1}"#,
            ),
        ] {
            let response = dispatcher
                .clone()
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri(&path)
                        .header(axum::http::header::CONTENT_TYPE, "application/json")
                        .body(Body::from(body))
                        .expect("request"),
                )
                .await
                .expect("response");
            assert_eq!(
                response.status(),
                axum::http::StatusCode::BAD_REQUEST,
                "request missing a current required field was accepted: {path}"
            );
        }
    }

    #[tokio::test]
    async fn dispatcher_does_not_accept_manual_hlae_status_requests() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/hlae/status")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"cs2_path":"C:/CS2/cs2.exe"}"#))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(
            response.status(),
            axum::http::StatusCode::METHOD_NOT_ALLOWED
        );
    }

    #[tokio::test]
    async fn dispatcher_exposes_bounded_cross_match_evidence_search() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .uri("/api/evidence/search?page=1&page_size=25")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("response body");
        let payload: vibe_cs_domain::EvidenceSearchPage =
            serde_json::from_slice(&body).expect("evidence search payload");
        assert_eq!(payload.page, 1);
        assert_eq!(payload.page_size, 25);
        assert_eq!(payload.total, 0);
    }

    #[tokio::test]
    async fn evidence_search_route_rejects_an_oversized_page() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .uri("/api/evidence/search?page_size=101")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn activity_feed_exposes_recording_stage_ordinal_without_claiming_percentage() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let job_id = Uuid::new_v4();
        let now = Utc::now();
        storage
            .put_recording_job(RecordingJob {
                id: job_id,
                status: JobStatus::Running,
                items: vec![],
                current_index: 0,
                progress: 0.425,
                message: "recording.stage.capturing".to_owned(),
                outputs: vec![],
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("persist recording job");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .uri("/api/activities")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("response body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("activity payload");
        assert_eq!(payload["items"][0]["id"], format!("recording:{job_id}"));
        assert_eq!(payload["items"][0]["kind"], "recording");
        assert_eq!(payload["items"][0]["job_id"], job_id.to_string());
        assert_eq!(payload["items"][0]["status"], "running");
        assert!(payload["items"][0]["progress_percent"].is_null());
        assert_eq!(payload["items"][0]["stage"], "recording.stage.capturing");
        assert_eq!(payload["items"][0]["completed_units"], 3);
        assert_eq!(payload["items"][0]["total_units"], 5);
        assert_eq!(payload["items"][0]["unit"], "stages");
        assert_eq!(
            payload["items"][0]["available_actions"],
            serde_json::json!(["cancel", "open_outputs"])
        );
    }

    #[tokio::test]
    async fn activity_feed_pages_the_globally_ordered_cross_workflow_projection() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let recording_id = Uuid::new_v4();
        let export_id = Uuid::new_v4();
        let demo_id = Uuid::new_v4();
        let now = Utc::now();

        storage
            .put_recording_job(RecordingJob {
                id: recording_id,
                status: JobStatus::Running,
                items: vec![],
                current_index: 0,
                progress: 0.0,
                message: "recording.stage.launching".to_owned(),
                outputs: vec![],
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("persist recording job");
        storage
            .put_export_job(ExportJobRecord {
                kind: "montage".to_owned(),
                job: ExportJob {
                    id: export_id,
                    project_id: Uuid::new_v4(),
                    status: JobStatus::Completed,
                    progress: 1.0,
                    output_path: "C:/exports/middle.mp4".to_owned(),
                    error: None,
                    created_at: now - chrono::Duration::seconds(1),
                    updated_at: now - chrono::Duration::seconds(1),
                },
            })
            .await
            .expect("persist export job");
        storage
            .put_demo(DemoRecord {
                id: demo_id,
                path: "C:/matches/oldest.dem".to_owned(),
                file_name: "oldest.dem".to_owned(),
                display_name: "Oldest failed analysis".to_owned(),
                source: "local".to_owned(),
                status: DemoStatus::Failed,
                map_name: None,
                match_date: None,
                duration_seconds: None,
                total_rounds: None,
                team_a_name: None,
                team_b_name: None,
                team_a_score: None,
                team_b_score: None,
                player_names: vec![],
                remark: String::new(),
                content_sha256: Some("ab".repeat(32)),
                file_size: 42,
                created_at: now - chrono::Duration::seconds(2),
                updated_at: now - chrono::Duration::seconds(2),
            })
            .await
            .expect("persist analysis lifecycle");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .uri("/api/activities?page=2&page_size=1")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("response body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("activity payload");

        assert_eq!(payload["total"], 3);
        assert_eq!(payload["page"], 2);
        assert_eq!(payload["page_size"], 1);
        assert_eq!(payload["items"].as_array().map(Vec::len), Some(1));
        assert_eq!(payload["items"][0]["id"], format!("export:{export_id}"));
        assert_eq!(payload["summary"]["active"], 1);
        assert_eq!(payload["summary"]["failed"], 1);
        assert_eq!(payload["summary"]["completed"], 1);
    }

    #[tokio::test]
    async fn activity_feed_filters_before_paging_without_changing_global_summary() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let recording_id = Uuid::new_v4();
        let demo_id = Uuid::new_v4();
        let now = Utc::now();

        storage
            .put_recording_job(RecordingJob {
                id: recording_id,
                status: JobStatus::Running,
                items: vec![],
                current_index: 0,
                progress: 0.0,
                message: "recording.stage.launching".to_owned(),
                outputs: vec![],
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("persist recording job");
        storage
            .put_demo(DemoRecord {
                id: demo_id,
                path: "C:/matches/needle.dem".to_owned(),
                file_name: "needle.dem".to_owned(),
                display_name: "Needle failed analysis".to_owned(),
                source: "local".to_owned(),
                status: DemoStatus::Failed,
                map_name: None,
                match_date: None,
                duration_seconds: None,
                total_rounds: None,
                team_a_name: None,
                team_b_name: None,
                team_a_score: None,
                team_b_score: None,
                player_names: vec![],
                remark: String::new(),
                content_sha256: Some("cd".repeat(32)),
                file_size: 42,
                created_at: now,
                updated_at: now - chrono::Duration::seconds(1),
            })
            .await
            .expect("persist analysis lifecycle");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .uri("/api/activities?kind=analysis&state=failed&search=needle&page=1&page_size=1")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("response body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("activity payload");

        assert_eq!(payload["total"], 1);
        assert_eq!(payload["items"].as_array().map(Vec::len), Some(1));
        assert_eq!(payload["items"][0]["id"], format!("analysis:{demo_id}"));
        assert_eq!(payload["summary"]["total"], 2);
        assert_eq!(payload["summary"]["active"], 1);
        assert_eq!(payload["summary"]["failed"], 1);
    }

    #[tokio::test]
    async fn activity_feed_rejects_an_unbounded_public_page() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .uri("/api/activities?page=1&page_size=101")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn activity_feed_preserves_export_kind_error_and_terminal_actions() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let job_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let now = Utc::now();
        storage
            .put_export_job(ExportJobRecord {
                kind: "montage".to_owned(),
                job: ExportJob {
                    id: job_id,
                    project_id,
                    status: JobStatus::Failed,
                    progress: 0.67,
                    output_path: "C:/exports/major-m1.mp4".to_owned(),
                    error: Some("encoder stopped".to_owned()),
                    created_at: now,
                    updated_at: now,
                },
            })
            .await
            .expect("persist export job");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .uri("/api/activities")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("response body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("activity payload");

        assert_eq!(payload["items"][0]["id"], format!("export:{job_id}"));
        assert_eq!(payload["items"][0]["kind"], "export");
        assert_eq!(payload["items"][0]["subtype"], "montage");
        assert_eq!(payload["items"][0]["context_id"], project_id.to_string());
        assert_eq!(payload["items"][0]["status"], "failed");
        assert_eq!(payload["items"][0]["progress_percent"], 67);
        assert_eq!(payload["items"][0]["error"], "encoder stopped");
        assert_eq!(
            payload["items"][0]["available_actions"],
            serde_json::json!(["open_outputs"])
        );
    }

    #[tokio::test]
    async fn activity_feed_keeps_download_phase_and_hides_unprovable_percentage() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let job_id = Uuid::new_v4();
        let now = Utc::now();
        storage
            .put_steam_matches(vec![SteamMatchRecord {
                id: "76561198000000000:42".to_owned(),
                steam_id: "76561198000000000".to_owned(),
                match_id: "42".to_owned(),
                outcome_id: "420".to_owned(),
                token: 42,
                map_name: Some("de_anubis".to_owned()),
                played_at: Some(now),
                score: Some("13:10".to_owned()),
                result: MatchHistoryResult::Win,
                demo_status: MatchDemoStatus::Downloading,
                demo_id: None,
                last_error: None,
                synced_at: now,
                updated_at: now,
            }])
            .await
            .expect("persist match record");
        storage
            .put_match_download_job(MatchDownloadJob {
                id: job_id,
                match_record_id: "76561198000000000:42".to_owned(),
                status: MatchDownloadStatus::Decompressing,
                downloaded_bytes: 8_192,
                total_bytes: None,
                progress: 0.8,
                demo_id: None,
                error: None,
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("persist download job");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .uri("/api/activities")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("response body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("activity payload");

        assert_eq!(payload["items"][0]["id"], format!("download:{job_id}"));
        assert_eq!(payload["items"][0]["kind"], "download");
        assert_eq!(payload["items"][0]["context_id"], "76561198000000000:42");
        assert_eq!(payload["items"][0]["status"], "decompressing");
        assert_eq!(payload["items"][0]["completed_units"], 8_192);
        assert_eq!(payload["items"][0]["unit"], "bytes");
        assert!(payload["items"][0]["total_units"].is_null());
        assert!(payload["items"][0]["progress_percent"].is_null());
        assert_eq!(
            payload["items"][0]["available_actions"],
            serde_json::json!(["cancel", "open_match_history"])
        );
    }

    #[tokio::test]
    async fn activity_feed_exposes_a_real_retry_for_failed_downloads() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        configure_steam_downloads(&storage, "76561198000000000").await;
        let job_id = Uuid::new_v4();
        let now = Utc::now();
        storage
            .put_steam_matches(vec![SteamMatchRecord {
                id: "76561198000000000:failed".to_owned(),
                steam_id: "76561198000000000".to_owned(),
                match_id: "failed".to_owned(),
                outcome_id: "failed-outcome".to_owned(),
                token: 42,
                map_name: Some("de_anubis".to_owned()),
                played_at: Some(now),
                score: Some("10:13".to_owned()),
                result: MatchHistoryResult::Loss,
                demo_status: MatchDemoStatus::Failed,
                demo_id: None,
                last_error: Some("download ticket expired".to_owned()),
                synced_at: now,
                updated_at: now,
            }])
            .await
            .expect("persist match record");
        storage
            .put_match_download_job(MatchDownloadJob {
                id: job_id,
                match_record_id: "76561198000000000:failed".to_owned(),
                status: MatchDownloadStatus::Failed,
                downloaded_bytes: 4_096,
                total_bytes: Some(8_192),
                progress: 0.5,
                demo_id: None,
                error: Some("download ticket expired".to_owned()),
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("persist failed download job");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .uri("/api/activities")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("response body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("activity payload");

        assert_eq!(payload["items"][0]["id"], format!("download:{job_id}"));
        assert_eq!(payload["items"][0]["status"], "failed");
        assert_eq!(payload["items"][0]["error"], "download ticket expired");
        assert_eq!(
            payload["items"][0]["available_actions"],
            serde_json::json!(["retry_download", "open_match_history"])
        );
    }

    #[tokio::test]
    async fn activity_feed_hides_download_retry_without_current_steam_credentials() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let now = Utc::now();
        let match_record_id = "76561198000000000:unconfigured";
        storage
            .put_steam_matches(vec![SteamMatchRecord {
                id: match_record_id.to_owned(),
                steam_id: "76561198000000000".to_owned(),
                match_id: "unconfigured".to_owned(),
                outcome_id: "unconfigured-outcome".to_owned(),
                token: 42,
                map_name: Some("de_anubis".to_owned()),
                played_at: Some(now),
                score: Some("10:13".to_owned()),
                result: MatchHistoryResult::Loss,
                demo_status: MatchDemoStatus::Failed,
                demo_id: None,
                last_error: Some("download ticket expired".to_owned()),
                synced_at: now,
                updated_at: now,
            }])
            .await
            .expect("persist match record");
        storage
            .put_match_download_job(MatchDownloadJob {
                id: Uuid::new_v4(),
                match_record_id: match_record_id.to_owned(),
                status: MatchDownloadStatus::Failed,
                downloaded_bytes: 4_096,
                total_bytes: Some(8_192),
                progress: 0.5,
                demo_id: None,
                error: Some("download ticket expired".to_owned()),
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("persist failed download job");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .uri("/api/activities?kind=download")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("response body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("activity payload");

        assert_eq!(
            payload["items"][0]["available_actions"],
            serde_json::json!(["open_match_history"])
        );
    }

    #[tokio::test]
    async fn activity_feed_hides_download_retry_for_a_different_current_steam_account() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        configure_steam_downloads(&storage, "76561198000000001").await;
        let now = Utc::now();
        let match_record_id = "76561198000000000:previous-account";
        storage
            .put_steam_matches(vec![SteamMatchRecord {
                id: match_record_id.to_owned(),
                steam_id: "76561198000000000".to_owned(),
                match_id: "previous-account".to_owned(),
                outcome_id: "previous-account-outcome".to_owned(),
                token: 42,
                map_name: Some("de_anubis".to_owned()),
                played_at: Some(now),
                score: Some("10:13".to_owned()),
                result: MatchHistoryResult::Loss,
                demo_status: MatchDemoStatus::Failed,
                demo_id: None,
                last_error: Some("download ticket expired".to_owned()),
                synced_at: now,
                updated_at: now,
            }])
            .await
            .expect("persist match record");
        storage
            .put_match_download_job(MatchDownloadJob {
                id: Uuid::new_v4(),
                match_record_id: match_record_id.to_owned(),
                status: MatchDownloadStatus::Failed,
                downloaded_bytes: 4_096,
                total_bytes: Some(8_192),
                progress: 0.5,
                demo_id: None,
                error: Some("download ticket expired".to_owned()),
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("persist failed download job");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .uri("/api/activities?kind=download")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("response body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("activity payload");

        assert_eq!(
            payload["items"][0]["available_actions"],
            serde_json::json!(["open_match_history"])
        );
    }

    #[tokio::test]
    async fn activity_feed_does_not_offer_retry_on_an_old_failure_while_a_newer_download_is_active()
    {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        configure_steam_downloads(&storage, "76561198000000000").await;
        let failed_job_id = Uuid::new_v4();
        let active_job_id = Uuid::new_v4();
        let now = Utc::now();
        let match_record_id = "76561198000000000:retrying";
        storage
            .put_steam_matches(vec![SteamMatchRecord {
                id: match_record_id.to_owned(),
                steam_id: "76561198000000000".to_owned(),
                match_id: "retrying".to_owned(),
                outcome_id: "retrying-outcome".to_owned(),
                token: 44,
                map_name: Some("de_nuke".to_owned()),
                played_at: Some(now),
                score: Some("13:11".to_owned()),
                result: MatchHistoryResult::Win,
                demo_status: MatchDemoStatus::Downloading,
                demo_id: None,
                last_error: None,
                synced_at: now,
                updated_at: now,
            }])
            .await
            .expect("persist match record");
        for job in [
            MatchDownloadJob {
                id: failed_job_id,
                match_record_id: match_record_id.to_owned(),
                status: MatchDownloadStatus::Failed,
                downloaded_bytes: 1_024,
                total_bytes: Some(8_192),
                progress: 0.125,
                demo_id: None,
                error: Some("first ticket expired".to_owned()),
                created_at: now - chrono::Duration::seconds(2),
                updated_at: now - chrono::Duration::seconds(2),
            },
            MatchDownloadJob {
                id: active_job_id,
                match_record_id: match_record_id.to_owned(),
                status: MatchDownloadStatus::Downloading,
                downloaded_bytes: 2_048,
                total_bytes: Some(8_192),
                progress: 0.25,
                demo_id: None,
                error: None,
                created_at: now,
                updated_at: now,
            },
        ] {
            storage
                .put_match_download_job(job)
                .await
                .expect("persist download job");
        }
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .uri("/api/activities?kind=download")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("response body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("activity payload");

        assert_eq!(
            payload["items"][0]["id"],
            format!("download:{active_job_id}")
        );
        assert_eq!(
            payload["items"][0]["available_actions"],
            serde_json::json!(["cancel", "open_match_history"])
        );
        assert_eq!(
            payload["items"][1]["id"],
            format!("download:{failed_job_id}")
        );
        assert_eq!(
            payload["items"][1]["available_actions"],
            serde_json::json!(["open_match_history"])
        );
    }

    #[tokio::test]
    async fn activity_feed_does_not_offer_retry_when_the_match_already_has_a_downloaded_demo() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        configure_steam_downloads(&storage, "76561198000000000").await;
        let failed_job_id = Uuid::new_v4();
        let demo_id = Uuid::new_v4();
        let now = Utc::now();
        let match_record_id = "76561198000000000:downloaded";
        storage
            .put_demo(DemoRecord {
                id: demo_id,
                path: "C:/matches/downloaded.dem".to_owned(),
                file_name: "downloaded.dem".to_owned(),
                display_name: "Downloaded match".to_owned(),
                source: "steam".to_owned(),
                status: DemoStatus::Ready,
                map_name: Some("de_train".to_owned()),
                match_date: Some(now),
                duration_seconds: None,
                total_rounds: None,
                team_a_name: None,
                team_b_name: None,
                team_a_score: None,
                team_b_score: None,
                player_names: vec![],
                remark: String::new(),
                content_sha256: Some("cd".repeat(32)),
                file_size: 8_192,
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("persist downloaded demo");
        storage
            .put_steam_matches(vec![SteamMatchRecord {
                id: match_record_id.to_owned(),
                steam_id: "76561198000000000".to_owned(),
                match_id: "downloaded".to_owned(),
                outcome_id: "downloaded-outcome".to_owned(),
                token: 45,
                map_name: Some("de_train".to_owned()),
                played_at: Some(now),
                score: Some("13:7".to_owned()),
                result: MatchHistoryResult::Win,
                demo_status: MatchDemoStatus::Downloaded,
                demo_id: Some(demo_id),
                last_error: None,
                synced_at: now,
                updated_at: now,
            }])
            .await
            .expect("persist downloaded match record");
        storage
            .put_match_download_job(MatchDownloadJob {
                id: failed_job_id,
                match_record_id: match_record_id.to_owned(),
                status: MatchDownloadStatus::Failed,
                downloaded_bytes: 4_096,
                total_bytes: Some(8_192),
                progress: 0.5,
                demo_id: None,
                error: Some("stale failed attempt".to_owned()),
                created_at: now - chrono::Duration::seconds(1),
                updated_at: now - chrono::Duration::seconds(1),
            })
            .await
            .expect("persist stale failed job");
        let dispatcher = build_dispatcher(AppState::new(
            storage.clone(),
            directory.path().to_path_buf(),
        ));

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .uri("/api/activities?kind=download")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("response body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("activity payload");

        assert_eq!(
            payload["items"][0]["id"],
            format!("download:{failed_job_id}")
        );
        assert_eq!(
            payload["items"][0]["available_actions"],
            serde_json::json!(["open_match_history"])
        );

        let completed_job_id = Uuid::new_v4();
        storage
            .put_match_download_job(MatchDownloadJob {
                id: completed_job_id,
                match_record_id: match_record_id.to_owned(),
                status: MatchDownloadStatus::Completed,
                downloaded_bytes: 8_192,
                total_bytes: Some(8_192),
                progress: 1.0,
                demo_id: Some(demo_id),
                error: None,
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("persist newer completed job");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));
        let response = dispatcher
            .oneshot(
                Request::builder()
                    .uri("/api/activities?kind=download")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("response body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("activity payload");

        assert_eq!(
            payload["items"][0]["id"],
            format!("download:{completed_job_id}")
        );
        assert_eq!(
            payload["items"][1]["id"],
            format!("download:{failed_job_id}")
        );
        assert_eq!(
            payload["items"][1]["available_actions"],
            serde_json::json!(["open_match_history"])
        );
    }

    #[tokio::test]
    async fn activity_feed_offers_retry_only_on_one_stably_selected_latest_terminal_attempt() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        configure_steam_downloads(&storage, "76561198000000000").await;
        let selected_job_id =
            Uuid::parse_str("00000000-0000-0000-0000-000000000001").expect("selected job id");
        let tied_job_id =
            Uuid::parse_str("00000000-0000-0000-0000-000000000002").expect("tied job id");
        let old_job_id =
            Uuid::parse_str("00000000-0000-0000-0000-000000000003").expect("old job id");
        let now = Utc::now();
        let match_record_id = "76561198000000000:repeated";
        storage
            .put_steam_matches(vec![SteamMatchRecord {
                id: match_record_id.to_owned(),
                steam_id: "76561198000000000".to_owned(),
                match_id: "repeated".to_owned(),
                outcome_id: "repeated-outcome".to_owned(),
                token: 46,
                map_name: Some("de_overpass".to_owned()),
                played_at: Some(now),
                score: Some("11:13".to_owned()),
                result: MatchHistoryResult::Loss,
                demo_status: MatchDemoStatus::Failed,
                demo_id: None,
                last_error: Some("latest terminal attempt failed".to_owned()),
                synced_at: now,
                updated_at: now,
            }])
            .await
            .expect("persist match record");
        for job in [
            MatchDownloadJob {
                id: old_job_id,
                match_record_id: match_record_id.to_owned(),
                status: MatchDownloadStatus::Failed,
                downloaded_bytes: 0,
                total_bytes: None,
                progress: 0.0,
                demo_id: None,
                error: Some("old failure".to_owned()),
                created_at: now - chrono::Duration::seconds(3),
                updated_at: now - chrono::Duration::seconds(3),
            },
            MatchDownloadJob {
                id: tied_job_id,
                match_record_id: match_record_id.to_owned(),
                status: MatchDownloadStatus::Cancelled,
                downloaded_bytes: 0,
                total_bytes: None,
                progress: 0.0,
                demo_id: None,
                error: None,
                created_at: now - chrono::Duration::seconds(2),
                updated_at: now - chrono::Duration::seconds(1),
            },
            MatchDownloadJob {
                id: selected_job_id,
                match_record_id: match_record_id.to_owned(),
                status: MatchDownloadStatus::Failed,
                downloaded_bytes: 1_024,
                total_bytes: Some(8_192),
                progress: 0.125,
                demo_id: None,
                error: Some("latest failure".to_owned()),
                created_at: now - chrono::Duration::seconds(1),
                updated_at: now - chrono::Duration::seconds(1),
            },
        ] {
            storage
                .put_match_download_job(job)
                .await
                .expect("persist terminal download job");
        }
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .uri("/api/activities?kind=download")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("response body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("activity payload");
        let items = payload["items"].as_array().expect("activity items");
        let retryable = items
            .iter()
            .filter(|item| {
                item["available_actions"]
                    .as_array()
                    .is_some_and(|actions| actions.iter().any(|action| action == "retry_download"))
            })
            .collect::<Vec<_>>();

        assert_eq!(retryable.len(), 1);
        assert_eq!(retryable[0]["id"], format!("download:{selected_job_id}"));
        assert_eq!(items[1]["id"], format!("download:{tied_job_id}"));
        assert_eq!(items[2]["id"], format!("download:{old_job_id}"));
    }

    #[tokio::test]
    async fn activity_feed_exposes_a_real_retry_for_cancelled_downloads() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        configure_steam_downloads(&storage, "76561198000000000").await;
        let job_id = Uuid::new_v4();
        let now = Utc::now();
        storage
            .put_steam_matches(vec![SteamMatchRecord {
                id: "76561198000000000:cancelled".to_owned(),
                steam_id: "76561198000000000".to_owned(),
                match_id: "cancelled".to_owned(),
                outcome_id: "cancelled-outcome".to_owned(),
                token: 43,
                map_name: Some("de_inferno".to_owned()),
                played_at: Some(now),
                score: Some("8:13".to_owned()),
                result: MatchHistoryResult::Loss,
                demo_status: MatchDemoStatus::Available,
                demo_id: None,
                last_error: None,
                synced_at: now,
                updated_at: now,
            }])
            .await
            .expect("persist match record");
        storage
            .put_match_download_job(MatchDownloadJob {
                id: job_id,
                match_record_id: "76561198000000000:cancelled".to_owned(),
                status: MatchDownloadStatus::Cancelled,
                downloaded_bytes: 0,
                total_bytes: None,
                progress: 0.0,
                demo_id: None,
                error: None,
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("persist cancelled download job");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .uri("/api/activities")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("response body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("activity payload");

        assert_eq!(payload["items"][0]["id"], format!("download:{job_id}"));
        assert_eq!(payload["items"][0]["status"], "cancelled");
        assert_eq!(
            payload["items"][0]["available_actions"],
            serde_json::json!(["retry_download", "open_match_history"])
        );
    }

    #[tokio::test]
    async fn activity_feed_projects_failed_analysis_without_claiming_a_job_or_error_detail() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let demo_id = Uuid::new_v4();
        let now = Utc::now();
        storage
            .put_demo(DemoRecord {
                id: demo_id,
                path: "C:/matches/major-m1.dem".to_owned(),
                file_name: "major-m1.dem".to_owned(),
                display_name: "Major M1".to_owned(),
                source: "local".to_owned(),
                status: DemoStatus::Failed,
                map_name: Some("de_anubis".to_owned()),
                match_date: Some(now),
                duration_seconds: None,
                total_rounds: None,
                team_a_name: None,
                team_b_name: None,
                team_a_score: None,
                team_b_score: None,
                player_names: vec![],
                remark: String::new(),
                content_sha256: Some("ab".repeat(32)),
                file_size: 42,
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("persist failed demo");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .uri("/api/activities")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("response body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("activity payload");

        assert_eq!(payload["items"][0]["id"], format!("analysis:{demo_id}"));
        assert_eq!(payload["items"][0]["kind"], "analysis");
        assert!(payload["items"][0]["job_id"].is_null());
        assert_eq!(payload["items"][0]["context_id"], demo_id.to_string());
        assert_eq!(payload["items"][0]["subject"], "Major M1");
        assert_eq!(payload["items"][0]["status"], "failed");
        assert!(payload["items"][0]["progress_percent"].is_null());
        assert!(payload["items"][0]["error"].is_null());
        assert_eq!(
            payload["items"][0]["available_actions"],
            serde_json::json!(["retry_analysis", "open_library"])
        );
    }

    #[tokio::test]
    async fn activity_feed_counts_analysis_lifecycle_beyond_one_public_page() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let now = Utc::now();
        let demos = (0..201)
            .map(|index| {
                let id = Uuid::new_v4();
                DemoRecord {
                    id,
                    path: format!("C:/matches/failed-{index}.dem"),
                    file_name: format!("failed-{index}.dem"),
                    display_name: format!("Failed {index}"),
                    source: "local".to_owned(),
                    status: DemoStatus::Failed,
                    map_name: None,
                    match_date: None,
                    duration_seconds: None,
                    total_rounds: None,
                    team_a_name: None,
                    team_b_name: None,
                    team_a_score: None,
                    team_b_score: None,
                    player_names: vec![],
                    remark: String::new(),
                    content_sha256: Some(id.simple().to_string().repeat(2)),
                    file_size: 42,
                    created_at: now,
                    updated_at: now,
                }
            })
            .collect();
        storage
            .put_demos(demos)
            .await
            .expect("persist failed demos");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .uri("/api/activities?page=3&page_size=100")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let body = to_bytes(response.into_body(), 512 * 1024)
            .await
            .expect("response body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("activity payload");

        assert_eq!(payload["total"], 201);
        assert_eq!(payload["page"], 3);
        assert_eq!(payload["page_size"], 100);
        assert_eq!(payload["items"].as_array().map(Vec::len), Some(1));
    }

    #[tokio::test]
    async fn activity_feed_includes_only_ready_demos_with_a_persisted_analysis_as_completed() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let demo_id = Uuid::new_v4();
        let unrelated_id = Uuid::new_v4();
        let now = Utc::now();
        let ready_demo = |id, name: &str| DemoRecord {
            id,
            path: format!("C:/matches/{id}.dem"),
            file_name: format!("{id}.dem"),
            display_name: name.to_owned(),
            source: "local".to_owned(),
            status: DemoStatus::Ready,
            map_name: Some("de_anubis".to_owned()),
            match_date: Some(now),
            duration_seconds: None,
            total_rounds: None,
            team_a_name: None,
            team_b_name: None,
            team_a_score: None,
            team_b_score: None,
            player_names: vec![],
            remark: String::new(),
            content_sha256: Some(id.simple().to_string().repeat(2)),
            file_size: 42,
            created_at: now,
            updated_at: now,
        };
        storage
            .put_demos(vec![
                ready_demo(demo_id, "Analyzed M1"),
                ready_demo(unrelated_id, "Ready only"),
            ])
            .await
            .expect("persist demos");
        storage
            .put_analysis(MatchAnalysis {
                demo_id,
                map_name: "de_anubis".to_owned(),
                tick_rate: 64.0,
                duration_seconds: 120.0,
                verified_total_ticks: Some(7_680),
                teams: vec![],
                players: vec![],
                rounds: vec![],
                highlights: vec![],
            })
            .await
            .expect("persist analysis");
        let dispatcher = build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .uri("/api/activities")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("response body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("activity payload");

        assert_eq!(payload["items"].as_array().map(Vec::len), Some(1));
        assert_eq!(payload["items"][0]["id"], format!("analysis:{demo_id}"));
        assert_eq!(payload["items"][0]["subject"], "Analyzed M1");
        assert_eq!(payload["items"][0]["status"], "completed");
        assert!(payload["items"][0]["job_id"].is_null());
        assert!(payload["items"][0]["progress_percent"].is_null());
        assert_eq!(
            payload["items"][0]["available_actions"],
            serde_json::json!(["open_analysis", "open_library"])
        );
    }
}
