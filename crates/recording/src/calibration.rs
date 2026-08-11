use vibe_cs_domain::{CaptureLatencyCalibration, CaptureLatencySample};

use crate::{RecordingError, RecordingResult};

/// Uses the median offset and median absolute deviation so one delayed frame
/// cannot distort the recommended capture delay.
///
/// # Errors
///
/// Rejects too few/many samples and implausible observations beyond 30 seconds.
pub fn calibrate_capture_latency(
    samples: &[CaptureLatencySample],
) -> RecordingResult<CaptureLatencyCalibration> {
    if !(3..=64).contains(&samples.len()) {
        return Err(RecordingError::InvalidInput(
            "latency calibration requires 3..=64 observed samples".to_owned(),
        ));
    }
    let mut offsets = samples
        .iter()
        .map(|sample| {
            sample
                .obs_observed_ms
                .saturating_sub(sample.game_observed_ms)
        })
        .collect::<Vec<_>>();
    if offsets.iter().any(|offset| offset.unsigned_abs() > 30_000) {
        return Err(RecordingError::InvalidInput(
            "latency observations must be within 30 seconds".to_owned(),
        ));
    }
    offsets.sort_unstable();
    let median = median_i64(&offsets);
    let mut deviations = offsets
        .iter()
        .map(|offset| offset.abs_diff(median))
        .collect::<Vec<_>>();
    deviations.sort_unstable();
    let jitter = median_u64(&deviations);
    let confidence = match (samples.len(), jitter) {
        (8.., 0..=33) => "high",
        (5.., 0..=100) => "medium",
        _ => "low",
    };
    let diagnostic = if jitter > 250 {
        "OBS 与游戏观察偏移波动较大；请关闭预览编码、确认帧率一致后重新测量"
    } else if median > 0 {
        "OBS 画面落后于游戏事件；建议应用正向捕获延迟补偿"
    } else if median < 0 {
        "OBS 画面早于事件时间轴；建议应用负向时间轴补偿"
    } else {
        "游戏事件与 OBS 画面中位偏移接近零"
    };
    Ok(CaptureLatencyCalibration {
        sample_count: samples.len(),
        recommended_delay_ms: median.clamp(-5_000, 5_000),
        median_offset_ms: median,
        jitter_ms: jitter,
        confidence: confidence.to_owned(),
        diagnostic: diagnostic.to_owned(),
    })
}

fn median_i64(values: &[i64]) -> i64 {
    let middle = values.len() / 2;
    if values.len().is_multiple_of(2) {
        values[middle - 1].saturating_add(values[middle]) / 2
    } else {
        values[middle]
    }
}

fn median_u64(values: &[u64]) -> u64 {
    let middle = values.len() / 2;
    if values.len().is_multiple_of(2) {
        values[middle - 1].saturating_add(values[middle]) / 2
    } else {
        values[middle]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn median_resists_one_outlier_and_reports_jitter() {
        let report = calibrate_capture_latency(&[
            CaptureLatencySample {
                game_observed_ms: 100,
                obs_observed_ms: 220,
            },
            CaptureLatencySample {
                game_observed_ms: 200,
                obs_observed_ms: 322,
            },
            CaptureLatencySample {
                game_observed_ms: 300,
                obs_observed_ms: 418,
            },
            CaptureLatencySample {
                game_observed_ms: 400,
                obs_observed_ms: 2_000,
            },
            CaptureLatencySample {
                game_observed_ms: 500,
                obs_observed_ms: 621,
            },
        ])
        .expect("calibration");
        assert_eq!(report.recommended_delay_ms, 121);
        assert_eq!(report.jitter_ms, 1);
        assert_eq!(report.confidence, "medium");
    }

    #[test]
    fn refuses_too_few_or_implausible_samples() {
        assert!(calibrate_capture_latency(&[]).is_err());
        assert!(
            calibrate_capture_latency(&[
                CaptureLatencySample {
                    game_observed_ms: 0,
                    obs_observed_ms: 50_000
                },
                CaptureLatencySample {
                    game_observed_ms: 1,
                    obs_observed_ms: 2
                },
                CaptureLatencySample {
                    game_observed_ms: 2,
                    obs_observed_ms: 3
                },
            ])
            .is_err()
        );
    }
}
