/**
 * The wire contract, mirrored from Rust.
 *
 * This file used to be 2400 lines of hand-copied structure. It is now almost
 * entirely re-exports of `./generated/**`, which `cargo test` writes out of the
 * `#[derive(TS)]` types in `crates/**`. A Rust structure that changes and a
 * binding that does not is a red diff in CI (`.github/workflows/ci.yml`, step
 * "wire types are in step with the Rust"), which is the whole point: the mirror
 * had drifted in eighteen places before it was generated, and nothing could
 * see it.
 *
 * ## How to read a re-export
 *
 * `export type { ConfigDto as AppConfig } from './generated/ConfigDto';`
 * means the Rust item is `ConfigDto` and the name this application has always
 * used for it is `AppConfig`. The alias is deliberate: renaming the Rust type
 * to flatter the binding would be reshaping the server to please the client.
 *
 * Explanatory prose that the Rust doc comments already carry is **not**
 * repeated here — open the generated file, it is in the TSDoc. What stays here
 * is what Rust cannot know: how the client uses a value.
 *
 * ## What is still hand-written, and why
 *
 * Two groups, each marked where it appears:
 *
 *   1. **Tauri-side types.** The streaming Agent chat contract
 *      (`AgentStatus`, `AgentChatInput`, `AgentEvent`, `AgentChatResult`) and
 *      `HlaeBundleHandoff` live in
 *      `apps/desktop/src-tauri/src/`, which is not part of the ts-rs wiring.
 *   2. **Frontend aliases.** `EntityId`.
 *
 * View models — shapes this application derives from the wire rather than
 * receives — moved to `./viewModels`. `dto.ts` is the wire, not a type
 * cupboard.
 */

/** An opaque server-owned identifier. Rust spells these `Uuid` or `String`. */
export type EntityId = string;

/* ── service health, storage, setup ───────────────────────────────────────── */

export type { HealthResponse as ApiHealth } from './generated/HealthResponse';
export type { StorageStatusResponse as StorageStatus } from './generated/StorageStatusResponse';
export type { DetectedPathsResponse as DetectedPaths } from './generated/DetectedPathsResponse';

/**
 * The quick-check pair.
 *
 * Both were hand-written unions until `routes/system.rs` grew real enums for
 * them; the guesses were `'game'` for the kind (right) and four states where
 * the probe only ever produces two (wrong — see the generated TSDoc).
 */
export type { DependencyKind } from './generated/DependencyKind';
export type { DependencyState } from './generated/DependencyState';
export type { DependencyCheck } from './generated/DependencyCheck';
export type { QuickCheckResponse } from './generated/QuickCheckResponse';

/* ── the demo library ─────────────────────────────────────────────────────── */

/**
 * The demo lifecycle. Both names are the same generated enum: `DemoStatus` is
 * what Rust calls it, `DemoLifecycleStatus` is what most of this application
 * calls it.
 */
export type { DemoStatus } from './generated/DemoStatus';
export type { DemoStatus as DemoLifecycleStatus } from './generated/DemoStatus';

/**
 * The `/api/demos` list row.
 *
 * Two Rust types wear this name. This one is application's `DemoSummaryDto`,
 * which renames `player_names` to `players`; domain's own `DemoRecord` is the
 * export/cosmetic-rewrite shape and is re-exported below as
 * `DemoCatalogRecord`. They are not interchangeable.
 */
export type { DemoSummaryDto as DemoRecord } from './generated/DemoSummaryDto';

/**
 * Domain's catalog record — the shape `CosmeticRewriteResponse.demo` carries
 * and the demo-export endpoint returns. Its player list is `player_names`.
 */
export type { DemoRecord as DemoCatalogRecord } from './generated/DemoRecord';

export type { DemoSort } from './generated/DemoSort';
export type { DemoQuery } from './generated/DemoQuery';
export type { DemoPatch as DemoUpdate } from './generated/DemoPatch';
export type { DemoMatchSource } from './generated/DemoMatchSource';
export type { ScanRequest } from './generated/ScanRequest';
export type { ScanResult } from './generated/ScanResult';
export type { DemoWatchRootStatus } from './generated/DemoWatchRootStatus';
export type { DemoWatchStatus } from './generated/DemoWatchStatus';

/* ── canonical project editing ───────────────────────────────────────────── */

export type { Project } from './generated/Project';
export type { EditingDocument } from './generated/EditingDocument';
export type { TimelineTrack } from './generated/TimelineTrack';
export type { TimelineClip } from './generated/TimelineClip';
export type { TimelineClipTransitions } from './generated/TimelineClipTransitions';
export type { EditorTransition } from './generated/EditorTransition';
export type { EditorTransitionKind } from './generated/EditorTransitionKind';
export type { TimelinePlacement } from './generated/TimelinePlacement';
export type { TimelineClipMaterial } from './generated/TimelineClipMaterial';
export type { TimelineClipMaterializationState } from './generated/TimelineClipMaterializationState';
export type { CaptureIntent } from './generated/CaptureIntent';
export type { ProjectPatch } from './generated/ProjectPatch';
export type { ProjectPatchScope } from './generated/ProjectPatchScope';
export type { ProjectEditOperation } from './generated/ProjectEditOperation';
export type { ProjectChangeAuthor } from './generated/ProjectChangeAuthor';
export type { ProjectChangeGroup } from './generated/ProjectChangeGroup';
export type { ProjectChangeGroupStatus } from './generated/ProjectChangeGroupStatus';
export type { ProjectEditLease } from './generated/ProjectEditLease';
export type { CreateProjectRequest } from './generated/CreateProjectRequest';
export type { ProjectPatchResult } from './generated/ProjectPatchResult';
export type { ProjectDeliveryBlocker } from './generated/ProjectDeliveryBlocker';
export type { ProjectDeliveryGate } from './generated/ProjectDeliveryGate';
export type { RevertProjectChangeGroupRequest } from './generated/RevertProjectChangeGroupRequest';

/** The generic page envelope every paginated route flattens into its response. */
export type { Page as Paginated } from './generated/Page';

/* ── review metadata: tags, comments ──────────────────────────────────────── */

export type { ReviewTag } from './generated/ReviewTag';
export type { ReviewTag as DemoTag } from './generated/ReviewTag';
export type { ReviewTagCreate } from './generated/ReviewTagCreate';
export type { ReviewTagCreate as DemoTagCreate } from './generated/ReviewTagCreate';
export type { ReviewMetadataUpdate } from './generated/ReviewMetadataUpdate';
export type { DemoMetadata } from './generated/DemoMetadata';
export type { DemoMetadataUpdate } from './generated/DemoMetadataUpdate';
export type { DemoMetadataBatchUpdate } from './generated/DemoMetadataBatchUpdate';
export type { PlayerReviewMetadata } from './generated/PlayerReviewMetadata';
export type { RoundReviewMetadata } from './generated/RoundReviewMetadata';

/* ── evidence search and annotations ──────────────────────────────────────── */

export type { EvidenceEventFamily as EvidenceSearchEventFamily } from './generated/EvidenceEventFamily';
export type { EvidenceSourceKind as EvidenceSearchSourceKind } from './generated/EvidenceSourceKind';
export type { EvidenceSearchQuery } from './generated/EvidenceSearchQuery';
export type { EvidenceSearchItem } from './generated/EvidenceSearchItem';
export type { EvidenceSearchCapability } from './generated/EvidenceSearchCapability';
export type { EvidenceSearchAvailability } from './generated/EvidenceSearchAvailability';
export type { EvidenceSearchPage as EvidenceSearchResponse } from './generated/EvidenceSearchPage';
export type { EvidenceAnnotationReviewState } from './generated/EvidenceAnnotationReviewState';
export type { EvidenceAnnotation } from './generated/EvidenceAnnotation';
export type { CreateEvidenceAnnotation } from './generated/CreateEvidenceAnnotation';
export type { UpdateEvidenceAnnotation } from './generated/UpdateEvidenceAnnotation';
export type { EvidenceAnnotationQuery } from './generated/EvidenceAnnotationQuery';

/* ── cosmetics ────────────────────────────────────────────────────────────── */

export type { CosmeticField } from './generated/CosmeticField';
export type { CosmeticField as CosmeticFieldName } from './generated/CosmeticField';
export type { MatchBasis } from './generated/MatchBasis';
export type { StablePlayerIdentity } from './generated/StablePlayerIdentity';
export type { CosmeticInspectionItem } from './generated/CosmeticInspectionItem';
export type { CosmeticInspectionReport } from './generated/CosmeticInspectionReport';
export type { CosmeticValues } from './generated/CosmeticValues';
export type { CosmeticTarget } from './generated/CosmeticTarget';
export type { CosmeticPatch } from './generated/CosmeticPatch';

/**
 * The rewrite request body.
 *
 * `confirm_new_file` is `boolean` here and not the literal `true` the mirror
 * used to assert: the constraint is real but it lives in the Rust validator,
 * which rejects `false`, and no TypeScript type can be generated from a
 * runtime check.
 */
export type { CosmeticRewriteBody as CosmeticRewriteRequest } from './generated/CosmeticRewriteBody';

export type { RewriteReport as CosmeticRewriteReport } from './generated/RewriteReport';
export type { BackendReport } from './generated/BackendReport';
export type { PatchRewriteReport } from './generated/PatchRewriteReport';
export type { FieldHit } from './generated/FieldHit';
export type { CosmeticRewriteResponse } from './generated/CosmeticRewriteResponse';
export type { CosmeticCatalogItemDto as CosmeticCatalogItem } from './generated/CosmeticCatalogItemDto';
export type { CosmeticPaintKitDto as CosmeticPaintKit } from './generated/CosmeticPaintKitDto';
export type { CosmeticCatalogDto as CosmeticCatalog } from './generated/CosmeticCatalogDto';

/**
 * A saved cosmetic plan.
 *
 * `patches` is `JsonValue` and not `CosmeticPatch[]`: storage keeps the
 * document as `serde_json::Value`, so the *mirror* was more precise than the
 * server. Narrow it with `CosmeticPatch[]` at the point of use until the Rust
 * field is tightened.
 */
export type { CosmeticPlan } from './generated/CosmeticPlan';

/* ── match analysis ───────────────────────────────────────────────────────── */

export type { PlayerStats } from './generated/PlayerStats';
export type { TeamSummary } from './generated/TeamSummary';
export type { EventKind } from './generated/EventKind';
export type { TimelineEvent } from './generated/TimelineEvent';
export type { RoundSummary as AnalysisRoundRecord } from './generated/RoundSummary';
export type { HighlightKind } from './generated/HighlightKind';
export type { Highlight as AnalysisHighlightRecord } from './generated/Highlight';
export type { InsightCapability as InsightCapabilityRecord } from './generated/InsightCapability';
export type { CountedItem as CountedItemRecord } from './generated/CountedItem';
export type { TeamPurchaseInsight as TeamPurchaseInsightRecord } from './generated/TeamPurchaseInsight';
export type { RoundEconomyInsight as RoundEconomyInsightRecord } from './generated/RoundEconomyInsight';
export type { PlayerUtilityInsight as PlayerUtilityInsightRecord } from './generated/PlayerUtilityInsight';
export type { PlayerMatchupInsight as PlayerMatchupInsightRecord } from './generated/PlayerMatchupInsight';
export type { AnalysisInsightAvailability } from './generated/AnalysisInsightAvailability';
export type { AnalysisInsights as AnalysisInsightsRecord } from './generated/AnalysisInsights';
export type { MatchAnalysis as MatchAnalysisRecord } from './generated/MatchAnalysis';

export type { AnalysisRunStatus } from './generated/AnalysisRunStatus';
export type { AnalysisRunStage } from './generated/AnalysisRunStage';
export type { AnalysisRunEventCode } from './generated/AnalysisRunEventCode';
export type { AnalysisRun } from './generated/AnalysisRun';
export type { AnalysisRunEvent } from './generated/AnalysisRunEvent';
export type { AnalysisRunDetail } from './generated/AnalysisRunDetail';

export type { ReviewScope as LlmReviewScope } from './generated/ReviewScope';
export type { ReviewTone as LlmReviewTone } from './generated/ReviewTone';
export type { LlmReviewRequest } from './generated/LlmReviewRequest';
export type { LlmReviewResult } from './generated/LlmReviewResult';

/* ── replay, heat points, radar ───────────────────────────────────────────── */

export type { ReplayInputState } from './generated/ReplayInputState';
export type { ReplayPlayer as ReplayPlayerRecord } from './generated/ReplayPlayer';
export type { ReplayProjectile as ReplayProjectileRecord } from './generated/ReplayProjectile';
export type { ReplayBomb as ReplayBombRecord } from './generated/ReplayBomb';
export type { ReplayFrame as ReplayFrameRecord } from './generated/ReplayFrame';
export type { ReplayCacheState } from './generated/ReplayCacheState';
export type { ReplayCacheMetadata } from './generated/ReplayCacheMetadata';
export type { ReplayFidelityMode } from './generated/ReplayFidelityMode';
export type { ReplayFidelityMetadata } from './generated/ReplayFidelityMetadata';
export type { ReplayPayload } from './generated/ReplayPayload';
export type { ReplayCacheStatus } from './generated/ReplayCacheStatus';
export type { ReplayCacheCleanup } from './generated/ReplayCacheCleanup';
export type { HeatPoint as HeatPointRecord } from './generated/HeatPoint';

/**
 * The radar calibration for one map. `image_url` addresses this service's own
 * radar route, so the client never fetches a third-party image.
 */
export type { RadarMetadataResponse as RadarOverviewRecord } from './generated/RadarMetadataResponse';
export type { RadarTransformResponse } from './generated/RadarTransformResponse';

/* ── players and lineups ──────────────────────────────────────────────────── */

export type { SteamProfileState } from './generated/SteamProfileState';
export type { PlayerSteamProfile } from './generated/PlayerSteamProfile';
export type { PlayerAggregateStats } from './generated/PlayerAggregateStats';
export type { PlayerDirectoryItem } from './generated/PlayerDirectoryItem';
export type { PlayerMatch } from './generated/PlayerMatch';
export type { PlayerProjectionCoverage } from './generated/PlayerProjectionCoverage';
export type { PlayerDirectoryPage } from './generated/PlayerDirectoryPage';
export type { PlayerMatchPage } from './generated/PlayerMatchPage';
export type { PlayerMapItem } from './generated/PlayerMapItem';
export type { PlayerMapPage } from './generated/PlayerMapPage';
export type { PlayerHeatmapKind } from './generated/PlayerHeatmapKind';
export type { PlayerHeatmapPoint } from './generated/PlayerHeatmapPoint';
export type { PlayerHeatmap } from './generated/PlayerHeatmap';
export type { PlayerComparison } from './generated/PlayerComparison';
export type { PlayerProfile } from './generated/PlayerProfile';
export type { AvatarCacheStatus } from './generated/AvatarCacheStatus';
export type { AvatarCacheCleanup } from './generated/AvatarCacheCleanup';

export type { LineupProjectionCoverage } from './generated/LineupProjectionCoverage';
export type { LineupDirectoryItem } from './generated/LineupDirectoryItem';
export type { LineupDirectoryPage } from './generated/LineupDirectoryPage';

/**
 * One map a lineup played.
 *
 * `team_slot` was `string` here for as long as `crates/storage` declared the
 * column as one — the schema's `CHECK(team_slot IN ('A', 'B'))` closed the set
 * in SQLite and nowhere else, so an exhaustive client switch was unsound. It is
 * `TeamSlot` now and a switch over the two is sound.
 */
export type { TeamSlot } from './generated/TeamSlot';
export type { LineupMapItem } from './generated/LineupMapItem';
export type { LineupMapPage } from './generated/LineupMapPage';

/* ── recording ────────────────────────────────────────────────────────────── */

export type { HlaeCameraStyle } from './generated/HlaeCameraStyle';
export type { RecordingVoicePolicy } from './generated/RecordingVoicePolicy';
export type { RecordingPresentation } from './generated/RecordingPresentation';

/**
 * One shot of a recording plan.
 *
 * `id` is nullable: Rust holds `Option<Uuid>` and
 * `RecordingJob::retryable_suffix` reasons explicitly about the `None` case
 * ("published recording request has no durable identity").
 */
export type { RecordingRequest } from './generated/RecordingRequest';
export type { RecordingPlanResponse } from './generated/RecordingPlanResponse';
export type { DirectorShotKind } from './generated/DirectorShotKind';
export type { DirectorShot } from './generated/DirectorShot';
export type { DirectorPlan } from './generated/DirectorPlan';

/*
 * The pre-recording check list — the first group to come from `generated/`
 * rather than from a hand-kept mirror.
 *
 * `blocking` is the number of `blocked` rows and is server-computed. Its
 * contract is one sentence: **while `blocking > 0` the start-recording action
 * is disabled.** A warning never disables it.
 */

/**
 * A saved set of shot settings, behind the shot inspector's "save as preset".
 *
 * Deliberately not `EditorPreset`, which is a multi-track editor clip preset
 * bound to a project revision and shares no field with this one.
 */

export type { JobStatus } from './generated/JobStatus';
export type { RecordingExecutionResponse } from './generated/RecordingExecutionResponse';

/** The domain record a recording job produces. Application's list DTO adds
 * `map_name` and `stream_url` on top of it — that one is `RecordedClipRecord`. */
export type { RecordedClip as RecordingJobOutput } from './generated/RecordedClip';
export type { RecordingJob } from './generated/RecordingJob';

/* ── the HLAE camera plan ─────────────────────────────────────────────────── */

/*
 * The whole camera-plan subtree, which the mirror used to type away as
 * `unknown`. Every per-frame coordinate an HLAE proposal preview carries is
 * described here. Note the spelling: this subtree is camelCase on the wire
 * while every REST DTO around it is snake_case.
 */
export type { HlaePlan } from './generated/HlaePlan';
export type { HlaePlanMode } from './generated/HlaePlanMode';
export type { CaptureSettings } from './generated/CaptureSettings';
export type { CaptureLayers } from './generated/CaptureLayers';
export type { HlaeScenePresentation } from './generated/HlaeScenePresentation';
export type { HlaeRadarVisibility } from './generated/HlaeRadarVisibility';
export type { HlaeHudVisibility } from './generated/HlaeHudVisibility';
export type { HlaeVoicePolicy } from './generated/HlaeVoicePolicy';
export type { CameraShot } from './generated/CameraShot';
export type { CameraKeyframe } from './generated/CameraKeyframe';
export type { CameraPosition } from './generated/CameraPosition';
export type { CameraRotation } from './generated/CameraRotation';
export type { PositionInterpolation } from './generated/PositionInterpolation';
export type { RotationInterpolation } from './generated/RotationInterpolation';
export type { CompiledHlaePlan } from './generated/CompiledHlaePlan';
export type { GeneratedArtifact } from './generated/GeneratedArtifact';
export type { HlaeNotice } from './generated/HlaeNotice';
export type { HlaeNoticeCode } from './generated/HlaeNoticeCode';

/* ── activity feed ────────────────────────────────────────────────────────── */

/**
 * The activity discriminators.
 *
 * These were the client's own unions over fields Rust typed as `&'static str`,
 * with a note that the server did not guarantee them. It does now: they are
 * serde enums in `crates/application/src/routes/activity.rs`, generated like
 * the query-side filters beside them.
 *
 * `ActivityStatus` is a superset of the three pipelines' own status enums —
 * `JobStatus` plus the transfer states — flattened for one feed.
 */
export type { ActivityKind } from './generated/ActivityKind';
export type { ActivityStatus } from './generated/ActivityStatus';
export type { ActivityAction } from './generated/ActivityAction';
export type { ActivityUnit } from './generated/ActivityUnit';

export type { ActivityKindFilter } from './generated/ActivityKindFilter';
export type { ActivityStateFilter } from './generated/ActivityStateFilter';
export type { ActivityItem } from './generated/ActivityItem';
export type { ActivityFailure } from './generated/ActivityFailure';
export type { JobFailureCode } from './generated/JobFailureCode';
export type { ActivitySummary } from './generated/ActivitySummary';
export type { ActivityFeed } from './generated/ActivityFeed';
export type { ActivityQuery } from './generated/ActivityQuery';

/* ── runtime state and demo playback ──────────────────────────────────────── */

export type { RuntimeStateResponse as RuntimeState } from './generated/RuntimeStateResponse';
export type { DemoPlaybackRequest as DemoPlaybackOptions } from './generated/DemoPlaybackRequest';

/*
 * The four playback responses were hand-written until the port grew structs
 * for them. The routes still answer `Json<serde_json::Value>` — the port's
 * `request(name, Value) -> Value` dispatch is a separate design question — but
 * that `Value` can now only be built by serialising a struct, so a renamed key
 * turns this diff red instead of silently disagreeing with the client.
 */

export type { DemoPlaybackStatus } from './generated/DemoPlaybackStatus';
export type { DemoPlaybackPreflight } from './generated/DemoPlaybackPreflight';
export type { DemoPlaybackLaunch } from './generated/DemoPlaybackLaunch';
export type { DemoPlaybackStop } from './generated/DemoPlaybackStop';

/* ── recorded clips, montage, editor, outputs ─────────────────────────────── */

/** The media-route clip row: domain's `RecordedClip` plus `map_name` and the
 * service-owned `stream_url`. */
export type { RecordedClipDto as RecordedClipRecord } from './generated/RecordedClipDto';

export type { WaveformResponse } from './generated/WaveformResponse';
export type { ExportJob } from './generated/ExportJob';
export type { ExportJobRecord } from './generated/ExportJobRecord';
export type { ProjectRenderPreviewCleanup } from './generated/ProjectRenderPreviewCleanup';
export type { CreateNestedSequenceRequest } from './generated/CreateNestedSequenceRequest';
export type { CreateNestedSequenceResponse } from './generated/CreateNestedSequenceResponse';
export type { NestedSequenceMedia } from './generated/NestedSequenceMedia';
export type { NestedSequenceMediaStatus } from './generated/NestedSequenceMediaStatus';
export type { RefreshNestedSequenceRequest } from './generated/RefreshNestedSequenceRequest';
export type { RefreshNestedSequenceResponse } from './generated/RefreshNestedSequenceResponse';
export type { CreateMulticamRequest } from './generated/CreateMulticamRequest';
export type { MulticamEditResponse } from './generated/MulticamEditResponse';
export type { MulticamSyncMethod } from './generated/MulticamSyncMethod';
export type { SwitchMulticamAngleRequest } from './generated/SwitchMulticamAngleRequest';

export type { OutputKind } from './generated/OutputKind';
export type { OutputAvailability } from './generated/OutputAvailability';
export type { OutputItemDto as OutputItem } from './generated/OutputItemDto';
export type { OutputMediaInfo } from './generated/OutputMediaInfo';
export type { OutputListQuery as OutputQuery } from './generated/OutputListQuery';
export type { OutputPageDto as OutputPage } from './generated/OutputPageDto';
export type { DeleteOutputResult } from './generated/DeleteOutputResult';
export type { OutputReference } from './generated/OutputReference';
export type { BatchDeleteItemResult } from './generated/BatchDeleteItemResult';
export type { BatchDeleteResponse as BatchDeleteOutputResult } from './generated/BatchDeleteResponse';
export type { CleanupMissingResponse as CleanupMissingOutputsResult } from './generated/CleanupMissingResponse';
export type { CleanupStagedResponse as CleanupStagedOutputsResult } from './generated/CleanupStagedResponse';

export type { Transform } from './generated/Transform';
export type { TextStyle } from './generated/TextStyle';
export type { EditorEffect } from './generated/EditorEffect';
export type { EditorKeyframeProperty } from './generated/EditorKeyframeProperty';
export type { EditorKeyframeInterpolation } from './generated/EditorKeyframeInterpolation';
export type { EditorKeyframe } from './generated/EditorKeyframe';
export type { EditorSpeedSegment } from './generated/EditorSpeedSegment';
export type { TrackKind } from './generated/TrackKind';
export type { EditorMarker } from './generated/EditorMarker';

export type { MediaProxyStatus } from './generated/MediaProxyStatus';
export type { MediaMetadataStatus } from './generated/MediaMetadataStatus';
export type { MediaAsset } from './generated/MediaAsset';
export type { ProxyCleanupResponse as MediaProxyCleanup } from './generated/ProxyCleanupResponse';

/* ── configuration ────────────────────────────────────────────────────────── */

export type { SteamConfig } from './generated/SteamConfig';
export type { LlmConfig } from './generated/LlmConfig';
export type { LlmParameterStyle } from './generated/LlmParameterStyle';
export type { RecordingDefaults } from './generated/RecordingDefaults';
export type { ConfigDto as AppConfig } from './generated/ConfigDto';

/** `/api/llm/test`. */
export type { LlmTestResult } from './generated/LlmTestResult';
export type { LlmCapabilities } from './generated/LlmCapabilities';
export type { LlmProtocol } from './generated/LlmProtocol';

/* ── HLAE integration status ──────────────────────────────────────────────── */

/**
 * `/api/hlae/status`.
 *
 * This is application's `ManagedHlaeStatusDto`, which re-nests the three
 * safety booleans under `safety_boundary`. Domain's own `HlaeStatus` — the one
 * `HlaeProposalPreview.installation_status` carries — keeps those three flat
 * at the top level and is re-exported below as `HlaeInstallationStatus`. Two
 * different shapes; do not read `safety_boundary` off the flat one.
 */
export type { ManagedHlaeStatusDto as HlaeStatus } from './generated/ManagedHlaeStatusDto';
export type { HlaeSafetyBoundaryDto } from './generated/HlaeSafetyBoundaryDto';
export type { ManagedHlaeReleaseStatus } from './generated/ManagedHlaeReleaseStatus';

/** Domain's flat installation status, as embedded in an HLAE proposal preview. */
export type { HlaeStatus as HlaeInstallationStatus } from './generated/HlaeStatus';

/**
 * The bundle the desktop shell hands to HLAE.
 *
 * Hand-written because its only definition is
 * `apps/desktop/src-tauri/src/hlae_output.rs`, which is outside the ts-rs
 * wiring. It is also the one type here with camelCase keys, for the same
 * reason.
 */
export type HlaeBundleHandoff = {
  directory: string;
  files: string[];
  completionMarker: string;
  createdAtEpochMs: number;
};

/* ── Steam match history ──────────────────────────────────────────────────── */

export type { MatchHistoryResult } from './generated/MatchHistoryResult';
export type { MatchDemoStatus } from './generated/MatchDemoStatus';
export type { SteamMatchRecord as MatchHistoryItem } from './generated/SteamMatchRecord';
export type { MatchDownloadStatus } from './generated/MatchDownloadStatus';
export type { MatchDownloadJob } from './generated/MatchDownloadJob';

/** The share-code sync summary. */
export type { MatchHistorySyncResult } from './generated/MatchHistorySyncResult';

/**
 * The crash-recovery marker.
 *
 * Note that `crates/platform-windows/src/backup.rs` has a `RecoveryStatus` of
 * its own with a different shape and no `Serialize`; this is not it.
 */
export type { RecoveryStatus } from './generated/RecoveryStatus';

/* ── errors ───────────────────────────────────────────────────────────────── */

/**
 * The error envelope every route answers with.
 *
 * All three fields are always present and `detail` is a plain string or null.
 * `ApiProblem` is the historical name for it.
 */
export type { ErrorBody } from './generated/ErrorBody';
export type { ErrorBody as ApiProblem } from './generated/ErrorBody';

/* ── the streaming Agent chat command ─────────────────────────────────────── */

/*
 * These reach the renderer through the Tauri `agent_chat` command, not through
 * `/api/agent/...`. `apps/desktop/src-tauri` derives `TS` now, so they are
 * generated like everything else — under a `Desktop` prefix, because two of
 * them (`AgentProposal`, `AgentToolCall`) collide with `crates/domain` types of
 * the same name and a different shape. The prefix is the honest distinction:
 * the domain pair is the persisted session, this pair is the streaming chat.
 *
 * `src-tauri` also had its own copy of `AgentMode` with the same three
 * variants, which is the drift this file's previous note warned about. It is
 * gone; the command takes `vibe_cs_agent::AgentMode` directly.
 */

export type { AgentMode } from './generated/AgentMode';

export type { DesktopAgentStatus as AgentStatus } from './generated/DesktopAgentStatus';
export type { AgentToolCall } from './generated/AgentToolCall';
export type { AgentToolCallStatus } from './generated/AgentToolCallStatus';
export type { DesktopAgentToolCallStarted as AgentToolCallStarted } from './generated/DesktopAgentToolCallStarted';
export type { DesktopAgentChatInput as AgentChatInput } from './generated/DesktopAgentChatInput';
export type { DesktopAgentWorkspaceContext as AgentWorkspaceContext } from './generated/DesktopAgentWorkspaceContext';
export type { DesktopAgentEvent as AgentEvent } from './generated/DesktopAgentEvent';
export type { DesktopAgentChatResult as AgentChatResult } from './generated/DesktopAgentChatResult';
export type { DesktopAgentCommandError as AgentCommandError } from './generated/DesktopAgentCommandError';

/**
 * One proposal the model emitted, as it arrives on the stream.
 *
 * `kind` used to be `string` here, and this comment used to say that closing it
 * belonged in `crates/agent` rather than at this hop. It does, and it happened:
 * `CapturedPlanKind` is the enum, minted by the four tool handlers, and both
 * this type and `CapturedPlan` carry it.
 */

/* ── the Agent session layer (spec §4.6) ──────────────────────────────────── */

/*
 * Reached through `/api/agent/...`, not through a Tauri command, and
 * deliberately separate from the transient `AgentEvent` stream above.
 *
 * Rust calls the two entry payloads `AgentToolCall` and `AgentProposal`; this
 * application has always called them `AgentSessionToolCall` and
 * `AgentSessionProposal` to keep them apart from the streaming pair. The alias
 * is what keeps that distinction visible.
 */

export type { AgentTurnStatus } from './generated/AgentTurnStatus';
export type { AgentTurnMetadata } from './generated/AgentTurnMetadata';
export type { AgentTurnUpdate } from './generated/AgentTurnUpdate';
export type { AgentToolDecisionKind } from './generated/AgentToolDecisionKind';

export type { AgentSessionEntry } from './generated/AgentSessionEntry';
export type { AgentSessionEntryDraft } from './generated/AgentSessionEntryDraft';
export type { AgentSession } from './generated/AgentSession';
export type { AgentSessionSummary } from './generated/AgentSessionSummary';
export type { AgentSessionPage } from './generated/AgentSessionPage';
export type { AgentSessionQuery } from './generated/AgentSessionQuery';


export type { AgentSessionRetention } from './generated/AgentSessionRetention';
export type { AgentWorkspaceSettings } from './generated/AgentWorkspaceSettings';
export type { CommentaryTone } from './generated/CommentaryTone';
export type { AgentSessionStorageStats } from './generated/AgentSessionStorageStats';
export type { AgentSessionExport } from './generated/AgentSessionExport';
export type { AgentSessionPurge } from './generated/AgentSessionPurge';

/**
 * The "currently in progress" reference picker.
 *
 * `WorkspaceReference.kind` is `string`: its own Rust doc comment calls it "the
 * persisted `AgentObjectKind` discriminator", but the field is declared
 * `&'static str`. Compare it against `AgentObjectKind` values rather than
 * switching exhaustively.
 */

/* ── audio intelligence ───────────────────────────────────────────────────── */

export type { AudioBeat } from './generated/AudioBeat';
export type { AudioOnset } from './generated/AudioOnset';
export type { AudioEnergyPoint } from './generated/AudioEnergyPoint';
export type { AudioSection } from './generated/AudioSection';
export type { AudioAnalysis } from './generated/AudioAnalysis';
export type { AudioAnalysisOptions } from './generated/AudioAnalysisOptions';
export type { BeatAlignmentClip } from './generated/BeatAlignmentClip';
export type { BeatAlignmentOptions } from './generated/BeatAlignmentOptions';
export type { BeatAlignmentRequest } from './generated/BeatAlignmentRequest';
export type { BeatAlignedClip } from './generated/BeatAlignedClip';

/**
 * A beat-alignment draft.
 *
 * `advisory_only` is `boolean` rather than the literal `true` the mirror
 * asserted: `apply_beat_alignment_draft` rejects `false` at runtime, and that
 * is where the constraint lives.
 */
export type { BeatAlignmentDraft } from './generated/BeatAlignmentDraft';

/* ── the raw JSON value ───────────────────────────────────────────────────── */

/** What ts-rs emits for `serde_json::Value`. Strictly narrower than `unknown`. */
export type { JsonValue } from './generated/serde_json/JsonValue';
