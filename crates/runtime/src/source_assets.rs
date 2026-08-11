use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use tokio::sync::{Mutex, RwLock};
use vibe_cs_api::{RadarImageData, RadarOverviewData, RadarTransformData, SourceAssetPort};
use vibe_cs_domain::DomainError;
use vibe_cs_integrations::discover_paths;
use vibe_cs_source_assets::{
    Cs2AssetStore, RadarOverview, RadarResourceKind, SourceAssetError, decode_vtex_to_browser_image,
};

const MAXIMUM_CACHED_RADARS: usize = 16;
const MAXIMUM_RADAR_CACHE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Default)]
struct AssetStoreCache {
    installation_root: Option<PathBuf>,
    store: Option<Arc<Cs2AssetStore>>,
    radars: HashMap<String, RadarOverviewData>,
    radar_order: VecDeque<String>,
    radar_bytes: usize,
}

#[derive(Debug, Clone)]
pub struct RuntimeSourceAssetPort {
    storage: vibe_cs_storage::Storage,
    cache: Arc<RwLock<AssetStoreCache>>,
    radar_generation: Arc<Mutex<()>>,
}

impl RuntimeSourceAssetPort {
    #[must_use]
    pub fn new(storage: vibe_cs_storage::Storage) -> Self {
        Self {
            storage,
            cache: Arc::new(RwLock::new(AssetStoreCache::default())),
            radar_generation: Arc::new(Mutex::new(())),
        }
    }

    async fn asset_store(&self) -> Result<Arc<Cs2AssetStore>, DomainError> {
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

        {
            let cache = self.cache.read().await;
            if cache.installation_root.as_ref() == Some(&installation_root)
                && let Some(store) = &cache.store
            {
                return Ok(Arc::clone(store));
            }
        }

        let root_for_open = installation_root.clone();
        let store = tokio::task::spawn_blocking(move || Cs2AssetStore::open(root_for_open))
            .await
            .map_err(|error| DomainError::Internal(format!("asset task failed: {error}")))?
            .map_err(map_source_asset_error)?;
        let store = Arc::new(store);
        let mut cache = self.cache.write().await;
        cache.installation_root = Some(installation_root);
        cache.store = Some(Arc::clone(&store));
        cache.radars.clear();
        cache.radar_order.clear();
        cache.radar_bytes = 0;
        Ok(store)
    }

    async fn cached_radar(&self, map_name: &str) -> Option<RadarOverviewData> {
        self.cache.read().await.radars.get(map_name).cloned()
    }

    async fn cache_radar(
        &self,
        map_name: String,
        store: &Arc<Cs2AssetStore>,
        overview: RadarOverviewData,
    ) {
        let bytes = overview.image.as_ref().map_or(0, |image| image.bytes.len());
        if bytes > MAXIMUM_RADAR_CACHE_BYTES {
            return;
        }
        let mut cache = self.cache.write().await;
        if cache
            .store
            .as_ref()
            .is_none_or(|active| !Arc::ptr_eq(active, store))
        {
            return;
        }
        if let Some(previous) = cache.radars.remove(&map_name) {
            cache.radar_bytes = cache
                .radar_bytes
                .saturating_sub(previous.image.as_ref().map_or(0, |image| image.bytes.len()));
            cache.radar_order.retain(|candidate| candidate != &map_name);
        }
        while cache.radars.len() >= MAXIMUM_CACHED_RADARS
            || cache.radar_bytes.saturating_add(bytes) > MAXIMUM_RADAR_CACHE_BYTES
        {
            let Some(oldest) = cache.radar_order.pop_front() else {
                break;
            };
            if let Some(removed) = cache.radars.remove(&oldest) {
                cache.radar_bytes = cache
                    .radar_bytes
                    .saturating_sub(removed.image.as_ref().map_or(0, |image| image.bytes.len()));
            }
        }
        cache.radar_bytes = cache.radar_bytes.saturating_add(bytes);
        cache.radar_order.push_back(map_name.clone());
        cache.radars.insert(map_name, overview);
    }
}

#[async_trait]
impl SourceAssetPort for RuntimeSourceAssetPort {
    async fn radar_overview(&self, map_name: String) -> Result<RadarOverviewData, DomainError> {
        let cache_key = map_name.to_ascii_lowercase();
        let store = self.asset_store().await?;
        if let Some(cached) = self.cached_radar(&cache_key).await {
            return Ok(cached);
        }
        let _generation = self.radar_generation.lock().await;
        if let Some(cached) = self.cached_radar(&cache_key).await {
            return Ok(cached);
        }
        let extraction_store = Arc::clone(&store);
        let overview = tokio::task::spawn_blocking(move || {
            extract_radar_overview(&extraction_store, &map_name)
        })
        .await
        .map_err(|error| DomainError::Internal(format!("asset task failed: {error}")))??;
        self.cache_radar(cache_key, &store, overview.clone()).await;
        Ok(overview)
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

fn extract_radar_overview(
    store: &Cs2AssetStore,
    map_name: &str,
) -> Result<RadarOverviewData, DomainError> {
    let overview = store
        .extract_radar_overview(map_name)
        .map_err(map_source_asset_error)?;
    let transform = match overview.radar_transform() {
        Ok(transform) => Some(RadarTransformData {
            position_x: transform.pos_x,
            position_y: transform.pos_y,
            scale: transform.scale,
            rotate: transform.rotate.unwrap_or(false),
            zoom: transform.zoom,
        }),
        Err(SourceAssetError::OverviewTextNotFound(_)) => None,
        Err(error) => return Err(map_source_asset_error(error)),
    };
    let image = select_radar_image(&overview)?;
    Ok(RadarOverviewData {
        map_name: overview.map_name,
        transform,
        image,
    })
}

fn select_radar_image(overview: &RadarOverview) -> Result<Option<RadarImageData>, DomainError> {
    if let Some(display) = overview
        .select_display_resource()
        .filter(|display| display.browser_displayable)
    {
        return Ok(Some(RadarImageData {
            bytes: display.resource.bytes.clone(),
            content_type: display.mime_type.to_owned(),
            browser_displayable: true,
        }));
    }

    let mut first_decode_error = None;
    for resource in overview.resources.iter().filter(|resource| {
        matches!(
            resource.descriptor.kind,
            RadarResourceKind::RadarVtex
                | RadarResourceKind::LowerRadarVtex
                | RadarResourceKind::SpectatorVtex
        )
    }) {
        match decode_vtex_to_browser_image(&resource.bytes) {
            Ok(decoded) => {
                return Ok(Some(RadarImageData {
                    bytes: decoded.bytes,
                    content_type: decoded.mime_type.to_owned(),
                    browser_displayable: true,
                }));
            }
            Err(error @ SourceAssetError::UnsupportedCompiledTextureFormat(_)) => {
                first_decode_error.get_or_insert(error);
            }
            Err(error) => return Err(map_source_asset_error(error)),
        }
    }

    if let Some(display) = overview.select_display_resource() {
        return Ok(Some(RadarImageData {
            bytes: display.resource.bytes.clone(),
            content_type: display.mime_type.to_owned(),
            browser_displayable: false,
        }));
    }
    if let Some(error) = first_decode_error {
        return Err(map_source_asset_error(error));
    }
    Ok(None)
}

fn map_source_asset_error(error: SourceAssetError) -> DomainError {
    match error {
        SourceAssetError::InvalidMapName(map_name) => {
            DomainError::InvalidInput(format!("invalid map name: {map_name:?}"))
        }
        SourceAssetError::RadarOverviewNotFound(map_name)
        | SourceAssetError::OverviewTextNotFound(map_name) => {
            DomainError::NotFound(format!("radar overview for {map_name}"))
        }
        SourceAssetError::Cs2ContentNotFound(path) => DomainError::DependencyUnavailable(format!(
            "CS2 content directory was not found below {}",
            path.display()
        )),
        SourceAssetError::Io { path, source } => DomainError::DependencyUnavailable(format!(
            "unable to read local game asset {}: {source}",
            path.display()
        )),
        error => DomainError::Internal(format!("local game asset is invalid: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;
    use vibe_cs_domain::AppConfig;

    use super::*;

    #[tokio::test]
    async fn reads_loose_radar_assets_from_the_configured_installation() {
        let root = tempdir().expect("installation root");
        let executable = root.path().join("game/bin/win64/cs2.exe");
        let overview_dir = root.path().join("game/csgo/resource/overviews");
        fs::create_dir_all(executable.parent().expect("executable parent")).expect("bin tree");
        fs::create_dir_all(&overview_dir).expect("overview tree");
        fs::write(&executable, b"stub").expect("executable");
        fs::write(
            overview_dir.join("de_safe.txt"),
            br#""de_safe" { "pos_x" "-2048" "pos_y" "3072" "scale" "4" }"#,
        )
        .expect("overview text");
        fs::write(
            overview_dir.join("de_safe_radar.png"),
            b"\x89PNG\r\n\x1a\nfixture",
        )
        .expect("radar image");

        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        storage
            .put_config(AppConfig {
                cs2_path: executable.to_string_lossy().into_owned(),
                ..AppConfig::default()
            })
            .await
            .expect("config");
        let port = RuntimeSourceAssetPort::new(storage);
        let overview = port
            .radar_overview("DE_SAFE".to_owned())
            .await
            .expect("radar overview");

        assert_eq!(overview.map_name, "de_safe");
        assert!((overview.transform.as_ref().expect("transform").scale - 4.0).abs() < f64::EPSILON);
        let image = overview.image.as_ref().expect("image");
        assert_eq!(image.content_type, "image/png");
        assert!(image.browser_displayable);
        assert_eq!(image.bytes, b"\x89PNG\r\n\x1a\nfixture");

        fs::remove_file(overview_dir.join("de_safe.txt")).expect("remove overview source");
        fs::remove_file(overview_dir.join("de_safe_radar.png")).expect("remove radar source");
        let cached = port
            .radar_overview("de_safe".to_owned())
            .await
            .expect("cached radar overview");
        assert_eq!(cached, overview);
    }

    #[test]
    fn resolves_the_installation_above_the_nearest_game_directory() {
        let root = tempdir().expect("installation root");
        let executable = root.path().join("game/bin/win64/cs2.exe");
        fs::create_dir_all(executable.parent().expect("parent")).expect("bin tree");
        fs::write(&executable, b"stub").expect("executable");

        assert_eq!(
            installation_root_from_executable(&executable),
            Some(root.path().canonicalize().expect("canonical root"))
        );
    }
}
