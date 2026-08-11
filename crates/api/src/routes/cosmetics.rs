use axum::{
    Json, Router,
    extract::{Path as AxumPath, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use vibe_cs_cosmetics::{
    CosmeticInspectionReport, CosmeticPatch, RewriteLimits, RewriteReport, RewriteRequest,
};
use vibe_cs_domain::{CosmeticPlan, DemoRecord};

use crate::{ApiError, ApiJson, ApiResult, AppState};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/cosmetics/catalog", get(cosmetic_catalog))
        .route(
            "/api/v1/cosmetics/catalog/items/{item_definition_index}/paint-kits/{paint_kit}/image",
            get(cosmetic_image),
        )
        .route("/api/v1/demos/{id}/cosmetics", get(inspect_cosmetics))
        .route(
            "/api/v1/demos/{id}/cosmetics/rewrite",
            post(rewrite_cosmetics),
        )
        .route(
            "/api/v1/demos/{id}/cosmetics/plans",
            get(list_cosmetic_plans).post(create_cosmetic_plan),
        )
        .route(
            "/api/v1/demos/{id}/cosmetics/plans/{plan_id}",
            put(update_cosmetic_plan).delete(delete_cosmetic_plan),
        )
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CosmeticPlanBody {
    name: String,
    patches: Vec<CosmeticPatch>,
}

async fn list_cosmetic_plans(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<Vec<CosmeticPlan>>> {
    let demo = registered_demo(&state, &id).await?;
    Ok(Json(state.storage.list_cosmetic_plans(demo.id).await?))
}

async fn create_cosmetic_plan(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    ApiJson(body): ApiJson<CosmeticPlanBody>,
) -> ApiResult<(StatusCode, Json<CosmeticPlan>)> {
    let demo = registered_demo(&state, &id).await?;
    let (name, patches) = validated_plan_body(body)?;
    let now = Utc::now();
    let plan = state
        .storage
        .put_cosmetic_plan(CosmeticPlan {
            id: Uuid::new_v4(),
            demo_id: demo.id,
            name,
            patches,
            created_at: now,
            updated_at: now,
        })
        .await?;
    Ok((StatusCode::CREATED, Json(plan)))
}

async fn update_cosmetic_plan(
    State(state): State<AppState>,
    AxumPath((id, plan_id)): AxumPath<(String, String)>,
    ApiJson(body): ApiJson<CosmeticPlanBody>,
) -> ApiResult<Json<CosmeticPlan>> {
    let demo = registered_demo(&state, &id).await?;
    let plan_id = parsed_uuid(&plan_id, "cosmetic plan id")?;
    let current = state
        .storage
        .get_cosmetic_plan(plan_id)
        .await?
        .filter(|plan| plan.demo_id == demo.id)
        .ok_or_else(|| ApiError::not_found("cosmetic plan"))?;
    let (name, patches) = validated_plan_body(body)?;
    Ok(Json(
        state
            .storage
            .put_cosmetic_plan(CosmeticPlan {
                name,
                patches,
                updated_at: Utc::now(),
                ..current
            })
            .await?,
    ))
}

async fn delete_cosmetic_plan(
    State(state): State<AppState>,
    AxumPath((id, plan_id)): AxumPath<(String, String)>,
) -> ApiResult<StatusCode> {
    let demo = registered_demo(&state, &id).await?;
    let plan_id = parsed_uuid(&plan_id, "cosmetic plan id")?;
    let current = state
        .storage
        .get_cosmetic_plan(plan_id)
        .await?
        .filter(|plan| plan.demo_id == demo.id)
        .ok_or_else(|| ApiError::not_found("cosmetic plan"))?;
    if state.storage.delete_cosmetic_plan(current.id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("cosmetic plan"))
    }
}

fn validated_plan_body(body: CosmeticPlanBody) -> ApiResult<(String, serde_json::Value)> {
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(ApiError::invalid(
            "cosmetic plan name must contain 1 to 80 characters",
        ));
    }
    RewriteRequest {
        patches: body.patches.clone(),
    }
    .validate(&RewriteLimits::default())
    .map_err(|error| ApiError::invalid(error.to_string()))?;
    let patches = serde_json::to_value(body.patches).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "serialization_failed",
            error.to_string(),
        )
    })?;
    Ok((name.to_owned(), patches))
}

fn parsed_uuid(value: &str, label: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(value).map_err(|_| ApiError::invalid(format!("{label} must be a UUID")))
}

async fn cosmetic_catalog(
    State(state): State<AppState>,
) -> ApiResult<Json<crate::CosmeticCatalogDto>> {
    Ok(Json(state.cosmetics.catalog().await?))
}

async fn cosmetic_image(
    State(state): State<AppState>,
    AxumPath((item_definition_index, paint_kit)): AxumPath<(u16, u32)>,
) -> ApiResult<Response> {
    let image = state
        .cosmetics
        .image(item_definition_index, paint_kit)
        .await?;
    Ok((
        [
            (header::CONTENT_TYPE, image.mime_type),
            (
                header::CACHE_CONTROL,
                "private, max-age=86400, immutable".to_owned(),
            ),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
        ],
        image.bytes,
    )
        .into_response())
}

async fn inspect_cosmetics(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<CosmeticInspectionReport>> {
    let demo = registered_demo(&state, &id).await?;
    Ok(Json(state.cosmetics.inspect(demo).await?))
}

#[derive(Debug, Serialize)]
struct CosmeticRewriteResponse {
    demo: DemoRecord,
    report: RewriteReport,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CosmeticRewriteBody {
    confirm_new_file: bool,
    patches: Vec<CosmeticPatch>,
}

async fn rewrite_cosmetics(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    ApiJson(request): ApiJson<CosmeticRewriteBody>,
) -> ApiResult<(StatusCode, Json<CosmeticRewriteResponse>)> {
    if !request.confirm_new_file {
        return Err(ApiError::invalid(
            "confirm_new_file must be true because rewriting creates a separate managed demo",
        ));
    }
    let demo = registered_demo(&state, &id).await?;
    let output = state
        .cosmetics
        .rewrite(
            demo,
            RewriteRequest {
                patches: request.patches,
            },
        )
        .await?;
    state
        .events
        .publish("demo", "created", Some(output.demo.id));
    Ok((
        StatusCode::CREATED,
        Json(CosmeticRewriteResponse {
            demo: output.demo,
            report: output.report,
        }),
    ))
}

async fn registered_demo(state: &AppState, id: &str) -> ApiResult<DemoRecord> {
    let id = parsed_uuid(id, "demo id")?;
    state
        .storage
        .get_demo(id)
        .await?
        .ok_or_else(|| ApiError::not_found("demo"))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use async_trait::async_trait;
    use chrono::Utc;
    use vibe_cs_cosmetics::{
        CosmeticInspectionReport, CosmeticPatch, CosmeticTarget, CosmeticValues, RewriteReport,
        RewriteRequest, StablePlayerIdentity,
    };
    use vibe_cs_domain::{DemoRecord, DemoStatus, DomainError};

    use super::*;
    use crate::{CosmeticRewriteOutput, CosmeticsPort, build_router};

    #[derive(Debug)]
    struct FixtureCosmetics {
        rewritten: DemoRecord,
    }

    #[async_trait]
    impl CosmeticsPort for FixtureCosmetics {
        async fn catalog(&self) -> Result<crate::CosmeticCatalogDto, DomainError> {
            Ok(crate::CosmeticCatalogDto {
                items: Vec::new(),
                paint_kits: Vec::new(),
            })
        }

        async fn image(
            &self,
            _item_definition_index: u16,
            _paint_kit: u32,
        ) -> Result<crate::CosmeticImageOutput, DomainError> {
            Ok(crate::CosmeticImageOutput {
                mime_type: "image/png".to_owned(),
                bytes: b"fixture".to_vec(),
            })
        }

        async fn inspect(&self, demo: DemoRecord) -> Result<CosmeticInspectionReport, DomainError> {
            Ok(CosmeticInspectionReport {
                input_path: demo.path.into(),
                input_bytes: demo.file_size,
                demo_messages: 8,
                entity_updates: 4,
                distinct_entities: 2,
                items: Vec::new(),
            })
        }

        async fn rewrite(
            &self,
            demo: DemoRecord,
            _request: RewriteRequest,
        ) -> Result<CosmeticRewriteOutput, DomainError> {
            Ok(CosmeticRewriteOutput {
                demo: self.rewritten.clone(),
                report: RewriteReport {
                    input_path: demo.path.into(),
                    output_path: self.rewritten.path.clone().into(),
                    input_bytes: demo.file_size,
                    output_bytes: self.rewritten.file_size,
                    demo_messages: 1,
                    rewrite: vibe_cs_cosmetics::BackendReport {
                        entity_updates: 1,
                        distinct_entities: 1,
                        patches: Vec::new(),
                    },
                },
            })
        }
    }

    fn demo(path: &str) -> DemoRecord {
        let now = Utc::now();
        DemoRecord {
            id: Uuid::new_v4(),
            path: path.to_owned(),
            file_name: "match.dem".to_owned(),
            display_name: "Match".to_owned(),
            source: "local".to_owned(),
            status: DemoStatus::Ready,
            map_name: None,
            match_date: None,
            duration_seconds: None,
            total_rounds: None,
            team_a_name: None,
            team_b_name: None,
            team_a_score: None,
            team_b_score: None,
            remark: String::new(),
            content_sha256: None,
            file_size: 16,
            created_at: now,
            updated_at: now,
        }
    }

    async fn start_app() -> (tempfile::TempDir, DemoRecord, std::net::SocketAddr) {
        let directory = tempfile::tempdir().expect("temp directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let source = demo("C:/fixtures/match.dem");
        storage.put_demo(source.clone()).await.expect("put source");
        let rewritten = demo("C:/data/cosmetics/match-edited.dem");
        let state = AppState::new(storage, directory.path().to_path_buf()).with_cosmetics(
            Arc::new(FixtureCosmetics {
                rewritten: rewritten.clone(),
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        tokio::spawn(async move { axum::serve(listener, build_router(state)).await });
        (directory, source, address)
    }

    #[tokio::test]
    async fn inspection_requires_a_registered_demo_id() {
        let (_directory, _source, address) = start_app().await;
        let response = reqwest::get(format!(
            "http://{address}/api/v1/demos/{}/cosmetics",
            Uuid::new_v4()
        ))
        .await
        .expect("request");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn inspection_and_rewrite_use_the_registered_record() {
        let (_directory, source, address) = start_app().await;
        let inspected = reqwest::get(format!(
            "http://{address}/api/v1/demos/{}/cosmetics",
            source.id
        ))
        .await
        .expect("inspect");
        assert_eq!(inspected.status(), StatusCode::OK);

        let identity =
            StablePlayerIdentity::new(76_561_197_960_389_184, 123_456).expect("identity");
        let response = reqwest::Client::new()
            .post(format!(
                "http://{address}/api/v1/demos/{}/cosmetics/rewrite",
                source.id
            ))
            .json(&serde_json::json!({
                "confirm_new_file": true,
                "patches": vec![CosmeticPatch {
                    target: CosmeticTarget {
                        owner: identity,
                        item_definition_index: Some(7),
                    },
                    values: CosmeticValues {
                        paint_kit: Some(600),
                        ..CosmeticValues::default()
                    },
                }]
            }))
            .send()
            .await
            .expect("rewrite");
        assert_eq!(response.status(), StatusCode::CREATED);
        let body = response.text().await.expect("body");
        assert!(body.contains("match-edited.dem"));
    }

    #[tokio::test]
    async fn rewrite_requires_explicit_new_file_confirmation() {
        let (_directory, source, address) = start_app().await;
        let response = reqwest::Client::new()
            .post(format!(
                "http://{address}/api/v1/demos/{}/cosmetics/rewrite",
                source.id
            ))
            .json(&serde_json::json!({
                "confirm_new_file": false,
                "patches": []
            }))
            .send()
            .await
            .expect("rewrite");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn catalog_and_inventory_image_are_exposed_with_safe_content_types() {
        let (_directory, _source, address) = start_app().await;
        let catalog = reqwest::get(format!("http://{address}/api/v1/cosmetics/catalog"))
            .await
            .expect("catalog");
        assert_eq!(catalog.status(), StatusCode::OK);
        assert_eq!(
            catalog.json::<serde_json::Value>().await.expect("json"),
            serde_json::json!({"items": [], "paint_kits": []})
        );

        let image = reqwest::get(format!(
            "http://{address}/api/v1/cosmetics/catalog/items/7/paint-kits/600/image"
        ))
        .await
        .expect("image");
        assert_eq!(image.status(), StatusCode::OK);
        assert_eq!(
            image.headers().get(reqwest::header::CONTENT_TYPE),
            Some(&reqwest::header::HeaderValue::from_static("image/png"))
        );
        assert_eq!(image.bytes().await.expect("bytes"), b"fixture"[..]);
    }

    #[tokio::test]
    async fn cosmetic_plans_are_scoped_to_the_registered_demo() {
        let (_directory, source, address) = start_app().await;
        let identity =
            StablePlayerIdentity::new(76_561_197_960_389_184, 123_456).expect("identity");
        let body = serde_json::json!({
            "name": "AK collection",
            "patches": [{
                "target": {
                    "owner": identity,
                    "item_definition_index": 7
                },
                "values": {"paint_kit": 600}
            }]
        });
        let client = reqwest::Client::new();
        let created = client
            .post(format!(
                "http://{address}/api/v1/demos/{}/cosmetics/plans",
                source.id
            ))
            .json(&body)
            .send()
            .await
            .expect("create");
        assert_eq!(created.status(), StatusCode::CREATED);
        let created = created.json::<CosmeticPlan>().await.expect("created plan");

        let listed = reqwest::get(format!(
            "http://{address}/api/v1/demos/{}/cosmetics/plans",
            source.id
        ))
        .await
        .expect("list")
        .json::<Vec<CosmeticPlan>>()
        .await
        .expect("plans");
        assert_eq!(listed, vec![created.clone()]);

        let mut updated_body = body;
        updated_body["name"] = serde_json::json!("Final loadout");
        let updated = client
            .put(format!(
                "http://{address}/api/v1/demos/{}/cosmetics/plans/{}",
                source.id, created.id
            ))
            .json(&updated_body)
            .send()
            .await
            .expect("update");
        assert_eq!(updated.status(), StatusCode::OK);
        assert_eq!(
            updated
                .json::<CosmeticPlan>()
                .await
                .expect("updated plan")
                .name,
            "Final loadout"
        );

        let deleted = client
            .delete(format!(
                "http://{address}/api/v1/demos/{}/cosmetics/plans/{}",
                source.id, created.id
            ))
            .send()
            .await
            .expect("delete");
        assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
    }
}
