use std::{path::PathBuf, sync::Arc};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;
use vibe_cs_cosmetics::{CosmeticInspectionReport, RewriteReport, RewriteRequest};
use vibe_cs_domain::{
    AgentProposalAction, AnalysisInputFingerprint, AudioAnalysis, AudioAnalysisOptions,
    BeatAlignmentDraft, BeatAlignmentRequest, DemoRecord, DomainError, ExportJob, HeatPoint,
    HlaeProposalEvidence, HlaeProposalExportResult, HlaeProposalIntent, HlaeProposalPreview,
    MatchAnalysis, ProposalConfirmation, RecordingJob, RecordingRequest, ReplayFidelityMetadata,
    ReplayFrame,
};

#[async_trait]
pub trait AnalysisProgressReporter: Send + Sync + std::fmt::Debug {
    async fn parser_started(&self) -> Result<(), DomainError>;
}

/// Run-scoped cancellation observed by every blocking boundary of an analysis owner.
#[derive(Debug, Clone)]
pub struct AnalysisCancellation {
    receiver: tokio::sync::watch::Receiver<bool>,
    _keepalive: Arc<tokio::sync::watch::Sender<bool>>,
}

/// Capability that signals one run-scoped analysis cancellation.
#[derive(Debug, Clone)]
pub struct AnalysisCancellationSource {
    sender: Arc<tokio::sync::watch::Sender<bool>>,
}

impl AnalysisCancellation {
    #[must_use]
    pub fn channel() -> (AnalysisCancellationSource, Self) {
        let (sender, receiver) = tokio::sync::watch::channel(false);
        let sender = Arc::new(sender);
        (
            AnalysisCancellationSource {
                sender: Arc::clone(&sender),
            },
            Self {
                receiver,
                _keepalive: sender,
            },
        )
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        *self.receiver.borrow()
    }

    pub async fn cancelled(&self) {
        let mut receiver = self.receiver.clone();
        let _ = receiver.wait_for(|cancelled| *cancelled).await;
    }
}

impl Default for AnalysisCancellation {
    fn default() -> Self {
        Self::channel().1
    }
}

impl AnalysisCancellationSource {
    pub fn cancel(&self) {
        self.sender.send_replace(true);
    }
}
use vibe_cs_hlae::HlaeBundleLaunchInputs;

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
        launch_inputs: &HlaeBundleLaunchInputs,
        confirmation: &ProposalConfirmation,
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
        _launch_inputs: &HlaeBundleLaunchInputs,
        _confirmation: &ProposalConfirmation,
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
    async fn validate_input(
        &self,
        demo: DemoRecord,
        cancellation: AnalysisCancellation,
    ) -> Result<AnalysisInputFingerprint, DomainError>;
    async fn analyze(
        &self,
        demo: DemoRecord,
        progress: Arc<dyn AnalysisProgressReporter>,
        cancellation: AnalysisCancellation,
    ) -> Result<MatchAnalysis, DomainError>;
    async fn replay(&self, demo: DemoRecord) -> Result<ReplayPayload, DomainError>;
    async fn replay_round(
        &self,
        _run_id: uuid::Uuid,
        _round: u32,
    ) -> Result<vibe_cs_domain::RoundReplayArtifact, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "selected-round replay adapter".to_owned(),
        ))
    }
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
#[serde(deny_unknown_fields)]
pub struct ReplayCacheMetadata {
    pub state: ReplayCacheState,
    pub key: Option<String>,
    pub bytes: u64,
    pub generated_at: Option<DateTime<Utc>>,
    pub repaired: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReplayPayload {
    pub frames: Vec<ReplayFrame>,
    pub fidelity: ReplayFidelityMetadata,
    pub cache: ReplayCacheMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReplayCacheStatus {
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
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub player_id: Option<String>,
    pub highlight_ids: Vec<String>,
    pub tone: ReviewTone,
}

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
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
    async fn validate_input(
        &self,
        _demo: DemoRecord,
        _cancellation: AnalysisCancellation,
    ) -> Result<AnalysisInputFingerprint, DomainError> {
        Err(DomainError::DependencyUnavailable(
            "Demo analysis adapter".to_owned(),
        ))
    }

    async fn analyze(
        &self,
        _demo: DemoRecord,
        _progress: Arc<dyn AnalysisProgressReporter>,
        _cancellation: AnalysisCancellation,
    ) -> Result<MatchAnalysis, DomainError> {
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
    /// Validates an executable recording plan against current authoritative
    /// Demo, analysis, configuration, and backend capability evidence.
    ///
    /// This check is read-only with respect to recording jobs and must not
    /// launch the game or capture runtime. Execution revalidates independently.
    async fn preflight(&self, items: &[RecordingRequest]) -> Result<(), DomainError>;
    /// Starts a job and durably registers its current state before returning.
    ///
    /// The application layer treats this method as the single persistence owner
    /// for the start transition; implementations must not return a successful
    /// job that cannot immediately be retrieved from durable storage.
    async fn execute(&self, job: RecordingJob) -> Result<RecordingJob, DomainError>;
    async fn cancel(&self, job: RecordingJob) -> Result<RecordingJob, DomainError>;
}

#[derive(Debug, Default)]
pub struct DisabledRecordingPort;

#[async_trait]
impl RecordingPort for DisabledRecordingPort {
    async fn preflight(&self, _items: &[RecordingRequest]) -> Result<(), DomainError> {
        Err(DomainError::DependencyUnavailable(
            "recording runtime".to_owned(),
        ))
    }

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

#[cfg(test)]
mod tests {
    use super::AnalysisCancellation;

    #[tokio::test]
    async fn analysis_cancellation_has_no_lost_wakeup_for_late_or_parallel_waiters() {
        for _ in 0..128 {
            let (source, cancellation) = AnalysisCancellation::channel();
            let waiters = (0..8)
                .map(|_| {
                    let cancellation = cancellation.clone();
                    tokio::spawn(async move { cancellation.cancelled().await })
                })
                .collect::<Vec<_>>();
            tokio::task::yield_now().await;
            source.cancel();
            cancellation.cancelled().await;
            for waiter in waiters {
                tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
                    .await
                    .expect("parallel cancellation waiter")
                    .expect("waiter task");
            }

            let late = cancellation.clone();
            tokio::time::timeout(std::time::Duration::from_secs(1), late.cancelled())
                .await
                .expect("late waiter observes retained cancellation");
        }
    }
}
