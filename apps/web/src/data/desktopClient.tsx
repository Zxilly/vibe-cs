/**
 * data layer — the one seam between the hooks and the IPC bridge.
 *
 * `shared/desktop/client` reaches `@tauri-apps/api`'s `invoke`, which only
 * exists inside the desktop shell. Tests have no Tauri environment, so every
 * hook takes its client from this context instead of importing `commands`
 * directly, and a test tree passes a plain object of stubs. The production
 * default *is* `commands`, so `main.tsx` mounts no provider and pages notice
 * nothing.
 *
 * Why a context rather than `vi.mock('shared/desktop/client')`: the mock would
 * have to be repeated per test file, it replaces the module for the whole file
 * (including anything else that imports it), and it gives a page-level or
 * domain-level test no way to supply a backend at all. §2.1 rule 6 already
 * forbids `pages/**` and `domain/**` from importing the client, so this is the
 * only place the substitution can live.
 *
 * `DesktopClient` is `Pick<typeof commands, …>` rather than a hand-written
 * interface: it stays exactly the real signatures, and a stub that drifts from
 * the wire fails to typecheck. It lists what this layer calls today — widening
 * it is how a new hook declares its dependency, and the list is the honest
 * answer to "what does the UI actually need from the 141-method bridge".
 */

import { createContext, use, type ReactNode } from 'react';

import { commands } from '../shared/desktop/client';

export type DesktopClient = Pick<
  typeof commands,
  // service
  | 'health'
  // demos
  | 'listDemos'
  | 'getDemo'
  | 'getDemoMetadata'
  | 'getDemoWatchStatus'
  | 'listReviewTags'
  // match history
  | 'listMatchHistory'
  | 'listActiveMatchDownloadJobs'
  // players
  | 'listPlayers'
  | 'getPlayer'
  | 'listPlayerMatches'
  | 'listPlayerMaps'
  | 'getPlayerHeatmap'
  // evidence
  | 'searchEvidence'
  | 'listEvidenceAnnotations'
  // tasks
  | 'listActivities'
  | 'getActivity'
  | 'getRecordingJob'
  | 'getExportJob'
  | 'getAnalysisRun'
  | 'getActiveAnalysisRun'
  // outputs
  | 'listOutputs'
  | 'listRecordedClips'
  | 'listRecordedClipRecords'
  | 'listExportJobs'
  // config
  | 'getConfig'
  | 'updateConfig'
  | 'quickCheck'
  | 'storageStatus'
  | 'getHlaeStatus'
  | 'prepareManagedHlae'
  | 'recoveryStatus'
  | 'runtimeState'
  /* ── writes ──
     Added in phase 3. Each name below is called by exactly one hook in this
     layer; the grouping matches the file that owns it. Three files declared
     their own `Pick` slices while phase 3 ran in parallel — they could not edit
     this shared file — and folding them back here is what removes both the
     duplicate types and `demos.ts`'s `as unknown as` narrowing. */
  // demos (data/demos.ts)
  | 'importDemoPaths'
  | 'importDemos'
  | 'scanDemos'
  | 'rescanDemoWatch'
  | 'updateDemo'
  | 'updateDemoMetadata'
  | 'updateDemoMetadataBatch'
  | 'deleteDemo'
  | 'createReviewTag'
  | 'updateReviewTag'
  | 'deleteReviewTag'
  | 'playDemo'
  // tasks (data/tasks.ts)
  | 'cancelRecordingJob'
  | 'cancelExportJob'
  | 'cancelAnalysisRun'
  | 'cancelMatchDownload'
  | 'planRecordingRetry'
  | 'startAnalysisRun'
  | 'downloadMatchDemo'
  // outputs (data/outputs.ts)
  | 'deleteOutput'
  | 'cleanupMissingOutputs'
  | 'cleanupStagedOutputs'
  /* 恢复中心 (phase 3g). `recoveryStatus` was already read by
     `useRecoveryStatus`; the restore that acts on it was not reachable. */
  | 'recoverConfiguration'
  | 'exportDiagnostics'
  | 'patchRecordedClip'
  | 'deleteRecordedClip'
  | 'listMediaAssets'
  | 'getMediaAsset'
  | 'importMediaAsset'
  | 'relinkMediaAsset'
  | 'deleteMediaAsset'
  | 'replaceMediaAssetMarkers'
  | 'extractAssetAudio'
  | 'generateMediaProxy'
  | 'cleanupMediaProxies'
  | 'analyzeAudioAsset'
  /* ── match workspace (data/match.ts) ──
     Added in phase 3c. `getAnalysis` is the one read all nine §7 views share;
     the rest are the reads a single view needs, plus the three annotation
     writes §10.4 gap 16 left disabled once this `Pick` was widened. */
  | 'getAnalysis'
  | 'getHeatmap'
  | 'getRadarOverview'
  | 'getReplayBinary'
  | 'getRoundReviewMetadata'
  | 'updateRoundReviewMetadata'
  | 'createEvidenceAnnotation'
  | 'updateEvidenceAnnotation'
  | 'deleteEvidenceAnnotation'
  | 'reviewDemo'
  /* ── Agent sessions (data/sessions.ts) ──
     Added in phase 3e. These are the §4.6 contract routes, which landed on the
     backend before this phase started, so nothing here is an adapter and no
     part of the session model is kept in browser storage. */
  | 'listAgentSessions'
  | 'createAgentSession'
  | 'getAgentSession'
  | 'renameAgentSession'
  | 'deleteAgentSession'
  | 'appendAgentSessionEntry'
  | 'updateAgentTurn'
  | 'getAgentWorkspaceSettings'
  | 'updateAgentWorkspaceSettings'
  | 'getAgentSessionStorage'
  | 'exportAgentSessions'
  | 'clearAgentSessions'
  | 'applyAgentSessionRetention'
  /* 设置 › AI 与 Agent › 模型 is `AppConfig.llm` (data/config.ts) plus this one
     probe, which is 「测试连接」 on the artboard. */
  | 'testLlm'
  /* The streaming half. `streamAgentChat` is the one Tauri `Channel` command in
     the whole bridge (§4.7), so it is the one read this layer does not express
     as a query — see `data/sessions.ts`, 「流式期间 data/ 怎么表达」. */
  | 'agentStatus'
  | 'streamAgentChat'
  | 'cancelAgentChat'
  /* Canonical Project editing. Human controls and Agent Operations share
     this route family; no Plan/Montage/Editor write is exposed here once its
     caller moves. */
  | 'listProjects'
  | 'getProject'
  | 'getProjectDeliveryGate'
  | 'createProject'
  | 'createProjectRecordingPlan'
  | 'exportProject'
  | 'listProjectRenderPreviews'
  | 'renderProjectPreview'
  | 'clearProjectRenderPreviews'
  | 'listNestedSequenceMedia'
  | 'createNestedSequence'
  | 'refreshNestedSequence'
  | 'createMulticam'
  | 'switchMulticamAngle'
  | 'applyProjectPatch'
  | 'listProjectChangeGroups'
  | 'revertProjectChangeGroup'
  | 'getProjectEditLease'
  | 'acquireProjectEditLease'
  | 'heartbeatProjectEditLease'
  | 'releaseProjectEditLease'
  /* ── recording shot presets (phase 3f, 「08 录制计划与镜头预览」) ──
     `/api/recording/shot-presets`, behind the shot inspector's 「存为预设」.
     There is no `expected_revision` anywhere in this group: nothing on the
     server dereferences a preset id, so a preset has no revision to pin. */
  /* ── pre-recording checks (phase 3f, 「08 录制计划与镜头预览」) ──
     `POST /api/recording/plans/{id}/preflight`, the closed check list behind
     the eight status rows at the bottom of the board. A write in the HTTP sense
     only: it measures, never mutates the plan lease. */
  /* ── the recording plan lifecycle (phase 3f, 「08 录制计划与镜头预览」) ──
     `planRecording` mints the 5-minute lease from a hand-built queue; the two
     other doors onto the same document (`planRecordingFromAgentPlan`,
     `planRecordingRetry`) are already listed above.

     `executeRecordingPlan` is the **only** command in this whole `Pick` that
     launches CS2. §4.5.3 rule ① — 「录制只由一次显式确认启动」 — is enforced
     three deep: it is reachable through exactly one hook
     (`useExecuteRecordingPlan`), that hook demands a branded confirmation value
     no query can produce, and `recording.interaction.test.tsx` walks the stub to
     prove no read path touches it.

     `abortRecording` is 「停止这次录制？」's second half — a process-level stop
     that exists beside `cancelRecordingJob` because a wedged CS2 outlives the
     job record. */
  | 'executeRecordingPlan'
  | 'abortRecording'
  /* ── 「在游戏里预览」 (phase 3f, 「08」) ──
     The recovery action behind the `camera_collision_unverified` warning: the
     preflight row says a camera path cannot be checked against map geometry
     *until it has been previewed in game*, so the page has to be able to offer
     that. `previewHlaeProposal` compiles the path and reports prerequisites,
     `exportHlaeProposal` writes the script files, and the playback trio starts
     and stops the Demo they were written for. Nothing here records. */
  | 'preflightDemo'
  | 'stopPlayback'
  | 'playbackStatus'
  /* ── beat suggestions and peaks (phase 3f, 「09 快速合辑」) ──
     `alignClipsToBeats` is 「节拍建议」. It is a pure computation over beats and
     clip durations — it takes no project id and writes nothing — which is what
     makes 「节拍建议不会直接修改工程，应用前可逐条预览」 true by construction
     rather than by discipline. The proposal preview/apply routes are also
     exposed for the Agent confirmation card; they preserve the same signed
     preview boundary before a write.

     The two waveform reads back 「low-orbit.mp3 · 128 BPM」's picture and the
     per-clip strips; `analyzeAudioAsset` above supplies the beats themselves. */
  | 'alignClipsToBeats'
  | 'getAssetWaveform'
  | 'getRecordedClipWaveform'
>;

/**
 * What a test hands to `DesktopClientProvider`. Every test stubs a handful of
 * methods, never all of them, so the partial is the shape they actually build —
 * declared once here rather than per data module.
 */
export type DesktopClientStub = Partial<DesktopClient>;

const DesktopClientContext = createContext<DesktopClient>(commands);

export interface DesktopClientProviderProps {
  client: DesktopClient;
  children: ReactNode;
}

/**
 * Overrides the bridge for the tree below. Only tests and stories mount it —
 * in the app the default is already the real client, which is why there is no
 * "provider missing" throw here the way `useService()` has one: the default is
 * correct, not a placeholder.
 */
export function DesktopClientProvider({ client, children }: DesktopClientProviderProps) {
  return <DesktopClientContext.Provider value={client}>{children}</DesktopClientContext.Provider>;
}

export function useDesktopClient(): DesktopClient {
  return use(DesktopClientContext);
}
