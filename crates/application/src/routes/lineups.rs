use axum::{
    Json, Router,
    extract::{Path, State},
    routing::get,
};
use serde::Deserialize;
use vibe_cs_storage::{LineupDirectoryPage, LineupDirectoryQuery, LineupMapPage, StorageError};

use crate::{ApiError, ApiQuery, ApiResult, AppState};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/lineups", get(list_lineups))
        .route("/api/lineups/{lineup_id}/maps", get(list_lineup_maps))
}

async fn list_lineups(
    State(state): State<AppState>,
    ApiQuery(query): ApiQuery<LineupDirectoryQuery>,
) -> ApiResult<Json<LineupDirectoryPage>> {
    state
        .storage
        .list_lineups(query)
        .await
        .map(Json)
        .map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LineupMapQuery {
    page: u32,
    page_size: u32,
}

async fn list_lineup_maps(
    State(state): State<AppState>,
    Path(lineup_id): Path<String>,
    ApiQuery(query): ApiQuery<LineupMapQuery>,
) -> ApiResult<Json<LineupMapPage>> {
    state
        .storage
        .list_lineup_maps(lineup_id, query.page, query.page_size)
        .await
        .map(Json)
        .map_err(storage_error)
}

fn storage_error(error: StorageError) -> ApiError {
    match error {
        StorageError::Domain(error) => error.into(),
        other => other.into(),
    }
}
