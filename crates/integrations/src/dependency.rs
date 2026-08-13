use std::path::Path;

use vibe_cs_domain::{AppConfig, DependencyStatus, SetupStatus};

use crate::{DiscoveredPaths, discover_paths};

#[derive(Debug, Clone, Copy, Default)]
pub struct DependencyInspector;

impl DependencyInspector {
    #[must_use]
    pub fn inspect(&self, config: &AppConfig) -> SetupStatus {
        let paths = discover_paths(config);
        self.inspect_discovered(&paths)
    }

    #[must_use]
    pub fn inspect_discovered(&self, paths: &DiscoveredPaths) -> SetupStatus {
        let dependencies = vec![
            status("CS2", paths.cs2.as_deref(), true),
            status("Steam", paths.steam.as_deref(), false),
        ];
        let ready = dependencies
            .iter()
            .filter(|dependency| dependency.name == "CS2")
            .all(|dependency| dependency.available);
        SetupStatus {
            ready,
            dependencies,
        }
    }
}

fn status(name: &str, path: Option<&Path>, required: bool) -> DependencyStatus {
    let available = path.is_some_and(Path::is_file);
    DependencyStatus {
        name: name.to_owned(),
        available,
        version: None,
        path: path.map(|path| path.display().to_string()),
        message: (!available).then(|| {
            if required {
                "required dependency was not found".to_owned()
            } else {
                "optional integration is unavailable".to_owned()
            }
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_requires_only_cs2() {
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("tool.exe");
        std::fs::write(&binary, b"stub").unwrap();
        let paths = DiscoveredPaths {
            cs2: Some(binary),
            ..DiscoveredPaths::default()
        };
        let status = DependencyInspector.inspect_discovered(&paths);
        assert!(status.ready);
        assert_eq!(
            status
                .dependencies
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            ["CS2", "Steam"]
        );
    }
}
