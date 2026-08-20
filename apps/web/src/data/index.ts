/**
 * data layer — TanStack Query over the desktop IPC bridge (spec §4.1).
 *
 * The whole of `pages/**` and `domain/**` reaches the service through this
 * barrel; §2.1 rule 6 forbids them from importing `shared/desktop/client`
 * directly, so that no cache invalidation can be bypassed.
 *
 * Shape of the layer:
 *
 *   queryClient.ts   the §4.1 defaults
 *   keys.ts          every query key, and the invalidation predicates
 *   desktopClient.tsx the injectable seam between the hooks and Tauri
 *   queryTuning.ts   `enabled` / `pollMs`, the two knobs a caller may turn
 *   errors.ts        a rejected query, in a shape a Notice can render
 *   health.ts        the local-service probe `app/boundary/ServiceGate` calls
 *   demos / players / evidence / tasks / outputs / config — one file per domain
 *
 * `sessions.ts`, `plans.ts` and `editNotifier.ts` are phase 3e (§4.5): their
 * models are settled with the backend first. `keys.ts` reserves the namespaces.
 */

export { createQueryClient, queryClient } from './queryClient';

export {
  QUERY_NAMESPACE,
  isKeyPrefixOf,
  isServiceProbeKey,
  qk,
  refreshesOnServiceRecovery,
  type PageQuery,
  type PlayerDirectoryQuery,
  type PlayerDirectorySort,
  type PlayerHeatmapQuery,
  type QueryNamespace,
} from './keys';

export {
  DesktopClientProvider,
  useDesktopClient,
  type DesktopClient,
  type DesktopClientProviderProps,
} from './desktopClient';

export {
  resolveQueryTuning,
  type DataQueryTuning,
  type ResolvedQueryTuning,
} from './queryTuning';

export { dataErrorMessage, toDataError, type DataError } from './errors';

export { invalidateServiceHealth, probeServiceHealth, serviceHealthKey } from './health';

export {
  invalidateDemo,
  invalidateDemos,
  useDemo,
  useDemoList,
  useDemoMetadata,
  useDemoWatchStatus,
  useReviewTags,
} from './demos';

export {
  invalidatePlayer,
  invalidatePlayers,
  usePlayer,
  usePlayerDirectory,
  usePlayerHeatmap,
  usePlayerMaps,
  usePlayerMatches,
} from './players';

export {
  invalidateEvidence,
  invalidateEvidenceAnnotations,
  useEvidenceAnnotations,
  useEvidenceSearch,
} from './evidence';

export {
  invalidateTask,
  invalidateTasks,
  useActiveAnalysisRun,
  useAnalysisRun,
  useExportJob,
  useRecordingJob,
  useTask,
  useTaskFeed,
} from './tasks';

export { invalidateOutputs, useOutputList, useRecordedClips } from './outputs';

export {
  invalidateConfig,
  useAgentStatus,
  useAppConfig,
  useExportDiagnostics,
  useHlaeStatus,
  useQuickCheck,
  useRecoveryStatus,
  useRuntimeState,
  useStorageStatus,
  useUpdateAppConfig,
} from './config';
