import { describe, expect, it } from 'vitest';

import type { ProjectChangeGroup } from '../../shared/desktop/dto';
import { projectHistoryCommands } from './projectHistory';

function group({
  id,
  revision,
  reverts = null,
}: {
  readonly id: string;
  readonly revision: number;
  readonly reverts?: string | null;
}): ProjectChangeGroup {
  return {
    id,
    project_id: 'project',
    from_revision: revision - 1,
    to_revision: revision,
    author: { kind: 'human' },
    status: 'completed',
    summary: id,
    reverts_change_group_id: reverts,
    operations: [{ op: 'replace_markers', markers: [] }],
    inverse_operations: [{ op: 'replace_markers', markers: [] }],
    created_at: '2026-09-01T00:00:00Z',
    completed_at: '2026-09-01T00:00:00Z',
  };
}

describe('projectHistoryCommands', () => {
  it('walks multiple Undo and Redo steps over immutable revert chains', () => {
    const a = group({ id: 'a', revision: 1 });
    const b = group({ id: 'b', revision: 2 });
    const undoB = group({ id: 'undo-b', revision: 3, reverts: b.id });
    const undoA = group({ id: 'undo-a', revision: 4, reverts: a.id });

    expect(projectHistoryCommands([undoA, b, a, undoB])).toEqual({
      undo: null,
      redo: undoA,
    });

    const redoA = group({ id: 'redo-a', revision: 5, reverts: undoA.id });
    expect(projectHistoryCommands([a, b, undoB, undoA, redoA])).toEqual({
      undo: redoA,
      redo: undoB,
    });
  });

  it('clears the redo branch after a new ordinary edit', () => {
    const a = group({ id: 'a', revision: 1 });
    const undoA = group({ id: 'undo-a', revision: 2, reverts: a.id });
    const branch = group({ id: 'branch', revision: 3 });

    expect(projectHistoryCommands([a, undoA, branch])).toEqual({
      undo: branch,
      redo: null,
    });
  });
});
