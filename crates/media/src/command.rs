use std::{ffi::OsString, path::PathBuf, sync::Arc};

use tokio::sync::watch;

use crate::FfmpegProgress;

pub type ProgressCallback = Arc<dyn Fn(FfmpegProgress) + Send + Sync>;

/// Validated, generated media-plan tokens. The `program` field is retained as
/// a compatibility label for persisted/debug plans; it is never executed.
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

#[cfg(test)]
mod tests {
    use super::*;

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
