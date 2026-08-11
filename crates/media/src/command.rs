use std::{ffi::OsString, path::PathBuf, sync::Arc};

use async_trait::async_trait;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::Command,
    sync::watch,
};

use crate::{FfmpegProgress, MediaError, MediaResult, parse_ffmpeg_progress};

pub type ProgressCallback = Arc<dyn Fn(FfmpegProgress) + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
}

impl CommandSpec {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
        }
    }

    #[must_use]
    pub fn arg(mut self, value: impl Into<OsString>) -> Self {
        self.args.push(value.into());
        self
    }

    #[must_use]
    pub fn args(mut self, values: impl IntoIterator<Item = impl Into<OsString>>) -> Self {
        self.args.extend(values.into_iter().map(Into::into));
        self
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProcessOutput {
    pub status: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl ProcessOutput {
    /// Converts a non-zero exit status into a structured process error.
    ///
    /// # Errors
    ///
    /// Returns [`MediaError::ProcessFailed`] when the process was unsuccessful.
    pub fn ensure_success(self) -> MediaResult<Self> {
        if self.status == 0 {
            Ok(self)
        } else {
            Err(MediaError::ProcessFailed {
                status: self.status,
                message: String::from_utf8_lossy(&self.stderr).trim().to_owned(),
            })
        }
    }
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
        command: &CommandSpec,
        cancellation: &ProcessCancellation,
    ) -> MediaResult<ProcessOutput>;

    async fn run_with_progress(
        &self,
        command: &CommandSpec,
        cancellation: &ProcessCancellation,
        progress: ProgressCallback,
    ) -> MediaResult<ProcessOutput> {
        let output = self.run(command, cancellation).await?;
        progress(parse_ffmpeg_progress(&String::from_utf8_lossy(
            &output.stdout,
        )));
        Ok(output)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SystemProcessRunner {
    pub maximum_output_bytes: usize,
}

impl Default for SystemProcessRunner {
    fn default() -> Self {
        Self {
            maximum_output_bytes: 32 * 1024 * 1024,
        }
    }
}

#[async_trait]
impl ProcessRunner for SystemProcessRunner {
    async fn run(
        &self,
        command: &CommandSpec,
        cancellation: &ProcessCancellation,
    ) -> MediaResult<ProcessOutput> {
        if cancellation.is_cancelled() {
            return Err(MediaError::Cancelled);
        }
        let mut child = Command::new(&command.program);
        child
            .args(&command.args)
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = child.spawn().map_err(|error| MediaError::Io {
            path: command.program.clone(),
            source: error,
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            MediaError::InvalidToolOutput("child process stdout was not captured".to_owned())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            MediaError::InvalidToolOutput("child process stderr was not captured".to_owned())
        })?;
        let read_limit = u64::try_from(self.maximum_output_bytes)
            .unwrap_or(u64::MAX)
            .saturating_add(1);
        let stdout_task = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stdout
                .take(read_limit)
                .read_to_end(&mut bytes)
                .await
                .map(|_| bytes)
        });
        let stderr_task = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stderr
                .take(read_limit)
                .read_to_end(&mut bytes)
                .await
                .map(|_| bytes)
        });
        let status = tokio::select! {
            result = child.wait() => result.map_err(|error| MediaError::Io {
                path: command.program.clone(),
                source: error,
            })?,
            () = cancellation.cancelled() => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                stdout_task.abort();
                stderr_task.abort();
                return Err(MediaError::Cancelled);
            },
        };
        let stdout = stdout_task
            .await
            .map_err(|error| MediaError::InvalidToolOutput(error.to_string()))?
            .map_err(|error| MediaError::Io {
                path: command.program.clone(),
                source: error,
            })?;
        let stderr = stderr_task
            .await
            .map_err(|error| MediaError::InvalidToolOutput(error.to_string()))?
            .map_err(|error| MediaError::Io {
                path: command.program.clone(),
                source: error,
            })?;
        let total = stdout.len().saturating_add(stderr.len());
        if total > self.maximum_output_bytes {
            return Err(MediaError::OutputLimit {
                limit: self.maximum_output_bytes,
            });
        }
        Ok(ProcessOutput {
            status: status.code().unwrap_or(-1),
            stdout,
            stderr,
        })
    }

    async fn run_with_progress(
        &self,
        command: &CommandSpec,
        cancellation: &ProcessCancellation,
        progress: ProgressCallback,
    ) -> MediaResult<ProcessOutput> {
        if cancellation.is_cancelled() {
            return Err(MediaError::Cancelled);
        }
        let mut child = Command::new(&command.program);
        child
            .args(&command.args)
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = child.spawn().map_err(|error| MediaError::Io {
            path: command.program.clone(),
            source: error,
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            MediaError::InvalidToolOutput("child process stdout was not captured".to_owned())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            MediaError::InvalidToolOutput("child process stderr was not captured".to_owned())
        })?;
        let maximum = self.maximum_output_bytes;
        let stdout_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut output = Vec::new();
            let mut block = String::new();
            loop {
                let mut line = Vec::new();
                let read = reader.read_until(b'\n', &mut line).await?;
                if read == 0 {
                    break;
                }
                if output.len() <= maximum {
                    let remaining = maximum.saturating_add(1).saturating_sub(output.len());
                    output.extend_from_slice(&line[..line.len().min(remaining)]);
                }
                block.push_str(&String::from_utf8_lossy(&line));
                if line.starts_with(b"progress=") {
                    progress(parse_ffmpeg_progress(&block));
                    block.clear();
                }
            }
            Ok::<_, std::io::Error>(output)
        });
        let read_limit = u64::try_from(self.maximum_output_bytes)
            .unwrap_or(u64::MAX)
            .saturating_add(1);
        let stderr_task = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stderr
                .take(read_limit)
                .read_to_end(&mut bytes)
                .await
                .map(|_| bytes)
        });
        let status = tokio::select! {
            result = child.wait() => result.map_err(|error| MediaError::Io {
                path: command.program.clone(),
                source: error,
            })?,
            () = cancellation.cancelled() => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                stdout_task.abort();
                stderr_task.abort();
                return Err(MediaError::Cancelled);
            },
        };
        let stdout = stdout_task
            .await
            .map_err(|error| MediaError::InvalidToolOutput(error.to_string()))?
            .map_err(|error| MediaError::Io {
                path: command.program.clone(),
                source: error,
            })?;
        let stderr = stderr_task
            .await
            .map_err(|error| MediaError::InvalidToolOutput(error.to_string()))?
            .map_err(|error| MediaError::Io {
                path: command.program.clone(),
                source: error,
            })?;
        if stdout.len().saturating_add(stderr.len()) > self.maximum_output_bytes {
            return Err(MediaError::OutputLimit {
                limit: self.maximum_output_bytes,
            });
        }
        Ok(ProcessOutput {
            status: status.code().unwrap_or(-1),
            stdout,
            stderr,
        })
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use std::sync::Mutex;

    use super::*;

    #[derive(Debug, Default)]
    pub(crate) struct FakeRunner {
        pub(crate) commands: Mutex<Vec<CommandSpec>>,
        pub(crate) output: Mutex<ProcessOutput>,
    }

    #[async_trait]
    impl ProcessRunner for FakeRunner {
        async fn run(
            &self,
            command: &CommandSpec,
            cancellation: &ProcessCancellation,
        ) -> MediaResult<ProcessOutput> {
            if cancellation.is_cancelled() {
                return Err(MediaError::Cancelled);
            }
            self.commands.lock().unwrap().push(command.clone());
            Ok(self.output.lock().unwrap().clone())
        }
    }

    #[tokio::test]
    async fn fake_runner_honors_pre_cancelled_requests() {
        let runner = FakeRunner::default();
        let cancellation = ProcessCancellation::default();
        cancellation.cancel();
        assert!(matches!(
            runner.run(&CommandSpec::new("ffmpeg"), &cancellation).await,
            Err(MediaError::Cancelled)
        ));
        assert!(runner.commands.lock().unwrap().is_empty());
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
}
