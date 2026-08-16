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
 * Four groups, each marked where it appears:
 *
 *   1. **Untyped routes.** `DemoPlaybackStatus`, `DemoPlaybackPreflight`,
 *      `DemoPlaybackLaunch`, `DemoPlaybackStop`, `LlmTestResult`,
 *      `MatchHistorySyncResult` and `RecoveryStatus` are served as
 *      `Json<serde_json::Value>` built with `json!` in
 *      `crates/runtime/src/integration.rs`. There is no Rust structure to
 *      generate from. Each is a backend gap, not a naming problem.
 *   2. **Tauri-side types.** The streaming Agent chat contract
 *      (`AgentStatus`, `AgentMessage`, `AgentThread`, `AgentChatInput`,
 *      `AgentEvent`, `AgentChatResult`, `AgentProposal`, `AgentVideoProposal`,
 *      `AgentShotDesign`) and `HlaeBundleHandoff` live in
 *      `apps/desktop/src-tauri/src/`, which is not part of the ts-rs wiring.
 *   3. **Client-side narrowings of an untyped field.** `DependencyKind`,
 *      `DependencyState`, `ActivityKind`, `ActivityStatus` and
 *      `ActivityAction` narrow fields that Rust types as `&'static str`
 *      produced by `match` arms. The generated types say `string`, correctly.
 *      These unions are the client's own reading of the closed set and are
 *      **not** guaranteed by the server.
 *   4. **Frontend aliases.** `EntityId`.
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
 * The two setup-check discriminators.
 *
 * `crates/application/src/routes/system.rs` types both as `&'static str`
 * written by `match` arms, so `generated/DependencyCheck.ts` says `string` and
 * these unions are the client's own reading of what those arms can produce.
 * Nothing in Rust stops a new arm from being added — turning them into real
 * serde enums is the fix, and it is a backend change.
 */
export type DependencyKind = 'game';
export type DependencyState = 'ready' | 'warning' | 'missing' | 'checking';

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
 * `team_slot` is `string`, not `'A' | 'B'`: `crates/storage` declares the
 * column as `String` and nothing in Rust closes it, so an exhaustive client
 * switch over two members was unsound. Treat an unrecognized slot as unknown.
 */
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
 * ("published recording request has no durable identity"). The request side of
 * the queue is `RecordingQueueItem`, whose `id` is required.
 */
export type { RecordingRequest } from './generated/RecordingRequest';
export type { RecordingQueueItem } from './generated/RecordingQueueItem';
export type { RecordingQueueRequest } from './generated/RecordingQueueRequest';
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
export type { RecordingPreflight } from './generated/RecordingPreflight';
export type { RecordingPreflightCheck } from './generated/RecordingPreflightCheck';
export type { RecordingPreflightCode } from './generated/RecordingPreflightCode';
export type { RecordingPreflightState } from './generated/RecordingPreflightState';

/**
 * A saved set of shot settings, behind the shot inspector's "save as preset".
 *
 * Deliberately not `EditorPreset`, which is a multi-track editor clip preset
 * bound to a project revision and shares no field with this one.
 */
export type { RecordingShotPreset } from './generated/RecordingShotPreset';
export type { RecordingShotPresetDraft } from './generated/RecordingShotPresetDraft';

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
 * The three activity discriminators.
 *
 * `crates/application/src/routes/activity.rs` emits `ActivityItem.kind`,
 * `.status`, `.unit` and `.available_actions` as `&'static str` from `match`
 * arms, so `generated/ActivityItem.ts` types all four as `string`. These
 * unions are the client's reading of those arms and are not enforced by the
 * server: compare against them, never assume exhaustiveness.
 *
 * `ActivityKindFilter` and `ActivityStateFilter` are the *query* side and are
 * real serde enums, which is why those two are generated.
 */
export type ActivityKind = 'recording' | 'export' | 'download' | 'analysis';
export type ActivityStatus =
  | import('./generated/JobStatus').JobStatus
  | 'downloading'
  | 'decompressing'
  | 'importing'
  | 'analyzing';
export type ActivityAction =
  | 'cancel'
  | 'retry_analysis'
  | 'retry_download'
  | 'retry_recording'
  | 'open_analysis'
  | 'open_library'
  | 'open_match_history'
  | 'open_outputs';

export type { ActivityKindFilter } from './generated/ActivityKindFilter';
export type { ActivityStateFilter } from './generated/ActivityStateFilter';
export type { ActivityItem } from './generated/ActivityItem';
export type { ActivitySummary } from './generated/ActivitySummary';
export type { ActivityFeed } from './generated/ActivityFeed';
export type { ActivityQuery } from './generated/ActivityQuery';

/* ── runtime state and demo playback ──────────────────────────────────────── */

export type { RuntimeStateResponse as RuntimeState } from './generated/RuntimeStateResponse';
export type { DemoPlaybackRequest as DemoPlaybackOptions } from './generated/DemoPlaybackRequest';

/*
 * The four playback responses below are hand-written because there is nothing
 * to generate them from: `preflight_demo`, `play_demo` and `stop_playback` in
 * `crates/application/src/routes/demos.rs` all return
 * `Json<serde_json::Value>`, proxied verbatim from the integrations port,
 * which builds the documents with `json!` in
 * `crates/runtime/src/integration.rs`. This is a hole in the contract, not a
 * naming problem: until those three routes answer with a real struct, nothing
 * can make a change to them turn a diff red.
 */

export type DemoPlaybackStatus = {
  executable_available: boolean;
  executable: string | null;
  gsi_installed: boolean;
  gsi_fresh: boolean;
  gsi_sequence: number;
  gsi_received_at: string | null;
  map_name: string | null;
  map_phase: string | null;
  player_name: string | null;
  player_activity: string | null;
  ready_to_launch: boolean;
  gsi_ready: boolean;
  warnings: string[];
};

export type DemoPlaybackPreflight = {
  ready: true;
  executable: string;
  demo_path: string;
  launch_path: string;
  demo_size: number;
  demo_sha256: string;
  arguments: string[];
  managed_copy: boolean;
  status: DemoPlaybackStatus;
  warnings: string[];
};

export type DemoPlaybackLaunch = {
  started: true;
  process_id: number;
  demo_id: EntityId;
  preflight: DemoPlaybackPreflight;
};

export type DemoPlaybackStop = {
  stopped: true;
  process_id: number | null;
  already_stopped: boolean;
  forced_process_stop: boolean;
};

/* ── recorded clips, montage, editor, outputs ─────────────────────────────── */

/** The media-route clip row: domain's `RecordedClip` plus `map_name` and the
 * service-owned `stream_url`. */
export type { RecordedClipDto as RecordedClipRecord } from './generated/RecordedClipDto';

export type { MontageClip as MontageClipRecord } from './generated/MontageClip';
export type { MontageBrandingTheme } from './generated/MontageBrandingTheme';
export type { MontageSettings as MontageSettingsRecord } from './generated/MontageSettings';
export type { MontageProject as MontageProjectRecord } from './generated/MontageProject';
export type { CreateMontageRequest as CreateMontageProject } from './generated/CreateMontageRequest';

export type { EditorExportRequest as EditorExportOptions } from './generated/EditorExportRequest';
export type { WaveformResponse } from './generated/WaveformResponse';
export type { JobAccepted } from './generated/JobAccepted';
export type { ExportJob } from './generated/ExportJob';
export type { ExportJobRecord } from './generated/ExportJobRecord';

export type { OutputKind } from './generated/OutputKind';
export type { OutputAvailability } from './generated/OutputAvailability';
export type { OutputItemDto as OutputItem } from './generated/OutputItemDto';
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
export type { EditorKeyframe } from './generated/EditorKeyframe';
export type { EditorSpeedSegment } from './generated/EditorSpeedSegment';
export type { EditorClip as TimelineClipDto } from './generated/EditorClip';
export type { TrackKind } from './generated/TrackKind';
export type { EditorTrack as TimelineTrackDto } from './generated/EditorTrack';
export type { EditorMarker } from './generated/EditorMarker';
export type { EditorProject } from './generated/EditorProject';
export type { EditorProjectSnapshot } from './generated/EditorProjectSnapshot';
export type { CreateEditorProjectRequest as CreateEditorProject } from './generated/CreateEditorProjectRequest';
export type { EditorColorAdjustPreset } from './generated/EditorColorAdjustPreset';
export type { EditorPresetDocument } from './generated/EditorPresetDocument';
export type { EditorTransitionPreset as EditorTransitionName } from './generated/EditorTransitionPreset';
export type { PresetRecord as EditorPreset } from './generated/PresetRecord';
export type { EditorProjectDeletionResponse as EditorProjectDeletionResult } from './generated/EditorProjectDeletionResponse';

export type { MediaProxyStatus } from './generated/MediaProxyStatus';
export type { MediaMetadataStatus } from './generated/MediaMetadataStatus';
export type { MediaAsset } from './generated/MediaAsset';
export type { SeparateEditorAudioResponse as EditorAudioSeparation } from './generated/SeparateEditorAudioResponse';
export type { EditorPackageExportResponse as EditorPackageExport } from './generated/EditorPackageExportResponse';
export type { EditorPackageImportResponse as EditorPackageImport } from './generated/EditorPackageImportResponse';
export type { ProxyCleanupResponse as MediaProxyCleanup } from './generated/ProxyCleanupResponse';

/* ── configuration ────────────────────────────────────────────────────────── */

export type { SteamConfig } from './generated/SteamConfig';
export type { LlmConfig } from './generated/LlmConfig';
export type { RecordingDefaults } from './generated/RecordingDefaults';
export type { ConfigDto as AppConfig } from './generated/ConfigDto';

/**
 * `/api/llm/test`.
 *
 * Hand-written: `crates/runtime/src/integration.rs` builds this body with
 * `json!`, so there is no Rust structure to generate from. A backend gap.
 */
export type LlmTestResult = {
  ok: true;
  provider: string;
  model: string;
  capabilities: {
    protocol: 'openai_chat_completions';
    chat: true;
    stream: true;
    tools: true;
  };
};

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

/**
 * The share-code sync summary.
 *
 * Hand-written: `crates/runtime/src/integration.rs` answers with a `json!`
 * document. A backend gap.
 */
export type MatchHistorySyncResult = {
  synced: number;
  created: number;
  total: number;
  cursor_advanced: boolean;
};

/**
 * The crash-recovery marker.
 *
 * Hand-written for the same reason as `MatchHistorySyncResult`. Note that
 * `crates/platform-windows/src/backup.rs` has a `RecoveryStatus` of its own
 * with a different shape and no `Serialize`; this is not it.
 */
export type RecoveryStatus = {
  recovery_required: boolean;
  reason?: string;
  backup_created_at?: string;
  affected_files: string[];
};

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
 * `/api/agent/...`. Their Rust definitions live in
 * `apps/desktop/src-tauri/src/agent.rs`, which is outside the ts-rs wiring, so
 * everything below that is not `AgentMode` or `AgentToolCall` stays
 * hand-written. `crates/agent` holds semantically identical copies of the
 * three that are generated; a drift between the two Rust copies would still
 * not turn any diff red. Closing that needs ts-rs in `src-tauri`.
 */

export type { AgentMode } from './generated/AgentMode';
export type { CapturedToolCall as AgentToolCall } from './generated/CapturedToolCall';

export type AgentStatus = {
  runtimeAvailable: boolean;
  configured: boolean;
  provider: string;
  model: string;
  streaming: boolean;
};

/**
 * One proposal the model emitted.
 *
 * `kind` is narrowed here to the four values `crates/agent/src/tools.rs`
 * actually emits, but Rust types the field as `String` at both hops
 * (`generated/CapturedPlan.ts` says `kind: string`), so a fifth kind would
 * compile everywhere and be unrepresentable in this type. It is a closed set
 * that is not modelled as one.
 */
export type AgentProposal = {
  kind: 'highlight_edit' | 'beat_alignment' | 'hlae' | 'video_render';
  title: string;
  payload: import('./generated/serde_json/JsonValue').JsonValue;
};

export type AgentVideoProposal = {
  /**
   * Queue items, not plan items: `crates/agent/src/tools.rs` mints a fresh
   * `Uuid` for every one of them, so each carries the durable identity a
   * `RecordingRequest` read back from a plan may lack.
   */
  items: import('./generated/RecordingQueueItem').RecordingQueueItem[];
  shot_designs: AgentShotDesign[];
  output: { container: 'mp4' };
  source_highlight_ids: string[];
  requires_user_confirmation: true;
};

export type AgentShotDesign = {
  highlight_id: string;
  map_name: string | null;
  camera_intent:
    | 'player_pov'
    | 'establish_location'
    | 'follow_entry'
    | 'reveal_duel'
    | 'hold_crossfire'
    | 'rise_after_climax'
    | 'transition_through_space';
  camera_style: import('./generated/HlaeCameraStyle').HlaeCameraStyle;
  rationale: string;
  spatial_evidence: unknown;
  requires_user_review: true;
};

export type AgentMessage = {
  id: EntityId;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  toolCalls: import('./generated/CapturedToolCall').CapturedToolCall[];
  proposals: AgentProposal[];
};

export type AgentThread = {
  id: EntityId;
  messages: AgentMessage[];
  updatedAt: string;
};

export type AgentChatInput = {
  requestId: EntityId;
  threadId: EntityId | null;
  demoId: EntityId | null;
  editorProjectId: EntityId | null;
  audioAssetId: EntityId | null;
  workspaceContext: {
    workflow: 'review' | 'edit' | 'neutral';
    destination:
      | 'review'
      | 'players'
      | 'evidence'
      | 'replay'
      | 'heatmap'
      | 'edit'
      | 'queue'
      | 'studio'
      | 'outputs'
      | 'neutral';
    demoId: EntityId | null;
    projectId: EntityId | null;
    playerId: string | null;
    roundNumber: number | null;
    tick: number | null;
  };
  mode: import('./generated/AgentMode').AgentMode;
  message: string;
};

export type AgentEvent =
  | { type: 'started'; threadId: EntityId }
  | { type: 'textDelta'; delta: string }
  | { type: 'toolCall'; toolCall: import('./generated/CapturedToolCall').CapturedToolCall }
  | { type: 'proposal'; proposal: AgentProposal }
  | { type: 'complete'; thread: AgentThread }
  | { type: 'error'; message: string };

export type AgentChatResult = { thread_id: EntityId };

/* ── agent proposals: HLAE, beat alignment, highlight edit ────────────────── */

export type { ProposalPrerequisite } from './generated/ProposalPrerequisite';

/**
 * The confirmation half of every proposal apply.
 *
 * `confirm` is `boolean` and not the literal `true` the mirror asserted: the
 * server rejects `false` at runtime and no generated type can say so.
 */
export type { ProposalConfirmation } from './generated/ProposalConfirmation';

export type { HlaeProposalMode } from './generated/HlaeProposalMode';
export type { HlaeProposalIntent } from './generated/HlaeProposalIntent';

/**
 * An HLAE proposal preview.
 *
 * `typed_plan` and `compiled_preview` are `JsonValue` because the Rust fields
 * really are `Option<serde_json::Value>` — the weakness is in the Rust, not in
 * the mirror. Their contents are `HlaePlan` and `CompiledHlaePlan`, both of
 * which are now generated types above; narrow with those at the point of use.
 * Tightening the Rust field would make `crates/domain` depend on
 * `crates/hlae`, which is an architecture decision, not a binding fix.
 */
export type { HlaeProposalPreview } from './generated/HlaeProposalPreview';
export type { HlaeProposalExportResult } from './generated/HlaeProposalExportResult';

export type { BeatAlignmentAudioPlacementIntent } from './generated/BeatAlignmentAudioPlacementIntent';
export type { BeatAlignmentProposalRequest } from './generated/BeatAlignmentProposalRequest';
export type { BeatAlignmentAudioBinding } from './generated/BeatAlignmentAudioBinding';
export type { BeatAlignmentAudioPlacement } from './generated/BeatAlignmentAudioPlacement';
export type { BeatAlignmentProposalPreview } from './generated/BeatAlignmentProposalPreview';
export type { BeatAlignmentApplyResult } from './generated/BeatAlignmentApplyResult';

export type { HighlightEditPacing } from './generated/HighlightEditPacing';
export type { HighlightEditTransition } from './generated/HighlightEditTransition';
export type { HighlightEditProposalIntent } from './generated/HighlightEditProposalIntent';
export type { HighlightEditProposalRequest } from './generated/HighlightEditProposalRequest';
export type { HighlightAssetMapping } from './generated/HighlightAssetMapping';
export type { HighlightEditClipInsert } from './generated/HighlightEditClipInsert';
export type { HighlightEditPlan } from './generated/HighlightEditPlan';
export type { HighlightEditProposalPreview } from './generated/HighlightEditProposalPreview';
export type { HighlightEditApplyResult } from './generated/HighlightEditApplyResult';

/* ── the Agent session layer (spec §4.6) ──────────────────────────────────── */

/*
 * Reached through `/api/agent/...`, not through a Tauri command, and
 * deliberately separate from the `AgentThread` / `AgentMessage` /
 * `AgentProposal` shapes above.
 *
 * Rust calls the two entry payloads `AgentToolCall` and `AgentProposal`; this
 * application has always called them `AgentSessionToolCall` and
 * `AgentSessionProposal` to keep them apart from the streaming pair. The alias
 * is what keeps that distinction visible.
 */

export type { AgentObjectKind } from './generated/AgentObjectKind';
export type { AgentObjectLocator } from './generated/AgentObjectLocator';
export type { AgentObjectRef } from './generated/AgentObjectRef';
export type { AgentObjectSessionRef } from './generated/AgentObjectSessionRef';
export type { AgentObjectRefTouch } from './generated/AgentObjectRefTouch';
export type { AgentToolCall as AgentSessionToolCall } from './generated/AgentToolCall';
export type { AgentProposal as AgentSessionProposal } from './generated/AgentProposal';

export type { WorkspaceEditOperation } from './generated/WorkspaceEditOperation';
export type { WorkspaceEditAuthor } from './generated/WorkspaceEditAuthor';
export type { WorkspaceEditChange } from './generated/WorkspaceEditChange';
export type { WorkspaceEditNotice } from './generated/WorkspaceEditNotice';

export type { AgentSessionEntry } from './generated/AgentSessionEntry';
export type { AgentSessionEntryDraft } from './generated/AgentSessionEntryDraft';
export type { AgentSession } from './generated/AgentSession';
export type { AgentSessionSummary } from './generated/AgentSessionSummary';
export type { AgentSessionPage } from './generated/AgentSessionPage';
export type { AgentSessionQuery } from './generated/AgentSessionQuery';

export type { AgentPlanStatus } from './generated/AgentPlanStatus';
export type { AgentPlanAuthor } from './generated/AgentPlanAuthor';
export type { AgentShotView } from './generated/AgentShotView';
export type { AgentShotRecording } from './generated/AgentShotRecording';
export type { AgentPlanShot } from './generated/AgentPlanShot';
export type { AgentPlanOrigin } from './generated/AgentPlanOrigin';
export type { AgentPlanOriginDraft } from './generated/AgentPlanOriginDraft';
export type { AgentPlanBaseline } from './generated/AgentPlanBaseline';
export type { AgentPlan } from './generated/AgentPlan';
export type { AgentPlanCreate } from './generated/AgentPlanCreate';
export type { AgentPlanEdit } from './generated/AgentPlanEdit';
export type { AgentPlanRestore } from './generated/AgentPlanRestore';
export type { AgentPlanSummary } from './generated/AgentPlanSummary';
export type { AgentPlanQuery } from './generated/AgentPlanQuery';

export type { AgentSessionRetention } from './generated/AgentSessionRetention';
export type { AgentWorkspaceSettings } from './generated/AgentWorkspaceSettings';
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
export type { WorkspaceReference as AgentWorkspaceReference } from './generated/WorkspaceReference';
export type { WorkspaceReferences as AgentWorkspaceReferences } from './generated/WorkspaceReferences';

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
