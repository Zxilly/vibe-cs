use std::{path::PathBuf, sync::Arc, time::Duration};

use async_trait::async_trait;
use vibe_cs_application::{MediaPort, ProbedMediaMetadata};
use vibe_cs_domain::DomainError;
use vibe_cs_media::{
    EncoderSelection, MediaError, ProcessCancellation, ProcessRunner, SingleInputTranscodeOptions,
    SystemProcessRunner, WaveformOptions, build_audio_extraction_plan,
    build_single_input_transcode_plan, execute_filter_plan, find_executable, generate_waveform,
    probe_media,
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const WAVEFORM_TIMEOUT: Duration = Duration::from_secs(90);
const MAXIMUM_WAVEFORM_BYTES: u64 = 32 * 1024 * 1024;
const PROXY_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const AUDIO_EXTRACTION_TIMEOUT: Duration = Duration::from_secs(60 * 60);

struct PendingFilterOutputs {
    temporary: PathBuf,
    final_output: PathBuf,
    temporary_was_present: bool,
    final_was_present: bool,
    armed: bool,
}

impl PendingFilterOutputs {
    fn new(temporary: PathBuf, final_output: PathBuf) -> Self {
        Self {
            temporary_was_present: temporary.exists(),
            final_was_present: final_output.exists(),
            temporary,
            final_output,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PendingFilterOutputs {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if !self.temporary_was_present {
            let _ = std::fs::remove_file(&self.temporary);
        }
        if !self.final_was_present {
            let _ = std::fs::remove_file(&self.final_output);
        }
    }
}

pub struct RuntimeMediaPort {
    storage: vibe_cs_storage::Storage,
    runner: Arc<dyn ProcessRunner>,
}

impl std::fmt::Debug for RuntimeMediaPort {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeMediaPort")
            .field("storage", &self.storage)
            .finish_non_exhaustive()
    }
}

impl RuntimeMediaPort {
    #[must_use]
    pub fn new(storage: vibe_cs_storage::Storage) -> Self {
        Self::with_runner(storage, Arc::new(SystemProcessRunner::default()))
    }

    #[must_use]
    pub fn with_runner(storage: vibe_cs_storage::Storage, runner: Arc<dyn ProcessRunner>) -> Self {
        Self { storage, runner }
    }

    async fn configured_executable(&self, name: &str) -> Result<PathBuf, DomainError> {
        let config = self
            .storage
            .get_config()
            .await
            .map_err(|error| DomainError::Internal(error.to_string()))?
            .unwrap_or_default();
        let configured = match name {
            "ffmpeg" => config.ffmpeg_path,
            "ffprobe" => config.ffprobe_path,
            _ => {
                return Err(DomainError::InvalidInput(format!(
                    "unsupported media executable: {name}"
                )));
            }
        };
        let configured = (!configured.trim().is_empty()).then(|| PathBuf::from(configured));
        find_executable(name, configured.as_deref()).map_err(map_media_error)
    }
}

#[async_trait]
impl MediaPort for RuntimeMediaPort {
    async fn probe(&self, path: PathBuf) -> Result<ProbedMediaMetadata, DomainError> {
        let ffprobe = self.configured_executable("ffprobe").await?;
        let cancellation = ProcessCancellation::default();
        let result = tokio::time::timeout(
            PROBE_TIMEOUT,
            probe_media(self.runner.as_ref(), &ffprobe, &path, &cancellation),
        )
        .await;
        let probe = if let Ok(result) = result {
            result.map_err(map_media_error)?
        } else {
            cancellation.cancel();
            return Err(DomainError::Internal(
                "media probe exceeded its time limit".to_owned(),
            ));
        };
        let video = probe.streams.iter().find(|stream| stream.kind == "video");
        Ok(ProbedMediaMetadata {
            duration_seconds: probe
                .duration_seconds
                .filter(|duration| duration.is_finite() && *duration >= 0.0),
            width: video.and_then(|stream| stream.width),
            height: video.and_then(|stream| stream.height),
            has_audio: probe.streams.iter().any(|stream| stream.kind == "audio"),
        })
    }

    async fn waveform(&self, path: PathBuf, buckets: usize) -> Result<Vec<f32>, DomainError> {
        let ffmpeg = self.configured_executable("ffmpeg").await?;
        let cancellation = ProcessCancellation::default();
        let options = WaveformOptions {
            buckets,
            maximum_input_bytes: MAXIMUM_WAVEFORM_BYTES,
            ..WaveformOptions::default()
        };
        let result = tokio::time::timeout(
            WAVEFORM_TIMEOUT,
            generate_waveform(self.runner.as_ref(), &ffmpeg, &path, options, &cancellation),
        )
        .await;
        if let Ok(result) = result {
            result.map_err(map_media_error)
        } else {
            cancellation.cancel();
            Err(DomainError::Internal(
                "waveform generation exceeded its time limit".to_owned(),
            ))
        }
    }

    async fn generate_proxy(
        &self,
        source: PathBuf,
        output: PathBuf,
        request: vibe_cs_application::MediaProxyRequest,
    ) -> Result<(), DomainError> {
        let ffmpeg = self.configured_executable("ffmpeg").await?;
        let cancellation = ProcessCancellation::default();
        let plan = build_single_input_transcode_plan(
            &ffmpeg,
            &source,
            &output,
            &SingleInputTranscodeOptions {
                duration_seconds: request.duration_seconds,
                width: request.width,
                height: request.height,
                fps: request.fps,
                has_audio: request.has_audio,
                fade_in_seconds: 0.0,
                fade_out_seconds: 0.0,
                overlays: Vec::new(),
                encoder: EncoderSelection {
                    primary: "libx264".to_owned(),
                    fallback: None,
                },
                quality: 65,
            },
        )
        .map_err(map_media_error)?;
        let result = tokio::time::timeout(
            PROXY_TIMEOUT,
            execute_filter_plan(self.runner.as_ref(), &plan, &cancellation),
        )
        .await;
        if let Ok(result) = result {
            result.map_err(map_media_error)
        } else {
            cancellation.cancel();
            Err(DomainError::Internal(
                "proxy generation exceeded its time limit".to_owned(),
            ))
        }
    }

    async fn extract_audio(
        &self,
        source: PathBuf,
        output: PathBuf,
        duration_seconds: f64,
    ) -> Result<(), DomainError> {
        let ffmpeg = self.configured_executable("ffmpeg").await?;
        let cancellation = ProcessCancellation::default();
        let plan = build_audio_extraction_plan(&ffmpeg, &source, &output, duration_seconds)
            .map_err(map_media_error)?;
        let mut cleanup =
            PendingFilterOutputs::new(plan.temporary_output.clone(), plan.final_output.clone());
        let result = tokio::time::timeout(
            AUDIO_EXTRACTION_TIMEOUT,
            execute_filter_plan(self.runner.as_ref(), &plan, &cancellation),
        )
        .await;
        if let Ok(result) = result {
            result.map_err(map_media_error)?;
            cleanup.disarm();
            Ok(())
        } else {
            cancellation.cancel();
            Err(DomainError::Internal(
                "audio extraction exceeded its time limit".to_owned(),
            ))
        }
    }
}

fn map_media_error(error: MediaError) -> DomainError {
    match error {
        MediaError::ExecutableNotFound(message) => DomainError::DependencyUnavailable(message),
        MediaError::InvalidInput(message) => DomainError::InvalidInput(message),
        MediaError::Cancelled => DomainError::Conflict("media operation was cancelled".to_owned()),
        error => DomainError::Internal(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_filter_outputs_remove_only_files_created_by_the_operation() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let temporary = directory.path().join("audio.partial.m4a");
        let output = directory.path().join("audio.m4a");
        let existing = directory.path().join("existing.m4a");
        std::fs::write(&existing, b"existing").expect("existing output");
        {
            let _cleanup = PendingFilterOutputs::new(temporary.clone(), output.clone());
            std::fs::write(&temporary, b"partial").expect("partial output");
            std::fs::write(&output, b"published").expect("published output");
        }
        assert!(!temporary.exists());
        assert!(!output.exists());
        {
            let _cleanup = PendingFilterOutputs::new(
                directory.path().join("unused.partial"),
                existing.clone(),
            );
        }
        assert_eq!(
            std::fs::read(existing).expect("preserved output"),
            b"existing"
        );
    }
}
