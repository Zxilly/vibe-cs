use std::{path::PathBuf, time::Duration};

use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaunchPolicy {
    pub insecure: bool,
    pub skip_intro: bool,
    pub windowed: bool,
}

impl Default for LaunchPolicy {
    fn default() -> Self {
        Self {
            insecure: true,
            skip_intro: true,
            windowed: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineConfig {
    pub cs2_executable: PathBuf,
    pub output_directory: PathBuf,
    pub preferred_process_id: Option<u32>,
    pub launch_policy: LaunchPolicy,
    pub launch_timeout: Duration,
    pub synchronization_timeout: Duration,
    pub maximum_segment_duration: Duration,
    pub maximum_demo_bytes: u64,
    pub maximum_clip_bytes: u64,
}

impl EngineConfig {
    #[must_use]
    pub fn new(cs2_executable: impl Into<PathBuf>, output_directory: impl Into<PathBuf>) -> Self {
        Self {
            cs2_executable: cs2_executable.into(),
            output_directory: output_directory.into(),
            preferred_process_id: None,
            launch_policy: LaunchPolicy::default(),
            launch_timeout: Duration::from_secs(45),
            synchronization_timeout: Duration::from_secs(20),
            maximum_segment_duration: Duration::from_secs(10 * 60),
            maximum_demo_bytes: 8 * 1024 * 1024 * 1024,
            maximum_clip_bytes: 64 * 1024 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SegmentPlan {
    pub demo_id: Uuid,
    pub demo_path: PathBuf,
    pub title: String,
    pub player_id: String,
    pub player_name: Option<String>,
    pub start_tick: u64,
    pub end_tick: u64,
    pub tick_rate: f64,
    pub playback_speed: f64,
    pub output_file_name: String,
    pub category: String,
    pub tags: Vec<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreflightReport {
    pub segment_count: usize,
    pub running_process_id: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaybackSnapshot {
    /// Monotonically advances only when the underlying source receives a new heartbeat.
    pub sequence: u64,
    /// True only for a fresh, active CS2 (app 730) heartbeat.
    pub ready: bool,
    pub demo_path: Option<PathBuf>,
    pub tick: Option<u64>,
    pub observed_player_id: Option<String>,
}
