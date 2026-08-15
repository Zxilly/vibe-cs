import { describe, expect, it } from 'vitest';

import type { WorkspaceEditNotice } from '../../shared/desktop/dto';
import { EDIT_NOTICE } from './agentFixtures.testing';
import {
  formatWorkspaceEditNotice,
  workspaceEditChangeCount,
  workspaceEditObjectLabel,
} from './editNotice';

describe('workspaceEditObjectLabel', () => {
  it('names the object the way the notice does — 「plan#P-118」', () => {
    expect(workspaceEditObjectLabel(EDIT_NOTICE.object)).toBe('plan#P-118');
  });
});

describe('workspaceEditChangeCount', () => {
  it('is the merged count the line prints, not a re-count', () => {
    expect(workspaceEditChangeCount(EDIT_NOTICE)).toBe(2);
  });

  it('is zero for a notice with no changes, and the caller decides what to do', () => {
    expect(workspaceEditChangeCount({ ...EDIT_NOTICE, changes: [] })).toBe(0);
  });
});

describe('formatWorkspaceEditNotice', () => {
  const text = formatWorkspaceEditNotice(EDIT_NOTICE);

  it('is valid JSON that round-trips', () => {
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('carries the seven keys §4.5.2 names, in the artboard’s order', () => {
    const keys = Object.keys(JSON.parse(text) as Record<string, unknown>);
    expect(keys).toEqual(['type', 'object', 'revision', 'by', 'at', 'changes', 'note']);
  });

  it('states the type, the object, the revision and the author', () => {
    const parsed = JSON.parse(text) as Record<string, unknown>;

    expect(parsed['type']).toBe('workspace_edit');
    expect(parsed['object']).toBe('plan#P-118');
    // Server-authoritative and never client-authored: the number the proposal's
    // `based_on_revision` is compared against (§4.5.3 ③).
    expect(parsed['revision']).toBe(7);
    expect(parsed['by']).toBe('user');
  });

  it('leaves an absent field out of a change rather than printing null', () => {
    const parsed = JSON.parse(text) as { changes: Record<string, unknown>[] };

    expect(parsed.changes[0]).toEqual({ shot: 2, op: 'updated', field: 'duration', from: '8.5s', to: '5.0s' });
    // 「{ "shot": 4, "op": "removed" }」 — a deletion has no field and no values,
    // and three nulls would be three lines the reader has to discard.
    expect(parsed.changes[1]).toEqual({ shot: 4, op: 'removed' });
    expect(text).not.toContain('null');
  });

  it('omits 「note」 entirely when there is none', () => {
    const silent: WorkspaceEditNotice = { ...EDIT_NOTICE, note: null };
    const parsed = JSON.parse(formatWorkspaceEditNotice(silent)) as Record<string, unknown>;

    expect(Object.keys(parsed)).not.toContain('note');
  });

  it('is indented, because a reader is going to read it', () => {
    expect(text).toContain('\n  "object"');
  });
});
