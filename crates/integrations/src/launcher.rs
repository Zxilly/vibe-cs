use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

use async_trait::async_trait;

use crate::{IntegrationError, IntegrationResult};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GameLaunchOptions {
    pub insecure: bool,
    pub skip_intro: bool,
    pub windowed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchCommand {
    pub program: PathBuf,
    pub args: Vec<OsString>,
}

/// Builds a direct executable/argument vector without invoking a shell.
///
/// # Errors
///
/// Returns an error when the executable or demo is missing, misnamed, or has
/// an invalid extension/path.
pub fn build_cs2_launch_command(
    executable: &Path,
    demo: &Path,
    options: GameLaunchOptions,
) -> IntegrationResult<LaunchCommand> {
    if !executable.is_file() {
        return Err(IntegrationError::InvalidInput(format!(
            "CS2 executable does not exist: {}",
            executable.display()
        )));
    }
    let file_name = executable
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !file_name.eq_ignore_ascii_case("cs2.exe") && file_name != "cs2" {
        return Err(IntegrationError::InvalidInput(
            "executable is not named cs2/cs2.exe".to_owned(),
        ));
    }
    if !demo.is_file()
        || demo
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case("dem"))
    {
        return Err(IntegrationError::InvalidInput(
            "demo must be an existing .dem file".to_owned(),
        ));
    }
    if demo
        .as_os_str()
        .to_string_lossy()
        .contains(['\0', '\r', '\n'])
    {
        return Err(IntegrationError::InvalidInput(
            "demo path contains control characters".to_owned(),
        ));
    }
    let mut args = Vec::new();
    if options.insecure {
        args.push(OsString::from("-insecure"));
    }
    if options.skip_intro {
        args.push(OsString::from("-novid"));
    }
    if options.windowed {
        args.push(OsString::from("-windowed"));
    }
    args.push(OsString::from("+playdemo"));
    args.push(demo.as_os_str().to_os_string());
    Ok(LaunchCommand {
        program: executable.to_path_buf(),
        args,
    })
}

#[async_trait]
pub trait GameLauncher: Send + Sync {
    async fn launch(&self, command: &LaunchCommand) -> IntegrationResult<u32>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemGameLauncher;

#[async_trait]
impl GameLauncher for SystemGameLauncher {
    async fn launch(&self, command: &LaunchCommand) -> IntegrationResult<u32> {
        let child = tokio::process::Command::new(&command.program)
            .args(&command.args)
            .stdin(std::process::Stdio::null())
            .spawn()
            .map_err(|source| IntegrationError::Io {
                path: command.program.clone(),
                source,
            })?;
        child.id().ok_or_else(|| IntegrationError::Unavailable {
            integration: "CS2 launcher",
            message: "process started without an identifier".to_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_keeps_demo_path_as_one_argument() {
        let root = tempfile::tempdir().unwrap();
        let executable = root
            .path()
            .join(if cfg!(windows) { "cs2.exe" } else { "cs2" });
        let demo = root.path().join("match with spaces.dem");
        std::fs::write(&executable, b"stub").unwrap();
        std::fs::write(&demo, b"stub").unwrap();
        let command =
            build_cs2_launch_command(&executable, &demo, GameLaunchOptions::default()).unwrap();
        assert_eq!(command.args.last().unwrap(), demo.as_os_str());
        assert_eq!(command.args[command.args.len() - 2], "+playdemo");
    }
}
