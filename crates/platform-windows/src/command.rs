use std::path::{Path, PathBuf};

use crate::{PlatformError, PlatformResult};

const MAXIMUM_CONSOLE_COMMAND_UTF16: usize = 2_048;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NativeWindowHandle(pub isize);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessInfo {
    pub process_id: u32,
    pub executable_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ForegroundWindow {
    pub handle: NativeWindowHandle,
    pub process_id: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ConsoleCommand {
    PlayDemo(PathBuf),
    GoToTick(u64),
    SpectatePlayer(String),
    Timescale(f64),
    RadarVisibility(bool),
    VoiceVolume(f64),
    VoicePlayerVolume { player_id: String, volume: f64 },
    CameraFov(f64),
    ViewmodelFov(f64),
    FlashAlpha(u8),
    GrenadeTrajectory(bool),
    HudVisibility(bool),
    Pause,
    Resume,
    Disconnect,
}

#[derive(Clone, PartialEq, Eq)]
pub struct ConsoleInputPlan {
    pub open_console_virtual_key: u16,
    pub command_utf16: Vec<u16>,
    pub submit_virtual_key: u16,
}

impl std::fmt::Debug for ConsoleInputPlan {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ConsoleInputPlan")
            .field("open_console_virtual_key", &self.open_console_virtual_key)
            .field("command_utf16_units", &self.command_utf16.len())
            .field("submit_virtual_key", &self.submit_virtual_key)
            .finish()
    }
}

pub trait DesktopBackend: Send + Sync {
    /// Lists processes whose executable name matches the requested file name.
    ///
    /// # Errors
    ///
    /// Returns a platform or process-enumeration error.
    fn discover_processes(&self, executable_name: &str) -> PlatformResult<Vec<ProcessInfo>>;

    /// Returns the current foreground window and owning process.
    ///
    /// # Errors
    ///
    /// Returns a platform error when no foreground window can be identified.
    fn foreground_window(&self) -> PlatformResult<ForegroundWindow>;

    /// Sends a validated plan only if the exact window and process are foreground.
    ///
    /// # Errors
    ///
    /// Returns an error when focus changed or structured input cannot be delivered.
    fn send_console_input(
        &self,
        window: NativeWindowHandle,
        expected_process_id: u32,
        plan: &ConsoleInputPlan,
    ) -> PlatformResult<()>;
}

impl<T> DesktopBackend for &T
where
    T: DesktopBackend + ?Sized,
{
    fn discover_processes(&self, executable_name: &str) -> PlatformResult<Vec<ProcessInfo>> {
        (*self).discover_processes(executable_name)
    }

    fn foreground_window(&self) -> PlatformResult<ForegroundWindow> {
        (*self).foreground_window()
    }

    fn send_console_input(
        &self,
        window: NativeWindowHandle,
        expected_process_id: u32,
        plan: &ConsoleInputPlan,
    ) -> PlatformResult<()> {
        (*self).send_console_input(window, expected_process_id, plan)
    }
}

#[derive(Debug)]
pub struct Cs2DesktopControl<B> {
    backend: B,
}

impl<B> Cs2DesktopControl<B>
where
    B: DesktopBackend,
{
    pub const fn new(backend: B) -> Self {
        Self { backend }
    }

    /// Verifies the target PID and foreground window immediately before input.
    ///
    /// # Errors
    ///
    /// Returns an error if CS2 is absent, another process owns the foreground
    /// window, the command is invalid, or the backend cannot deliver input.
    pub fn send_command(&self, process_id: u32, command: &ConsoleCommand) -> PlatformResult<()> {
        let processes = self.backend.discover_processes("cs2.exe")?;
        if !processes.iter().any(|process| {
            process.process_id == process_id
                && process.executable_name.eq_ignore_ascii_case("cs2.exe")
        }) {
            return Err(PlatformError::ProcessNotFound(format!(
                "cs2.exe with PID {process_id}"
            )));
        }
        let foreground = self.backend.foreground_window()?;
        if foreground.process_id != process_id {
            return Err(PlatformError::ForegroundMismatch {
                expected: process_id,
                actual: foreground.process_id,
            });
        }
        let plan = build_console_input(command)?;
        self.backend
            .send_console_input(foreground.handle, process_id, &plan)
    }
}

/// Builds a bounded Unicode input plan without a command shell.
///
/// # Errors
///
/// Rejects missing/non-absolute demos, unsafe path characters, and commands
/// that exceed the configured UTF-16 limit.
pub fn build_console_input(command: &ConsoleCommand) -> PlatformResult<ConsoleInputPlan> {
    let command = match command {
        ConsoleCommand::PlayDemo(path) => build_playdemo(path)?,
        ConsoleCommand::GoToTick(tick) => format!("demo_gototick {tick}"),
        ConsoleCommand::SpectatePlayer(player) => build_spectate_player(player)?,
        ConsoleCommand::Timescale(timescale) => build_timescale(*timescale)?,
        ConsoleCommand::RadarVisibility(visible) => {
            format!("cl_drawhud_force_radar {}", if *visible { 0 } else { -1 })
        }
        ConsoleCommand::VoiceVolume(volume) => build_voice_volume(*volume)?,
        ConsoleCommand::VoicePlayerVolume { player_id, volume } => {
            format!(
                "voice_player_volume {} {}",
                safe_player_id(player_id)?,
                safe_volume(*volume)?
            )
        }
        ConsoleCommand::CameraFov(value) => format!(
            "fov_cs_debug {}",
            safe_range(*value, 60.0, 140.0, "camera FOV")?
        ),
        ConsoleCommand::ViewmodelFov(value) => format!(
            "viewmodel_fov {}",
            safe_range(*value, 54.0, 68.0, "viewmodel FOV")?
        ),
        ConsoleCommand::FlashAlpha(value) => format!("cl_flash_max_alpha {value}"),
        ConsoleCommand::GrenadeTrajectory(visible) => format!(
            "sv_grenade_trajectory_prac_pipreview {}",
            u8::from(*visible)
        ),
        ConsoleCommand::HudVisibility(visible) => {
            format!("cl_draw_only_deathnotices {}", u8::from(!*visible))
        }
        ConsoleCommand::Pause => "demo_pause".to_owned(),
        ConsoleCommand::Resume => "demo_resume".to_owned(),
        ConsoleCommand::Disconnect => "disconnect".to_owned(),
    };
    if command.chars().any(char::is_control) {
        return Err(PlatformError::InvalidInput(
            "console command contains control characters".to_owned(),
        ));
    }
    let command_utf16 = command.encode_utf16().collect::<Vec<_>>();
    if command_utf16.is_empty() || command_utf16.len() > MAXIMUM_CONSOLE_COMMAND_UTF16 {
        return Err(PlatformError::InvalidInput(format!(
            "console command must contain 1..={MAXIMUM_CONSOLE_COMMAND_UTF16} UTF-16 units"
        )));
    }
    Ok(ConsoleInputPlan {
        // VK_OEM_3 is the default grave/tilde console key on Windows layouts.
        open_console_virtual_key: 0xC0,
        command_utf16,
        // VK_RETURN
        submit_virtual_key: 0x0D,
    })
}

fn build_spectate_player(player: &str) -> PlatformResult<String> {
    if player.is_empty()
        || player.len() > 128
        || player.trim() != player
        || player
            .chars()
            .any(|character| character.is_control() || matches!(character, '"' | ';' | '\\'))
    {
        return Err(PlatformError::InvalidInput(
            "spectator target contains unsafe characters or exceeds 128 bytes".to_owned(),
        ));
    }
    Ok(format!("spec_player \"{player}\""))
}

fn build_timescale(timescale: f64) -> PlatformResult<String> {
    if !timescale.is_finite() || !(0.1..=8.0).contains(&timescale) {
        return Err(PlatformError::InvalidInput(
            "demo timescale must be finite and between 0.1 and 8.0".to_owned(),
        ));
    }
    Ok(format!("demo_timescale {timescale}"))
}

fn build_voice_volume(volume: f64) -> PlatformResult<String> {
    if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
        return Err(PlatformError::InvalidInput(
            "voice volume must be finite and between 0 and 1".to_owned(),
        ));
    }
    Ok(format!("snd_voipvolume {volume}"))
}

fn safe_player_id(player_id: &str) -> PlatformResult<&str> {
    if player_id.is_empty()
        || player_id.len() > 32
        || !player_id.bytes().all(|value| value.is_ascii_digit())
    {
        return Err(PlatformError::InvalidInput(
            "voice player identity must contain 1..=32 ASCII digits".to_owned(),
        ));
    }
    Ok(player_id)
}

fn safe_volume(volume: f64) -> PlatformResult<f64> {
    safe_range(volume, 0.0, 1.0, "voice player volume")
}

fn safe_range(value: f64, minimum: f64, maximum: f64, label: &str) -> PlatformResult<f64> {
    if !value.is_finite() || !(minimum..=maximum).contains(&value) {
        return Err(PlatformError::InvalidInput(format!(
            "{label} must be finite and between {minimum} and {maximum}"
        )));
    }
    Ok(value)
}

fn build_playdemo(path: &Path) -> PlatformResult<String> {
    if !path.is_absolute() {
        return Err(PlatformError::InvalidInput(
            "demo path must be an existing absolute file".to_owned(),
        ));
    }
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("dem"))
    {
        return Err(PlatformError::InvalidInput(
            "demo path must end in .dem".to_owned(),
        ));
    }
    let path = path
        .to_str()
        .ok_or_else(|| PlatformError::InvalidInput("demo path is not valid Unicode".to_owned()))?;
    if path
        .chars()
        .any(|character| character.is_control() || matches!(character, '"' | ';'))
    {
        return Err(PlatformError::InvalidInput(
            "demo path contains console control characters".to_owned(),
        ));
    }
    if !Path::new(path).is_file() {
        return Err(PlatformError::InvalidInput(
            "demo path must be an existing absolute file".to_owned(),
        ));
    }
    Ok(format!("playdemo \"{path}\""))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[derive(Debug)]
    struct FakeDesktop {
        processes: Vec<ProcessInfo>,
        foreground: ForegroundWindow,
        sent: Mutex<Vec<ConsoleInputPlan>>,
    }

    impl DesktopBackend for FakeDesktop {
        fn discover_processes(&self, _executable_name: &str) -> PlatformResult<Vec<ProcessInfo>> {
            Ok(self.processes.clone())
        }

        fn foreground_window(&self) -> PlatformResult<ForegroundWindow> {
            Ok(self.foreground)
        }

        fn send_console_input(
            &self,
            _window: NativeWindowHandle,
            _expected_process_id: u32,
            plan: &ConsoleInputPlan,
        ) -> PlatformResult<()> {
            self.sent.lock().unwrap().push(plan.clone());
            Ok(())
        }
    }

    #[test]
    fn playdemo_path_stays_quoted_in_one_console_command() {
        let root = tempfile::tempdir().unwrap();
        let demo = root.path().join("match with spaces.dem");
        std::fs::write(&demo, b"PBDEMS2\0").unwrap();
        let plan = build_console_input(&ConsoleCommand::PlayDemo(demo.clone())).unwrap();
        let decoded = String::from_utf16(&plan.command_utf16).unwrap();
        assert_eq!(decoded, format!("playdemo \"{}\"", demo.display()));
    }

    #[test]
    fn playdemo_rejects_console_metacharacters() {
        let root = tempfile::tempdir().unwrap();
        let demo = root.path().join("match;quit.dem");
        std::fs::write(&demo, b"PBDEMS2\0").unwrap();
        assert!(matches!(
            build_console_input(&ConsoleCommand::PlayDemo(demo)),
            Err(PlatformError::InvalidInput(_))
        ));
    }

    #[test]
    fn playdemo_rejects_line_controls_before_filesystem_access() {
        let root = tempfile::tempdir().unwrap();
        let demo = root.path().join("match\nquit.dem");
        assert!(matches!(
            build_console_input(&ConsoleCommand::PlayDemo(demo)),
            Err(PlatformError::InvalidInput(_))
        ));
    }

    #[test]
    fn spectator_and_timescale_commands_are_strictly_typed() {
        let spectator = build_console_input(&ConsoleCommand::SpectatePlayer(
            "76561198000000000".to_owned(),
        ))
        .unwrap();
        assert_eq!(
            String::from_utf16(&spectator.command_utf16).unwrap(),
            "spec_player \"76561198000000000\""
        );
        assert!(matches!(
            build_console_input(&ConsoleCommand::SpectatePlayer("player;quit".to_owned())),
            Err(PlatformError::InvalidInput(_))
        ));
        let isolated = build_console_input(&ConsoleCommand::VoicePlayerVolume {
            player_id: "76561198000000000".to_owned(),
            volume: 0.0,
        })
        .unwrap();
        assert_eq!(
            String::from_utf16(&isolated.command_utf16).unwrap(),
            "voice_player_volume 76561198000000000 0"
        );
        assert!(
            build_console_input(&ConsoleCommand::VoicePlayerVolume {
                player_id: "player;quit".to_owned(),
                volume: 0.0,
            })
            .is_err()
        );
        assert_eq!(
            String::from_utf16(
                &build_console_input(&ConsoleCommand::CameraFov(100.0))
                    .unwrap()
                    .command_utf16
            )
            .unwrap(),
            "fov_cs_debug 100"
        );
        assert!(matches!(
            build_console_input(&ConsoleCommand::Timescale(f64::NAN)),
            Err(PlatformError::InvalidInput(_))
        ));
        let hidden_radar = build_console_input(&ConsoleCommand::RadarVisibility(false)).unwrap();
        assert_eq!(
            String::from_utf16(&hidden_radar.command_utf16).unwrap(),
            "cl_drawhud_force_radar -1"
        );
        let muted_voice = build_console_input(&ConsoleCommand::VoiceVolume(0.0)).unwrap();
        assert_eq!(
            String::from_utf16(&muted_voice.command_utf16).unwrap(),
            "snd_voipvolume 0"
        );
        assert!(matches!(
            build_console_input(&ConsoleCommand::VoiceVolume(1.5)),
            Err(PlatformError::InvalidInput(_))
        ));
    }

    #[test]
    fn foreground_pid_is_checked_before_backend_input() {
        let backend = FakeDesktop {
            processes: vec![ProcessInfo {
                process_id: 7,
                executable_name: "cs2.exe".to_owned(),
            }],
            foreground: ForegroundWindow {
                handle: NativeWindowHandle(42),
                process_id: 9,
            },
            sent: Mutex::new(Vec::new()),
        };
        let control = Cs2DesktopControl::new(backend);
        assert!(matches!(
            control.send_command(7, &ConsoleCommand::Pause),
            Err(PlatformError::ForegroundMismatch {
                expected: 7,
                actual: 9
            })
        ));
        assert!(control.backend.sent.lock().unwrap().is_empty());
    }
}
