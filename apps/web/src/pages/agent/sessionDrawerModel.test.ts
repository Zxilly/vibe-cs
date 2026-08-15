/*
 * `unit` project — the pure half of the session drawer.
 *
 * Four things are pinned here, and each one is a decision that would otherwise
 * only exist inside a JSX expression: what the search sends, what the picker's
 * four groups are, which objects count as already referenced, and where a
 * reference chip goes.
 */

import { describe, expect, it } from 'vitest';

import type {
  AgentObjectKind,
  AgentObjectRef,
  AgentWorkspaceReference,
  AgentWorkspaceReferences,
} from '../../shared/desktop/dto';
import {
  SESSION_LIST_LIMIT,
  WORKSPACE_REFERENCE_GROUPS,
  agentObjectDestination,
  objectRefKey,
  referencedKeys,
  selectedPlanId,
  selectedReferences,
  sessionSearchQuery,
  toObjectRefTouch,
  workspaceReferenceCount,
  workspaceReferenceGroups,
} from './sessionDrawerModel';

const OBJECT_KINDS: readonly AgentObjectKind[] = ['plan', 'recording_task', 'edit_project', 'output'];

function reference(
  kind: AgentObjectKind,
  id: string,
  overrides: Partial<AgentWorkspaceReference> = {},
): AgentWorkspaceReference {
  return {
    kind,
    id,
    label: `${kind} ${id}`,
    status: '运行中 2/6',
    progress_percent: null,
    item_count: null,
    error: null,
    updated_at: '2026-08-15T09:41:00.000Z',
    ...overrides,
  };
}

function references(overrides: Partial<AgentWorkspaceReferences> = {}): AgentWorkspaceReferences {
  return {
    pending_plans: [],
    running_recording_tasks: [],
    edit_projects: [],
    failed_outputs: [],
    ...overrides,
  };
}

describe('sessionSearchQuery', () => {
  it('sends the term the user typed', () => {
    expect(sessionSearchQuery('Kael')).toEqual({ q: 'Kael', limit: SESSION_LIST_LIMIT });
  });

  it('trims, because a trailing space is not a different search', () => {
    expect(sessionSearchQuery('  Kael  ')).toEqual({ q: 'Kael', limit: SESSION_LIST_LIMIT });
  });

  it('omits `q` entirely for an empty box rather than sending an empty string', () => {
    /* Two spellings of one list would be two cache keys, and clearing the box
       would refetch what was already on screen. */
    expect(sessionSearchQuery('')).toEqual({ limit: SESSION_LIST_LIMIT });
    expect(sessionSearchQuery('   ')).toEqual({ limit: SESSION_LIST_LIMIT });
    expect('q' in sessionSearchQuery('')).toBe(false);
  });

  it('takes a caller-supplied page size', () => {
    expect(sessionSearchQuery('x', 5)).toEqual({ q: 'x', limit: 5 });
  });
});

describe('the picker groups', () => {
  it('covers every field of AgentWorkspaceReferences exactly once, in the artboard order', () => {
    expect(WORKSPACE_REFERENCE_GROUPS.map((group) => group.id)).toEqual([
      'pending_plans',
      'running_recording_tasks',
      'edit_projects',
      'failed_outputs',
    ]);
    const empty = references();
    expect(new Set(WORKSPACE_REFERENCE_GROUPS.map((group) => group.id))).toEqual(
      new Set(Object.keys(empty)),
    );
  });

  it('emphasises 等待确认的方案 and nothing else — the accent is a fact, not decoration', () => {
    const emphasised = WORKSPACE_REFERENCE_GROUPS.filter((group) => group.emphasis);
    expect(emphasised.map((group) => group.id)).toEqual(['pending_plans']);
  });

  it('drops empty groups rather than drawing a heading with nothing under it', () => {
    const groups = workspaceReferenceGroups(
      references({ edit_projects: [reference('edit_project', 'E-1')] }),
    );
    expect(groups.map((group) => group.id)).toEqual(['edit_projects']);
    expect(groups[0]?.items).toHaveLength(1);
  });

  it('counts across all four, and says 0 for a workspace with nothing running', () => {
    expect(workspaceReferenceCount(references())).toBe(0);
    expect(workspaceReferenceCount(undefined)).toBe(0);
    expect(
      workspaceReferenceCount(
        references({
          pending_plans: [reference('plan', 'P-118')],
          failed_outputs: [reference('output', 'O-1'), reference('output', 'O-2')],
        }),
      ),
    ).toBe(3);
  });

  it('treats a still-loading read as empty rather than throwing', () => {
    expect(workspaceReferenceGroups(undefined)).toEqual([]);
  });
});

describe('what a session already references', () => {
  it('keys on kind *and* id, because an id is only unique per kind', () => {
    expect(objectRefKey('plan', 'X')).not.toBe(objectRefKey('output', 'X'));
  });

  it('builds the set the 已引用 state reads', () => {
    const refs: AgentObjectRef[] = [
      {
        kind: 'plan',
        id: 'P-118',
        label: '方案 #P-118',
        touched_at: '2026-08-15T09:24:00.000Z',
        touch_count: 2,
        summary: '镜头 02 改为 Tracking',
        status: '等待确认',
      },
    ];
    const keys = referencedKeys(refs);
    expect(keys.has(objectRefKey('plan', 'P-118'))).toBe(true);
    expect(keys.has(objectRefKey('output', 'P-118'))).toBe(false);
  });
});

describe('toObjectRefTouch', () => {
  it('carries the server’s own status through unchanged', () => {
    const touch = toObjectRefTouch(reference('recording_task', 'A-2483'), '在新建会话时引用');
    expect(touch).toEqual({
      kind: 'recording_task',
      id: 'A-2483',
      label: 'recording_task A-2483',
      summary: '在新建会话时引用',
      status: '运行中 2/6',
    });
  });

  it('takes its summary from the caller, so this module holds no copy', () => {
    expect(toObjectRefTouch(reference('output', 'O-1'), '任意一句').summary).toBe('任意一句');
  });
});

describe('what a new session takes over', () => {
  const workspace = references({
    pending_plans: [reference('plan', 'P-118'), reference('plan', 'P-102')],
    running_recording_tasks: [reference('recording_task', 'A-2483')],
  });

  it('is the first picked plan, in the order the sheet drew them', () => {
    const picked = new Set([objectRefKey('plan', 'P-102'), objectRefKey('plan', 'P-118')]);
    expect(selectedPlanId(workspace, picked)).toBe('P-118');
  });

  it('is null when nothing picked is a plan — the address then keeps its own', () => {
    expect(selectedPlanId(workspace, new Set([objectRefKey('recording_task', 'A-2483')]))).toBeNull();
    expect(selectedPlanId(workspace, new Set())).toBeNull();
  });

  it('returns every pick in list order, so the touches are written in that order', () => {
    const picked = new Set([
      objectRefKey('recording_task', 'A-2483'),
      objectRefKey('plan', 'P-102'),
    ]);
    expect(selectedReferences(workspace, picked).map((item) => item.id)).toEqual(['P-102', 'A-2483']);
  });
});

describe('where a reference chip goes', () => {
  it('is total over AgentObjectKind — an unknown kind cannot produce a dead chip', () => {
    for (const kind of OBJECT_KINDS) {
      const destination = agentObjectDestination(kind, 'X-1');
      expect(destination.kind === 'plan' || destination.to !== '').toBe(true);
    }
  });

  it('keeps a plan on this page: it is a patch to `?plan=`, not a navigation', () => {
    expect(agentObjectDestination('plan', 'P-118')).toEqual({ kind: 'plan', planId: 'P-118' });
  });

  it('sends the other three to their §7 routes', () => {
    expect(agentObjectDestination('recording_task', 'A-2483')).toEqual({
      kind: 'route',
      to: '/delivery/task/A-2483',
    });
    expect(agentObjectDestination('edit_project', 'E-7')).toEqual({
      kind: 'route',
      to: '/editor/E-7',
    });
    /* §7 gives `/delivery` only `?view=outputs|tasks` — there is no per-output
       address, and this module does not get to invent one. */
    expect(agentObjectDestination('output', 'O-1')).toEqual({
      kind: 'route',
      to: '/delivery?view=outputs',
    });
  });

  it('escapes an id that would otherwise break the path', () => {
    expect(agentObjectDestination('recording_task', 'a/b?c')).toEqual({
      kind: 'route',
      to: '/delivery/task/a%2Fb%3Fc',
    });
  });
});
