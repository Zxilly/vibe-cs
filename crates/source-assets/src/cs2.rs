use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
};

use same_file::Handle;

use crate::{RadarTransform, Result, SourceAssetError, VpkArchive, VpkLimits, parse_overview_text};

const MAX_MAP_NAME_LENGTH: usize = 128;
const MAX_RADAR_OVERVIEW_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum RadarResourceKind {
    OverviewText,
    RadarDds,
    RadarPng,
    RadarVtex,
    LowerRadarDds,
    LowerRadarPng,
    LowerRadarVtex,
    SpectatorDds,
    SpectatorPng,
    SpectatorVtex,
    PanoramaPng,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RadarResourceOrigin {
    LooseFile {
        path: PathBuf,
    },
    VpkEntry {
        directory_path: PathBuf,
        virtual_path: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RadarResourceDescriptor {
    pub kind: RadarResourceKind,
    pub virtual_path: String,
    pub size: u64,
    pub crc32: Option<u32>,
    pub origin: RadarResourceOrigin,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RadarOverviewLocation {
    pub map_name: String,
    pub resources: Vec<RadarResourceDescriptor>,
}

impl RadarOverviewLocation {
    pub fn has_overview_text(&self) -> bool {
        self.resources
            .iter()
            .any(|resource| resource.kind == RadarResourceKind::OverviewText)
    }

    pub fn has_radar_image(&self) -> bool {
        self.resources
            .iter()
            .any(|resource| resource.kind != RadarResourceKind::OverviewText)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RadarResource {
    pub descriptor: RadarResourceDescriptor,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RadarOverview {
    pub map_name: String,
    pub resources: Vec<RadarResource>,
}

impl RadarOverview {
    pub fn get(&self, kind: RadarResourceKind) -> Option<&RadarResource> {
        self.resources
            .iter()
            .find(|resource| resource.descriptor.kind == kind)
    }

    pub fn radar_transform(&self) -> Result<RadarTransform> {
        let text = self
            .get(RadarResourceKind::OverviewText)
            .ok_or_else(|| SourceAssetError::OverviewTextNotFound(self.map_name.clone()))?;
        parse_overview_text(&text.bytes)
    }

    pub fn select_display_resource(&self) -> Option<RadarDisplayResource<'_>> {
        select_display_resource(&self.resources)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RadarDisplayResource<'a> {
    pub resource: &'a RadarResource,
    pub mime_type: &'static str,
    pub browser_displayable: bool,
}

pub fn select_display_resource(resources: &[RadarResource]) -> Option<RadarDisplayResource<'_>> {
    let resource = resources
        .iter()
        .filter_map(|resource| {
            if matches!(
                resource.descriptor.kind,
                RadarResourceKind::PanoramaPng
                    | RadarResourceKind::RadarPng
                    | RadarResourceKind::LowerRadarPng
                    | RadarResourceKind::SpectatorPng
            ) && !resource.bytes.starts_with(b"\x89PNG\r\n\x1a\n")
            {
                return None;
            }
            display_priority(resource.descriptor.kind).map(|rank| (rank, resource))
        })
        .min_by_key(|(rank, _)| *rank)?
        .1;
    let (mime_type, browser_displayable) = match resource.descriptor.kind {
        RadarResourceKind::PanoramaPng
        | RadarResourceKind::RadarPng
        | RadarResourceKind::LowerRadarPng
        | RadarResourceKind::SpectatorPng => ("image/png", true),
        RadarResourceKind::RadarDds
        | RadarResourceKind::LowerRadarDds
        | RadarResourceKind::SpectatorDds => ("image/vnd-ms.dds", false),
        RadarResourceKind::RadarVtex
        | RadarResourceKind::LowerRadarVtex
        | RadarResourceKind::SpectatorVtex => ("application/octet-stream", false),
        RadarResourceKind::OverviewText => return None,
    };
    Some(RadarDisplayResource {
        resource,
        mime_type,
        browser_displayable,
    })
}

const fn display_priority(kind: RadarResourceKind) -> Option<u8> {
    match kind {
        RadarResourceKind::PanoramaPng => Some(0),
        RadarResourceKind::RadarPng => Some(1),
        RadarResourceKind::LowerRadarPng => Some(2),
        RadarResourceKind::SpectatorPng => Some(3),
        RadarResourceKind::RadarDds => Some(4),
        RadarResourceKind::LowerRadarDds => Some(5),
        RadarResourceKind::SpectatorDds => Some(6),
        RadarResourceKind::RadarVtex => Some(7),
        RadarResourceKind::LowerRadarVtex => Some(8),
        RadarResourceKind::SpectatorVtex => Some(9),
        RadarResourceKind::OverviewText => None,
    }
}

#[derive(Debug)]
pub struct Cs2AssetStore {
    installation_root: PathBuf,
    content_root: PathBuf,
    package: Option<VpkArchive>,
    limits: VpkLimits,
}

impl Cs2AssetStore {
    pub fn open(installation_root: impl AsRef<Path>) -> Result<Self> {
        Self::open_with_limits(installation_root, VpkLimits::default())
    }

    pub fn open_with_limits(
        installation_root: impl AsRef<Path>,
        limits: VpkLimits,
    ) -> Result<Self> {
        let requested_root = installation_root.as_ref().to_path_buf();
        let installation_root = fs::canonicalize(&requested_root)
            .map_err(|error| SourceAssetError::io(&requested_root, error))?;
        let content_root = find_content_root(&installation_root)
            .ok_or(SourceAssetError::Cs2ContentNotFound(requested_root))?;
        let package_path = content_root.join("pak01_dir.vpk");
        let package = match fs::metadata(&package_path) {
            Ok(metadata) if metadata.is_file() => {
                Some(VpkArchive::open_with_limits(&package_path, limits)?)
            }
            Ok(_) => {
                return Err(SourceAssetError::io(
                    &package_path,
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "pak01_dir.vpk is not a regular file",
                    ),
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(SourceAssetError::io(&package_path, error)),
        };
        Ok(Self {
            installation_root,
            content_root,
            package,
            limits,
        })
    }

    pub fn installation_root(&self) -> &Path {
        &self.installation_root
    }

    pub fn content_root(&self) -> &Path {
        &self.content_root
    }

    pub fn package(&self) -> Option<&VpkArchive> {
        self.package.as_ref()
    }

    pub fn locate_radar_overview(&self, map_name: &str) -> Result<RadarOverviewLocation> {
        let map_name = normalize_map_name(map_name)?;
        let mut resources = Vec::new();
        for (kind, virtual_path) in radar_candidates(&map_name) {
            if let Some(descriptor) = self.locate_loose(kind, &virtual_path)? {
                resources.push(descriptor);
                continue;
            }
            if let Some(package) = &self.package
                && let Some(entry) = package.entry(&virtual_path)?
            {
                resources.push(RadarResourceDescriptor {
                    kind,
                    virtual_path: entry.path().to_owned(),
                    size: entry.total_size(),
                    crc32: Some(entry.crc32()),
                    origin: RadarResourceOrigin::VpkEntry {
                        directory_path: package.directory_path().to_path_buf(),
                        virtual_path: entry.path().to_owned(),
                    },
                });
            }
        }
        if resources.is_empty() {
            return Err(SourceAssetError::RadarOverviewNotFound(map_name));
        }
        Ok(RadarOverviewLocation {
            map_name,
            resources,
        })
    }

    pub fn extract_radar_overview(&self, map_name: &str) -> Result<RadarOverview> {
        let location = self.locate_radar_overview(map_name)?;
        enforce_radar_aggregate_size(&location.resources, MAX_RADAR_OVERVIEW_BYTES)?;
        let mut resources = Vec::with_capacity(location.resources.len());
        let mut extracted_bytes = 0_u64;
        for descriptor in location.resources {
            let bytes = match &descriptor.origin {
                RadarResourceOrigin::LooseFile { path } => {
                    self.read_loose_file(path, extracted_bytes, MAX_RADAR_OVERVIEW_BYTES)?
                }
                RadarResourceOrigin::VpkEntry { virtual_path, .. } => self
                    .package
                    .as_ref()
                    .ok_or_else(|| SourceAssetError::EntryNotFound(virtual_path.clone()))?
                    .read(virtual_path)?,
            };
            extracted_bytes = checked_radar_aggregate_size(
                extracted_bytes,
                u64::try_from(bytes.len()).unwrap_or(u64::MAX),
                MAX_RADAR_OVERVIEW_BYTES,
            )?;
            resources.push(RadarResource { descriptor, bytes });
        }
        Ok(RadarOverview {
            map_name: location.map_name,
            resources,
        })
    }

    fn locate_loose(
        &self,
        kind: RadarResourceKind,
        virtual_path: &str,
    ) -> Result<Option<RadarResourceDescriptor>> {
        let candidate = virtual_path
            .split('/')
            .fold(self.content_root.clone(), |path, component| {
                path.join(component)
            });
        let canonical = match fs::canonicalize(&candidate) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(SourceAssetError::io(&candidate, error)),
        };
        self.ensure_inside_content(&canonical)?;
        let metadata =
            fs::metadata(&canonical).map_err(|error| SourceAssetError::io(&canonical, error))?;
        if !metadata.is_file() {
            return Err(SourceAssetError::io(
                &canonical,
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "radar resource is not a regular file",
                ),
            ));
        }
        enforce_resource_size(metadata.len(), self.limits.max_entry_size)?;
        Ok(Some(RadarResourceDescriptor {
            kind,
            virtual_path: virtual_path.to_owned(),
            size: metadata.len(),
            crc32: None,
            origin: RadarResourceOrigin::LooseFile { path: canonical },
        }))
    }

    fn read_loose_file(&self, path: &Path, consumed: u64, aggregate_limit: u64) -> Result<Vec<u8>> {
        let canonical =
            fs::canonicalize(path).map_err(|error| SourceAssetError::io(path, error))?;
        self.ensure_inside_content(&canonical)?;
        let file = open_loose_read_only(&canonical)
            .map_err(|error| SourceAssetError::io(&canonical, error))?;
        let mut opened_handle =
            Handle::from_file(file).map_err(|error| SourceAssetError::io(&canonical, error))?;
        let opened_metadata = opened_handle
            .as_file()
            .metadata()
            .map_err(|error| SourceAssetError::io(&canonical, error))?;
        if !opened_metadata.is_file() {
            return Err(changed_resource_error(&canonical));
        }
        let opened_path = fs::canonicalize(&canonical)
            .map_err(|error| SourceAssetError::io(&canonical, error))?;
        self.ensure_inside_content(&opened_path)?;
        let path_handle = Handle::from_path(&opened_path)
            .map_err(|error| SourceAssetError::io(&opened_path, error))?;
        if opened_path != canonical || opened_handle != path_handle {
            return Err(changed_resource_error(&canonical));
        }
        let length = opened_metadata.len();
        enforce_resource_size(length, self.limits.max_entry_size)?;
        checked_radar_aggregate_size(consumed, length, aggregate_limit)?;
        let remaining =
            aggregate_limit
                .checked_sub(consumed)
                .ok_or(SourceAssetError::ArithmeticOverflow(
                    "radar overview remaining budget",
                ))?;
        let bounded_length = self
            .limits
            .max_entry_size
            .min(remaining)
            .checked_add(1)
            .ok_or(SourceAssetError::ArithmeticOverflow("loose resource limit"))?;
        let mut bytes = Vec::new();
        opened_handle
            .as_file_mut()
            .take(bounded_length)
            .read_to_end(&mut bytes)
            .map_err(|error| SourceAssetError::io(&canonical, error))?;
        enforce_resource_size(
            u64::try_from(bytes.len()).unwrap_or(u64::MAX),
            self.limits.max_entry_size,
        )?;
        checked_radar_aggregate_size(
            consumed,
            u64::try_from(bytes.len()).unwrap_or(u64::MAX),
            aggregate_limit,
        )?;
        let final_metadata = opened_handle
            .as_file()
            .metadata()
            .map_err(|error| SourceAssetError::io(&canonical, error))?;
        let final_path = fs::canonicalize(&canonical)
            .map_err(|error| SourceAssetError::io(&canonical, error))?;
        self.ensure_inside_content(&final_path)?;
        let final_path_handle = Handle::from_path(&final_path)
            .map_err(|error| SourceAssetError::io(&final_path, error))?;
        if final_path != canonical
            || opened_handle != final_path_handle
            || final_metadata.len() != length
            || u64::try_from(bytes.len()).unwrap_or(u64::MAX) != length
        {
            return Err(changed_resource_error(&canonical));
        }
        Ok(bytes)
    }

    fn ensure_inside_content(&self, path: &Path) -> Result<()> {
        if path == self.content_root || path.starts_with(&self.content_root) {
            return Ok(());
        }
        Err(SourceAssetError::ResourceOutsideContent(path.to_path_buf()))
    }
}

#[cfg(windows)]
fn open_loose_read_only(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;

    // Allow other readers, but deny concurrent writers and replacement while this handle is open.
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
}

#[cfg(not(windows))]
fn open_loose_read_only(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

fn changed_resource_error(path: &Path) -> SourceAssetError {
    SourceAssetError::io(
        path,
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "radar resource changed while it was being opened or read",
        ),
    )
}

fn find_content_root(installation_root: &Path) -> Option<PathBuf> {
    [
        installation_root.join("game/csgo"),
        installation_root.join("csgo"),
        installation_root.to_path_buf(),
    ]
    .into_iter()
    .filter_map(|candidate| fs::canonicalize(candidate).ok())
    .filter(|candidate| candidate == installation_root || candidate.starts_with(installation_root))
    .find(|candidate| {
        candidate.join("pak01_dir.vpk").is_file() || candidate.join("resource/overviews").is_dir()
    })
}

fn normalize_map_name(map_name: &str) -> Result<String> {
    if map_name.is_empty()
        || map_name.len() > MAX_MAP_NAME_LENGTH
        || !map_name.is_ascii()
        || !map_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(SourceAssetError::InvalidMapName(map_name.to_owned()));
    }
    Ok(map_name.to_ascii_lowercase())
}

fn radar_candidates(map_name: &str) -> [(RadarResourceKind, String); 12] {
    [
        (
            RadarResourceKind::OverviewText,
            format!("resource/overviews/{map_name}.txt"),
        ),
        (
            RadarResourceKind::RadarDds,
            format!("resource/overviews/{map_name}_radar.dds"),
        ),
        (
            RadarResourceKind::RadarPng,
            format!("resource/overviews/{map_name}_radar.png"),
        ),
        (
            RadarResourceKind::LowerRadarDds,
            format!("resource/overviews/{map_name}_lower_radar.dds"),
        ),
        (
            RadarResourceKind::LowerRadarPng,
            format!("resource/overviews/{map_name}_lower_radar.png"),
        ),
        (
            RadarResourceKind::SpectatorDds,
            format!("resource/overviews/{map_name}_radar_spectate.dds"),
        ),
        (
            RadarResourceKind::SpectatorPng,
            format!("resource/overviews/{map_name}_radar_spectate.png"),
        ),
        (
            RadarResourceKind::PanoramaPng,
            format!("panorama/images/overheadmaps/{map_name}_radar.png"),
        ),
        (
            RadarResourceKind::RadarVtex,
            format!("panorama/images/overheadmaps/{map_name}_radar.vtex_c"),
        ),
        (
            RadarResourceKind::RadarVtex,
            format!("panorama/images/overheadmaps/{map_name}_radar_psd.vtex_c"),
        ),
        (
            RadarResourceKind::LowerRadarVtex,
            format!("panorama/images/overheadmaps/{map_name}_lower_radar.vtex_c"),
        ),
        (
            RadarResourceKind::SpectatorVtex,
            format!("panorama/images/overheadmaps/{map_name}_radar_spectate.vtex_c"),
        ),
    ]
}

fn enforce_resource_size(actual: u64, limit: u64) -> Result<()> {
    if actual > limit {
        return Err(SourceAssetError::LimitExceeded {
            kind: "radar resource",
            actual,
            limit,
        });
    }
    Ok(())
}

fn enforce_radar_aggregate_size(resources: &[RadarResourceDescriptor], limit: u64) -> Result<()> {
    resources.iter().try_fold(0_u64, |total, resource| {
        checked_radar_aggregate_size(total, resource.size, limit)
    })?;
    Ok(())
}

fn checked_radar_aggregate_size(consumed: u64, additional: u64, limit: u64) -> Result<u64> {
    let actual = consumed
        .checked_add(additional)
        .ok_or(SourceAssetError::ArithmeticOverflow(
            "radar overview aggregate size",
        ))?;
    if actual > limit {
        return Err(SourceAssetError::LimitExceeded {
            kind: "radar overview aggregate",
            actual,
            limit,
        });
    }
    Ok(actual)
}

#[cfg(test)]
mod tests {
    use std::{fs, io::Cursor};

    use tempfile::tempdir;

    use super::*;
    use crate::{
        SourceAssetError,
        test_support::{TestEntry, TestLocation, write_vpk},
    };

    #[test]
    fn locates_and_extracts_radar_resources_from_a_cs2_installation() {
        let installation = tempdir().expect("create installation root");
        let content_root = installation.path().join("game/csgo");
        fs::create_dir_all(&content_root).expect("create content root");
        write_vpk(
            &content_root.join("pak01_dir.vpk"),
            &[
                TestEntry::new(
                    "resource/overviews/de_safe.txt",
                    b"\"pos_x\" ",
                    b"\"100\"",
                    TestLocation::Inline,
                ),
                TestEntry::new(
                    "resource/overviews/de_safe_radar.dds",
                    b"DDS ",
                    b"radar",
                    TestLocation::External(1),
                ),
                TestEntry::new(
                    "panorama/images/overheadmaps/de_safe_radar.png",
                    b"\x89PNG",
                    b"panorama",
                    TestLocation::Inline,
                ),
                TestEntry::new(
                    "panorama/images/overheadmaps/de_safe_radar.vtex_c",
                    b"VTEX",
                    b"compiled",
                    TestLocation::External(1),
                ),
            ],
        );

        let store = Cs2AssetStore::open(installation.path()).expect("open asset store");
        assert_eq!(store.content_root(), content_root.canonicalize().unwrap());
        let location = store
            .locate_radar_overview("DE_SAFE")
            .expect("locate overview");
        assert_eq!(location.map_name, "de_safe");
        assert!(location.has_overview_text());
        assert!(location.has_radar_image());
        assert_eq!(location.resources.len(), 4);
        assert!(
            location
                .resources
                .iter()
                .all(|resource| matches!(resource.origin, RadarResourceOrigin::VpkEntry { .. }))
        );

        let overview = store
            .extract_radar_overview("de_safe")
            .expect("extract overview");
        assert_eq!(
            overview
                .get(RadarResourceKind::OverviewText)
                .expect("overview text")
                .bytes,
            b"\"pos_x\" \"100\""
        );
        assert_eq!(
            overview
                .get(RadarResourceKind::RadarDds)
                .expect("radar DDS")
                .bytes,
            b"DDS radar"
        );
        assert_eq!(
            overview
                .get(RadarResourceKind::PanoramaPng)
                .expect("panorama PNG")
                .bytes,
            b"\x89PNGpanorama"
        );
        assert_eq!(
            overview
                .get(RadarResourceKind::RadarVtex)
                .expect("compiled radar texture")
                .bytes,
            b"VTEXcompiled"
        );
    }

    #[test]
    fn loose_radar_resources_override_packaged_resources() {
        let installation = tempdir().expect("create installation root");
        let content_root = installation.path().join("game/csgo");
        let overview_root = content_root.join("resource/overviews");
        fs::create_dir_all(&overview_root).expect("create overview root");
        write_vpk(
            &content_root.join("pak01_dir.vpk"),
            &[TestEntry::new(
                "resource/overviews/de_safe.txt",
                b"",
                b"packaged",
                TestLocation::Inline,
            )],
        );
        fs::write(overview_root.join("de_safe.txt"), b"loose").expect("write loose overview");

        let store = Cs2AssetStore::open(installation.path()).expect("open asset store");
        let location = store
            .locate_radar_overview("de_safe")
            .expect("locate overview");
        assert!(matches!(
            location.resources[0].origin,
            RadarResourceOrigin::LooseFile { .. }
        ));
        assert_eq!(
            store
                .extract_radar_overview("de_safe")
                .expect("extract overview")
                .resources[0]
                .bytes,
            b"loose"
        );
    }

    #[test]
    fn rejects_unsafe_map_names_missing_assets_and_oversized_loose_files() {
        let installation = tempdir().expect("create installation root");
        let overview_root = installation.path().join("game/csgo/resource/overviews");
        fs::create_dir_all(&overview_root).expect("create overview root");
        let store = Cs2AssetStore::open(installation.path()).expect("open loose asset store");
        for invalid in ["", "../de_safe", "de/safe", "C:map", "dé_safe"] {
            assert!(matches!(
                store.locate_radar_overview(invalid),
                Err(SourceAssetError::InvalidMapName(_))
            ));
        }
        assert!(matches!(
            store.locate_radar_overview("de_missing"),
            Err(SourceAssetError::RadarOverviewNotFound(_))
        ));

        fs::write(overview_root.join("de_large.txt"), b"12345").expect("write large overview");
        let store = Cs2AssetStore::open_with_limits(
            installation.path(),
            VpkLimits {
                max_entry_size: 4,
                ..VpkLimits::default()
            },
        )
        .expect("open bounded store");
        assert!(matches!(
            store.locate_radar_overview("de_large"),
            Err(SourceAssetError::LimitExceeded {
                kind: "radar resource",
                actual: 5,
                limit: 4
            })
        ));
    }

    #[test]
    fn rejects_aggregate_radar_resources_before_loading_them() {
        let resources = [
            RadarResourceDescriptor {
                kind: RadarResourceKind::OverviewText,
                virtual_path: "resource/overviews/de_safe.txt".to_owned(),
                size: 40,
                crc32: None,
                origin: RadarResourceOrigin::LooseFile {
                    path: PathBuf::from("de_safe.txt"),
                },
            },
            RadarResourceDescriptor {
                kind: RadarResourceKind::RadarVtex,
                virtual_path: "panorama/images/overheadmaps/de_safe_radar.vtex_c".to_owned(),
                size: 25,
                crc32: None,
                origin: RadarResourceOrigin::LooseFile {
                    path: PathBuf::from("de_safe_radar.vtex_c"),
                },
            },
        ];
        assert!(matches!(
            enforce_radar_aggregate_size(&resources, 64),
            Err(SourceAssetError::LimitExceeded {
                kind: "radar overview aggregate",
                actual: 65,
                limit: 64,
            })
        ));
    }

    #[test]
    fn file_handle_identity_distinguishes_same_sized_resources() {
        let directory = tempdir().expect("create identity test directory");
        let left = directory.path().join("left.bin");
        let right = directory.path().join("right.bin");
        fs::write(&left, b"same").expect("write left resource");
        fs::write(&right, b"same").expect("write right resource");
        let left_handle = Handle::from_path(&left).expect("left handle");
        let alias_handle =
            Handle::from_file(File::open(&left).expect("left alias")).expect("left alias handle");
        let right_handle = Handle::from_path(right).expect("right handle");
        assert_eq!(left_handle, alias_handle);
        assert_ne!(left_handle, right_handle);
    }

    #[test]
    fn loose_reads_enforce_remaining_aggregate_budget() {
        let installation = tempdir().expect("create installation root");
        let overview_root = installation.path().join("game/csgo/resource/overviews");
        fs::create_dir_all(&overview_root).expect("create overview root");
        let resource = overview_root.join("de_budget.txt");
        fs::write(&resource, b"12345").expect("write resource");
        let store = Cs2AssetStore::open(installation.path()).expect("open asset store");
        assert!(matches!(
            store.read_loose_file(&resource, 60, 64),
            Err(SourceAssetError::LimitExceeded {
                kind: "radar overview aggregate",
                actual: 65,
                limit: 64,
            })
        ));
    }

    #[test]
    fn selects_browser_resources_before_dds_and_vtex_without_mime_spoofing() {
        let resources = [
            radar_resource(RadarResourceKind::RadarVtex),
            radar_resource(RadarResourceKind::RadarDds),
            radar_resource(RadarResourceKind::SpectatorPng),
            radar_resource(RadarResourceKind::PanoramaPng),
        ];
        let selected = select_display_resource(&resources).expect("select PNG");
        assert_eq!(
            selected.resource.descriptor.kind,
            RadarResourceKind::PanoramaPng
        );
        assert_eq!(selected.mime_type, "image/png");
        assert!(selected.browser_displayable);

        let selected = select_display_resource(&resources[..2]).expect("select DDS");
        assert_eq!(
            selected.resource.descriptor.kind,
            RadarResourceKind::RadarDds
        );
        assert_eq!(selected.mime_type, "image/vnd-ms.dds");
        assert!(!selected.browser_displayable);

        let invalid_png = RadarResource {
            bytes: b"not a PNG".to_vec(),
            ..radar_resource(RadarResourceKind::PanoramaPng)
        };
        let invalid_resources = [invalid_png, radar_resource(RadarResourceKind::RadarDds)];
        let selected = select_display_resource(&invalid_resources).expect("ignore spoofed PNG");
        assert_eq!(
            selected.resource.descriptor.kind,
            RadarResourceKind::RadarDds
        );

        let selected = select_display_resource(&resources[..1]).expect("select VTEX");
        assert_eq!(
            selected.resource.descriptor.kind,
            RadarResourceKind::RadarVtex
        );
        assert_eq!(selected.mime_type, "application/octet-stream");
        assert!(!selected.browser_displayable);
        assert!(
            select_display_resource(&[radar_resource(RadarResourceKind::OverviewText)]).is_none()
        );
    }

    #[test]
    #[ignore = "requires VIBE_CS2_INSTALL to point at a local CS2 installation"]
    fn opens_real_cs2_radar_assets_read_only() {
        let installation = std::env::var_os("VIBE_CS2_INSTALL")
            .map(PathBuf::from)
            .expect("set VIBE_CS2_INSTALL");
        let store = Cs2AssetStore::open(installation).expect("open real CS2 assets");
        assert!(!store.package().expect("main package").is_empty());
        let location = store
            .locate_radar_overview("de_dust2")
            .expect("locate de_dust2 radar");
        for resource in &location.resources {
            eprintln!(
                "{:?} {} {} bytes",
                resource.kind, resource.virtual_path, resource.size
            );
        }
        assert!(location.has_radar_image());
        let extracted = store
            .extract_radar_overview("de_dust2")
            .expect("verify and extract de_dust2 radar");
        assert!(!extracted.resources.is_empty());
        let transform = extracted
            .radar_transform()
            .expect("parse de_dust2 overview transform");
        assert!(transform.scale > 0.0);
        let display = extracted
            .select_display_resource()
            .expect("select de_dust2 radar source");
        let decoded = crate::decode_vtex_to_browser_image(&display.resource.bytes)
            .expect("decode de_dust2 compiled radar");
        assert_eq!((decoded.width, decoded.height), (1_024, 1_024));
        assert_eq!(decoded.mime_type, "image/png");
        assert!(decoded.bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        let mut png = png::Decoder::new(Cursor::new(&decoded.bytes))
            .read_info()
            .expect("read generated radar PNG");
        let mut pixels = vec![
            0;
            png.output_buffer_size()
                .expect("bounded generated PNG output")
        ];
        let frame = png
            .next_frame(&mut pixels)
            .expect("decode generated radar PNG");
        assert_eq!((frame.width, frame.height), (1_024, 1_024));
        assert!(
            pixels[..frame.buffer_size()]
                .chunks_exact(4)
                .any(|pixel| pixel[..3] != [0, 0, 0])
        );
        assert_eq!(display.mime_type, "application/octet-stream");
        assert!(!display.browser_displayable);
    }

    fn radar_resource(kind: RadarResourceKind) -> RadarResource {
        RadarResource {
            descriptor: RadarResourceDescriptor {
                kind,
                virtual_path: "resource/overviews/test".to_owned(),
                size: 1,
                crc32: None,
                origin: RadarResourceOrigin::LooseFile {
                    path: PathBuf::from("resource/overviews/test"),
                },
            },
            bytes: if matches!(
                kind,
                RadarResourceKind::PanoramaPng
                    | RadarResourceKind::RadarPng
                    | RadarResourceKind::LowerRadarPng
                    | RadarResourceKind::SpectatorPng
            ) {
                b"\x89PNG\r\n\x1a\n".to_vec()
            } else {
                vec![0]
            },
        }
    }
}
