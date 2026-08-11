use std::path::PathBuf;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;
use vibe_cs_cosmetics::{CosmeticInspectionReport, RewriteReport, RewriteRequest};
use vibe_cs_domain::{
    AgentProposalAction, AudioAnalysis, AudioAnalysisOptions, BeatAlignmentDraft,
    BeatAlignmentRequest, DemoRecord, DomainError, ExportJob, HeatPoint, HlaeProposalEvidence,
    HlaeProposalExportResult, HlaeProposalIntent, HlaeProposalPreview, MatchAnalysis, RecordingJob,
    ReplayFrame,
};

#[async_trait]
pub trait ProposalExecutionPort: Send + Sync + std::fmt::Debug {
    /// Builds a process-free preview from trusted Rust evidence.
    ///
    /// # Errors
    ///
    /// Returns a domain error when the evidence or generated typed plan is
    /// invalid, or the local adapter cannot create a confirmation token.
    async fn preview_hlae(
        &self,
        intent: &HlaeProposalIntent,
        evidence: &HlaeProposalEvidence,
    ) -> Result<HlaeProposalPreview, DomainError>;

    /// Revalidates and exports a confirmed plan without launching a process.
    ///
    /// # Errors
    ///
    /// Returns a domain error for stale evidence, revision, fingerprint, token,
    /// typed plan validation, or managed file publication failures.
    async fn export_hlae(
        &self,
        intent: &HlaeProposalIntent,
        evidence: &HlaeProposalEvidence,
        expected_revision: u64,
        base_fingerprint: &str,
        proposal_fingerprint: &str,
        confirmation_token: &str,
    ) -> Result<HlaeProposalExportResult, DomainError>;

    /// Signs a proposal identity for an explicit UI confirmation round-trip.
    ///
    /// # Errors
    ///
    /// Returns a domain error if the local confirmation authority is not
    /// available.
    fn confirmation_token(
        &self,
        action: AgentProposalAction,
        base_fingerprint: &str,
        proposal_fingerprint: &str,
        expected_revision: u64,
    ) -> Result<String, DomainError>;

    /// Verifies that a token is bound to this action, evidence, proposal, and
    /// revision.
    ///
    /// # Errors
    ///
    /// Returns a conflict when the token is malformed, stale, or belongs to a
    /// different proposal operation.
    fn verify_confirmation(
        &self,
        action: AgentProposalAction,
        base_fingerprint: &str,
        proposal_fingerprint: &str,
        expected_revision: u64,
        confirmation_token: &str,
    ) -> Result<(), DomainError>;
}

#[derive(Debug, Default)]
pub struct DisabledProposalExecutionPort;

#[async_trait]
impl ProposalExecutionPort for DisabledProposalExecutionPort {
    async fn preview_hlae(
        &self,
        _intent: &HlaeProposalIntent,
        _evidence: &HlaeProposalEvidence,
    ) -> Result<HlaeProposalPreview, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "AI proposal execution adapter".to_owned(),
        ))
    }

    async fn export_hlae(
        &self,
        _intent: &HlaeProposalIntent,
        _evidence: &HlaeProposalEvidence,
        _expected_revision: u64,
        _base_fingerprint: &str,
        _proposal_fingerprint: &str,
        _confirmation_token: &str,
    ) -> Result<HlaeProposalExportResult, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "AI proposal execution adapter".to_owned(),
        ))
    }

    fn confirmation_token(
        &self,
        _action: AgentProposalAction,
        _base_fingerprint: &str,
        _proposal_fingerprint: &str,
        _expected_revision: u64,
    ) -> Result<String, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "AI proposal confirmation adapter".to_owned(),
        ))
    }

    fn verify_confirmation(
        &self,
        _action: AgentProposalAction,
        _base_fingerprint: &str,
        _proposal_fingerprint: &str,
        _expected_revision: u64,
        _confirmation_token: &str,
    ) -> Result<(), DomainError> {
        Err(DomainError::DependencyUnavailable(
            "AI proposal confirmation adapter".to_owned(),
        ))
    }
}

#[async_trait]
pub trait AnalysisPort: Send + Sync + std::fmt::Debug {
    async fn analyze(&self, demo: DemoRecord) -> Result<MatchAnalysis, DomainError>;
    async fn replay(&self, demo: DemoRecord) -> Result<ReplayPayload, DomainError>;
    async fn heatmap(&self, demo: DemoRecord) -> Result<Vec<HeatPoint>, DomainError>;
    async fn replay_cache_status(&self) -> Result<ReplayCacheStatus, DomainError>;
    async fn clear_replay_cache(&self) -> Result<ReplayCacheCleanup, DomainError>;
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReplayCacheState {
    Hit,
    Generated,
    Bypassed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReplayCacheMetadata {
    pub state: ReplayCacheState,
    pub version: u32,
    pub key: Option<String>,
    pub bytes: u64,
    pub generated_at: Option<DateTime<Utc>>,
    pub repaired: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReplayPayload {
    pub frames: Vec<ReplayFrame>,
    pub cache: ReplayCacheMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReplayCacheStatus {
    pub version: u32,
    pub entries: u64,
    pub bytes: u64,
    pub maximum_entries: u64,
    pub maximum_bytes: u64,
    pub scan_complete: bool,
    pub checked_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReplayCacheCleanup {
    pub removed_entries: u64,
    pub freed_bytes: u64,
    pub failed_entries: u64,
    pub scan_complete: bool,
    pub completed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewScope {
    Match,
    Highlights,
    Player,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewTone {
    Analytical,
    Coach,
    Direct,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LlmReviewRequest {
    pub scope: ReviewScope,
    #[serde(default)]
    pub player_id: Option<String>,
    #[serde(default)]
    pub highlight_ids: Vec<String>,
    pub tone: ReviewTone,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LlmReviewResult {
    pub demo_id: Uuid,
    pub scope: ReviewScope,
    pub player_id: Option<String>,
    pub highlight_ids: Vec<String>,
    pub tone: ReviewTone,
    pub commentary: String,
    pub evidence_ids: Vec<String>,
    pub evidence_sha256: String,
    pub provider: String,
    pub model: String,
    pub generated_at: DateTime<Utc>,
    pub cached: bool,
}

#[async_trait]
pub trait ReviewPort: Send + Sync + std::fmt::Debug {
    async fn review(
        &self,
        demo_id: Uuid,
        request: LlmReviewRequest,
    ) -> Result<LlmReviewResult, DomainError>;
}

#[derive(Debug, Default)]
pub struct DisabledReviewPort;

#[async_trait]
impl ReviewPort for DisabledReviewPort {
    async fn review(
        &self,
        _demo_id: Uuid,
        _request: LlmReviewRequest,
    ) -> Result<LlmReviewResult, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "AI review adapter".to_owned(),
        ))
    }
}

#[derive(Debug, Default)]
pub struct DisabledAnalysisPort;

#[async_trait]
impl AnalysisPort for DisabledAnalysisPort {
    async fn analyze(&self, _demo: DemoRecord) -> Result<MatchAnalysis, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "demo analysis adapter".to_owned(),
        ))
    }

    async fn replay(&self, _demo: DemoRecord) -> Result<ReplayPayload, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "replay adapter".to_owned(),
        ))
    }

    async fn heatmap(&self, _demo: DemoRecord) -> Result<Vec<HeatPoint>, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "heatmap adapter".to_owned(),
        ))
    }

    async fn replay_cache_status(&self) -> Result<ReplayCacheStatus, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "replay cache adapter".to_owned(),
        ))
    }

    async fn clear_replay_cache(&self) -> Result<ReplayCacheCleanup, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "replay cache adapter".to_owned(),
        ))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CosmeticRewriteOutput {
    pub demo: DemoRecord,
    pub report: RewriteReport,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CosmeticCatalogItemDto {
    pub item_definition_index: u16,
    pub internal_name: String,
    pub display_name: String,
    pub category: String,
    pub base_image_available: bool,
    pub paint_kit_ids: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CosmeticPaintKitDto {
    pub id: u32,
    pub internal_name: String,
    pub display_name: String,
    pub wear_min: f32,
    pub wear_max: f32,
    pub compatible_item_definition_indices: Vec<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CosmeticCatalogDto {
    pub items: Vec<CosmeticCatalogItemDto>,
    pub paint_kits: Vec<CosmeticPaintKitDto>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CosmeticImageOutput {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[async_trait]
pub trait CosmeticsPort: Send + Sync + std::fmt::Debug {
    async fn catalog(&self) -> Result<CosmeticCatalogDto, DomainError>;
    async fn image(
        &self,
        item_definition_index: u16,
        paint_kit: u32,
    ) -> Result<CosmeticImageOutput, DomainError>;
    async fn inspect(&self, demo: DemoRecord) -> Result<CosmeticInspectionReport, DomainError>;
    async fn rewrite(
        &self,
        demo: DemoRecord,
        request: RewriteRequest,
    ) -> Result<CosmeticRewriteOutput, DomainError>;
}

#[derive(Debug, Default)]
pub struct DisabledCosmeticsPort;

#[async_trait]
impl CosmeticsPort for DisabledCosmeticsPort {
    async fn catalog(&self) -> Result<CosmeticCatalogDto, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "cosmetic catalog adapter".to_owned(),
        ))
    }

    async fn image(
        &self,
        _item_definition_index: u16,
        _paint_kit: u32,
    ) -> Result<CosmeticImageOutput, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "cosmetic catalog adapter".to_owned(),
        ))
    }

    async fn inspect(&self, _demo: DemoRecord) -> Result<CosmeticInspectionReport, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "cosmetic inspection adapter".to_owned(),
        ))
    }

    async fn rewrite(
        &self,
        _demo: DemoRecord,
        _request: RewriteRequest,
    ) -> Result<CosmeticRewriteOutput, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "cosmetic rewrite adapter".to_owned(),
        ))
    }
}

#[async_trait]
pub trait RecordingPort: Send + Sync + std::fmt::Debug {
    async fn execute(&self, job: RecordingJob) -> Result<RecordingJob, DomainError>;
    async fn cancel(&self, job: RecordingJob) -> Result<RecordingJob, DomainError>;
}

#[derive(Debug, Default)]
pub struct DisabledRecordingPort;

#[async_trait]
impl RecordingPort for DisabledRecordingPort {
    async fn execute(&self, _job: RecordingJob) -> Result<RecordingJob, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "recording runtime".to_owned(),
        ))
    }

    async fn cancel(&self, _job: RecordingJob) -> Result<RecordingJob, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "recording runtime".to_owned(),
        ))
    }
}

#[async_trait]
pub trait ExportPort: Send + Sync + std::fmt::Debug {
    /// Starts and durably registers an export before returning its active job.
    async fn start(
        &self,
        kind: &str,
        project_id: Uuid,
        request: Value,
    ) -> Result<ExportJob, DomainError>;

    /// Persists the cancellation request before signalling the active process.
    async fn cancel(&self, job_id: Uuid) -> Result<ExportJob, DomainError>;
}

#[derive(Debug, Default)]
pub struct DisabledExportPort;

#[async_trait]
impl ExportPort for DisabledExportPort {
    async fn start(
        &self,
        kind: &str,
        _project_id: Uuid,
        _request: Value,
    ) -> Result<ExportJob, DomainError> {
        Err(DomainError::DependencyUnavailable(format!(
            "{kind} export adapter"
        )))
    }

    async fn cancel(&self, _job_id: Uuid) -> Result<ExportJob, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "export adapter".to_owned(),
        ))
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProbedMediaMetadata {
    pub duration_seconds: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub has_audio: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MediaProxyRequest {
    pub duration_seconds: f64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub has_audio: bool,
}

#[async_trait]
pub trait MediaPort: Send + Sync + std::fmt::Debug {
    async fn probe(&self, path: PathBuf) -> Result<ProbedMediaMetadata, DomainError>;
    async fn waveform(&self, path: PathBuf, buckets: usize) -> Result<Vec<f32>, DomainError>;

    async fn analyze_audio(
        &self,
        _path: PathBuf,
        _options: AudioAnalysisOptions,
    ) -> Result<AudioAnalysis, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "audio intelligence adapter".to_owned(),
        ))
    }

    async fn align_clips_to_beats(
        &self,
        _request: BeatAlignmentRequest,
    ) -> Result<BeatAlignmentDraft, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "beat alignment adapter".to_owned(),
        ))
    }

    async fn generate_proxy(
        &self,
        _source: PathBuf,
        _output: PathBuf,
        _request: MediaProxyRequest,
    ) -> Result<(), DomainError> {
        Err(DomainError::DependencyUnavailable(
            "media proxy adapter".to_owned(),
        ))
    }

    async fn extract_audio(
        &self,
        _source: PathBuf,
        _output: PathBuf,
        _duration_seconds: f64,
    ) -> Result<(), DomainError> {
        Err(DomainError::DependencyUnavailable(
            "audio extraction adapter".to_owned(),
        ))
    }
}

#[derive(Debug, Default)]
pub struct DisabledMediaPort;

#[async_trait]
impl MediaPort for DisabledMediaPort {
    async fn probe(&self, _path: PathBuf) -> Result<ProbedMediaMetadata, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "media probe adapter".to_owned(),
        ))
    }

    async fn waveform(&self, _path: PathBuf, _buckets: usize) -> Result<Vec<f32>, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "waveform adapter".to_owned(),
        ))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RadarTransformData {
    pub position_x: f64,
    pub position_y: f64,
    pub scale: f64,
    pub rotate: bool,
    pub zoom: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RadarImageData {
    pub bytes: Vec<u8>,
    pub content_type: String,
    pub browser_displayable: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RadarOverviewData {
    pub map_name: String,
    pub transform: Option<RadarTransformData>,
    pub image: Option<RadarImageData>,
}

#[async_trait]
pub trait SourceAssetPort: Send + Sync + std::fmt::Debug {
    async fn radar_overview(&self, map_name: String) -> Result<RadarOverviewData, DomainError>;
}

#[derive(Debug, Default)]
pub struct DisabledSourceAssetPort;

#[async_trait]
impl SourceAssetPort for DisabledSourceAssetPort {
    async fn radar_overview(&self, _map_name: String) -> Result<RadarOverviewData, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "local game asset store".to_owned(),
        ))
    }
}

#[async_trait]
pub trait IntegrationPort: Send + Sync + std::fmt::Debug {
    async fn request(&self, capability: &str, request: Value) -> Result<Value, DomainError>;
}

#[derive(Debug, Default)]
pub struct DisabledIntegrationPort;

#[async_trait]
impl IntegrationPort for DisabledIntegrationPort {
    async fn request(&self, capability: &str, _request: Value) -> Result<Value, DomainError> {
        Err(DomainError::DependencyUnavailable(capability.to_owned()))
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObsVideoSettingsSnapshot {
    pub base_width: u32,
    pub base_height: u32,
    pub output_width: u32,
    pub output_height: u32,
    pub fps_numerator: u32,
    pub fps_denominator: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ObsVideoField {
    OutputResolution,
    FrameRate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObsVideoFieldDiff {
    pub field: ObsVideoField,
    pub current: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObsVideoTuningPlan {
    pub current: ObsVideoSettingsSnapshot,
    pub target: ObsVideoSettingsSnapshot,
    pub diff: Vec<ObsVideoFieldDiff>,
    pub expected_fingerprint: String,
    pub recording_active: bool,
    pub warnings: Vec<String>,
    pub managed_fields: Vec<String>,
    pub excluded_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ObsVideoApplyRequest {
    pub confirm: bool,
    pub expected_fingerprint: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ObsVideoBackupReason {
    Apply,
    BeforeRestore,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObsVideoBackup {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub reason: ObsVideoBackupReason,
    pub settings: ObsVideoSettingsSnapshot,
    pub settings_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObsVideoApplyResult {
    pub applied: bool,
    pub backup: Option<ObsVideoBackup>,
    pub settings: ObsVideoSettingsSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ObsVideoRestoreRequest {
    pub confirm: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObsVideoRestoreResult {
    pub restored: bool,
    pub restored_backup_id: Uuid,
    pub rollback_backup: Option<ObsVideoBackup>,
    pub settings: ObsVideoSettingsSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObsVideoBackupDeleteResult {
    pub id: Uuid,
    pub deleted: bool,
}

#[async_trait]
pub trait ObsTuningPort: Send + Sync + std::fmt::Debug {
    async fn plan(&self) -> Result<ObsVideoTuningPlan, DomainError>;
    async fn apply(
        &self,
        request: ObsVideoApplyRequest,
    ) -> Result<ObsVideoApplyResult, DomainError>;
    async fn list_backups(&self) -> Result<Vec<ObsVideoBackup>, DomainError>;
    async fn restore(
        &self,
        id: Uuid,
        request: ObsVideoRestoreRequest,
    ) -> Result<ObsVideoRestoreResult, DomainError>;
    async fn delete_backup(&self, id: Uuid) -> Result<ObsVideoBackupDeleteResult, DomainError>;
}

#[derive(Debug, Default)]
pub struct DisabledObsTuningPort;

#[async_trait]
impl ObsTuningPort for DisabledObsTuningPort {
    async fn plan(&self) -> Result<ObsVideoTuningPlan, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "OBS video tuning adapter".to_owned(),
        ))
    }

    async fn apply(
        &self,
        _request: ObsVideoApplyRequest,
    ) -> Result<ObsVideoApplyResult, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "OBS video tuning adapter".to_owned(),
        ))
    }

    async fn list_backups(&self) -> Result<Vec<ObsVideoBackup>, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "OBS video tuning adapter".to_owned(),
        ))
    }

    async fn restore(
        &self,
        _id: Uuid,
        _request: ObsVideoRestoreRequest,
    ) -> Result<ObsVideoRestoreResult, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "OBS video tuning adapter".to_owned(),
        ))
    }

    async fn delete_backup(&self, _id: Uuid) -> Result<ObsVideoBackupDeleteResult, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "OBS video tuning adapter".to_owned(),
        ))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DemoWatchRootStatus {
    pub path: String,
    pub state: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct DemoWatchStatus {
    pub running: bool,
    pub roots: Vec<DemoWatchRootStatus>,
    pub last_scan_at: Option<DateTime<Utc>>,
    pub last_event_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub imported: u64,
    pub updated: u64,
    pub missing: u64,
}

#[async_trait]
pub trait DemoWatchPort: Send + Sync + std::fmt::Debug {
    async fn reconfigure(&self, paths: Vec<String>) -> Result<DemoWatchStatus, DomainError>;
    async fn rescan(&self) -> Result<DemoWatchStatus, DomainError>;
    async fn status(&self) -> DemoWatchStatus;
}

#[derive(Debug, Default)]
pub struct DisabledDemoWatchPort;

#[async_trait]
impl DemoWatchPort for DisabledDemoWatchPort {
    async fn reconfigure(&self, paths: Vec<String>) -> Result<DemoWatchStatus, DomainError> {
        Ok(DemoWatchStatus {
            roots: paths
                .into_iter()
                .map(|path| DemoWatchRootStatus {
                    path,
                    state: "disabled".to_owned(),
                    message: Some("directory watcher is not available in this host".to_owned()),
                })
                .collect(),
            ..DemoWatchStatus::default()
        })
    }

    async fn rescan(&self) -> Result<DemoWatchStatus, DomainError> {
        Ok(DemoWatchStatus::default())
    }

    async fn status(&self) -> DemoWatchStatus {
        DemoWatchStatus::default()
    }
}
