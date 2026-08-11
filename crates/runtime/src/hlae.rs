use std::path::Path;

use vibe_cs_hlae::{
    CompiledHlaePlan, ExportedHlaePlan, HlaeDiscovery, HlaeError, HlaeLaunchProfile, HlaeNotice,
    HlaePlan, LaunchResolution, build_hlae_launch_profile, compile_hlae_plan, discover_hlae,
    export_hlae_plan, validate_hlae_plan,
};

/// Process-free HLAE adapter used by desktop commands and AI tool boundaries.
///
/// Deliberately has no launch or execute method. A caller can discover an
/// installation, validate a typed plan, and preview the exact generated files.
#[derive(Debug, Default)]
pub struct RuntimeHlaePort;

impl RuntimeHlaePort {
    /// Locates an existing installation without loading or running its binaries.
    #[must_use]
    pub fn discover(configured_path: Option<&Path>) -> HlaeDiscovery {
        discover_hlae(configured_path)
    }

    /// Produces a dry-run bundle for review without writing or executing it.
    ///
    /// # Errors
    ///
    /// Returns [`HlaeError`] when the plan or artifact path is invalid.
    pub fn compile(
        plan: &HlaePlan,
        artifact_directory: &Path,
    ) -> Result<CompiledHlaePlan, HlaeError> {
        compile_hlae_plan(plan, artifact_directory)
    }

    /// Validates a typed camera plan and returns non-blocking review notices.
    ///
    /// # Errors
    ///
    /// Returns [`HlaeError`] when the plan contains unsafe or invalid values.
    pub fn validate(plan: &HlaePlan) -> Result<Vec<HlaeNotice>, HlaeError> {
        validate_hlae_plan(plan)
    }

    /// Atomically writes a no-clobber bundle below an application-managed root.
    ///
    /// # Errors
    ///
    /// Returns [`HlaeError`] when validation, safe staging, or atomic
    /// publication fails. Existing bundles are never replaced.
    pub fn export(
        plan: &HlaePlan,
        managed_root: &Path,
        bundle_name: &str,
    ) -> Result<ExportedHlaePlan, HlaeError> {
        export_hlae_plan(plan, managed_root, bundle_name)
    }

    /// Produces fixed official custom-loader fields with `-insecure` enforced.
    ///
    /// # Errors
    ///
    /// Returns [`HlaeError`] when an installation path, CS2 path, config root,
    /// or resolution is invalid.
    pub fn launch_profile(
        installation: &vibe_cs_hlae::HlaeInstallation,
        cs2_executable: &Path,
        moviemaking_config_root: &Path,
        resolution: LaunchResolution,
    ) -> Result<HlaeLaunchProfile, HlaeError> {
        build_hlae_launch_profile(
            installation,
            cs2_executable,
            moviemaking_config_root,
            resolution,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_has_a_safe_missing_installation_result() {
        let discovery = RuntimeHlaePort::discover(Some(Path::new("missing/HLAE.exe")));
        assert!(discovery.installation.is_none());
        assert!(!discovery.checked_locations.is_empty());
    }
}
