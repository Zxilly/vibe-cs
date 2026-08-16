//! The Agent session retention sweeper.
//!
//! §10.1 gap 2: `POST /api/agent/workspace/storage/retention` existed and
//! nothing ever called it, so 「最近 50 条」 and 「30 天」 were policies the user
//! could set and the service would never enforce.
//!
//! ## Why this is here and not in the renderer
//!
//! §10.5 settled it: **the render process is not a scheduler.** Sweeping only
//! while a window is open turns 「30 天」 into 「30 天，如果你最近开过应用」, and
//! sweeping *at startup* is an irreversible delete with no user action behind
//! it — one that happens before the user can see, let alone correct, the policy
//! that caused it. A mis-set 「不保留」 would silently empty the workspace on the
//! next launch.
//!
//! So the sweep lives with the runtime, on a clock, and the settings panel
//! keeps its one explicit 「立即应用」 with a destructive confirmation.
//!
//! ## The first sweep is deliberately not immediate
//!
//! [`FIRST_SWEEP_DELAY`] passes before the first pass. That is the same
//! objection as startup-sweeping, softened rather than dismissed: a user who
//! launches the app, sees 「不保留」 and changes it within the delay never loses
//! anything. It is not a *guarantee* — five minutes is a guess about human
//! reaction time, not a contract — and the honest description is that it makes
//! the accident recoverable in the common case, not impossible.
//!
//! ## What a sweep does not touch
//!
//! Conversations only. Plans, recording tasks, edit projects and outputs a
//! session referenced are untouched, because a reference never implied
//! ownership — the same rule `delete_session` follows.

use std::time::Duration;

use tokio::time::MissedTickBehavior;
use vibe_cs_application::EventHub;
use vibe_cs_storage::Storage;

/// How long after startup the first sweep runs. See the module comment.
const FIRST_SWEEP_DELAY: Duration = Duration::from_secs(5 * 60);

/// How often afterwards. Retention is expressed in days and counts of fifty;
/// an hour is far finer than either, and the sweep is one indexed DELETE.
const SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// Starts the sweeper on the current runtime. The task lives as long as the
/// process — there is no stop handle because there is no caller that would use
/// one: the sweeper has no state to flush and dropping the runtime ends it.
pub(crate) fn start(storage: Storage, events: EventHub) {
    tokio::spawn(run(storage, events));
}

async fn run(storage: Storage, events: EventHub) {
    tokio::time::sleep(FIRST_SWEEP_DELAY).await;
    let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
    // A machine that slept through several intervals should sweep once on
    // waking, not run the backlog: every missed sweep would delete the same
    // rows the first one already did.
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        sweep_once(&storage, &events).await;
        ticker.tick().await;
    }
}

async fn sweep_once(storage: &Storage, events: &EventHub) {
    match storage.apply_agent_session_retention().await {
        Ok(0) => {}
        Ok(removed) => {
            tracing::info!(removed, "agent session retention policy removed sessions");
            // The drawer's session count changed underneath whatever is open.
            events.publish("agent_session", "retention_applied", None);
        }
        // A failed sweep is logged and retried on the next tick rather than
        // ending the task: the database being busy is a transient condition,
        // and a sweeper that stopped on the first one would leave the policy
        // unenforced for the rest of the session with nothing to say so.
        Err(error) => tracing::error!(%error, "agent session retention sweep failed"),
    }
}

#[cfg(test)]
mod tests {
    use vibe_cs_domain::{AgentSessionRetention, AgentWorkspaceSettings, CommentaryTone};

    use super::*;

    async fn storage() -> Storage {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("retention.sqlite");
        // The directory is kept alive by leaking it: the storage handle holds
        // the file open for the rest of the test and dropping the guard here
        // would remove it underneath.
        std::mem::forget(directory);
        Storage::open(&path).await.expect("storage")
    }

    fn settings(retention: AgentSessionRetention) -> AgentWorkspaceSettings {
        AgentWorkspaceSettings {
            session_retention: retention,
            take_limit: 5,
            auto_attach_context: true,
            preview_before_apply: true,
            show_evidence_reads: true,
            default_video_seconds: 40,
            default_shot_view: vibe_cs_domain::AgentShotView::Observer,
            commentary_tone: CommentaryTone::Professional,
        }
    }

    #[tokio::test]
    async fn a_sweep_enforces_the_stored_policy() {
        // 「最近 N 条」 rather than 「N 天」: sessions are created with the
        // current clock and there is no write path that back-dates one, so a
        // count is the policy this test can actually set up honestly.
        let storage = storage().await;
        for title in ["oldest", "newest"] {
            storage
                .create_agent_session(title.to_owned())
                .await
                .expect("session");
        }
        storage
            .set_agent_workspace_settings(settings(AgentSessionRetention::RecentCount { count: 1 }))
            .await
            .expect("settings");

        sweep_once(&storage, &EventHub::default()).await;

        let remaining = storage
            .list_agent_sessions(vibe_cs_domain::AgentSessionQuery::default())
            .await
            .expect("sessions");
        assert_eq!(remaining.items.len(), 1);
        assert_eq!(remaining.items[0].title, "newest");
    }

    #[tokio::test]
    async fn the_default_policy_removes_nothing() {
        // 「全部保留」 is the default, so a fresh install never loses a
        // conversation to a sweeper it was never told about.
        let storage = storage().await;
        storage
            .create_agent_session("kept".to_owned())
            .await
            .expect("session");

        sweep_once(&storage, &EventHub::default()).await;

        let remaining = storage
            .list_agent_sessions(vibe_cs_domain::AgentSessionQuery::default())
            .await
            .expect("sessions");
        assert_eq!(remaining.items.len(), 1);
    }
}
