use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

use directories::BaseDirs;
use vibe_cs_domain::AppConfig;

use crate::{IntegrationError, IntegrationResult};

const CS2_APP_ID: u32 = 730;
const PUBLIC_STEAM_ID64_ACCOUNT_BASE: u64 = 76_561_197_960_265_728;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DiscoveredPaths {
    pub steam: Option<PathBuf>,
    pub cs2: Option<PathBuf>,
    pub steam_libraries: Vec<PathBuf>,
}

#[must_use]
pub fn discover_paths(config: &AppConfig) -> DiscoveredPaths {
    let configured_steam_root = configured_steam_root(&config.steam_path);
    let configured_cs2 = configured_steam_root
        .as_ref()
        .and_then(|root| discover_cs2(std::slice::from_ref(root)));
    let steam_installations = discover_steam_installations(configured_steam_root.as_deref());
    let steam = configured_steam_executable(&config.steam_path)
        .or_else(|| {
            steam_installations
                .iter()
                .find_map(|item| item.executable.clone())
        })
        .or_else(discover_steam_executable);
    let mut libraries = steam_roots();
    libraries.extend(configured_steam_root);
    libraries.extend(
        steam_installations
            .iter()
            .flat_map(|item| item.libraries.clone()),
    );
    if let Some(parent) = steam.as_deref().and_then(Path::parent) {
        libraries.push(parent.to_path_buf());
    }
    libraries.sort();
    libraries.dedup();
    for root in libraries.clone() {
        libraries.extend(parse_library_folders(
            &root.join("steamapps/libraryfolders.vdf"),
        ));
    }
    libraries.sort();
    libraries.dedup();
    let manifest_cs2 = steam_installations.iter().find_map(|item| item.cs2.clone());
    DiscoveredPaths {
        steam,
        cs2: existing_file(&config.cs2_path)
            .or(configured_cs2)
            .or(manifest_cs2)
            .or_else(|| discover_cs2(&libraries)),
        steam_libraries: libraries,
    }
}

/// Resolves the active Steam account's existing CS2 configuration directory.
/// Windows uses Steam's live `ActiveUser` identity and falls back to app 730's
/// `LastOwner` only when the live identity is unavailable.
///
/// # Errors
///
/// Returns an error when the Steam executable, app manifest, account identity,
/// or existing user configuration is unavailable or escapes the Steam root.
pub fn discover_active_cs2_user_config(steam_executable: &Path) -> IntegrationResult<PathBuf> {
    discover_cs2_user_config_for_account(steam_executable, active_steam_account_id())
}

fn discover_cs2_user_config_for_account(
    steam_executable: &Path,
    active_account_id: Option<u32>,
) -> IntegrationResult<PathBuf> {
    if !steam_executable.is_file() || !is_steam_executable(steam_executable) {
        return Err(IntegrationError::InvalidConfiguration(
            "Steam executable is missing or has an unexpected file name".to_owned(),
        ));
    }
    let steam_root = steam_executable.parent().ok_or_else(|| {
        IntegrationError::InvalidConfiguration(
            "Steam executable has no installation directory".to_owned(),
        )
    })?;
    let steam = steamlocate::SteamDir::from_dir(steam_root).map_err(|error| {
        IntegrationError::Unavailable {
            integration: "Steam CS2 configuration",
            message: format!("unable to inspect the Steam installation: {error}"),
        }
    })?;
    let (app, _) = steam
        .find_app(CS2_APP_ID)
        .map_err(|error| IntegrationError::Unavailable {
            integration: "Steam CS2 configuration",
            message: format!("unable to inspect app 730: {error}"),
        })?
        .ok_or_else(|| IntegrationError::Unavailable {
            integration: "Steam CS2 configuration",
            message: "app 730 is not installed in this Steam library set".to_owned(),
        })?;
    let last_owner_account_id = app.last_user.and_then(steam_account_id);
    let account_id = active_account_id
        .filter(|value| *value != 0)
        .or(last_owner_account_id)
        .ok_or_else(|| IntegrationError::Unavailable {
            integration: "Steam CS2 configuration",
            message: "Steam has no active or last-owner public individual account".to_owned(),
        })?;
    let expected_account_root = steam_root.join("userdata").join(account_id.to_string());
    let config = expected_account_root.join("730/local/cfg");
    let metadata =
        std::fs::symlink_metadata(&config).map_err(|error| IntegrationError::Unavailable {
            integration: "Steam CS2 configuration",
            message: format!("active account cfg directory is unavailable: {error}"),
        })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(IntegrationError::Unavailable {
            integration: "Steam CS2 configuration",
            message: "active account cfg path is linked or is not a directory".to_owned(),
        });
    }
    let canonical_account = std::fs::canonicalize(&expected_account_root).map_err(|error| {
        IntegrationError::Unavailable {
            integration: "Steam CS2 configuration",
            message: format!("active account directory cannot be canonicalized: {error}"),
        }
    })?;
    let canonical_config =
        std::fs::canonicalize(&config).map_err(|error| IntegrationError::Unavailable {
            integration: "Steam CS2 configuration",
            message: format!("active account cfg directory cannot be canonicalized: {error}"),
        })?;
    if canonical_config != canonical_account.join("730/local/cfg") {
        return Err(IntegrationError::Unavailable {
            integration: "Steam CS2 configuration",
            message: "active account cfg directory escaped its Steam userdata account".to_owned(),
        });
    }
    let has_user_convars = std::fs::read_dir(&canonical_config)
        .map_err(|error| IntegrationError::Unavailable {
            integration: "Steam CS2 configuration",
            message: format!("active account cfg directory cannot be read: {error}"),
        })?
        .filter_map(Result::ok)
        .any(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with("cs2_user_convars_") && name.ends_with(".vcfg")
        });
    if !has_user_convars {
        return Err(IntegrationError::Unavailable {
            integration: "Steam CS2 configuration",
            message: "active account cfg directory has no CS2 user convar file".to_owned(),
        });
    }
    Ok(canonical_config)
}

fn steam_account_id(steam_id64: u64) -> Option<u32> {
    steam_id64
        .checked_sub(PUBLIC_STEAM_ID64_ACCOUNT_BASE)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value != 0)
}

#[cfg(windows)]
fn active_steam_account_id() -> Option<u32> {
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};

    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Valve\\Steam\\ActiveProcess")
        .ok()?
        .get_value::<u32, _>("ActiveUser")
        .ok()
        .filter(|value| *value != 0)
}

#[cfg(not(windows))]
fn active_steam_account_id() -> Option<u32> {
    None
}

pub(crate) fn is_steam_executable(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            if cfg!(windows) {
                name.eq_ignore_ascii_case("steam.exe")
            } else {
                name == "steam" || name == "steam_osx"
            }
        })
}

#[derive(Debug, Default)]
struct SteamInstallation {
    executable: Option<PathBuf>,
    libraries: Vec<PathBuf>,
    cs2: Option<PathBuf>,
}

fn discover_steam_installations(configured_root: Option<&Path>) -> Vec<SteamInstallation> {
    let mut directories = steamlocate::locate_all().unwrap_or_default();
    if let Some(directory) =
        configured_root.and_then(|path| steamlocate::SteamDir::from_dir(path).ok())
        && !directories
            .iter()
            .any(|item| item.path() == directory.path())
    {
        directories.push(directory);
    }
    directories
        .into_iter()
        .map(|directory| {
            let executable = steam_executable_in(directory.path());
            let libraries = directory.library_paths().unwrap_or_default();
            let cs2 = directory
                .find_app(CS2_APP_ID)
                .ok()
                .flatten()
                .and_then(|(app, library)| cs2_executable_in(&library.resolve_app_dir(&app)));
            SteamInstallation {
                executable,
                libraries,
                cs2,
            }
        })
        .collect()
}

fn steam_executable_in(root: &Path) -> Option<PathBuf> {
    let relative = if cfg!(windows) {
        "steam.exe"
    } else if cfg!(target_os = "macos") {
        "Steam.app/Contents/MacOS/steam_osx"
    } else {
        "steam"
    };
    Some(root.join(relative)).filter(|path| path.is_file())
}

fn cs2_executable_in(app_directory: &Path) -> Option<PathBuf> {
    let relative = if cfg!(windows) {
        Path::new("game/bin/win64/cs2.exe")
    } else if cfg!(target_os = "macos") {
        Path::new("game/cs2.app/Contents/MacOS/cs2")
    } else {
        Path::new("game/bin/linuxsteamrt64/cs2")
    };
    Some(app_directory.join(relative)).filter(|path| path.is_file())
}

fn configured_steam_root(value: &str) -> Option<PathBuf> {
    let path = PathBuf::from(value.trim());
    if value.trim().is_empty() {
        None
    } else if path.is_dir() {
        Some(path)
    } else if path.is_file() {
        path.parent().map(Path::to_path_buf)
    } else {
        None
    }
}

fn configured_steam_executable(value: &str) -> Option<PathBuf> {
    let path = PathBuf::from(value.trim());
    if value.trim().is_empty() {
        return None;
    }
    if path.is_file() {
        return Some(path);
    }
    if !path.is_dir() {
        return None;
    }
    let relative = if cfg!(windows) {
        "steam.exe"
    } else if cfg!(target_os = "macos") {
        "Steam.app/Contents/MacOS/steam_osx"
    } else {
        "steam"
    };
    Some(path.join(relative)).filter(|candidate| candidate.is_file())
}

fn existing_file(value: &str) -> Option<PathBuf> {
    (!value.trim().is_empty())
        .then(|| PathBuf::from(value))
        .filter(|path| path.is_file())
}

pub fn find_on_path(name: &str) -> Option<PathBuf> {
    if name.is_empty() || name.contains(['/', '\\', '\0']) {
        return None;
    }
    let names = if cfg!(windows) {
        vec![format!("{name}.exe"), name.to_owned()]
    } else {
        vec![name.to_owned()]
    };
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|path| path.is_file())
}

fn steam_roots() -> Vec<PathBuf> {
    let mut roots = BTreeSet::new();
    if cfg!(windows) {
        for variable in ["ProgramFiles(x86)", "ProgramFiles"] {
            if let Some(path) = std::env::var_os(variable) {
                roots.insert(PathBuf::from(path).join("Steam"));
            }
        }
    }
    if let Some(base) = BaseDirs::new() {
        roots.insert(base.home_dir().join(".steam/steam"));
        roots.insert(base.home_dir().join(".local/share/Steam"));
        roots.insert(base.home_dir().join("Library/Application Support/Steam"));
    }
    roots.into_iter().filter(|path| path.is_dir()).collect()
}

fn discover_steam_executable() -> Option<PathBuf> {
    steam_roots()
        .into_iter()
        .find_map(|root| steam_executable_in(&root))
        .or_else(|| find_on_path("steam"))
}

fn discover_cs2(libraries: &[PathBuf]) -> Option<PathBuf> {
    let relative = if cfg!(windows) {
        Path::new("steamapps/common/Counter-Strike Global Offensive/game/bin/win64/cs2.exe")
    } else if cfg!(target_os = "macos") {
        Path::new(
            "steamapps/common/Counter-Strike Global Offensive/game/cs2.app/Contents/MacOS/cs2",
        )
    } else {
        Path::new("steamapps/common/Counter-Strike Global Offensive/game/bin/linuxsteamrt64/cs2")
    };
    libraries
        .iter()
        .map(|root| root.join(relative))
        .find(|path| path.is_file())
}

fn parse_library_folders(path: &Path) -> Vec<PathBuf> {
    let Ok(metadata) = std::fs::metadata(path) else {
        return Vec::new();
    };
    if metadata.len() > 2 * 1024 * 1024 {
        return Vec::new();
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let quoted = text
        .split('"')
        .enumerate()
        .filter_map(|(index, value)| (index % 2 == 1).then_some(value))
        .collect::<Vec<_>>();
    quoted
        .windows(2)
        .filter(|pair| pair[0].eq_ignore_ascii_case("path"))
        .map(|pair| PathBuf::from(pair[1].replace("\\\\", "\\")))
        .filter(|path| path.is_dir())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vdf_library_paths_with_a_size_limit() {
        let root = tempfile::tempdir().unwrap();
        let library = root.path().join("library");
        std::fs::create_dir(&library).unwrap();
        let vdf = root.path().join("libraryfolders.vdf");
        std::fs::write(
            &vdf,
            format!(
                "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} }}",
                library.display()
            ),
        )
        .unwrap();
        assert_eq!(parse_library_folders(&vdf), [library]);
    }

    #[test]
    fn configured_steam_directory_is_also_used_as_a_game_library() {
        let root = tempfile::tempdir().unwrap();
        let relative = if cfg!(windows) {
            "steamapps/common/Counter-Strike Global Offensive/game/bin/win64/cs2.exe"
        } else if cfg!(target_os = "macos") {
            "steamapps/common/Counter-Strike Global Offensive/game/cs2.app/Contents/MacOS/cs2"
        } else {
            "steamapps/common/Counter-Strike Global Offensive/game/bin/linuxsteamrt64/cs2"
        };
        let executable = root.path().join(relative);
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, b"stub").unwrap();
        let config = AppConfig {
            steam_path: root.path().to_string_lossy().into_owned(),
            ..AppConfig::default()
        };

        let paths = discover_paths(&config);
        assert_eq!(paths.cs2.as_deref(), Some(executable.as_path()));
        assert!(paths.steam_libraries.iter().any(|path| path == root.path()));
    }

    #[test]
    fn resolves_cs2_executable_below_a_manifest_install_directory() {
        let root = tempfile::tempdir().unwrap();
        let relative = if cfg!(windows) {
            "game/bin/win64/cs2.exe"
        } else if cfg!(target_os = "macos") {
            "game/cs2.app/Contents/MacOS/cs2"
        } else {
            "game/bin/linuxsteamrt64/cs2"
        };
        let executable = root.path().join(relative);
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, b"stub").unwrap();
        assert_eq!(
            cs2_executable_in(root.path()).as_deref(),
            Some(executable.as_path())
        );
    }

    #[test]
    fn resolves_the_last_cs2_owner_configuration_without_guessing_an_account() {
        let root = tempfile::tempdir().unwrap();
        let steam_executable = root
            .path()
            .join(if cfg!(windows) { "steam.exe" } else { "steam" });
        let account_id = 42_u32;
        let steam_id64 = PUBLIC_STEAM_ID64_ACCOUNT_BASE + u64::from(account_id);
        let config = root
            .path()
            .join("userdata")
            .join(account_id.to_string())
            .join("730/local/cfg");
        std::fs::create_dir_all(root.path().join("steamapps")).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(&steam_executable, b"steam").unwrap();
        std::fs::write(
            root.path().join("steamapps/libraryfolders.vdf"),
            format!(
                "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" \"apps\" {{ \"730\" \"1\" }} }} }}",
                root.path().to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .unwrap();
        std::fs::write(
            root.path().join("steamapps/appmanifest_730.acf"),
            format!(
                "\"AppState\" {{ \"appid\" \"730\" \"installdir\" \"Counter-Strike Global Offensive\" \"LastOwner\" \"{steam_id64}\" }}"
            ),
        )
        .unwrap();
        std::fs::write(
            config.join("cs2_user_convars_0_slot0.vcfg"),
            b"sensitivity=0.845927",
        )
        .unwrap();

        assert_eq!(
            discover_cs2_user_config_for_account(&steam_executable, None).unwrap(),
            std::fs::canonicalize(config).unwrap()
        );

        let active_config = root.path().join("userdata/7/730/local/cfg");
        std::fs::create_dir_all(&active_config).unwrap();
        std::fs::write(
            active_config.join("cs2_user_convars_0_slot0.vcfg"),
            b"sensitivity=1.25",
        )
        .unwrap();
        assert_eq!(
            discover_cs2_user_config_for_account(&steam_executable, Some(7)).unwrap(),
            std::fs::canonicalize(active_config).unwrap(),
            "the live Steam account must take precedence over app 730 LastOwner"
        );
    }
}
