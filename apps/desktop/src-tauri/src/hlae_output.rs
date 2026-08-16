use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read as _,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::Serialize;
use sha2::{Digest as _, Sha256};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt as _;
use vibe_cs_hlae::{
    HLAE_BUNDLE_LAUNCH_PROFILE_FILE, HLAE_BUNDLE_MANIFEST_FILE, HLAE_BUNDLE_MANIFEST_PRODUCER,
    HLAE_BUNDLE_README_FILE, HlaeBundleManifest,
};

const BOOTSTRAP_FILE: &str = "vibe_cs_hlae.cfg";
const COMMAND_FILE: &str = "vibe_cs_commands.xml";
const MAXIMUM_BUNDLES: usize = 256;
const MAXIMUM_BUNDLE_SCAN: usize = 4_096;
const MAXIMUM_BUNDLE_FILES: usize = 64;
const MAXIMUM_MANIFEST_BYTES: u64 = 64 * 1024;
const MAXIMUM_ARTIFACT_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug)]
pub(crate) struct ManagedHlaeRoot(PathBuf);

impl ManagedHlaeRoot {
    pub(crate) fn new(data_dir: &Path) -> Self {
        Self(data_dir.join("hlae-plans"))
    }
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "DesktopHlaeBundleHandoff")]
pub(crate) struct HlaeBundleHandoff {
    pub(crate) directory: String,
    pub(crate) files: Vec<String>,
    pub(crate) completion_marker: String,
    pub(crate) created_at_epoch_ms: u64,
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command injection owns State and deserialized arguments"
)]
pub(crate) fn list_hlae_bundles(
    root: State<'_, ManagedHlaeRoot>,
) -> Result<Vec<HlaeBundleHandoff>, String> {
    list_managed_hlae_bundles(&root)
}

pub(crate) fn list_managed_hlae_bundles(
    root: &ManagedHlaeRoot,
) -> Result<Vec<HlaeBundleHandoff>, String> {
    let Some(canonical_root) = canonical_managed_root(&root.0)? else {
        return Ok(Vec::new());
    };
    let entries = fs::read_dir(&canonical_root)
        .map_err(|error| format!("unable to inspect managed HLAE plans: {error}"))?;
    let mut bundles = Vec::new();
    for (index, entry) in entries.enumerate() {
        if index >= MAXIMUM_BUNDLE_SCAN {
            return Err("managed HLAE plan directory exceeds the safe scan limit".to_owned());
        }
        let entry =
            entry.map_err(|error| format!("unable to inspect managed HLAE plan: {error}"))?;
        if let Ok(bundle) = validate_bundle(&canonical_root, &entry.path()) {
            bundles.push(bundle);
        }
    }
    bundles.sort_by_key(|bundle| std::cmp::Reverse(bundle.created_at_epoch_ms));
    bundles.truncate(MAXIMUM_BUNDLES);
    Ok(bundles)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command injection owns AppHandle, State, and deserialized arguments"
)]
pub(crate) fn reveal_hlae_bundle(
    app: AppHandle,
    root: State<'_, ManagedHlaeRoot>,
    bundle_directory: String,
) -> Result<HlaeBundleHandoff, String> {
    let canonical_root = canonical_managed_root(&root.0)?
        .ok_or_else(|| "no managed HLAE bundles have been exported".to_owned())?;
    let handoff = validate_bundle(&canonical_root, Path::new(&bundle_directory))?;
    app.opener()
        .reveal_item_in_dir(&handoff.directory)
        .map_err(|error| format!("unable to reveal the managed HLAE bundle: {error}"))?;
    Ok(handoff)
}

fn canonical_managed_root(root: &Path) -> Result<Option<PathBuf>, String> {
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err("managed HLAE root is not a regular directory".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("unable to inspect managed HLAE root: {error}")),
    }
    let canonical = fs::canonicalize(root)
        .map_err(|error| format!("unable to resolve managed HLAE root: {error}"))?;
    if is_reparse_point(root)? {
        return Err("managed HLAE root cannot be a reparse point".to_owned());
    }
    Ok(Some(canonical))
}

fn validate_bundle(root: &Path, requested: &Path) -> Result<HlaeBundleHandoff, String> {
    if !requested.is_absolute() {
        return Err("HLAE bundle path must be absolute".to_owned());
    }
    let metadata = fs::symlink_metadata(requested)
        .map_err(|error| format!("unable to inspect HLAE bundle: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || is_reparse_point(requested)? {
        return Err("HLAE bundle must be a regular managed directory".to_owned());
    }
    let canonical = fs::canonicalize(requested)
        .map_err(|error| format!("unable to resolve HLAE bundle: {error}"))?;
    if canonical.parent() != Some(root) || !valid_bundle_name(&canonical) {
        return Err("HLAE bundle is outside the managed hlae-plans directory".to_owned());
    }

    let mut entries_by_name = BTreeMap::new();
    let entries = fs::read_dir(&canonical)
        .map_err(|error| format!("unable to inspect HLAE bundle files: {error}"))?;
    for entry in entries.take(MAXIMUM_BUNDLE_FILES.saturating_add(1)) {
        let entry =
            entry.map_err(|error| format!("unable to inspect HLAE bundle entry: {error}"))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("unable to inspect HLAE artifact: {error}"))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || is_reparse_point(&path)? {
            return Err("HLAE bundle contains a non-regular artifact".to_owned());
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "HLAE bundle contains a non-Unicode artifact name".to_owned())?;
        if entries_by_name
            .insert(name, (path, metadata.len()))
            .is_some()
        {
            return Err("HLAE bundle contains duplicate artifact names".to_owned());
        }
    }
    if entries_by_name.len() > MAXIMUM_BUNDLE_FILES {
        return Err("HLAE bundle contains too many artifacts".to_owned());
    }
    let marker = canonical.join(HLAE_BUNDLE_MANIFEST_FILE);
    let Some((_, marker_size)) = entries_by_name.get(HLAE_BUNDLE_MANIFEST_FILE) else {
        return Err("HLAE bundle completion manifest is missing".to_owned());
    };
    if *marker_size > MAXIMUM_MANIFEST_BYTES {
        return Err("HLAE bundle completion manifest is too large".to_owned());
    }
    let marker_contents = fs::read_to_string(&marker)
        .map_err(|error| format!("HLAE bundle completion marker is unavailable: {error}"))?;
    let manifest: HlaeBundleManifest = serde_json::from_str(&marker_contents)
        .map_err(|error| format!("HLAE bundle completion manifest is invalid: {error}"))?;
    if manifest.state != "complete" || manifest.producer != HLAE_BUNDLE_MANIFEST_PRODUCER {
        return Err("HLAE bundle completion manifest contract is unsupported".to_owned());
    }
    if manifest.artifacts.len().saturating_add(1) != entries_by_name.len() {
        return Err("HLAE bundle has missing or unmanifested artifacts".to_owned());
    }

    let mut manifested_names = BTreeSet::new();
    let mut has_bootstrap = false;
    let mut has_commands = false;
    let mut has_readme = false;
    let mut has_launch_profile = false;
    let mut camera_paths = 0_usize;
    let mut total_bytes = 0_u64;
    for artifact in &manifest.artifacts {
        if !valid_artifact_name(&artifact.path)
            || !valid_sha256(&artifact.sha256)
            || !manifested_names.insert(artifact.path.as_str())
        {
            return Err("HLAE bundle manifest contains an unsafe or duplicate artifact".to_owned());
        }
        has_bootstrap |= artifact.path == BOOTSTRAP_FILE;
        has_commands |= artifact.path == COMMAND_FILE;
        has_readme |= artifact.path == HLAE_BUNDLE_README_FILE;
        has_launch_profile |= artifact.path == HLAE_BUNDLE_LAUNCH_PROFILE_FILE;
        camera_paths += usize::from(valid_camera_name(&artifact.path));
        let Some((path, actual_size)) = entries_by_name.get(&artifact.path) else {
            return Err("HLAE bundle manifest references a missing artifact".to_owned());
        };
        if artifact.size != *actual_size || artifact.size > MAXIMUM_ARTIFACT_BYTES {
            return Err("HLAE bundle artifact size does not match its manifest".to_owned());
        }
        total_bytes = total_bytes
            .checked_add(artifact.size)
            .filter(|total| *total <= MAXIMUM_ARTIFACT_BYTES)
            .ok_or_else(|| "HLAE bundle artifacts exceed the verification budget".to_owned())?;
        if hash_regular_file(path, artifact.size)? != artifact.sha256 {
            return Err("HLAE bundle artifact hash does not match its manifest".to_owned());
        }
    }
    if !has_bootstrap || !has_commands || !has_readme || !has_launch_profile || camera_paths == 0 {
        return Err("HLAE bundle manifest is missing required fixed artifacts".to_owned());
    }
    let mut files = entries_by_name
        .into_values()
        .map(|(path, _)| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    files.sort();
    let created_at_epoch_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .and_then(|value| u64::try_from(value.as_millis()).ok())
        .unwrap_or_default();
    Ok(HlaeBundleHandoff {
        directory: canonical.to_string_lossy().into_owned(),
        files,
        completion_marker: marker.to_string_lossy().into_owned(),
        created_at_epoch_ms,
    })
}

fn valid_artifact_name(value: &str) -> bool {
    value == BOOTSTRAP_FILE
        || value == COMMAND_FILE
        || value == HLAE_BUNDLE_README_FILE
        || value == HLAE_BUNDLE_LAUNCH_PROFILE_FILE
        || valid_camera_name(value)
}

fn valid_camera_name(value: &str) -> bool {
    value
        .strip_prefix("camera_")
        .and_then(|value| value.strip_suffix(".xml"))
        .is_some_and(|id| {
            !id.is_empty()
                && id.len() <= 64
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn hash_regular_file(path: &Path, expected_size: u64) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("unable to open HLAE artifact for verification: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("unable to inspect opened HLAE artifact: {error}"))?;
    if !metadata.is_file() || metadata.len() != expected_size {
        return Err("opened HLAE artifact identity changed during verification".to_owned());
    }
    let mut digest = Sha256::new();
    let mut read_bytes = 0_u64;
    let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("unable to hash HLAE artifact: {error}"))?;
        if count == 0 {
            break;
        }
        read_bytes = read_bytes
            .checked_add(u64::try_from(count).map_err(|error| error.to_string())?)
            .filter(|size| *size <= expected_size)
            .ok_or_else(|| "HLAE artifact grew during verification".to_owned())?;
        digest.update(&buffer[..count]);
    }
    if read_bytes != expected_size {
        return Err("HLAE artifact changed size during verification".to_owned());
    }
    Ok(hex::encode(digest.finalize()))
}

fn valid_bundle_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("proposal_"))
        .is_some_and(|suffix| {
            suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

#[cfg(windows)]
fn is_reparse_point(path: &Path) -> Result<bool, String> {
    use std::os::windows::fs::MetadataExt as _;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
        .map_err(|error| format!("unable to inspect HLAE path attributes: {error}"))
}

#[cfg(not(windows))]
const fn is_reparse_point(_path: &Path) -> Result<bool, String> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_artifact(path: &str, contents: &[u8]) -> vibe_cs_hlae::HlaeBundleArtifactManifest {
        vibe_cs_hlae::HlaeBundleArtifactManifest {
            path: path.to_owned(),
            size: u64::try_from(contents.len()).unwrap(),
            sha256: hex::encode(Sha256::digest(contents)),
        }
    }

    fn bundle(root: &Path, name: &str) -> PathBuf {
        let directory = root.join(name);
        fs::create_dir_all(&directory).unwrap();
        let artifacts = [
            (BOOTSTRAP_FILE, b"bootstrap".as_slice()),
            (COMMAND_FILE, b"commands".as_slice()),
            ("camera_shot_1.xml", b"camera".as_slice()),
            (HLAE_BUNDLE_README_FILE, b"readme".as_slice()),
            (HLAE_BUNDLE_LAUNCH_PROFILE_FILE, b"{}".as_slice()),
        ];
        for (path, contents) in artifacts {
            fs::write(directory.join(path), contents).unwrap();
        }
        let manifest = HlaeBundleManifest {
            state: "complete".to_owned(),
            producer: HLAE_BUNDLE_MANIFEST_PRODUCER.to_owned(),
            artifacts: artifacts
                .into_iter()
                .map(|(path, contents)| manifest_artifact(path, contents))
                .collect(),
        };
        fs::write(
            directory.join(HLAE_BUNDLE_MANIFEST_FILE),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        directory
    }

    #[test]
    fn accepts_only_complete_direct_managed_bundles() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("hlae-plans");
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let directory = bundle(&root, "proposal_0123456789abcdef0123456789abcdef");

        let handoff = validate_bundle(&root, &directory).unwrap();

        assert_eq!(handoff.directory, directory.to_string_lossy());
        assert_eq!(handoff.files.len(), 6);
    }

    #[test]
    fn rejects_external_and_incomplete_directories() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("hlae-plans");
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let external = bundle(
            temporary.path(),
            "proposal_0123456789abcdef0123456789abcdef",
        );
        let incomplete = root.join("proposal_abcdef0123456789abcdef0123456789");
        fs::create_dir(&incomplete).unwrap();

        assert!(validate_bundle(&root, &external).is_err());
        assert!(validate_bundle(&root, &incomplete).is_err());
    }

    #[test]
    fn rejects_tampered_extra_and_missing_artifacts() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("hlae-plans");
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();

        let tampered = bundle(&root, "proposal_0123456789abcdef0123456789abcdef");
        fs::write(tampered.join(BOOTSTRAP_FILE), b"tampered!").unwrap();
        assert!(validate_bundle(&root, &tampered).is_err());

        let extra = bundle(&root, "proposal_1123456789abcdef0123456789abcdef");
        fs::write(extra.join("extra.txt"), b"extra").unwrap();
        assert!(validate_bundle(&root, &extra).is_err());

        let missing = bundle(&root, "proposal_2123456789abcdef0123456789abcdef");
        fs::remove_file(missing.join(COMMAND_FILE)).unwrap();
        assert!(validate_bundle(&root, &missing).is_err());
    }
}
