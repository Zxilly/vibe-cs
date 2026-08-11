mod cosmetics;
mod demos;
mod integrations;
mod media;
mod obs_tuning;
mod outputs;
mod players;
mod product;
mod proposals;
mod recording;
mod review;
mod source_assets;
mod system;

use axum::{
    Router,
    http::StatusCode,
    routing::{any, get},
};

use crate::{ApiError, AppState};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .merge(system::router())
        .merge(cosmetics::router())
        .merge(demos::router())
        .merge(recording::router())
        .merge(review::router())
        .merge(source_assets::router())
        .merge(media::router())
        .merge(obs_tuning::router())
        .merge(outputs::router())
        .merge(players::router())
        .merge(proposals::router())
        .merge(product::router())
        .merge(integrations::router())
        .route("/api/v1/events", get(system::events))
        .route("/api/v1/{*path}", any(not_found))
}

pub(crate) fn gsi_router() -> Router<AppState> {
    integrations::gsi_router()
}

pub(crate) async fn not_found() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "route_not_found",
        "API route was not found",
    )
}
