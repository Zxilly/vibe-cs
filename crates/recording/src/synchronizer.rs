use std::{path::Path, sync::Arc, time::Duration};

use async_trait::async_trait;
use chrono::Utc;
use tokio::sync::RwLock;
use vibe_cs_integrations::GsiState;
use vibe_cs_platform_windows::ProcessCancellation;

use crate::{
    PlaybackSnapshot, PlaybackSnapshotSource, PlaybackSynchronizer, RecordingError, RecordingResult,
};

#[derive(Debug)]
pub struct SystemPlaybackSynchronizer<S> {
    source: S,
    poll_interval: Duration,
    tick_tolerance: u64,
}

impl<S> SystemPlaybackSynchronizer<S> {
    #[must_use]
    pub const fn new(source: S) -> Self {
        Self {
            source,
            poll_interval: Duration::from_millis(50),
            tick_tolerance: 2,
        }
    }

    /// Sets bounded polling and seek tolerance values.
    ///
    /// # Errors
    ///
    /// Rejects zero/large polling intervals and excessive tick tolerance.
    pub fn with_limits(
        mut self,
        poll_interval: Duration,
        tick_tolerance: u64,
    ) -> RecordingResult<Self> {
        if poll_interval.is_zero() || poll_interval > Duration::from_secs(5) || tick_tolerance > 128
        {
            return Err(RecordingError::InvalidInput(
                "playback synchronization limits are invalid".to_owned(),
            ));
        }
        self.poll_interval = poll_interval;
        self.tick_tolerance = tick_tolerance;
        Ok(self)
    }

    async fn wait_for<F>(
        &self,
        stage: &'static str,
        timeout: Duration,
        cancellation: &ProcessCancellation,
        mut predicate: F,
    ) -> RecordingResult<Option<PlaybackSnapshot>>
    where
        S: PlaybackSnapshotSource,
        F: FnMut(&PlaybackSnapshot) -> bool,
    {
        if timeout.is_zero() {
            return Err(RecordingError::InvalidInput(
                "playback synchronization timeout must be positive".to_owned(),
            ));
        }
        let deadline = tokio::time::Instant::now() + timeout;
        let mut last = None;
        loop {
            if cancellation.is_cancelled() {
                return Err(RecordingError::Cancelled { stage });
            }
            if let Some(snapshot) = self.source.snapshot().await? {
                if predicate(&snapshot) {
                    return Ok(Some(snapshot));
                }
                last = Some(snapshot);
            }
            if tokio::time::Instant::now() >= deadline {
                return Ok(last);
            }
            tokio::select! {
                () = cancellation.cancelled() => {
                    return Err(RecordingError::Cancelled { stage });
                }
                () = tokio::time::sleep(self.poll_interval) => {}
            }
        }
    }
}

#[async_trait]
impl<S> PlaybackSynchronizer for SystemPlaybackSynchronizer<S>
where
    S: PlaybackSnapshotSource,
{
    async fn confirm_demo_ready(
        &self,
        demo_path: &Path,
        timeout: Duration,
        cancellation: &ProcessCancellation,
    ) -> RecordingResult<()> {
        let confirmed = self
            .wait_for("demo readiness", timeout, cancellation, |snapshot| {
                snapshot.ready && snapshot.demo_path.as_deref() == Some(demo_path)
            })
            .await?;
        if confirmed.is_some_and(|snapshot| {
            snapshot.ready && snapshot.demo_path.as_deref() == Some(demo_path)
        }) {
            Ok(())
        } else {
            Err(RecordingError::Timeout {
                stage: "verified demo readiness",
            })
        }
    }

    async fn confirm_tick(
        &self,
        tick: u64,
        timeout: Duration,
        cancellation: &ProcessCancellation,
    ) -> RecordingResult<()> {
        let tolerance = self.tick_tolerance;
        let confirmed = self
            .wait_for("demo seek", timeout, cancellation, |snapshot| {
                snapshot
                    .tick
                    .is_some_and(|actual| actual.abs_diff(tick) <= tolerance)
            })
            .await?;
        if confirmed.is_some_and(|snapshot| {
            snapshot
                .tick
                .is_some_and(|actual| actual.abs_diff(tick) <= tolerance)
        }) {
            Ok(())
        } else {
            Err(RecordingError::Timeout {
                stage: "verified demo seek",
            })
        }
    }

    async fn confirm_observer(
        &self,
        player_id: &str,
        timeout: Duration,
        cancellation: &ProcessCancellation,
    ) -> RecordingResult<()> {
        let confirmed = self
            .wait_for("observer selection", timeout, cancellation, |snapshot| {
                snapshot.observed_player_id.as_deref() == Some(player_id)
            })
            .await?;
        match confirmed.and_then(|snapshot| snapshot.observed_player_id) {
            Some(actual) if actual == player_id => Ok(()),
            Some(actual) => Err(RecordingError::ObserverMismatch {
                expected: player_id.to_owned(),
                actual,
            }),
            None => Err(RecordingError::Timeout {
                stage: "verified observer selection",
            }),
        }
    }

    async fn wait_until_tick(
        &self,
        tick: u64,
        _tick_rate: f64,
        timeout: Duration,
        cancellation: &ProcessCancellation,
    ) -> RecordingResult<()> {
        let confirmed = self
            .wait_for("segment end tick", timeout, cancellation, |snapshot| {
                snapshot.tick.is_some_and(|actual| actual >= tick)
            })
            .await?;
        if confirmed.is_some_and(|snapshot| snapshot.tick.is_some_and(|actual| actual >= tick)) {
            Ok(())
        } else {
            Err(RecordingError::Timeout {
                stage: "verified segment end tick",
            })
        }
    }
}

#[derive(Debug, Clone)]
pub struct GsiStateSnapshotSource {
    state: Arc<RwLock<GsiState>>,
    maximum_age: chrono::Duration,
}

impl GsiStateSnapshotSource {
    #[must_use]
    pub const fn new(state: Arc<RwLock<GsiState>>, maximum_age: chrono::Duration) -> Self {
        Self { state, maximum_age }
    }
}

#[async_trait]
impl PlaybackSnapshotSource for GsiStateSnapshotSource {
    async fn snapshot(&self) -> RecordingResult<Option<PlaybackSnapshot>> {
        let state = self.state.read().await;
        let Some(payload) = state.latest.as_ref() else {
            return Ok(None);
        };
        let fresh = state.is_fresh(Utc::now(), self.maximum_age);
        let is_cs2 = payload
            .provider
            .as_ref()
            .and_then(|provider| provider.appid)
            .is_some_and(|appid| appid == 730);
        let active = payload
            .player
            .as_ref()
            .and_then(|player| player.activity.as_deref())
            .is_some_and(|activity| {
                activity.eq_ignore_ascii_case("playing")
                    || activity.eq_ignore_ascii_case("spectating")
            });
        let observed_player_id = payload
            .player
            .as_ref()
            .and_then(|player| player.steamid.clone().or_else(|| player.name.clone()));
        Ok(Some(PlaybackSnapshot {
            sequence: state.sequence,
            ready: fresh
                && is_cs2
                && active
                && payload
                    .map
                    .as_ref()
                    .and_then(|map| map.name.as_ref())
                    .is_some(),
            // Standard GSI does not expose demo identity or demo tick. Leaving
            // these absent deliberately prevents false synchronization success.
            demo_path: None,
            tick: None,
            observed_player_id,
        }))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[derive(Debug)]
    struct StaticSource(Mutex<Option<PlaybackSnapshot>>);

    #[async_trait]
    impl PlaybackSnapshotSource for StaticSource {
        async fn snapshot(&self) -> RecordingResult<Option<PlaybackSnapshot>> {
            Ok(self.0.lock().unwrap().clone())
        }
    }

    #[tokio::test]
    async fn system_synchronizer_requires_exact_evidence() {
        let root = tempfile::tempdir().unwrap();
        let demo = root.path().join("match.dem");
        let source = StaticSource(Mutex::new(Some(PlaybackSnapshot {
            sequence: 1,
            ready: true,
            demo_path: Some(demo.clone()),
            tick: Some(100),
            observed_player_id: Some("player-1".to_owned()),
        })));
        let synchronizer = SystemPlaybackSynchronizer::new(source)
            .with_limits(Duration::from_millis(1), 2)
            .unwrap();
        let cancellation = ProcessCancellation::default();
        synchronizer
            .confirm_demo_ready(&demo, Duration::from_millis(10), &cancellation)
            .await
            .unwrap();
        synchronizer
            .confirm_tick(102, Duration::from_millis(10), &cancellation)
            .await
            .unwrap();
        synchronizer
            .confirm_observer("player-1", Duration::from_millis(10), &cancellation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn missing_tick_never_blindly_succeeds() {
        let source = StaticSource(Mutex::new(Some(PlaybackSnapshot {
            sequence: 1,
            ready: true,
            demo_path: None,
            tick: None,
            observed_player_id: None,
        })));
        let synchronizer = SystemPlaybackSynchronizer::new(source)
            .with_limits(Duration::from_millis(1), 0)
            .unwrap();
        assert!(matches!(
            synchronizer
                .confirm_tick(
                    100,
                    Duration::from_millis(3),
                    &ProcessCancellation::default()
                )
                .await,
            Err(RecordingError::Timeout { .. })
        ));
    }
}
