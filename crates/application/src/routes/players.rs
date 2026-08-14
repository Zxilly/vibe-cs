use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderName, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};

use crate::{
    ApiError, ApiQuery, ApiResult, AppState, AvatarCacheCleanup, AvatarCacheStatus, PlayerAvatar,
    PlayerComparison, PlayerComparisonQuery, PlayerDirectoryPage, PlayerDirectoryQuery,
    PlayerMapPage, PlayerMapQuery, PlayerMatchPage, PlayerMatchQuery, PlayerProfile,
};

const AVATAR_CACHE_HEADER: HeaderName = HeaderName::from_static("x-vibe-cs-avatar-cache");

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/players", get(list_players))
        .route("/api/players/compare", get(compare_players))
        .route("/api/players/{steam_id}/maps", get(list_player_maps))
        .route("/api/players/{steam_id}/matches", get(list_player_matches))
        .route("/api/players/{steam_id}", get(get_player))
        .route(
            "/api/players/{steam_id}/avatar",
            get(get_avatar).head(head_avatar),
        )
        .route(
            "/api/avatar-cache",
            get(avatar_cache_status).delete(clear_avatar_cache),
        )
}

async fn list_players(
    State(state): State<AppState>,
    ApiQuery(query): ApiQuery<PlayerDirectoryQuery>,
) -> ApiResult<Json<PlayerDirectoryPage>> {
    state
        .players
        .list(query)
        .await
        .map(Json)
        .map_err(Into::into)
}

async fn compare_players(
    State(state): State<AppState>,
    ApiQuery(query): ApiQuery<PlayerComparisonQuery>,
) -> ApiResult<Json<PlayerComparison>> {
    state
        .players
        .compare(query)
        .await
        .map(Json)
        .map_err(Into::into)
}

async fn get_player(
    State(state): State<AppState>,
    Path(steam_id): Path<String>,
) -> ApiResult<Json<PlayerProfile>> {
    state
        .players
        .get(steam_id)
        .await
        .map(Json)
        .map_err(Into::into)
}

async fn list_player_matches(
    State(state): State<AppState>,
    Path(steam_id): Path<String>,
    ApiQuery(query): ApiQuery<PlayerMatchQuery>,
) -> ApiResult<Json<PlayerMatchPage>> {
    query.validate()?;
    state
        .players
        .matches(steam_id, query)
        .await
        .map(Json)
        .map_err(Into::into)
}

async fn list_player_maps(
    State(state): State<AppState>,
    Path(steam_id): Path<String>,
    ApiQuery(query): ApiQuery<PlayerMapQuery>,
) -> ApiResult<Json<PlayerMapPage>> {
    query.validate()?;
    state
        .players
        .maps(steam_id, query)
        .await
        .map(Json)
        .map_err(Into::into)
}

async fn get_avatar(
    State(state): State<AppState>,
    Path(steam_id): Path<String>,
) -> ApiResult<Response> {
    let avatar = state.players.avatar(steam_id).await?;
    avatar_response(avatar, false)
}

async fn head_avatar(
    State(state): State<AppState>,
    Path(steam_id): Path<String>,
) -> ApiResult<Response> {
    let avatar = state.players.avatar(steam_id).await?;
    avatar_response(avatar, true)
}

fn avatar_response(avatar: PlayerAvatar, head_only: bool) -> ApiResult<Response> {
    if !matches!(
        avatar.content_type.as_str(),
        "image/jpeg" | "image/png" | "image/webp"
    ) {
        return Err(adapter_metadata_error("content type"));
    }

    let content_type = HeaderValue::from_str(&avatar.content_type)
        .map_err(|_| adapter_metadata_error("content type"))?;
    let content_length = HeaderValue::from_str(&avatar.bytes.len().to_string())
        .map_err(|_| adapter_metadata_error("content length"))?;
    let etag =
        HeaderValue::from_str(&avatar.etag).map_err(|_| adapter_metadata_error("entity tag"))?;
    let last_modified = avatar
        .last_modified
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string();
    let last_modified = HeaderValue::from_str(&last_modified)
        .map_err(|_| adapter_metadata_error("modification time"))?;
    let cache_state = if avatar.cached { "hit" } else { "miss" };
    let body = if head_only {
        Body::empty()
    } else {
        Body::from(avatar.bytes)
    };
    let mut response = body.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, content_type);
    headers.insert(header::CONTENT_LENGTH, content_length);
    headers.insert(header::ETAG, etag);
    headers.insert(header::LAST_MODIFIED, last_modified);
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=86400"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(AVATAR_CACHE_HEADER, HeaderValue::from_static(cache_state));
    Ok(response)
}

fn adapter_metadata_error(field: &str) -> ApiError {
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "invalid_avatar_metadata",
        format!("Avatar adapter returned an invalid {field}"),
    )
}

async fn avatar_cache_status(State(state): State<AppState>) -> ApiResult<Json<AvatarCacheStatus>> {
    state
        .players
        .avatar_cache_status()
        .await
        .map(Json)
        .map_err(Into::into)
}

async fn clear_avatar_cache(State(state): State<AppState>) -> ApiResult<Json<AvatarCacheCleanup>> {
    state
        .players
        .clear_avatar_cache()
        .await
        .map(Json)
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use axum::{body::to_bytes, http::Request};
    use chrono::{TimeZone, Utc};
    use tower::ServiceExt;
    use vibe_cs_domain::DomainError;

    use super::*;
    use crate::{
        PlayerAggregateStats, PlayerComparison, PlayerComparisonQuery, PlayerDirectoryItem,
        PlayerDirectorySort, PlayerDirectorySortDirection, PlayerPort, PlayerProjectionCoverage,
        PlayerSteamProfile,
    };

    const PLAYER_ID: &str = "76561198000000001";

    #[derive(Debug)]
    struct FixturePlayers {
        last_query: Mutex<Option<PlayerDirectoryQuery>>,
        last_comparison: Mutex<Option<PlayerComparisonQuery>>,
    }

    impl FixturePlayers {
        fn new() -> Self {
            Self {
                last_query: Mutex::new(None),
                last_comparison: Mutex::new(None),
            }
        }
    }

    #[async_trait]
    impl PlayerPort for FixturePlayers {
        async fn list(
            &self,
            query: PlayerDirectoryQuery,
        ) -> Result<PlayerDirectoryPage, DomainError> {
            *self.last_query.lock().expect("query lock") = Some(query);
            Ok(PlayerDirectoryPage {
                items: Vec::new(),
                total: 0,
                page: 2,
                page_size: 25,
                coverage: coverage(12),
            })
        }

        async fn get(&self, steam_id: String) -> Result<PlayerProfile, DomainError> {
            Ok(PlayerProfile {
                player: PlayerDirectoryItem {
                    steam_id,
                    name: "Local Player".to_owned(),
                    aliases: Vec::new(),
                    aliases_total: 0,
                    last_team: None,
                    last_match_date: None,
                    last_cataloged_at: Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
                    stats: PlayerAggregateStats::default(),
                    steam: PlayerSteamProfile::not_configured(),
                },
                coverage: coverage(1),
            })
        }

        async fn matches(
            &self,
            steam_id: String,
            query: PlayerMatchQuery,
        ) -> Result<PlayerMatchPage, DomainError> {
            Ok(PlayerMatchPage {
                steam_id,
                items: Vec::new(),
                total: 0,
                page: query.page,
                page_size: query.page_size,
                coverage: coverage(12),
            })
        }

        async fn maps(
            &self,
            steam_id: String,
            query: PlayerMapQuery,
        ) -> Result<PlayerMapPage, DomainError> {
            Ok(PlayerMapPage {
                steam_id,
                items: Vec::new(),
                total: 0,
                page: query.page,
                page_size: query.page_size,
                coverage: coverage(12),
            })
        }

        async fn compare(
            &self,
            query: PlayerComparisonQuery,
        ) -> Result<PlayerComparison, DomainError> {
            *self.last_comparison.lock().expect("comparison lock") = Some(query.clone());
            let player = |steam_id: String| PlayerDirectoryItem {
                steam_id,
                name: "Local Player".to_owned(),
                aliases: Vec::new(),
                aliases_total: 0,
                last_team: None,
                last_match_date: None,
                last_cataloged_at: Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
                stats: PlayerAggregateStats::default(),
                steam: PlayerSteamProfile::not_configured(),
            };
            Ok(PlayerComparison {
                players: [player(query.left), player(query.right)],
                coverage: coverage(12),
            })
        }

        async fn avatar(&self, _steam_id: String) -> Result<PlayerAvatar, DomainError> {
            Ok(PlayerAvatar {
                bytes: b"fixture-avatar".to_vec(),
                content_type: "image/jpeg".to_owned(),
                etag: "\"sha256-fixture\"".to_owned(),
                last_modified: Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
                cached: true,
            })
        }

        async fn avatar_cache_status(&self) -> Result<AvatarCacheStatus, DomainError> {
            Ok(AvatarCacheStatus {
                entries: 1,
                bytes: 14,
                maximum_entries: 500,
                maximum_bytes: 64 * 1024 * 1024,
                scan_complete: true,
                checked_at: Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
            })
        }

        async fn clear_avatar_cache(&self) -> Result<AvatarCacheCleanup, DomainError> {
            Ok(AvatarCacheCleanup {
                removed_entries: 1,
                freed_bytes: 14,
                failed_entries: 0,
                scan_complete: true,
                completed_at: Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
            })
        }
    }

    const fn coverage(projected_demos: u64) -> PlayerProjectionCoverage {
        PlayerProjectionCoverage {
            projected_demos,
            total_analyses: projected_demos,
            projection_complete: true,
        }
    }

    async fn test_state(players: Arc<FixturePlayers>) -> (tempfile::TempDir, AppState) {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage, directory.path().to_path_buf()).with_players(players);
        (directory, state)
    }

    #[tokio::test]
    async fn player_list_forwards_bounded_query_fields() {
        let players = Arc::new(FixturePlayers::new());
        let (_directory, state) = test_state(Arc::clone(&players)).await;
        let query = PlayerDirectoryQuery {
            search: Some("local".to_owned()),
            page: Some(2),
            page_size: Some(25),
            sort: PlayerDirectorySort::Kills,
            direction: PlayerDirectorySortDirection::Asc,
        };

        let Json(page) = list_players(State(state), ApiQuery(query.clone()))
            .await
            .expect("player page");

        assert_eq!(page.page, 2);
        assert_eq!(
            players.last_query.lock().expect("query lock").as_ref(),
            Some(&query)
        );
    }

    #[tokio::test]
    async fn player_comparison_forwards_two_explicit_ordered_ids() {
        let players = Arc::new(FixturePlayers::new());
        let (_directory, state) = test_state(Arc::clone(&players)).await;
        let query = PlayerComparisonQuery {
            left: PLAYER_ID.to_owned(),
            right: "76561198000000002".to_owned(),
        };

        let response = router()
            .with_state(state)
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/players/compare?left={}&right={}",
                        query.left, query.right
                    ))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let comparison: PlayerComparison = serde_json::from_slice(
            &to_bytes(response.into_body(), 64 * 1024)
                .await
                .expect("comparison body"),
        )
        .expect("player comparison");

        assert_eq!(
            comparison
                .players
                .iter()
                .map(|player| player.steam_id.as_str())
                .collect::<Vec<_>>(),
            [query.left.as_str(), query.right.as_str()]
        );
        assert_eq!(
            players
                .last_comparison
                .lock()
                .expect("comparison lock")
                .as_ref(),
            Some(&query)
        );
    }

    #[tokio::test]
    async fn player_matches_route_returns_the_exact_requested_page() {
        let players = Arc::new(FixturePlayers::new());
        let (_directory, state) = test_state(players).await;
        let response = router()
            .with_state(state)
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/players/{PLAYER_ID}/matches?page=2&page_size=20"
                    ))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let page: serde_json::Value = serde_json::from_slice(
            &to_bytes(response.into_body(), 64 * 1024)
                .await
                .expect("player matches body"),
        )
        .expect("player matches page");
        assert_eq!(page["page"], 2);
        assert_eq!(page["page_size"], 20);
        assert_eq!(page["steam_id"], "76561198000000001");
        assert_eq!(page["coverage"]["projected_demos"], 12);
        assert_eq!(page["coverage"]["total_analyses"], 12);
        assert_eq!(page["coverage"]["projection_complete"], true);
        assert_eq!(page["items"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn player_maps_route_returns_the_exact_requested_page() {
        let players = Arc::new(FixturePlayers::new());
        let (_directory, state) = test_state(players).await;
        let response = router()
            .with_state(state)
            .oneshot(
                Request::builder()
                    .uri(format!("/api/players/{PLAYER_ID}/maps?page=2&page_size=20"))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let page: serde_json::Value = serde_json::from_slice(
            &to_bytes(response.into_body(), 64 * 1024)
                .await
                .expect("player maps body"),
        )
        .expect("player maps page");
        assert_eq!(page["page"], 2);
        assert_eq!(page["page_size"], 20);
        assert_eq!(page["steam_id"], PLAYER_ID);
        assert_eq!(page["coverage"]["projected_demos"], 12);
        assert_eq!(page["coverage"]["total_analyses"], 12);
        assert_eq!(page["coverage"]["projection_complete"], true);
        assert_eq!(page["items"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn player_matches_route_rejects_missing_unknown_and_out_of_range_query_fields() {
        let players = Arc::new(FixturePlayers::new());
        let (_directory, state) = test_state(players).await;
        let dispatcher = router().with_state(state);

        for uri in [
            format!("/api/players/{PLAYER_ID}/matches?page_size=20"),
            format!("/api/players/{PLAYER_ID}/matches?page=1"),
            format!("/api/players/{PLAYER_ID}/matches?page=1&page_size=20&limit=20"),
            format!("/api/players/{PLAYER_ID}/matches?page=0&page_size=20"),
            format!("/api/players/{PLAYER_ID}/matches?page=10001&page_size=20"),
            format!("/api/players/{PLAYER_ID}/matches?page=1&page_size=0"),
            format!("/api/players/{PLAYER_ID}/matches?page=1&page_size=101"),
        ] {
            let response = dispatcher
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(uri)
                        .body(Body::empty())
                        .expect("request"),
                )
                .await
                .expect("response");
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
    }

    #[tokio::test]
    async fn player_comparison_route_rejects_missing_and_unknown_query_fields() {
        let players = Arc::new(FixturePlayers::new());
        let (_directory, state) = test_state(players).await;
        let dispatcher = router().with_state(state);

        for uri in [
            format!("/api/players/compare?left={PLAYER_ID}"),
            format!("/api/players/compare?left={PLAYER_ID}&right=76561198000000002&players=all"),
        ] {
            let response = dispatcher
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(uri)
                        .body(Body::empty())
                        .expect("request"),
                )
                .await
                .expect("response");
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
    }

    #[tokio::test]
    async fn avatar_get_and_head_return_identical_metadata() {
        let players = Arc::new(FixturePlayers::new());
        let (_directory, state) = test_state(players).await;

        let get = get_avatar(State(state.clone()), Path(PLAYER_ID.to_owned()))
            .await
            .expect("GET avatar");
        let head = head_avatar(State(state), Path(PLAYER_ID.to_owned()))
            .await
            .expect("HEAD avatar");

        for name in [
            header::CONTENT_TYPE,
            header::CONTENT_LENGTH,
            header::ETAG,
            header::LAST_MODIFIED,
            header::CACHE_CONTROL,
            header::X_CONTENT_TYPE_OPTIONS,
            AVATAR_CACHE_HEADER,
        ] {
            assert_eq!(get.headers().get(&name), head.headers().get(&name));
        }
        assert_eq!(get.headers()[header::CONTENT_TYPE], "image/jpeg");
        assert_eq!(get.headers()[header::CONTENT_LENGTH], "14");
        assert_eq!(get.headers()[AVATAR_CACHE_HEADER], "hit");
        assert_eq!(
            to_bytes(get.into_body(), 1024).await.expect("GET body"),
            &b"fixture-avatar"[..]
        );
        assert!(
            to_bytes(head.into_body(), 1024)
                .await
                .expect("HEAD body")
                .is_empty()
        );
    }
}
