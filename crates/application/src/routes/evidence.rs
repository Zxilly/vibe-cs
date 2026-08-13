use axum::{Json, Router, extract::State, routing::get};
use vibe_cs_domain::{EvidenceSearchPage, EvidenceSearchQuery};

use crate::{ApiQuery, ApiResult, AppState};

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/api/evidence/search", get(search))
}

async fn search(
    State(state): State<AppState>,
    ApiQuery(query): ApiQuery<EvidenceSearchQuery>,
) -> ApiResult<Json<EvidenceSearchPage>> {
    query.validate()?;
    state
        .storage
        .search_evidence(query)
        .await
        .map(Json)
        .map_err(Into::into)
}
