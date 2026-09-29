use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use cap_std::fs::Dir;
use sha2::{Digest, Sha256};
use vibe_cs_application::{MapGeometryCacheState, MapGeometryData, MapGeometryStatus};
use vibe_cs_domain::DomainError;
use vibe_cs_source_assets::{
    Cs2AssetStore, VpkArchive, decode_map_geometry, encode_map_geometry, extract_world_geometry,
};

use super::map_source_asset_error;
use crate::cache_directory::{
    capability_metadata_is_reparse, ensure_cache_directory_mapping, initialize_cache_directory,
    open_verified_plain_file, remove_verified_file, write_atomic,
};

const MAPS: [&str; 8] = [
    "de_mirage",
    "de_dust2",
    "de_inferno",
    "de_nuke",
    "de_ancient",
    "de_anubis",
    "de_train",
    "de_overpass",
];
const MAX_CACHE_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug)]
pub(super) struct GeometrySource {
    map_name: String,
    package: PathBuf,
    pub key: String,
    cache_dir: PathBuf,
    cache_path: PathBuf,
    directory: Dir,
}

fn io_error(context: &str, error: impl std::fmt::Display) -> DomainError {
    DomainError::DependencyUnavailable(format!("{context}: {error}"))
}

fn fingerprint(path: &Path) -> Result<String, DomainError> {
    let metadata =
        fs::metadata(path).map_err(|error| io_error("read map package metadata", error))?;
    if !metadata.is_file() {
        return Err(DomainError::InvalidInput(
            "map package is not a regular file".to_owned(),
        ));
    }
    let modified = metadata
        .modified()
        .map_err(|error| io_error("read map package modification time", error))?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| io_error("map package modification time", error))?;
    let mut hash = Sha256::new();
    // Revision covers both extraction policy and VMAP format. Rebuilding a
    // changed extractor bumps this number; obsolete files are discarded locally.
    hash.update(b"vibe-map-geometry-4\0");
    hash.update(path.to_string_lossy().as_bytes());
    hash.update(metadata.len().to_le_bytes());
    hash.update(modified.as_nanos().to_le_bytes());
    Ok(hex::encode(hash.finalize()))
}

impl GeometrySource {
    pub(super) fn open(
        store: &Cs2AssetStore,
        root: &Path,
        map_name: &str,
    ) -> Result<Self, DomainError> {
        let map_name = map_name.to_ascii_lowercase();
        let package = store
            .map_package_path(&map_name)
            .map_err(map_source_asset_error)?;
        let key = fingerprint(&package)?;
        let (root, root_directory) = initialize_cache_directory(root)?;
        match root_directory.create_dir(&map_name) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(io_error("create map cache directory", error)),
        }
        let metadata = root_directory
            .symlink_metadata(&map_name)
            .map_err(|error| io_error("inspect map cache directory", error))?;
        if !metadata.is_dir() || metadata.is_symlink() || capability_metadata_is_reparse(&metadata)
        {
            return Err(DomainError::Conflict(
                "map cache is not a plain directory".to_owned(),
            ));
        }
        let directory = root_directory
            .open_dir(&map_name)
            .map_err(|error| io_error("open map cache directory", error))?;
        let cache_dir = root.join(&map_name);
        ensure_cache_directory_mapping(&directory, &cache_dir)?;
        let cache_path = cache_dir.join(format!("{key}.vmap"));
        Ok(Self {
            map_name,
            package,
            key,
            cache_dir,
            cache_path,
            directory,
        })
    }

    fn status(&self) -> MapGeometryStatus {
        let failed = |reason| MapGeometryStatus {
            map_name: self.map_name.clone(),
            state: MapGeometryCacheState::Failed,
            bytes: None,
            reason: Some(reason),
        };
        let ready_bytes = match open_verified_plain_file(&self.directory, self.cache_name()) {
            Ok((_, metadata)) if (32..=MAX_CACHE_BYTES).contains(&metadata.len()) => {
                Some(metadata.len())
            }
            Ok(_) => {
                return failed("The cached map geometry is incomplete; regenerate it.".to_owned());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return failed(format!("The cached map geometry cannot be read: {error}"));
            }
        };
        let stale = ready_bytes.is_none()
            && self.directory.entries().is_ok_and(|entries| {
                entries
                    .take(256)
                    .flatten()
                    .any(|entry| managed_name(&entry.file_name()))
            });
        MapGeometryStatus {
            map_name: self.map_name.clone(),
            state: if ready_bytes.is_some() {
                MapGeometryCacheState::Ready
            } else if stale {
                MapGeometryCacheState::Stale
            } else {
                MapGeometryCacheState::Missing
            },
            bytes: ready_bytes,
            reason: None,
        }
    }

    fn cached(&self) -> Result<Option<Vec<u8>>, DomainError> {
        ensure_cache_directory_mapping(&self.directory, &self.cache_dir)?;
        let (mut file, metadata) =
            match open_verified_plain_file(&self.directory, self.cache_name()) {
                Ok(opened) => opened,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(io_error("read geometry cache", error)),
            };
        if metadata.len() > MAX_CACHE_BYTES {
            return Ok(None);
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(MAX_CACHE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| io_error("read geometry cache", error))?;
        if bytes.len() as u64 > MAX_CACHE_BYTES || decode_map_geometry(&bytes).is_err() {
            return Ok(None);
        }
        Ok(Some(bytes))
    }

    pub(super) fn load(&self, rebuild: bool) -> Result<MapGeometryData, DomainError> {
        if !rebuild && let Some(bytes) = self.cached()? {
            return Ok(self.data(bytes));
        }
        let package = VpkArchive::open(&self.package).map_err(map_source_asset_error)?;
        let resource = package
            .read(&format!("maps/{}/world_physics.vmdl_c", self.map_name))
            .map_err(map_source_asset_error)?;
        let geometry = extract_world_geometry(&resource).map_err(map_source_asset_error)?;
        let bytes = encode_map_geometry(&geometry).map_err(map_source_asset_error)?;
        if fingerprint(&self.package)? != self.key {
            return Err(DomainError::Conflict("CS2 updated this map while geometry was being prepared; retry with the new package".to_owned()));
        }
        ensure_cache_directory_mapping(&self.directory, &self.cache_dir)?;
        write_atomic(
            &self.directory,
            &format!("{}.vmap", self.key),
            &self.key,
            &bytes,
        )?;
        // Only generated VMAP files for this one map are retired. Keep the last
        // good cache until the replacement has been successfully published.
        if let Ok(entries) = self.directory.entries() {
            for entry in entries.take(256).flatten() {
                let name = entry.file_name();
                if name != self.cache_name()
                    && managed_name(&name)
                    && let Ok((file, _)) = open_verified_plain_file(&self.directory, &name)
                    && let Err(error) = remove_verified_file(&self.directory, &name, &file)
                {
                    tracing::warn!(%error, ?name, "unable to retire obsolete geometry cache");
                }
            }
        }
        Ok(self.data(bytes))
    }

    fn data(&self, bytes: Vec<u8>) -> MapGeometryData {
        let status = MapGeometryStatus {
            map_name: self.map_name.clone(),
            state: MapGeometryCacheState::Ready,
            bytes: Some(bytes.len() as u64),
            reason: None,
        };
        MapGeometryData { bytes, status }
    }

    fn cache_name(&self) -> &std::ffi::OsStr {
        self.cache_path
            .file_name()
            .expect("generated cache basename")
    }
}

fn managed_name(name: &std::ffi::OsStr) -> bool {
    name.to_str().is_some_and(|name| {
        name.len() == 69
            && Path::new(name)
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("vmap"))
            && name.as_bytes()[..64].iter().all(u8::is_ascii_hexdigit)
    })
}

pub(super) fn statuses(
    store: &Cs2AssetStore,
    root: &Path,
) -> Vec<(MapGeometryStatus, Option<String>)> {
    MAPS.into_iter()
        .map(
            |map_name| match GeometrySource::open(store, root, map_name) {
                Ok(source) => (source.status(), Some(source.key)),
                Err(error) => (
                    MapGeometryStatus {
                        map_name: map_name.to_owned(),
                        state: if matches!(
                            error,
                            DomainError::DependencyUnavailable(_) | DomainError::NotFound(_)
                        ) {
                            MapGeometryCacheState::Unavailable
                        } else {
                            MapGeometryCacheState::Failed
                        },
                        bytes: None,
                        reason: Some(error.to_string()),
                    },
                    None,
                ),
            },
        )
        .collect()
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;
    use std::time::{Duration, SystemTime};

    use super::*;

    fn fixture() -> (tempfile::TempDir, Cs2AssetStore, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("game/csgo/resource/overviews")).unwrap();
        fs::create_dir_all(root.path().join("game/csgo/maps")).unwrap();
        let package = root.path().join("game/csgo/maps/de_fixture.vpk");
        fs::write(
            &package,
            include_bytes!("../../../source-assets/tests/fixtures/de_fixture.vpk"),
        )
        .unwrap();
        let store = Cs2AssetStore::open(root.path()).unwrap();
        (root, store, package)
    }

    #[test]
    fn caches_real_extraction_recovers_corruption_and_retires_updated_packages() {
        let (root, store, package) = fixture();
        let cache = root.path().join("cache");
        let source = GeometrySource::open(&store, &cache, "de_fixture").unwrap();
        assert_eq!(source.status().state, MapGeometryCacheState::Missing);
        let first = source.load(false).unwrap();
        let geometry = decode_map_geometry(&first.bytes).unwrap();
        assert_eq!(
            (geometry.vertices.len(), geometry.triangles.len()),
            (28, 38)
        );
        assert_eq!(source.status().state, MapGeometryCacheState::Ready);

        let historical = UNIX_EPOCH + Duration::from_secs(1_600_000_000);
        fs::File::options()
            .write(true)
            .open(&source.cache_path)
            .unwrap()
            .set_modified(historical)
            .unwrap();
        assert_eq!(source.load(false).unwrap().bytes, first.bytes);
        assert_eq!(
            fs::metadata(&source.cache_path)
                .unwrap()
                .modified()
                .unwrap(),
            historical,
            "cache hit must not regenerate"
        );

        fs::write(&source.cache_path, b"corrupt cache").unwrap();
        assert_eq!(
            source.status().state,
            MapGeometryCacheState::Failed,
            "a broken current cache is not a game update"
        );
        assert_eq!(
            source.load(false).unwrap().bytes,
            first.bytes,
            "corrupt cache is regenerated from VPK"
        );
        let old_key = source.key.clone();
        fs::File::options()
            .write(true)
            .open(&package)
            .unwrap()
            .set_modified(SystemTime::now() + Duration::from_secs(2))
            .unwrap();
        let updated = GeometrySource::open(&store, &cache, "de_fixture").unwrap();
        assert_ne!(updated.key, old_key);
        assert_eq!(updated.status().state, MapGeometryCacheState::Stale);
        assert_eq!(updated.load(false).unwrap().bytes, first.bytes);
        assert!(
            !source.cache_path.exists(),
            "old generation retired only after publication"
        );
        assert!(updated.cache_path.exists());

        let timestamp = fs::metadata(&package).unwrap().modified().unwrap();
        fs::OpenOptions::new()
            .append(true)
            .open(&package)
            .unwrap()
            .write_all(b"certificate trailer")
            .unwrap();
        fs::File::options()
            .write(true)
            .open(&package)
            .unwrap()
            .set_modified(timestamp)
            .unwrap();
        let resized = GeometrySource::open(&store, &cache, "de_fixture").unwrap();
        assert_ne!(resized.key, updated.key, "size alone invalidates the cache");
        assert_eq!(resized.load(false).unwrap().bytes, first.bytes);
    }

    #[test]
    fn does_not_publish_an_extraction_when_the_source_fingerprint_changed() {
        let (root, store, package) = fixture();
        let cache = root.path().join("cache");
        let source = GeometrySource::open(&store, &cache, "de_fixture").unwrap();
        let original = source.load(false).unwrap().bytes;
        fs::File::options()
            .write(true)
            .open(&package)
            .unwrap()
            .set_modified(SystemTime::now() + Duration::from_secs(5))
            .unwrap();
        assert!(matches!(source.load(true), Err(DomainError::Conflict(_))));
        assert_eq!(fs::read(&source.cache_path).unwrap(), original);
        for name in ["../de_fixture", "de_fixture/other", "C:fixture", ""] {
            assert!(matches!(
                GeometrySource::open(&store, &cache, name),
                Err(DomainError::InvalidInput(_))
            ));
        }
    }

    #[cfg(windows)]
    #[test]
    fn refuses_cache_junctions_and_does_not_touch_the_external_directory() {
        let (root, store, _) = fixture();
        let cache = root.path().join("cache");
        fs::create_dir(&cache).unwrap();
        let map_cache = cache.join("de_fixture");
        let external = tempfile::tempdir().unwrap();
        let sentinel = external.path().join(format!("{}.vmap", "a".repeat(64)));
        fs::write(&sentinel, b"external user file").unwrap();
        let result = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&map_cache)
            .arg(external.path())
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(GeometrySource::open(&store, &cache, "de_fixture").is_err());
        assert_eq!(fs::read(&sentinel).unwrap(), b"external user file");
        assert_eq!(fs::read_dir(external.path()).unwrap().count(), 1);
        fs::remove_dir(&map_cache).unwrap();
    }
}
