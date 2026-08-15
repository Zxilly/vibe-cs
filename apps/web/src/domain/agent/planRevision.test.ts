import { i18n } from '@lingui/core';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  PLAN_CHANGE_AFFORDANCE,
  STALE_OPACITY_CLASS,
  STALE_OPACITY_PERCENT,
  changeSetIsStale,
  markChangeStale,
  markStale,
  pendingChangeCount,
  planChangeAffordance,
} from './planRevision';
import { PLAN_CHANGE_STATES, type PlanChange, type PlanChangeSet, type PlanChangeState } from './types';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });
});

function change(id: string, state: PlanChangeState): PlanChange {
  return {
    id,
    op: 'shorten',
    targetShotId: `shot-${id}`,
    before: '8.5s',
    after: '3.0s',
    deltaSeconds: -5.5,
    rationale: '压到 30 秒以内',
    warning: null,
    state,
  };
}

function changeSet(basedOnRevision: number, changes: PlanChange[]): PlanChangeSet {
  return {
    kind: 'plan_change_set',
    title: '把它压到 30 秒以内',
    planId: 'P-118',
    basedOnRevision,
    changes,
  };
}

describe('markStale', () => {
  it('leaves everything alone when the base equals the current revision', () => {
    const set = changeSet(7, [change('1', 'pending'), change('2', 'pending')]);
    expect(markStale(set, 7)).toBe(set);
    expect(changeSetIsStale(set, 7)).toBe(false);
  });

  it('marks unhandled changes stale when the base is behind', () => {
    const set = changeSet(6, [change('1', 'pending'), change('2', 'pending')]);
    const marked = markStale(set, 7);

    expect(changeSetIsStale(set, 7)).toBe(true);
    expect(marked.changes.map((item) => item.state)).toEqual(['stale', 'stale']);
    // The body stays readable — 「过期不等于错误」.
    expect(marked.changes[0]?.before).toBe('8.5s');
    expect(marked.changes[0]?.rationale).toBe('压到 30 秒以内');
  });

  it('does not touch a change that was already accepted', () => {
    const set = changeSet(6, [change('1', 'accepted'), change('2', 'pending')]);
    const marked = markStale(set, 7);

    expect(marked.changes[0]?.state).toBe('accepted');
    expect(marked.changes[1]?.state).toBe('stale');
  });

  it('does not touch a change that was already rejected', () => {
    const set = changeSet(3, [change('1', 'rejected')]);
    expect(markStale(set, 9).changes[0]?.state).toBe('rejected');
  });

  it('is idempotent — a stale set marked again is the same object', () => {
    const set = changeSet(6, [change('1', 'pending')]);
    const once = markStale(set, 7);
    expect(markStale(once, 7)).toBe(once);
  });

  it('does not throw on an empty change set', () => {
    const set = changeSet(6, []);
    expect(markStale(set, 7).changes).toEqual([]);
    expect(pendingChangeCount(set)).toBe(0);
  });

  it('treats a base ahead of the plan as current, because the plan copy is the stale one', () => {
    const set = changeSet(9, [change('1', 'pending')]);
    expect(changeSetIsStale(set, 7)).toBe(false);
    expect(markStale(set, 7)).toBe(set);
  });

  it('counts only the changes still awaiting a decision', () => {
    const set = changeSet(7, [
      change('1', 'pending'),
      change('2', 'accepted'),
      change('3', 'rejected'),
      change('4', 'pending'),
    ]);
    expect(pendingChangeCount(set)).toBe(2);
  });

  it('marks one change in isolation the same way', () => {
    expect(markChangeStale(change('1', 'pending'), true).state).toBe('stale');
    expect(markChangeStale(change('1', 'pending'), false).state).toBe('pending');
    expect(markChangeStale(change('1', 'accepted'), true).state).toBe('accepted');
  });
});

describe('what an expired card looks like', () => {
  it('describes all four states', () => {
    for (const state of PLAN_CHANGE_STATES) {
      expect(PLAN_CHANGE_AFFORDANCE[state]).toBeDefined();
    }
  });

  it('dims to 55%, disables 接受 with a written reason and labels it 已过期', () => {
    const stale = PLAN_CHANGE_AFFORDANCE.stale;

    expect(STALE_OPACITY_PERCENT).toBe(55);
    expect(stale.className).toBe(STALE_OPACITY_CLASS);
    expect(stale.className).toContain('55');
    expect(stale.acceptDisabled).toBe(true);
    expect(stale.statusLabel).not.toBeNull();
    expect(i18n._(stale.statusLabel!)).toBe('已过期');
    expect(stale.acceptDisabledReason).not.toBeNull();
    expect(i18n._(stale.acceptDisabledReason!)).toContain('仍可查看');
  });

  it('leaves a pending card undimmed, unlabelled and fully actionable', () => {
    const pending = PLAN_CHANGE_AFFORDANCE.pending;
    expect(pending.className).toBe('');
    expect(pending.acceptDisabled).toBe(false);
    expect(pending.rejectDisabled).toBe(false);
    expect(pending.statusLabel).toBeNull();
    expect(pending.acceptDisabledReason).toBeNull();
  });

  it('dims nothing but the stale card', () => {
    for (const state of PLAN_CHANGE_STATES) {
      if (state === 'stale') continue;
      expect(PLAN_CHANGE_AFFORDANCE[state].className).toBe('');
    }
  });

  it('states a reason whenever 接受 is disabled', () => {
    for (const state of PLAN_CHANGE_STATES) {
      const affordance = PLAN_CHANGE_AFFORDANCE[state];
      if (!affordance.acceptDisabled) continue;
      expect(affordance.acceptDisabledReason).not.toBeNull();
      expect(i18n._(affordance.acceptDisabledReason!)).not.toBe('');
    }
  });

  it('keeps 撤销拒绝 reachable — a rejected change can still be accepted', () => {
    expect(PLAN_CHANGE_AFFORDANCE.rejected.acceptDisabled).toBe(false);
  });

  it('reads the affordance straight off a change', () => {
    expect(planChangeAffordance(change('1', 'stale'))).toBe(PLAN_CHANGE_AFFORDANCE.stale);
  });
});
