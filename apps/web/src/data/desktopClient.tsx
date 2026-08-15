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
  // config
  | 'getConfig'
  | 'updateConfig'
  | 'quickCheck'
  | 'storageStatus'
  | 'getHlaeStatus'
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
  | 'touchAgentObjectRef'
  | 'listAgentObjectSessions'
  | 'listAgentWorkspaceReferences'
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
  /* ── Agent plans (data/plans.ts) ──
     `applyAgentPlanEdit` is the conditional write that carries the manual edit,
     bumps the revision and injects the `workspace_edit` notice in one
     transaction (§10 deviation 5). There is no separate notify route. */
  | 'listAgentPlans'
  | 'getAgentPlan'
  | 'createAgentPlan'
  | 'applyAgentPlanEdit'
  | 'restoreAgentPlanBaseline'
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
