use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::get,
};
use uuid::Uuid;
use vibe_cs_domain::{
    CreateEvidenceAnnotation, EvidenceAnnotation, EvidenceAnnotationQuery, Page,
    UpdateEvidenceAnnotation,
};
use vibe_cs_storage::EvidenceAnnotationCreate;

use crate::{ApiError, ApiJson, ApiQuery, ApiResult, AppState};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/evidence/annotations",
            get(list_annotations).post(create_annotation),
        )
        .route(
            "/api/evidence/annotations/{id}",
            axum::routing::patch(update_annotation).delete(delete_annotation),
        )
}

async fn list_annotations(
    State(state): State<AppState>,
    ApiQuery(query): ApiQuery<EvidenceAnnotationQuery>,
) -> ApiResult<Json<Page<EvidenceAnnotation>>> {
    Ok(Json(state.storage.list_evidence_annotations(query).await?))
}

async fn create_annotation(
    State(state): State<AppState>,
    ApiJson(draft): ApiJson<CreateEvidenceAnnotation>,
) -> ApiResult<(StatusCode, Json<EvidenceAnnotation>)> {
    match state.storage.create_evidence_annotation(draft).await? {
        EvidenceAnnotationCreate::Created(annotation) => {
            Ok((StatusCode::CREATED, Json(annotation)))
        }
        EvidenceAnnotationCreate::EvidenceNotFound => Err(ApiError::not_found("evidence")),
        EvidenceAnnotationCreate::EvidenceLocationMismatch => Err(ApiError::invalid(
            "annotation round and tick must match the canonical evidence locator",
        )),
    }
}

async fn update_annotation(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    ApiJson(update): ApiJson<UpdateEvidenceAnnotation>,
) -> ApiResult<Json<EvidenceAnnotation>> {
    state
        .storage
        .update_evidence_annotation(id, update)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("evidence annotation"))
}

async fn delete_annotation(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    if state.storage.delete_evidence_annotation(id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("evidence annotation"))
    }
}
