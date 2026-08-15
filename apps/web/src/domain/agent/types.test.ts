import { i18n } from '@lingui/core';
import { beforeAll, describe, expect, it } from 'vitest';

import type { AgentSessionProposal } from '../../shared/desktop/dto';
import {
  AGENT_ENTRY_KIND,
  AGENT_ENTRY_KINDS,
  AGENT_OBJECT_KIND,
  AGENT_OBJECT_KINDS,
  AGENT_PLAN_AUTHOR,
  AGENT_PLAN_AUTHORS,
  AGENT_PLAN_STATUS,
  AGENT_PLAN_STATUSES,
  AGENT_SHOT_KIND,
  AGENT_SHOT_KINDS,
  AGENT_SHOT_VIEW,
  AGENT_SHOT_VIEWS,
  PLAN_CHANGE_OP,
  PLAN_CHANGE_OPS,
  PLAN_CHANGE_STATE,
  PLAN_CHANGE_STATES,
  WORKSPACE_EDIT_OPERATION,
  WORKSPACE_EDIT_OPERATIONS,
  isPlanChangeOp,
  readPlanChangeSet,
} from './types';

beforeAll(() => {
  // Source locale with an empty catalog: the macros baked the zh-CN string in.
  i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });
});

function proposal(overrides: Partial<AgentSessionProposal> = {}): AgentSessionProposal {
  return {
    kind: 'plan_change_set',
    title: '把它压到 30 秒以内',
    plan_id: 'P-118',
    based_on_revision: 6,
    payload: { changes: [] },
    ...overrides,
  };
}

describe('the tables are total', () => {
  it('covers all seven camera styles the wire can send, with a Latin code', () => {
    expect(AGENT_SHOT_KINDS).toHaveLength(7);
    for (const kind of AGENT_SHOT_KINDS) {
      const meta = AGENT_SHOT_KIND[kind];
      expect(i18n._(meta.label)).not.toBe('');
      expect(meta.code).not.toBe('');
      expect(meta.icon).toBeTruthy();
    }
  });

  it('keeps the five §4.5.2 members and labels the two the wire adds', () => {
    expect(AGENT_SHOT_KIND.static.code).toBe('Static');
    expect(AGENT_SHOT_KIND.tracking.code).toBe('Tracking');
    expect(AGENT_SHOT_KIND.pov.code).toBe('POV');
    expect(AGENT_SHOT_KIND.crane.code).toBe('Crane');
    expect(AGENT_SHOT_KIND.flyby.code).toBe('Flyby');
    expect(AGENT_SHOT_KIND.orbit.code).toBe('Orbit');
    expect(AGENT_SHOT_KIND.dolly.code).toBe('Dolly');
  });

  it('gives every shot view a label and a glyph', () => {
    expect(AGENT_SHOT_VIEWS).toHaveLength(2);
    for (const view of AGENT_SHOT_VIEWS) {
      expect(i18n._(AGENT_SHOT_VIEW[view].label)).not.toBe('');
      expect(AGENT_SHOT_VIEW[view].icon).toBeTruthy();
    }
  });

  it('gives every author a source badge and a removal badge', () => {
    expect(AGENT_PLAN_AUTHORS).toHaveLength(2);
    for (const author of AGENT_PLAN_AUTHORS) {
      const meta = AGENT_PLAN_AUTHOR[author];
      expect(i18n._(meta.label)).not.toBe('');
      expect(i18n._(meta.sourceBadge)).not.toBe('');
      expect(i18n._(meta.removedBadge)).not.toBe('');
    }
    // §4.5.3 rule ②: a shot the user touched is never 「待批准」.
    expect(i18n._(AGENT_PLAN_AUTHOR.user.sourceBadge)).toBe('你改过');
    expect(i18n._(AGENT_PLAN_AUTHOR.user.removedBadge)).toBe('你删除的');
  });

  it('gives every plan status a label and a glyph', () => {
    expect(AGENT_PLAN_STATUSES).toHaveLength(4);
    for (const status of AGENT_PLAN_STATUSES) {
      expect(i18n._(AGENT_PLAN_STATUS[status].label)).not.toBe('');
      expect(AGENT_PLAN_STATUS[status].icon).toBeTruthy();
    }
  });

  it('gives every referencable object kind a label and a glyph', () => {
    expect(AGENT_OBJECT_KINDS).toHaveLength(4);
    for (const kind of AGENT_OBJECT_KINDS) {
      expect(i18n._(AGENT_OBJECT_KIND[kind].label)).not.toBe('');
      expect(AGENT_OBJECT_KIND[kind].icon).toBeTruthy();
    }
  });

  it('marks the workspace-edit entry as the one that is not a bubble', () => {
    expect(AGENT_ENTRY_KINDS).toHaveLength(3);
    for (const kind of AGENT_ENTRY_KINDS) {
      expect(i18n._(AGENT_ENTRY_KIND[kind].label)).not.toBe('');
    }
    expect(AGENT_ENTRY_KIND.user.bubble).toBe(true);
    expect(AGENT_ENTRY_KIND.assistant.bubble).toBe(true);
    expect(AGENT_ENTRY_KIND.workspace_edit.bubble).toBe(false);
  });

  it('gives every workspace-edit operation a label and a glyph', () => {
    expect(WORKSPACE_EDIT_OPERATIONS).toHaveLength(4);
    for (const op of WORKSPACE_EDIT_OPERATIONS) {
      expect(i18n._(WORKSPACE_EDIT_OPERATION[op].label)).not.toBe('');
      expect(WORKSPACE_EDIT_OPERATION[op].icon).toBeTruthy();
    }
  });

  it('gives every change op and every change state a label and a glyph', () => {
    expect(PLAN_CHANGE_OPS).toHaveLength(4);
    expect(PLAN_CHANGE_STATES).toHaveLength(4);
    for (const op of PLAN_CHANGE_OPS) {
      expect(i18n._(PLAN_CHANGE_OP[op].label)).not.toBe('');
      expect(PLAN_CHANGE_OP[op].icon).toBeTruthy();
    }
    for (const state of PLAN_CHANGE_STATES) {
      expect(i18n._(PLAN_CHANGE_STATE[state].label)).not.toBe('');
      expect(PLAN_CHANGE_STATE[state].icon).toBeTruthy();
    }
  });

  it('has no two members of a union sharing a glyph', () => {
    const unions = [
      AGENT_SHOT_KINDS.map((kind) => AGENT_SHOT_KIND[kind].icon),
      AGENT_SHOT_VIEWS.map((view) => AGENT_SHOT_VIEW[view].icon),
      AGENT_PLAN_STATUSES.map((status) => AGENT_PLAN_STATUS[status].icon),
      AGENT_OBJECT_KINDS.map((kind) => AGENT_OBJECT_KIND[kind].icon),
      AGENT_ENTRY_KINDS.map((kind) => AGENT_ENTRY_KIND[kind].icon),
      WORKSPACE_EDIT_OPERATIONS.map((op) => WORKSPACE_EDIT_OPERATION[op].icon),
      PLAN_CHANGE_OPS.map((op) => PLAN_CHANGE_OP[op].icon),
      PLAN_CHANGE_STATES.map((state) => PLAN_CHANGE_STATE[state].icon),
    ];
    for (const icons of unions) {
      expect(new Set(icons).size).toBe(icons.length);
    }
  });
});

describe('readPlanChangeSet', () => {
  it('reads a full change and keeps the revision it was based on', () => {
    const parsed = readPlanChangeSet(
      proposal({
        payload: {
          changes: [
            {
              id: 'c1',
              op: 'shorten',
              target: 'shot-02',
              before: '8.5s',
              after: '3.0s',
              delta_seconds: -5.5,
              rationale: '只保留从中路进入 A 大道的一段',
              warning: '结尾会变硬',
            },
          ],
        },
      }),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.basedOnRevision).toBe(6);
    expect(parsed?.planId).toBe('P-118');
    expect(parsed?.changes).toHaveLength(1);
    expect(parsed?.changes[0]).toEqual({
      id: 'c1',
      op: 'shorten',
      targetShotId: 'shot-02',
      before: '8.5s',
      after: '3.0s',
      deltaSeconds: -5.5,
      rationale: '只保留从中路进入 A 大道的一段',
      warning: '结尾会变硬',
      state: 'pending',
    });
  });

  it('keeps a sparse change with nulls rather than inventing values', () => {
    const parsed = readPlanChangeSet(
      proposal({ payload: { changes: [{ op: 'delete', target: 'shot-04' }] } }),
    );

    expect(parsed?.changes[0]).toMatchObject({
      op: 'delete',
      targetShotId: 'shot-04',
      before: null,
      after: null,
      deltaSeconds: null,
      rationale: null,
      warning: null,
    });
    // A payload without ids still yields stable keys.
    expect(parsed?.changes[0]?.id).toBe('delete-shot-04-0');
  });

  it('drops a change that cannot be drawn or applied, keeps the rest', () => {
    const parsed = readPlanChangeSet(
      proposal({
        payload: {
          changes: [
            { op: 'reticulate', target: 'shot-01' },
            { op: 'insert', target: '' },
            { op: 'insert' },
            'not an object',
            { op: 'replace', target: 'shot-03' },
          ],
        },
      }),
    );

    expect(parsed?.changes).toHaveLength(1);
    expect(parsed?.changes[0]?.op).toBe('replace');
  });

  it('returns null when the proposal does not target a plan revision', () => {
    expect(readPlanChangeSet(proposal({ plan_id: null }))).toBeNull();
    expect(readPlanChangeSet(proposal({ based_on_revision: null }))).toBeNull();
  });

  it('returns null when the payload is not a change set at all', () => {
    expect(readPlanChangeSet(proposal({ payload: null }))).toBeNull();
    expect(readPlanChangeSet(proposal({ payload: 'shorten shot 2' }))).toBeNull();
    expect(readPlanChangeSet(proposal({ payload: { note: 'no changes key' } }))).toBeNull();
  });

  it('distinguishes an empty change set from an unreadable payload', () => {
    const parsed = readPlanChangeSet(proposal({ payload: { changes: [] } }));
    expect(parsed).not.toBeNull();
    expect(parsed?.changes).toEqual([]);
  });

  it('narrows a raw op string', () => {
    expect(isPlanChangeOp('shorten')).toBe(true);
    expect(isPlanChangeOp('trim')).toBe(false);
  });
});
