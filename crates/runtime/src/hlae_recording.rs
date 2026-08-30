//! Production recording backend backed by one managed HLAE session and the
//! native Windows Media Foundation MP4 encoder.

use std::{
    collections::{HashMap, HashSet},
    fmt, fs,
    io::Write as _,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest as _, Sha256};
use uuid::Uuid;
use vibe_cs_domain::{
    AppConfig, DomainError, HlaeCameraStyle, RecordedClip, RecordingJob, RecordingRequest,
    RecordingVoicePolicy,
};
use vibe_cs_hlae::{
    CameraShot, CaptureLayers, CaptureSettings, HLAE_SESSION_MAX_TAKES, HLAE_TAKE_MAX_FRAMES,
    HlaeBundleLaunchInputs, HlaeDiscoverySource, HlaeHudVisibility, HlaePlan, HlaePlanMode,
    HlaePlayerPovCapturePlan, HlaePlayerPovPresentation, HlaeRadarVisibility,
    HlaeScenePresentation, HlaeVoicePolicy, LaunchResolution, PositionInterpolation,
    RotationInterpolation, discover_managed_hlae, validate_hlae_plan,
};
use vibe_cs_integrations::{discover_active_cs2_user_config, discover_paths};
use vibe_cs_platform_windows::{
    HlaeSequenceEncoderCapabilityReport, ProcessCancellation, atomic_write,
    probe_hlae_sequence_encoder_capabilities,
};

use crate::hlae_session::RuntimeHlaePersistentSession;
use crate::recording::verify_recording_demo_content;
use crate::{
    HlaeTakeMp4EncodeError, HlaeTakeStabilityError, HlaeTakeStabilityPolicy,
    OrphanedRecordingRecovery, PreparedRecording, RecordingBackend, RecordingCancellation,
    RecordingProgressSink, RuntimeHlaeBridgeError, RuntimeHlaeCaptureProgram,
    RuntimeHlaeSessionError, RuntimeHlaeSessionEvidence, RuntimeHlaeSessionOrchestrator,
    RuntimeHlaeSessionRequest, RuntimeHlaeSessionTimeouts,
};

const MANAGED_HLAE_JOB_DIRECTORY: &str = "hlae-jobs";
const MANAGED_HLAE_LEASE_DIRECTORY: &str = "hlae-leases";
const RECORDED_CLIP_DIRECTORY: &str = "recordings";
const MANAGED_CAPTURE_BACKEND: &str = "managed_hlae_windows_mf";
const MANAGED_HLAE_LEASE_PRODUCER: &str = "vibe-cs-runtime/managed-hlae";
const MANAGED_HLAE_LEASE_MAX_BYTES: u64 = 16 * 1_024;
const MANAGED_HLAE_STAGED_OUTPUT_FILE: &str = "encoded-output.mp4";
const MANAGED_HLAE_PARTIAL_OUTPUT_FILE: &str = ".encoded-output.partial.mp4";
const CAPTURE_SCHEDULER_OVERSHOOT_TICKS: u32 = 8;
const MINIMUM_NATIVE_BITRATE_BPS: u64 = 4_000_000;
const MAXIMUM_NATIVE_BITRATE_BPS: u64 = 80_000_000;
const SESSION_RUNNER_SHUTDOWN_MARGIN: std::time::Duration = std::time::Duration::from_millis(250);

#[derive(Debug, Clone, PartialEq, Eq)]
struct ManagedRecordingRoots {
    data: PathBuf,
    jobs: PathBuf,
    leases: PathBuf,
    recordings: PathBuf,
}

impl ManagedRecordingRoots {
    fn from_created(data_dir: &Path) -> Result<Self, DomainError> {
        let data = canonical_plain_directory(data_dir, "recording data directory")?;
        let jobs = canonical_direct_child_directory(
            &data,
            &data_dir.join(MANAGED_HLAE_JOB_DIRECTORY),
            MANAGED_HLAE_JOB_DIRECTORY,
        )?;
        let leases = canonical_direct_child_directory(
            &data,
            &data_dir.join(MANAGED_HLAE_LEASE_DIRECTORY),
            MANAGED_HLAE_LEASE_DIRECTORY,
        )?;
        let recordings = canonical_direct_child_directory(
            &data,
            &data_dir.join(RECORDED_CLIP_DIRECTORY),
            RECORDED_CLIP_DIRECTORY,
        )?;
        Ok(Self {
            data,
            jobs,
            leases,
            recordings,
        })
    }

    fn revalidate(&self) -> Result<(), DomainError> {
        let data = canonical_plain_directory(&self.data, "recording data directory")?;
        if data != self.data {
            return Err(managed_path_error(
                "recording data directory identity changed",
            ));
        }
        let jobs = canonical_direct_child_directory(&data, &self.jobs, MANAGED_HLAE_JOB_DIRECTORY)?;
        let leases =
            canonical_direct_child_directory(&data, &self.leases, MANAGED_HLAE_LEASE_DIRECTORY)?;
        let recordings =
            canonical_direct_child_directory(&data, &self.recordings, RECORDED_CLIP_DIRECTORY)?;
        if jobs != self.jobs || leases != self.leases || recordings != self.recordings {
            return Err(managed_path_error(
                "managed recording directory identity changed",
            ));
        }
        Ok(())
    }

    fn expected_output(&self, file_name: &str) -> Result<PathBuf, DomainError> {
        self.revalidate()?;
        let file_name = validated_mp4_name(file_name)?;
        let path = self.recordings.join(file_name);
        validate_expected_output_location(self, &path)?;
        Ok(path)
    }

    fn validate_published_output(
        &self,
        expected: &Path,
        reported: &Path,
    ) -> Result<PathBuf, DomainError> {
        self.revalidate()?;
        validate_expected_output_location(self, expected)?;
        if !reported.is_absolute() {
            return Err(managed_path_error(
                "HLAE session returned a relative recording output path",
            ));
        }

        let expected_metadata = fs::symlink_metadata(expected).map_err(|error| {
            managed_path_error(format!(
                "managed recording output is unavailable at {}: {error}",
                expected.display()
            ))
        })?;
        if !expected_metadata.is_file()
            || expected_metadata.file_type().is_symlink()
            || metadata_is_reparse_point(&expected_metadata)
        {
            return Err(managed_path_error(
                "managed recording output must be a regular non-link file",
            ));
        }
        let reported_metadata = fs::symlink_metadata(reported).map_err(|error| {
            managed_path_error(format!(
                "HLAE session reported an unavailable recording output {}: {error}",
                reported.display()
            ))
        })?;
        if !reported_metadata.is_file()
            || reported_metadata.file_type().is_symlink()
            || metadata_is_reparse_point(&reported_metadata)
        {
            return Err(managed_path_error(
                "HLAE session output must be a regular non-link file",
            ));
        }

        let expected_identity = fs::canonicalize(expected).map_err(|error| {
            managed_path_error(format!(
                "unable to resolve managed recording output {}: {error}",
                expected.display()
            ))
        })?;
        let reported_identity = fs::canonicalize(reported).map_err(|error| {
            managed_path_error(format!(
                "unable to resolve HLAE session output {}: {error}",
                reported.display()
            ))
        })?;
        if expected_identity.parent() != Some(self.recordings.as_path())
            || !expected_identity.starts_with(&self.recordings)
            || reported_identity != expected_identity
        {
            return Err(managed_path_error(
                "HLAE session output identity escaped the managed recordings directory",
            ));
        }
        Ok(expected_identity)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum ManagedHlaeArtifactLeaseState {
    Capturing,
    PublishedAwaitingCommit,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedHlaeArtifactLeaseDocument {
    producer: String,
    job_id: Uuid,
    item_index: usize,
    jobs_root: PathBuf,
    recordings_root: PathBuf,
    job_root: PathBuf,
    capture_root: PathBuf,
    staged_output_mp4: PathBuf,
    partial_output_mp4: PathBuf,
    final_output_mp4: PathBuf,
    state: ManagedHlaeArtifactLeaseState,
    recorded_clip: Option<RecordedClip>,
    final_output_bytes: Option<u64>,
    final_output_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ManagedHlaeArtifactLease {
    job_id: Uuid,
    item_index: usize,
    lease_path: PathBuf,
    job_root: PathBuf,
    capture_root: PathBuf,
    staged_output_mp4: PathBuf,
    partial_output_mp4: PathBuf,
    final_output_mp4: PathBuf,
}

fn create_managed_hlae_artifact_lease(
    roots: &ManagedRecordingRoots,
    job_id: Uuid,
    item_index: usize,
    final_output_mp4: &Path,
) -> Result<ManagedHlaeArtifactLease, DomainError> {
    roots.revalidate()?;
    validate_expected_output_location(roots, final_output_mp4)?;
    let job_root = managed_job_path(roots, job_id, item_index);
    let capture_root = job_root.join("capture");
    let staged_output_mp4 = job_root.join(MANAGED_HLAE_STAGED_OUTPUT_FILE);
    let partial_output_mp4 = job_root.join(MANAGED_HLAE_PARTIAL_OUTPUT_FILE);
    let lease_path = roots.leases.join(format!("{job_id}.json"));
    validate_absent_managed_job_path(roots, &job_root, job_id, item_index)?;
    validate_lease_path(roots, &lease_path, job_id)?;
    if lease_path.exists() {
        return Err(DomainError::Conflict(format!(
            "recording job {job_id} has an unresolved HLAE artifact lease"
        )));
    }
    let document = ManagedHlaeArtifactLeaseDocument {
        producer: MANAGED_HLAE_LEASE_PRODUCER.to_owned(),
        job_id,
        item_index,
        jobs_root: roots.jobs.clone(),
        recordings_root: roots.recordings.clone(),
        job_root: job_root.clone(),
        capture_root: capture_root.clone(),
        staged_output_mp4: staged_output_mp4.clone(),
        partial_output_mp4: partial_output_mp4.clone(),
        final_output_mp4: final_output_mp4.to_path_buf(),
        state: ManagedHlaeArtifactLeaseState::Capturing,
        recorded_clip: None,
        final_output_bytes: None,
        final_output_sha256: None,
    };
    let bytes = serialize_lease_document(&document)?;
    write_new_synced(&lease_path, &bytes)?;
    Ok(ManagedHlaeArtifactLease {
        job_id,
        item_index,
        lease_path,
        job_root,
        capture_root,
        staged_output_mp4,
        partial_output_mp4,
        final_output_mp4: final_output_mp4.to_path_buf(),
    })
}

fn serialize_lease_document(
    document: &ManagedHlaeArtifactLeaseDocument,
) -> Result<Vec<u8>, DomainError> {
    let mut bytes = serde_json::to_vec_pretty(document).map_err(|error| {
        managed_path_error(format!(
            "unable to serialize managed HLAE artifact lease: {error}"
        ))
    })?;
    bytes.push(b'\n');
    if u64::try_from(bytes.len()).map_or(true, |length| length > MANAGED_HLAE_LEASE_MAX_BYTES) {
        return Err(managed_path_error(
            "managed HLAE artifact lease exceeds its durable size limit",
        ));
    }
    Ok(bytes)
}

fn published_output_digest(path: &Path) -> Result<(u64, String), DomainError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        managed_path_error(format!(
            "unable to inspect published HLAE output {}: {error}",
            path.display()
        ))
    })?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
    {
        return Err(managed_path_error(
            "published HLAE output must be a regular non-link file",
        ));
    }
    let mut file = fs::File::open(path).map_err(|error| {
        managed_path_error(format!(
            "unable to open published HLAE output {}: {error}",
            path.display()
        ))
    })?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1_024].into_boxed_slice();
    loop {
        let read = std::io::Read::read(&mut file, &mut buffer).map_err(|error| {
            managed_path_error(format!(
                "unable to hash published HLAE output {}: {error}",
                path.display()
            ))
        })?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok((metadata.len(), hex::encode(digest.finalize())))
}

fn mark_lease_published(
    roots: &ManagedRecordingRoots,
    lease: &ManagedHlaeArtifactLease,
    clip: &RecordedClip,
    expected_output_bytes: u64,
) -> Result<(), DomainError> {
    roots.revalidate()?;
    validate_lease_path(roots, &lease.lease_path, lease.job_id)?;
    let mut document = read_trusted_lease(&lease.lease_path, lease.job_id)?.ok_or_else(|| {
        managed_path_error("managed HLAE artifact lease disappeared before commit")
    })?;
    validate_lease_document(
        roots,
        &document,
        lease.job_id,
        Some(lease.item_index),
        Some(&lease.final_output_mp4),
    )?;
    if document.state != ManagedHlaeArtifactLeaseState::Capturing
        || document.recorded_clip.is_some()
        || document.final_output_bytes.is_some()
        || document.final_output_sha256.is_some()
    {
        return Err(managed_path_error(
            "managed HLAE artifact lease is not in its pre-publication state",
        ));
    }
    validate_managed_hlae_clip_path(clip)?;
    if Path::new(&clip.path) != lease.final_output_mp4 {
        return Err(managed_path_error(
            "published RecordedClip does not match its exact leased output",
        ));
    }
    let (output_bytes, output_sha256) = published_output_digest(&lease.final_output_mp4)?;
    if output_bytes == 0 || output_bytes != expected_output_bytes {
        return Err(managed_path_error(
            "published HLAE output size does not match verified encoder evidence",
        ));
    }
    document.state = ManagedHlaeArtifactLeaseState::PublishedAwaitingCommit;
    document.recorded_clip = Some(clip.clone());
    document.final_output_bytes = Some(output_bytes);
    document.final_output_sha256 = Some(output_sha256);
    atomic_write(&lease.lease_path, &serialize_lease_document(&document)?).map_err(|error| {
        managed_path_error(format!("unable to commit published HLAE lease: {error}"))
    })
}

fn managed_job_path(roots: &ManagedRecordingRoots, job_id: Uuid, item_index: usize) -> PathBuf {
    roots.jobs.join(format!("job-{job_id}-{item_index}"))
}

fn recover_managed_hlae_artifacts(
    roots: &ManagedRecordingRoots,
    job_id: Uuid,
    expected_item_index: Option<usize>,
    expected_final_output: Option<&Path>,
) -> Result<bool, DomainError> {
    roots.revalidate()?;
    let lease_path = roots.leases.join(format!("{job_id}.json"));
    validate_lease_path(roots, &lease_path, job_id)?;
    let Some(document) = read_trusted_lease(&lease_path, job_id)? else {
        return Ok(false);
    };
    validate_lease_document(
        roots,
        &document,
        job_id,
        expected_item_index,
        expected_final_output,
    )?;
    if document.state != ManagedHlaeArtifactLeaseState::Capturing {
        return Err(managed_path_error(
            "a published HLAE artifact lease cannot be retired before RecordedClip storage commit",
        ));
    }
    remove_exact_partial_file(&document.partial_output_mp4, &document.job_root)?;
    remove_exact_partial_file(&document.staged_output_mp4, &document.job_root)?;
    remove_managed_job_artifacts(&document)?;
    remove_plain_file(&lease_path, "managed HLAE artifact lease")?;
    Ok(true)
}

fn recover_managed_hlae_job(
    roots: &ManagedRecordingRoots,
    job: &RecordingJob,
) -> Result<OrphanedRecordingRecovery, DomainError> {
    roots.revalidate()?;
    let lease_path = roots.leases.join(format!("{}.json", job.id));
    validate_lease_path(roots, &lease_path, job.id)?;
    let Some(document) = read_trusted_lease(&lease_path, job.id)? else {
        return Ok(OrphanedRecordingRecovery::NoPublishedClip);
    };
    let validation =
        validate_lease_document(roots, &document, job.id, Some(job.current_index), None);
    if document.state == ManagedHlaeArtifactLeaseState::Capturing {
        validation?;
        recover_managed_hlae_artifacts(
            roots,
            job.id,
            Some(job.current_index),
            Some(&document.final_output_mp4),
        )?;
        return Ok(OrphanedRecordingRecovery::NoPublishedClip);
    }
    let recovered = (|| {
        validation?;
        let request = job.items.get(document.item_index).ok_or_else(|| {
            managed_path_error("published HLAE lease references an unavailable recording item")
        })?;
        let clip = document.recorded_clip.as_ref().ok_or_else(|| {
            managed_path_error("published HLAE lease is missing its exact RecordedClip payload")
        })?;
        if clip.demo_id != Some(request.demo_id) {
            return Err(managed_path_error(
                "published HLAE lease RecordedClip belongs to another Demo",
            ));
        }
        validate_managed_hlae_clip_path(clip)?;
        let (actual_bytes, actual_sha256) = published_output_digest(&document.final_output_mp4)?;
        if document.final_output_bytes != Some(actual_bytes)
            || document.final_output_sha256.as_deref() != Some(actual_sha256.as_str())
        {
            return Err(managed_path_error(
                "published HLAE output no longer matches its verified durable evidence",
            ));
        }
        Ok(OrphanedRecordingRecovery::PublishedClip {
            item_index: document.item_index,
            clip: Box::new(clip.clone()),
        })
    })();
    recovered.map_err(|error: DomainError| {
        DomainError::CleanupFailed(format!(
            "[HLAE_PUBLISHED_CLIP_RECOVERY_FAILED] {error}; exact recovery evidence was retained at {}",
            lease_path.display()
        ))
    })
}

fn commit_managed_hlae_clip(
    roots: &ManagedRecordingRoots,
    job_id: Uuid,
    item_index: usize,
    clip: &RecordedClip,
) -> Result<(), DomainError> {
    roots.revalidate()?;
    let lease_path = roots.leases.join(format!("{job_id}.json"));
    validate_lease_path(roots, &lease_path, job_id)?;
    let document = read_trusted_lease(&lease_path, job_id)?.ok_or_else(|| {
        DomainError::CleanupFailed(
            "[HLAE_PUBLISHED_CLIP_COMMIT_FAILED] exact publication lease is missing".to_owned(),
        )
    })?;
    let commit = (|| {
        validate_lease_document(
            roots,
            &document,
            job_id,
            Some(item_index),
            Some(Path::new(&clip.path)),
        )?;
        if document.state != ManagedHlaeArtifactLeaseState::PublishedAwaitingCommit
            || document.recorded_clip.as_ref() != Some(clip)
        {
            return Err(managed_path_error(
                "exact publication lease does not contain this RecordedClip",
            ));
        }
        validate_managed_hlae_clip_path(clip)?;
        let (output_bytes, output_sha256) = published_output_digest(&document.final_output_mp4)?;
        if document.final_output_bytes != Some(output_bytes)
            || document.final_output_sha256.as_deref() != Some(output_sha256.as_str())
        {
            return Err(managed_path_error(
                "published HLAE output content changed before storage commit",
            ));
        }
        let lease = ManagedHlaeArtifactLease {
            job_id: document.job_id,
            item_index: document.item_index,
            lease_path: lease_path.clone(),
            job_root: document.job_root.clone(),
            capture_root: document.capture_root.clone(),
            staged_output_mp4: document.staged_output_mp4.clone(),
            partial_output_mp4: document.partial_output_mp4.clone(),
            final_output_mp4: document.final_output_mp4.clone(),
        };
        remove_completed_lease(roots, &lease)
    })();
    commit.map_err(|error: DomainError| {
        DomainError::CleanupFailed(format!(
            "[HLAE_PUBLISHED_CLIP_COMMIT_FAILED] {error}; exact lease was retained at {}",
            lease_path.display()
        ))
    })
}

fn cleanup_lease_after_attempt(
    roots: &ManagedRecordingRoots,
    lease: &ManagedHlaeArtifactLease,
    primary: DomainError,
) -> DomainError {
    match recover_managed_hlae_artifacts(
        roots,
        lease.job_id,
        Some(lease.item_index),
        Some(&lease.final_output_mp4),
    ) {
        Ok(_) => primary,
        Err(cleanup) => DomainError::CleanupFailed(format!(
            "{primary}; managed HLAE artifact lease cleanup also failed: {cleanup}"
        )),
    }
}

fn remove_completed_lease(
    roots: &ManagedRecordingRoots,
    lease: &ManagedHlaeArtifactLease,
) -> Result<(), DomainError> {
    roots.revalidate()?;
    let metadata = fs::symlink_metadata(&lease.lease_path).map_err(|error| {
        managed_path_error(format!(
            "unable to inspect completed HLAE artifact lease: {error}"
        ))
    })?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
    {
        return Err(managed_path_error(
            "completed HLAE artifact lease must remain a regular non-link file",
        ));
    }
    remove_plain_file(&lease.lease_path, "completed HLAE artifact lease")
}

fn read_trusted_lease(
    lease_path: &Path,
    job_id: Uuid,
) -> Result<Option<ManagedHlaeArtifactLeaseDocument>, DomainError> {
    let metadata = match fs::symlink_metadata(lease_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(managed_path_error(format!(
                "unable to inspect HLAE artifact lease for job {job_id}: {error}"
            )));
        }
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
        || metadata.len() > MANAGED_HLAE_LEASE_MAX_BYTES
    {
        return Err(managed_path_error(
            "managed HLAE artifact lease must be a bounded regular non-link file",
        ));
    }
    let bytes = fs::read(lease_path).map_err(|error| {
        managed_path_error(format!(
            "unable to read HLAE artifact lease for job {job_id}: {error}"
        ))
    })?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| managed_path_error(format!("invalid HLAE artifact lease: {error}")))
}

fn validate_lease_document(
    roots: &ManagedRecordingRoots,
    document: &ManagedHlaeArtifactLeaseDocument,
    job_id: Uuid,
    expected_item_index: Option<usize>,
    expected_final_output: Option<&Path>,
) -> Result<(), DomainError> {
    if document.producer != MANAGED_HLAE_LEASE_PRODUCER
        || document.job_id != job_id
        || expected_item_index.is_some_and(|index| document.item_index != index)
        || document.jobs_root != roots.jobs
        || document.recordings_root != roots.recordings
        || expected_final_output.is_some_and(|path| document.final_output_mp4 != path)
    {
        return Err(managed_path_error(
            "managed HLAE artifact lease does not match the orphaned recording job",
        ));
    }
    validate_absent_or_existing_managed_job_path(
        roots,
        &document.job_root,
        job_id,
        document.item_index,
    )?;
    if document.capture_root != document.job_root.join("capture")
        || document.staged_output_mp4 != document.job_root.join(MANAGED_HLAE_STAGED_OUTPUT_FILE)
        || document.partial_output_mp4 != document.job_root.join(MANAGED_HLAE_PARTIAL_OUTPUT_FILE)
    {
        return Err(managed_path_error(
            "managed HLAE artifact lease contains a non-canonical artifact path",
        ));
    }
    validate_expected_output_location(roots, &document.final_output_mp4)?;
    match document.state {
        ManagedHlaeArtifactLeaseState::Capturing => {
            if document.recorded_clip.is_some()
                || document.final_output_bytes.is_some()
                || document.final_output_sha256.is_some()
            {
                return Err(managed_path_error(
                    "capturing HLAE lease contains premature publication evidence",
                ));
            }
        }
        ManagedHlaeArtifactLeaseState::PublishedAwaitingCommit => {
            let clip = document.recorded_clip.as_ref().ok_or_else(|| {
                managed_path_error("published HLAE lease is missing its RecordedClip")
            })?;
            let output_bytes = document.final_output_bytes.ok_or_else(|| {
                managed_path_error("published HLAE lease is missing its output length")
            })?;
            let output_sha256 = document.final_output_sha256.as_deref().ok_or_else(|| {
                managed_path_error("published HLAE lease is missing its output digest")
            })?;
            let valid_digest = output_sha256.len() == 64
                && output_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
            let Some((managed_root, managed_output)) = managed_hlae_clip_paths(clip)? else {
                return Err(managed_path_error(
                    "published HLAE lease RecordedClip lacks managed backend evidence",
                ));
            };
            if output_bytes == 0
                || !valid_digest
                || managed_root != roots.recordings
                || managed_output != document.final_output_mp4
                || !clip.duration_seconds.is_finite()
                || clip.duration_seconds <= 0.0
            {
                return Err(managed_path_error(
                    "published HLAE lease contains invalid or mismatched output evidence",
                ));
            }
        }
    }
    Ok(())
}

fn validate_lease_path(
    roots: &ManagedRecordingRoots,
    lease_path: &Path,
    job_id: Uuid,
) -> Result<(), DomainError> {
    if !lease_path.is_absolute()
        || lease_path.parent() != Some(roots.leases.as_path())
        || lease_path.file_name().and_then(|name| name.to_str())
            != Some(format!("{job_id}.json").as_str())
    {
        return Err(managed_path_error(
            "managed HLAE lease must be the job's exact direct-child lease path",
        ));
    }
    Ok(())
}

fn validate_absent_managed_job_path(
    roots: &ManagedRecordingRoots,
    job_root: &Path,
    job_id: Uuid,
    item_index: usize,
) -> Result<(), DomainError> {
    validate_managed_job_identity(roots, job_root, job_id, item_index)?;
    if job_root.exists() {
        return Err(DomainError::Conflict(
            "managed HLAE job path already exists".to_owned(),
        ));
    }
    Ok(())
}

fn validate_absent_or_existing_managed_job_path(
    roots: &ManagedRecordingRoots,
    job_root: &Path,
    job_id: Uuid,
    item_index: usize,
) -> Result<(), DomainError> {
    validate_managed_job_identity(roots, job_root, job_id, item_index)?;
    if job_root.exists() {
        let canonical = canonical_plain_directory(job_root, "leased managed HLAE job")?;
        if canonical != job_root || canonical.parent() != Some(roots.jobs.as_path()) {
            return Err(managed_path_error(
                "leased managed HLAE job identity changed before recovery",
            ));
        }
    }
    Ok(())
}

fn validate_managed_job_identity(
    roots: &ManagedRecordingRoots,
    job_root: &Path,
    job_id: Uuid,
    item_index: usize,
) -> Result<(), DomainError> {
    let expected_name = format!("job-{job_id}-{item_index}");
    if !job_root.is_absolute()
        || job_root.parent() != Some(roots.jobs.as_path())
        || job_root.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str())
    {
        return Err(managed_path_error(
            "managed HLAE job must be the lease-bound direct child of the jobs root",
        ));
    }
    Ok(())
}

fn remove_exact_partial_file(path: &Path, job_root: &Path) -> Result<(), DomainError> {
    if path.parent() != Some(job_root) {
        return Err(managed_path_error(
            "leased partial artifact is outside its exact managed job",
        ));
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(managed_path_error(format!(
                "unable to inspect leased partial artifact {}: {error}",
                path.display()
            )));
        }
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
    {
        return Err(managed_path_error(
            "leased partial artifact must be a regular non-link file",
        ));
    }
    remove_plain_file(path, "leased partial artifact")
}

fn remove_managed_job_artifacts(
    document: &ManagedHlaeArtifactLeaseDocument,
) -> Result<(), DomainError> {
    if !document.job_root.exists() {
        return Ok(());
    }
    let capture_root = &document.capture_root;
    if capture_root.exists() {
        let canonical_capture =
            canonical_plain_directory(capture_root, "leased HLAE capture root")?;
        if canonical_capture != *capture_root
            || canonical_capture.parent() != Some(document.job_root.as_path())
        {
            return Err(managed_path_error(
                "leased HLAE capture root identity changed before recovery",
            ));
        }
        let mut entries = fs::read_dir(capture_root).map_err(|error| {
            managed_path_error(format!(
                "unable to enumerate leased HLAE capture root: {error}"
            ))
        })?;
        let take = entries
            .next()
            .transpose()
            .map_err(|error| managed_path_error(format!("unable to read leased take: {error}")))?;
        if entries.next().is_some() {
            return Err(managed_path_error(
                "leased HLAE capture root contains more than one take",
            ));
        }
        if let Some(take) = take {
            let take_path = take.path();
            let name = take
                .file_name()
                .into_string()
                .map_err(|_| managed_path_error("leased HLAE take name must be valid Unicode"))?;
            let valid_name = name.strip_prefix("take").is_some_and(|digits| {
                digits.len() == 4 && digits.bytes().all(|byte| byte.is_ascii_digit())
            });
            let canonical_take = canonical_plain_directory(&take_path, "leased HLAE take")?;
            if !valid_name || canonical_take.parent() != Some(capture_root.as_path()) {
                return Err(managed_path_error(
                    "leased HLAE take is not a canonical direct child",
                ));
            }
            let mut count = 0_usize;
            let mut raw_artifacts = Vec::new();
            for entry in fs::read_dir(&canonical_take).map_err(|error| {
                managed_path_error(format!("unable to enumerate leased HLAE take: {error}"))
            })? {
                count = count
                    .checked_add(1)
                    .ok_or_else(|| managed_path_error("leased HLAE artifact count overflowed"))?;
                if count > HLAE_TAKE_MAX_FRAMES.saturating_add(1) {
                    return Err(managed_path_error(
                        "leased HLAE take exceeds the bounded artifact count",
                    ));
                }
                let entry = entry.map_err(|error| {
                    managed_path_error(format!("unable to read leased HLAE artifact: {error}"))
                })?;
                validate_raw_take_artifact(&entry)?;
                raw_artifacts.push(entry.path());
            }
            for artifact in raw_artifacts {
                let metadata = fs::symlink_metadata(&artifact).map_err(|error| {
                    managed_path_error(format!(
                        "unable to revalidate leased HLAE artifact before cleanup: {error}"
                    ))
                })?;
                if !metadata.is_file()
                    || metadata.file_type().is_symlink()
                    || metadata_is_reparse_point(&metadata)
                {
                    return Err(managed_path_error(
                        "leased HLAE artifact identity changed before cleanup",
                    ));
                }
                remove_plain_file(&artifact, "leased HLAE raw artifact")?;
            }
            fs::remove_dir(&canonical_take).map_err(|error| {
                managed_path_error(format!("unable to remove empty leased HLAE take: {error}"))
            })?;
        }
        fs::remove_dir(capture_root).map_err(|error| {
            managed_path_error(format!(
                "unable to remove leased HLAE capture root: {error}"
            ))
        })?;
    }
    Ok(())
}

fn validate_raw_take_artifact(entry: &fs::DirEntry) -> Result<(), DomainError> {
    let path = entry.path();
    let metadata = fs::symlink_metadata(&path).map_err(|error| {
        managed_path_error(format!("unable to inspect leased HLAE artifact: {error}"))
    })?;
    let name = entry
        .file_name()
        .into_string()
        .map_err(|_| managed_path_error("leased HLAE artifact name must be valid Unicode"))?;
    let is_frame = name.strip_suffix(".tga").is_some_and(|digits| {
        digits.len() >= 5 && digits.bytes().all(|byte| byte.is_ascii_digit())
    });
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
        || (!is_frame && name != "audio.wav")
    {
        return Err(managed_path_error(
            "leased HLAE take contains an unexpected or linked artifact",
        ));
    }
    Ok(())
}

fn remove_plain_file(path: &Path, label: &str) -> Result<(), DomainError> {
    fs::remove_file(path).map_err(|error| {
        managed_path_error(format!(
            "unable to remove {label} {}: {error}",
            path.display()
        ))
    })
}

fn write_new_synced(path: &Path, bytes: &[u8]) -> Result<(), DomainError> {
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| {
            managed_path_error(format!(
                "unable to create artifact lease {}: {error}",
                path.display()
            ))
        })?;
    if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(managed_path_error(format!(
            "unable to persist artifact lease {}: {error}",
            path.display()
        )));
    }
    Ok(())
}

fn canonical_plain_directory(path: &Path, label: &str) -> Result<PathBuf, DomainError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        managed_path_error(format!(
            "unable to inspect {label} {}: {error}",
            path.display()
        ))
    })?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
    {
        return Err(managed_path_error(format!(
            "{label} must be a regular non-link directory"
        )));
    }
    let canonical = fs::canonicalize(path).map_err(|error| {
        managed_path_error(format!(
            "unable to resolve {label} {}: {error}",
            path.display()
        ))
    })?;
    if !canonical.is_absolute() {
        return Err(managed_path_error(format!(
            "{label} must resolve to an absolute directory"
        )));
    }
    Ok(canonical)
}

fn canonical_direct_child_directory(
    canonical_parent: &Path,
    child: &Path,
    expected_name: &str,
) -> Result<PathBuf, DomainError> {
    if child.file_name().and_then(|name| name.to_str()) != Some(expected_name) {
        return Err(managed_path_error(
            "managed recording directory has an unexpected name",
        ));
    }
    let canonical_child = canonical_plain_directory(child, "managed recording directory")?;
    if canonical_child.parent() != Some(canonical_parent)
        || !canonical_child.starts_with(canonical_parent)
    {
        return Err(managed_path_error(
            "managed recording directory must be a direct child of the data directory",
        ));
    }
    Ok(canonical_child)
}

fn validate_expected_output_location(
    roots: &ManagedRecordingRoots,
    expected: &Path,
) -> Result<(), DomainError> {
    if !expected.is_absolute()
        || expected.parent() != Some(roots.recordings.as_path())
        || !expected.starts_with(&roots.recordings)
        || expected
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| validated_mp4_name(name).ok())
            .is_none()
    {
        return Err(managed_path_error(
            "recording output must be an absolute direct-child MP4 in the managed recordings directory",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn managed_path_error(message: impl Into<String>) -> DomainError {
    DomainError::Internal(message.into())
}

fn managed_hlae_clip_paths(clip: &RecordedClip) -> Result<Option<(&Path, &Path)>, DomainError> {
    if clip
        .metadata
        .get("capture_backend")
        .and_then(serde_json::Value::as_str)
        != Some(MANAGED_CAPTURE_BACKEND)
    {
        return Ok(None);
    }
    let root = clip
        .metadata
        .get("managed_recordings_root")
        .and_then(serde_json::Value::as_str)
        .map(Path::new)
        .ok_or_else(|| managed_path_error("managed recording root evidence is missing"))?;
    let expected = clip
        .metadata
        .get("managed_output_identity")
        .and_then(serde_json::Value::as_str)
        .map(Path::new)
        .ok_or_else(|| managed_path_error("managed recording output evidence is missing"))?;
    let clip_path = Path::new(&clip.path);
    if !root.is_absolute()
        || !expected.is_absolute()
        || !clip_path.is_absolute()
        || clip_path != expected
        || expected.parent() != Some(root)
        || !expected.starts_with(root)
        || expected
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| validated_mp4_name(name).ok())
            .is_none()
    {
        return Err(managed_path_error(
            "recorded clip identity is outside its managed recordings root",
        ));
    }
    Ok(Some((root, expected)))
}

pub(crate) fn validate_managed_hlae_clip_path(clip: &RecordedClip) -> Result<(), DomainError> {
    let Some((root, expected)) = managed_hlae_clip_paths(clip)? else {
        return Ok(());
    };
    let canonical_root = canonical_plain_directory(root, "managed recordings root")?;
    if canonical_root != root {
        return Err(managed_path_error(
            "managed recordings root identity changed before publication",
        ));
    }
    let metadata = fs::symlink_metadata(expected).map_err(|error| {
        managed_path_error(format!(
            "unable to inspect managed recorded clip {}: {error}",
            expected.display()
        ))
    })?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
    {
        return Err(managed_path_error(
            "managed recorded clip must be a regular non-link file",
        ));
    }
    let canonical_output = fs::canonicalize(expected).map_err(|error| {
        managed_path_error(format!(
            "unable to resolve managed recorded clip {}: {error}",
            expected.display()
        ))
    })?;
    if canonical_output != expected
        || canonical_output.parent() != Some(canonical_root.as_path())
        || !canonical_output.starts_with(&canonical_root)
    {
        return Err(managed_path_error(
            "managed recorded clip identity changed before publication",
        ));
    }
    Ok(())
}

pub(crate) async fn remove_managed_hlae_unpublished_clip(
    clip: &RecordedClip,
) -> Option<Result<(), DomainError>> {
    let paths = match managed_hlae_clip_paths(clip) {
        Ok(Some(paths)) => paths,
        Ok(None) => return None,
        Err(error) => return Some(Err(error)),
    };
    let (root, expected) = paths;
    let canonical_root = match canonical_plain_directory(root, "managed recordings root") {
        Ok(canonical) if canonical == root => canonical,
        Ok(_) => {
            return Some(Err(managed_path_error(
                "managed recordings root identity changed before cleanup",
            )));
        }
        Err(error) => return Some(Err(error)),
    };
    let metadata = match fs::symlink_metadata(expected) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Some(Ok(())),
        Err(error) => {
            return Some(Err(managed_path_error(format!(
                "unable to inspect unpublished managed clip {}: {error}",
                expected.display()
            ))));
        }
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
    {
        return Some(Err(managed_path_error(
            "refusing to remove an unpublished managed clip that is not a regular non-link file",
        )));
    }
    let canonical_output = match fs::canonicalize(expected) {
        Ok(path) => path,
        Err(error) => {
            return Some(Err(managed_path_error(format!(
                "unable to resolve unpublished managed clip {}: {error}",
                expected.display()
            ))));
        }
    };
    if canonical_output != expected
        || canonical_output.parent() != Some(canonical_root.as_path())
        || !canonical_output.starts_with(&canonical_root)
    {
        return Some(Err(managed_path_error(
            "refusing to remove an unpublished clip whose managed identity changed",
        )));
    }
    Some(
        tokio::fs::remove_file(expected)
            .await
            .or_else(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    Ok(())
                } else {
                    Err(error)
                }
            })
            .map_err(|error| {
                managed_path_error(format!(
                    "unable to remove unpublished managed clip {}: {error}",
                    expected.display()
                ))
            }),
    )
}

fn build_player_pov_plan(
    item: &PreparedRecording,
    managed_job_root: &Path,
    capture: CaptureSettings,
    presentation: HlaePlayerPovPresentation,
) -> Result<HlaePlayerPovCapturePlan, DomainError> {
    let spectator_slot = item.segment.spectator_slot.ok_or_else(|| {
        DomainError::DependencyUnavailable(
            "this Demo must be reanalyzed before its verified CS2 spectator slot can be used"
                .to_owned(),
        )
    })?;
    if !(1..=64).contains(&spectator_slot) {
        return Err(DomainError::InvalidInput(
            "the parser-backed CS2 spectator slot is outside 1..=64".to_owned(),
        ));
    }
    let verified_total_ticks = item.segment.verified_total_ticks.ok_or_else(|| {
        DomainError::DependencyUnavailable(
            "this Demo must be reanalyzed before its authoritative total tick count can be used"
                .to_owned(),
        )
    })?;
    if item.segment.start_tick < 3
        || item.segment.end_tick <= item.segment.start_tick
        || item.segment.end_tick > u64::from(verified_total_ticks)
    {
        return Err(DomainError::InvalidInput(
            "the recording segment is outside the parser-verified Demo tick range".to_owned(),
        ));
    }
    if item.segment.player_id.len() != 17
        || !item
            .segment
            .player_id
            .bytes()
            .all(|byte| byte.is_ascii_digit())
    {
        return Err(DomainError::InvalidInput(
            "player POV capture requires a canonical 17-digit SteamID64".to_owned(),
        ));
    }
    let pre_roll_ticks = item.segment.start_tick.saturating_sub(1).min(128);
    Ok(HlaePlayerPovCapturePlan {
        demo_path: item.segment.demo_path.clone(),
        output_directory: managed_job_root.join("capture"),
        player_id: item.segment.player_id.clone(),
        spectator_slot,
        start_tick: item.segment.start_tick,
        end_tick: item.segment.end_tick,
        pre_roll_ticks,
        tick_rate: item.segment.tick_rate,
        capture,
        presentation,
    })
}

/// Resolves the presentation one take records with.
///
/// A request that carries no presentation of its own follows the global
/// `AppConfig.recording` defaults, which is what `fallback` holds. A request
/// that carries one overrides every one of the six controls at once: the shot
/// inspector always sends a complete presentation, so a partial merge would
/// only invent a state the interface cannot express.
///
/// The mutual exclusion the fallback has to police - "mute everyone" together
/// with "isolate the target" - cannot be spelled by an override at all, because
/// [`RecordingVoicePolicy`] is one closed choice instead of two bools.
fn take_presentation(
    fallback: HlaePlayerPovPresentation,
    request: &RecordingRequest,
) -> HlaePlayerPovPresentation {
    let Some(shot) = request.presentation else {
        return fallback;
    };
    HlaePlayerPovPresentation {
        radar: if shot.show_radar {
            HlaeRadarVisibility::Visible
        } else {
            HlaeRadarVisibility::Hidden
        },
        hud: if shot.show_hud {
            HlaeHudVisibility::Visible
        } else {
            HlaeHudVisibility::DeathNoticesOnly
        },
        camera_fov: shot.camera_fov,
        viewmodel_fov: shot.viewmodel_fov,
        flash_alpha: shot.flash_alpha,
        voice: match shot.voice {
            RecordingVoicePolicy::AllPlayers => HlaeVoicePolicy::AllPlayers,
            RecordingVoicePolicy::Muted => HlaeVoicePolicy::Muted,
            RecordingVoicePolicy::TargetOnly => HlaeVoicePolicy::TargetOnly,
        },
    }
}

/// Resolves the scene half of a presentation for an observer take.
///
/// `camera_fov` and `viewmodel_fov` are dropped on purpose: a camera path
/// carries a field of view on every keyframe and draws no viewmodel, so there
/// is nothing here for those two values to control. `RecordingPresentation`
/// already rejects a non-neutral field of view for every non-POV style at the
/// API boundary, which is why this is a silent drop rather than a second,
/// later error.
fn scene_presentation(
    item: &PreparedRecording,
    presentation: HlaePlayerPovPresentation,
) -> Result<HlaeScenePresentation, DomainError> {
    let voice_target_slot = match presentation.voice {
        HlaeVoicePolicy::TargetOnly => {
            let slot = item.segment.spectator_slot.ok_or_else(|| {
                DomainError::DependencyUnavailable(
                    "this Demo must be reanalyzed before its verified CS2 spectator slot can isolate the recorded player's voice"
                        .to_owned(),
                )
            })?;
            if !(1..=64).contains(&slot) {
                return Err(DomainError::InvalidInput(
                    "the parser-backed CS2 spectator slot is outside 1..=64".to_owned(),
                ));
            }
            Some(slot)
        }
        HlaeVoicePolicy::AllPlayers | HlaeVoicePolicy::Muted => None,
    };
    Ok(presentation.scene(voice_target_slot))
}

fn build_camera_plan(
    item: &PreparedRecording,
    managed_job_root: &Path,
    capture: CaptureSettings,
    presentation: HlaePlayerPovPresentation,
) -> Result<HlaePlan, DomainError> {
    let candidates = item
        .replay_frames
        .iter()
        .filter(|frame| {
            frame.tick >= item.segment.start_tick && frame.tick <= item.segment.end_tick
        })
        .filter_map(|frame| {
            frame
                .players
                .iter()
                .find(|player| player.id == item.segment.player_id)
                .map(|player| (frame.tick, (player, frame)))
        })
        .collect::<Vec<_>>();
    let samples = crate::camera_planning::sample_four_frames(&candidates).ok_or_else(|| {
        DomainError::DependencyUnavailable(
            "this shot needs at least four spatial replay samples for camera movement".to_owned(),
        )
    })?;
    let duration = item.segment.end_tick - item.segment.start_tick;
    let target_ticks = [
        item.segment.start_tick,
        item.segment.start_tick + duration / 3,
        item.segment.start_tick + duration.saturating_mul(2) / 3,
        item.segment.end_tick,
    ];
    let keyframes = samples
        .iter()
        .zip(target_ticks)
        .enumerate()
        .map(|(index, ((_, (player, frame)), tick))| {
            crate::camera_planning::camera_keyframe_for_scene(
                tick,
                player,
                samples[0].1.0,
                item.request.camera_style,
                index,
                crate::camera_planning::engagement_focus(frame, player),
            )
        })
        .collect();
    let plan = HlaePlan {
        mode: HlaePlanMode::Capture,
        tick_rate: item.segment.tick_rate,
        demo_path: item.segment.demo_path.clone(),
        output_directory: managed_job_root.join("capture"),
        pre_roll_ticks: item.segment.start_tick.saturating_sub(1).min(128),
        capture,
        presentation: scene_presentation(item, presentation)?,
        shots: vec![CameraShot {
            id: format!("clip_{:02}", item.item_index + 1),
            start_tick: item.segment.start_tick,
            end_tick: item.segment.end_tick,
            position_interpolation: PositionInterpolation::Cubic,
            rotation_interpolation: RotationInterpolation::SphericalCubic,
            keyframes,
        }],
    };
    validate_hlae_plan(&plan).map_err(|error| DomainError::InvalidInput(error.to_string()))?;
    Ok(plan)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HlaeRecordingSessionResult {
    output_path: PathBuf,
    output_bytes: u64,
    frame_count: u64,
    duration_100ns: u64,
    manifest_path: PathBuf,
    loader_process_id: u32,
    game_process_id: u32,
    observed_start_tick: u32,
    observed_end_tick: u32,
    observer_steam_id64: Option<u64>,
    observer_mode_raw: Option<u8>,
    observer_verified_before_capture_tick: Option<u32>,
    observer_verified_at_capture_stop_tick: Option<u32>,
    audio_stream_included: bool,
}

/// Immutable job-level sharing facts used by persistent session runners.
/// `shared_demo` is present only when every session take is bound to the same
/// verified Demo and total-tick authority; other jobs remain safely
/// representable as isolated takes.
#[derive(Debug, Clone, PartialEq, Eq)]
struct HlaeSessionJobContract {
    job_id: Uuid,
    shared_demo: Option<PathBuf>,
    verified_total_ticks: Option<u32>,
    take_count: usize,
    persistent_pov: bool,
}

#[async_trait]
trait HlaeSessionRunner: fmt::Debug + Send + Sync {
    async fn begin_job(
        &self,
        _contract: HlaeSessionJobContract,
    ) -> Result<(), RuntimeHlaeSessionError> {
        Ok(())
    }

    async fn run(
        &self,
        request: RuntimeHlaeSessionRequest,
        progress: RecordingProgressSink,
    ) -> Result<HlaeRecordingSessionResult, RuntimeHlaeSessionError>;

    async fn acknowledge_published_take(
        &self,
        _job_id: Uuid,
        _take_index: usize,
    ) -> Result<(), RuntimeHlaeSessionError> {
        Ok(())
    }

    async fn abort_job(&self, _job_id: Uuid) -> Result<(), RuntimeHlaeSessionError> {
        Ok(())
    }

    async fn finish_job(&self, _job_id: Uuid) -> Result<(), RuntimeHlaeSessionError> {
        Ok(())
    }
}

#[async_trait]
impl HlaeSessionRunner for RuntimeHlaeSessionOrchestrator {
    async fn run(
        &self,
        request: RuntimeHlaeSessionRequest,
        progress: RecordingProgressSink,
    ) -> Result<HlaeRecordingSessionResult, RuntimeHlaeSessionError> {
        let evidence =
            RuntimeHlaeSessionOrchestrator::run_with_progress(self, request, progress).await?;
        Ok(recording_session_result(evidence))
    }
}

fn recording_session_result(evidence: RuntimeHlaeSessionEvidence) -> HlaeRecordingSessionResult {
    HlaeRecordingSessionResult {
        output_path: evidence.mp4_summary.output_path,
        output_bytes: evidence.mp4_summary.output_bytes,
        frame_count: evidence.mp4_summary.frame_count,
        duration_100ns: evidence.mp4_summary.video_duration_100ns,
        manifest_path: evidence.artifact_manifest,
        loader_process_id: evidence.loader_process_id,
        game_process_id: evidence.game_process_id,
        observed_start_tick: evidence.observed_capture_span.start_tick(),
        observed_end_tick: evidence.observed_capture_span.end_tick(),
        observer_steam_id64: evidence
            .observer_evidence
            .map(vibe_cs_hlae::ObservedPlayerPov::steam_id64),
        observer_mode_raw: evidence
            .observer_evidence
            .map(vibe_cs_hlae::ObservedPlayerPov::observer_mode),
        observer_verified_before_capture_tick: evidence
            .observer_evidence
            .map(vibe_cs_hlae::ObservedPlayerPov::verified_before_capture_tick),
        observer_verified_at_capture_stop_tick: evidence
            .observer_evidence
            .and_then(vibe_cs_hlae::ObservedPlayerPov::verified_at_capture_stop_tick),
        audio_stream_included: evidence.mp4_summary.audio_stream_included,
    }
}

#[derive(Debug, Default)]
struct PersistentRuntimeHlaeSessionRunner {
    orchestrator: RuntimeHlaeSessionOrchestrator,
    jobs: tokio::sync::Mutex<HashMap<Uuid, Arc<tokio::sync::Mutex<PersistentRuntimeHlaeJob>>>>,
}

#[derive(Debug)]
struct PersistentRuntimeHlaeJob {
    contract: HlaeSessionJobContract,
    session: Option<RuntimeHlaePersistentSession>,
    acknowledged_takes: usize,
}

#[async_trait]
impl HlaeSessionRunner for PersistentRuntimeHlaeSessionRunner {
    async fn begin_job(
        &self,
        contract: HlaeSessionJobContract,
    ) -> Result<(), RuntimeHlaeSessionError> {
        if !contract.persistent_pov {
            return Ok(());
        }
        let job_id = contract.job_id;
        let mut jobs = self.jobs.lock().await;
        if jobs.contains_key(&job_id) {
            return Err(vibe_cs_hlae::HlaeError::InvalidPlan(
                "persistent HLAE job is already registered".to_owned(),
            )
            .into());
        }
        jobs.insert(
            job_id,
            Arc::new(tokio::sync::Mutex::new(PersistentRuntimeHlaeJob {
                contract,
                session: None,
                acknowledged_takes: 0,
            })),
        );
        Ok(())
    }

    async fn run(
        &self,
        request: RuntimeHlaeSessionRequest,
        progress: RecordingProgressSink,
    ) -> Result<HlaeRecordingSessionResult, RuntimeHlaeSessionError> {
        let job = self.jobs.lock().await.get(&request.job_id).cloned();
        let Some(job) = job else {
            return self
                .orchestrator
                .run_with_progress(request, progress)
                .await
                .map(recording_session_result);
        };
        let mut job = job.lock().await;
        if request.take_index == 0 {
            if job.session.is_some() || job.acknowledged_takes != 0 {
                return Err(vibe_cs_hlae::HlaeError::InvalidPlan(
                    "persistent HLAE first Take was already started".to_owned(),
                )
                .into());
            }
            let (session, evidence) = self
                .orchestrator
                .begin_persistent_with_progress(request, progress)
                .await?;
            job.session = Some(session);
            return Ok(recording_session_result(evidence));
        }
        if request.take_index != job.acknowledged_takes {
            return Err(vibe_cs_hlae::HlaeError::InvalidPlan(
                "persistent HLAE next Take requires the previous database ACK".to_owned(),
            )
            .into());
        }
        let session = job.session.as_mut().ok_or_else(|| {
            RuntimeHlaeSessionError::from(vibe_cs_hlae::HlaeError::InvalidPlan(
                "persistent HLAE session was not opened".to_owned(),
            ))
        })?;
        self.orchestrator
            .capture_next_persistent_with_progress(session, request, progress)
            .await
            .map(recording_session_result)
    }

    async fn acknowledge_published_take(
        &self,
        job_id: Uuid,
        take_index: usize,
    ) -> Result<(), RuntimeHlaeSessionError> {
        let job = self.jobs.lock().await.get(&job_id).cloned();
        let Some(job) = job else {
            return Ok(());
        };
        let mut job = job.lock().await;
        if take_index != job.acknowledged_takes || take_index >= job.contract.take_count {
            return Err(vibe_cs_hlae::HlaeError::InvalidPlan(
                "persistent HLAE database ACK is out of sequence".to_owned(),
            )
            .into());
        }
        job.acknowledged_takes += 1;
        Ok(())
    }

    async fn finish_job(&self, job_id: Uuid) -> Result<(), RuntimeHlaeSessionError> {
        let job = self.jobs.lock().await.remove(&job_id);
        let Some(job) = job else {
            return Ok(());
        };
        let mut job = job.lock().await;
        let Some(session) = job.session.take() else {
            return Ok(());
        };
        self.orchestrator.finish_persistent(session).await
    }

    async fn abort_job(&self, job_id: Uuid) -> Result<(), RuntimeHlaeSessionError> {
        let job = self.jobs.lock().await.remove(&job_id);
        let Some(job) = job else {
            return Ok(());
        };
        let mut job = job.lock().await;
        let Some(session) = job.session.take() else {
            return Ok(());
        };
        self.orchestrator.abort_persistent(session)
    }
}

trait HlaeLaunchEnvironment: fmt::Debug + Send + Sync {
    fn resolve(
        &self,
        config: &AppConfig,
        resolution: LaunchResolution,
    ) -> Result<HlaeBundleLaunchInputs, DomainError>;
}

trait HlaeEncoderCapabilityProbe: fmt::Debug + Send + Sync {
    fn probe(&self) -> HlaeSequenceEncoderCapabilityReport;
}

#[derive(Debug)]
struct SystemHlaeEncoderCapabilityProbe;

impl HlaeEncoderCapabilityProbe for SystemHlaeEncoderCapabilityProbe {
    fn probe(&self) -> HlaeSequenceEncoderCapabilityReport {
        probe_hlae_sequence_encoder_capabilities()
    }
}

#[cfg(test)]
#[derive(Debug)]
struct AvailableHlaeEncoderCapabilityProbe;

#[cfg(test)]
impl HlaeEncoderCapabilityProbe for AvailableHlaeEncoderCapabilityProbe {
    fn probe(&self) -> HlaeSequenceEncoderCapabilityReport {
        HlaeSequenceEncoderCapabilityReport {
            status: vibe_cs_platform_windows::HlaeSequenceEncoderProbeStatus::EncoderCandidatesRegistered,
            media_foundation_started: true,
            registered_h264_encoder_count: 1,
            registered_hardware_h264_encoder_count: 0,
            registered_aac_encoder_count: 1,
            end_to_end_mp4_encode_verified: false,
            detail: "deterministic test capability inventory".to_owned(),
        }
    }
}

#[derive(Debug, Clone)]
struct SystemHlaeLaunchEnvironment {
    data_dir: PathBuf,
}

impl HlaeLaunchEnvironment for SystemHlaeLaunchEnvironment {
    fn resolve(
        &self,
        config: &AppConfig,
        resolution: LaunchResolution,
    ) -> Result<HlaeBundleLaunchInputs, DomainError> {
        if !cfg!(windows) {
            return Err(DomainError::DependencyUnavailable(
                "managed HLAE movie capture is supported only on Windows".to_owned(),
            ));
        }
        let discovery = discover_managed_hlae(&self.data_dir.join("runtimes").join("hlae"));
        let installation = discovery.installation.ok_or_else(|| {
            DomainError::DependencyUnavailable(
                "prepare the app-managed movie engine before recording".to_owned(),
            )
        })?;
        if installation.source != HlaeDiscoverySource::Managed {
            return Err(DomainError::DependencyUnavailable(
                "recording requires the integrity-verified app-managed movie engine".to_owned(),
            ));
        }
        let paths = discover_paths(config);
        let game_executable = paths.cs2.ok_or_else(|| {
            DomainError::DependencyUnavailable("CS2 executable was not found".to_owned())
        })?;
        let steam_executable = paths.steam.ok_or_else(|| {
            DomainError::DependencyUnavailable("Steam executable was not found".to_owned())
        })?;
        let user_config_directory =
            discover_active_cs2_user_config(&steam_executable).map_err(|error| {
                DomainError::DependencyUnavailable(format!(
                    "active Steam CS2 configuration is unavailable: {error}"
                ))
            })?;
        Ok(HlaeBundleLaunchInputs {
            installation,
            game_executable,
            steam_executable,
            user_config_directory: Some(user_config_directory),
            resolution,
        })
    }
}

#[derive(Debug, Clone)]
struct HlaeRecordingClipContext {
    binding: PreparedRecording,
    expected_output_mp4: PathBuf,
    job_root: PathBuf,
    plan: RuntimeHlaeCaptureProgram,
    verified_total_ticks: u32,
    maximum_end_overshoot: u32,
}

#[derive(Debug)]
struct HlaeRecordingJobContext {
    job_id: Uuid,
    config: AppConfig,
    roots: ManagedRecordingRoots,
    launch_inputs: HlaeBundleLaunchInputs,
    target_bitrate_bps: u32,
    persistent_pov: bool,
    clips: Vec<HlaeRecordingClipContext>,
}

impl HlaeRecordingJobContext {
    fn session_contract(&self) -> HlaeSessionJobContract {
        let first = &self.clips[0];
        let shares_demo = self.clips.iter().all(|clip| {
            clip.binding.demo.id == first.binding.demo.id
                && capture_program_demo_path(&clip.plan) == capture_program_demo_path(&first.plan)
                && clip.verified_total_ticks == first.verified_total_ticks
        });
        HlaeSessionJobContract {
            job_id: self.job_id,
            shared_demo: shares_demo.then(|| capture_program_demo_path(&first.plan).to_path_buf()),
            verified_total_ticks: shares_demo.then_some(first.verified_total_ticks),
            take_count: self.clips.len(),
            persistent_pov: self.persistent_pov,
        }
    }
}

fn capture_program_demo_path(program: &RuntimeHlaeCaptureProgram) -> &Path {
    match program {
        RuntimeHlaeCaptureProgram::Camera(plan) => &plan.demo_path,
        RuntimeHlaeCaptureProgram::PlayerPov(plan) => &plan.demo_path,
    }
}

/// Public recording queue backend using app-managed HLAE and native Windows
/// Media Foundation. It never probes or launches OBS or an external encoder.
#[derive(Clone)]
pub struct HlaeRecordingBackend {
    data_dir: PathBuf,
    session_runner: Arc<dyn HlaeSessionRunner>,
    launch_environment: Arc<dyn HlaeLaunchEnvironment>,
    encoder_capability_probe: Arc<dyn HlaeEncoderCapabilityProbe>,
    job_contexts: Arc<Mutex<HashMap<Uuid, Arc<HlaeRecordingJobContext>>>>,
    session_timeouts: RuntimeHlaeSessionTimeouts,
}

impl fmt::Debug for HlaeRecordingBackend {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HlaeRecordingBackend")
            .field("data_dir", &self.data_dir)
            .finish_non_exhaustive()
    }
}

impl HlaeRecordingBackend {
    #[must_use]
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            launch_environment: Arc::new(SystemHlaeLaunchEnvironment {
                data_dir: data_dir.clone(),
            }),
            data_dir,
            session_runner: Arc::new(PersistentRuntimeHlaeSessionRunner::default()),
            encoder_capability_probe: Arc::new(SystemHlaeEncoderCapabilityProbe),
            job_contexts: Arc::new(Mutex::new(HashMap::new())),
            session_timeouts: RuntimeHlaeSessionTimeouts::default(),
        }
    }

    #[cfg(test)]
    fn with_dependencies(
        data_dir: PathBuf,
        session_runner: Arc<dyn HlaeSessionRunner>,
        launch_environment: Arc<dyn HlaeLaunchEnvironment>,
    ) -> Self {
        Self {
            data_dir,
            session_runner,
            launch_environment,
            encoder_capability_probe: Arc::new(AvailableHlaeEncoderCapabilityProbe),
            job_contexts: Arc::new(Mutex::new(HashMap::new())),
            session_timeouts: RuntimeHlaeSessionTimeouts::default(),
        }
    }

    #[cfg(test)]
    fn with_cancellation_grace(mut self, cancellation_grace: std::time::Duration) -> Self {
        self.session_timeouts.cancellation_grace = cancellation_grace;
        self
    }

    async fn ensure_managed_roots(&self) -> Result<ManagedRecordingRoots, DomainError> {
        if !self.data_dir.is_absolute() {
            return Err(DomainError::InvalidInput(
                "recording data directory must be absolute".to_owned(),
            ));
        }
        tokio::fs::create_dir_all(&self.data_dir)
            .await
            .map_err(|error| {
                DomainError::Internal(format!(
                    "unable to create recording data directory {}: {error}",
                    self.data_dir.display()
                ))
            })?;
        canonical_plain_directory(&self.data_dir, "recording data directory")?;
        let jobs = self.data_dir.join(MANAGED_HLAE_JOB_DIRECTORY);
        let leases = self.data_dir.join(MANAGED_HLAE_LEASE_DIRECTORY);
        let outputs = self.data_dir.join(RECORDED_CLIP_DIRECTORY);
        for path in [&jobs, &leases, &outputs] {
            match tokio::fs::create_dir(path).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(DomainError::Internal(format!(
                        "unable to create managed recording directory {}: {error}",
                        path.display()
                    )));
                }
            }
        }
        ManagedRecordingRoots::from_created(&self.data_dir)
    }

    async fn remove_unpublished_output(
        roots: &ManagedRecordingRoots,
        expected: &Path,
    ) -> Result<(), DomainError> {
        roots.revalidate()?;
        validate_expected_output_location(roots, expected)?;
        let metadata = match fs::symlink_metadata(expected) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(managed_path_error(format!(
                    "unable to inspect unpublished recording output {}: {error}",
                    expected.display()
                )));
            }
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata_is_reparse_point(&metadata)
        {
            return Err(managed_path_error(
                "refusing to remove an unpublished output that is not a regular non-link file",
            ));
        }
        let identity = fs::canonicalize(expected).map_err(|error| {
            managed_path_error(format!(
                "unable to resolve unpublished recording output {}: {error}",
                expected.display()
            ))
        })?;
        if identity.parent() != Some(roots.recordings.as_path())
            || !identity.starts_with(&roots.recordings)
        {
            return Err(managed_path_error(
                "refusing to remove an unpublished output outside the managed recordings directory",
            ));
        }
        match tokio::fs::remove_file(expected).await {
            Ok(()) => {
                tracing::info!(path = %expected.display(), "removed unpublished native recording output");
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(managed_path_error(format!(
                "unable to remove unpublished native recording output {}: {error}",
                expected.display()
            ))),
        }
    }

    async fn error_after_output_cleanup(
        roots: &ManagedRecordingRoots,
        expected: &Path,
        primary: DomainError,
    ) -> DomainError {
        match Self::remove_unpublished_output(roots, expected).await {
            Ok(()) => primary,
            Err(cleanup) => DomainError::CleanupFailed(format!(
                "{primary}; managed output cleanup also failed: {cleanup}"
            )),
        }
    }

    fn capture_settings(config: &AppConfig) -> Result<CaptureSettings, DomainError> {
        let (width, height) = parse_resolution(&config.recording.resolution)?;
        if !matches!(config.recording.fps, 30 | 60) {
            return Err(DomainError::InvalidInput(
                "native HLAE capture supports 30 or 60 FPS".to_owned(),
            ));
        }
        Ok(CaptureSettings {
            fps: config.recording.fps,
            width,
            height,
            record_wav: true,
            layers: CaptureLayers::default(),
        })
    }

    fn verify_native_encoder_candidates(
        report: &HlaeSequenceEncoderCapabilityReport,
        require_audio: bool,
    ) -> Result<(), DomainError> {
        if !report.media_foundation_started || report.registered_h264_encoder_count == 0 {
            return Err(DomainError::DependencyUnavailable(format!(
                "Windows H.264 movie encoding is unavailable: {}",
                report.detail
            )));
        }
        if require_audio && report.registered_aac_encoder_count == 0 {
            return Err(DomainError::DependencyUnavailable(format!(
                "Windows AAC movie encoding is unavailable: {}",
                report.detail
            )));
        }
        Ok(())
    }

    fn validate_native_feature_contract(
        _config: &AppConfig,
        items: &[PreparedRecording],
    ) -> Result<(), DomainError> {
        if items.is_empty() {
            return Err(DomainError::InvalidInput(
                "recording queue must contain at least one item".to_owned(),
            ));
        }
        if u32::try_from(items.len()).map_or(true, |count| count > HLAE_SESSION_MAX_TAKES) {
            return Err(DomainError::InvalidInput(format!(
                "recording queue exceeds the managed HLAE session limit of {HLAE_SESSION_MAX_TAKES} takes"
            )));
        }
        Ok(())
    }

    /// The job-wide fallback presentation, read from the global
    /// `AppConfig.recording` defaults.
    ///
    /// This is what a shot that carries no presentation of its own records
    /// with. [`take_presentation`] decides, per take, whether the fallback or
    /// the shot's own presentation applies.
    ///
    /// It no longer validates anything: `RecordingDefaults.voice` is a
    /// three-valued enum, so the illegal combination this used to reject
    /// cannot be written down. That is the point of the collapse — the guard
    /// moved from every read to the type.
    fn presentation(config: &AppConfig) -> HlaePlayerPovPresentation {
        HlaePlayerPovPresentation {
            radar: if config.recording.show_radar {
                HlaeRadarVisibility::Visible
            } else {
                HlaeRadarVisibility::Hidden
            },
            hud: if config.recording.show_hud {
                HlaeHudVisibility::Visible
            } else {
                HlaeHudVisibility::DeathNoticesOnly
            },
            camera_fov: config.recording.camera_fov,
            viewmodel_fov: config.recording.viewmodel_fov,
            flash_alpha: config.recording.flash_alpha,
            voice: match config.recording.voice {
                vibe_cs_domain::RecordingVoicePolicy::Muted => HlaeVoicePolicy::Muted,
                vibe_cs_domain::RecordingVoicePolicy::TargetOnly => HlaeVoicePolicy::TargetOnly,
                vibe_cs_domain::RecordingVoicePolicy::AllPlayers => HlaeVoicePolicy::AllPlayers,
            },
        }
    }

    async fn prepare_job_context(
        &self,
        config: &AppConfig,
        items: &[PreparedRecording],
    ) -> Result<HlaeRecordingJobContext, DomainError> {
        Self::validate_native_feature_contract(config, items)?;
        let capture = Self::capture_settings(config)?;
        Self::verify_native_encoder_candidates(
            &self.encoder_capability_probe.probe(),
            capture.record_wav,
        )?;
        let fallback_presentation = Self::presentation(config);
        let roots = self.ensure_managed_roots().await?;
        let launch_inputs = self.launch_environment.resolve(
            config,
            LaunchResolution {
                width: capture.width,
                height: capture.height,
            },
        )?;
        let target_bitrate_bps = native_target_bitrate(config)?;
        let job_id = items[0].job_id;
        let first_presentation = take_presentation(fallback_presentation, &items[0].request);
        let persistent_pov = items.len() > 1
            && items.iter().all(|item| {
                item.request.camera_style == HlaeCameraStyle::Pov
                    && item.demo.id == items[0].demo.id
                    && item.segment.player_id == items[0].segment.player_id
                    && item.segment.spectator_slot == items[0].segment.spectator_slot
                    && item.segment.verified_total_ticks == items[0].segment.verified_total_ticks
                    && take_presentation(fallback_presentation, &item.request) == first_presentation
            });
        let persistent_root = managed_job_path(&roots, job_id, 0);
        let mut output_names = HashSet::with_capacity(items.len());
        let mut clips = Vec::with_capacity(items.len());
        for (item_index, item) in items.iter().enumerate() {
            if item.job_id != job_id || item.item_index != item_index {
                return Err(DomainError::Conflict(
                    "recording job items do not match one contiguous immutable job binding"
                        .to_owned(),
                ));
            }
            verify_recording_demo_content(&item.demo, &item.segment.demo_path).await?;
            if !item.segment.demo_path.is_file() {
                return Err(DomainError::DependencyUnavailable(format!(
                    "recording Demo is unavailable: {}",
                    item.segment.demo_path.display()
                )));
            }
            if !output_names.insert(item.segment.output_file_name.clone()) {
                return Err(DomainError::Conflict(
                    "recording job contains duplicate managed output names".to_owned(),
                ));
            }
            let expected_output_mp4 = roots.expected_output(&item.segment.output_file_name)?;
            if expected_output_mp4.exists() {
                return Err(DomainError::Conflict(
                    "recording output already exists".to_owned(),
                ));
            }
            let item_job_root = managed_job_path(&roots, item.job_id, item.item_index);
            let job_root = if persistent_pov {
                persistent_root.clone()
            } else {
                item_job_root
            };
            // Every take resolves its own presentation. A job whose first shot
            // is muted and whose second keeps team voice has to record two
            // different soundtracks, so this cannot be hoisted out of the loop.
            let presentation = take_presentation(fallback_presentation, &item.request);
            let plan = match item.request.camera_style {
                HlaeCameraStyle::Pov => RuntimeHlaeCaptureProgram::PlayerPov(
                    build_player_pov_plan(item, &job_root, capture.clone(), presentation)?,
                ),
                _ => RuntimeHlaeCaptureProgram::Camera(build_camera_plan(
                    item,
                    &job_root,
                    capture.clone(),
                    presentation,
                )?),
            };
            let verified_total_ticks = item.segment.verified_total_ticks.ok_or_else(|| {
                DomainError::DependencyUnavailable(
                    "this Demo must be reanalyzed before recording".to_owned(),
                )
            })?;
            let maximum_end_overshoot = verified_total_ticks
                .saturating_sub(u32::try_from(item.segment.end_tick).map_err(|_| {
                    DomainError::InvalidInput("recording end tick is unsupported".to_owned())
                })?)
                .min(CAPTURE_SCHEDULER_OVERSHOOT_TICKS);
            clips.push(HlaeRecordingClipContext {
                binding: item.clone(),
                expected_output_mp4,
                job_root,
                plan,
                verified_total_ticks,
                maximum_end_overshoot,
            });
        }
        Ok(HlaeRecordingJobContext {
            job_id,
            config: config.clone(),
            roots,
            launch_inputs,
            target_bitrate_bps,
            persistent_pov,
            clips,
        })
    }

    fn job_context(&self, job_id: Uuid) -> Result<Arc<HlaeRecordingJobContext>, DomainError> {
        self.job_contexts
            .lock()
            .map_err(|_| DomainError::Internal("HLAE job context lock was poisoned".to_owned()))?
            .get(&job_id)
            .cloned()
            .ok_or_else(|| {
                DomainError::Conflict(
                    "recording job has no active immutable HLAE preflight context".to_owned(),
                )
            })
    }

    #[cfg(test)]
    async fn record_for_test(
        &self,
        config: &AppConfig,
        item: &PreparedRecording,
        cancellation: &RecordingCancellation,
        progress: &RecordingProgressSink,
    ) -> Result<RecordedClip, DomainError> {
        let owns_context = self.job_context(item.job_id).is_err();
        if owns_context {
            self.begin_job(config, std::slice::from_ref(item)).await?;
        }
        let result = self.record(config, item, cancellation, progress).await;
        if owns_context {
            let cleanup = self.finish_job(item.job_id).await;
            return match (result, cleanup) {
                (Ok(clip), Ok(())) => Ok(clip),
                (Err(error), Ok(())) => Err(error),
                (Ok(_), Err(cleanup)) => Err(cleanup),
                (Err(primary), Err(cleanup)) => Err(DomainError::CleanupFailed(format!(
                    "{primary}; additionally failed to clean test job context: {cleanup}"
                ))),
            };
        }
        result
    }
}

#[async_trait]
impl RecordingBackend for HlaeRecordingBackend {
    async fn recover_orphaned_job(
        &self,
        job: &RecordingJob,
    ) -> Result<OrphanedRecordingRecovery, DomainError> {
        let roots = self.ensure_managed_roots().await?;
        let job_id = job.id;
        let item_index = job.current_index;
        let job = job.clone();
        let recovery = tokio::task::spawn_blocking(move || recover_managed_hlae_job(&roots, &job))
            .await
            .map_err(|error| {
                DomainError::CleanupFailed(format!(
                    "managed HLAE artifact recovery task failed: {error}"
                ))
            })??;
        match &recovery {
            OrphanedRecordingRecovery::NoPublishedClip => {
                tracing::info!(%job_id, item_index, "reconciled exact HLAE artifact lease");
            }
            OrphanedRecordingRecovery::PublishedClip { .. } => {
                tracing::info!(%job_id, item_index, "recovered exact verified HLAE publication");
            }
        }
        Ok(recovery)
    }

    async fn commit_recorded_clip(
        &self,
        job_id: Uuid,
        item_index: usize,
        clip: &RecordedClip,
    ) -> Result<(), DomainError> {
        let roots = self.ensure_managed_roots().await?;
        let clip = clip.clone();
        tokio::task::spawn_blocking(move || {
            commit_managed_hlae_clip(&roots, job_id, item_index, &clip)
        })
        .await
        .map_err(|error| {
            DomainError::CleanupFailed(format!(
                "[HLAE_PUBLISHED_CLIP_COMMIT_FAILED] commit task failed: {error}"
            ))
        })??;
        self.session_runner
            .acknowledge_published_take(job_id, item_index)
            .await
            .map_err(session_error)
    }

    async fn preflight(
        &self,
        config: &AppConfig,
        items: &[PreparedRecording],
    ) -> Result<(), DomainError> {
        let _context = self.prepare_job_context(config, items).await?;
        Ok(())
    }

    async fn begin_job(
        &self,
        config: &AppConfig,
        items: &[PreparedRecording],
    ) -> Result<(), DomainError> {
        let context = Arc::new(self.prepare_job_context(config, items).await?);
        let job_id = context.job_id;
        let contract = context.session_contract();
        {
            let mut contexts = self.job_contexts.lock().map_err(|_| {
                DomainError::Internal("HLAE job context lock was poisoned".to_owned())
            })?;
            match contexts.entry(job_id) {
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(context);
                }
                std::collections::hash_map::Entry::Occupied(_) => {
                    return Err(DomainError::Conflict(
                        "recording job already has an active HLAE preflight context".to_owned(),
                    ));
                }
            }
        }
        if let Err(error) = self.session_runner.begin_job(contract).await {
            self.job_contexts
                .lock()
                .map_err(|_| {
                    DomainError::Internal("HLAE job context lock was poisoned".to_owned())
                })?
                .remove(&job_id);
            let primary = session_error(error);
            return match self.session_runner.finish_job(job_id).await {
                Ok(()) => Err(primary),
                Err(cleanup) => Err(DomainError::CleanupFailed(format!(
                    "{primary}; persistent HLAE session cleanup also failed: {}",
                    session_error(cleanup)
                ))),
            };
        }
        Ok(())
    }

    async fn finish_job(&self, job_id: Uuid) -> Result<(), DomainError> {
        let context = self
            .job_contexts
            .lock()
            .map_err(|_| DomainError::Internal("HLAE job context lock was poisoned".to_owned()))?
            .remove(&job_id);
        if context.is_some() {
            self.session_runner
                .finish_job(job_id)
                .await
                .map_err(session_error)?;
        }
        Ok(())
    }

    async fn record(
        &self,
        config: &AppConfig,
        item: &PreparedRecording,
        cancellation: &RecordingCancellation,
        progress: &RecordingProgressSink,
    ) -> Result<RecordedClip, DomainError> {
        if cancellation.is_cancelled() {
            return Err(DomainError::Conflict("recording was cancelled".to_owned()));
        }
        let context = self.job_context(item.job_id)?;
        if context.config != *config {
            return Err(DomainError::Conflict(
                "recording configuration changed after immutable HLAE preflight".to_owned(),
            ));
        }
        let clip_context = context.clips.get(item.item_index).ok_or_else(|| {
            DomainError::Conflict(
                "recording item is not bound to the active HLAE job context".to_owned(),
            )
        })?;
        if clip_context.binding != *item {
            return Err(DomainError::Conflict(
                "recording item changed after immutable HLAE preflight".to_owned(),
            ));
        }
        verify_recording_demo_content(&item.demo, &item.segment.demo_path).await?;
        let roots = &context.roots;
        roots.revalidate()?;
        let expected_output_mp4 = &clip_context.expected_output_mp4;
        if expected_output_mp4.exists() {
            return Err(DomainError::Conflict(
                "recording output already exists".to_owned(),
            ));
        }
        let lease = create_managed_hlae_artifact_lease(
            &context.roots,
            item.job_id,
            item.item_index,
            expected_output_mp4,
        )?;
        let process_cancellation = ProcessCancellation::default();
        let session_timeouts = self.session_timeouts;
        let request = RuntimeHlaeSessionRequest {
            job_id: item.job_id,
            take_index: item.item_index,
            capture_program: clip_context.plan.clone(),
            launch_inputs: context.launch_inputs.clone(),
            verified_total_ticks: clip_context.verified_total_ticks,
            managed_job_root: clip_context.job_root.clone(),
            output_mp4: expected_output_mp4.clone(),
            target_bitrate_bps: context.target_bitrate_bps,
            max_start_overshoot_ticks: CAPTURE_SCHEDULER_OVERSHOOT_TICKS,
            max_end_overshoot_ticks: clip_context.maximum_end_overshoot,
            take_stability: HlaeTakeStabilityPolicy::default(),
            timeouts: session_timeouts,
            cancellation: process_cancellation.clone(),
        };
        let running = self.session_runner.run(request, progress.clone());
        tokio::pin!(running);
        let result = tokio::select! {
            result = &mut running => result,
            () = cancellation.cancelled() => {
                process_cancellation.cancel();
                match tokio::time::timeout(
                    session_timeouts
                        .cancellation_grace
                        .saturating_add(SESSION_RUNNER_SHUTDOWN_MARGIN),
                    &mut running,
                ).await {
                    Ok(result) => result,
                    Err(_) => Err(RuntimeHlaeSessionError::CancellationTimedOut {
                        phase: "stopping the managed HLAE session runner",
                        timeout: session_timeouts
                            .cancellation_grace
                            .saturating_add(SESSION_RUNNER_SHUTDOWN_MARGIN),
                    }),
                }
            }
        };
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                let abort = self
                    .session_runner
                    .abort_job(item.job_id)
                    .await
                    .map_err(session_error);
                let primary = Self::error_after_output_cleanup(
                    roots,
                    expected_output_mp4,
                    session_error(error),
                )
                .await;
                let primary = match abort {
                    Ok(()) => primary,
                    Err(abort) => DomainError::CleanupFailed(format!(
                        "{primary}; persistent HLAE session abort also failed: {abort}"
                    )),
                };
                return Err(cleanup_lease_after_attempt(roots, &lease, primary));
            }
        };
        let validated_output =
            match roots.validate_published_output(expected_output_mp4, &result.output_path) {
                Ok(path) => path,
                Err(error) => {
                    let primary =
                        Self::error_after_output_cleanup(roots, expected_output_mp4, error).await;
                    return Err(cleanup_lease_after_attempt(roots, &lease, primary));
                }
            };
        if let Err(error) = verify_recording_demo_content(&item.demo, &item.segment.demo_path).await
        {
            let primary = Self::error_after_output_cleanup(roots, expected_output_mp4, error).await;
            return Err(cleanup_lease_after_attempt(roots, &lease, primary));
        }
        if cancellation.is_cancelled() {
            let primary = Self::error_after_output_cleanup(
                roots,
                expected_output_mp4,
                DomainError::Conflict("recording was cancelled".to_owned()),
            )
            .await;
            return Err(cleanup_lease_after_attempt(roots, &lease, primary));
        }
        let duration_seconds =
            std::time::Duration::from_nanos(result.duration_100ns.saturating_mul(100))
                .as_secs_f64();
        if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
            let primary = Self::error_after_output_cleanup(
                roots,
                expected_output_mp4,
                DomainError::Internal(
                    "native HLAE encoder returned an invalid duration".to_owned(),
                ),
            )
            .await;
            return Err(cleanup_lease_after_attempt(roots, &lease, primary));
        }
        let clip = RecordedClip {
            id: Uuid::new_v4(),
            path: validated_output.to_string_lossy().into_owned(),
            title: item.segment.title.clone(),
            duration_seconds,
            demo_id: Some(item.demo.id),
            player_name: item.segment.player_name.clone(),
            category: item.segment.category.clone(),
            tags: item.segment.tags.clone(),
            metadata: json!({
                "request_id": item.request.id,
                "capture_backend": MANAGED_CAPTURE_BACKEND,
                "managed_recordings_root": roots.recordings.to_string_lossy(),
                "managed_output_identity": validated_output.to_string_lossy(),
                "artifact_manifest": result.manifest_path,
                "loader_process_id": result.loader_process_id,
                "game_process_id": result.game_process_id,
                "scheduled_start_tick": item.segment.start_tick,
                "scheduled_end_tick": item.segment.end_tick,
                "observed_start_tick": result.observed_start_tick,
                "observed_end_tick": result.observed_end_tick,
                "observer_steam_id64": result.observer_steam_id64.map(|value| value.to_string()),
                "observer_mode_raw": result.observer_mode_raw,
                "observer_identity_validation": if item.request.camera_style == HlaeCameraStyle::Pov { "continuous_bridge_lock_with_start_and_stop_evidence" } else { "not_required_for_camera_path" },
                "camera_style": item.request.camera_style,
                "observer_verified_before_capture_tick": result.observer_verified_before_capture_tick,
                "observer_verified_at_capture_stop_tick": result.observer_verified_at_capture_stop_tick,
                "output_bytes": result.output_bytes,
                "frame_count": result.frame_count,
                "audio_stream_included": result.audio_stream_included,
                "video_codec": "H.264",
                "audio_codec": if result.audio_stream_included { "AAC" } else { "none" },
            }),
            created_at: Utc::now(),
        };
        if let Err(error) = mark_lease_published(roots, &lease, &clip, result.output_bytes) {
            let primary = Self::error_after_output_cleanup(roots, expected_output_mp4, error).await;
            return Err(cleanup_lease_after_attempt(roots, &lease, primary));
        }
        Ok(clip)
    }
}

fn parse_resolution(value: &str) -> Result<(u32, u32), DomainError> {
    let (width, height) = value.trim().split_once('x').ok_or_else(|| {
        DomainError::InvalidInput("recording resolution must use WIDTHxHEIGHT".to_owned())
    })?;
    let width = width.parse::<u32>().map_err(|_| {
        DomainError::InvalidInput("recording resolution width is invalid".to_owned())
    })?;
    let height = height.parse::<u32>().map_err(|_| {
        DomainError::InvalidInput("recording resolution height is invalid".to_owned())
    })?;
    if !(320..=4_096).contains(&width)
        || !(240..=2_304).contains(&height)
        || !width.is_multiple_of(2)
        || !height.is_multiple_of(2)
    {
        return Err(DomainError::InvalidInput(
            "recording resolution is outside the native MP4 contract".to_owned(),
        ));
    }
    Ok((width, height))
}

fn native_target_bitrate(config: &AppConfig) -> Result<u32, DomainError> {
    let (width, height) = parse_resolution(&config.recording.resolution)?;
    let bitrate = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|value| value.checked_mul(u64::from(config.recording.fps)))
        .map(|value| value / 8)
        .ok_or_else(|| DomainError::InvalidInput("recording bitrate overflowed".to_owned()))?
        .clamp(MINIMUM_NATIVE_BITRATE_BPS, MAXIMUM_NATIVE_BITRATE_BPS);
    u32::try_from(bitrate)
        .map_err(|_| DomainError::InvalidInput("recording bitrate is unsupported".to_owned()))
}

fn validated_mp4_name(value: &str) -> Result<&str, DomainError> {
    let path = Path::new(value);
    if value.is_empty()
        || path.file_name().and_then(|name| name.to_str()) != Some(value)
        || path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("mp4"))
    {
        return Err(DomainError::InvalidInput(
            "recording output must be a direct-child .mp4 filename".to_owned(),
        ));
    }
    Ok(value)
}

fn session_error(error: RuntimeHlaeSessionError) -> DomainError {
    match error {
        RuntimeHlaeSessionError::Hlae(
            vibe_cs_hlae::HlaeError::UnsupportedPlatform
            | vibe_cs_hlae::HlaeError::InvalidInstallation(_),
        )
        | RuntimeHlaeSessionError::DiskSpace(
            vibe_cs_platform_windows::HlaeDiskSpacePreflightError::Insufficient { .. }
            | vibe_cs_platform_windows::HlaeDiskSpacePreflightError::DirectoryUnavailable {
                ..
            },
        )
        | RuntimeHlaeSessionError::Encode(HlaeTakeMp4EncodeError::Platform(
            vibe_cs_platform_windows::PlatformError::Unsupported
            | vibe_cs_platform_windows::PlatformError::ProcessNotFound(_),
        ))
        | RuntimeHlaeSessionError::Platform(
            vibe_cs_platform_windows::PlatformError::Unsupported
            | vibe_cs_platform_windows::PlatformError::ProcessNotFound(_),
        )
        | RuntimeHlaeSessionError::Bridge(RuntimeHlaeBridgeError::Platform(
            vibe_cs_platform_windows::PlatformError::Unsupported
            | vibe_cs_platform_windows::PlatformError::ProcessNotFound(_),
        )) => DomainError::DependencyUnavailable(error.to_string()),
        RuntimeHlaeSessionError::Hlae(
            vibe_cs_hlae::HlaeError::InvalidPlan(_) | vibe_cs_hlae::HlaeError::UnsafePath { .. },
        )
        | RuntimeHlaeSessionError::Protocol(
            vibe_cs_hlae::HlaeSessionProtocolError::InvalidPath(_)
            | vibe_cs_hlae::HlaeSessionProtocolError::InvalidTickContract,
        )
        | RuntimeHlaeSessionError::DiskSpace(
            vibe_cs_platform_windows::HlaeDiskSpacePreflightError::InvalidRequest(_),
        )
        | RuntimeHlaeSessionError::Encode(HlaeTakeMp4EncodeError::Platform(
            vibe_cs_platform_windows::PlatformError::InvalidInput(_),
        ))
        | RuntimeHlaeSessionError::Stability(HlaeTakeStabilityError::InvalidPolicy(_))
        | RuntimeHlaeSessionError::Platform(
            vibe_cs_platform_windows::PlatformError::InvalidInput(_),
        )
        | RuntimeHlaeSessionError::Bridge(RuntimeHlaeBridgeError::Platform(
            vibe_cs_platform_windows::PlatformError::InvalidInput(_),
        )) => DomainError::InvalidInput(error.to_string()),
        RuntimeHlaeSessionError::Hlae(
            vibe_cs_hlae::HlaeError::ArtifactBundleExists(_)
            | vibe_cs_hlae::HlaeError::ArtifactBundleConflict { .. },
        ) => DomainError::Conflict(error.to_string()),
        RuntimeHlaeSessionError::Stability(HlaeTakeStabilityError::Cancelled)
        | RuntimeHlaeSessionError::Encode(HlaeTakeMp4EncodeError::Platform(
            vibe_cs_platform_windows::PlatformError::Cancelled { .. },
        ))
        | RuntimeHlaeSessionError::Platform(vibe_cs_platform_windows::PlatformError::Cancelled {
            ..
        })
        | RuntimeHlaeSessionError::Bridge(RuntimeHlaeBridgeError::Platform(
            vibe_cs_platform_windows::PlatformError::Cancelled { .. },
        )) => DomainError::Conflict("recording was cancelled".to_owned()),
        RuntimeHlaeSessionError::Protocol(error) => DomainError::Internal(format!(
            "[HLAE_PROTOCOL_FAILURE] managed HLAE protocol failed: {error}"
        )),
        RuntimeHlaeSessionError::Stability(HlaeTakeStabilityError::TimedOut { timeout }) => {
            DomainError::Internal(format!(
                "[HLAE_TAKE_TIMEOUT] managed HLAE take did not stabilize within {timeout:?}"
            ))
        }
        RuntimeHlaeSessionError::Bridge(RuntimeHlaeBridgeError::Timeout { operation }) => {
            DomainError::Internal(format!(
                "[HLAE_BRIDGE_TIMEOUT] managed HLAE bridge {operation} timed out"
            ))
        }
        RuntimeHlaeSessionError::Bridge(error) => DomainError::Internal(format!(
            "[HLAE_BRIDGE_FAILURE] managed HLAE bridge failed: {error}"
        )),
        RuntimeHlaeSessionError::ProtocolTimedOut => DomainError::Internal(
            "[HLAE_PROTOCOL_TIMEOUT] managed HLAE protocol did not finalize before its absolute deadline"
                .to_owned(),
        ),
        RuntimeHlaeSessionError::LoaderExited { exit_code } => {
            DomainError::DependencyUnavailable(format!(
                "[HLAE_LOADER_EXITED] the managed movie engine exited before capture completed (exit code {exit_code}); verify or repair the app-managed HLAE runtime"
            ))
        }
        RuntimeHlaeSessionError::Cleanup { primary, cleanup } => DomainError::CleanupFailed(
            format!("[HLAE_CLEANUP_FAILURE] cleanup failed after {primary}: {cleanup}"),
        ),
        RuntimeHlaeSessionError::CancellationTimedOut { phase, timeout } => {
            DomainError::CleanupFailed(format!(
                "[HLAE_CANCELLATION_TIMEOUT] cancellation timed out while {phase} after {timeout:?}"
            ))
        }
        other => DomainError::Internal(format!("managed HLAE capture failed: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc as StdArc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    use chrono::Utc;
    use serde_json::Value;
    use sha2::Digest as _;
    use uuid::Uuid;
    use vibe_cs_domain::{
        DemoRecord, DemoStatus, JobStatus, RecordingRequest, ReplayFrame, ReplayPlayer,
    };
    use vibe_cs_hlae::{CaptureLayers, CaptureSettings, HlaeDiscoverySource, HlaeInstallation};
    use vibe_cs_recording::SegmentPlan;

    use super::*;

    fn fixture() -> (tempfile::TempDir, PreparedRecording) {
        let directory = tempfile::tempdir().expect("temporary HLAE recording fixture");
        let demo_path = directory.path().join("major.dem");
        std::fs::write(&demo_path, b"PBDEMS2 fixture").expect("demo fixture");
        let demo_id = Uuid::new_v4();
        let now = Utc::now();
        let request = RecordingRequest {
            id: Some(Uuid::new_v4()),
            demo_id,
            highlight_id: None,
            player_id: "76561197960690195".to_owned(),
            title: "FalleN R20".to_owned(),
            start_tick: 1_000,
            end_tick: 1_320,
            pre_roll_seconds: 0.0,
            post_roll_seconds: 0.0,
            victim_pov: false,
            camera_style: HlaeCameraStyle::default(),
            presentation: None,
        };
        let segment = SegmentPlan {
            demo_id,
            demo_path: demo_path.clone(),
            title: request.title.clone(),
            player_id: request.player_id.clone(),
            player_name: Some("FalleN".to_owned()),
            spectator_slot: Some(7),
            verified_total_ticks: Some(4_096),
            start_tick: request.start_tick,
            end_tick: request.end_tick,
            tick_rate: 64.0,
            output_file_name: "fallen-r20.mp4".to_owned(),
            category: "multi-kill".to_owned(),
            tags: vec!["4k".to_owned()],
            metadata: Value::Null,
        };
        (
            directory,
            PreparedRecording {
                job_id: Uuid::new_v4(),
                item_index: 0,
                request,
                demo: DemoRecord {
                    id: demo_id,
                    path: demo_path.to_string_lossy().into_owned(),
                    file_name: "major.dem".to_owned(),
                    display_name: "Major".to_owned(),
                    source: "test".to_owned(),
                    status: DemoStatus::Ready,
                    map_name: Some("de_mirage".to_owned()),
                    match_date: None,
                    duration_seconds: Some(64.0),
                    total_rounds: Some(21),
                    team_a_name: None,
                    team_b_name: None,
                    team_a_score: None,
                    team_b_score: None,
                    player_names: vec!["FalleN".to_owned()],
                    remark: String::new(),
                    content_sha256: Some(hex::encode(sha2::Sha256::digest(b"PBDEMS2 fixture"))),
                    file_size: 16,
                    created_at: now,
                    updated_at: now,
                },
                segment,
                replay_frames: Vec::new(),
            },
        )
    }

    fn capture() -> CaptureSettings {
        CaptureSettings {
            fps: 60,
            width: 1_920,
            height: 1_080,
            record_wav: true,
            layers: CaptureLayers::default(),
        }
    }

    fn ignored_progress() -> RecordingProgressSink {
        crate::recording_progress::recording_progress_channel().0
    }

    fn orphaned_recording_job(item: &PreparedRecording) -> RecordingJob {
        let now = Utc::now();
        RecordingJob {
            id: item.job_id,
            retry_of: None,
            status: JobStatus::Running,
            items: vec![item.request.clone()],
            current_index: item.item_index,
            progress: 0.5,
            message: "recording.stage.capturing".to_owned(),
            outputs: Vec::new(),
            error_code: None,
            created_at: now,
            updated_at: now,
        }
    }

    #[derive(Debug, Default)]
    struct FakeSessionRunner {
        observed: Mutex<Vec<(String, u8, u32, u32)>>,
    }

    #[async_trait]
    impl HlaeSessionRunner for FakeSessionRunner {
        async fn run(
            &self,
            request: RuntimeHlaeSessionRequest,
            _progress: RecordingProgressSink,
        ) -> Result<HlaeRecordingSessionResult, RuntimeHlaeSessionError> {
            let RuntimeHlaeCaptureProgram::PlayerPov(plan) = &request.capture_program else {
                panic!("recording queue must issue a player POV plan");
            };
            self.observed.lock().expect("observed requests").push((
                plan.player_id.clone(),
                plan.spectator_slot,
                request.verified_total_ticks,
                request.max_end_overshoot_ticks,
            ));
            std::fs::write(&request.output_mp4, b"verified-native-mp4")
                .expect("fake native output");
            Ok(HlaeRecordingSessionResult {
                output_path: request.output_mp4,
                output_bytes: 19,
                frame_count: 300,
                duration_100ns: 50_000_000,
                manifest_path: request
                    .managed_job_root
                    .join("vibe_cs_session_manifest.json"),
                loader_process_id: 100,
                game_process_id: 200,
                observed_start_tick: 1_001,
                observed_end_tick: 1_321,
                observer_steam_id64: Some(76_561_197_960_690_195),
                observer_mode_raw: Some(2),
                observer_verified_before_capture_tick: Some(1_000),
                observer_verified_at_capture_stop_tick: Some(1_321),
                audio_stream_included: true,
            })
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum PersistentSessionTrace {
        Opened {
            job_id: Uuid,
            take_count: usize,
        },
        DemoLoaded(PathBuf),
        Seek {
            take_index: usize,
            target_tick: u32,
        },
        Observer {
            take_index: usize,
            steam_id64: String,
        },
        RawCapture {
            take_index: usize,
        },
        Mp4Published {
            take_index: usize,
        },
        DatabaseAck {
            take_index: usize,
        },
        TakeFailed {
            take_index: usize,
        },
        Aborted {
            job_id: Uuid,
        },
        Closed {
            job_id: Uuid,
        },
    }

    #[derive(Debug, Default)]
    struct PersistentTracerState {
        active_job: Option<Uuid>,
        next_take: usize,
        acknowledged_takes: usize,
        session_roots: Vec<PathBuf>,
        events: Vec<PersistentSessionTrace>,
    }

    #[derive(Debug, Default)]
    struct PersistentTracerSessionRunner {
        state: Mutex<PersistentTracerState>,
        fail_take: Option<usize>,
    }

    #[async_trait]
    impl HlaeSessionRunner for PersistentTracerSessionRunner {
        async fn begin_job(
            &self,
            contract: HlaeSessionJobContract,
        ) -> Result<(), RuntimeHlaeSessionError> {
            let demo = contract.shared_demo.ok_or({
                RuntimeHlaeSessionError::Protocol(
                    vibe_cs_hlae::HlaeSessionProtocolError::InvalidHostTransition,
                )
            })?;
            assert_eq!(contract.verified_total_ticks, Some(4_096));
            assert!(contract.persistent_pov);
            let mut state = self.state.lock().expect("persistent tracer state");
            assert!(state.active_job.replace(contract.job_id).is_none());
            state.events.push(PersistentSessionTrace::Opened {
                job_id: contract.job_id,
                take_count: contract.take_count,
            });
            state.events.push(PersistentSessionTrace::DemoLoaded(demo));
            Ok(())
        }

        async fn run(
            &self,
            request: RuntimeHlaeSessionRequest,
            _progress: RecordingProgressSink,
        ) -> Result<HlaeRecordingSessionResult, RuntimeHlaeSessionError> {
            let RuntimeHlaeCaptureProgram::PlayerPov(plan) = &request.capture_program else {
                panic!("recording queue must issue a player POV plan");
            };
            let take_index = {
                let mut state = self.state.lock().expect("persistent tracer state");
                state.session_roots.push(request.managed_job_root.clone());
                assert!(
                    state.active_job.is_some(),
                    "one shared session must be open"
                );
                assert_eq!(
                    state.next_take, state.acknowledged_takes,
                    "take N+1 must wait for take N database acknowledgement"
                );
                let take_index = state.next_take;
                state.next_take += 1;
                if self.fail_take == Some(take_index) {
                    state
                        .events
                        .push(PersistentSessionTrace::TakeFailed { take_index });
                    return Err(RuntimeHlaeSessionError::Protocol(
                        vibe_cs_hlae::HlaeSessionProtocolError::InvalidBridgeTransition,
                    ));
                }
                state.events.extend([
                    PersistentSessionTrace::Seek {
                        take_index,
                        target_tick: u32::try_from(plan.start_tick - plan.pre_roll_ticks)
                            .expect("bounded seek"),
                    },
                    PersistentSessionTrace::Observer {
                        take_index,
                        steam_id64: plan.player_id.clone(),
                    },
                    PersistentSessionTrace::RawCapture { take_index },
                    PersistentSessionTrace::Mp4Published { take_index },
                ]);
                take_index
            };
            std::fs::write(
                &request.output_mp4,
                format!("verified-native-mp4-{take_index}"),
            )
            .expect("fake native output");
            let output_bytes = std::fs::metadata(&request.output_mp4)
                .expect("fake output metadata")
                .len();
            Ok(HlaeRecordingSessionResult {
                output_path: request.output_mp4,
                output_bytes,
                frame_count: 300,
                duration_100ns: 50_000_000,
                manifest_path: request
                    .managed_job_root
                    .join("vibe_cs_session_manifest.json"),
                loader_process_id: 100,
                game_process_id: 200,
                observed_start_tick: u32::try_from(plan.start_tick).expect("start tick"),
                observed_end_tick: u32::try_from(plan.end_tick).expect("end tick"),
                observer_steam_id64: Some(plan.player_id.parse().expect("SteamID64")),
                observer_mode_raw: Some(2),
                observer_verified_before_capture_tick: Some(
                    u32::try_from(plan.start_tick).expect("start tick"),
                ),
                observer_verified_at_capture_stop_tick: Some(
                    u32::try_from(plan.end_tick).expect("end tick"),
                ),
                audio_stream_included: true,
            })
        }

        async fn acknowledge_published_take(
            &self,
            job_id: Uuid,
            take_index: usize,
        ) -> Result<(), RuntimeHlaeSessionError> {
            let mut state = self.state.lock().expect("persistent tracer state");
            assert_eq!(state.active_job, Some(job_id));
            assert_eq!(take_index, state.acknowledged_takes);
            state.acknowledged_takes += 1;
            state
                .events
                .push(PersistentSessionTrace::DatabaseAck { take_index });
            Ok(())
        }

        async fn finish_job(&self, job_id: Uuid) -> Result<(), RuntimeHlaeSessionError> {
            let mut state = self.state.lock().expect("persistent tracer state");
            if state.active_job.take() == Some(job_id) {
                state.events.push(PersistentSessionTrace::Closed { job_id });
            }
            Ok(())
        }

        async fn abort_job(&self, job_id: Uuid) -> Result<(), RuntimeHlaeSessionError> {
            let mut state = self.state.lock().expect("persistent tracer state");
            assert_eq!(state.active_job.take(), Some(job_id));
            state
                .events
                .push(PersistentSessionTrace::Aborted { job_id });
            Ok(())
        }
    }

    #[derive(Debug, Default)]
    struct CancellationAfterPublishRunner {
        published: StdArc<tokio::sync::Notify>,
    }

    #[async_trait]
    impl HlaeSessionRunner for CancellationAfterPublishRunner {
        async fn run(
            &self,
            request: RuntimeHlaeSessionRequest,
            _progress: RecordingProgressSink,
        ) -> Result<HlaeRecordingSessionResult, RuntimeHlaeSessionError> {
            std::fs::write(&request.output_mp4, b"verified-native-mp4")
                .expect("fake native output");
            self.published.notify_one();
            request.cancellation.cancelled().await;
            Ok(HlaeRecordingSessionResult {
                output_path: request.output_mp4,
                output_bytes: 19,
                frame_count: 300,
                duration_100ns: 50_000_000,
                manifest_path: request
                    .managed_job_root
                    .join("vibe_cs_session_manifest.json"),
                loader_process_id: 100,
                game_process_id: 200,
                observed_start_tick: 1_001,
                observed_end_tick: 1_321,
                observer_steam_id64: Some(76_561_197_960_690_195),
                observer_mode_raw: Some(2),
                observer_verified_before_capture_tick: Some(1_000),
                observer_verified_at_capture_stop_tick: Some(1_321),
                audio_stream_included: true,
            })
        }
    }

    #[derive(Debug, Default)]
    struct CancellationIgnoringRunner {
        published: StdArc<tokio::sync::Notify>,
    }

    #[async_trait]
    impl HlaeSessionRunner for CancellationIgnoringRunner {
        async fn run(
            &self,
            request: RuntimeHlaeSessionRequest,
            _progress: RecordingProgressSink,
        ) -> Result<HlaeRecordingSessionResult, RuntimeHlaeSessionError> {
            std::fs::write(&request.output_mp4, b"unpublished-native-mp4")
                .expect("fake native output");
            self.published.notify_one();
            futures_util::future::pending().await
        }
    }

    #[derive(Debug)]
    struct InvalidPlanSessionRunner;

    #[async_trait]
    impl HlaeSessionRunner for InvalidPlanSessionRunner {
        async fn run(
            &self,
            _request: RuntimeHlaeSessionRequest,
            _progress: RecordingProgressSink,
        ) -> Result<HlaeRecordingSessionResult, RuntimeHlaeSessionError> {
            Err(RuntimeHlaeSessionError::Hlae(
                vibe_cs_hlae::HlaeError::InvalidPlan("capture contract rejected".to_owned()),
            ))
        }
    }

    #[derive(Debug)]
    struct InjectedErrorSessionRunner {
        error: Mutex<Option<RuntimeHlaeSessionError>>,
    }

    impl InjectedErrorSessionRunner {
        fn new(error: RuntimeHlaeSessionError) -> Self {
            Self {
                error: Mutex::new(Some(error)),
            }
        }
    }

    #[async_trait]
    impl HlaeSessionRunner for InjectedErrorSessionRunner {
        async fn run(
            &self,
            _request: RuntimeHlaeSessionRequest,
            _progress: RecordingProgressSink,
        ) -> Result<HlaeRecordingSessionResult, RuntimeHlaeSessionError> {
            Err(self
                .error
                .lock()
                .expect("injected session error")
                .take()
                .expect("injected session error may be consumed only once"))
        }
    }

    #[derive(Debug)]
    struct FakeLaunchEnvironment {
        root: PathBuf,
    }

    impl HlaeLaunchEnvironment for FakeLaunchEnvironment {
        fn resolve(
            &self,
            _config: &AppConfig,
            resolution: LaunchResolution,
        ) -> Result<HlaeBundleLaunchInputs, DomainError> {
            Ok(HlaeBundleLaunchInputs {
                installation: HlaeInstallation {
                    root: self.root.join("hlae"),
                    executable: self.root.join("hlae/HLAE.exe"),
                    source2_hook: self.root.join("hlae/x64/AfxHookSource2.dll"),
                    source: HlaeDiscoverySource::Managed,
                },
                game_executable: self.root.join("cs2.exe"),
                steam_executable: self.root.join("steam.exe"),
                user_config_directory: None,
                resolution,
            })
        }
    }

    #[derive(Debug)]
    struct CountingLaunchEnvironment {
        root: PathBuf,
        resolves: AtomicUsize,
    }

    impl HlaeLaunchEnvironment for CountingLaunchEnvironment {
        fn resolve(
            &self,
            _config: &AppConfig,
            resolution: LaunchResolution,
        ) -> Result<HlaeBundleLaunchInputs, DomainError> {
            self.resolves.fetch_add(1, Ordering::SeqCst);
            Ok(HlaeBundleLaunchInputs {
                installation: HlaeInstallation {
                    root: self.root.join("hlae"),
                    executable: self.root.join("hlae/HLAE.exe"),
                    source2_hook: self.root.join("hlae/x64/AfxHookSource2.dll"),
                    source: HlaeDiscoverySource::Managed,
                },
                game_executable: self.root.join("cs2.exe"),
                steam_executable: self.root.join("steam.exe"),
                user_config_directory: None,
                resolution,
            })
        }
    }

    #[derive(Debug)]
    struct CountingEncoderCapabilityProbe {
        probes: AtomicUsize,
    }

    impl HlaeEncoderCapabilityProbe for CountingEncoderCapabilityProbe {
        fn probe(&self) -> HlaeSequenceEncoderCapabilityReport {
            self.probes.fetch_add(1, Ordering::SeqCst);
            AvailableHlaeEncoderCapabilityProbe.probe()
        }
    }

    async fn record_with_session_error(error: RuntimeHlaeSessionError) -> DomainError {
        let (directory, item) = fixture();
        let backend = HlaeRecordingBackend::with_dependencies(
            directory.path().to_path_buf(),
            Arc::new(InjectedErrorSessionRunner::new(error)),
            Arc::new(FakeLaunchEnvironment {
                root: directory.path().to_path_buf(),
            }),
        );

        backend
            .record_for_test(
                &AppConfig::default(),
                &item,
                &RecordingCancellation::default(),
                &ignored_progress(),
            )
            .await
            .expect_err("injected HLAE session failure must reach the recording boundary")
    }

    #[test]
    fn queue_item_becomes_a_closed_parser_backed_player_pov_plan() {
        let (directory, item) = fixture();
        let job = directory.path().join("job-not-created-yet");

        let plan =
            build_player_pov_plan(&item, &job, capture(), HlaePlayerPovPresentation::default())
                .expect("verified analysis evidence should produce a closed plan");

        assert_eq!(plan.demo_path, item.segment.demo_path);
        assert_eq!(plan.output_directory, job.join("capture"));
        assert_eq!(plan.player_id, "76561197960690195");
        assert_eq!(plan.spectator_slot, 7);
        assert_eq!((plan.start_tick, plan.end_tick), (1_000, 1_320));
        assert_eq!(plan.pre_roll_ticks, 128);
        assert!((plan.tick_rate - 64.0).abs() <= f64::EPSILON);
        assert_eq!(plan.capture, capture());
        assert!(!job.exists());
    }

    fn cinematic_fixture() -> (tempfile::TempDir, PreparedRecording) {
        let (directory, mut item) = fixture();
        item.request.camera_style = HlaeCameraStyle::Crane;
        item.replay_frames = [1_000, 1_106, 1_213, 1_320]
            .into_iter()
            .enumerate()
            .map(|(index, tick)| ReplayFrame {
                tick,
                players: vec![ReplayPlayer {
                    id: item.segment.player_id.clone(),
                    name: "FalleN".to_owned(),
                    team: "T".to_owned(),
                    position: [
                        f64::from(u32::try_from(index).expect("fixture frame index fits u32"))
                            * 16.0,
                        32.0,
                        4.0,
                    ],
                    yaw: 90.0,
                    health: 100,
                    armor: 100,
                    alive: true,
                    weapon: "ak47".to_owned(),
                    input: None,
                }],
                projectiles: Vec::new(),
                bomb: None,
            })
            .collect();
        (directory, item)
    }

    #[test]
    fn cinematic_queue_item_becomes_an_evidence_backed_camera_plan() {
        let (directory, item) = cinematic_fixture();
        let job = directory.path().join("camera-job");

        let plan = build_camera_plan(&item, &job, capture(), HlaePlayerPovPresentation::default())
            .expect("camera plan");

        assert_eq!(plan.mode, HlaePlanMode::Capture);
        assert_eq!(plan.output_directory, job.join("capture"));
        assert_eq!(plan.shots.len(), 1);
        assert_eq!(plan.shots[0].keyframes.len(), 4);
        assert_eq!(plan.shots[0].start_tick, item.segment.start_tick);
        assert_eq!(plan.shots[0].end_tick, item.segment.end_tick);
        assert_ne!(
            plan.shots[0].keyframes[0].position,
            plan.shots[0].keyframes[1].position
        );
    }

    #[test]
    fn a_shot_without_a_presentation_records_with_the_global_defaults() {
        let mut config = AppConfig::default();
        config.recording.show_radar = false;
        config.recording.flash_alpha = 102;
        config.recording.voice = vibe_cs_domain::RecordingVoicePolicy::TargetOnly;
        let fallback = HlaeRecordingBackend::presentation(&config);
        let (_directory, item) = fixture();
        assert_eq!(item.request.presentation, None);

        assert_eq!(take_presentation(fallback, &item.request), fallback);
        assert_eq!(fallback.radar, HlaeRadarVisibility::Hidden);
        assert_eq!(fallback.voice, HlaeVoicePolicy::TargetOnly);
        assert_eq!(fallback.flash_alpha, 102);
    }

    #[test]
    fn every_global_voice_policy_reaches_the_capture_as_itself() {
        // The old test here asserted that two booleans could not both be set.
        // They no longer exist: `RecordingDefaults.voice` is a three-valued
        // enum, so the illegal combination is unrepresentable rather than
        // rejected, and what is worth pinning now is the mapping.
        for (policy, expected) in [
            (
                vibe_cs_domain::RecordingVoicePolicy::AllPlayers,
                HlaeVoicePolicy::AllPlayers,
            ),
            (
                vibe_cs_domain::RecordingVoicePolicy::Muted,
                HlaeVoicePolicy::Muted,
            ),
            (
                vibe_cs_domain::RecordingVoicePolicy::TargetOnly,
                HlaeVoicePolicy::TargetOnly,
            ),
        ] {
            let mut config = AppConfig::default();
            config.recording.voice = policy;
            assert_eq!(HlaeRecordingBackend::presentation(&config).voice, expected);
        }
    }

    #[test]
    fn every_take_of_one_job_resolves_its_own_presentation() {
        let (directory, mut muted) = fixture();
        let fallback = HlaeRecordingBackend::presentation(&AppConfig::default());
        muted.request.presentation = Some(vibe_cs_domain::RecordingPresentation {
            voice: RecordingVoicePolicy::Muted,
            show_hud: false,
            ..vibe_cs_domain::RecordingPresentation::default()
        });
        let mut team_voice = muted.clone();
        team_voice.item_index = 1;
        team_voice.request.presentation = Some(vibe_cs_domain::RecordingPresentation {
            voice: RecordingVoicePolicy::AllPlayers,
            ..vibe_cs_domain::RecordingPresentation::default()
        });

        let first = take_presentation(fallback, &muted.request);
        let second = take_presentation(fallback, &team_voice.request);
        assert_ne!(first, second);
        assert_eq!(first.voice, HlaeVoicePolicy::Muted);
        assert_eq!(first.hud, HlaeHudVisibility::DeathNoticesOnly);
        assert_eq!(second.voice, HlaeVoicePolicy::AllPlayers);
        assert_eq!(second.hud, HlaeHudVisibility::Visible);

        // The two takes of the same job compile into two different programs.
        let first_plan =
            build_player_pov_plan(&muted, &directory.path().join("take-0"), capture(), first)
                .expect("first take");
        let second_plan = build_player_pov_plan(
            &team_voice,
            &directory.path().join("take-1"),
            capture(),
            second,
        )
        .expect("second take");
        assert_ne!(first_plan.presentation, second_plan.presentation);
        assert_eq!(first_plan.presentation.voice, HlaeVoicePolicy::Muted);
        assert_eq!(second_plan.presentation.voice, HlaeVoicePolicy::AllPlayers);
    }

    #[test]
    fn an_observer_take_carries_hud_radar_flash_and_voice_into_its_camera_plan() {
        let (directory, mut item) = cinematic_fixture();
        item.request.presentation = Some(vibe_cs_domain::RecordingPresentation {
            show_hud: false,
            show_radar: false,
            flash_alpha: 102,
            voice: RecordingVoicePolicy::TargetOnly,
            ..vibe_cs_domain::RecordingPresentation::default()
        });
        let fallback = HlaeRecordingBackend::presentation(&AppConfig::default());
        let presentation = take_presentation(fallback, &item.request);

        let plan = build_camera_plan(
            &item,
            &directory.path().join("camera-job"),
            capture(),
            presentation,
        )
        .expect("camera plan");

        assert_eq!(
            plan.presentation,
            HlaeScenePresentation {
                radar: HlaeRadarVisibility::Hidden,
                hud: HlaeHudVisibility::DeathNoticesOnly,
                flash_alpha: 102,
                voice: HlaeVoicePolicy::TargetOnly,
                voice_target_slot: item.segment.spectator_slot,
            }
        );
    }

    #[test]
    fn an_observer_take_never_isolates_a_voice_without_parser_evidence() {
        let (directory, mut item) = cinematic_fixture();
        item.segment.spectator_slot = None;
        item.request.presentation = Some(vibe_cs_domain::RecordingPresentation {
            voice: RecordingVoicePolicy::TargetOnly,
            ..vibe_cs_domain::RecordingPresentation::default()
        });
        let fallback = HlaeRecordingBackend::presentation(&AppConfig::default());
        let presentation = take_presentation(fallback, &item.request);

        let error = build_camera_plan(
            &item,
            &directory.path().join("camera-job"),
            capture(),
            presentation,
        )
        .expect_err("an isolated voice needs the parser-backed spectator slot");

        assert!(matches!(error, DomainError::DependencyUnavailable(_)));
        assert!(error.to_string().contains("reanalyzed"));

        // Every other voice policy still records without that evidence.
        item.request.presentation = Some(vibe_cs_domain::RecordingPresentation {
            voice: RecordingVoicePolicy::Muted,
            ..vibe_cs_domain::RecordingPresentation::default()
        });
        let muted = take_presentation(fallback, &item.request);
        build_camera_plan(
            &item,
            &directory.path().join("camera-job"),
            capture(),
            muted,
        )
        .expect("muting everyone needs no spectator slot");
    }

    #[test]
    fn missing_or_conflicting_parser_evidence_never_guesses_a_spectator_target() {
        let (directory, mut item) = fixture();
        let job = directory.path().join("job");
        item.segment.spectator_slot = None;
        let slot_error =
            build_player_pov_plan(&item, &job, capture(), HlaePlayerPovPresentation::default())
                .expect_err("missing current observer evidence must require reanalysis");
        assert!(slot_error.to_string().contains("reanalyzed"));

        item.segment.spectator_slot = Some(7);
        item.segment.verified_total_ticks = None;
        let ticks_error =
            build_player_pov_plan(&item, &job, capture(), HlaePlayerPovPresentation::default())
                .expect_err("estimated total ticks must not be accepted");
        assert!(ticks_error.to_string().contains("reanalyzed"));
    }

    #[test]
    fn native_encoder_inventory_requires_both_h264_and_aac_before_capture() {
        let report = HlaeSequenceEncoderCapabilityReport {
            status: vibe_cs_platform_windows::HlaeSequenceEncoderProbeStatus::EncoderCandidatesRegistered,
            media_foundation_started: true,
            registered_h264_encoder_count: 1,
            registered_hardware_h264_encoder_count: 0,
            registered_aac_encoder_count: 0,
            end_to_end_mp4_encode_verified: false,
            detail: "test inventory".to_owned(),
        };
        let error = HlaeRecordingBackend::verify_native_encoder_candidates(&report, true)
            .expect_err("capture with game audio must require an AAC encoder");
        assert!(matches!(error, DomainError::DependencyUnavailable(_)));
        assert!(error.to_string().contains("AAC"));

        let video_only = HlaeRecordingBackend::verify_native_encoder_candidates(&report, false);
        assert!(video_only.is_ok());
    }

    #[tokio::test]
    async fn public_backend_returns_only_a_native_verified_mp4_clip() {
        let (directory, item) = fixture();
        let runner = Arc::new(FakeSessionRunner::default());
        let backend = HlaeRecordingBackend::with_dependencies(
            directory.path().to_path_buf(),
            runner.clone(),
            Arc::new(FakeLaunchEnvironment {
                root: directory.path().to_path_buf(),
            }),
        );
        let config = AppConfig::default();

        backend
            .preflight(&config, std::slice::from_ref(&item))
            .await
            .expect("native HLAE preflight");
        let clip = backend
            .record_for_test(
                &config,
                &item,
                &RecordingCancellation::default(),
                &ignored_progress(),
            )
            .await
            .expect("native HLAE recording");

        assert!(Path::new(&clip.path).is_file());
        assert!(clip.path.ends_with("fallen-r20.mp4"));
        assert!((clip.duration_seconds - 5.0).abs() <= f64::EPSILON);
        assert_eq!(clip.metadata["capture_backend"], "managed_hlae_windows_mf");
        assert_eq!(clip.metadata["managed_output_identity"], clip.path.as_str());
        validate_managed_hlae_clip_path(&clip)
            .expect("publication must revalidate managed output containment");
        assert_eq!(clip.metadata["observer_steam_id64"], "76561197960690195");
        assert_eq!(
            clip.metadata["observer_identity_validation"],
            "continuous_bridge_lock_with_start_and_stop_evidence"
        );
        assert_eq!(
            runner.observed.lock().expect("observed request").as_slice(),
            &[("76561197960690195".to_owned(), 7, 4_096, 8)]
        );
    }

    #[tokio::test]
    async fn one_job_resolves_shared_hlae_environment_once_but_records_every_bound_clip() {
        let (directory, first) = fixture();
        let mut second = first.clone();
        second.item_index = 1;
        second.segment.output_file_name = "fallen-r20-second.mp4".to_owned();
        let runner = Arc::new(FakeSessionRunner::default());
        let environment = Arc::new(CountingLaunchEnvironment {
            root: directory.path().to_path_buf(),
            resolves: AtomicUsize::new(0),
        });
        let encoder_probe = Arc::new(CountingEncoderCapabilityProbe {
            probes: AtomicUsize::new(0),
        });
        let mut backend = HlaeRecordingBackend::with_dependencies(
            directory.path().to_path_buf(),
            runner.clone(),
            environment.clone(),
        );
        backend.encoder_capability_probe = encoder_probe.clone();
        let config = AppConfig::default();
        let items = vec![first.clone(), second.clone()];

        backend
            .begin_job(&config, &items)
            .await
            .expect("one immutable job preflight");
        for item in &items {
            let clip = backend
                .record(
                    &config,
                    item,
                    &RecordingCancellation::default(),
                    &ignored_progress(),
                )
                .await
                .expect("independent clip recording");
            backend
                .commit_recorded_clip(item.job_id, item.item_index, &clip)
                .await
                .expect("retire the independent clip lease");
        }
        backend
            .finish_job(first.job_id)
            .await
            .expect("finish immutable job context");

        assert_eq!(environment.resolves.load(Ordering::SeqCst), 1);
        assert_eq!(encoder_probe.probes.load(Ordering::SeqCst), 1);
        assert_eq!(runner.observed.lock().expect("observed requests").len(), 2);
        assert!(backend.job_context(first.job_id).is_err());
    }

    #[tokio::test]
    async fn session_takes_share_one_demo_session_and_advance_only_after_database_ack() {
        let (directory, first) = fixture();
        let mut second = first.clone();
        second.item_index = 1;
        second.request.id = Some(Uuid::new_v4());
        second.request.title = "FalleN R21".to_owned();
        second.request.start_tick = 1_400;
        second.request.end_tick = 1_720;
        second.segment.title = second.request.title.clone();
        second.segment.start_tick = second.request.start_tick;
        second.segment.end_tick = second.request.end_tick;
        second.segment.output_file_name = "fallen-r21.mp4".to_owned();
        let runner = Arc::new(PersistentTracerSessionRunner::default());
        let backend = HlaeRecordingBackend::with_dependencies(
            directory.path().to_path_buf(),
            runner.clone(),
            Arc::new(FakeLaunchEnvironment {
                root: directory.path().to_path_buf(),
            }),
        );
        let config = AppConfig::default();
        let items = vec![first.clone(), second.clone()];

        backend
            .begin_job(&config, &items)
            .await
            .expect("open one shared Demo session");
        for item in &items {
            let clip = backend
                .record(
                    &config,
                    item,
                    &RecordingCancellation::default(),
                    &ignored_progress(),
                )
                .await
                .expect("capture one take in the shared session");
            let lease_path = directory
                .path()
                .join(format!("hlae-leases/{}.json", item.job_id));
            let lease: ManagedHlaeArtifactLeaseDocument =
                serde_json::from_slice(&std::fs::read(&lease_path).expect("published take lease"))
                    .expect("published take lease document");
            assert_eq!(
                lease.state,
                ManagedHlaeArtifactLeaseState::PublishedAwaitingCommit
            );
            backend
                .commit_recorded_clip(item.job_id, item.item_index, &clip)
                .await
                .expect("database acknowledgement advances the session");
            assert!(!lease_path.exists(), "exact take lease retires after ack");
        }
        backend
            .finish_job(first.job_id)
            .await
            .expect("close one shared Demo session");

        let state = runner.state.lock().expect("persistent tracer state");
        assert_eq!(state.acknowledged_takes, 2);
        assert_eq!(state.session_roots.len(), 2);
        assert_eq!(state.session_roots[0], state.session_roots[1]);
        assert_eq!(
            state.events,
            vec![
                PersistentSessionTrace::Opened {
                    job_id: first.job_id,
                    take_count: 2,
                },
                PersistentSessionTrace::DemoLoaded(first.segment.demo_path.clone()),
                PersistentSessionTrace::Seek {
                    take_index: 0,
                    target_tick: 872,
                },
                PersistentSessionTrace::Observer {
                    take_index: 0,
                    steam_id64: first.segment.player_id.clone(),
                },
                PersistentSessionTrace::RawCapture { take_index: 0 },
                PersistentSessionTrace::Mp4Published { take_index: 0 },
                PersistentSessionTrace::DatabaseAck { take_index: 0 },
                PersistentSessionTrace::Seek {
                    take_index: 1,
                    target_tick: 1_272,
                },
                PersistentSessionTrace::Observer {
                    take_index: 1,
                    steam_id64: second.segment.player_id.clone(),
                },
                PersistentSessionTrace::RawCapture { take_index: 1 },
                PersistentSessionTrace::Mp4Published { take_index: 1 },
                PersistentSessionTrace::DatabaseAck { take_index: 1 },
                PersistentSessionTrace::Closed {
                    job_id: first.job_id,
                },
            ]
        );
    }

    #[tokio::test]
    async fn second_take_failure_aborts_shared_session_without_rolling_back_first_take() {
        let (directory, first) = fixture();
        let mut second = first.clone();
        second.item_index = 1;
        second.request.id = Some(Uuid::new_v4());
        second.request.title = "FalleN R21".to_owned();
        second.request.start_tick = 1_400;
        second.request.end_tick = 1_720;
        second.segment.title = second.request.title.clone();
        second.segment.start_tick = second.request.start_tick;
        second.segment.end_tick = second.request.end_tick;
        second.segment.output_file_name = "fallen-r21.mp4".to_owned();
        let runner = Arc::new(PersistentTracerSessionRunner {
            state: Mutex::new(PersistentTracerState::default()),
            fail_take: Some(1),
        });
        let backend = HlaeRecordingBackend::with_dependencies(
            directory.path().to_path_buf(),
            runner.clone(),
            Arc::new(FakeLaunchEnvironment {
                root: directory.path().to_path_buf(),
            }),
        );
        let config = AppConfig::default();
        let items = vec![first.clone(), second.clone()];
        backend
            .begin_job(&config, &items)
            .await
            .expect("shared job");

        let first_clip = backend
            .record(
                &config,
                &first,
                &RecordingCancellation::default(),
                &ignored_progress(),
            )
            .await
            .expect("first take");
        backend
            .commit_recorded_clip(first.job_id, 0, &first_clip)
            .await
            .expect("first take durable ack");
        let error = backend
            .record(
                &config,
                &second,
                &RecordingCancellation::default(),
                &ignored_progress(),
            )
            .await
            .expect_err("second take crashes");
        assert!(error.to_string().contains("HLAE_PROTOCOL_FAILURE"));
        backend
            .finish_job(first.job_id)
            .await
            .expect("idempotent close after abort");

        assert!(
            Path::new(&first_clip.path).is_file(),
            "take1 remains published"
        );
        assert!(
            !directory.path().join("recordings/fallen-r21.mp4").exists(),
            "failed take2 is never published"
        );
        assert!(
            !directory
                .path()
                .join(format!("hlae-leases/{}.json", first.job_id))
                .exists(),
            "failed take2 lease is retired after fail-closed cleanup"
        );
        let state = runner.state.lock().expect("persistent tracer state");
        assert!(
            state
                .events
                .contains(&PersistentSessionTrace::DatabaseAck { take_index: 0 })
        );
        assert!(
            state
                .events
                .contains(&PersistentSessionTrace::TakeFailed { take_index: 1 })
        );
        assert!(state.events.contains(&PersistentSessionTrace::Aborted {
            job_id: first.job_id
        }));
        assert!(
            !state
                .events
                .contains(&PersistentSessionTrace::DatabaseAck { take_index: 1 })
        );
        assert!(!state.events.contains(&PersistentSessionTrace::Closed {
            job_id: first.job_id
        }));
    }

    #[tokio::test]
    async fn duplicate_begin_never_replaces_the_original_immutable_job_binding() {
        let (directory, first) = fixture();
        let backend = HlaeRecordingBackend::with_dependencies(
            directory.path().to_path_buf(),
            Arc::new(FakeSessionRunner::default()),
            Arc::new(FakeLaunchEnvironment {
                root: directory.path().to_path_buf(),
            }),
        );
        let config = AppConfig::default();
        backend
            .begin_job(&config, std::slice::from_ref(&first))
            .await
            .expect("first immutable binding");
        let mut changed = first.clone();
        changed.segment.title = "changed after first begin".to_owned();

        let error = backend
            .begin_job(&config, std::slice::from_ref(&changed))
            .await
            .expect_err("duplicate begin must not replace the first binding");

        assert!(matches!(error, DomainError::Conflict(_)));
        assert_eq!(
            backend
                .job_context(first.job_id)
                .expect("original context remains")
                .clips[0]
                .binding,
            first
        );
        backend
            .finish_job(first.job_id)
            .await
            .expect("release original context");
    }

    #[tokio::test]
    async fn published_native_clip_keeps_its_exact_lease_until_database_commit() {
        let (directory, item) = fixture();
        let backend = HlaeRecordingBackend::with_dependencies(
            directory.path().to_path_buf(),
            Arc::new(FakeSessionRunner::default()),
            Arc::new(FakeLaunchEnvironment {
                root: directory.path().to_path_buf(),
            }),
        );

        let clip = backend
            .record_for_test(
                &AppConfig::default(),
                &item,
                &RecordingCancellation::default(),
                &ignored_progress(),
            )
            .await
            .expect("verified native clip");

        assert!(Path::new(&clip.path).is_file());
        assert!(
            directory
                .path()
                .join(format!("hlae-leases/{}.json", item.job_id))
                .is_file(),
            "publication must remain leased until RecordedClip is durable"
        );
        let lease_path = directory
            .path()
            .join(format!("hlae-leases/{}.json", item.job_id));
        let lease: ManagedHlaeArtifactLeaseDocument =
            serde_json::from_slice(&std::fs::read(lease_path).expect("published lease bytes"))
                .expect("published lease document");
        let lease_json = serde_json::to_value(&lease).expect("current lease JSON");
        let mut invalid_lease = lease_json;
        invalid_lease
            .as_object_mut()
            .expect("lease object")
            .insert("unexpected".to_owned(), serde_json::json!(true));
        assert!(serde_json::from_value::<ManagedHlaeArtifactLeaseDocument>(invalid_lease).is_err());
        assert_eq!(
            lease.state,
            ManagedHlaeArtifactLeaseState::PublishedAwaitingCommit
        );
        assert_eq!(lease.recorded_clip.as_ref(), Some(&clip));
        assert_eq!(lease.final_output_bytes, Some(19));
        assert_eq!(
            lease.final_output_sha256,
            Some(hex::encode(sha2::Sha256::digest(b"verified-native-mp4")))
        );

        let recovery = backend
            .recover_orphaned_job(&orphaned_recording_job(&item))
            .await
            .expect("recover exact verified publication");
        assert_eq!(
            recovery,
            OrphanedRecordingRecovery::PublishedClip {
                item_index: item.item_index,
                clip: Box::new(clip.clone()),
            }
        );
        assert!(
            directory
                .path()
                .join(format!("hlae-leases/{}.json", item.job_id))
                .is_file(),
            "recovery must retain evidence until storage commit"
        );

        backend
            .commit_recorded_clip(item.job_id, item.item_index, &clip)
            .await
            .expect("retire exact lease after durable storage commit");
        assert!(
            !directory
                .path()
                .join(format!("hlae-leases/{}.json", item.job_id))
                .exists()
        );
        assert!(Path::new(&clip.path).is_file());
    }

    #[tokio::test]
    async fn published_clip_recovery_rejects_changed_final_and_retains_exact_evidence() {
        let (directory, item) = fixture();
        let backend = HlaeRecordingBackend::with_dependencies(
            directory.path().to_path_buf(),
            Arc::new(FakeSessionRunner::default()),
            Arc::new(FakeLaunchEnvironment {
                root: directory.path().to_path_buf(),
            }),
        );
        let clip = backend
            .record_for_test(
                &AppConfig::default(),
                &item,
                &RecordingCancellation::default(),
                &ignored_progress(),
            )
            .await
            .expect("verified native clip");
        std::fs::write(&clip.path, b"changed-after-publication").expect("tamper final output");

        let error = backend
            .recover_orphaned_job(&orphaned_recording_job(&item))
            .await
            .expect_err("changed publication must fail closed");

        assert!(matches!(error, DomainError::CleanupFailed(_)));
        assert!(
            error
                .to_string()
                .contains("HLAE_PUBLISHED_CLIP_RECOVERY_FAILED")
        );
        assert!(Path::new(&clip.path).is_file());
        assert!(
            directory
                .path()
                .join(format!("hlae-leases/{}.json", item.job_id))
                .is_file()
        );
    }

    #[tokio::test]
    async fn storage_commit_rejects_same_length_output_mutation_and_retains_exact_lease() {
        let (directory, item) = fixture();
        let backend = HlaeRecordingBackend::with_dependencies(
            directory.path().to_path_buf(),
            Arc::new(FakeSessionRunner::default()),
            Arc::new(FakeLaunchEnvironment {
                root: directory.path().to_path_buf(),
            }),
        );
        let clip = backend
            .record_for_test(
                &AppConfig::default(),
                &item,
                &RecordingCancellation::default(),
                &ignored_progress(),
            )
            .await
            .expect("verified native clip");
        assert_eq!(b"tampered-native-mp4".len(), b"verified-native-mp4".len());
        std::fs::write(&clip.path, b"tampered-native-mp4").expect("same-length final mutation");

        let error = backend
            .commit_recorded_clip(item.job_id, item.item_index, &clip)
            .await
            .expect_err("same-length mutation must not retire publication evidence");

        assert!(matches!(error, DomainError::CleanupFailed(_)));
        assert!(
            error
                .to_string()
                .contains("HLAE_PUBLISHED_CLIP_COMMIT_FAILED")
        );
        assert!(
            directory
                .path()
                .join(format!("hlae-leases/{}.json", item.job_id))
                .is_file()
        );
        assert_eq!(
            std::fs::read(&clip.path).expect("mutated final remains for diagnosis"),
            b"tampered-native-mp4"
        );
    }

    #[tokio::test]
    async fn cancellation_after_native_publish_removes_the_unpublished_mp4() {
        let (directory, item) = fixture();
        let runner = Arc::new(CancellationAfterPublishRunner::default());
        let backend = HlaeRecordingBackend::with_dependencies(
            directory.path().to_path_buf(),
            runner.clone(),
            Arc::new(FakeLaunchEnvironment {
                root: directory.path().to_path_buf(),
            }),
        );
        let cancellation = RecordingCancellation::default();
        let config = AppConfig::default();
        let progress = ignored_progress();
        let running = backend.record_for_test(&config, &item, &cancellation, &progress);
        tokio::pin!(running);

        tokio::select! {
            () = runner.published.notified() => {}
            result = &mut running => panic!("recording finished before cancellation: {result:?}"),
        }
        cancellation.cancel();
        let error = running
            .await
            .expect_err("cancelled output must never become a recorded clip");

        assert!(matches!(error, DomainError::Conflict(_)));
        assert!(!directory.path().join("recordings/fallen-r20.mp4").exists());
    }

    #[tokio::test]
    async fn cancellation_drops_an_uncooperative_runner_after_a_bounded_grace() {
        let (directory, item) = fixture();
        let runner = Arc::new(CancellationIgnoringRunner::default());
        let backend = HlaeRecordingBackend::with_dependencies(
            directory.path().to_path_buf(),
            runner.clone(),
            Arc::new(FakeLaunchEnvironment {
                root: directory.path().to_path_buf(),
            }),
        )
        .with_cancellation_grace(std::time::Duration::from_millis(10));
        let cancellation = RecordingCancellation::default();
        let config = AppConfig::default();
        let progress = ignored_progress();
        let running = backend.record_for_test(&config, &item, &cancellation, &progress);
        tokio::pin!(running);

        tokio::select! {
            () = runner.published.notified() => {}
            result = &mut running => panic!("recording finished before cancellation: {result:?}"),
        }
        let cancelled_at = tokio::time::Instant::now();
        cancellation.cancel();
        let error = tokio::time::timeout(std::time::Duration::from_secs(1), running)
            .await
            .expect("backend cancellation must settle inside its bounded runner grace")
            .expect_err("uncooperative runner cannot publish a clip");

        assert!(matches!(error, DomainError::CleanupFailed(_)));
        assert!(error.to_string().contains("session runner"));
        assert!(cancelled_at.elapsed() < std::time::Duration::from_secs(1));
        assert!(!directory.path().join("recordings/fallen-r20.mp4").exists());
        assert!(
            !directory
                .path()
                .join(format!("hlae-leases/{}.json", item.job_id))
                .exists(),
            "completed timeout cleanup must retire the exact lease"
        );
    }

    #[tokio::test]
    async fn invalid_hlae_capture_contract_is_reported_as_user_input() {
        let (directory, item) = fixture();
        let backend = HlaeRecordingBackend::with_dependencies(
            directory.path().to_path_buf(),
            Arc::new(InvalidPlanSessionRunner),
            Arc::new(FakeLaunchEnvironment {
                root: directory.path().to_path_buf(),
            }),
        );

        let error = backend
            .record_for_test(
                &AppConfig::default(),
                &item,
                &RecordingCancellation::default(),
                &ignored_progress(),
            )
            .await
            .expect_err("invalid capture contract must not become an internal error");

        assert!(matches!(error, DomainError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn invalid_hlae_protocol_contract_is_reported_as_user_input() {
        let error = record_with_session_error(RuntimeHlaeSessionError::Protocol(
            vibe_cs_hlae::HlaeSessionProtocolError::InvalidTickContract,
        ))
        .await;

        assert!(matches!(error, DomainError::InvalidInput(_)));
        assert!(
            error
                .to_string()
                .contains("capture tick contract is invalid")
        );
    }

    #[tokio::test]
    async fn hlae_protocol_failure_has_a_stable_diagnostic() {
        let error = record_with_session_error(RuntimeHlaeSessionError::Protocol(
            vibe_cs_hlae::HlaeSessionProtocolError::SequenceMismatch {
                expected: 1,
                actual: 2,
            },
        ))
        .await;

        assert!(matches!(error, DomainError::Internal(_)));
        assert!(error.to_string().contains("[HLAE_PROTOCOL_FAILURE]"));
        assert!(error.to_string().contains("expected bridge sequence"));
    }

    #[tokio::test]
    async fn hlae_protocol_timeout_has_a_stable_diagnostic() {
        let error = record_with_session_error(RuntimeHlaeSessionError::ProtocolTimedOut).await;

        assert!(matches!(error, DomainError::Internal(_)));
        assert!(error.to_string().contains("[HLAE_PROTOCOL_TIMEOUT]"));
        assert!(error.to_string().contains("absolute deadline"));
    }

    #[tokio::test]
    async fn failed_hlae_loader_process_has_a_stable_actionable_diagnostic() {
        let error = record_with_session_error(RuntimeHlaeSessionError::LoaderExited {
            exit_code: -1_073_741_515,
        })
        .await;

        assert!(matches!(error, DomainError::DependencyUnavailable(_)));
        assert!(error.to_string().contains("[HLAE_LOADER_EXITED]"));
        assert!(error.to_string().contains("-1073741515"));
        assert!(error.to_string().contains("managed movie engine"));
    }

    #[tokio::test]
    async fn insufficient_hlae_staging_space_is_reported_as_an_unavailable_dependency() {
        let error = record_with_session_error(RuntimeHlaeSessionError::DiskSpace(
            vibe_cs_platform_windows::HlaeDiskSpacePreflightError::Insufficient {
                available_bytes: 512,
                required_bytes: 1_024,
            },
        ))
        .await;

        assert!(matches!(error, DomainError::DependencyUnavailable(_)));
        assert!(error.to_string().contains("512 bytes available"));
        assert!(error.to_string().contains("1024 bytes required"));
    }

    #[tokio::test]
    async fn unavailable_hlae_staging_directory_is_reported_as_an_unavailable_dependency() {
        let error = record_with_session_error(RuntimeHlaeSessionError::DiskSpace(
            vibe_cs_platform_windows::HlaeDiskSpacePreflightError::DirectoryUnavailable {
                path: PathBuf::from(r"C:\missing-hlae-staging"),
                source: std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "staging volume is unavailable",
                ),
            },
        ))
        .await;

        assert!(matches!(error, DomainError::DependencyUnavailable(_)));
        assert!(error.to_string().contains("missing-hlae-staging"));
        assert!(error.to_string().contains("staging volume is unavailable"));
    }

    #[tokio::test]
    async fn invalid_hlae_staging_contract_is_reported_as_user_input() {
        let error = record_with_session_error(RuntimeHlaeSessionError::DiskSpace(
            vibe_cs_platform_windows::HlaeDiskSpacePreflightError::InvalidRequest(
                "staging byte count must be positive".to_owned(),
            ),
        ))
        .await;

        assert!(matches!(error, DomainError::InvalidInput(_)));
        assert!(
            error
                .to_string()
                .contains("staging byte count must be positive")
        );
    }

    #[tokio::test]
    async fn invalid_native_encoder_contract_is_reported_as_user_input() {
        let error = record_with_session_error(RuntimeHlaeSessionError::Encode(
            HlaeTakeMp4EncodeError::Platform(
                vibe_cs_platform_windows::PlatformError::InvalidInput(
                    "validated take has no audio stream".to_owned(),
                ),
            ),
        ))
        .await;

        assert!(matches!(error, DomainError::InvalidInput(_)));
        assert!(
            error
                .to_string()
                .contains("validated take has no audio stream")
        );
    }

    #[tokio::test]
    async fn invalid_take_stability_contract_is_reported_as_user_input() {
        let error = record_with_session_error(RuntimeHlaeSessionError::Stability(
            HlaeTakeStabilityError::InvalidPolicy(
                "unchanged poll count must be positive".to_owned(),
            ),
        ))
        .await;

        assert!(matches!(error, DomainError::InvalidInput(_)));
        assert!(
            error
                .to_string()
                .contains("unchanged poll count must be positive")
        );
    }

    #[tokio::test]
    async fn hlae_take_stability_timeout_has_a_stable_diagnostic() {
        let error = record_with_session_error(RuntimeHlaeSessionError::Stability(
            HlaeTakeStabilityError::TimedOut {
                timeout: std::time::Duration::from_secs(30),
            },
        ))
        .await;

        assert!(matches!(error, DomainError::Internal(_)));
        assert!(error.to_string().contains("[HLAE_TAKE_TIMEOUT]"));
        assert!(error.to_string().contains("30s"));
    }

    #[tokio::test]
    async fn cancelled_hlae_take_stability_is_reported_as_cancellation() {
        let error = record_with_session_error(RuntimeHlaeSessionError::Stability(
            HlaeTakeStabilityError::Cancelled,
        ))
        .await;

        assert!(matches!(error, DomainError::Conflict(_)));
        assert!(error.to_string().contains("recording was cancelled"));
    }

    #[tokio::test]
    async fn invalid_windows_launch_contract_is_reported_as_user_input() {
        let error = record_with_session_error(RuntimeHlaeSessionError::Platform(
            vibe_cs_platform_windows::PlatformError::InvalidInput(
                "game process identifier must be non-zero".to_owned(),
            ),
        ))
        .await;

        assert!(matches!(error, DomainError::InvalidInput(_)));
        assert!(
            error
                .to_string()
                .contains("game process identifier must be non-zero")
        );
    }

    #[tokio::test]
    async fn missing_managed_game_process_is_reported_as_an_unavailable_dependency() {
        let error = record_with_session_error(RuntimeHlaeSessionError::Platform(
            vibe_cs_platform_windows::PlatformError::ProcessNotFound(
                "managed CS2 process".to_owned(),
            ),
        ))
        .await;

        assert!(matches!(error, DomainError::DependencyUnavailable(_)));
        assert!(error.to_string().contains("managed CS2 process"));
    }

    #[tokio::test]
    async fn unavailable_windows_media_foundation_is_reported_as_an_unavailable_dependency() {
        let error = record_with_session_error(RuntimeHlaeSessionError::Encode(
            HlaeTakeMp4EncodeError::Platform(vibe_cs_platform_windows::PlatformError::Unsupported),
        ))
        .await;

        assert!(matches!(error, DomainError::DependencyUnavailable(_)));
        assert!(
            error
                .to_string()
                .contains("Windows platform capability is unsupported")
        );
    }

    #[tokio::test]
    async fn hlae_bridge_timeout_has_a_stable_diagnostic() {
        let error = record_with_session_error(RuntimeHlaeSessionError::Bridge(
            RuntimeHlaeBridgeError::Timeout {
                operation: "accept",
            },
        ))
        .await;

        assert!(matches!(error, DomainError::Internal(_)));
        assert!(error.to_string().contains("[HLAE_BRIDGE_TIMEOUT]"));
        assert!(error.to_string().contains("accept"));
    }

    #[tokio::test]
    async fn hlae_bridge_failure_has_a_stable_diagnostic() {
        let error = record_with_session_error(RuntimeHlaeSessionError::Bridge(
            RuntimeHlaeBridgeError::Closed,
        ))
        .await;

        assert!(matches!(error, DomainError::Internal(_)));
        assert!(error.to_string().contains("[HLAE_BRIDGE_FAILURE]"));
        assert!(error.to_string().contains("connection closed"));
    }

    #[tokio::test]
    async fn hlae_cleanup_failure_keeps_cleanup_severity_and_both_causes() {
        let error = record_with_session_error(RuntimeHlaeSessionError::Cleanup {
            primary: "bridge disconnected".to_owned(),
            cleanup: "managed process tree remained alive".to_owned(),
        })
        .await;

        assert!(matches!(error, DomainError::CleanupFailed(_)));
        assert!(error.to_string().contains("[HLAE_CLEANUP_FAILURE]"));
        assert!(error.to_string().contains("bridge disconnected"));
        assert!(
            error
                .to_string()
                .contains("managed process tree remained alive")
        );
    }

    #[tokio::test]
    async fn invalid_hlae_bridge_contract_is_reported_as_user_input() {
        let error = record_with_session_error(RuntimeHlaeSessionError::Bridge(
            RuntimeHlaeBridgeError::Platform(
                vibe_cs_platform_windows::PlatformError::InvalidInput(
                    "bridge endpoint is outside the contract".to_owned(),
                ),
            ),
        ))
        .await;

        assert!(matches!(error, DomainError::InvalidInput(_)));
        assert!(
            error
                .to_string()
                .contains("bridge endpoint is outside the contract")
        );
    }

    #[tokio::test]
    async fn changed_demo_after_native_capture_removes_the_unpublished_mp4() {
        #[derive(Debug)]
        struct ReplacingDemoRunner;

        #[async_trait]
        impl HlaeSessionRunner for ReplacingDemoRunner {
            async fn run(
                &self,
                request: RuntimeHlaeSessionRequest,
                _progress: RecordingProgressSink,
            ) -> Result<HlaeRecordingSessionResult, RuntimeHlaeSessionError> {
                let demo_path = match &request.capture_program {
                    RuntimeHlaeCaptureProgram::PlayerPov(plan) => plan.demo_path.clone(),
                    RuntimeHlaeCaptureProgram::Camera(_) => unreachable!("player POV fixture"),
                };
                std::fs::write(&request.output_mp4, b"verified-native-mp4")
                    .expect("fake native output");
                std::fs::write(demo_path, b"changed while recording")
                    .expect("replace Demo during capture");
                Ok(HlaeRecordingSessionResult {
                    output_path: request.output_mp4,
                    output_bytes: 19,
                    frame_count: 300,
                    duration_100ns: 50_000_000,
                    manifest_path: request
                        .managed_job_root
                        .join("vibe_cs_session_manifest.json"),
                    loader_process_id: 100,
                    game_process_id: 200,
                    observed_start_tick: 1_001,
                    observed_end_tick: 1_321,
                    observer_steam_id64: Some(76_561_197_960_690_195),
                    observer_mode_raw: Some(2),
                    observer_verified_before_capture_tick: Some(1_000),
                    observer_verified_at_capture_stop_tick: Some(1_321),
                    audio_stream_included: true,
                })
            }
        }

        let (directory, mut item) = fixture();
        item.demo.content_sha256 = Some(hex::encode(sha2::Sha256::digest(b"PBDEMS2 fixture")));
        let backend = HlaeRecordingBackend::with_dependencies(
            directory.path().to_path_buf(),
            Arc::new(ReplacingDemoRunner),
            Arc::new(FakeLaunchEnvironment {
                root: directory.path().to_path_buf(),
            }),
        );
        let error = backend
            .record_for_test(
                &AppConfig::default(),
                &item,
                &RecordingCancellation::default(),
                &ignored_progress(),
            )
            .await
            .expect_err("changed source Demo must prevent MP4 publication");

        assert!(matches!(error, DomainError::Conflict(_)));
        assert!(!directory.path().join("recordings/fallen-r20.mp4").exists());
    }

    #[tokio::test]
    async fn untrusted_runner_output_path_never_publishes_or_deletes_an_external_file() {
        #[derive(Debug)]
        struct ExternalPathRunner {
            victim: PathBuf,
        }

        #[async_trait]
        impl HlaeSessionRunner for ExternalPathRunner {
            async fn run(
                &self,
                request: RuntimeHlaeSessionRequest,
                _progress: RecordingProgressSink,
            ) -> Result<HlaeRecordingSessionResult, RuntimeHlaeSessionError> {
                std::fs::write(&request.output_mp4, b"unpublished-native-mp4")
                    .expect("fake expected output");
                Ok(HlaeRecordingSessionResult {
                    output_path: self.victim.clone(),
                    output_bytes: 22,
                    frame_count: 300,
                    duration_100ns: 50_000_000,
                    manifest_path: request
                        .managed_job_root
                        .join("vibe_cs_session_manifest.json"),
                    loader_process_id: 100,
                    game_process_id: 200,
                    observed_start_tick: 1_001,
                    observed_end_tick: 1_321,
                    observer_steam_id64: Some(76_561_197_960_690_195),
                    observer_mode_raw: Some(2),
                    observer_verified_before_capture_tick: Some(1_000),
                    observer_verified_at_capture_stop_tick: Some(1_321),
                    audio_stream_included: true,
                })
            }
        }

        let (directory, item) = fixture();
        let victim_directory = tempfile::tempdir().expect("external victim directory");
        let victim = victim_directory.path().join("do-not-delete.mp4");
        std::fs::write(&victim, b"external-user-file").expect("external victim fixture");
        let backend = HlaeRecordingBackend::with_dependencies(
            directory.path().to_path_buf(),
            Arc::new(ExternalPathRunner {
                victim: victim.clone(),
            }),
            Arc::new(FakeLaunchEnvironment {
                root: directory.path().to_path_buf(),
            }),
        );

        let error = backend
            .record_for_test(
                &AppConfig::default(),
                &item,
                &RecordingCancellation::default(),
                &ignored_progress(),
            )
            .await
            .expect_err("runner output outside the managed root must be rejected");

        assert!(matches!(error, DomainError::Internal(_)));
        assert_eq!(
            std::fs::read(&victim).expect("external victim must survive"),
            b"external-user-file"
        );
        assert!(!directory.path().join("recordings/fallen-r20.mp4").exists());
    }

    #[tokio::test]
    async fn failed_session_removes_only_its_validated_expected_output() {
        #[derive(Debug)]
        struct FailingAfterPublishRunner;

        #[async_trait]
        impl HlaeSessionRunner for FailingAfterPublishRunner {
            async fn run(
                &self,
                request: RuntimeHlaeSessionRequest,
                _progress: RecordingProgressSink,
            ) -> Result<HlaeRecordingSessionResult, RuntimeHlaeSessionError> {
                std::fs::write(&request.output_mp4, b"unpublished-native-mp4")
                    .expect("fake expected output");
                Err(RuntimeHlaeSessionError::Hlae(
                    vibe_cs_hlae::HlaeError::InvalidPlan("fixture failure".to_owned()),
                ))
            }
        }

        let (directory, item) = fixture();
        let backend = HlaeRecordingBackend::with_dependencies(
            directory.path().to_path_buf(),
            Arc::new(FailingAfterPublishRunner),
            Arc::new(FakeLaunchEnvironment {
                root: directory.path().to_path_buf(),
            }),
        );

        let error = backend
            .record_for_test(
                &AppConfig::default(),
                &item,
                &RecordingCancellation::default(),
                &ignored_progress(),
            )
            .await
            .expect_err("failed sessions must not leave unpublished output");

        assert!(matches!(error, DomainError::InvalidInput(_)));
        assert!(!directory.path().join("recordings/fallen-r20.mp4").exists());
    }

    #[tokio::test]
    async fn cleanup_failure_is_reported_together_with_the_primary_output_error() {
        #[derive(Debug)]
        struct DirectoryOutputRunner;

        #[async_trait]
        impl HlaeSessionRunner for DirectoryOutputRunner {
            async fn run(
                &self,
                request: RuntimeHlaeSessionRequest,
                _progress: RecordingProgressSink,
            ) -> Result<HlaeRecordingSessionResult, RuntimeHlaeSessionError> {
                std::fs::create_dir(&request.output_mp4).expect("invalid directory output");
                Ok(HlaeRecordingSessionResult {
                    output_path: request.output_mp4,
                    output_bytes: 0,
                    frame_count: 0,
                    duration_100ns: 0,
                    manifest_path: request
                        .managed_job_root
                        .join("vibe_cs_session_manifest.json"),
                    loader_process_id: 100,
                    game_process_id: 200,
                    observed_start_tick: 1_001,
                    observed_end_tick: 1_321,
                    observer_steam_id64: Some(76_561_197_960_690_195),
                    observer_mode_raw: Some(2),
                    observer_verified_before_capture_tick: Some(1_000),
                    observer_verified_at_capture_stop_tick: Some(1_321),
                    audio_stream_included: false,
                })
            }
        }

        let (directory, item) = fixture();
        let backend = HlaeRecordingBackend::with_dependencies(
            directory.path().to_path_buf(),
            Arc::new(DirectoryOutputRunner),
            Arc::new(FakeLaunchEnvironment {
                root: directory.path().to_path_buf(),
            }),
        );

        let error = backend
            .record_for_test(
                &AppConfig::default(),
                &item,
                &RecordingCancellation::default(),
                &ignored_progress(),
            )
            .await
            .expect_err("invalid output and failed cleanup must both be reported");

        assert!(matches!(error, DomainError::CleanupFailed(_)));
        assert!(error.to_string().contains("cleanup also failed"));
    }

    #[tokio::test]
    async fn trusted_orphan_lease_removes_only_bound_raw_and_partial_artifacts() {
        let (directory, item) = fixture();
        let backend = HlaeRecordingBackend::with_dependencies(
            directory.path().to_path_buf(),
            Arc::new(FakeSessionRunner::default()),
            Arc::new(FakeLaunchEnvironment {
                root: directory.path().to_path_buf(),
            }),
        );
        let roots = backend.ensure_managed_roots().await.expect("managed roots");
        let final_output = roots
            .expected_output(&item.segment.output_file_name)
            .expect("managed final output");
        let lease =
            create_managed_hlae_artifact_lease(&roots, item.job_id, item.item_index, &final_output)
                .expect("durable artifact lease");
        std::fs::create_dir(&lease.job_root).expect("job root");
        std::fs::create_dir(&lease.capture_root).expect("capture root");
        let take = lease.capture_root.join("take0000");
        std::fs::create_dir(&take).expect("take root");
        std::fs::write(take.join("00000.tga"), b"raw-frame").expect("raw frame");
        std::fs::write(take.join("audio.wav"), b"raw-audio").expect("raw audio");
        std::fs::write(&lease.staged_output_mp4, b"staged").expect("staged MP4");
        std::fs::write(&lease.partial_output_mp4, b"partial").expect("partial MP4");
        std::fs::write(&final_output, b"published-final").expect("final output evidence");
        let unrelated = roots.recordings.join("unrelated.mp4");
        std::fs::write(&unrelated, b"unrelated").expect("unrelated output");

        backend
            .recover_orphaned_job(&orphaned_recording_job(&item))
            .await
            .expect("trusted orphan cleanup through recording backend");

        assert!(!lease.capture_root.exists());
        assert!(!lease.staged_output_mp4.exists());
        assert!(!lease.partial_output_mp4.exists());
        assert!(!lease.lease_path.exists());
        assert_eq!(
            std::fs::read(final_output).expect("final survives"),
            b"published-final"
        );
        assert_eq!(
            std::fs::read(unrelated).expect("unrelated survives"),
            b"unrelated"
        );
    }

    #[tokio::test]
    async fn tampered_orphan_lease_never_deletes_an_external_partial_path() {
        let (directory, item) = fixture();
        let backend = HlaeRecordingBackend::with_dependencies(
            directory.path().to_path_buf(),
            Arc::new(FakeSessionRunner::default()),
            Arc::new(FakeLaunchEnvironment {
                root: directory.path().to_path_buf(),
            }),
        );
        let roots = backend.ensure_managed_roots().await.expect("managed roots");
        let final_output = roots
            .expected_output(&item.segment.output_file_name)
            .expect("managed final output");
        let lease =
            create_managed_hlae_artifact_lease(&roots, item.job_id, item.item_index, &final_output)
                .expect("durable artifact lease");
        let victim_directory = tempfile::tempdir().expect("external victim root");
        let victim = victim_directory.path().join("external.partial.mp4");
        std::fs::write(&victim, b"external-user-file").expect("external victim");
        let bytes = std::fs::read(&lease.lease_path).expect("read trusted lease");
        let mut document: ManagedHlaeArtifactLeaseDocument =
            serde_json::from_slice(&bytes).expect("decode trusted lease");
        document.partial_output_mp4 = victim.clone();
        std::fs::remove_file(&lease.lease_path).expect("replace lease fixture");
        let bytes = serde_json::to_vec(&document).expect("encode tampered lease");
        std::fs::write(&lease.lease_path, bytes).expect("tampered lease fixture");

        let error = backend
            .recover_orphaned_job(&orphaned_recording_job(&item))
            .await
            .expect_err("tampered lease must fail closed");

        assert!(matches!(error, DomainError::Internal(_)));
        assert_eq!(
            std::fs::read(&victim).expect("external victim survives"),
            b"external-user-file"
        );
        assert!(lease.lease_path.is_file(), "recovery evidence must remain");
    }

    #[tokio::test]
    async fn orphan_recovery_without_an_exact_lease_never_scans_managed_jobs() {
        let (directory, item) = fixture();
        let backend = HlaeRecordingBackend::with_dependencies(
            directory.path().to_path_buf(),
            Arc::new(FakeSessionRunner::default()),
            Arc::new(FakeLaunchEnvironment {
                root: directory.path().to_path_buf(),
            }),
        );
        let roots = backend.ensure_managed_roots().await.expect("managed roots");
        let unleased_job = roots.jobs.join("capture-unleased");
        let take = unleased_job.join("capture/take0000");
        std::fs::create_dir_all(&take).expect("unleased capture tree");
        let raw = take.join("00000.tga");
        std::fs::write(&raw, b"unleased-raw").expect("unleased raw frame");

        recover_managed_hlae_artifacts(&roots, item.job_id, Some(item.item_index), None)
            .expect("missing lease is a safe no-op");

        assert_eq!(
            std::fs::read(raw).expect("unleased artifact survives"),
            b"unleased-raw"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn managed_recordings_root_symlink_is_rejected_before_use() {
        use std::os::unix::fs::symlink;

        let (directory, _item) = fixture();
        let external = tempfile::tempdir().expect("external recordings directory");
        symlink(
            external.path(),
            directory.path().join(RECORDED_CLIP_DIRECTORY),
        )
        .expect("recordings symlink fixture");
        let backend = HlaeRecordingBackend::with_dependencies(
            directory.path().to_path_buf(),
            Arc::new(FakeSessionRunner::default()),
            Arc::new(FakeLaunchEnvironment {
                root: directory.path().to_path_buf(),
            }),
        );

        let error = backend
            .ensure_managed_roots()
            .await
            .expect_err("managed root symlinks must fail closed");

        assert!(matches!(error, DomainError::Internal(_)));
        assert!(error.to_string().contains("non-link"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn recording_data_root_symlink_is_rejected_before_use() {
        use std::os::unix::fs::symlink;

        let parent = tempfile::tempdir().expect("data root parent");
        let external = tempfile::tempdir().expect("external data directory");
        let linked_data = parent.path().join("linked-data");
        symlink(external.path(), &linked_data).expect("data root symlink fixture");
        let backend = HlaeRecordingBackend::with_dependencies(
            linked_data,
            Arc::new(FakeSessionRunner::default()),
            Arc::new(FakeLaunchEnvironment {
                root: parent.path().to_path_buf(),
            }),
        );

        let error = backend
            .ensure_managed_roots()
            .await
            .expect_err("data root symlinks must fail closed");

        assert!(matches!(error, DomainError::Internal(_)));
        assert!(error.to_string().contains("non-link"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn managed_child_root_junctions_are_rejected_before_use() {
        for child_name in [
            MANAGED_HLAE_JOB_DIRECTORY,
            MANAGED_HLAE_LEASE_DIRECTORY,
            RECORDED_CLIP_DIRECTORY,
        ] {
            let (directory, _item) = fixture();
            let external = tempfile::tempdir().expect("external managed directory");
            let sentinel = external.path().join("sentinel.txt");
            std::fs::write(&sentinel, b"external").expect("external sentinel");
            let junction = directory.path().join(child_name);
            let status = std::process::Command::new("cmd")
                .args([
                    "/d",
                    "/c",
                    "mklink",
                    "/J",
                    &junction.to_string_lossy(),
                    &external.path().to_string_lossy(),
                ])
                .status()
                .expect("invoke mklink");
            if !status.success() {
                // Some locked-down Windows runners prohibit creating junctions.
                // Production validation still checks FILE_ATTRIBUTE_REPARSE_POINT.
                return;
            }
            let backend = HlaeRecordingBackend::with_dependencies(
                directory.path().to_path_buf(),
                Arc::new(FakeSessionRunner::default()),
                Arc::new(FakeLaunchEnvironment {
                    root: directory.path().to_path_buf(),
                }),
            );

            let error = backend
                .ensure_managed_roots()
                .await
                .expect_err("managed root junctions must fail closed");

            assert!(matches!(error, DomainError::Internal(_)));
            assert!(error.to_string().contains("non-link"));
            assert_eq!(
                std::fs::read(&sentinel).expect("external sentinel survives"),
                b"external"
            );
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn recording_data_root_junction_is_rejected_before_use() {
        let parent = tempfile::tempdir().expect("data root parent");
        let external = tempfile::tempdir().expect("external data directory");
        let linked_data = parent.path().join("linked-data");
        let status = std::process::Command::new("cmd")
            .args([
                "/d",
                "/c",
                "mklink",
                "/J",
                &linked_data.to_string_lossy(),
                &external.path().to_string_lossy(),
            ])
            .status()
            .expect("invoke mklink");
        if !status.success() {
            return;
        }
        let backend = HlaeRecordingBackend::with_dependencies(
            linked_data,
            Arc::new(FakeSessionRunner::default()),
            Arc::new(FakeLaunchEnvironment {
                root: parent.path().to_path_buf(),
            }),
        );

        let error = backend
            .ensure_managed_roots()
            .await
            .expect_err("data root junctions must fail closed");

        assert!(matches!(error, DomainError::Internal(_)));
        assert!(error.to_string().contains("non-link"));
        assert!(!external.path().join(MANAGED_HLAE_JOB_DIRECTORY).exists());
        assert!(!external.path().join(MANAGED_HLAE_LEASE_DIRECTORY).exists());
        assert!(!external.path().join(RECORDED_CLIP_DIRECTORY).exists());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn cleanup_refuses_a_swapped_recordings_root_and_preserves_the_external_victim() {
        let (directory, item) = fixture();
        let backend = HlaeRecordingBackend::with_dependencies(
            directory.path().to_path_buf(),
            Arc::new(FakeSessionRunner::default()),
            Arc::new(FakeLaunchEnvironment {
                root: directory.path().to_path_buf(),
            }),
        );
        let clip = backend
            .record_for_test(
                &AppConfig::default(),
                &item,
                &RecordingCancellation::default(),
                &ignored_progress(),
            )
            .await
            .expect("managed clip fixture");
        let recordings = directory.path().join(RECORDED_CLIP_DIRECTORY);
        let displaced = directory.path().join("recordings-displaced");
        std::fs::rename(&recordings, &displaced).expect("displace managed recordings root");
        let external = tempfile::tempdir().expect("external victim directory");
        let victim = external.path().join("fallen-r20.mp4");
        std::fs::write(&victim, b"external-user-file").expect("external victim");
        let status = std::process::Command::new("cmd")
            .args([
                "/d",
                "/c",
                "mklink",
                "/J",
                &recordings.to_string_lossy(),
                &external.path().to_string_lossy(),
            ])
            .status()
            .expect("invoke mklink");
        if !status.success() {
            return;
        }

        let error = remove_managed_hlae_unpublished_clip(&clip)
            .await
            .expect("managed clip cleanup must be claimed")
            .expect_err("swapped managed roots must fail cleanup closed");

        assert!(matches!(error, DomainError::Internal(_)));
        assert_eq!(
            std::fs::read(&victim).expect("external victim survives"),
            b"external-user-file"
        );
        assert!(displaced.join("fallen-r20.mp4").is_file());
    }
}
