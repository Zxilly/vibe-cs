use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

use crate::{HlaeDiscovery, HlaeDiscoverySource, HlaeError, HlaeInstallation};

const HLAE_EXECUTABLE: &str = "HLAE.exe";
const SOURCE2_HOOK: &str = "x64/AfxHookSource2.dll";

/// Finds an existing installation without launching or inspecting executable code.
#[must_use]
pub fn discover_hlae(configured_path: Option<&Path>) -> HlaeDiscovery {
    let mut candidates = Vec::new();
    if let Some(path) = configured_path {
        candidates.push((normalize_candidate(path), HlaeDiscoverySource::Configured));
    }
    candidates.extend(
        common_candidates()
            .into_iter()
            .map(|path| (path, HlaeDiscoverySource::CommonLocation)),
    );

    let mut seen = BTreeSet::new();
    candidates.retain(|(path, _)| seen.insert(path.clone()));
    let checked_locations = candidates.iter().map(|(path, _)| path.clone()).collect();

    if !cfg!(windows) {
        return HlaeDiscovery {
            installation: None,
            checked_locations,
            messages: vec![HlaeError::UnsupportedPlatform.to_string()],
        };
    }

    let installation = candidates
        .into_iter()
        .find_map(|(executable, source)| installation_from_executable(&executable, source).ok());
    let messages = if installation.is_some() {
        Vec::new()
    } else {
        vec!["No complete HLAE installation was found; configure HLAE.exe manually".to_owned()]
    };
    HlaeDiscovery {
        installation,
        checked_locations,
        messages,
    }
}

/// Validates the minimum files required for CS2 without loading either binary.
///
/// # Errors
///
/// Returns [`HlaeError::InvalidInstallation`] when the executable name or the
/// Source 2 hook is missing.
pub fn installation_from_executable(
    executable: &Path,
    source: HlaeDiscoverySource,
) -> Result<HlaeInstallation, HlaeError> {
    if !is_named(executable, HLAE_EXECUTABLE) {
        return Err(HlaeError::InvalidInstallation(
            "the configured executable must be named HLAE.exe".to_owned(),
        ));
    }
    if !executable.is_file() {
        return Err(HlaeError::InvalidInstallation(
            "HLAE.exe does not exist".to_owned(),
        ));
    }
    let root = executable.parent().ok_or_else(|| {
        HlaeError::InvalidInstallation("HLAE.exe has no installation directory".to_owned())
    })?;
    let source2_hook = root.join(SOURCE2_HOOK);
    if !source2_hook.is_file() {
        return Err(HlaeError::InvalidInstallation(
            "x64/AfxHookSource2.dll is missing".to_owned(),
        ));
    }
    Ok(HlaeInstallation {
        root: root.to_path_buf(),
        executable: executable.to_path_buf(),
        source2_hook,
        source,
    })
}

fn normalize_candidate(path: &Path) -> PathBuf {
    if path.is_dir() {
        path.join(HLAE_EXECUTABLE)
    } else {
        path.to_path_buf()
    }
}

fn common_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for variable in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(root) = std::env::var_os(variable) {
            candidates.push(PathBuf::from(root).join("HLAE/HLAE.exe"));
        }
    }
    if let Some(root) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(root).join("HLAE/HLAE.exe"));
    }
    candidates.push(PathBuf::from(r"C:\HLAE\HLAE.exe"));
    candidates
}

fn is_named(path: &Path, expected: &str) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case(expected))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_executable_and_source2_hook_without_running_them() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("HLAE.exe");
        let hook = root.path().join(SOURCE2_HOOK);
        std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
        std::fs::write(&executable, b"not executed").unwrap();
        std::fs::write(&hook, b"not loaded").unwrap();

        let installation =
            installation_from_executable(&executable, HlaeDiscoverySource::Configured).unwrap();

        assert_eq!(installation.executable, executable);
        assert_eq!(installation.source2_hook, hook);
    }

    #[test]
    fn rejects_a_partial_installation() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("HLAE.exe");
        std::fs::write(&executable, b"not executed").unwrap();
        assert!(
            installation_from_executable(&executable, HlaeDiscoverySource::Configured).is_err()
        );
    }
}
