use std::path::Path;

use crate::{HlaeDiscovery, HlaeDiscoverySource, HlaeError, HlaeInstallation};

const HLAE_EXECUTABLE: &str = "HLAE.exe";
const SOURCE2_HOOK: &str = "x64/AfxHookSource2.dll";

/// Finds the integrity-verified application-managed release without launching
/// or inspecting executable code.
#[must_use]
pub fn discover_managed_hlae(managed_root: &Path) -> HlaeDiscovery {
    let executable = crate::managed_hlae_release_directory(managed_root).join(HLAE_EXECUTABLE);
    let checked_locations = vec![executable];

    if !cfg!(windows) {
        return HlaeDiscovery {
            installation: None,
            checked_locations,
            messages: vec![HlaeError::UnsupportedPlatform.to_string()],
        };
    }

    let installation = crate::verify_managed_hlae_installation(managed_root).ok();
    let messages = if installation.is_some() {
        Vec::new()
    } else {
        vec!["No integrity-verified app-managed HLAE release was found".to_owned()]
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
pub(crate) fn installation_from_executable(
    executable: &Path,
) -> Result<HlaeInstallation, HlaeError> {
    if !is_named(executable, HLAE_EXECUTABLE) {
        return Err(HlaeError::InvalidInstallation(
            "the HLAE executable must be named HLAE.exe".to_owned(),
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
        source: HlaeDiscoverySource::Managed,
    })
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
    fn managed_discovery_never_accepts_a_manual_or_common_location() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join(HLAE_EXECUTABLE);
        let hook = root.path().join(SOURCE2_HOOK);
        std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
        std::fs::write(&executable, b"manual fixture").unwrap();
        std::fs::write(&hook, b"manual fixture").unwrap();

        let discovery = discover_managed_hlae(root.path());

        assert!(discovery.installation.is_none());
        assert_eq!(
            discovery.checked_locations,
            vec![crate::managed_hlae_release_directory(root.path()).join(HLAE_EXECUTABLE)]
        );
        assert!(
            discovery
                .messages
                .iter()
                .all(|message| !message.contains("configure") && !message.contains("manually"))
        );
    }

    #[test]
    fn validates_executable_and_source2_hook_without_running_them() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("HLAE.exe");
        let hook = root.path().join(SOURCE2_HOOK);
        std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
        std::fs::write(&executable, b"not executed").unwrap();
        std::fs::write(&hook, b"not loaded").unwrap();

        let installation = installation_from_executable(&executable).unwrap();

        assert_eq!(installation.executable, executable);
        assert_eq!(installation.source2_hook, hook);
    }

    #[test]
    fn rejects_a_partial_installation() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("HLAE.exe");
        std::fs::write(&executable, b"not executed").unwrap();
        assert!(installation_from_executable(&executable).is_err());
    }
}
