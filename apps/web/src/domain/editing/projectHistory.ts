import type { ProjectChangeGroup } from '../../shared/desktop/dto';

export interface ProjectHistoryCommands {
  readonly undo: ProjectChangeGroup | null;
  readonly redo: ProjectChangeGroup | null;
}

interface HistoryRoot {
  latest: ProjectChangeGroup;
  applied: boolean;
}

/**
 * Reconstruct the linear editor history cursor from immutable Change Groups.
 *
 * A revert is itself a Change Group. Its target can therefore be either an
 * original edit (Undo) or the previous revert in the same chain (Redo). New
 * ordinary edits clear the redo stack, matching desktop editor behavior.
 */
export function projectHistoryCommands(
  changeGroups: readonly ProjectChangeGroup[],
): ProjectHistoryCommands {
  const ordered = [...changeGroups]
    .filter((group) => group.status === 'completed'
      && group.operations.length > 0
      && group.author.kind !== 'system')
    .sort((left, right) => left.to_revision - right.to_revision);
  const rootIdByGroupId = new Map<string, string>();
  const roots = new Map<string, HistoryRoot>();
  const undoStack: string[] = [];
  let redoStack: string[] = [];

  const remove = (stack: string[], rootId: string) => {
    const index = stack.lastIndexOf(rootId);
    if (index >= 0) stack.splice(index, 1);
  };

  for (const group of ordered) {
    const targetId = group.reverts_change_group_id;
    if (targetId === null) {
      rootIdByGroupId.set(group.id, group.id);
      roots.set(group.id, { latest: group, applied: true });
      undoStack.push(group.id);
      redoStack = [];
      continue;
    }

    const rootId = rootIdByGroupId.get(targetId);
    if (rootId === undefined) continue;
    const root = roots.get(rootId);
    if (root === undefined) continue;
    rootIdByGroupId.set(group.id, rootId);
    root.latest = group;
    if (root.applied) {
      root.applied = false;
      remove(undoStack, rootId);
      redoStack.push(rootId);
    } else {
      root.applied = true;
      remove(redoStack, rootId);
      undoStack.push(rootId);
    }
  }

  const undoRoot = roots.get(undoStack.at(-1) ?? '');
  const redoRoot = roots.get(redoStack.at(-1) ?? '');
  return {
    undo: undoRoot?.latest ?? null,
    redo: redoRoot?.latest ?? null,
  };
}
