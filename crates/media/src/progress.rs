#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct FfmpegProgress {
    pub out_time_seconds: f64,
    pub completed: bool,
}

#[must_use]
pub fn parse_ffmpeg_progress(text: &str) -> FfmpegProgress {
    let mut progress = FfmpegProgress::default();
    for line in text.lines() {
        let Some((key, value)) = line.trim().split_once('=') else {
            continue;
        };
        match key {
            "out_time_us" | "out_time_ms" => {
                if let Ok(microseconds) = value.parse::<u64>() {
                    progress.out_time_seconds =
                        std::time::Duration::from_micros(microseconds).as_secs_f64();
                }
            }
            "out_time" => {
                if let Some(seconds) = parse_timestamp(value) {
                    progress.out_time_seconds = seconds;
                }
            }
            "progress" => progress.completed = value == "end",
            _ => {}
        }
    }
    progress
}

fn parse_timestamp(value: &str) -> Option<f64> {
    let mut parts = value.split(':');
    let hours = parts.next()?.parse::<f64>().ok()?;
    let minutes = parts.next()?.parse::<f64>().ok()?;
    let seconds = parts.next()?.parse::<f64>().ok()?;
    (parts.next().is_none()).then_some(hours * 3600.0 + minutes * 60.0 + seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_machine_readable_progress() {
        let progress = parse_ffmpeg_progress("frame=30\nout_time=00:01:02.500000\nprogress=end\n");
        assert!((progress.out_time_seconds - 62.5).abs() < f64::EPSILON);
        assert!(progress.completed);
    }
}
