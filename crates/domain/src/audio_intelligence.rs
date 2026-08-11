use serde::{Deserialize, Serialize};

/// Bounded settings for deterministic, local music analysis.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct AudioAnalysisOptions {
    /// Analysis sample rate. Inputs above this rate are downsampled in-process.
    pub sample_rate: u32,
    /// Reject audio longer than this value instead of allocating without bound.
    pub maximum_duration_seconds: f64,
    pub maximum_beats: usize,
    pub maximum_onsets: usize,
    pub energy_points: usize,
    pub maximum_sections: usize,
}

impl Default for AudioAnalysisOptions {
    fn default() -> Self {
        Self {
            sample_rate: 11_025,
            maximum_duration_seconds: 30.0 * 60.0,
            maximum_beats: 4_096,
            maximum_onsets: 4_096,
            energy_points: 512,
            maximum_sections: 24,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AudioBeat {
    pub index: usize,
    pub time_seconds: f64,
    /// Normalized local onset strength in the `0..=1` range.
    pub strength: f32,
    /// One-based position in an assumed four-beat phrase.
    pub phrase_position: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AudioOnset {
    pub time_seconds: f64,
    pub strength: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AudioEnergyPoint {
    pub time_seconds: f64,
    pub rms: f32,
    pub peak: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AudioSection {
    pub start_seconds: f64,
    pub end_seconds: f64,
    /// `quiet`, `build`, `steady`, `peak`, or `release`.
    pub character: String,
    pub mean_energy: f32,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AudioAnalysis {
    pub duration_seconds: f64,
    pub analysis_sample_rate: u32,
    pub bpm: Option<f64>,
    pub tempo_confidence: f32,
    pub beats: Vec<AudioBeat>,
    pub onsets: Vec<AudioOnset>,
    pub energy: Vec<AudioEnergyPoint>,
    pub sections: Vec<AudioSection>,
    /// Human-readable caveats intended to be exposed to an AI tool and users.
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BeatAlignmentClip {
    pub clip_id: String,
    pub source_duration_seconds: f64,
    #[serde(default)]
    pub minimum_duration_seconds: Option<f64>,
    #[serde(default)]
    pub maximum_duration_seconds: Option<f64>,
    /// Optional preferred beat span. When absent, source duration wins.
    #[serde(default)]
    pub preferred_beats: Option<u16>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct BeatAlignmentOptions {
    pub timeline_start_seconds: f64,
    pub maximum_duration_change_ratio: f64,
    pub beats_per_phrase: u8,
    pub prefer_strong_boundaries: bool,
}

impl Default for BeatAlignmentOptions {
    fn default() -> Self {
        Self {
            timeline_start_seconds: 0.0,
            maximum_duration_change_ratio: 0.35,
            beats_per_phrase: 4,
            prefer_strong_boundaries: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BeatAlignmentRequest {
    pub beats: Vec<AudioBeat>,
    pub clips: Vec<BeatAlignmentClip>,
    #[serde(default)]
    pub options: BeatAlignmentOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BeatAlignedClip {
    pub clip_id: String,
    pub timeline_start_seconds: f64,
    pub timeline_end_seconds: f64,
    pub planned_duration_seconds: f64,
    pub source_duration_seconds: f64,
    pub duration_change_ratio: f64,
    pub start_beat_index: usize,
    pub end_beat_index: usize,
    pub rationale: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BeatAlignmentDraft {
    /// This is an advisory plan only. Applying it requires a separate editor action.
    pub advisory_only: bool,
    pub clips: Vec<BeatAlignedClip>,
    pub unplaced_clip_ids: Vec<String>,
    pub constraints: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analysis_options_have_transport_safe_defaults() {
        let options: AudioAnalysisOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(options, AudioAnalysisOptions::default());
        assert!(serde_json::from_str::<AudioAnalysisOptions>(r#"{"unexpected":true}"#).is_err());
    }
}
