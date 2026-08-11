use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

use directories::BaseDirs;
use vibe_cs_domain::AppConfig;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DiscoveredPaths {
    pub steam: Option<PathBuf>,
    pub cs2: Option<PathBuf>,
    pub obs: Option<PathBuf>,
    pub ffmpeg: Option<PathBuf>,
    pub ffprobe: Option<PathBuf>,
    pub steam_libraries: Vec<PathBuf>,
}

#[must_use]
pub fn discover_paths(config: &AppConfig) -> DiscoveredPaths {
    let configured_steam_root = configured_steam_root(&config.steam_path);
    let steam = configured_steam_executable(&config.steam_path).or_else(discover_steam_executable);
    let mut libraries = steam_roots();
    libraries.extend(configured_steam_root);
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
    DiscoveredPaths {
        steam,
        cs2: existing_file(&config.cs2_path).or_else(|| discover_cs2(&libraries)),
        obs: existing_file(&config.obs.executable).or_else(discover_obs),
        ffmpeg: existing_file(&config.ffmpeg_path).or_else(|| find_on_path("ffmpeg")),
        ffprobe: existing_file(&config.ffprobe_path).or_else(|| find_on_path("ffprobe")),
        steam_libraries: libraries,
    }
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
    let executable = if cfg!(windows) {
        "steam.exe"
    } else if cfg!(target_os = "macos") {
        "Steam.app/Contents/MacOS/steam_osx"
    } else {
        "steam"
    };
    steam_roots()
        .into_iter()
        .map(|root| root.join(executable))
        .find(|path| path.is_file())
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

fn discover_obs() -> Option<PathBuf> {
    if cfg!(windows) {
        ["ProgramFiles", "ProgramFiles(x86)"]
            .into_iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .map(|root| root.join("obs-studio/bin/64bit/obs64.exe"))
            .find(|path| path.is_file())
    } else if cfg!(target_os = "macos") {
        Some(PathBuf::from("/Applications/OBS.app/Contents/MacOS/OBS"))
            .filter(|path| path.is_file())
    } else {
        find_on_path("obs")
    }
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
}
