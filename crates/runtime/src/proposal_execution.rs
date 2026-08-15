use std::{
    collections::hash_map::DefaultHasher,
    f64::consts::{PI, TAU},
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
};

use async_trait::async_trait;
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use vibe_cs_application::ProposalExecutionPort;
use vibe_cs_domain::{
    AgentProposalAction, DomainError, HlaeCameraStyle, HlaeProposalEvidence,
    HlaeProposalExportResult, HlaeProposalIntent, HlaeProposalMode, HlaeProposalPreview,
    ProposalConfirmation, ProposalPrerequisite, ReplayFrame, ReplayPlayer,
};
use vibe_cs_hlae::{
    CameraKeyframe, CameraPosition, CameraRotation, CameraShot, CaptureSettings,
    HlaeBundleLaunchInputs, HlaePlan, HlaePlanMode, PositionInterpolation, RotationInterpolation,
    compile_hlae_plan, export_hlae_plan, validate_hlae_plan,
};

type ProposalHmac = Hmac<Sha256>;
const CONFIRMATION_KEY_BYTES: usize = 32;
const PROPOSAL_REVISION: u64 = 2;
const MAXIMUM_DEMO_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const HASH_BUFFER_BYTES: usize = 1024 * 1024;

pub struct RuntimeProposalExecutionPort {
    managed_root: PathBuf,
    capture_root: PathBuf,
    confirmation_key: [u8; CONFIRMATION_KEY_BYTES],
}

impl std::fmt::Debug for RuntimeProposalExecutionPort {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeProposalExecutionPort")
            .field("managed_root", &self.managed_root)
            .field("capture_root", &self.capture_root)
            .field("confirmation_key", &"[REDACTED]")
            .finish()
    }
}

impl Drop for RuntimeProposalExecutionPort {
    fn drop(&mut self) {
        self.confirmation_key.fill(0);
    }
}

impl RuntimeProposalExecutionPort {
    /// Creates a process-local confirmation authority. Tokens intentionally
    /// expire when the desktop process exits and are never persisted or sent
    /// to an AI provider.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::Internal`] when the operating system cannot
    /// provide cryptographically secure randomness for confirmation tokens.
    pub fn new(data_dir: &Path) -> Result<Self, DomainError> {
        let mut confirmation_key = [0_u8; CONFIRMATION_KEY_BYTES];
        getrandom::fill(&mut confirmation_key).map_err(|error| {
            DomainError::Internal(format!("initialize proposal confirmation key: {error}"))
        })?;
        Ok(Self {
            managed_root: data_dir.join("hlae-plans"),
            capture_root: data_dir.join("hlae-captures"),
            confirmation_key,
        })
    }

    fn build_hlae_preview(
        &self,
        intent: &HlaeProposalIntent,
        evidence: &HlaeProposalEvidence,
        verification: &DemoVerification,
    ) -> Result<HlaeProposalPreview, DomainError> {
        let built = match build_evidence_plan(intent, evidence, verification, &self.capture_root)? {
            EvidencePlan::Prerequisites(items) => {
                return Ok(HlaeProposalPreview::prerequisites(items));
            }
            EvidencePlan::Ready { plan, base_hash } => (plan, base_hash),
        };
        let (plan, base_fingerprint) = built;
        // Round-trip through the deny-unknown-fields JSON contract. This keeps
        // the exact transport shown to a user identical to the typed value we
        // validate and later export.
        let typed_json = serde_json::to_value(&plan)
            .map_err(|error| DomainError::Internal(format!("serialize HLAE plan: {error}")))?;
        let typed_plan: HlaePlan = serde_json::from_value(typed_json.clone()).map_err(|error| {
            DomainError::InvalidInput(format!("invalid typed HLAE plan: {error}"))
        })?;
        let bundle_name = bundle_name(&proposal_hash_seed(&base_fingerprint, intent, &typed_plan)?);
        let artifact_directory = self.managed_root.join(&bundle_name);
        let compiled =
            compile_hlae_plan(&typed_plan, &artifact_directory).map_err(map_hlae_error)?;
        let proposal_fingerprint = proposal_fingerprint(&base_fingerprint, intent, &typed_plan)?;
        let confirmation_token = self.confirmation_token(
            AgentProposalAction::ExportHlaePlan,
            &base_fingerprint,
            &proposal_fingerprint,
            PROPOSAL_REVISION,
        )?;
        let notices = compiled
            .notices
            .iter()
            .map(|notice| notice.message.clone())
            .collect();
        Ok(HlaeProposalPreview {
            proposal_revision: PROPOSAL_REVISION,
            ready: true,
            prerequisites: Vec::new(),
            base_fingerprint: Some(base_fingerprint),
            proposal_fingerprint: Some(proposal_fingerprint),
            confirmation_token: Some(confirmation_token),
            typed_plan: Some(typed_json),
            compiled_preview: Some(serde_json::to_value(compiled).map_err(|error| {
                DomainError::Internal(format!("serialize compiled HLAE preview: {error}"))
            })?),
            notices,
            installation_status: None,
        })
    }
}

#[async_trait]
impl ProposalExecutionPort for RuntimeProposalExecutionPort {
    async fn preview_hlae(
        &self,
        intent: &HlaeProposalIntent,
        evidence: &HlaeProposalEvidence,
    ) -> Result<HlaeProposalPreview, DomainError> {
        let verification = match verify_demo_content(evidence).await {
            Ok(verification) => verification,
            Err(error) => {
                return Ok(HlaeProposalPreview::prerequisites(vec![
                    error.prerequisite(),
                ]));
            }
        };
        self.build_hlae_preview(intent, evidence, &verification)
    }

    async fn export_hlae(
        &self,
        intent: &HlaeProposalIntent,
        evidence: &HlaeProposalEvidence,
        launch_inputs: &HlaeBundleLaunchInputs,
        confirmation: &ProposalConfirmation,
    ) -> Result<HlaeProposalExportResult, DomainError> {
        let expected_revision = confirmation.expected_revision;
        let base_fingerprint = &confirmation.base_fingerprint;
        let proposal_fingerprint = &confirmation.proposal_fingerprint;
        let confirmation_token = &confirmation.confirmation_token;
        if expected_revision != PROPOSAL_REVISION {
            return Err(DomainError::Conflict(format!(
                "HLAE proposal is at revision {PROPOSAL_REVISION}"
            )));
        }
        let verification = verify_demo_content(evidence)
            .await
            .map_err(DemoIntegrityError::export_error)?;
        let preview = self.build_hlae_preview(intent, evidence, &verification)?;
        if !preview.ready {
            return Err(DomainError::Conflict(
                "HLAE proposal prerequisites are no longer satisfied".to_owned(),
            ));
        }
        let current_base = preview.base_fingerprint.as_deref().unwrap_or_default();
        let current_proposal = preview.proposal_fingerprint.as_deref().unwrap_or_default();
        if current_base != base_fingerprint || current_proposal != proposal_fingerprint {
            return Err(DomainError::Conflict(
                "HLAE proposal evidence or generated plan changed; preview it again".to_owned(),
            ));
        }
        self.verify_confirmation(
            AgentProposalAction::ExportHlaePlan,
            base_fingerprint,
            proposal_fingerprint,
            expected_revision,
            confirmation_token,
        )?;
        let plan: HlaePlan =
            serde_json::from_value(preview.typed_plan.ok_or_else(|| {
                DomainError::Internal("HLAE preview omitted its plan".to_owned())
            })?)
            .map_err(|error| {
                DomainError::InvalidInput(format!("invalid typed HLAE plan: {error}"))
            })?;
        validate_hlae_plan(&plan).map_err(map_hlae_error)?;
        fs::create_dir_all(&self.managed_root).map_err(|error| {
            DomainError::Internal(format!("create managed HLAE plan directory: {error}"))
        })?;
        let name = bundle_name(proposal_fingerprint);
        let exported = export_hlae_plan(&plan, &self.managed_root, &name, launch_inputs)
            .map_err(map_hlae_error)?;
        if !exported.completion_marker.is_file() {
            return Err(DomainError::Internal(
                "HLAE export did not publish its completion marker".to_owned(),
            ));
        }
        Ok(HlaeProposalExportResult {
            base_fingerprint: base_fingerprint.to_owned(),
            proposal_fingerprint: proposal_fingerprint.to_owned(),
            directory: exported.directory.to_string_lossy().into_owned(),
            files: exported
                .files
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            completion_marker: exported.completion_marker.to_string_lossy().into_owned(),
            launched: false,
        })
    }

    fn confirmation_token(
        &self,
        action: AgentProposalAction,
        base_fingerprint: &str,
        proposal_fingerprint: &str,
        expected_revision: u64,
    ) -> Result<String, DomainError> {
        let mut mac = ProposalHmac::new_from_slice(&self.confirmation_key)
            .map_err(|_| DomainError::Internal("initialize proposal HMAC".to_owned()))?;
        update_confirmation_mac(
            &mut mac,
            action,
            base_fingerprint,
            proposal_fingerprint,
            expected_revision,
        );
        Ok(hex::encode(mac.finalize().into_bytes()))
    }

    fn verify_confirmation(
        &self,
        action: AgentProposalAction,
        base_fingerprint: &str,
        proposal_fingerprint: &str,
        expected_revision: u64,
        confirmation_token: &str,
    ) -> Result<(), DomainError> {
        let tag = hex::decode(confirmation_token).map_err(|_| {
            DomainError::Conflict("proposal confirmation token is invalid".to_owned())
        })?;
        let mut mac = ProposalHmac::new_from_slice(&self.confirmation_key)
            .map_err(|_| DomainError::Internal("initialize proposal HMAC".to_owned()))?;
        update_confirmation_mac(
            &mut mac,
            action,
            base_fingerprint,
            proposal_fingerprint,
            expected_revision,
        );
        mac.verify_slice(&tag).map_err(|_| {
            DomainError::Conflict("proposal confirmation token does not match".to_owned())
        })
    }
}

#[derive(Debug)]
enum DemoIntegrityError {
    MissingFingerprint,
    MissingFile,
    NotRegularFile,
    TooLarge,
    ContentChanged,
    Io(std::io::Error),
}

struct DemoVerification {
    content_sha256: String,
    file_identity: u64,
}

impl DemoIntegrityError {
    fn prerequisite(&self) -> ProposalPrerequisite {
        match self {
            Self::MissingFingerprint => prerequisite(
                "missing_demo_fingerprint",
                "Re-import the demo to record its content fingerprint.",
            ),
            Self::MissingFile => prerequisite(
                "missing_demo_file",
                "The selected demo file must still exist locally.",
            ),
            Self::NotRegularFile => prerequisite(
                "unsafe_demo_file",
                "The demo must be a regular local file, not a link or reparse point.",
            ),
            Self::TooLarge => prerequisite(
                "demo_too_large",
                "The demo exceeds the bounded proposal verification limit.",
            ),
            Self::ContentChanged => prerequisite(
                "demo_content_changed",
                "The demo content changed after import; re-import and analyze it again.",
            ),
            Self::Io(_) => prerequisite(
                "demo_verification_failed",
                "The demo could not be read for content verification.",
            ),
        }
    }

    fn export_error(self) -> DomainError {
        match self {
            Self::Io(error) => {
                DomainError::Internal(format!("verify HLAE proposal demo content: {error}"))
            }
            other => DomainError::Conflict(other.prerequisite().message),
        }
    }
}

async fn verify_demo_content(
    evidence: &HlaeProposalEvidence,
) -> Result<DemoVerification, DemoIntegrityError> {
    let expected = evidence
        .demo_content_sha256
        .as_deref()
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or(DemoIntegrityError::MissingFingerprint)?;
    let path = Path::new(&evidence.demo_path);
    let metadata = tokio::fs::symlink_metadata(path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            DemoIntegrityError::MissingFile
        } else {
            DemoIntegrityError::Io(error)
        }
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
        return Err(DemoIntegrityError::NotRegularFile);
    }
    if metadata.len() > MAXIMUM_DEMO_BYTES {
        return Err(DemoIntegrityError::TooLarge);
    }
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(DemoIntegrityError::Io)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    let mut read_bytes = 0_u64;
    loop {
        // Every bounded read is an await point, so dropping the request future
        // cancels verification without a detached blocking hash task.
        let read = file
            .read(&mut buffer)
            .await
            .map_err(DemoIntegrityError::Io)?;
        if read == 0 {
            break;
        }
        read_bytes = read_bytes.saturating_add(read as u64);
        if read_bytes > MAXIMUM_DEMO_BYTES || read_bytes > metadata.len() {
            return Err(DemoIntegrityError::TooLarge);
        }
        hash.update(&buffer[..read]);
    }
    let actual_sha256 = hex::encode(hash.finalize());
    if read_bytes != metadata.len() || !actual_sha256.eq_ignore_ascii_case(expected) {
        return Err(DemoIntegrityError::ContentChanged);
    }
    let open_handle =
        same_file::Handle::from_file(file.into_std().await).map_err(DemoIntegrityError::Io)?;
    let named_handle = same_file::Handle::from_path(path).map_err(DemoIntegrityError::Io)?;
    if open_handle != named_handle {
        return Err(DemoIntegrityError::ContentChanged);
    }
    let mut identity = DefaultHasher::new();
    open_handle.hash(&mut identity);
    Ok(DemoVerification {
        content_sha256: actual_sha256,
        file_identity: identity.finish(),
    })
}

#[cfg(windows)]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
const fn is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

enum EvidencePlan {
    Prerequisites(Vec<ProposalPrerequisite>),
    Ready { plan: HlaePlan, base_hash: String },
}

fn build_evidence_plan(
    intent: &HlaeProposalIntent,
    evidence: &HlaeProposalEvidence,
    verification: &DemoVerification,
    capture_root: &Path,
) -> Result<EvidencePlan, DomainError> {
    let mut prerequisites = Vec::new();
    if intent.highlight_ids.is_empty() || intent.highlight_ids.len() > 16 {
        prerequisites.push(prerequisite(
            "select_highlights",
            "Select between 1 and 16 analyzed highlights.",
        ));
    }
    if !intent.lead_seconds.is_finite()
        || !(0.5..=8.0).contains(&intent.lead_seconds)
        || !intent.tail_seconds.is_finite()
        || !(0.5..=8.0).contains(&intent.tail_seconds)
    {
        prerequisites.push(prerequisite(
            "invalid_camera_context",
            "HLAE lead and tail context must each be between 0.5 and 8 seconds.",
        ));
    }
    if !evidence.tick_rate.is_finite() || !(1.0..=256.0).contains(&evidence.tick_rate) {
        prerequisites.push(prerequisite(
            "missing_tick_rate",
            "The demo analysis does not contain a trustworthy tick rate.",
        ));
    }
    let demo_path = PathBuf::from(&evidence.demo_path);
    if !demo_path.is_file() {
        prerequisites.push(prerequisite(
            "missing_demo_file",
            "The selected demo file must still exist locally.",
        ));
    }
    let mut selected = Vec::new();
    for id in &intent.highlight_ids {
        match evidence
            .highlights
            .iter()
            .find(|highlight| &highlight.id == id)
        {
            Some(highlight) => selected.push(highlight),
            None => prerequisites.push(prerequisite(
                "missing_highlight",
                format!("Highlight {id} is not present in the current analysis."),
            )),
        }
    }
    selected.sort_by_key(|highlight| highlight.start_tick);
    if !prerequisites.is_empty() {
        return Ok(EvidencePlan::Prerequisites(prerequisites));
    }

    let mut shots = Vec::with_capacity(selected.len());
    let mut sampled_evidence = Vec::with_capacity(selected.len());
    for (shot_index, highlight) in selected.into_iter().enumerate() {
        let Some(lead_ticks) = seconds_to_ticks(intent.lead_seconds, evidence.tick_rate) else {
            prerequisites.push(prerequisite(
                "invalid_camera_context",
                "HLAE lead context cannot be represented in demo ticks.",
            ));
            continue;
        };
        let Some(tail_ticks) = seconds_to_ticks(intent.tail_seconds, evidence.tick_rate) else {
            prerequisites.push(prerequisite(
                "invalid_camera_context",
                "HLAE tail context cannot be represented in demo ticks.",
            ));
            continue;
        };
        let window_start = highlight.start_tick.saturating_sub(lead_ticks);
        let Some(window_end) = highlight.end_tick.checked_add(tail_ticks) else {
            prerequisites.push(prerequisite(
                "camera_window_overflow",
                format!(
                    "Highlight {} context exceeds the demo tick range.",
                    highlight.id
                ),
            ));
            continue;
        };
        if shots
            .last()
            .is_some_and(|previous: &CameraShot| previous.end_tick >= window_start)
        {
            prerequisites.push(prerequisite(
                "overlapping_camera_windows",
                "Selected lead/tail camera windows overlap; reduce context or choose non-overlapping highlights.",
            ));
            continue;
        }
        let candidates = evidence
            .replay_frames
            .iter()
            .filter(|frame| frame.tick >= window_start && frame.tick <= window_end)
            .filter_map(|frame| {
                frame
                    .players
                    .iter()
                    .find(|player| player.id == highlight.player_id)
                    .map(|player| (frame.tick, (player, frame)))
            })
            .collect::<Vec<_>>();
        let Some(samples) = sample_four_frames(&candidates) else {
            prerequisites.push(prerequisite(
                "missing_spatial_evidence",
                format!(
                    "Highlight {} needs at least four target-player replay frames.",
                    highlight.id
                ),
            ));
            continue;
        };
        let duration = window_end - window_start;
        let target_ticks = [
            window_start,
            window_start + duration / 3,
            window_start + duration.saturating_mul(2) / 3,
            window_end,
        ];
        let keyframes = samples
            .iter()
            .zip(target_ticks)
            .enumerate()
            .map(|(index, ((_, (player, frame)), target_tick))| {
                camera_keyframe_for_scene(
                    target_tick,
                    player,
                    samples[0].1.0,
                    intent.camera_style,
                    index,
                    engagement_focus(frame, player),
                )
            })
            .collect::<Vec<_>>();
        sampled_evidence.push(serde_json::json!({
            "highlight": highlight,
            "leadSeconds": intent.lead_seconds,
            "tailSeconds": intent.tail_seconds,
            "windowStartTick": window_start,
            "windowEndTick": window_end,
            "frames": samples.iter().map(|(tick, (player, frame))| serde_json::json!({
                "sourceTick": tick,
                "player": player,
                "engagementFocus": engagement_focus(frame, player),
            })).collect::<Vec<_>>(),
        }));
        shots.push(CameraShot {
            id: format!("highlight_{:02}", shot_index + 1),
            start_tick: window_start,
            end_tick: window_end,
            position_interpolation: PositionInterpolation::Cubic,
            rotation_interpolation: RotationInterpolation::SphericalCubic,
            keyframes,
        });
    }
    if !prerequisites.is_empty() {
        return Ok(EvidencePlan::Prerequisites(prerequisites));
    }
    let base_hash = hash_json(
        b"vibe-cs-hlae-evidence\0",
        &serde_json::json!({
            "demoPath": evidence.demo_path,
            "demoContentSha256": verification.content_sha256,
            "demoFileIdentity": verification.file_identity,
            "tickRate": evidence.tick_rate,
            "samples": sampled_evidence,
        }),
    )?;
    let output_directory = capture_root.join(format!("capture_{}", &base_hash[..16]));
    // `tick_rate` was constrained to the finite 1..=256 range above, so this
    // rounded conversion is bounded and cannot lose a sign or overflow.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let pre_roll_ticks = (evidence.tick_rate * 2.0).round() as u64;
    let plan = HlaePlan {
        mode: match intent.mode {
            HlaeProposalMode::Preview => HlaePlanMode::Preview,
            HlaeProposalMode::Capture => HlaePlanMode::Capture,
        },
        tick_rate: evidence.tick_rate,
        demo_path,
        output_directory,
        pre_roll_ticks,
        capture: CaptureSettings::default(),
        shots,
    };
    validate_hlae_plan(&plan).map_err(map_hlae_error)?;
    Ok(EvidencePlan::Ready { plan, base_hash })
}

fn seconds_to_ticks(seconds: f64, tick_rate: f64) -> Option<u64> {
    let value = (seconds * tick_rate).round();
    if !value.is_finite() || !(0.0..=2_048.0).contains(&value) {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some(value as u64)
}

pub(crate) fn sample_four_frames<T: Copy>(frames: &[(u64, T)]) -> Option<[(u64, T); 4]> {
    if frames.len() < 4 {
        return None;
    }
    let last = frames.len() - 1;
    let indexes = [0, last / 3, (last * 2) / 3, last];
    let samples = indexes.map(|index| frames[index]);
    if samples.windows(2).any(|pair| pair[0].0 >= pair[1].0) {
        return None;
    }
    Some(samples)
}

#[cfg(test)]
fn camera_keyframe(
    tick: u64,
    player: &ReplayPlayer,
    anchor: &ReplayPlayer,
    style: HlaeCameraStyle,
    index: usize,
) -> CameraKeyframe {
    camera_keyframe_for_scene(tick, player, anchor, style, index, None)
}

pub(crate) fn camera_keyframe_for_scene(
    tick: u64,
    player: &ReplayPlayer,
    anchor: &ReplayPlayer,
    style: HlaeCameraStyle,
    index: usize,
    engagement_focus: Option<[f64; 3]>,
) -> CameraKeyframe {
    let phase = f64::from(u32::try_from(index).unwrap_or_default());
    let progress = phase / 3.0;
    let target = [
        player.position[0],
        player.position[1],
        player.position[2] + 64.0,
    ];
    let focus = engagement_focus.unwrap_or([
        target[0] + 256.0 * player.yaw.to_radians().cos(),
        target[1] + 256.0 * player.yaw.to_radians().sin(),
        target[2],
    ]);
    let interaction = [
        (target[0] + focus[0]) * 0.5,
        (target[1] + focus[1]) * 0.5,
        (target[2] + focus[2]) * 0.5,
    ];
    let engagement_dx = focus[0] - target[0];
    let engagement_dy = focus[1] - target[1];
    let engagement_distance = engagement_dx.hypot(engagement_dy).clamp(96.0, 512.0);
    let engagement_angle = if engagement_dx.abs() + engagement_dy.abs() > f64::EPSILON {
        engagement_dy.atan2(engagement_dx)
    } else {
        player.yaw.to_radians()
    };
    let (position, rotation, fov) = match style {
        HlaeCameraStyle::Pov => (
            CameraPosition {
                x: target[0],
                y: target[1],
                z: target[2],
            },
            CameraRotation {
                pitch: 0.0,
                yaw: normalized_yaw(player.yaw),
                roll: 0.0,
            },
            90.0,
        ),
        HlaeCameraStyle::Orbit => {
            let angle = engagement_angle + TAU * phase / 4.0;
            let radius = (engagement_distance * 0.32).clamp(72.0, 128.0);
            let camera = [
                interaction[0] + radius * angle.cos(),
                interaction[1] + radius * angle.sin(),
                player.position[2] + 80.0,
            ];
            (camera_position(camera), look_at(camera, interaction), 78.0)
        }
        HlaeCameraStyle::Dolly => {
            let angle = engagement_angle;
            let distance = (engagement_distance * 0.46).clamp(112.0, 192.0) - 20.0 * phase;
            let camera = [
                interaction[0] - distance * angle.cos(),
                interaction[1] - distance * angle.sin(),
                player.position[2] + 56.0,
            ];
            (camera_position(camera), look_at(camera, interaction), 72.0)
        }
        HlaeCameraStyle::Static => {
            let angle = engagement_angle;
            let lateral = (engagement_distance * 0.22).clamp(64.0, 96.0);
            let rear = (engagement_distance * 0.34).clamp(96.0, 160.0);
            let camera = [
                anchor.position[0] - rear * angle.cos() - lateral * angle.sin(),
                anchor.position[1] - rear * angle.sin() + lateral * angle.cos(),
                anchor.position[2] + 92.0,
            ];
            (camera_position(camera), look_at(camera, interaction), 76.0)
        }
        HlaeCameraStyle::Tracking => {
            let angle = engagement_angle;
            let lateral = (engagement_distance * 0.24).clamp(72.0, 112.0);
            let camera = [
                player.position[0] - 40.0 * angle.cos() - lateral * angle.sin(),
                player.position[1] - 40.0 * angle.sin() + lateral * angle.cos(),
                player.position[2] + 72.0,
            ];
            (camera_position(camera), look_at(camera, interaction), 80.0)
        }
        HlaeCameraStyle::Crane => {
            let angle = engagement_angle;
            let distance = (engagement_distance * 0.38).clamp(112.0, 176.0) - 32.0 * progress;
            let camera = [
                interaction[0] - distance * angle.cos(),
                interaction[1] - distance * angle.sin(),
                player.position[2] + 48.0 + 176.0 * progress,
            ];
            (camera_position(camera), look_at(camera, interaction), 74.0)
        }
        HlaeCameraStyle::Flyby => {
            let angle = engagement_angle;
            let travel = (engagement_distance * 0.72).clamp(240.0, 440.0);
            let longitudinal = -travel * 0.5 + travel * progress;
            let lateral_span = (engagement_distance * 0.24).clamp(72.0, 120.0);
            let lateral = lateral_span - lateral_span * 2.0 * progress;
            let camera = [
                interaction[0] + longitudinal * angle.cos() - lateral * angle.sin(),
                interaction[1] + longitudinal * angle.sin() + lateral * angle.cos(),
                player.position[2] + 72.0 + 20.0 * (PI * progress).sin(),
            ];
            (camera_position(camera), look_at(camera, interaction), 82.0)
        }
    };
    CameraKeyframe {
        tick,
        position,
        rotation,
        fov,
    }
}

pub(crate) fn engagement_focus(frame: &ReplayFrame, player: &ReplayPlayer) -> Option<[f64; 3]> {
    frame
        .players
        .iter()
        .filter(|candidate| {
            candidate.id != player.id
                && candidate.alive
                && !candidate.team.is_empty()
                && candidate.team != player.team
        })
        .min_by(|left, right| {
            planar_distance_squared(left.position, player.position)
                .total_cmp(&planar_distance_squared(right.position, player.position))
        })
        .map(|opponent| {
            [
                opponent.position[0],
                opponent.position[1],
                opponent.position[2] + 56.0,
            ]
        })
}

fn planar_distance_squared(left: [f64; 3], right: [f64; 3]) -> f64 {
    (left[0] - right[0]).powi(2) + (left[1] - right[1]).powi(2)
}

const fn camera_position(value: [f64; 3]) -> CameraPosition {
    CameraPosition {
        x: value[0],
        y: value[1],
        z: value[2],
    }
}

fn look_at(camera: [f64; 3], target: [f64; 3]) -> CameraRotation {
    let dx = target[0] - camera[0];
    let dy = target[1] - camera[1];
    let dz = target[2] - camera[2];
    let horizontal = dx.hypot(dy);
    CameraRotation {
        pitch: -dz.atan2(horizontal).to_degrees(),
        yaw: normalized_yaw(dy.atan2(dx).to_degrees()),
        roll: 0.0,
    }
}

fn normalized_yaw(value: f64) -> f64 {
    (value + 180.0).rem_euclid(360.0) - 180.0
}

fn prerequisite(code: impl Into<String>, message: impl Into<String>) -> ProposalPrerequisite {
    ProposalPrerequisite {
        code: code.into(),
        message: message.into(),
    }
}

fn proposal_hash_seed(
    base_fingerprint: &str,
    intent: &HlaeProposalIntent,
    plan: &HlaePlan,
) -> Result<String, DomainError> {
    proposal_fingerprint(base_fingerprint, intent, plan)
}

fn proposal_fingerprint(
    base_fingerprint: &str,
    intent: &HlaeProposalIntent,
    plan: &HlaePlan,
) -> Result<String, DomainError> {
    hash_json(
        b"vibe-cs-hlae-proposal\0",
        &serde_json::json!({
            "baseFingerprint": base_fingerprint,
            "intent": intent,
            "plan": plan,
        }),
    )
}

fn hash_json(domain: &[u8], value: &serde_json::Value) -> Result<String, DomainError> {
    let bytes = serde_json::to_vec(value).map_err(|error| {
        DomainError::Internal(format!("serialize proposal fingerprint: {error}"))
    })?;
    let mut hash = Sha256::new();
    hash.update(domain);
    hash.update(bytes);
    Ok(hex::encode(hash.finalize()))
}

fn bundle_name(fingerprint: &str) -> String {
    let bounded = fingerprint.get(..32).unwrap_or(fingerprint);
    format!("proposal_{bounded}")
}

fn update_confirmation_mac(
    mac: &mut ProposalHmac,
    action: AgentProposalAction,
    base_fingerprint: &str,
    proposal_fingerprint: &str,
    expected_revision: u64,
) {
    mac.update(b"vibe-cs-agent-proposal-confirmation\0");
    mac.update(&[match action {
        AgentProposalAction::ExportHlaePlan => 1,
        AgentProposalAction::ApplyBeatAlignment => 2,
        AgentProposalAction::ApplyHighlightEdit => 3,
    }]);
    mac.update(&(base_fingerprint.len() as u64).to_be_bytes());
    mac.update(base_fingerprint.as_bytes());
    mac.update(&(proposal_fingerprint.len() as u64).to_be_bytes());
    mac.update(proposal_fingerprint.as_bytes());
    mac.update(&expected_revision.to_be_bytes());
}

fn map_hlae_error(error: vibe_cs_hlae::HlaeError) -> DomainError {
    match error {
        vibe_cs_hlae::HlaeError::InvalidPlan(message)
        | vibe_cs_hlae::HlaeError::InvalidInstallation(message) => {
            DomainError::InvalidInput(message)
        }
        vibe_cs_hlae::HlaeError::ArtifactBundleExists(path) => DomainError::Conflict(format!(
            "HLAE proposal bundle already exists at {}",
            path.display()
        )),
        vibe_cs_hlae::HlaeError::ArtifactBundleConflict { path, reason } => {
            DomainError::Conflict(format!(
                "HLAE proposal bundle at {} cannot be resumed: {reason}",
                path.display()
            ))
        }
        other => DomainError::Internal(format!("HLAE proposal operation failed: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_output_never_exposes_the_confirmation_authority() {
        let root = tempfile::tempdir().unwrap();
        let mut port = RuntimeProposalExecutionPort::new(root.path()).unwrap();
        port.confirmation_key = [0xAB; CONFIRMATION_KEY_BYTES];

        let rendered = format!("{port:?}");

        assert!(rendered.contains("[REDACTED]"));
        assert!(!rendered.contains("171"));
        assert!(!rendered.to_ascii_lowercase().contains("abab"));
    }
    use vibe_cs_domain::{Highlight, HighlightKind, ReplayFrame};

    fn evidence(root: &Path) -> HlaeProposalEvidence {
        let demo = root.join("match.dem");
        fs::write(&demo, b"demo").unwrap();
        let demo_sha256 = hex::encode(Sha256::digest(b"demo"));
        let frames = [1_000, 1_080, 1_160, 1_240]
            .into_iter()
            .map(|tick| ReplayFrame {
                tick,
                players: vec![ReplayPlayer {
                    id: "player-1".to_owned(),
                    name: "Player".to_owned(),
                    team: "CT".to_owned(),
                    position: [f64::from(u32::try_from(tick).unwrap()) / 10.0, 20.0, 10.0],
                    yaw: 45.0,
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
        HlaeProposalEvidence {
            demo_path: demo.to_string_lossy().into_owned(),
            demo_content_sha256: Some(demo_sha256),
            tick_rate: 64.0,
            highlights: vec![Highlight {
                id: "highlight-1".to_owned(),
                player_id: "player-1".to_owned(),
                round: 1,
                start_tick: 1_000,
                end_tick: 1_240,
                kind: HighlightKind::MultiKill,
                title: "Multi kill".to_owned(),
                description: String::new(),
                score: 1.0,
                tags: Vec::new(),
                victims: Vec::new(),
            }],
            replay_frames: frames,
        }
    }

    fn intent() -> HlaeProposalIntent {
        HlaeProposalIntent {
            demo_id: uuid::Uuid::nil(),
            highlight_ids: vec!["highlight-1".to_owned()],
            camera_style: HlaeCameraStyle::Orbit,
            mode: HlaeProposalMode::Preview,
            lead_seconds: 2.0,
            tail_seconds: 2.0,
        }
    }

    fn launch_inputs(root: &Path) -> HlaeBundleLaunchInputs {
        let installation_root = root.join("HLAE");
        let executable = installation_root.join("HLAE.exe");
        let source2_hook = installation_root.join("x64/AfxHookSource2.dll");
        let game_executable = root.join("game/bin/win64/cs2.exe");
        let steam_executable = root.join("Steam/steam.exe");
        fs::create_dir_all(source2_hook.parent().unwrap()).unwrap();
        fs::create_dir_all(game_executable.parent().unwrap()).unwrap();
        fs::create_dir_all(steam_executable.parent().unwrap()).unwrap();
        fs::write(&executable, b"hlae").unwrap();
        fs::write(&source2_hook, b"hook").unwrap();
        fs::write(&game_executable, b"cs2").unwrap();
        fs::write(&steam_executable, b"steam").unwrap();
        HlaeBundleLaunchInputs {
            installation: vibe_cs_hlae::HlaeInstallation {
                root: installation_root,
                executable,
                source2_hook,
                source: vibe_cs_hlae::HlaeDiscoverySource::Managed,
            },
            game_executable,
            steam_executable,
            resolution: vibe_cs_hlae::LaunchResolution {
                width: 1920,
                height: 1080,
            },
        }
    }

    fn export_confirmation(
        base_fingerprint: String,
        proposal_fingerprint: String,
        confirmation_token: String,
    ) -> ProposalConfirmation {
        ProposalConfirmation {
            base_fingerprint,
            proposal_fingerprint,
            confirmation_token,
            expected_revision: PROPOSAL_REVISION,
            confirm: true,
        }
    }

    #[test]
    fn cinematic_camera_styles_generate_distinct_evidence_backed_paths() {
        let player = |position: [f64; 3]| ReplayPlayer {
            id: "player-1".to_owned(),
            name: "Player".to_owned(),
            team: "CT".to_owned(),
            position,
            yaw: 30.0,
            health: 100,
            armor: 100,
            alive: true,
            weapon: "ak47".to_owned(),
            input: None,
        };
        let anchor = player([0.0, 0.0, 0.0]);
        let moved = player([96.0, 48.0, 0.0]);

        let locked_start = camera_keyframe(100, &anchor, &anchor, HlaeCameraStyle::Static, 0);
        let locked_end = camera_keyframe(200, &moved, &anchor, HlaeCameraStyle::Static, 3);
        assert_eq!(locked_start.position, locked_end.position);
        assert_ne!(locked_start.rotation, locked_end.rotation);

        let tracking_start = camera_keyframe(100, &anchor, &anchor, HlaeCameraStyle::Tracking, 0);
        let tracking_end = camera_keyframe(200, &moved, &anchor, HlaeCameraStyle::Tracking, 3);
        assert_ne!(tracking_start.position, tracking_end.position);

        let crane_start = camera_keyframe(100, &anchor, &anchor, HlaeCameraStyle::Crane, 0);
        let crane_end = camera_keyframe(200, &moved, &anchor, HlaeCameraStyle::Crane, 3);
        assert!(crane_end.position.z > crane_start.position.z);

        let flyby_start = camera_keyframe(100, &anchor, &anchor, HlaeCameraStyle::Flyby, 0);
        let flyby_end = camera_keyframe(200, &moved, &anchor, HlaeCameraStyle::Flyby, 3);
        assert_ne!(flyby_start.position, flyby_end.position);
    }

    #[test]
    fn cinematic_camera_uses_the_nearest_live_opponent_as_the_engagement_axis() {
        let player = ReplayPlayer {
            id: "player-1".to_owned(),
            name: "Player".to_owned(),
            team: "T".to_owned(),
            position: [0.0, 0.0, 0.0],
            yaw: 180.0,
            health: 100,
            armor: 100,
            alive: true,
            weapon: "ak47".to_owned(),
            input: None,
        };
        let opponent = ReplayPlayer {
            id: "opponent-1".to_owned(),
            name: "Opponent".to_owned(),
            team: "CT".to_owned(),
            position: [320.0, 0.0, 0.0],
            yaw: 180.0,
            health: 100,
            armor: 100,
            alive: true,
            weapon: "m4a1".to_owned(),
            input: None,
        };
        let frame = ReplayFrame {
            tick: 100,
            players: vec![player.clone(), opponent],
            projectiles: Vec::new(),
            bomb: None,
        };
        let focus = engagement_focus(&frame, &player).expect("live opponent focus");
        assert_eq!(focus, [320.0, 0.0, 56.0]);

        let keyframe = camera_keyframe_for_scene(
            100,
            &player,
            &player,
            HlaeCameraStyle::Dolly,
            0,
            Some(focus),
        );
        assert!(keyframe.position.x < 160.0);
        assert!(keyframe.rotation.yaw.abs() < 1.0);
    }

    #[tokio::test]
    async fn preview_uses_real_frames_and_export_requires_its_token() {
        let root = tempfile::tempdir().unwrap();
        let port = RuntimeProposalExecutionPort::new(root.path()).unwrap();
        let evidence = evidence(root.path());
        let preview = port.preview_hlae(&intent(), &evidence).await.unwrap();
        assert!(preview.ready);
        let typed_plan: HlaePlan =
            serde_json::from_value(preview.typed_plan.clone().unwrap()).unwrap();
        assert!((typed_plan.tick_rate - 64.0).abs() < f64::EPSILON);
        assert_eq!(typed_plan.shots[0].start_tick, 872);
        assert_eq!(typed_plan.shots[0].end_tick, 1_368);
        let base = preview.base_fingerprint.unwrap();
        let proposal = preview.proposal_fingerprint.unwrap();
        let token = preview.confirmation_token.unwrap();
        let launch_inputs = launch_inputs(root.path());
        let confirmation = export_confirmation(base, proposal, token);

        let exported = port
            .export_hlae(&intent(), &evidence, &launch_inputs, &confirmation)
            .await
            .unwrap();
        assert!(!exported.launched);
        assert!(Path::new(&exported.completion_marker).is_file());
        assert!(exported.directory.contains("hlae-plans"));
    }

    #[tokio::test]
    async fn missing_spatial_frames_return_prerequisites_without_a_token() {
        let root = tempfile::tempdir().unwrap();
        let port = RuntimeProposalExecutionPort::new(root.path()).unwrap();
        let mut evidence = evidence(root.path());
        evidence.replay_frames.truncate(3);
        let preview = port.preview_hlae(&intent(), &evidence).await.unwrap();
        assert!(!preview.ready);
        assert!(preview.confirmation_token.is_none());
        assert_eq!(preview.prerequisites[0].code, "missing_spatial_evidence");
    }

    #[tokio::test]
    async fn replacing_demo_content_after_preview_rejects_the_old_token() {
        let root = tempfile::tempdir().unwrap();
        let port = RuntimeProposalExecutionPort::new(root.path()).unwrap();
        let evidence = evidence(root.path());
        let preview = port.preview_hlae(&intent(), &evidence).await.unwrap();
        let base = preview.base_fingerprint.unwrap();
        let proposal = preview.proposal_fingerprint.unwrap();
        let token = preview.confirmation_token.unwrap();
        let launch_inputs = launch_inputs(root.path());
        let confirmation = export_confirmation(base, proposal, token);
        fs::write(&evidence.demo_path, b"replaced demo bytes").unwrap();

        let error = port
            .export_hlae(&intent(), &evidence, &launch_inputs, &confirmation)
            .await
            .unwrap_err();
        assert!(matches!(error, DomainError::Conflict(_)));
        assert!(!root.path().join("hlae-plans").exists());
    }

    #[tokio::test]
    async fn replacing_demo_identity_with_same_bytes_rejects_the_old_token() {
        let root = tempfile::tempdir().unwrap();
        let port = RuntimeProposalExecutionPort::new(root.path()).unwrap();
        let evidence = evidence(root.path());
        let preview = port.preview_hlae(&intent(), &evidence).await.unwrap();
        let base = preview.base_fingerprint.unwrap();
        let proposal = preview.proposal_fingerprint.unwrap();
        let token = preview.confirmation_token.unwrap();
        let launch_inputs = launch_inputs(root.path());
        let confirmation = export_confirmation(base, proposal, token);
        let replacement = root.path().join("replacement.dem");
        fs::write(&replacement, b"demo").unwrap();
        fs::remove_file(&evidence.demo_path).unwrap();
        fs::rename(replacement, &evidence.demo_path).unwrap();

        let error = port
            .export_hlae(&intent(), &evidence, &launch_inputs, &confirmation)
            .await
            .unwrap_err();
        assert!(matches!(error, DomainError::Conflict(_)));
        assert!(!root.path().join("hlae-plans").exists());
    }

    #[test]
    fn confirmation_token_is_bound_to_revision_and_fingerprints() {
        let root = tempfile::tempdir().unwrap();
        let port = RuntimeProposalExecutionPort::new(root.path()).unwrap();
        let token = port
            .confirmation_token(AgentProposalAction::ApplyBeatAlignment, "base", "plan", 4)
            .unwrap();
        assert!(
            port.verify_confirmation(
                AgentProposalAction::ApplyBeatAlignment,
                "base",
                "plan",
                5,
                &token,
            )
            .is_err()
        );
        assert!(
            port.verify_confirmation(
                AgentProposalAction::ApplyHighlightEdit,
                "base",
                "plan",
                4,
                &token,
            )
            .is_err()
        );
    }
}
