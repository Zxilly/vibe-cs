use std::{ffi::OsString, path::Path};

use crate::{
    HLAE_MANAGED_SESSION_CONFIG_RELATIVE_PATH, HlaeError, HlaeLaunchProfile,
    HlaeManagedSessionBootstrap, validate::validate_safe_path,
};

/// A reviewable, process-free invocation of HLAE's official custom loader.
///
/// The executable and argument collection are immutable so consumers cannot
/// append unreviewed game or loader options after validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HlaeCustomLoaderInvocation {
    executable: std::path::PathBuf,
    arguments: Vec<OsString>,
}

impl HlaeCustomLoaderInvocation {
    #[must_use]
    pub fn executable(&self) -> &Path {
        &self.executable
    }

    #[must_use]
    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }
}

/// Converts a typed HLAE launch profile into the official custom-loader argv.
///
/// This function only constructs data. It never starts HLAE, CS2, or a shell.
///
/// # Errors
///
/// Returns [`HlaeError`] when the required moviemaking environment value is
/// absent or the fixed Steam launch environment has drifted.
pub fn build_hlae_custom_loader_invocation(
    profile: &HlaeLaunchProfile,
) -> Result<HlaeCustomLoaderInvocation, HlaeError> {
    validate_launch_paths(profile)?;
    let game_command_line = validate_fixed_game_command_line(profile)?;
    if profile.environment.len() != 6 {
        return Err(HlaeError::InvalidPlan(
            "launch profile must define only the reviewed Steam and USRLOCALCSGO environment"
                .to_owned(),
        ));
    }
    let moviemaking_config = profile.environment.get("USRLOCALCSGO").ok_or_else(|| {
        HlaeError::InvalidPlan("launch profile must define USRLOCALCSGO".to_owned())
    })?;
    validate_safe_path(Path::new(moviemaking_config), "moviemakingConfigRoot", true)?;
    if !Path::new(moviemaking_config).is_dir() {
        return Err(HlaeError::InvalidInstallation(
            "moviemaking config root must be an existing directory".to_owned(),
        ));
    }
    let steam_path = profile
        .environment
        .get("SteamPath")
        .ok_or_else(|| HlaeError::InvalidPlan("launch profile must define SteamPath".to_owned()))?;
    validate_safe_path(Path::new(steam_path), "steamRoot", true)?;
    if !Path::new(steam_path).is_dir()
        || !Path::new(steam_path).join("steam.exe").is_file()
        || profile.environment.get("SteamAppId").map(String::as_str) != Some("730")
        || profile
            .environment
            .get("SteamClientLaunch")
            .map(String::as_str)
            != Some("1")
        || profile.environment.get("SteamGameId").map(String::as_str) != Some("730")
        || profile
            .environment
            .get("SteamOverlayGameId")
            .map(String::as_str)
            != Some("730")
    {
        return Err(HlaeError::InvalidPlan(
            "launch profile Steam environment does not match the reviewed CS2 contract".to_owned(),
        ));
    }

    let mut arguments = vec![
        OsString::from("-customLoader"),
        OsString::from("-noGui"),
        OsString::from("-noConfig"),
        OsString::from("-autoStart"),
        OsString::from("-hookDllPath"),
        profile.hook_library.clone().into_os_string(),
        OsString::from("-programPath"),
        profile.game_executable.clone().into_os_string(),
        OsString::from("-cmdLine"),
        OsString::from(game_command_line),
    ];
    for (name, value) in &profile.environment {
        arguments.push(OsString::from("-addEnv"));
        arguments.push(OsString::from(format!("{name}={value}")));
    }

    Ok(HlaeCustomLoaderInvocation {
        executable: profile.hlae_executable.clone(),
        arguments,
    })
}

/// Builds the reviewed custom-loader invocation for one already-published
/// managed startup configuration.
///
/// The validated bootstrap commands are encoded directly in Source 2's fixed
/// `+command` syntax. This avoids the startup race where `+exec` is processed
/// before HLAE has mounted the isolated `USRLOCALCSGO` search path.
///
/// # Errors
///
/// Returns [`HlaeError`] when the base launch profile is invalid or the startup
/// artifact is missing, linked, moved, oversized, or changed after compilation.
pub fn build_hlae_managed_session_invocation(
    profile: &HlaeLaunchProfile,
    bootstrap: &HlaeManagedSessionBootstrap,
) -> Result<HlaeCustomLoaderInvocation, HlaeError> {
    let mut invocation = build_hlae_custom_loader_invocation(profile)?;
    validate_published_managed_bootstrap(profile, bootstrap)?;
    let cmdline_index = invocation
        .arguments
        .iter()
        .position(|argument| argument == "-cmdLine")
        .and_then(|index| index.checked_add(1))
        .ok_or_else(|| {
            HlaeError::InvalidPlan("custom-loader invocation has no command line".to_owned())
        })?;
    let command_line = invocation
        .arguments
        .get(cmdline_index)
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            HlaeError::InvalidPlan("custom-loader command line is not Unicode".to_owned())
        })?;
    invocation.arguments[cmdline_index] = OsString::from(format!(
        "{command_line} {}",
        bootstrap.command_line_suffix()
    ));
    Ok(invocation)
}

fn validate_published_managed_bootstrap(
    profile: &HlaeLaunchProfile,
    bootstrap: &HlaeManagedSessionBootstrap,
) -> Result<(), HlaeError> {
    let path = bootstrap.path();
    validate_safe_path(path, "managedSessionConfig", true)?;
    if path.file_name().and_then(|name| name.to_str()) != Some("autoexec.cfg") {
        return Err(HlaeError::InvalidPlan(
            "managed session config must use the isolated autoexec filename".to_owned(),
        ));
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|error| HlaeError::ArtifactIo {
        operation: "inspect managed session config",
        message: error.to_string(),
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(HlaeError::InvalidPlan(
            "managed session config must be a regular non-link file".to_owned(),
        ));
    }
    let expected_size =
        u64::try_from(bootstrap.contents().len()).map_err(|error| HlaeError::ArtifactIo {
            operation: "measure managed session config",
            message: error.to_string(),
        })?;
    if metadata.len() != expected_size {
        return Err(HlaeError::InvalidPlan(
            "managed session config size changed after compilation".to_owned(),
        ));
    }

    let root = profile.environment.get("USRLOCALCSGO").ok_or_else(|| {
        HlaeError::InvalidPlan("launch profile must define USRLOCALCSGO".to_owned())
    })?;
    let root = std::fs::canonicalize(root).map_err(|error| HlaeError::ArtifactIo {
        operation: "canonicalize moviemaking config root",
        message: error.to_string(),
    })?;
    let expected_path = root.join(HLAE_MANAGED_SESSION_CONFIG_RELATIVE_PATH);
    let actual = std::fs::canonicalize(path).map_err(|error| HlaeError::ArtifactIo {
        operation: "canonicalize managed session config",
        message: error.to_string(),
    })?;
    if actual != expected_path || !actual.starts_with(&root) {
        return Err(HlaeError::InvalidPlan(
            "managed session config escaped the isolated moviemaking root".to_owned(),
        ));
    }
    let contents = std::fs::read_to_string(path).map_err(|error| HlaeError::ArtifactIo {
        operation: "read managed session config",
        message: error.to_string(),
    })?;
    if contents != bootstrap.contents() {
        return Err(HlaeError::InvalidPlan(
            "managed session config changed after compilation".to_owned(),
        ));
    }
    Ok(())
}

fn validate_launch_paths(profile: &HlaeLaunchProfile) -> Result<(), HlaeError> {
    for (path, field, expected_name) in [
        (&profile.hlae_executable, "hlaeExecutable", "HLAE.exe"),
        (&profile.hook_library, "hookLibrary", "AfxHookSource2.dll"),
        (&profile.game_executable, "gameExecutable", "cs2.exe"),
    ] {
        validate_safe_path(path, field, true)?;
        if !path.is_file()
            || !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case(expected_name))
        {
            return Err(HlaeError::InvalidInstallation(format!(
                "{field} must be an existing {expected_name}"
            )));
        }
    }
    Ok(())
}

fn validate_fixed_game_command_line(profile: &HlaeLaunchProfile) -> Result<String, HlaeError> {
    if !profile.safety.insecure_mode_required
        || !profile.safety.vac_servers_prohibited
        || !profile.safety.demo_playback_only
    {
        return invalid_launch_profile();
    }
    let [
        steam,
        worldwide,
        insecure,
        sv_lan,
        lan_value,
        console,
        windowed,
        width_flag,
        width,
        height_flag,
        height,
        fix_net_con,
        disable_steam_storage,
    ] = profile.arguments.as_slice()
    else {
        return invalid_launch_profile();
    };
    if steam != "-steam"
        || worldwide != "-worldwide"
        || insecure != "-insecure"
        || sv_lan != "+sv_lan"
        || lan_value != "1"
        || console != "-console"
        || windowed != "-sw"
        || width_flag != "-w"
        || height_flag != "-h"
        || fix_net_con != "-afxFixNetCon"
        || disable_steam_storage != "-afxDisableSteamStorage"
        || !is_canonical_dimension(width, 320, 4_096)
        || !is_canonical_dimension(height, 240, 2_304)
    {
        return invalid_launch_profile();
    }
    Ok(profile.arguments.join(" "))
}

fn is_canonical_dimension(value: &str, minimum: u32, maximum: u32) -> bool {
    value.parse::<u32>().is_ok_and(|parsed| {
        (minimum..=maximum).contains(&parsed)
            && parsed.is_multiple_of(2)
            && parsed.to_string() == value
    })
}

fn invalid_launch_profile<T>() -> Result<T, HlaeError> {
    Err(HlaeError::InvalidPlan(
        "launch profile must use the fixed offline CS2 command line and safety policy".to_owned(),
    ))
}
