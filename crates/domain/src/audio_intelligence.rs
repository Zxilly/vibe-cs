use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Bounded settings for deterministic, local music analysis.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
pub struct AudioBeat {
    pub index: usize,
    pub time_seconds: f64,
    /// Normalized local onset strength in the `0..=1` range.
    pub strength: f32,
    /// One-based position in an assumed four-beat phrase.
    pub phrase_position: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
pub struct AudioOnset {
    pub time_seconds: f64,
    pub strength: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
pub struct AudioEnergyPoint {
    pub time_seconds: f64,
    pub rms: f32,
    pub peak: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
pub struct AudioSection {
    pub start_seconds: f64,
    pub end_seconds: f64,
    /// `quiet`, `build`, `steady`, `peak`, or `release`.
    pub character: String,
    pub mean_energy: f32,
    pub confidence: f32,
}

/// One fixed frequency interval used by the bounded, log-power spectral map.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
pub struct AudioSpectralBand {
    pub label: String,
    pub lower_hz: f32,
    pub upper_hz: f32,
}

/// A compact time slice of spectral evidence. `band_levels_db` follows the
/// order of [`AudioSpectralMap::bands`] and is relative to the loudest band in
/// the analyzed track.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
pub struct AudioSpectralPoint {
    pub time_seconds: f64,
    pub band_levels_db: Vec<f32>,
    pub spectral_centroid_hz: f32,
    pub spectral_rolloff_hz: f32,
    pub spectral_flux: f32,
}

/// A token-bounded numerical spectrogram for tools and product visualizations.
/// This is evidence, not a semantic music classification.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
pub struct AudioSpectralMap {
    pub floor_db: f32,
    pub bands: Vec<AudioSpectralBand>,
    pub points: Vec<AudioSpectralPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
pub struct AudioTimeRange {
    pub start_seconds: f64,
    pub end_seconds: f64,
}

/// A ranked musical boundary that is safe for the Agent to consider. The
/// editor still decides whether a visual cut belongs there.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
pub struct AudioCutPoint {
    pub time_seconds: f64,
    /// `section_boundary`, `strong_onset`, or `phrase_boundary`.
    pub kind: String,
    pub strength: f32,
}

/// Bounded, editing-oriented diagnostics derived from real decoded samples.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
pub struct AudioRhythmDiagnostics {
    pub onset_rate_per_second: f32,
    pub strong_onset_rate_per_second: f32,
    pub dynamic_range_db: f32,
    pub silence_ratio: f32,
    pub silence_regions: Vec<AudioTimeRange>,
    pub recommended_cut_points: Vec<AudioCutPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
pub struct AudioAnalysis {
    pub duration_seconds: f64,
    pub analysis_sample_rate: u32,
    pub bpm: Option<f64>,
    pub tempo_confidence: f32,
    pub beats: Vec<AudioBeat>,
    pub onsets: Vec<AudioOnset>,
    pub energy: Vec<AudioEnergyPoint>,
    pub sections: Vec<AudioSection>,
    pub spectral_map: AudioSpectralMap,
    pub rhythm_diagnostics: AudioRhythmDiagnostics,
    /// Human-readable caveats intended to be exposed to an AI tool and users.
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct BeatAlignmentClip {
    pub clip_id: String,
    pub source_duration_seconds: f64,
    #[serde(default)]
    #[ts(optional)]
    pub minimum_duration_seconds: Option<f64>,
    #[serde(default)]
    #[ts(optional)]
    pub maximum_duration_seconds: Option<f64>,
    /// Optional preferred beat span. When absent, source duration wins.
    #[serde(default)]
    #[ts(optional)]
    pub preferred_beats: Option<u16>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct BeatAlignmentRequest {
    pub beats: Vec<AudioBeat>,
    pub clips: Vec<BeatAlignmentClip>,
    pub options: BeatAlignmentOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export)]
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
    fn audio_analysis_options_accept_only_the_current_exact_shape() {
        let current = serde_json::to_value(AudioAnalysisOptions::default())
            .expect("serialize current audio options");
        assert_eq!(
            serde_json::from_value::<AudioAnalysisOptions>(current.clone())
                .expect("current audio options"),
            AudioAnalysisOptions::default()
        );

        for required in [
            "sample_rate",
            "maximum_duration_seconds",
            "maximum_beats",
            "maximum_onsets",
            "energy_points",
            "maximum_sections",
        ] {
            let mut incomplete = current.clone();
            incomplete
                .as_object_mut()
                .expect("audio options are an object")
                .remove(required);
            assert!(
                serde_json::from_value::<AudioAnalysisOptions>(incomplete).is_err(),
                "missing {required} must be rejected"
            );
        }
    }

    #[test]
    fn beat_alignment_options_accept_only_the_current_exact_shape() {
        let current = serde_json::to_value(BeatAlignmentOptions::default())
            .expect("serialize current alignment options");
        for required in [
            "timeline_start_seconds",
            "maximum_duration_change_ratio",
            "beats_per_phrase",
            "prefer_strong_boundaries",
        ] {
            let mut incomplete = current.clone();
            incomplete
                .as_object_mut()
                .expect("alignment options are an object")
                .remove(required);
            assert!(
                serde_json::from_value::<BeatAlignmentOptions>(incomplete).is_err(),
                "missing {required} must be rejected"
            );
        }
    }

    #[test]
    fn beat_alignment_request_requires_explicit_current_options() {
        let current = serde_json::json!({
            "beats": [],
            "clips": [],
            "options": BeatAlignmentOptions::default(),
        });
        serde_json::from_value::<BeatAlignmentRequest>(current.clone())
            .expect("current alignment request");

        let mut incomplete = current;
        incomplete
            .as_object_mut()
            .expect("alignment request is an object")
            .remove("options");
        assert!(serde_json::from_value::<BeatAlignmentRequest>(incomplete).is_err());
    }
}
