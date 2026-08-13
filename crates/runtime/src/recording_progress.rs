use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};

use tokio::sync::mpsc;

/// Verified milestones exposed by one managed recording pipeline.
///
/// The ordinal is the current verified pipeline position, not an estimate of
/// elapsed wall-clock time. Keep variants ordered so a sink can reject
/// regressions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum RecordingStage {
    Launching = 1,
    Seeking = 2,
    Capturing = 3,
    Stabilizing = 4,
    Encoding = 5,
}

impl RecordingStage {
    pub const COUNT: u8 = Self::Encoding as u8;

    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::Launching => "recording.stage.launching",
            Self::Seeking => "recording.stage.seeking",
            Self::Capturing => "recording.stage.capturing",
            Self::Stabilizing => "recording.stage.stabilizing",
            Self::Encoding => "recording.stage.encoding",
        }
    }

    #[must_use]
    pub const fn milestone(self) -> u8 {
        self as u8
    }
}

/// Non-blocking, bounded progress publisher for a single recording item.
///
/// There are exactly five possible monotonic events and the channel is sized
/// for all five, so a slow persistence consumer cannot block HLAE protocol or
/// encoder work and does not lose a valid stage transition.
#[derive(Debug, Clone)]
pub struct RecordingProgressSink {
    sender: mpsc::Sender<RecordingStage>,
    latest: Arc<AtomicU8>,
}

impl RecordingProgressSink {
    /// Reports a later verified milestone without waiting on the consumer.
    pub fn report(&self, stage: RecordingStage) {
        let next = stage.milestone();
        let mut current = self.latest.load(Ordering::Acquire);
        loop {
            if next <= current {
                return;
            }
            match self.latest.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(observed) => current = observed,
            }
        }
        let _ = self.sender.try_send(stage);
    }
}

pub(crate) fn recording_progress_channel() -> (RecordingProgressSink, mpsc::Receiver<RecordingStage>)
{
    let (sender, receiver) = mpsc::channel(usize::from(RecordingStage::COUNT));
    (
        RecordingProgressSink {
            sender,
            latest: Arc::new(AtomicU8::new(0)),
        },
        receiver,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sink_is_non_blocking_bounded_and_rejects_stage_regressions() {
        let (sink, mut receiver) = recording_progress_channel();
        sink.report(RecordingStage::Launching);
        sink.report(RecordingStage::Capturing);
        sink.report(RecordingStage::Seeking);
        sink.report(RecordingStage::Capturing);
        sink.report(RecordingStage::Encoding);
        drop(sink);

        let mut observed = Vec::new();
        while let Some(stage) = receiver.recv().await {
            observed.push(stage);
        }

        assert_eq!(
            observed,
            [
                RecordingStage::Launching,
                RecordingStage::Capturing,
                RecordingStage::Encoding,
            ]
        );
    }
}
