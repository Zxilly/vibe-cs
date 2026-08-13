use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use chrono::Utc;
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;
use vibe_cs_application::{
    CosmeticCatalogDto, CosmeticCatalogItemDto, CosmeticImageOutput, CosmeticPaintKitDto,
    CosmeticRewriteOutput, CosmeticsPort,
};
use vibe_cs_cosmetics::{
    BackendError, CosmeticInspectionReport, RewriteError, RewriteLimits, RewriteRequest,
    inspect_demo, rewrite_demo,
};
use vibe_cs_demo::{ParseCancellation, ValidationLimits, validate_demo};
use vibe_cs_domain::{DemoRecord, DemoStatus, DomainError};
use vibe_cs_integrations::discover_paths;
use vibe_cs_source_assets::{CosmeticCatalog, CosmeticCatalogCategory, Cs2AssetStore};

const MAXIMUM_COSMETIC_DEMO_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct RuntimeCosmeticsPort {
    storage: vibe_cs_storage::Storage,
    data_dir: PathBuf,
    limits: RewriteLimits,
    catalog_cache: Arc<RwLock<Option<CosmeticAssetCache>>>,
    catalog_generation: Arc<Mutex<()>>,
}

#[derive(Debug, Clone)]
struct CosmeticAssetCache {
    installation_root: PathBuf,
    locale: String,
    store: Arc<Cs2AssetStore>,
    catalog: Arc<CosmeticCatalog>,
}

impl RuntimeCosmeticsPort {
    #[must_use]
    pub fn new(storage: vibe_cs_storage::Storage, data_dir: PathBuf) -> Self {
        Self {
            storage,
            data_dir,
            limits: RewriteLimits {
                max_input_bytes: MAXIMUM_COSMETIC_DEMO_BYTES,
                max_output_bytes: MAXIMUM_COSMETIC_DEMO_BYTES,
                ..RewriteLimits::default()
            },
            catalog_cache: Arc::new(RwLock::new(None)),
            catalog_generation: Arc::new(Mutex::new(())),
        }
    }

    async fn cosmetic_assets(&self) -> Result<CosmeticAssetCache, DomainError> {
        let config = self
            .storage
            .get_config()
            .await
            .map_err(|error| {
                DomainError::Internal(format!("unable to load configuration: {error}"))
            })?
            .unwrap_or_default();
        let executable = discover_paths(&config).cs2.ok_or_else(|| {
            DomainError::DependencyUnavailable("CS2 executable was not found".to_owned())
        })?;
        let installation_root =
            installation_root_from_executable(&executable).ok_or_else(|| {
                DomainError::DependencyUnavailable(format!(
                    "CS2 installation root could not be resolved from {}",
                    executable.display()
                ))
            })?;
        let locale = config.locale;
        if let Some(cached) = self.catalog_cache.read().await.as_ref()
            && cached.installation_root == installation_root
            && cached.locale == locale
        {
            return Ok(cached.clone());
        }
        let _generation = self.catalog_generation.lock().await;
        if let Some(cached) = self.catalog_cache.read().await.as_ref()
            && cached.installation_root == installation_root
            && cached.locale == locale
        {
            return Ok(cached.clone());
        }
        let root = installation_root.clone();
        let catalog_locale = locale.clone();
        let (store, catalog) = tokio::task::spawn_blocking(move || {
            let store = Arc::new(Cs2AssetStore::open(root)?);
            let catalog = Arc::new(store.cosmetic_catalog_for_locale(&catalog_locale)?);
            Ok::<_, vibe_cs_source_assets::SourceAssetError>((store, catalog))
        })
        .await
        .map_err(|error| DomainError::Internal(format!("cosmetic catalog task failed: {error}")))?
        .map_err(|error| DomainError::DependencyUnavailable(error.to_string()))?;
        let cached = CosmeticAssetCache {
            installation_root,
            locale,
            store,
            catalog,
        };
        *self.catalog_cache.write().await = Some(cached.clone());
        Ok(cached)
    }

    async fn rewrite_inner(
        &self,
        source: DemoRecord,
        request: RewriteRequest,
    ) -> Result<CosmeticRewriteOutput, DomainError> {
        request.validate(&self.limits).map_err(map_rewrite_error)?;
        let output_directory = self.data_dir.join("cosmetics");
        tokio::fs::create_dir_all(&output_directory)
            .await
            .map_err(|error| DomainError::Internal(error.to_string()))?;
        let managed_root = tokio::fs::canonicalize(&self.data_dir)
            .await
            .map_err(|error| DomainError::Internal(error.to_string()))?;
        let output_directory = tokio::fs::canonicalize(&output_directory)
            .await
            .map_err(|error| DomainError::Internal(error.to_string()))?;
        if !output_directory.starts_with(&managed_root) {
            return Err(DomainError::Conflict(
                "cosmetic output directory resolves outside the application data directory"
                    .to_owned(),
            ));
        }
        let output = managed_output_path(&output_directory, &source);
        let input = PathBuf::from(&source.path);
        let limits = self.limits;
        let rewrite_request = request.clone();
        let rewrite_input = input.clone();
        let rewrite_output = output.clone();
        let report = match tokio::task::spawn_blocking(move || {
            rewrite_demo(rewrite_input, rewrite_output, &rewrite_request, &limits)
        })
        .await
        {
            Ok(Ok(report)) => report,
            Ok(Err(error)) => return Err(map_rewrite_error(error)),
            Err(error) => {
                cleanup_managed_output(&output).await;
                return Err(DomainError::Internal(format!(
                    "cosmetic rewrite task failed: {error}"
                )));
            }
        };

        let validation_output = output.clone();
        let validated = match tokio::task::spawn_blocking(move || {
            validate_demo(
                &validation_output,
                ValidationLimits {
                    minimum_bytes: 16,
                    maximum_bytes: MAXIMUM_COSMETIC_DEMO_BYTES,
                },
                &ParseCancellation::default(),
            )
        })
        .await
        {
            Ok(Ok(validated)) => validated,
            Ok(Err(error)) => {
                cleanup_managed_output(&output).await;
                return Err(DomainError::Internal(format!(
                    "rewritten demo failed validation: {error}"
                )));
            }
            Err(error) => {
                cleanup_managed_output(&output).await;
                return Err(DomainError::Internal(format!(
                    "rewritten demo validation task failed: {error}"
                )));
            }
        };

        let demo =
            match record_from_rewrite(&source, &validated.path, validated.size, validated.sha256) {
                Ok(demo) => demo,
                Err(error) => {
                    cleanup_managed_output(&output).await;
                    return Err(error);
                }
            };
        let (inserted, duplicates) = match self.storage.put_unique_demos(vec![demo.clone()]).await {
            Ok(result) => result,
            Err(error) => {
                cleanup_managed_output(&output).await;
                return Err(DomainError::Internal(error.to_string()));
            }
        };
        if inserted.len() != 1 || !duplicates.is_empty() {
            cleanup_managed_output(&output).await;
            return Err(DomainError::Conflict(
                "rewritten demo content is already registered".to_owned(),
            ));
        }

        Ok(CosmeticRewriteOutput { demo, report })
    }
}

#[async_trait]
impl CosmeticsPort for RuntimeCosmeticsPort {
    async fn catalog(&self) -> Result<CosmeticCatalogDto, DomainError> {
        let assets = self.cosmetic_assets().await?;
        Ok(catalog_dto(&assets.catalog))
    }

    async fn image(
        &self,
        item_definition_index: u16,
        paint_kit: u32,
    ) -> Result<CosmeticImageOutput, DomainError> {
        let assets = self.cosmetic_assets().await?;
        let path = assets
            .catalog
            .image_path(item_definition_index, paint_kit)
            .ok_or_else(|| DomainError::NotFound("cosmetic inventory image".to_owned()))?
            .to_owned();
        let store = Arc::clone(&assets.store);
        let image = tokio::task::spawn_blocking(move || store.cosmetic_image(&path))
            .await
            .map_err(|error| DomainError::Internal(format!("cosmetic image task failed: {error}")))?
            .map_err(|error| DomainError::Internal(error.to_string()))?;
        Ok(CosmeticImageOutput {
            mime_type: image.mime_type.to_owned(),
            bytes: image.bytes,
        })
    }

    async fn inspect(&self, demo: DemoRecord) -> Result<CosmeticInspectionReport, DomainError> {
        let input = PathBuf::from(demo.path);
        let limits = self.limits;
        tokio::task::spawn_blocking(move || inspect_demo(input, &limits))
            .await
            .map_err(|error| {
                DomainError::Internal(format!("cosmetic inspection task failed: {error}"))
            })?
            .map_err(map_rewrite_error)
    }

    async fn rewrite(
        &self,
        demo: DemoRecord,
        request: RewriteRequest,
    ) -> Result<CosmeticRewriteOutput, DomainError> {
        self.rewrite_inner(demo, request).await
    }
}

fn installation_root_from_executable(executable: &Path) -> Option<PathBuf> {
    let executable = std::fs::canonicalize(executable).ok()?;
    executable
        .ancestors()
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("game"))
        })
        .and_then(Path::parent)
        .map(Path::to_path_buf)
}

fn catalog_dto(catalog: &CosmeticCatalog) -> CosmeticCatalogDto {
    CosmeticCatalogDto {
        items: catalog
            .items
            .iter()
            .map(|item| CosmeticCatalogItemDto {
                item_definition_index: item.item_definition_index,
                internal_name: item.internal_name.clone(),
                display_name: item.display_name.clone(),
                category: match item.category {
                    CosmeticCatalogCategory::Weapon => "weapon",
                    CosmeticCatalogCategory::Knife => "knife",
                    CosmeticCatalogCategory::Gloves => "gloves",
                    CosmeticCatalogCategory::Agent => "agent",
                    CosmeticCatalogCategory::Equipment => "equipment",
                }
                .to_owned(),
                base_image_available: item.base_image_path.is_some(),
                paint_kit_ids: item.paint_kit_ids.clone(),
            })
            .collect(),
        paint_kits: catalog
            .paint_kits
            .iter()
            .map(|paint| CosmeticPaintKitDto {
                id: paint.id,
                internal_name: paint.internal_name.clone(),
                display_name: paint.display_name.clone(),
                wear_min: paint.wear_min,
                wear_max: paint.wear_max,
                compatible_item_definition_indices: paint.image_paths.keys().copied().collect(),
            })
            .collect(),
    }
}

fn managed_output_path(directory: &Path, source: &DemoRecord) -> PathBuf {
    let mut stem = source
        .file_name
        .strip_suffix(".dem")
        .unwrap_or(&source.file_name)
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .take(80)
        .collect::<String>();
    if stem.trim_matches('-').is_empty() {
        "demo".clone_into(&mut stem);
    }
    directory.join(format!("{stem}-cosmetics-{}.dem", Uuid::new_v4()))
}

fn record_from_rewrite(
    source: &DemoRecord,
    path: &Path,
    file_size: u64,
    sha256: String,
) -> Result<DemoRecord, DomainError> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| DomainError::Internal("managed output file name is invalid".to_owned()))?
        .to_owned();
    let now = Utc::now();
    Ok(DemoRecord {
        id: Uuid::new_v4(),
        path: path.to_string_lossy().into_owned(),
        file_name,
        display_name: format!("{} · 饰品版本", source.display_name),
        source: "cosmetics".to_owned(),
        status: DemoStatus::Discovered,
        map_name: source.map_name.clone(),
        match_date: source.match_date,
        duration_seconds: source.duration_seconds,
        total_rounds: source.total_rounds,
        team_a_name: source.team_a_name.clone(),
        team_b_name: source.team_b_name.clone(),
        team_a_score: source.team_a_score,
        team_b_score: source.team_b_score,
        player_names: source.player_names.clone(),
        remark: "由受控饰品字段重写生成，源文件保持不变。".to_owned(),
        content_sha256: Some(sha256),
        file_size,
        created_at: now,
        updated_at: now,
    })
}

async fn cleanup_managed_output(path: &Path) {
    if let Err(error) = tokio::fs::remove_file(path).await
        && error.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(%error, path = %path.display(), "unable to clean up cosmetic output");
    }
}

fn map_rewrite_error(error: RewriteError) -> DomainError {
    match error {
        RewriteError::InvalidRequest { .. }
        | RewriteError::PathNotAbsolute { .. }
        | RewriteError::InvalidExtension { .. }
        | RewriteError::InvalidMagic { .. }
        | RewriteError::MalformedEnvelope { .. }
        | RewriteError::LimitExceeded { .. }
        | RewriteError::NoMatchingFields => DomainError::InvalidInput(error.to_string()),
        RewriteError::SameInputAndOutput { .. } | RewriteError::OutputAlreadyExists { .. } => {
            DomainError::Conflict(error.to_string())
        }
        RewriteError::Backend(BackendError::LimitExceeded {
            kind,
            limit,
            observed,
        }) => DomainError::InvalidInput(
            RewriteError::LimitExceeded {
                kind,
                limit,
                observed,
            }
            .to_string(),
        ),
        RewriteError::Backend(BackendError::Stream(message)) => DomainError::InvalidInput(message),
        RewriteError::Io { .. } | RewriteError::Backend(BackendError::Io(_)) => {
            DomainError::Internal(error.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use std::collections::BTreeMap;

    fn source_record(file_name: &str) -> DemoRecord {
        let now = Utc::now();
        DemoRecord {
            id: Uuid::new_v4(),
            path: format!("C:/matches/{file_name}"),
            file_name: file_name.to_owned(),
            display_name: "决赛".to_owned(),
            source: "local".to_owned(),
            status: DemoStatus::Ready,
            map_name: Some("de_mirage".to_owned()),
            match_date: None,
            duration_seconds: Some(1200.0),
            total_rounds: Some(24),
            team_a_name: None,
            team_b_name: None,
            team_a_score: Some(13),
            team_b_score: Some(11),
            player_names: Vec::new(),
            remark: String::new(),
            content_sha256: None,
            file_size: 100,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn managed_output_is_new_and_stays_in_the_cosmetics_directory() {
        let directory = PathBuf::from("C:/vibe-cs-data/cosmetics");
        let path = managed_output_path(&directory, &source_record("../../bad name.dem"));
        assert_eq!(path.parent(), Some(directory.as_path()));
        assert_eq!(
            path.extension().and_then(|value| value.to_str()),
            Some("dem")
        );
        assert!(
            path.file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.contains("cosmetics"))
        );
    }

    #[test]
    fn rewritten_record_keeps_match_metadata_but_gets_a_new_identity() {
        let source = source_record("match.dem");
        let output = PathBuf::from("C:/vibe-cs-data/cosmetics/match-new.dem");
        let rewritten =
            record_from_rewrite(&source, &output, 120, "a".repeat(64)).expect("rewritten record");
        assert_ne!(rewritten.id, source.id);
        assert_eq!(rewritten.map_name, source.map_name);
        assert_eq!(rewritten.source, "cosmetics");
        assert_eq!(rewritten.status, DemoStatus::Discovered);
        assert_eq!(rewritten.path, output.to_string_lossy());
    }

    #[test]
    fn rewrite_limits_keep_files_within_validation_budget() {
        let limits = RewriteLimits {
            max_input_bytes: MAXIMUM_COSMETIC_DEMO_BYTES,
            max_output_bytes: MAXIMUM_COSMETIC_DEMO_BYTES,
            ..RewriteLimits::default()
        };
        assert_eq!(limits.max_input_bytes, MAXIMUM_COSMETIC_DEMO_BYTES);
        limits.validate().expect("limits");
    }

    #[test]
    fn catalog_transport_keeps_local_names_compatibility_and_ranges() {
        let catalog = CosmeticCatalog {
            items: vec![vibe_cs_source_assets::CosmeticCatalogItem {
                item_definition_index: 7,
                internal_name: "weapon_ak47".to_owned(),
                display_name: "AK-47".to_owned(),
                category: CosmeticCatalogCategory::Weapon,
                base_image_path: None,
                paint_kit_ids: vec![600],
            }],
            paint_kits: vec![vibe_cs_source_assets::CosmeticPaintKit {
                id: 600,
                internal_name: "test_finish".to_owned(),
                display_name: "Test Finish".to_owned(),
                wear_min: 0.06,
                wear_max: 0.8,
                image_paths: BTreeMap::from([(7, "safe".to_owned())]),
            }],
        };
        let dto = catalog_dto(&catalog);
        assert_eq!(dto.items[0].category, "weapon");
        assert_eq!(dto.items[0].paint_kit_ids, vec![600]);
        assert_eq!(
            dto.paint_kits[0].compatible_item_definition_indices,
            vec![7]
        );
        assert!((dto.paint_kits[0].wear_min - 0.06).abs() < f32::EPSILON);
    }
}
