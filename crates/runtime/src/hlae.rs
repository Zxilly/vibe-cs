use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{RecvTimeoutError, sync_channel},
    },
    thread,
    time::{Duration, SystemTime},
};

use vibe_cs_hlae::{
    CompiledHlaePlan, ExportedHlaePlan, HLAE_TAKE_MAX_FRAMES, HlaeBundleLaunchInputs,
    HlaeCaptureArtifactError, HlaeDiscovery, HlaeError, HlaeLaunchProfile, HlaeNotice, HlaePlan,
    HlaeTakeExpectation, HlaeTakeInventory, LaunchResolution, build_hlae_launch_profile,
    compile_hlae_plan, decode_hlae_tga_bgra, discover_managed_hlae, export_hlae_plan,
    inspect_hlae_take, validate_hlae_plan,
};
use vibe_cs_platform_windows::{
    NativeMp4VideoConfig, NativeMp4VideoInspection, NativeMp4VideoSummary, NativeMp4VideoWriter,
    PlatformError, ProcessCancellation, RationalFrameRate, inspect_native_h264_mp4,
};

/// Complete input contract for encoding one application-managed HLAE take.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HlaeTakeMp4EncodeRequest {
    pub managed_output_root: PathBuf,
    pub take_directory: PathBuf,
    pub output_path: PathBuf,
    /// Exact unpublished MP4 path persisted by the caller for crash recovery.
    pub partial_output_path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub target_bitrate_bps: u32,
    pub require_audio: bool,
    /// Per-plan frame budget derived before launch. This must be much tighter
    /// than the process-wide emergency ceiling for ordinary highlight jobs.
    pub maximum_frames: usize,
    /// Minimum acceptable frame count derived from the planned capture span.
    /// A clean but prematurely stopped take must never be published as success.
    pub minimum_frames: usize,
}

/// Read-back evidence returned only after the MP4 has been atomically published.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HlaeTakeMp4EncodeEvidence {
    pub summary: NativeMp4VideoSummary,
    pub inspection: NativeMp4VideoInspection,
}

/// Fail-closed errors from binding and encoding an HLAE take.
#[derive(Debug, thiserror::Error)]
pub enum HlaeTakeMp4EncodeError {
    #[error(transparent)]
    Capture(#[from] vibe_cs_hlae::HlaeCaptureArtifactError),
    #[error(transparent)]
    Platform(#[from] PlatformError),
    #[error("HLAE frame decode pipeline failed: {0}")]
    DecodePipeline(String),
}

/// Bounded polling policy used after HLAE reports `recordEnd`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HlaeTakeStabilityPolicy {
    /// Delay between direct-directory observations.
    pub poll_interval: Duration,
    /// Number of post-baseline polls that must remain unchanged.
    pub required_unchanged_polls: usize,
    /// Absolute limit for the complete stabilization attempt.
    pub timeout: Duration,
}

impl Default for HlaeTakeStabilityPolicy {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_millis(250),
            required_unchanged_polls: 4,
            timeout: Duration::from_secs(30),
        }
    }
}

/// Fail-closed outcomes from waiting for HLAE's files to finish flushing.
#[derive(Debug, thiserror::Error)]
pub enum HlaeTakeStabilityError {
    #[error("invalid HLAE take stability policy: {0}")]
    InvalidPolicy(String),
    #[error("HLAE take stabilization was cancelled")]
    Cancelled,
    #[error("HLAE take did not stabilize within {timeout:?}")]
    TimedOut { timeout: Duration },
    #[error(transparent)]
    Capture(#[from] HlaeCaptureArtifactError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum HlaeTakeSnapshotKind {
    Frame(usize),
    Audio,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct HlaeTakeSnapshotEntry {
    name: String,
    kind: HlaeTakeSnapshotKind,
    byte_length: u64,
    modified_at: SystemTime,
}

/// Waits until an HLAE screen-only take has stopped changing on disk.
///
/// HLAE emits `recordEnd` before its final `endmovie`/capture flush completes,
/// so callers must cross this boundary before opening frames for encoding.
/// Only regular direct entries from the managed `afxClassic` contract are
/// observed. Once stable, the existing strict take inspector supplies the
/// returned inventory.
///
/// # Errors
///
/// Returns an error for an invalid policy, cancellation, timeout, unsafe path
/// or entry type, unexpected artifact, or a stable but invalid take.
pub async fn wait_for_stable_hlae_take(
    managed_output_root: &Path,
    take_directory: &Path,
    expectation: HlaeTakeExpectation,
    policy: HlaeTakeStabilityPolicy,
    cancellation: &ProcessCancellation,
) -> Result<HlaeTakeInventory, HlaeTakeStabilityError> {
    validate_hlae_take_stability_policy(policy)?;
    if cancellation.is_cancelled() {
        return Err(HlaeTakeStabilityError::Cancelled);
    }

    let deadline = tokio::time::Instant::now() + policy.timeout;
    let mut previous = snapshot_hlae_take(managed_output_root, take_directory, expectation)?;
    let mut unchanged_polls = 0_usize;
    loop {
        tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(HlaeTakeStabilityError::Cancelled),
            () = tokio::time::sleep_until(deadline) => {
                return Err(HlaeTakeStabilityError::TimedOut { timeout: policy.timeout });
            }
            () = tokio::time::sleep(policy.poll_interval) => {}
        }
        if cancellation.is_cancelled() {
            return Err(HlaeTakeStabilityError::Cancelled);
        }
        let current = snapshot_hlae_take(managed_output_root, take_directory, expectation)?;
        if current == previous {
            unchanged_polls = unchanged_polls.saturating_add(1);
        } else {
            unchanged_polls = 0;
            previous = current;
        }
        if unchanged_polls >= policy.required_unchanged_polls {
            if cancellation.is_cancelled() {
                return Err(HlaeTakeStabilityError::Cancelled);
            }
            return inspect_hlae_take(managed_output_root, take_directory, expectation)
                .map_err(Into::into);
        }
    }
}

fn validate_hlae_take_stability_policy(
    policy: HlaeTakeStabilityPolicy,
) -> Result<(), HlaeTakeStabilityError> {
    const MAXIMUM_TIMEOUT: Duration = Duration::from_secs(5 * 60);
    const MAXIMUM_UNCHANGED_POLLS: usize = 1_024;
    if policy.poll_interval.is_zero() {
        return Err(HlaeTakeStabilityError::InvalidPolicy(
            "poll interval must be positive".to_owned(),
        ));
    }
    if policy.required_unchanged_polls == 0
        || policy.required_unchanged_polls > MAXIMUM_UNCHANGED_POLLS
    {
        return Err(HlaeTakeStabilityError::InvalidPolicy(format!(
            "unchanged poll count must be between 1 and {MAXIMUM_UNCHANGED_POLLS}"
        )));
    }
    if policy.timeout.is_zero() || policy.timeout > MAXIMUM_TIMEOUT {
        return Err(HlaeTakeStabilityError::InvalidPolicy(
            "timeout must be positive and no greater than five minutes".to_owned(),
        ));
    }
    let minimum_timeout = policy
        .poll_interval
        .checked_mul(u32::try_from(policy.required_unchanged_polls).map_err(|_| {
            HlaeTakeStabilityError::InvalidPolicy("unchanged poll count is unsupported".to_owned())
        })?)
        .ok_or_else(|| {
            HlaeTakeStabilityError::InvalidPolicy("stability window overflow".to_owned())
        })?;
    if policy.timeout < minimum_timeout {
        return Err(HlaeTakeStabilityError::InvalidPolicy(
            "timeout is shorter than the required stability window".to_owned(),
        ));
    }
    Ok(())
}

fn snapshot_hlae_take(
    managed_output_root: &Path,
    take_directory: &Path,
    expectation: HlaeTakeExpectation,
) -> Result<Vec<HlaeTakeSnapshotEntry>, HlaeTakeStabilityError> {
    let managed_metadata = fs::symlink_metadata(managed_output_root).map_err(capture_io)?;
    if managed_metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&managed_metadata)
        || !managed_metadata.is_dir()
    {
        return capture_invalid("managed output root must be a regular non-link directory");
    }
    let take_metadata = fs::symlink_metadata(take_directory).map_err(capture_io)?;
    if take_metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&take_metadata)
        || !take_metadata.is_dir()
    {
        return capture_invalid("HLAE take must be a regular non-link directory");
    }
    let managed_output_root = fs::canonicalize(managed_output_root).map_err(capture_io)?;
    let take_directory = fs::canonicalize(take_directory).map_err(capture_io)?;
    if take_directory == managed_output_root || !take_directory.starts_with(&managed_output_root) {
        return capture_invalid("take directory must be a strict descendant of the managed root");
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(&take_directory).map_err(capture_io)? {
        let entry = entry.map_err(capture_io)?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(capture_io)?;
        if metadata.file_type().is_symlink()
            || metadata_is_reparse_point(&metadata)
            || !metadata.is_file()
        {
            return capture_invalid(format!(
                "unexpected non-file take artifact: {}",
                entry.path().display()
            ));
        }
        let name = entry.file_name().into_string().map_err(|_| {
            HlaeTakeStabilityError::Capture(HlaeCaptureArtifactError::Invalid(
                "take artifact names must be UTF-8".to_owned(),
            ))
        })?;
        let kind = if name == "audio.wav" {
            HlaeTakeSnapshotKind::Audio
        } else {
            HlaeTakeSnapshotKind::Frame(parse_hlae_frame_name(&name)?)
        };
        entries.push(HlaeTakeSnapshotEntry {
            name,
            kind,
            byte_length: metadata.len(),
            modified_at: metadata.modified().map_err(capture_io)?,
        });
        if entries.len() > expectation.maximum_frames.saturating_add(1) {
            return capture_invalid("HLAE take exceeds its bounded direct-entry budget");
        }
    }
    entries.sort_unstable();
    Ok(entries)
}

fn parse_hlae_frame_name(name: &str) -> Result<usize, HlaeTakeStabilityError> {
    let Some(stem) = name.strip_suffix(".tga") else {
        return capture_invalid(format!("unexpected take artifact: {name}"));
    };
    if stem.len() < 5 || !stem.bytes().all(|byte| byte.is_ascii_digit()) {
        return capture_invalid(format!("invalid HLAE frame name: {name}"));
    }
    let index = stem.parse::<usize>().map_err(|_| {
        HlaeTakeStabilityError::Capture(HlaeCaptureArtifactError::Invalid(format!(
            "invalid HLAE frame index: {name}"
        )))
    })?;
    if format!("{index:05}") != stem {
        return capture_invalid(format!("non-canonical HLAE frame name: {name}"));
    }
    Ok(index)
}

fn capture_io(error: std::io::Error) -> HlaeTakeStabilityError {
    HlaeCaptureArtifactError::Io(error).into()
}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn capture_invalid<T>(message: impl Into<String>) -> Result<T, HlaeTakeStabilityError> {
    Err(HlaeTakeStabilityError::Capture(
        HlaeCaptureArtifactError::Invalid(message.into()),
    ))
}

const MINIMUM_HLAE_DECODE_WORKERS: usize = 2;
const MAXIMUM_HLAE_DECODE_WORKERS: usize = 4;
const HLAE_DECODE_RESULT_POLL_INTERVAL: Duration = Duration::from_millis(10);

struct DecodedHlaeFrame {
    index: usize,
    result: Result<Vec<u8>, HlaeTakeMp4EncodeError>,
}

fn hlae_decode_worker_count() -> usize {
    thread::available_parallelism()
        .map_or(MINIMUM_HLAE_DECODE_WORKERS, usize::from)
        .clamp(MINIMUM_HLAE_DECODE_WORKERS, MAXIMUM_HLAE_DECODE_WORKERS)
}

/// Decodes a fixed sliding window in parallel, then exposes frames strictly in
/// input order. A replacement task is dispatched only after one frame has been
/// written, so decoding, queued results, reordering, and the active write share
/// one `worker_count`-frame memory budget.
fn decode_hlae_frames_ordered<Decode, Write>(
    frame_paths: &[PathBuf],
    worker_count: usize,
    cancellation: &ProcessCancellation,
    decode: &Decode,
    mut write: Write,
) -> Result<(), HlaeTakeMp4EncodeError>
where
    Decode: Fn(usize, &Path) -> Result<Vec<u8>, HlaeTakeMp4EncodeError> + Sync,
    Write: FnMut(usize, Vec<u8>) -> Result<(), HlaeTakeMp4EncodeError>,
{
    if !(MINIMUM_HLAE_DECODE_WORKERS..=MAXIMUM_HLAE_DECODE_WORKERS).contains(&worker_count) {
        return Err(HlaeTakeMp4EncodeError::DecodePipeline(format!(
            "worker count must be between {MINIMUM_HLAE_DECODE_WORKERS} and {MAXIMUM_HLAE_DECODE_WORKERS}"
        )));
    }
    if frame_paths.is_empty() {
        return Ok(());
    }
    if cancellation.is_cancelled() {
        return Err(PlatformError::Cancelled { process_id: None }.into());
    }

    let stop = AtomicBool::new(false);
    let (task_sender, task_receiver) = sync_channel::<usize>(worker_count);
    let task_receiver = Mutex::new(task_receiver);
    let (result_sender, result_receiver) = sync_channel::<DecodedHlaeFrame>(worker_count);

    thread::scope(|scope| {
        let mut workers = Vec::with_capacity(worker_count);
        for _ in 0..worker_count {
            let result_sender = result_sender.clone();
            let task_receiver = &task_receiver;
            let stop = &stop;
            workers.push(scope.spawn(move || {
                loop {
                    if stop.load(Ordering::Acquire) || cancellation.is_cancelled() {
                        return;
                    }
                    let task = {
                        let Ok(receiver) = task_receiver.lock() else {
                            return;
                        };
                        receiver.recv()
                    };
                    let Ok(index) = task else {
                        return;
                    };
                    if stop.load(Ordering::Acquire) || cancellation.is_cancelled() {
                        return;
                    }
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        decode(index, &frame_paths[index])
                    }))
                    .unwrap_or_else(|_| {
                        Err(HlaeTakeMp4EncodeError::DecodePipeline(format!(
                            "worker panicked while decoding frame {index}"
                        )))
                    });
                    if result.is_err() {
                        stop.store(true, Ordering::Release);
                    }
                    if cancellation.is_cancelled()
                        || result_sender
                            .send(DecodedHlaeFrame { index, result })
                            .is_err()
                    {
                        return;
                    }
                }
            }));
        }
        drop(result_sender);

        let operation = (|| {
            let initially_dispatched = worker_count.min(frame_paths.len());
            for index in 0..initially_dispatched {
                task_sender.send(index).map_err(|_| {
                    HlaeTakeMp4EncodeError::DecodePipeline(
                        "all decoder workers stopped before accepting the initial frame window"
                            .to_owned(),
                    )
                })?;
            }
            let mut next_to_dispatch = initially_dispatched;
            let mut next_to_write = 0_usize;
            let mut completed_out_of_order = BTreeMap::new();

            while next_to_write < frame_paths.len() {
                if cancellation.is_cancelled() {
                    return Err(PlatformError::Cancelled { process_id: None }.into());
                }
                let decoded = match result_receiver.recv_timeout(HLAE_DECODE_RESULT_POLL_INTERVAL) {
                    Ok(decoded) => decoded,
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => {
                        if cancellation.is_cancelled() {
                            return Err(PlatformError::Cancelled { process_id: None }.into());
                        }
                        return Err(HlaeTakeMp4EncodeError::DecodePipeline(
                            "all decoder workers stopped before the sequence completed".to_owned(),
                        ));
                    }
                };
                let frame = decoded.result?;
                if completed_out_of_order
                    .insert(decoded.index, frame)
                    .is_some()
                {
                    return Err(HlaeTakeMp4EncodeError::DecodePipeline(format!(
                        "decoder returned frame {} more than once",
                        decoded.index
                    )));
                }

                while let Some(frame) = completed_out_of_order.remove(&next_to_write) {
                    if cancellation.is_cancelled() {
                        return Err(PlatformError::Cancelled { process_id: None }.into());
                    }
                    write(next_to_write, frame)?;
                    next_to_write += 1;
                    if next_to_dispatch < frame_paths.len() {
                        task_sender.send(next_to_dispatch).map_err(|_| {
                            HlaeTakeMp4EncodeError::DecodePipeline(
                                "all decoder workers stopped before accepting the next frame"
                                    .to_owned(),
                            )
                        })?;
                        next_to_dispatch += 1;
                    }
                }
            }
            Ok(())
        })();

        stop.store(true, Ordering::Release);
        drop(task_sender);
        drop(result_receiver);
        let mut worker_panicked = false;
        for worker in workers {
            worker_panicked |= worker.join().is_err();
        }
        if worker_panicked && operation.is_ok() {
            return Err(HlaeTakeMp4EncodeError::DecodePipeline(
                "decoder worker panicked".to_owned(),
            ));
        }
        operation
    })
}

/// Streams one validated HLAE image sequence into the native Windows MP4 path.
///
/// This boundary accepts only a stable, fully flushed, screen-only take. HLAE's
/// `recordEnd` callback alone is not proof that `endmovie` has finished flushing;
/// the session finalizer must establish that condition before calling `encode`.
#[derive(Debug, Default)]
pub struct RuntimeHlaeSequenceEncoder;

impl RuntimeHlaeSequenceEncoder {
    /// Encodes one take without overwriting an existing destination.
    ///
    /// # Errors
    ///
    /// Returns an error before publication if take validation, cancellation,
    /// native encoding, or read-back verification fails.
    pub fn encode(
        request: &HlaeTakeMp4EncodeRequest,
        cancellation: &ProcessCancellation,
    ) -> Result<HlaeTakeMp4EncodeEvidence, HlaeTakeMp4EncodeError> {
        if cancellation.is_cancelled() {
            return Err(PlatformError::Cancelled { process_id: None }.into());
        }
        if request.maximum_frames == 0 || request.maximum_frames > HLAE_TAKE_MAX_FRAMES {
            return Err(PlatformError::InvalidInput(
                "HLAE take frame budget is outside the bounded range".to_owned(),
            )
            .into());
        }
        if request.minimum_frames == 0 || request.minimum_frames > request.maximum_frames {
            return Err(PlatformError::InvalidInput(
                "HLAE take minimum frame requirement is outside the bounded range".to_owned(),
            )
            .into());
        }
        let inventory = inspect_hlae_take(
            &request.managed_output_root,
            &request.take_directory,
            HlaeTakeExpectation {
                width: request.width,
                height: request.height,
                require_audio: request.require_audio,
                maximum_frames: request.maximum_frames,
            },
        )?;
        if inventory.frames.len() < request.minimum_frames {
            return Err(PlatformError::InvalidInput(format!(
                "HLAE take ended early with {} frames; at least {} were required",
                inventory.frames.len(),
                request.minimum_frames
            ))
            .into());
        }
        let frame_count = u64::try_from(inventory.frames.len()).map_err(|_| {
            PlatformError::InvalidInput("HLAE frame count is unsupported".to_owned())
        })?;
        let config = NativeMp4VideoConfig {
            width: request.width,
            height: request.height,
            frame_count,
            frame_rate: RationalFrameRate {
                numerator: request.fps,
                denominator: 1,
            },
            target_bitrate_bps: request.target_bitrate_bps,
        };
        let mut writer = if request.require_audio {
            let wav = inventory.audio_wav.as_deref().ok_or_else(|| {
                PlatformError::InvalidInput("validated HLAE take has no audio.wav".to_owned())
            })?;
            NativeMp4VideoWriter::create_with_pcm_wav_at_temporary_path(
                &request.output_path,
                &request.partial_output_path,
                config,
                wav,
            )?
        } else {
            NativeMp4VideoWriter::create_at_temporary_path(
                &request.output_path,
                &request.partial_output_path,
                config,
            )?
        };
        decode_hlae_frames_ordered(
            &inventory.frames,
            hlae_decode_worker_count(),
            cancellation,
            &|_index, frame_path| {
                decode_hlae_tga_bgra(frame_path, request.width, request.height).map_err(Into::into)
            },
            |_index, frame| {
                writer
                    .write_bgra_frame(&frame, cancellation)
                    .map(|_| ())
                    .map_err(Into::into)
            },
        )?;
        let mut summary = writer.finish(cancellation)?;
        let published_identity =
            fs::canonicalize(&summary.output_path).map_err(|error| PlatformError::Io {
                operation: "canonicalizing native HLAE MP4 output",
                path: summary.output_path.clone(),
                source: error,
            })?;
        let requested_identity =
            fs::canonicalize(&request.output_path).map_err(|error| PlatformError::Io {
                operation: "canonicalizing requested HLAE MP4 output",
                path: request.output_path.clone(),
                source: error,
            })?;
        if published_identity != requested_identity {
            return Err(PlatformError::InvalidInput(
                "native encoder published a different MP4 identity than the requested output"
                    .to_owned(),
            )
            .into());
        }
        summary.output_path.clone_from(&request.output_path);
        let inspection = inspect_native_h264_mp4(&summary.output_path)?;
        Ok(HlaeTakeMp4EncodeEvidence {
            summary,
            inspection,
        })
    }
}

const MINIMUM_HLAE_GAME_DISCOVERY_TIMEOUT: Duration = Duration::from_millis(1);
const MAXIMUM_HLAE_GAME_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(300);

fn managed_hlae_process_tree_spec(
    invocation: &vibe_cs_hlae::HlaeCustomLoaderInvocation,
) -> Result<vibe_cs_platform_windows::ProcessTreeSpec, PlatformError> {
    let mut spec = vibe_cs_platform_windows::ProcessTreeSpec::new(invocation.executable())?;
    for argument in invocation.arguments() {
        spec = spec.arg(argument.clone())?;
    }
    Ok(spec)
}

fn canonical_expected_cs2_executable(path: &Path) -> Result<PathBuf, PlatformError> {
    if !path.is_absolute()
        || !path.is_file()
        || !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("cs2.exe"))
    {
        return Err(PlatformError::InvalidInput(
            "managed HLAE launch expects an existing absolute cs2.exe".to_owned(),
        ));
    }
    let canonical = std::fs::canonicalize(path).map_err(|error| {
        PlatformError::InvalidInput(format!(
            "managed HLAE expected cs2.exe could not be canonicalized: {error}"
        ))
    })?;
    if !canonical.is_file()
        || !canonical
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("cs2.exe"))
    {
        return Err(PlatformError::InvalidInput(
            "managed HLAE expected executable must resolve to cs2.exe".to_owned(),
        ));
    }
    Ok(canonical)
}

fn validate_invocation_cs2_identity(
    invocation: &vibe_cs_hlae::HlaeCustomLoaderInvocation,
    expected_cs2_executable: &Path,
) -> Result<(), PlatformError> {
    let mut program_paths = invocation
        .arguments()
        .windows(2)
        .filter(|pair| pair[0].to_str() == Some("-programPath"))
        .map(|pair| PathBuf::from(&pair[1]));
    let program_path = program_paths.next().ok_or_else(|| {
        PlatformError::InvalidInput(
            "typed HLAE invocation does not contain a -programPath".to_owned(),
        )
    })?;
    if program_paths.next().is_some() {
        return Err(PlatformError::InvalidInput(
            "typed HLAE invocation contains multiple -programPath values".to_owned(),
        ));
    }
    let program_path = canonical_expected_cs2_executable(&program_path)?;
    if !same_file::is_same_file(program_path, expected_cs2_executable).unwrap_or(false) {
        return Err(PlatformError::InvalidInput(
            "expected cs2.exe differs from the typed HLAE -programPath".to_owned(),
        ));
    }
    Ok(())
}

/// Owns the HLAE custom loader and the exact CS2 process it created.
#[derive(Debug)]
pub struct RuntimeManagedHlaeProcess {
    loader_process_id: u32,
    game_process_id: u32,
    tree: vibe_cs_platform_windows::ManagedProcessTree,
}

impl RuntimeManagedHlaeProcess {
    /// Starts the typed custom loader and waits for exactly one matching CS2
    /// process in the same Windows Job Object.
    ///
    /// # Errors
    ///
    /// Rejects invalid timeouts and returns a platform error when launch or
    /// exact process discovery cannot be completed safely.
    pub async fn launch(
        invocation: &vibe_cs_hlae::HlaeCustomLoaderInvocation,
        expected_cs2_executable: &Path,
        game_discovery_timeout: Duration,
        cancellation: &ProcessCancellation,
    ) -> Result<Self, PlatformError> {
        if !(MINIMUM_HLAE_GAME_DISCOVERY_TIMEOUT..=MAXIMUM_HLAE_GAME_DISCOVERY_TIMEOUT)
            .contains(&game_discovery_timeout)
        {
            return Err(PlatformError::InvalidInput(
                "HLAE game discovery timeout must be between 1 millisecond and 300 seconds"
                    .to_owned(),
            ));
        }
        if cancellation.is_cancelled() {
            return Err(PlatformError::Cancelled { process_id: None });
        }
        let expected_cs2_executable = canonical_expected_cs2_executable(expected_cs2_executable)?;
        validate_invocation_cs2_identity(invocation, &expected_cs2_executable)?;
        let spec = managed_hlae_process_tree_spec(invocation)?;
        let tree = vibe_cs_platform_windows::ManagedProcessTree::spawn(&spec, cancellation)?;
        let loader_process_id = tree.primary_process_id();
        let game_process_id = tree
            .wait_for_unique_process(
                &expected_cs2_executable,
                game_discovery_timeout,
                cancellation,
            )
            .await?;
        if cancellation.is_cancelled() {
            return Err(PlatformError::Cancelled {
                process_id: Some(loader_process_id),
            });
        }
        Ok(Self {
            loader_process_id,
            game_process_id,
            tree,
        })
    }

    /// Returns the primary HLAE custom-loader process identifier.
    #[must_use]
    pub const fn loader_process_id(&self) -> u32 {
        self.loader_process_id
    }

    /// Returns the unique exact-path CS2 process identifier in HLAE's job.
    #[must_use]
    pub const fn game_process_id(&self) -> u32 {
        self.game_process_id
    }

    /// Waits for the HLAE loader while retaining ownership of all descendants.
    ///
    /// # Errors
    ///
    /// Returns a platform or cancellation error. Cancellation terminates the
    /// complete managed process tree.
    pub async fn wait_loader(
        &self,
        cancellation: &ProcessCancellation,
    ) -> Result<vibe_cs_platform_windows::ProcessTreeExit, PlatformError> {
        self.tree.wait(cancellation).await
    }

    /// Terminates HLAE and every process in its Windows Job Object.
    ///
    /// # Errors
    ///
    /// Returns a platform error when the job cannot be terminated cleanly.
    pub fn close(self) -> Result<(), PlatformError> {
        self.tree.close()
    }
}

/// Process-free HLAE adapter used by desktop commands and AI tool boundaries.
///
/// Deliberately has no launch or execute method. A caller can discover an
/// installation, validate a typed plan, and preview the exact generated files.
#[derive(Debug, Default)]
pub struct RuntimeHlaePort;

impl RuntimeHlaePort {
    /// Locates the integrity-verified application-managed release without
    /// loading or running its binaries.
    #[must_use]
    pub fn discover(managed_root: &Path) -> HlaeDiscovery {
        discover_managed_hlae(managed_root)
    }

    /// Produces a dry-run bundle for review without writing or executing it.
    ///
    /// # Errors
    ///
    /// Returns [`HlaeError`] when the plan or artifact path is invalid.
    pub fn compile(
        plan: &HlaePlan,
        artifact_directory: &Path,
    ) -> Result<CompiledHlaePlan, HlaeError> {
        compile_hlae_plan(plan, artifact_directory)
    }

    /// Validates a typed camera plan and returns non-blocking review notices.
    ///
    /// # Errors
    ///
    /// Returns [`HlaeError`] when the plan contains unsafe or invalid values.
    pub fn validate(plan: &HlaePlan) -> Result<Vec<HlaeNotice>, HlaeError> {
        validate_hlae_plan(plan)
    }

    /// Atomically writes a no-clobber bundle below an application-managed root.
    ///
    /// # Errors
    ///
    /// Returns [`HlaeError`] when validation, safe staging, or atomic
    /// publication fails. Existing bundles are never replaced.
    pub fn export(
        plan: &HlaePlan,
        managed_root: &Path,
        bundle_name: &str,
        launch_inputs: &HlaeBundleLaunchInputs,
    ) -> Result<ExportedHlaePlan, HlaeError> {
        export_hlae_plan(plan, managed_root, bundle_name, launch_inputs)
    }

    /// Produces fixed official custom-loader fields with `-insecure` enforced.
    ///
    /// # Errors
    ///
    /// Returns [`HlaeError`] when an installation path, CS2 path, config root,
    /// or resolution is invalid.
    pub fn launch_profile(
        installation: &vibe_cs_hlae::HlaeInstallation,
        cs2_executable: &Path,
        steam_executable: &Path,
        moviemaking_config_root: &Path,
        resolution: LaunchResolution,
    ) -> Result<HlaeLaunchProfile, HlaeError> {
        build_hlae_launch_profile(
            installation,
            cs2_executable,
            steam_executable,
            moviemaking_config_root,
            resolution,
        )
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;
    use std::sync::{
        Arc, Barrier, Condvar, Mutex,
        atomic::{AtomicUsize, Ordering as AtomicOrdering},
    };
    use std::time::Duration;

    use super::*;

    #[test]
    fn ordered_frame_pipeline_writes_in_index_order_when_decodes_finish_out_of_order() {
        #[derive(Default)]
        struct CompletionState {
            stage: usize,
            order: Vec<usize>,
        }

        let frames = (0..4)
            .map(|index| PathBuf::from(format!("{index:05}.tga")))
            .collect::<Vec<_>>();
        let completion = Arc::new((Mutex::new(CompletionState::default()), Condvar::new()));
        let decoder_completion = Arc::clone(&completion);
        let mut written = Vec::new();

        decode_hlae_frames_ordered(
            &frames,
            3,
            &ProcessCancellation::default(),
            &move |index, _path| {
                let (state, changed) = &*decoder_completion;
                let mut state = state.lock().expect("completion state");
                let required_stage = match index {
                    0 => 2,
                    1 => 1,
                    _ => 0,
                };
                state = changed
                    .wait_while(state, |state| state.stage < required_stage)
                    .expect("completion state");
                state.order.push(index);
                state.stage += 1;
                changed.notify_all();
                Ok(vec![u8::try_from(index).expect("test index")])
            },
            |index, frame| {
                written.push((index, frame[0]));
                Ok(())
            },
        )
        .expect("ordered decode pipeline");

        assert_eq!(
            completion.0.lock().expect("completion state").order,
            vec![2, 1, 0, 3]
        );
        assert_eq!(written, vec![(0, 0), (1, 1), (2, 2), (3, 3)]);
    }

    #[test]
    fn ordered_frame_pipeline_bounds_concurrency_and_decoded_frames_to_its_worker_window() {
        const WORKERS: usize = 4;
        let frames = (0..16)
            .map(|index| PathBuf::from(format!("{index:05}.tga")))
            .collect::<Vec<_>>();
        let first_window = Arc::new(Barrier::new(WORKERS));
        let active_decodes = Arc::new(AtomicUsize::new(0));
        let maximum_active_decodes = Arc::new(AtomicUsize::new(0));
        let decoded_frames = Arc::new(AtomicUsize::new(0));
        let written_frames = Arc::new(AtomicUsize::new(0));
        let maximum_resident_frames = Arc::new(AtomicUsize::new(0));

        decode_hlae_frames_ordered(
            &frames,
            WORKERS,
            &ProcessCancellation::default(),
            &{
                let first_window = Arc::clone(&first_window);
                let active_decodes = Arc::clone(&active_decodes);
                let maximum_active_decodes = Arc::clone(&maximum_active_decodes);
                let decoded_frames = Arc::clone(&decoded_frames);
                let written_frames = Arc::clone(&written_frames);
                let maximum_resident_frames = Arc::clone(&maximum_resident_frames);
                move |index, _path| {
                    let active = active_decodes.fetch_add(1, AtomicOrdering::SeqCst) + 1;
                    maximum_active_decodes.fetch_max(active, AtomicOrdering::SeqCst);
                    if index < WORKERS {
                        first_window.wait();
                    }
                    std::thread::sleep(Duration::from_millis(2));
                    active_decodes.fetch_sub(1, AtomicOrdering::SeqCst);
                    let decoded = decoded_frames.fetch_add(1, AtomicOrdering::SeqCst) + 1;
                    let resident = decoded - written_frames.load(AtomicOrdering::SeqCst);
                    maximum_resident_frames.fetch_max(resident, AtomicOrdering::SeqCst);
                    Ok(vec![u8::try_from(index).expect("test index")])
                }
            },
            {
                let written_frames = Arc::clone(&written_frames);
                move |_index, _frame| {
                    std::thread::sleep(Duration::from_millis(2));
                    written_frames.fetch_add(1, AtomicOrdering::SeqCst);
                    Ok(())
                }
            },
        )
        .expect("bounded ordered decode pipeline");

        assert_eq!(maximum_active_decodes.load(AtomicOrdering::SeqCst), WORKERS);
        assert!(
            maximum_resident_frames.load(AtomicOrdering::SeqCst) <= WORKERS,
            "the sliding window must bound decoded frames independently of sequence length"
        );
        assert_eq!(written_frames.load(AtomicOrdering::SeqCst), frames.len());
    }

    #[test]
    fn ordered_frame_pipeline_stops_and_joins_every_worker_on_the_first_decode_error() {
        const WORKERS: usize = 3;
        let frames = (0..100)
            .map(|index| PathBuf::from(format!("{index:05}.tga")))
            .collect::<Vec<_>>();
        let first_window = Arc::new(Barrier::new(WORKERS));
        let active_decodes = Arc::new(AtomicUsize::new(0));
        let started_decodes = Arc::new(AtomicUsize::new(0));
        let writes = Arc::new(AtomicUsize::new(0));

        let error = decode_hlae_frames_ordered(
            &frames,
            WORKERS,
            &ProcessCancellation::default(),
            &{
                let first_window = Arc::clone(&first_window);
                let active_decodes = Arc::clone(&active_decodes);
                let started_decodes = Arc::clone(&started_decodes);
                move |index, _path| {
                    started_decodes.fetch_add(1, AtomicOrdering::SeqCst);
                    active_decodes.fetch_add(1, AtomicOrdering::SeqCst);
                    first_window.wait();
                    if index == 1 {
                        active_decodes.fetch_sub(1, AtomicOrdering::SeqCst);
                        return Err(HlaeTakeMp4EncodeError::DecodePipeline(
                            "synthetic decoder failure".to_owned(),
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(20));
                    active_decodes.fetch_sub(1, AtomicOrdering::SeqCst);
                    Ok(vec![0])
                }
            },
            {
                let writes = Arc::clone(&writes);
                move |_index, _frame| {
                    writes.fetch_add(1, AtomicOrdering::SeqCst);
                    Ok(())
                }
            },
        )
        .expect_err("first decoder error must stop the pipeline");

        assert!(matches!(
            error,
            HlaeTakeMp4EncodeError::DecodePipeline(message)
                if message == "synthetic decoder failure"
        ));
        assert_eq!(started_decodes.load(AtomicOrdering::SeqCst), WORKERS);
        assert_eq!(active_decodes.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(writes.load(AtomicOrdering::SeqCst), 0);
    }

    #[test]
    fn ordered_frame_pipeline_stops_dispatching_and_joins_workers_when_cancelled() {
        const WORKERS: usize = 3;
        let frames = (0..100)
            .map(|index| PathBuf::from(format!("{index:05}.tga")))
            .collect::<Vec<_>>();
        let cancellation = ProcessCancellation::default();
        let cancellation_trigger = cancellation.clone();
        let first_window = Arc::new(Barrier::new(WORKERS));
        let active_decodes = Arc::new(AtomicUsize::new(0));
        let started_decodes = Arc::new(AtomicUsize::new(0));
        let writes = Arc::new(AtomicUsize::new(0));

        let error = decode_hlae_frames_ordered(
            &frames,
            WORKERS,
            &cancellation,
            &{
                let first_window = Arc::clone(&first_window);
                let active_decodes = Arc::clone(&active_decodes);
                let started_decodes = Arc::clone(&started_decodes);
                move |index, _path| {
                    started_decodes.fetch_add(1, AtomicOrdering::SeqCst);
                    active_decodes.fetch_add(1, AtomicOrdering::SeqCst);
                    first_window.wait();
                    if index == 0 {
                        cancellation_trigger.cancel();
                    }
                    std::thread::sleep(Duration::from_millis(20));
                    active_decodes.fetch_sub(1, AtomicOrdering::SeqCst);
                    Ok(vec![0])
                }
            },
            {
                let writes = Arc::clone(&writes);
                move |_index, _frame| {
                    writes.fetch_add(1, AtomicOrdering::SeqCst);
                    Ok(())
                }
            },
        )
        .expect_err("cancelled decode pipeline must stop");

        assert!(matches!(
            error,
            HlaeTakeMp4EncodeError::Platform(PlatformError::Cancelled { process_id: None })
        ));
        assert_eq!(started_decodes.load(AtomicOrdering::SeqCst), WORKERS);
        assert_eq!(active_decodes.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(writes.load(AtomicOrdering::SeqCst), 0);
    }

    struct ManagedLaunchFixture {
        _directory: tempfile::TempDir,
        invocation: vibe_cs_hlae::HlaeCustomLoaderInvocation,
        cs2_executable: PathBuf,
    }

    fn managed_launch_fixture() -> ManagedLaunchFixture {
        let directory = tempfile::tempdir().expect("temporary launch fixture");
        let root = directory.path();
        let hlae_root = root.join("hlae");
        let hlae_executable = hlae_root.join("HLAE.exe");
        let hook_library = hlae_root.join("x64").join("AfxHookSource2.dll");
        let cs2_executable = root.join("game").join("bin").join("win64").join("cs2.exe");
        let steam_executable = root.join("steam").join("steam.exe");
        let moviemaking_config_root = root.join("moviemaking");
        for parent in [
            hlae_executable.parent().expect("HLAE parent"),
            hook_library.parent().expect("hook parent"),
            cs2_executable.parent().expect("CS2 parent"),
            steam_executable.parent().expect("Steam parent"),
            moviemaking_config_root.as_path(),
        ] {
            std::fs::create_dir_all(parent).expect("launch fixture directory");
        }
        for file in [
            &hlae_executable,
            &hook_library,
            &cs2_executable,
            &steam_executable,
        ] {
            std::fs::write(file, b"test fixture").expect("launch fixture file");
        }
        let installation = vibe_cs_hlae::HlaeInstallation {
            root: hlae_root,
            executable: hlae_executable,
            source2_hook: hook_library,
            source: vibe_cs_hlae::HlaeDiscoverySource::Managed,
        };
        let profile = RuntimeHlaePort::launch_profile(
            &installation,
            &cs2_executable,
            &steam_executable,
            &moviemaking_config_root,
            LaunchResolution {
                width: 1280,
                height: 720,
            },
        )
        .expect("typed launch profile");
        let demo = root.join("fixture.dem");
        let commands = moviemaking_config_root.join("vibe_cs_commands.xml");
        let bridge = moviemaking_config_root.join(vibe_cs_hlae::HLAE_MIRV_BRIDGE_FILE_NAME);
        for file in [&demo, &commands, &bridge] {
            std::fs::write(file, b"managed session fixture").expect("managed session artifact");
        }
        let bootstrap = vibe_cs_hlae::compile_hlae_managed_session_bootstrap(
            &moviemaking_config_root,
            &demo,
            &commands,
            &bridge,
        )
        .expect("typed managed session bootstrap");
        std::fs::create_dir_all(bootstrap.path().parent().expect("bootstrap parent"))
            .expect("bootstrap cfg directory");
        std::fs::write(bootstrap.path(), bootstrap.contents()).expect("published bootstrap");
        let invocation = vibe_cs_hlae::build_hlae_managed_session_invocation(&profile, &bootstrap)
            .expect("typed managed-session custom-loader invocation");
        ManagedLaunchFixture {
            _directory: directory,
            invocation,
            cs2_executable,
        }
    }

    #[tokio::test]
    async fn managed_hlae_launch_rejects_an_unbounded_game_discovery_wait_before_spawning() {
        for timeout in [Duration::ZERO, Duration::from_secs(301)] {
            let fixture = managed_launch_fixture();
            let error = RuntimeManagedHlaeProcess::launch(
                &fixture.invocation,
                &fixture.cs2_executable,
                timeout,
                &ProcessCancellation::default(),
            )
            .await
            .expect_err("game discovery timeout must be bounded");

            assert!(matches!(error, PlatformError::InvalidInput(_)));
        }
    }

    #[tokio::test]
    async fn managed_hlae_launch_honors_cancellation_before_touching_a_process() {
        let fixture = managed_launch_fixture();
        let cancellation = ProcessCancellation::default();
        cancellation.cancel();

        let error = RuntimeManagedHlaeProcess::launch(
            &fixture.invocation,
            &fixture.cs2_executable,
            Duration::from_secs(1),
            &cancellation,
        )
        .await
        .expect_err("pre-cancelled HLAE launch must not start a process");

        assert!(matches!(
            error,
            PlatformError::Cancelled { process_id: None }
        ));
    }

    #[test]
    fn managed_hlae_spec_preserves_the_typed_invocation_as_literal_argv() {
        let fixture = managed_launch_fixture();
        let actual = managed_hlae_process_tree_spec(&fixture.invocation)
            .expect("runtime managed process specification");
        let mut expected =
            vibe_cs_platform_windows::ProcessTreeSpec::new(fixture.invocation.executable())
                .expect("expected direct executable");
        for argument in fixture.invocation.arguments() {
            expected = expected
                .arg(argument.clone())
                .expect("expected literal argument");
        }

        assert_eq!(actual, expected);
        assert!(fixture.invocation.arguments().iter().any(|argument| {
            argument
                .to_str()
                .is_some_and(|value| value.ends_with("+exec vibe_cs_managed_session.cfg"))
        }));
        assert!(
            !format!("{actual:?}")
                .to_ascii_lowercase()
                .contains("powershell")
        );
    }

    #[tokio::test]
    async fn managed_hlae_launch_rejects_a_non_cs2_identity_before_spawning() {
        let fixture = managed_launch_fixture();
        let wrong_executable = fixture
            .cs2_executable
            .parent()
            .expect("CS2 parent")
            .join("not-cs2.exe");
        std::fs::write(&wrong_executable, b"wrong process identity")
            .expect("wrong executable fixture");

        let error = RuntimeManagedHlaeProcess::launch(
            &fixture.invocation,
            &wrong_executable,
            Duration::from_secs(1),
            &ProcessCancellation::default(),
        )
        .await
        .expect_err("managed launch must bind only an exact cs2.exe identity");

        assert!(matches!(error, PlatformError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn managed_hlae_launch_rejects_a_cs2_path_that_differs_from_the_typed_invocation() {
        let fixture = managed_launch_fixture();
        let other_cs2 = fixture
            .cs2_executable
            .parent()
            .expect("CS2 parent")
            .join("other-installation")
            .join("cs2.exe");
        std::fs::create_dir_all(other_cs2.parent().expect("other CS2 parent"))
            .expect("other CS2 directory");
        std::fs::write(&other_cs2, b"other cs2 identity").expect("other CS2 fixture");

        let error = RuntimeManagedHlaeProcess::launch(
            &fixture.invocation,
            &other_cs2,
            Duration::from_secs(1),
            &ProcessCancellation::default(),
        )
        .await
        .expect_err("discovery identity must match the typed -programPath");

        assert!(matches!(error, PlatformError::InvalidInput(_)));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn managed_hlae_launch_reaches_the_windows_job_backend() {
        let fixture = managed_launch_fixture();

        let error = RuntimeManagedHlaeProcess::launch(
            &fixture.invocation,
            &fixture.cs2_executable,
            Duration::from_millis(1),
            &ProcessCancellation::default(),
        )
        .await
        .expect_err("the fixture HLAE.exe is intentionally not a PE executable");

        assert!(
            !matches!(error, PlatformError::Unsupported),
            "Windows launch must route through the Job Object backend"
        );
    }

    #[cfg(unix)]
    fn create_directory_link(original: &Path, link: &Path) {
        std::os::unix::fs::symlink(original, link).expect("directory symlink");
    }

    #[cfg(windows)]
    fn create_directory_link(original: &Path, link: &Path) {
        let output = std::process::Command::new("cmd")
            .args([
                "/d",
                "/c",
                "mklink",
                "/J",
                &link.to_string_lossy(),
                &original.to_string_lossy(),
            ])
            .output()
            .expect("create directory junction");
        assert!(
            output.status.success(),
            "unable to create test junction: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn write_test_tga(path: &Path, width: u16, height: u16) {
        let mut bytes = vec![0_u8; 18];
        bytes[2] = 2;
        bytes[12..14].copy_from_slice(&width.to_le_bytes());
        bytes[14..16].copy_from_slice(&height.to_le_bytes());
        bytes[16] = 24;
        bytes[17] = 0x20;
        bytes.resize(18 + usize::from(width) * usize::from(height) * 3, 0x40);
        std::fs::write(path, bytes).expect("test TGA");
    }

    fn write_test_pcm_wav(path: &Path, sample_frame_count: u32) {
        const CHANNEL_COUNT: u16 = 2;
        const SAMPLE_RATE: u32 = 48_000;
        const BITS_PER_SAMPLE: u16 = 16;
        let block_align = CHANNEL_COUNT * (BITS_PER_SAMPLE / 8);
        let data_bytes = sample_frame_count * u32::from(block_align);
        let mut bytes = Vec::with_capacity(44 + data_bytes as usize);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&CHANNEL_COUNT.to_le_bytes());
        bytes.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
        bytes.extend_from_slice(&(SAMPLE_RATE * u32::from(block_align)).to_le_bytes());
        bytes.extend_from_slice(&block_align.to_le_bytes());
        bytes.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_bytes.to_le_bytes());
        bytes.resize(44 + data_bytes as usize, 0);
        std::fs::write(path, bytes).expect("test PCM WAV");
    }

    #[tokio::test]
    async fn take_stability_waits_for_a_growing_frame_then_returns_the_valid_inventory() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let managed_root = directory.path().join("managed");
        let take_directory = managed_root.join("take0000");
        std::fs::create_dir_all(&take_directory).expect("managed take directory");
        let frame = take_directory.join("00000.tga");
        let mut header = vec![0_u8; 18];
        header[2] = 2;
        header[12..14].copy_from_slice(&10_u16.to_le_bytes());
        header[14..16].copy_from_slice(&1_u16.to_le_bytes());
        header[16] = 24;
        header[17] = 0x20;
        std::fs::write(&frame, header).expect("partial TGA header");

        let growing_frame = frame.clone();
        let writer = tokio::spawn(async move {
            for _ in 0..10 {
                tokio::time::sleep(Duration::from_millis(3)).await;
                std::fs::OpenOptions::new()
                    .append(true)
                    .open(&growing_frame)
                    .expect("open growing frame")
                    .write_all(&[0x10, 0x20, 0x30])
                    .expect("grow frame");
            }
        });

        let inventory = wait_for_stable_hlae_take(
            &managed_root,
            &take_directory,
            HlaeTakeExpectation {
                width: 10,
                height: 1,
                require_audio: false,
                maximum_frames: 60,
            },
            HlaeTakeStabilityPolicy {
                poll_interval: Duration::from_millis(5),
                required_unchanged_polls: 3,
                // The full HLAE test filter runs many filesystem-heavy tests in
                // parallel on Windows. Keep this comfortably above the 30 ms
                // synthetic write while preserving the bounded wait contract.
                timeout: Duration::from_secs(2),
            },
            &ProcessCancellation::default(),
        )
        .await
        .expect("completed HLAE take becomes stable");
        writer.await.expect("frame writer");

        assert_eq!(
            inventory.frames,
            vec![std::fs::canonicalize(frame).expect("canonical test frame")]
        );
    }

    #[tokio::test]
    async fn take_stability_times_out_while_a_take_never_stops_growing() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let managed_root = directory.path().join("managed");
        let take_directory = managed_root.join("take0000");
        std::fs::create_dir_all(&take_directory).expect("managed take directory");
        let frame = take_directory.join("00000.tga");
        std::fs::write(&frame, b"still being flushed").expect("growing artifact");
        let growing_frame = frame.clone();
        let writer = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(2)).await;
                std::fs::OpenOptions::new()
                    .append(true)
                    .open(&growing_frame)
                    .expect("open growing frame")
                    .write_all(&[0])
                    .expect("grow frame");
            }
        });

        let error = wait_for_stable_hlae_take(
            &managed_root,
            &take_directory,
            HlaeTakeExpectation {
                width: 1,
                height: 1,
                require_audio: false,
                maximum_frames: 60,
            },
            HlaeTakeStabilityPolicy {
                poll_interval: Duration::from_millis(5),
                required_unchanged_polls: 3,
                timeout: Duration::from_millis(80),
            },
            &ProcessCancellation::default(),
        )
        .await
        .expect_err("continuously growing take must time out");
        writer.abort();
        let _ = writer.await;

        assert!(matches!(error, HlaeTakeStabilityError::TimedOut { .. }));
    }

    #[tokio::test]
    async fn take_stability_stops_promptly_when_cancelled() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let managed_root = directory.path().join("managed");
        let take_directory = managed_root.join("take0000");
        std::fs::create_dir_all(&take_directory).expect("managed take directory");
        write_test_tga(&take_directory.join("00000.tga"), 1, 1);
        let cancellation = ProcessCancellation::default();
        let cancellation_trigger = cancellation.clone();
        let trigger = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancellation_trigger.cancel();
        });

        let error = wait_for_stable_hlae_take(
            &managed_root,
            &take_directory,
            HlaeTakeExpectation {
                width: 1,
                height: 1,
                require_audio: false,
                maximum_frames: 60,
            },
            HlaeTakeStabilityPolicy {
                poll_interval: Duration::from_millis(10),
                required_unchanged_polls: 20,
                timeout: Duration::from_millis(500),
            },
            &cancellation,
        )
        .await
        .expect_err("cancelled stabilization must stop");
        trigger.await.expect("cancellation trigger");

        assert!(matches!(error, HlaeTakeStabilityError::Cancelled));
    }

    #[tokio::test]
    async fn take_stability_rejects_a_stable_malformed_frame() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let managed_root = directory.path().join("managed");
        let take_directory = managed_root.join("take0000");
        std::fs::create_dir_all(&take_directory).expect("managed take directory");
        std::fs::write(take_directory.join("00000.tga"), b"truncated")
            .expect("malformed stable frame");

        let error = wait_for_stable_hlae_take(
            &managed_root,
            &take_directory,
            HlaeTakeExpectation {
                width: 1,
                height: 1,
                require_audio: false,
                maximum_frames: 60,
            },
            HlaeTakeStabilityPolicy {
                poll_interval: Duration::from_millis(2),
                required_unchanged_polls: 2,
                timeout: Duration::from_millis(500),
            },
            &ProcessCancellation::default(),
        )
        .await
        .expect_err("stable malformed take must fail exact inspection");

        assert!(matches!(error, HlaeTakeStabilityError::Capture(_)));
        assert!(
            error.to_string().contains("failed to fill whole buffer"),
            "unexpected malformed-frame error: {error}"
        );
    }

    #[tokio::test]
    async fn take_stability_rejects_a_take_outside_the_managed_root() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let managed_root = directory.path().join("managed");
        let outside_take = directory.path().join("outside").join("take0000");
        std::fs::create_dir_all(&managed_root).expect("managed root");
        std::fs::create_dir_all(&outside_take).expect("outside take");
        write_test_tga(&outside_take.join("00000.tga"), 1, 1);

        let error = wait_for_stable_hlae_take(
            &managed_root,
            &outside_take,
            HlaeTakeExpectation {
                width: 1,
                height: 1,
                require_audio: false,
                maximum_frames: 60,
            },
            HlaeTakeStabilityPolicy::default(),
            &ProcessCancellation::default(),
        )
        .await
        .expect_err("outside take must fail before polling");

        assert!(matches!(error, HlaeTakeStabilityError::Capture(_)));
        assert!(error.to_string().contains("strict descendant"));
    }

    #[tokio::test]
    async fn take_stability_rejects_a_linked_take_even_when_its_target_is_managed() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let managed_root = directory.path().join("managed");
        let real_take = managed_root.join("real-take");
        let linked_take = managed_root.join("take0000");
        std::fs::create_dir_all(&real_take).expect("real managed take");
        write_test_tga(&real_take.join("00000.tga"), 1, 1);
        create_directory_link(&real_take, &linked_take);

        let error = wait_for_stable_hlae_take(
            &managed_root,
            &linked_take,
            HlaeTakeExpectation {
                width: 1,
                height: 1,
                require_audio: false,
                maximum_frames: 60,
            },
            HlaeTakeStabilityPolicy::default(),
            &ProcessCancellation::default(),
        )
        .await
        .expect_err("linked take must fail before polling");

        assert!(matches!(error, HlaeTakeStabilityError::Capture(_)));
        assert!(error.to_string().contains("regular non-link directory"));
    }

    #[tokio::test]
    async fn take_stability_rejects_nested_or_unexpected_direct_entries_before_polling() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let managed_root = directory.path().join("managed");
        let take_directory = managed_root.join("take0000");
        std::fs::create_dir_all(take_directory.join("vibe_world"))
            .expect("unsupported world layer");

        let error = wait_for_stable_hlae_take(
            &managed_root,
            &take_directory,
            HlaeTakeExpectation {
                width: 1,
                height: 1,
                require_audio: false,
                maximum_frames: 60,
            },
            HlaeTakeStabilityPolicy::default(),
            &ProcessCancellation::default(),
        )
        .await
        .expect_err("nested layer output is outside the screen-only contract");
        assert!(error.to_string().contains("unexpected non-file"));

        std::fs::remove_dir(take_directory.join("vibe_world")).expect("remove layer directory");
        std::fs::write(take_directory.join("capture.log"), b"unexpected")
            .expect("unexpected direct artifact");
        let error = wait_for_stable_hlae_take(
            &managed_root,
            &take_directory,
            HlaeTakeExpectation {
                width: 1,
                height: 1,
                require_audio: false,
                maximum_frames: 60,
            },
            HlaeTakeStabilityPolicy::default(),
            &ProcessCancellation::default(),
        )
        .await
        .expect_err("unexpected direct artifact is outside the screen-only contract");
        assert!(error.to_string().contains("unexpected take artifact"));
    }

    #[test]
    fn adapter_checks_only_the_managed_release_location() {
        let managed_root = Path::new("missing/managed-hlae");
        let discovery = RuntimeHlaePort::discover(managed_root);
        assert!(discovery.installation.is_none());
        assert_eq!(
            discovery.checked_locations,
            vec![vibe_cs_hlae::managed_hlae_release_directory(managed_root).join("HLAE.exe")]
        );
    }

    #[test]
    fn sequence_encoder_rejects_a_gapped_take_without_publishing_an_mp4() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let managed_root = directory.path().join("managed");
        let take_directory = managed_root.join("take0000");
        std::fs::create_dir_all(&take_directory).expect("managed take directory");
        write_test_tga(&take_directory.join("00000.tga"), 320, 240);
        write_test_tga(&take_directory.join("00002.tga"), 320, 240);
        let output = directory.path().join("result.mp4");

        let error = RuntimeHlaeSequenceEncoder::encode(
            &HlaeTakeMp4EncodeRequest {
                managed_output_root: managed_root,
                take_directory,
                output_path: output.clone(),
                partial_output_path: output.with_extension("partial.mp4"),
                width: 320,
                height: 240,
                fps: 60,
                target_bitrate_bps: 4_000_000,
                require_audio: false,
                maximum_frames: 60,
                minimum_frames: 1,
            },
            &vibe_cs_platform_windows::ProcessCancellation::default(),
        )
        .expect_err("gapped HLAE sequence must fail closed");

        assert!(matches!(error, HlaeTakeMp4EncodeError::Capture(_)));
        assert!(!output.exists());
    }

    #[test]
    fn sequence_encoder_rejects_a_contiguous_but_prematurely_stopped_take() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let managed_root = directory.path().join("managed");
        let take_directory = managed_root.join("take0000");
        std::fs::create_dir_all(&take_directory).expect("managed take directory");
        write_test_tga(&take_directory.join("00000.tga"), 320, 240);
        let output = directory.path().join("result.mp4");

        let error = RuntimeHlaeSequenceEncoder::encode(
            &HlaeTakeMp4EncodeRequest {
                managed_output_root: managed_root,
                take_directory,
                output_path: output.clone(),
                partial_output_path: output.with_extension("partial.mp4"),
                width: 320,
                height: 240,
                fps: 60,
                target_bitrate_bps: 4_000_000,
                require_audio: false,
                maximum_frames: 120,
                minimum_frames: 119,
            },
            &ProcessCancellation::default(),
        )
        .expect_err("an early clean stop must not publish a short MP4");

        assert!(matches!(
            error,
            HlaeTakeMp4EncodeError::Platform(PlatformError::InvalidInput(message))
                if message.contains("ended early")
        ));
        assert!(!output.exists());
    }

    #[test]
    fn sequence_encoder_rejects_unknown_take_artifacts_without_publishing() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let managed_root = directory.path().join("managed");
        let take_directory = managed_root.join("take0000");
        std::fs::create_dir_all(&take_directory).expect("managed take directory");
        write_test_tga(&take_directory.join("00000.tga"), 320, 240);
        std::fs::write(take_directory.join("unexpected.txt"), b"not an HLAE frame")
            .expect("unexpected take artifact");
        let output = directory.path().join("result.mp4");

        let error = RuntimeHlaeSequenceEncoder::encode(
            &HlaeTakeMp4EncodeRequest {
                managed_output_root: managed_root,
                take_directory,
                output_path: output.clone(),
                partial_output_path: output.with_extension("partial.mp4"),
                width: 320,
                height: 240,
                fps: 60,
                target_bitrate_bps: 4_000_000,
                require_audio: false,
                maximum_frames: 60,
                minimum_frames: 1,
            },
            &ProcessCancellation::default(),
        )
        .expect_err("unknown take artifacts must fail closed");

        assert!(matches!(error, HlaeTakeMp4EncodeError::Capture(_)));
        assert!(!output.exists());
    }

    #[test]
    fn sequence_encoder_rejects_a_malformed_wav_before_publishing() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let managed_root = directory.path().join("managed");
        let take_directory = managed_root.join("take0000");
        std::fs::create_dir_all(&take_directory).expect("managed take directory");
        write_test_tga(&take_directory.join("00000.tga"), 320, 240);
        std::fs::write(take_directory.join("audio.wav"), b"RIFF\0\0\0\0WAVE")
            .expect("malformed marker-only WAV");
        let output = directory.path().join("result.mp4");

        let error = RuntimeHlaeSequenceEncoder::encode(
            &HlaeTakeMp4EncodeRequest {
                managed_output_root: managed_root,
                take_directory,
                output_path: output.clone(),
                partial_output_path: output.with_extension("partial.mp4"),
                width: 320,
                height: 240,
                fps: 60,
                target_bitrate_bps: 4_000_000,
                require_audio: true,
                maximum_frames: 60,
                minimum_frames: 1,
            },
            &ProcessCancellation::default(),
        )
        .expect_err("malformed PCM WAV must fail closed");

        assert!(matches!(
            error,
            HlaeTakeMp4EncodeError::Platform(PlatformError::InvalidInput(_))
        ));
        assert!(!output.exists());
    }

    #[test]
    fn sequence_encoder_honors_pre_cancellation_without_publishing() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let output = directory.path().join("cancelled.mp4");
        let cancellation = ProcessCancellation::default();
        cancellation.cancel();

        let error = RuntimeHlaeSequenceEncoder::encode(
            &HlaeTakeMp4EncodeRequest {
                managed_output_root: directory.path().join("missing-managed-root"),
                take_directory: directory.path().join("missing-take"),
                output_path: output.clone(),
                partial_output_path: output.with_extension("partial.mp4"),
                width: 320,
                height: 240,
                fps: 60,
                target_bitrate_bps: 4_000_000,
                require_audio: false,
                maximum_frames: 60,
                minimum_frames: 1,
            },
            &cancellation,
        )
        .expect_err("pre-cancelled encode must stop before filesystem work");

        assert!(matches!(
            error,
            HlaeTakeMp4EncodeError::Platform(PlatformError::Cancelled { process_id: None })
        ));
        assert!(!output.exists());
    }

    #[test]
    fn sequence_encoder_never_overwrites_an_existing_destination() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let managed_root = directory.path().join("managed");
        let take_directory = managed_root.join("take0000");
        std::fs::create_dir_all(&take_directory).expect("managed take directory");
        write_test_tga(&take_directory.join("00000.tga"), 320, 240);
        let output = directory.path().join("result.mp4");
        std::fs::write(&output, b"keep me").expect("existing destination");

        let error = RuntimeHlaeSequenceEncoder::encode(
            &HlaeTakeMp4EncodeRequest {
                managed_output_root: managed_root,
                take_directory,
                output_path: output.clone(),
                partial_output_path: output.with_extension("partial.mp4"),
                width: 320,
                height: 240,
                fps: 60,
                target_bitrate_bps: 4_000_000,
                require_audio: false,
                maximum_frames: 60,
                minimum_frames: 1,
            },
            &ProcessCancellation::default(),
        )
        .expect_err("existing MP4 destination must not be replaced");

        assert!(matches!(
            error,
            HlaeTakeMp4EncodeError::Platform(PlatformError::RecoveryPending)
        ));
        assert_eq!(
            std::fs::read(output).expect("existing destination"),
            b"keep me"
        );
    }

    #[test]
    fn sequence_encoder_preserves_the_exact_leased_partial_output() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let managed_root = directory.path().join("managed");
        let take_directory = managed_root.join("take0000");
        std::fs::create_dir_all(&take_directory).expect("managed take directory");
        write_test_tga(&take_directory.join("00000.tga"), 320, 240);
        let output = directory.path().join("result.mp4");
        let partial = directory.path().join("result.partial.mp4");
        std::fs::write(&partial, b"crash evidence").expect("existing leased partial");

        let error = RuntimeHlaeSequenceEncoder::encode(
            &HlaeTakeMp4EncodeRequest {
                managed_output_root: managed_root,
                take_directory,
                output_path: output.clone(),
                partial_output_path: partial.clone(),
                width: 320,
                height: 240,
                fps: 60,
                target_bitrate_bps: 4_000_000,
                require_audio: false,
                maximum_frames: 60,
                minimum_frames: 1,
            },
            &ProcessCancellation::default(),
        )
        .expect_err("the encoder must never truncate a leased partial output");

        assert!(matches!(
            error,
            HlaeTakeMp4EncodeError::Platform(PlatformError::RecoveryPending)
        ));
        assert_eq!(
            std::fs::read(partial).expect("existing partial survives"),
            b"crash evidence"
        );
        assert!(!output.exists());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "runs the real Windows Media Foundation H.264/AAC pipeline"]
    fn sequence_encoder_streams_a_managed_hlae_take_to_verified_h264_aac_mp4() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let managed_root = directory.path().join("managed");
        let take_directory = managed_root.join("take0000");
        std::fs::create_dir_all(&take_directory).expect("managed take directory");
        for index in 0..3 {
            write_test_tga(&take_directory.join(format!("{index:05}.tga")), 320, 240);
        }
        write_test_pcm_wav(&take_directory.join("audio.wav"), 4_800);
        let output = directory.path().join("result.mp4");

        let evidence = RuntimeHlaeSequenceEncoder::encode(
            &HlaeTakeMp4EncodeRequest {
                managed_output_root: managed_root,
                take_directory,
                output_path: output.clone(),
                partial_output_path: output.with_extension("partial.mp4"),
                width: 320,
                height: 240,
                fps: 30,
                target_bitrate_bps: 2_000_000,
                require_audio: true,
                maximum_frames: 60,
                minimum_frames: 1,
            },
            &ProcessCancellation::default(),
        )
        .expect("real Media Foundation encode");

        assert_eq!(evidence.summary.output_path, output);
        assert_eq!(evidence.summary.frame_count, 3);
        assert!(evidence.summary.audio_stream_included);
        assert!(evidence.inspection.video_subtype_is_h264);
        assert!(evidence.inspection.audio_stream_is_aac);
        assert_eq!(
            (evidence.inspection.width, evidence.inspection.height),
            (320, 240)
        );
        assert_eq!(evidence.inspection.sample_count, 3);
        assert!(evidence.inspection.timestamps_are_monotonic);
        assert!(evidence.inspection.audio_timestamps_are_monotonic);
        assert!(output.is_file());
    }
}
