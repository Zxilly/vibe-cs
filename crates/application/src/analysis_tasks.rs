use std::{
    collections::HashMap,
    sync::{Arc, Mutex, PoisonError},
};

use tokio::sync::watch;
use uuid::Uuid;
use vibe_cs_domain::AnalysisRun;

use crate::{AnalysisCancellation, AnalysisCancellationSource};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AnalysisTaskError {
    AlreadyOwned,
    OwnerUnavailable,
    CommitInProgress,
    OwnerStopped,
    CancellationRequested,
    CancellationCleanupFailed,
}

#[derive(Debug, Clone)]
enum CancellationCompletion {
    Pending,
    Cancelled(AnalysisRun),
    CleanupFailed,
    OwnerStopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AnalysisTaskPhase {
    Running,
    Cancelling,
    Committing,
}

#[derive(Debug)]
struct AnalysisTaskEntry {
    phase: AnalysisTaskPhase,
    cancellation_source: AnalysisCancellationSource,
    completion: watch::Sender<CancellationCompletion>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct AnalysisTaskRegistry {
    entries: Arc<Mutex<HashMap<Uuid, AnalysisTaskEntry>>>,
}

impl AnalysisTaskRegistry {
    pub(crate) fn register(&self, run_id: Uuid) -> Result<AnalysisTaskOwner, AnalysisTaskError> {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        if entries.contains_key(&run_id) {
            return Err(AnalysisTaskError::AlreadyOwned);
        }
        let (cancellation_source, cancellation) = AnalysisCancellation::channel();
        let (completion, _) = watch::channel(CancellationCompletion::Pending);
        entries.insert(
            run_id,
            AnalysisTaskEntry {
                phase: AnalysisTaskPhase::Running,
                cancellation_source,
                completion,
            },
        );
        Ok(AnalysisTaskOwner {
            registry: self.clone(),
            run_id,
            cancellation,
            finished: false,
        })
    }

    pub(crate) fn request_cancel(
        &self,
        run_id: Uuid,
    ) -> Result<AnalysisCancelWaiter, AnalysisTaskError> {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        let entry = entries
            .get_mut(&run_id)
            .ok_or(AnalysisTaskError::OwnerUnavailable)?;
        match entry.phase {
            AnalysisTaskPhase::Running => {
                entry.phase = AnalysisTaskPhase::Cancelling;
                entry.cancellation_source.cancel();
            }
            AnalysisTaskPhase::Cancelling => {}
            AnalysisTaskPhase::Committing => return Err(AnalysisTaskError::CommitInProgress),
        }
        Ok(AnalysisCancelWaiter {
            completion: entry.completion.subscribe(),
        })
    }

    pub(crate) fn has_owner(&self, run_id: Uuid) -> bool {
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(&run_id)
    }

    fn finish_cancelled(&self, run_id: Uuid, run: AnalysisRun) {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(entry) = entries.remove(&run_id) {
            entry
                .completion
                .send_replace(CancellationCompletion::Cancelled(run));
        }
    }

    fn try_begin_commit(&self, run_id: Uuid) -> Result<(), AnalysisTaskError> {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        let entry = entries
            .get_mut(&run_id)
            .ok_or(AnalysisTaskError::OwnerUnavailable)?;
        match entry.phase {
            AnalysisTaskPhase::Running => {
                entry.phase = AnalysisTaskPhase::Committing;
                Ok(())
            }
            AnalysisTaskPhase::Cancelling => Err(AnalysisTaskError::CancellationRequested),
            AnalysisTaskPhase::Committing => Err(AnalysisTaskError::CommitInProgress),
        }
    }

    fn finish_terminal(&self, run_id: Uuid) {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        entries.remove(&run_id);
    }

    fn finish_cancellation_cleanup_failed(&self, run_id: Uuid) {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(entry) = entries.remove(&run_id) {
            entry
                .completion
                .send_replace(CancellationCompletion::CleanupFailed);
        }
    }

    fn owner_stopped(&self, run_id: Uuid) {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(entry) = entries.remove(&run_id) {
            entry
                .completion
                .send_replace(CancellationCompletion::OwnerStopped);
        }
    }
}

#[derive(Debug)]
pub(crate) struct AnalysisTaskOwner {
    registry: AnalysisTaskRegistry,
    run_id: Uuid,
    cancellation: AnalysisCancellation,
    finished: bool,
}

impl AnalysisTaskOwner {
    pub(crate) fn cancellation(&self) -> AnalysisCancellation {
        self.cancellation.clone()
    }

    pub(crate) fn finish_cancelled(mut self, run: AnalysisRun) {
        self.registry.finish_cancelled(self.run_id, run);
        self.finished = true;
    }

    pub(crate) fn try_begin_commit(&self) -> Result<(), AnalysisTaskError> {
        self.registry.try_begin_commit(self.run_id)
    }

    pub(crate) fn finish_terminal(mut self) {
        self.registry.finish_terminal(self.run_id);
        self.finished = true;
    }

    pub(crate) fn finish_cancellation_cleanup_failed(mut self) {
        self.registry
            .finish_cancellation_cleanup_failed(self.run_id);
        self.finished = true;
    }
}

impl Drop for AnalysisTaskOwner {
    fn drop(&mut self) {
        if !self.finished {
            self.registry.owner_stopped(self.run_id);
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AnalysisCancelWaiter {
    completion: watch::Receiver<CancellationCompletion>,
}

impl AnalysisCancelWaiter {
    pub(crate) async fn wait(&self) -> Result<AnalysisRun, AnalysisTaskError> {
        let mut completion = self.completion.clone();
        loop {
            match completion.borrow().clone() {
                CancellationCompletion::Pending => {}
                CancellationCompletion::Cancelled(run) => return Ok(run),
                CancellationCompletion::CleanupFailed => {
                    return Err(AnalysisTaskError::CancellationCleanupFailed);
                }
                CancellationCompletion::OwnerStopped => {
                    return Err(AnalysisTaskError::OwnerStopped);
                }
            }
            completion
                .changed()
                .await
                .map_err(|_| AnalysisTaskError::OwnerStopped)?;
        }
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;
    use vibe_cs_domain::{AnalysisRun, AnalysisRunStage, AnalysisRunStatus};

    use super::*;

    fn cancelled_run(id: Uuid) -> AnalysisRun {
        let now = chrono::Utc::now();
        AnalysisRun {
            id,
            demo_id: Uuid::new_v4(),
            input_sha256: None,
            input_size: None,
            status: AnalysisRunStatus::Cancelled,
            stage: AnalysisRunStage::Cancelled,
            error: None,
            created_at: now,
            updated_at: now,
        }
    }

    #[tokio::test]
    async fn repeated_cancel_requests_wait_for_the_unique_owner_terminal_result() {
        let registry = AnalysisTaskRegistry::default();
        let run_id = Uuid::new_v4();
        let owner = registry.register(run_id).expect("unique owner");

        let first = registry.request_cancel(run_id).expect("first request");
        let second = registry.request_cancel(run_id).expect("shared request");
        assert!(owner.cancellation().is_cancelled());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), first.wait())
                .await
                .is_err(),
            "requesting cancellation must not claim that the owner stopped"
        );

        let cancelled = cancelled_run(run_id);
        owner.finish_cancelled(cancelled.clone());
        assert_eq!(first.wait().await.unwrap(), cancelled);
        assert_eq!(second.wait().await.unwrap(), cancelled);
    }

    #[tokio::test]
    async fn cancellation_cleanup_failure_wakes_every_waiter_without_claiming_cancelled() {
        let registry = AnalysisTaskRegistry::default();
        let run_id = Uuid::new_v4();
        let owner = registry.register(run_id).expect("unique owner");
        let first = registry.request_cancel(run_id).expect("first request");
        let second = registry.request_cancel(run_id).expect("shared request");

        owner.finish_cancellation_cleanup_failed();

        assert_eq!(
            first.wait().await.unwrap_err(),
            AnalysisTaskError::CancellationCleanupFailed
        );
        assert_eq!(
            second.wait().await.unwrap_err(),
            AnalysisTaskError::CancellationCleanupFailed
        );
        assert!(!registry.has_owner(run_id));
    }

    #[test]
    fn completion_and_cancellation_have_one_atomic_winner() {
        let registry = AnalysisTaskRegistry::default();
        let completing_id = Uuid::new_v4();
        let completing = registry.register(completing_id).unwrap();
        assert_eq!(completing.try_begin_commit(), Ok(()));
        assert_eq!(
            registry.request_cancel(completing_id).unwrap_err(),
            AnalysisTaskError::CommitInProgress
        );
        completing.finish_terminal();

        let cancelling_id = Uuid::new_v4();
        let cancelling = registry.register(cancelling_id).unwrap();
        let _waiter = registry.request_cancel(cancelling_id).unwrap();
        assert_eq!(
            cancelling.try_begin_commit(),
            Err(AnalysisTaskError::CancellationRequested)
        );
    }
}
