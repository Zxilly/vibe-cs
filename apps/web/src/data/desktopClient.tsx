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
 * the wire fails to typecheck. It lists only what this layer reads today —
 * widening it is how a new hook declares its dependency.
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
>;

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
