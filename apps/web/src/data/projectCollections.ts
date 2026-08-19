import { useSyncExternalStore } from 'react';

export type CollectedClipKind = 'highlight' | 'round' | 'evidence' | 'player' | 'selection';

export interface ProjectCollectedClip {
  readonly id: string;
  readonly demoId: string;
  readonly matchLabel: string;
  readonly kind: CollectedClipKind;
  readonly label: string;
  readonly round: number | null;
  readonly playerId: string | null;
  readonly highlightId: string | null;
  readonly evidenceId: string | null;
  readonly startTick: number | null;
  readonly endTick: number | null;
  readonly addedAt: string;
}

export type ProjectCollectionState = Readonly<Record<string, readonly ProjectCollectedClip[]>>;

const STORAGE_KEY = 'vibe-cs.project-collections.v1';
const EMPTY: ProjectCollectionState = {};
let snapshot: ProjectCollectionState | null = null;
const listeners = new Set<() => void>();

function readSnapshot(): ProjectCollectionState {
  if (snapshot !== null) return snapshot;
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) snapshot = EMPTY;
    else {
      const parsed: unknown = JSON.parse(raw);
      snapshot = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as ProjectCollectionState
        : EMPTY;
    }
  } catch {
    snapshot = EMPTY;
  }
  return snapshot;
}

function writeSnapshot(next: ProjectCollectionState): void {
  snapshot = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The desktop webview can deny storage; the in-memory collection still
    // keeps the current session usable instead of turning the action into a no-op.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useProjectCollections() {
  const state = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
  return {
    state,
    add: addProjectCollectedClip,
    remove: removeProjectCollectedClip,
  };
}

export function addProjectCollectedClip(projectId: string, clip: ProjectCollectedClip): void {
  const state = readSnapshot();
  const current = state[projectId] ?? [];
  const next = [...current.filter((entry) => entry.id !== clip.id), clip];
  writeSnapshot({ ...state, [projectId]: next });
}

export function removeProjectCollectedClip(projectId: string, clipId: string): void {
  const state = readSnapshot();
  const current = state[projectId] ?? [];
  const next = current.filter((entry) => entry.id !== clipId);
  const copy: Record<string, readonly ProjectCollectedClip[]> = { ...state };
  if (next.length === 0) delete copy[projectId];
  else copy[projectId] = next;
  writeSnapshot(copy);
}

/** Test isolation for the module-level external-store cache. */
export function resetProjectCollectionsForTesting(): void {
  snapshot = null;
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Same storage-denied fallback as the production writer.
  }
  for (const listener of listeners) listener();
}
