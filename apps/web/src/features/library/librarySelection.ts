import type { DemoLifecycleStatus } from '../../shared/desktop/dto';
import type { LibraryQueryState } from './libraryQuery';

export const maximumLibrarySelection = 12;

export function isDemoAnalyzable(status: DemoLifecycleStatus): boolean {
  return status === 'discovered' || status === 'failed';
}

export function librarySelectionIdentity(
  query: Pick<LibraryQueryState, 'search' | 'map' | 'status'>,
): string {
  return [query.search, query.map, query.status]
    .map((value) => value.trim())
    .join('\u0000');
}

export type LibrarySelectionToggle = {
  selectedIds: ReadonlySet<string>;
  changed: boolean;
  atLimit: boolean;
};

export function toggleLibrarySelection(
  selectedIds: ReadonlySet<string>,
  demoId: string,
): LibrarySelectionToggle {
  if (selectedIds.has(demoId)) {
    const next = new Set(selectedIds);
    next.delete(demoId);
    return { selectedIds: next, changed: true, atLimit: false };
  }
  if (selectedIds.size >= maximumLibrarySelection) {
    return { selectedIds, changed: false, atLimit: true };
  }
  const next = new Set(selectedIds);
  next.add(demoId);
  return {
    selectedIds: next,
    changed: true,
    atLimit: next.size >= maximumLibrarySelection,
  };
}

export type LibrarySelectionRejection = {
  id: string;
  reason: 'missing' | 'not_analyzable' | 'identity_mismatch';
};

export type LibrarySelectionReconciliation = {
  validIds: string[];
  rejected: LibrarySelectionRejection[];
};

export type LibrarySelectionPreflightCallbacks = {
  onSuccess: (result: LibrarySelectionReconciliation) => void;
  onFailure: (error: unknown) => void;
};

export type LibrarySelectionPreflight = {
  run: (
    selectedIds: readonly string[],
    readDemo: (
      id: string,
      signal: AbortSignal,
    ) => Promise<{ id: string; status: DemoLifecycleStatus }>,
    callbacks: LibrarySelectionPreflightCallbacks,
  ) => Promise<void>;
  cancel: () => void;
  dispose: () => void;
};

export function createLibrarySelectionPreflight(): LibrarySelectionPreflight {
  let controller: AbortController | null = null;
  let generation = 0;

  const cancel = () => {
    generation += 1;
    controller?.abort();
    controller = null;
  };

  return {
    async run(selectedIds, readDemo, callbacks) {
      cancel();
      const currentGeneration = generation;
      const currentController = new AbortController();
      controller = currentController;
      const isCurrent = () => generation === currentGeneration
        && !currentController.signal.aborted;

      let result: LibrarySelectionReconciliation;
      try {
        result = await reconcileLibrarySelection(
          selectedIds,
          (id) => readDemo(id, currentController.signal),
        );
      } catch (error) {
        if (isCurrent()) callbacks.onFailure(error);
        return;
      } finally {
        if (generation === currentGeneration) controller = null;
      }
      if (isCurrent()) callbacks.onSuccess(result);
    },
    cancel,
    dispose: cancel,
  };
}

export async function reconcileLibrarySelection(
  selectedIds: readonly string[],
  readDemo: (id: string) => Promise<{ id: string; status: DemoLifecycleStatus }>,
): Promise<LibrarySelectionReconciliation> {
  const settled = await Promise.allSettled(selectedIds.map((id) => readDemo(id)));
  const validIds: string[] = [];
  const rejected: LibrarySelectionRejection[] = [];
  settled.forEach((result, index) => {
    const id = selectedIds[index];
    if (!id) return;
    if (result.status === 'rejected') {
      if (!isMissingDemoError(result.reason)) throw result.reason;
      rejected.push({ id, reason: 'missing' });
      return;
    }
    if (result.value.id !== id) {
      rejected.push({ id, reason: 'identity_mismatch' });
      return;
    }
    if (!isDemoAnalyzable(result.value.status)) {
      rejected.push({ id, reason: 'not_analyzable' });
      return;
    }
    validIds.push(id);
  });
  return { validIds, rejected };
}

function isMissingDemoError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'status' in error
    && (error as { status?: unknown }).status === 404;
}

export type LibrarySelectionNotice = {
  tone: 'warning' | 'danger';
  key: 'library.selection.rejected' | 'library.selection.noneValid';
  values: Record<string, number>;
};

export function selectionNotice(
  rejectedCount: number,
  validCount: number,
): LibrarySelectionNotice | null {
  if (rejectedCount === 0) return null;
  if (validCount === 0) {
    return { tone: 'danger', key: 'library.selection.noneValid', values: {} };
  }
  return {
    tone: 'warning',
    key: 'library.selection.rejected',
    values: { count: rejectedCount, valid: validCount },
  };
}

export function formatLibrarySelectionMessage(
  template: string,
  values: Record<string, string | number>,
): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template,
  );
}
