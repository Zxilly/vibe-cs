use std::{path::PathBuf, sync::Arc, time::Duration};

use async_trait::async_trait;
use vibe_cs_application::{MediaPort, ProbedMediaMetadata};
use vibe_cs_domain::{
    AudioAnalysis, AudioAnalysisOptions, BeatAlignmentDraft, BeatAlignmentRequest, DomainError,
};
use vibe_cs_media::{
    EncoderSelection, MediaError, ProcessCancellation, SingleInputTranscodeOptions,
    ThumbnailOptions, WaveformOptions, analyze_native_audio, build_audio_extraction_plan,
    build_single_input_transcode_plan, execute_native_filter_plan, generate_native_thumbnail,
    generate_native_waveform, native_probe_media, plan_clip_alignment,
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const WAVEFORM_TIMEOUT: Duration = Duration::from_secs(90);
const THUMBNAIL_TIMEOUT: Duration = Duration::from_secs(30);
const AUDIO_ANALYSIS_TIMEOUT: Duration = Duration::from_secs(3 * 60);
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
    thumbnail_permits: Arc<tokio::sync::Semaphore>,
}

impl std::fmt::Debug for RuntimeMediaPort {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("RuntimeMediaPort").finish()
    }
}

impl RuntimeMediaPort {
    #[must_use]
    pub fn new(_storage: vibe_cs_storage::Storage) -> Self {
        Self {
            thumbnail_permits: Arc::new(tokio::sync::Semaphore::new(4)),
        }
    }
}

#[async_trait]
impl MediaPort for RuntimeMediaPort {
    async fn probe(&self, path: PathBuf) -> Result<ProbedMediaMetadata, DomainError> {
        let cancellation = ProcessCancellation::default();
        let probe_cancellation = cancellation.clone();
        let result = tokio::time::timeout(
            PROBE_TIMEOUT,
            tokio::task::spawn_blocking(move || native_probe_media(&path, &probe_cancellation)),
        )
        .await;
        let probe = if let Ok(result) = result {
            result
                .map_err(|error| {
                    DomainError::Internal(format!("native probe task failed: {error}"))
                })?
                .map_err(map_media_error)?
        } else {
            cancellation.cancel();
            return Err(DomainError::Internal(
                "media probe exceeded its time limit".to_owned(),
            ));
        };
        let video = probe.streams.iter().find(|stream| stream.kind == "video");
        let audio = probe.streams.iter().find(|stream| stream.kind == "audio");
        Ok(ProbedMediaMetadata {
            duration_seconds: probe
                .duration_seconds
                .filter(|duration| duration.is_finite() && *duration >= 0.0),
            width: video.and_then(|stream| stream.width),
            height: video.and_then(|stream| stream.height),
            has_audio: audio.is_some(),
            frame_rate: video.and_then(|stream| stream.frame_rate.clone()),
            video_codec: video.map(|stream| stream.codec.clone()),
            audio_codec: audio.map(|stream| stream.codec.clone()),
        })
    }

    async fn waveform(&self, path: PathBuf, buckets: usize) -> Result<Vec<f32>, DomainError> {
        let cancellation = ProcessCancellation::default();
        let options = WaveformOptions {
            buckets,
            maximum_input_bytes: MAXIMUM_WAVEFORM_BYTES,
            ..WaveformOptions::default()
        };
        let waveform_cancellation = cancellation.clone();
        let result = tokio::time::timeout(
            WAVEFORM_TIMEOUT,
            tokio::task::spawn_blocking(move || {
                generate_native_waveform(&path, options, &waveform_cancellation)
            }),
        )
        .await;
        if let Ok(result) = result {
            result
                .map_err(|error| {
                    DomainError::Internal(format!("native waveform task failed: {error}"))
                })?
                .map_err(map_media_error)
        } else {
            cancellation.cancel();
            Err(DomainError::Internal(
                "waveform generation exceeded its time limit".to_owned(),
            ))
        }
    }

    async fn thumbnail(
        &self,
        path: PathBuf,
        time_seconds: f64,
        maximum_width: u32,
        maximum_height: u32,
    ) -> Result<Vec<u8>, DomainError> {
        let cancellation = ProcessCancellation::default();
        let thumbnail_cancellation = cancellation.clone();
        let permit = self
            .thumbnail_permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| DomainError::Internal("thumbnail decoder queue closed".to_owned()))?;
        let result = tokio::time::timeout(
            THUMBNAIL_TIMEOUT,
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                generate_native_thumbnail(
                    &path,
                    ThumbnailOptions {
                        time_seconds,
                        maximum_width,
                        maximum_height,
                    },
                    &thumbnail_cancellation,
                )
            }),
        )
        .await;
        if let Ok(result) = result {
            result
                .map_err(|error| {
                    DomainError::Internal(format!("native thumbnail task failed: {error}"))
                })?
                .map_err(map_media_error)
        } else {
            cancellation.cancel();
            Err(DomainError::Internal(
                "thumbnail generation exceeded its time limit".to_owned(),
            ))
        }
    }

    async fn analyze_audio(
        &self,
        path: PathBuf,
        options: AudioAnalysisOptions,
    ) -> Result<AudioAnalysis, DomainError> {
        let cancellation = ProcessCancellation::default();
        let analysis_cancellation = cancellation.clone();
        let result = tokio::time::timeout(
            AUDIO_ANALYSIS_TIMEOUT,
            tokio::task::spawn_blocking(move || {
                analyze_native_audio(&path, options, &analysis_cancellation)
            }),
        )
        .await;
        if let Ok(result) = result {
            result
                .map_err(|error| {
                    DomainError::Internal(format!("audio analysis task failed: {error}"))
                })?
                .map_err(map_media_error)
        } else {
            cancellation.cancel();
            Err(DomainError::Internal(
                "audio analysis exceeded its time limit".to_owned(),
            ))
        }
    }

    async fn align_clips_to_beats(
        &self,
        request: BeatAlignmentRequest,
    ) -> Result<BeatAlignmentDraft, DomainError> {
        plan_clip_alignment(&request).map_err(map_media_error)
    }

    async fn generate_proxy(
        &self,
        source: PathBuf,
        output: PathBuf,
        request: vibe_cs_application::MediaProxyRequest,
    ) -> Result<(), DomainError> {
        let cancellation = ProcessCancellation::default();
        let plan = build_single_input_transcode_plan(
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
                    primary: "libopenh264".to_owned(),
                    fallback: None,
                },
                quality: 65,
            },
        )
        .map_err(map_media_error)?;
        let result = tokio::time::timeout(
            PROXY_TIMEOUT,
            execute_native_filter_plan(&plan, &cancellation),
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
        let cancellation = ProcessCancellation::default();
        let plan = build_audio_extraction_plan(&source, &output, duration_seconds)
            .map_err(map_media_error)?;
        let mut cleanup =
            PendingFilterOutputs::new(plan.temporary_output.clone(), plan.final_output.clone());
        let result = tokio::time::timeout(
            AUDIO_EXTRACTION_TIMEOUT,
            execute_native_filter_plan(&plan, &cancellation),
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
