mod activity;
mod agent_sessions;
mod analysis_runs;
mod annotations;
mod cosmetics;
mod demos;
mod evidence;
mod integrations;
mod lineups;
mod media;
pub(crate) mod outputs;
mod players;
mod product;
mod proposals;
pub(crate) mod recording;
mod recording_presets;
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
        .merge(activity::router())
        .merge(agent_sessions::router())
        .merge(analysis_runs::router())
        .merge(annotations::router())
        .merge(system::router())
        .merge(cosmetics::router())
        .merge(demos::router())
        .merge(evidence::router())
        .merge(recording::router())
        .merge(recording_presets::router())
        .merge(review::router())
        .merge(source_assets::router())
        .merge(media::router())
        .merge(outputs::router())
        .merge(players::router())
        .merge(proposals::router())
        .merge(product::router())
        .merge(integrations::router())
        .merge(lineups::router())
        .route("/api/events", get(system::events))
        .route("/api/{*path}", any(not_found))
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
