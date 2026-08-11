use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

use async_trait::async_trait;
use tokio::sync::watch;

#[cfg(windows)]
use crate::io_error;
use crate::{PlatformError, PlatformResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessSpec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub current_dir: Option<PathBuf>,
    pub wait_for_exit: bool,
}

impl ProcessSpec {
    /// Creates a direct process specification without a shell.
    ///
    /// # Errors
    ///
    /// Rejects non-absolute/non-file programs and control characters.
    pub fn new(program: impl Into<PathBuf>) -> PlatformResult<Self> {
        let program = program.into();
        validate_program(&program)?;
        Ok(Self {
            program,
            args: Vec::new(),
            current_dir: None,
            wait_for_exit: true,
        })
    }

    /// Adds one argv element.
    ///
    /// # Errors
    ///
    /// Rejects NUL, carriage-return, and newline characters.
    pub fn arg(mut self, argument: impl Into<OsString>) -> PlatformResult<Self> {
        let argument = argument.into();
        validate_os_argument(&argument)?;
        self.args.push(argument);
        Ok(self)
    }

    /// Sets an existing absolute working directory.
    ///
    /// # Errors
    ///
    /// Rejects missing, relative, or non-directory paths.
    pub fn current_dir(mut self, directory: impl Into<PathBuf>) -> PlatformResult<Self> {
        let directory = directory.into();
        validate_current_dir(&directory)?;
        self.current_dir = Some(directory);
        Ok(self)
    }

    #[must_use]
    pub const fn detached(mut self) -> Self {
        self.wait_for_exit = false;
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessOutcome {
    pub process_id: u32,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct ProcessCancellation {
    cancelled: watch::Sender<bool>,
}

impl Default for ProcessCancellation {
    fn default() -> Self {
        let (cancelled, _receiver) = watch::channel(false);
        Self { cancelled }
    }
}

impl ProcessCancellation {
    pub fn cancel(&self) {
        self.cancelled.send_replace(true);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        *self.cancelled.borrow()
    }

    /// Waits until cancellation is requested.
    pub async fn cancelled(&self) {
        let mut receiver = self.cancelled.subscribe();
        loop {
            if *receiver.borrow_and_update() {
                return;
            }
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }
}

#[async_trait]
pub trait ProcessRunner: Send + Sync {
    async fn run(
        &self,
        spec: &ProcessSpec,
        cancellation: &ProcessCancellation,
    ) -> PlatformResult<ProcessOutcome>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemProcessRunner;

#[cfg(windows)]
#[async_trait]
impl ProcessRunner for SystemProcessRunner {
    async fn run(
        &self,
        spec: &ProcessSpec,
        cancellation: &ProcessCancellation,
    ) -> PlatformResult<ProcessOutcome> {
        if cancellation.is_cancelled() {
            return Err(PlatformError::Cancelled { process_id: None });
        }
        validate_program(&spec.program)?;
        for argument in &spec.args {
            validate_os_argument(argument)?;
        }
        if let Some(directory) = &spec.current_dir {
            validate_current_dir(directory)?;
        }
        let mut command = tokio::process::Command::new(&spec.program);
        command
            .args(&spec.args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        if let Some(directory) = &spec.current_dir {
            command.current_dir(directory);
        }
        let mut child = command
            .spawn()
            .map_err(|error| io_error("launching process", &spec.program, error))?;
        let process_id = child.id().ok_or_else(|| {
            PlatformError::Windows("process started without an identifier".to_owned())
        })?;
        if !spec.wait_for_exit {
            return Ok(ProcessOutcome {
                process_id,
                exit_code: None,
            });
        }
        let status = tokio::select! {
            result = child.wait() => result.map_err(|error| {
                io_error("waiting for process", &spec.program, error)
            })?,
            () = cancellation.cancelled() => {
                // Cancellation stops our wait. It intentionally does not terminate CS2/OBS.
                return Err(PlatformError::Cancelled {
                    process_id: Some(process_id),
                });
            },
        };
        Ok(ProcessOutcome {
            process_id,
            exit_code: status.code(),
        })
    }
}

#[cfg(not(windows))]
#[async_trait]
impl ProcessRunner for SystemProcessRunner {
    async fn run(
        &self,
        _spec: &ProcessSpec,
        _cancellation: &ProcessCancellation,
    ) -> PlatformResult<ProcessOutcome> {
        Err(PlatformError::Unsupported)
    }
}

fn validate_program(program: &Path) -> PlatformResult<()> {
    if !program.is_absolute() || !program.is_file() {
        return Err(PlatformError::InvalidInput(
            "process program must be an existing absolute file".to_owned(),
        ));
    }
    validate_os_argument(program.as_os_str())
}

fn validate_os_argument(argument: &OsStr) -> PlatformResult<()> {
    let argument = argument.to_string_lossy();
    if argument.contains(['\0', '\r', '\n']) {
        return Err(PlatformError::InvalidInput(
            "process argument contains control characters".to_owned(),
        ));
    }
    Ok(())
}

fn validate_current_dir(directory: &Path) -> PlatformResult<()> {
    if !directory.is_absolute() || !directory.is_dir() {
        return Err(PlatformError::InvalidInput(
            "process working directory must be an existing absolute directory".to_owned(),
        ));
    }
    validate_os_argument(directory.as_os_str())
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[derive(Debug, Default)]
    struct FakeRunner {
        calls: Mutex<Vec<ProcessSpec>>,
    }

    #[derive(Debug, Default)]
    struct WaitingFakeRunner;

    #[async_trait]
    impl ProcessRunner for WaitingFakeRunner {
        async fn run(
            &self,
            _spec: &ProcessSpec,
            cancellation: &ProcessCancellation,
        ) -> PlatformResult<ProcessOutcome> {
            cancellation.cancelled().await;
            Err(PlatformError::Cancelled {
                process_id: Some(42),
            })
        }
    }

    #[async_trait]
    impl ProcessRunner for FakeRunner {
        async fn run(
            &self,
            spec: &ProcessSpec,
            cancellation: &ProcessCancellation,
        ) -> PlatformResult<ProcessOutcome> {
            if cancellation.is_cancelled() {
                return Err(PlatformError::Cancelled { process_id: None });
            }
            self.calls.lock().unwrap().push(spec.clone());
            Ok(ProcessOutcome {
                process_id: 42,
                exit_code: Some(0),
            })
        }
    }

    #[tokio::test]
    async fn injected_runner_honors_pre_cancellation() {
        let root = tempfile::tempdir().unwrap();
        let program = root.path().join("cs2.exe");
        std::fs::write(&program, b"stub").unwrap();
        let spec = ProcessSpec::new(program).unwrap();
        let cancellation = ProcessCancellation::default();
        cancellation.cancel();
        let runner = FakeRunner::default();
        assert!(matches!(
            runner.run(&spec, &cancellation).await,
            Err(PlatformError::Cancelled { process_id: None })
        ));
        assert!(runner.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn injected_runner_can_cancel_an_active_wait() {
        let root = tempfile::tempdir().unwrap();
        let program = root.path().join("cs2.exe");
        std::fs::write(&program, b"stub").unwrap();
        let spec = ProcessSpec::new(program).unwrap();
        let cancellation = ProcessCancellation::default();
        let cancel = cancellation.clone();
        let cancellation_task = async move {
            tokio::task::yield_now().await;
            cancel.cancel();
        };
        let (result, ()) = tokio::join!(
            WaitingFakeRunner.run(&spec, &cancellation),
            cancellation_task
        );
        assert!(matches!(
            result,
            Err(PlatformError::Cancelled {
                process_id: Some(42)
            })
        ));
    }

    #[tokio::test]
    async fn cancellation_state_reaches_registered_and_late_waiters() {
        let cancellation = ProcessCancellation::default();
        let registered = cancellation.clone();
        let waiter = tokio::spawn(async move { registered.cancelled().await });
        tokio::task::yield_now().await;
        cancellation.cancel();
        let late = cancellation.clone();
        let late_waiter = tokio::spawn(async move { late.cancelled().await });

        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            waiter.await.expect("registered waiter");
            late_waiter.await.expect("late waiter");
        })
        .await
        .expect("cancellation waiters must not lose the state change");
    }

    #[test]
    fn arguments_reject_line_controls() {
        let root = tempfile::tempdir().unwrap();
        let program = root.path().join("cs2.exe");
        std::fs::write(&program, b"stub").unwrap();
        assert!(matches!(
            ProcessSpec::new(program).unwrap().arg("+playdemo\nquit"),
            Err(PlatformError::InvalidInput(_))
        ));
    }

    #[test]
    fn working_directory_rejects_relative_paths() {
        let root = tempfile::tempdir().unwrap();
        let program = root.path().join("cs2.exe");
        std::fs::write(&program, b"stub").unwrap();
        assert!(matches!(
            ProcessSpec::new(program).unwrap().current_dir("relative"),
            Err(PlatformError::InvalidInput(_))
        ));
    }
}
