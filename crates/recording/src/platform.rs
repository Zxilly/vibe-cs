use std::{path::Path, time::Duration};

use async_trait::async_trait;
use vibe_cs_platform_windows::{
    ConsoleCommand, Cs2DesktopControl, DesktopBackend, ProcessCancellation, ProcessInfo,
    ProcessRunner, ProcessSpec,
};

use crate::{GameController, LaunchPolicy, RecordingError, RecordingResult};

#[derive(Debug)]
pub struct PlatformGameController<B, R> {
    desktop: B,
    process_runner: R,
    discovery_poll_interval: Duration,
}

impl<B, R> PlatformGameController<B, R> {
    #[must_use]
    pub const fn new(desktop: B, process_runner: R) -> Self {
        Self {
            desktop,
            process_runner,
            discovery_poll_interval: Duration::from_millis(100),
        }
    }

    /// Overrides the bounded process-discovery polling interval.
    ///
    /// # Errors
    ///
    /// Rejects zero intervals or intervals longer than five seconds.
    pub fn with_discovery_poll_interval(mut self, interval: Duration) -> RecordingResult<Self> {
        if interval.is_zero() || interval > Duration::from_secs(5) {
            return Err(RecordingError::InvalidInput(
                "CS2 discovery polling interval must be between 1 ms and 5 seconds".to_owned(),
            ));
        }
        self.discovery_poll_interval = interval;
        Ok(self)
    }
}

#[async_trait]
impl<B, R> GameController for PlatformGameController<B, R>
where
    B: DesktopBackend,
    R: ProcessRunner,
{
    fn discover_cs2(&self) -> RecordingResult<Vec<ProcessInfo>> {
        Ok(self.desktop.discover_processes("cs2.exe")?)
    }

    async fn launch_cs2(
        &self,
        executable: &Path,
        policy: LaunchPolicy,
        timeout: Duration,
        cancellation: &ProcessCancellation,
    ) -> RecordingResult<u32> {
        let file_name = executable
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if !file_name.eq_ignore_ascii_case("cs2.exe") {
            return Err(RecordingError::InvalidInput(
                "Windows CS2 executable must be named cs2.exe".to_owned(),
            ));
        }
        if timeout.is_zero() {
            return Err(RecordingError::InvalidInput(
                "CS2 launch timeout must be positive".to_owned(),
            ));
        }
        let mut spec = ProcessSpec::new(executable)?.detached();
        if policy.insecure {
            spec = spec.arg("-insecure")?;
        }
        if policy.skip_intro {
            spec = spec.arg("-novid")?;
        }
        if policy.windowed {
            spec = spec.arg("-windowed")?;
        }
        let launched = self.process_runner.run(&spec, cancellation).await?;
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if cancellation.is_cancelled() {
                return Err(RecordingError::Cancelled {
                    stage: "CS2 process discovery",
                });
            }
            if self
                .discover_cs2()?
                .iter()
                .any(|process| process.process_id == launched.process_id)
            {
                return Ok(launched.process_id);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(RecordingError::Timeout {
                    stage: "CS2 process discovery",
                });
            }
            tokio::select! {
                () = cancellation.cancelled() => {
                    return Err(RecordingError::Cancelled {
                        stage: "CS2 process discovery",
                    });
                }
                () = tokio::time::sleep(self.discovery_poll_interval) => {}
            }
        }
    }

    fn send_command(&self, process_id: u32, command: &ConsoleCommand) -> RecordingResult<()> {
        Cs2DesktopControl::new(&self.desktop)
            .send_command(process_id, command)
            .map_err(RecordingError::from)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use vibe_cs_platform_windows::{
        ConsoleInputPlan, ForegroundWindow, NativeWindowHandle, PlatformResult, ProcessOutcome,
    };

    use super::*;

    #[derive(Debug)]
    struct FakeDesktop {
        processes: Vec<ProcessInfo>,
    }

    impl DesktopBackend for FakeDesktop {
        fn discover_processes(&self, _executable_name: &str) -> PlatformResult<Vec<ProcessInfo>> {
            Ok(self.processes.clone())
        }

        fn foreground_window(&self) -> PlatformResult<ForegroundWindow> {
            Ok(ForegroundWindow {
                handle: NativeWindowHandle(1),
                process_id: self.processes[0].process_id,
            })
        }

        fn send_console_input(
            &self,
            _window: NativeWindowHandle,
            _expected_process_id: u32,
            _plan: &ConsoleInputPlan,
        ) -> PlatformResult<()> {
            Ok(())
        }
    }

    #[derive(Debug, Default)]
    struct FakeProcessRunner {
        specs: Mutex<Vec<ProcessSpec>>,
    }

    #[async_trait]
    impl ProcessRunner for FakeProcessRunner {
        async fn run(
            &self,
            spec: &ProcessSpec,
            _cancellation: &ProcessCancellation,
        ) -> PlatformResult<ProcessOutcome> {
            self.specs.lock().unwrap().push(spec.clone());
            Ok(ProcessOutcome {
                process_id: 42,
                exit_code: None,
            })
        }
    }

    #[tokio::test]
    async fn launch_uses_direct_typed_arguments_and_confirms_pid() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("cs2.exe");
        std::fs::write(&executable, b"stub").unwrap();
        let controller = PlatformGameController::new(
            FakeDesktop {
                processes: vec![ProcessInfo {
                    process_id: 42,
                    executable_name: "cs2.exe".to_owned(),
                }],
            },
            FakeProcessRunner::default(),
        );

        let process_id = controller
            .launch_cs2(
                &executable,
                LaunchPolicy::default(),
                Duration::from_secs(1),
                &ProcessCancellation::default(),
            )
            .await
            .unwrap();
        assert_eq!(process_id, 42);
        let specs = controller.process_runner.specs.lock().unwrap();
        assert!(!specs[0].wait_for_exit);
        assert_eq!(specs[0].args, ["-insecure", "-novid"]);
    }
}
