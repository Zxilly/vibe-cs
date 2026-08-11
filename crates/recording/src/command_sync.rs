use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use vibe_cs_platform_windows::{ConsoleCommand, ProcessCancellation, ProcessInfo};

use crate::{
    GameController, LaunchPolicy, PlaybackSnapshot, PlaybackSnapshotSource, PlaybackSynchronizer,
    RecordingError, RecordingResult,
};

#[derive(Debug, Clone, PartialEq)]
pub struct CommandAcknowledgement<T> {
    pub value: T,
    pub sequence: u64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CommandEvidenceSnapshot {
    pub command_sequence: u64,
    pub demo: Option<CommandAcknowledgement<PathBuf>>,
    pub pause_sequence: Option<u64>,
    pub seek: Option<CommandAcknowledgement<u64>>,
    pub observer: Option<CommandAcknowledgement<String>>,
    pub timescale: Option<CommandAcknowledgement<f64>>,
    pub resume_sequence: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct CommandEvidenceStore {
    inner: Arc<Mutex<CommandEvidenceSnapshot>>,
}

impl CommandEvidenceStore {
    /// Returns a coherent copy of successful typed-command evidence.
    ///
    /// # Errors
    ///
    /// Returns an error if another thread panicked while updating evidence.
    pub fn snapshot(&self) -> RecordingResult<CommandEvidenceSnapshot> {
        self.inner
            .lock()
            .map(|state| state.clone())
            .map_err(|_| RecordingError::Preflight("command evidence lock is poisoned".to_owned()))
    }

    fn acknowledge(&self, command: &ConsoleCommand) -> RecordingResult<()> {
        let mut state = self.inner.lock().map_err(|_| {
            RecordingError::Preflight("command evidence lock is poisoned".to_owned())
        })?;
        state.command_sequence = state.command_sequence.saturating_add(1);
        let sequence = state.command_sequence;
        match command {
            ConsoleCommand::PlayDemo(path) => {
                state.demo = Some(CommandAcknowledgement {
                    value: path.clone(),
                    sequence,
                });
                state.pause_sequence = None;
                state.seek = None;
                state.observer = None;
                state.timescale = None;
                state.resume_sequence = None;
            }
            ConsoleCommand::Pause => {
                state.pause_sequence = Some(sequence);
                state.resume_sequence = None;
            }
            ConsoleCommand::GoToTick(tick) => {
                state.seek = Some(CommandAcknowledgement {
                    value: *tick,
                    sequence,
                });
            }
            ConsoleCommand::SpectatePlayer(player) => {
                state.observer = Some(CommandAcknowledgement {
                    value: player.clone(),
                    sequence,
                });
            }
            ConsoleCommand::Timescale(timescale) => {
                state.timescale = Some(CommandAcknowledgement {
                    value: *timescale,
                    sequence,
                });
            }
            ConsoleCommand::RadarVisibility(_)
            | ConsoleCommand::VoiceVolume(_)
            | ConsoleCommand::VoicePlayerVolume { .. }
            | ConsoleCommand::CameraFov(_)
            | ConsoleCommand::ViewmodelFov(_)
            | ConsoleCommand::FlashAlpha(_)
            | ConsoleCommand::GrenadeTrajectory(_)
            | ConsoleCommand::HudVisibility(_) => {}
            ConsoleCommand::Resume => state.resume_sequence = Some(sequence),
            ConsoleCommand::Disconnect => {
                *state = CommandEvidenceSnapshot {
                    command_sequence: sequence,
                    ..CommandEvidenceSnapshot::default()
                };
            }
        }
        Ok(())
    }
}

/// A game-controller decorator that records evidence only after the wrapped
/// controller successfully delivers an allowlisted typed command.
#[derive(Debug)]
pub struct CommandEvidenceGameController<G> {
    inner: G,
    evidence: CommandEvidenceStore,
}

impl<G> CommandEvidenceGameController<G> {
    #[must_use]
    pub const fn new(inner: G, evidence: CommandEvidenceStore) -> Self {
        Self { inner, evidence }
    }

    #[must_use]
    pub const fn inner(&self) -> &G {
        &self.inner
    }
}

#[async_trait]
impl<G> GameController for CommandEvidenceGameController<G>
where
    G: GameController,
{
    fn discover_cs2(&self) -> RecordingResult<Vec<ProcessInfo>> {
        self.inner.discover_cs2()
    }

    async fn launch_cs2(
        &self,
        executable: &Path,
        policy: LaunchPolicy,
        timeout: Duration,
        cancellation: &ProcessCancellation,
    ) -> RecordingResult<u32> {
        self.inner
            .launch_cs2(executable, policy, timeout, cancellation)
            .await
    }

    fn send_command(&self, process_id: u32, command: &ConsoleCommand) -> RecordingResult<()> {
        self.inner.send_command(process_id, command)?;
        self.evidence.acknowledge(command)
    }
}

#[async_trait]
pub trait MonotonicClock: Send + Sync {
    /// Returns elapsed monotonic time from an arbitrary process-local origin.
    fn now(&self) -> Duration;

    /// Sleeps using the same monotonic time source.
    async fn sleep(&self, duration: Duration);
}

#[derive(Debug, Clone)]
pub struct TokioMonotonicClock {
    origin: tokio::time::Instant,
}

impl Default for TokioMonotonicClock {
    fn default() -> Self {
        Self {
            origin: tokio::time::Instant::now(),
        }
    }
}

#[async_trait]
impl MonotonicClock for TokioMonotonicClock {
    fn now(&self) -> Duration {
        tokio::time::Instant::now().duration_since(self.origin)
    }

    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

/// Synchronizes playback from successful command acknowledgements plus fresh
/// GSI-style heartbeats. It intentionally does **not** claim direct tick telemetry.
#[derive(Debug)]
pub struct CommandAcknowledgedPlaybackSynchronizer<S, C = TokioMonotonicClock> {
    evidence: CommandEvidenceStore,
    source: S,
    clock: C,
    poll_interval: Duration,
    maximum_heartbeat_gap: Duration,
    confirmed_seek: Mutex<Option<ConfirmedSeek>>,
    confirmed_observer: Mutex<Option<ConfirmedObserver>>,
}

impl<S> CommandAcknowledgedPlaybackSynchronizer<S, TokioMonotonicClock> {
    #[must_use]
    pub fn new(evidence: CommandEvidenceStore, source: S) -> Self {
        Self::with_clock(evidence, source, TokioMonotonicClock::default())
    }
}

impl<S, C> CommandAcknowledgedPlaybackSynchronizer<S, C> {
    #[must_use]
    pub fn with_clock(evidence: CommandEvidenceStore, source: S, clock: C) -> Self {
        Self {
            evidence,
            source,
            clock,
            poll_interval: Duration::from_millis(50),
            maximum_heartbeat_gap: Duration::from_secs(3),
            confirmed_seek: Mutex::new(None),
            confirmed_observer: Mutex::new(None),
        }
    }

    /// Configures heartbeat polling and the largest acceptable heartbeat gap.
    ///
    /// # Errors
    ///
    /// Rejects zero values, a gap shorter than polling, or limits over 30 seconds.
    pub fn with_limits(
        mut self,
        poll_interval: Duration,
        maximum_heartbeat_gap: Duration,
    ) -> RecordingResult<Self> {
        if poll_interval.is_zero()
            || maximum_heartbeat_gap < poll_interval
            || maximum_heartbeat_gap > Duration::from_secs(30)
        {
            return Err(RecordingError::InvalidInput(
                "command-acknowledged heartbeat limits are invalid".to_owned(),
            ));
        }
        self.poll_interval = poll_interval;
        self.maximum_heartbeat_gap = maximum_heartbeat_gap;
        Ok(self)
    }
}

#[derive(Debug, Clone, Copy)]
struct ConfirmedSeek {
    tick: u64,
    command_sequence: u64,
}

#[derive(Debug, Clone)]
struct ConfirmedObserver {
    player_id: String,
    command_sequence: u64,
}

#[derive(Debug)]
struct HeartbeatWait {
    matched: bool,
    last: Option<PlaybackSnapshot>,
}

impl<S, C> CommandAcknowledgedPlaybackSynchronizer<S, C>
where
    S: PlaybackSnapshotSource,
    C: MonotonicClock,
{
    async fn wait_for_post_command_heartbeat<F>(
        &self,
        stage: &'static str,
        timeout: Duration,
        cancellation: &ProcessCancellation,
        mut predicate: F,
    ) -> RecordingResult<HeartbeatWait>
    where
        F: FnMut(&PlaybackSnapshot) -> bool,
    {
        if timeout.is_zero() {
            return Err(RecordingError::InvalidInput(
                "heartbeat confirmation timeout must be positive".to_owned(),
            ));
        }
        let baseline = self
            .source
            .snapshot()
            .await?
            .map_or(0, |snapshot| snapshot.sequence);
        let started = self.clock.now();
        let mut last = None;
        loop {
            if cancellation.is_cancelled() {
                return Err(RecordingError::Cancelled { stage });
            }
            if let Some(snapshot) = self.source.snapshot().await?
                && snapshot.sequence > baseline
                && snapshot.ready
            {
                let matched = predicate(&snapshot);
                last = Some(snapshot);
                if matched {
                    return Ok(HeartbeatWait {
                        matched: true,
                        last,
                    });
                }
            }
            if monotonic_elapsed(self.clock.now(), started)? >= timeout {
                return Ok(HeartbeatWait {
                    matched: false,
                    last,
                });
            }
            tokio::select! {
                () = cancellation.cancelled() => {
                    return Err(RecordingError::Cancelled { stage });
                }
                () = self.clock.sleep(self.poll_interval) => {}
            }
        }
    }

    fn ensure_evidence_unchanged(&self, sequence: u64) -> RecordingResult<()> {
        if self.evidence.snapshot()?.command_sequence == sequence {
            Ok(())
        } else {
            Err(RecordingError::Preflight(
                "playback command evidence changed during heartbeat confirmation".to_owned(),
            ))
        }
    }
}

#[async_trait]
impl<S, C> PlaybackSynchronizer for CommandAcknowledgedPlaybackSynchronizer<S, C>
where
    S: PlaybackSnapshotSource,
    C: MonotonicClock,
{
    async fn confirm_demo_ready(
        &self,
        demo_path: &Path,
        timeout: Duration,
        cancellation: &ProcessCancellation,
    ) -> RecordingResult<()> {
        let state = self.evidence.snapshot()?;
        let acknowledgement = state.demo.ok_or_else(|| {
            RecordingError::Preflight("no successful playdemo command evidence".to_owned())
        })?;
        if acknowledgement.value != demo_path {
            return Err(RecordingError::Preflight(
                "playdemo command evidence belongs to another demo".to_owned(),
            ));
        }
        let waited = self
            .wait_for_post_command_heartbeat(
                "post-playdemo heartbeat",
                timeout,
                cancellation,
                |_| true,
            )
            .await?;
        self.ensure_evidence_unchanged(state.command_sequence)?;
        if waited.matched {
            Ok(())
        } else {
            Err(RecordingError::Timeout {
                stage: "post-playdemo CS2 heartbeat",
            })
        }
    }

    async fn confirm_tick(
        &self,
        tick: u64,
        timeout: Duration,
        cancellation: &ProcessCancellation,
    ) -> RecordingResult<()> {
        let state = self.evidence.snapshot()?;
        let demo_sequence = state
            .demo
            .as_ref()
            .map(|item| item.sequence)
            .ok_or_else(|| {
                RecordingError::Preflight("no successful playdemo command evidence".to_owned())
            })?;
        let pause_sequence = state.pause_sequence.ok_or_else(|| {
            RecordingError::Preflight("no successful pause command evidence".to_owned())
        })?;
        let seek = state.seek.ok_or_else(|| {
            RecordingError::Preflight("no successful seek command evidence".to_owned())
        })?;
        if seek.value != tick || !(demo_sequence < pause_sequence && pause_sequence < seek.sequence)
        {
            return Err(RecordingError::Preflight(
                "seek command evidence is missing, stale, or for another tick".to_owned(),
            ));
        }
        let waited = self
            .wait_for_post_command_heartbeat("post-seek heartbeat", timeout, cancellation, |_| true)
            .await?;
        self.ensure_evidence_unchanged(state.command_sequence)?;
        if !waited.matched {
            return Err(RecordingError::Timeout {
                stage: "post-seek CS2 heartbeat",
            });
        }
        *self.confirmed_seek.lock().map_err(|_| {
            RecordingError::Preflight("confirmed seek lock is poisoned".to_owned())
        })? = Some(ConfirmedSeek {
            tick,
            command_sequence: seek.sequence,
        });
        Ok(())
    }

    async fn confirm_observer(
        &self,
        player_id: &str,
        timeout: Duration,
        cancellation: &ProcessCancellation,
    ) -> RecordingResult<()> {
        let state = self.evidence.snapshot()?;
        let seek_sequence = state
            .seek
            .as_ref()
            .map(|item| item.sequence)
            .ok_or_else(|| {
                RecordingError::Preflight("no successful seek command evidence".to_owned())
            })?;
        let observer = state.observer.ok_or_else(|| {
            RecordingError::Preflight("no successful spectator command evidence".to_owned())
        })?;
        if observer.value != player_id || observer.sequence <= seek_sequence {
            return Err(RecordingError::Preflight(
                "spectator command evidence is stale or for another player".to_owned(),
            ));
        }
        let waited = self
            .wait_for_post_command_heartbeat(
                "observer heartbeat",
                timeout,
                cancellation,
                |snapshot| snapshot.observed_player_id.as_deref() == Some(player_id),
            )
            .await?;
        self.ensure_evidence_unchanged(state.command_sequence)?;
        if waited.matched {
            *self.confirmed_observer.lock().map_err(|_| {
                RecordingError::Preflight("confirmed observer lock is poisoned".to_owned())
            })? = Some(ConfirmedObserver {
                player_id: player_id.to_owned(),
                command_sequence: observer.sequence,
            });
            return Ok(());
        }
        if let Some(actual) = waited.last.and_then(|snapshot| snapshot.observed_player_id) {
            Err(RecordingError::ObserverMismatch {
                expected: player_id.to_owned(),
                actual,
            })
        } else {
            Err(RecordingError::Timeout {
                stage: "verified observer heartbeat",
            })
        }
    }

    async fn wait_until_tick(
        &self,
        tick: u64,
        tick_rate: f64,
        timeout: Duration,
        cancellation: &ProcessCancellation,
    ) -> RecordingResult<()> {
        if !tick_rate.is_finite() || !(1.0..=256.0).contains(&tick_rate) || timeout.is_zero() {
            return Err(RecordingError::InvalidInput(
                "segment clock tick rate or timeout is invalid".to_owned(),
            ));
        }
        let confirmed = self
            .confirmed_seek
            .lock()
            .map_err(|_| RecordingError::Preflight("confirmed seek lock is poisoned".to_owned()))?
            .ok_or_else(|| {
                RecordingError::Preflight("start tick has not been heartbeat-confirmed".to_owned())
            })?;
        if tick <= confirmed.tick {
            return Err(RecordingError::InvalidInput(
                "segment end tick must follow its confirmed start tick".to_owned(),
            ));
        }
        let state = self.evidence.snapshot()?;
        let seek = state
            .seek
            .as_ref()
            .ok_or_else(|| RecordingError::Preflight("seek evidence disappeared".to_owned()))?;
        let timescale = state.timescale.as_ref().ok_or_else(|| {
            RecordingError::Preflight("no successful timescale command evidence".to_owned())
        })?;
        let resume_sequence = state.resume_sequence.ok_or_else(|| {
            RecordingError::Preflight("no successful resume command evidence".to_owned())
        })?;
        let confirmed_observer = self
            .confirmed_observer
            .lock()
            .map_err(|_| {
                RecordingError::Preflight("confirmed observer lock is poisoned".to_owned())
            })?
            .clone()
            .ok_or_else(|| {
                RecordingError::Preflight("observer has not been heartbeat-confirmed".to_owned())
            })?;
        let observer = state.observer.as_ref().ok_or_else(|| {
            RecordingError::Preflight("spectator evidence disappeared".to_owned())
        })?;
        if seek.sequence != confirmed.command_sequence
            || seek.value != confirmed.tick
            || observer.sequence != confirmed_observer.command_sequence
            || observer.value != confirmed_observer.player_id
            || !timescale.value.is_finite()
            || !(0.1..=8.0).contains(&timescale.value)
            || timescale.sequence <= observer.sequence
            || resume_sequence <= timescale.sequence
        {
            return Err(RecordingError::Preflight(
                "segment clock command evidence is stale or out of order".to_owned(),
            ));
        }
        let tick_span = u32::try_from(tick - confirmed.tick).map_err(|_| {
            RecordingError::InvalidInput("segment tick span exceeds the supported range".to_owned())
        })?;
        let playback_duration =
            Duration::try_from_secs_f64(f64::from(tick_span) / tick_rate / timescale.value)
                .map_err(|_| {
                    RecordingError::InvalidInput("segment clock is out of range".to_owned())
                })?;
        if playback_duration.is_zero() || playback_duration > timeout {
            return Err(RecordingError::InvalidInput(
                "segment clock duration exceeds its timeout".to_owned(),
            ));
        }

        let baseline = self
            .source
            .snapshot()
            .await?
            .map_or(0, |snapshot| snapshot.sequence);
        let started = self.clock.now();
        let mut last_heartbeat_at = started;
        let mut last_sequence = baseline;
        let mut saw_post_resume_heartbeat = false;
        loop {
            if cancellation.is_cancelled() {
                return Err(RecordingError::Cancelled {
                    stage: "command-acknowledged segment clock",
                });
            }
            self.ensure_evidence_unchanged(state.command_sequence)?;
            if let Some(snapshot) = self.source.snapshot().await?
                && snapshot.ready
                && snapshot.sequence > last_sequence
            {
                last_sequence = snapshot.sequence;
                last_heartbeat_at = self.clock.now();
                saw_post_resume_heartbeat = snapshot.sequence > baseline;
            }
            let now = self.clock.now();
            let elapsed = monotonic_elapsed(now, started)?;
            if elapsed >= playback_duration && saw_post_resume_heartbeat {
                return Ok(());
            }
            if elapsed >= timeout {
                return Err(RecordingError::Timeout {
                    stage: "command-acknowledged segment clock",
                });
            }
            if monotonic_elapsed(now, last_heartbeat_at)? >= self.maximum_heartbeat_gap {
                return Err(RecordingError::Timeout {
                    stage: "continuous CS2 heartbeat",
                });
            }
            tokio::select! {
                () = cancellation.cancelled() => {
                    return Err(RecordingError::Cancelled {
                        stage: "command-acknowledged segment clock",
                    });
                }
                () = self.clock.sleep(self.poll_interval) => {}
            }
        }
    }
}

fn monotonic_elapsed(now: Duration, earlier: Duration) -> RecordingResult<Duration> {
    now.checked_sub(earlier)
        .ok_or_else(|| RecordingError::Preflight("monotonic clock moved backwards".to_owned()))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    use super::*;

    #[derive(Debug, Default)]
    struct FakeGame;

    #[async_trait]
    impl GameController for FakeGame {
        fn discover_cs2(&self) -> RecordingResult<Vec<ProcessInfo>> {
            Ok(Vec::new())
        }

        async fn launch_cs2(
            &self,
            _executable: &Path,
            _policy: LaunchPolicy,
            _timeout: Duration,
            _cancellation: &ProcessCancellation,
        ) -> RecordingResult<u32> {
            Ok(7)
        }

        fn send_command(&self, _process_id: u32, _command: &ConsoleCommand) -> RecordingResult<()> {
            Ok(())
        }
    }

    #[derive(Debug, Default)]
    struct FakeClock {
        nanoseconds: AtomicU64,
    }

    #[async_trait]
    impl MonotonicClock for FakeClock {
        fn now(&self) -> Duration {
            Duration::from_nanos(self.nanoseconds.load(Ordering::SeqCst))
        }

        async fn sleep(&self, duration: Duration) {
            let nanoseconds = u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX);
            self.nanoseconds.fetch_add(nanoseconds, Ordering::SeqCst);
            tokio::task::yield_now().await;
        }
    }

    #[derive(Debug)]
    struct AdvancingHeartbeatSource {
        sequence: AtomicU64,
        observer: String,
        calls: AtomicUsize,
        cancellation: Option<(ProcessCancellation, usize)>,
    }

    #[async_trait]
    impl PlaybackSnapshotSource for AdvancingHeartbeatSource {
        async fn snapshot(&self) -> RecordingResult<Option<PlaybackSnapshot>> {
            let calls = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            if let Some((cancellation, cancel_at)) = &self.cancellation
                && calls >= *cancel_at
            {
                cancellation.cancel();
            }
            Ok(Some(PlaybackSnapshot {
                sequence: self.sequence.fetch_add(1, Ordering::SeqCst) + 1,
                ready: true,
                demo_path: None,
                tick: None,
                observed_player_id: Some(self.observer.clone()),
            }))
        }
    }

    #[derive(Debug)]
    struct FixedHeartbeatSource {
        observer: String,
    }

    #[async_trait]
    impl PlaybackSnapshotSource for FixedHeartbeatSource {
        async fn snapshot(&self) -> RecordingResult<Option<PlaybackSnapshot>> {
            Ok(Some(PlaybackSnapshot {
                sequence: 1,
                ready: true,
                demo_path: None,
                tick: None,
                observed_player_id: Some(self.observer.clone()),
            }))
        }
    }

    fn issue_commands(
        controller: &CommandEvidenceGameController<FakeGame>,
        demo: &Path,
        timescale: f64,
    ) {
        for command in [
            ConsoleCommand::PlayDemo(demo.to_path_buf()),
            ConsoleCommand::Pause,
            ConsoleCommand::GoToTick(100),
            ConsoleCommand::SpectatePlayer("player-1".to_owned()),
            ConsoleCommand::Timescale(timescale),
            ConsoleCommand::Resume,
        ] {
            controller.send_command(7, &command).unwrap();
        }
    }

    fn advancing_source(observer: &str) -> AdvancingHeartbeatSource {
        AdvancingHeartbeatSource {
            sequence: AtomicU64::new(0),
            observer: observer.to_owned(),
            calls: AtomicUsize::new(0),
            cancellation: None,
        }
    }

    async fn confirm_start<S, C>(
        synchronizer: &CommandAcknowledgedPlaybackSynchronizer<S, C>,
        demo: &Path,
        cancellation: &ProcessCancellation,
    ) where
        S: PlaybackSnapshotSource,
        C: MonotonicClock,
    {
        synchronizer
            .confirm_demo_ready(demo, Duration::from_secs(1), cancellation)
            .await
            .unwrap();
        synchronizer
            .confirm_tick(100, Duration::from_secs(1), cancellation)
            .await
            .unwrap();
        synchronizer
            .confirm_observer("player-1", Duration::from_secs(1), cancellation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn command_evidence_and_fresh_heartbeats_complete_a_segment() {
        let evidence = CommandEvidenceStore::default();
        let game = CommandEvidenceGameController::new(FakeGame, evidence.clone());
        let demo = PathBuf::from("C:\\demos\\match.dem");
        issue_commands(&game, &demo, 1.0);
        let synchronizer = CommandAcknowledgedPlaybackSynchronizer::with_clock(
            evidence,
            advancing_source("player-1"),
            FakeClock::default(),
        )
        .with_limits(Duration::from_millis(10), Duration::from_millis(100))
        .unwrap();
        let cancellation = ProcessCancellation::default();
        confirm_start(&synchronizer, &demo, &cancellation).await;
        synchronizer
            .wait_until_tick(200, 100.0, Duration::from_secs(2), &cancellation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn unchanged_heartbeat_cannot_acknowledge_playdemo() {
        let evidence = CommandEvidenceStore::default();
        let game = CommandEvidenceGameController::new(FakeGame, evidence.clone());
        let demo = PathBuf::from("C:\\demos\\match.dem");
        game.send_command(7, &ConsoleCommand::PlayDemo(demo.clone()))
            .unwrap();
        let synchronizer = CommandAcknowledgedPlaybackSynchronizer::with_clock(
            evidence,
            FixedHeartbeatSource {
                observer: "player-1".to_owned(),
            },
            FakeClock::default(),
        )
        .with_limits(Duration::from_millis(10), Duration::from_millis(100))
        .unwrap();
        assert!(matches!(
            synchronizer
                .confirm_demo_ready(
                    &demo,
                    Duration::from_millis(30),
                    &ProcessCancellation::default()
                )
                .await,
            Err(RecordingError::Timeout { .. })
        ));
    }

    #[tokio::test]
    async fn observer_still_requires_an_exact_gsi_match() {
        let evidence = CommandEvidenceStore::default();
        let game = CommandEvidenceGameController::new(FakeGame, evidence.clone());
        let demo = PathBuf::from("C:\\demos\\match.dem");
        issue_commands(&game, &demo, 1.0);
        let synchronizer = CommandAcknowledgedPlaybackSynchronizer::with_clock(
            evidence,
            advancing_source("wrong-player"),
            FakeClock::default(),
        )
        .with_limits(Duration::from_millis(10), Duration::from_millis(100))
        .unwrap();
        let cancellation = ProcessCancellation::default();
        synchronizer
            .confirm_demo_ready(&demo, Duration::from_secs(1), &cancellation)
            .await
            .unwrap();
        synchronizer
            .confirm_tick(100, Duration::from_secs(1), &cancellation)
            .await
            .unwrap();
        assert!(matches!(
            synchronizer
                .confirm_observer("player-1", Duration::from_millis(30), &cancellation)
                .await,
            Err(RecordingError::ObserverMismatch { .. })
        ));
    }

    #[tokio::test]
    async fn segment_clock_is_cooperatively_cancellable() {
        let evidence = CommandEvidenceStore::default();
        let game = CommandEvidenceGameController::new(FakeGame, evidence.clone());
        let demo = PathBuf::from("C:\\demos\\match.dem");
        issue_commands(&game, &demo, 1.0);
        let cancellation = ProcessCancellation::default();
        let source = AdvancingHeartbeatSource {
            cancellation: Some((cancellation.clone(), 9)),
            ..advancing_source("player-1")
        };
        let synchronizer = CommandAcknowledgedPlaybackSynchronizer::with_clock(
            evidence,
            source,
            FakeClock::default(),
        )
        .with_limits(Duration::from_millis(10), Duration::from_millis(100))
        .unwrap();
        confirm_start(&synchronizer, &demo, &cancellation).await;
        assert!(matches!(
            synchronizer
                .wait_until_tick(10_000, 100.0, Duration::from_secs(200), &cancellation)
                .await,
            Err(RecordingError::Cancelled { .. })
        ));
    }

    #[tokio::test]
    async fn double_timescale_halves_the_monotonic_wait() {
        let evidence = CommandEvidenceStore::default();
        let game = CommandEvidenceGameController::new(FakeGame, evidence.clone());
        let demo = PathBuf::from("C:\\demos\\match.dem");
        issue_commands(&game, &demo, 2.0);
        let synchronizer = CommandAcknowledgedPlaybackSynchronizer::with_clock(
            evidence,
            advancing_source("player-1"),
            FakeClock::default(),
        )
        .with_limits(Duration::from_millis(10), Duration::from_millis(100))
        .unwrap();
        let cancellation = ProcessCancellation::default();
        confirm_start(&synchronizer, &demo, &cancellation).await;
        synchronizer
            .wait_until_tick(200, 100.0, Duration::from_secs(1), &cancellation)
            .await
            .unwrap();
        let elapsed = synchronizer.clock.now();
        assert!(elapsed >= Duration::from_millis(500));
        assert!(elapsed < Duration::from_millis(520));
    }
}
