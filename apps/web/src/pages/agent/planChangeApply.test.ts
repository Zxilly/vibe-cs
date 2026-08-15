/*
 * `unit` project — accepting a change (§4.5.3 rules ① and ③).
 *
 * The point of these tests is what accepting is *not*: it is not a command, it
 * is not a guess, and it is not available for an op whose payload does not carry
 * what applying it would need.
 */

import { describe, expect, it } from 'vitest';

import { PLAN_CHANGE_OPS, readPlanChangeSet } from '../../domain/agent';
import type { PlanChange } from '../../domain/agent';
import { PLAN_PROPOSAL, PLAN_SHOTS } from '../../domain/agent/agentFixtures.testing';

import {
  APPLICABLE_PLAN_CHANGE_OPS,
  PLAN_CHANGE_IS_APPLICABLE,
  applyPlanChange,
  changeApplicability,
} from './planChangeApply';
import { removeShot } from './planEditModel';

const CHANGES = readPlanChangeSet(PLAN_PROPOSAL)?.changes ?? [];
const SHORTEN = CHANGES[0] as PlanChange;
const DELETE_04 = CHANGES[1] as PlanChange;

function change(overrides: Partial<PlanChange>): PlanChange {
  return { ...SHORTEN, ...overrides };
}

describe('the table of what can be applied', () => {
  it('is total over the four ops', () => {
    for (const op of PLAN_CHANGE_OPS) {
      expect(typeof PLAN_CHANGE_IS_APPLICABLE[op]).toBe('boolean');
    }
  });

  it('is exactly 缩短 and 删除 — the two the payload carries enough for', () => {
    expect([...APPLICABLE_PLAN_CHANGE_OPS]).toEqual(['shorten', 'delete']);
  });
});

describe('changeApplicability', () => {
  it('lets a shorten with a delta through', () => {
    expect(changeApplicability(SHORTEN, PLAN_SHOTS)).toEqual({ applicable: true, reason: null });
  });

  it('refuses a replace and an insert, and says why rather than hiding them', () => {
    for (const op of ['replace', 'insert'] as const) {
      const verdict = changeApplicability(change({ op }), PLAN_SHOTS);
      expect(verdict.applicable).toBe(false);
      expect(verdict.reason).not.toBeNull();
    }
  });

  it('refuses a shorten with no delta rather than parsing 「3.0s」 out of prose', () => {
    const verdict = changeApplicability(change({ deltaSeconds: null }), PLAN_SHOTS);
    expect(verdict.applicable).toBe(false);
    expect(verdict.reason).not.toBeNull();
  });

  it('refuses a delta that would take the shot below zero', () => {
    expect(changeApplicability(change({ deltaSeconds: -99 }), PLAN_SHOTS).applicable).toBe(false);
  });

  it('refuses a change aimed at a shot that is no longer in the plan', () => {
    expect(changeApplicability(change({ targetShotId: 'shot-99' }), PLAN_SHOTS).applicable).toBe(false);
  });

  it('refuses to delete a shot the user already deleted', () => {
    const removed = removeShot(PLAN_SHOTS, 'shot-04')?.shots ?? [];
    expect(changeApplicability(DELETE_04, PLAN_SHOTS).applicable).toBe(true);
    expect(changeApplicability(DELETE_04, removed).applicable).toBe(false);
  });

  it('never says 「不能接受」 without a reason', () => {
    const verdicts = [
      changeApplicability(SHORTEN, PLAN_SHOTS),
      changeApplicability(change({ op: 'insert' }), PLAN_SHOTS),
      changeApplicability(change({ deltaSeconds: null }), PLAN_SHOTS),
      changeApplicability(change({ targetShotId: 'shot-99' }), PLAN_SHOTS),
    ];
    for (const verdict of verdicts) {
      expect(verdict.applicable).toBe(verdict.reason === null);
    }
  });
});

describe('applyPlanChange', () => {
  it('turns a shorten into one duration line on the target shot', () => {
    const result = applyPlanChange(PLAN_SHOTS, SHORTEN);

    expect(result?.shots[1]?.duration_seconds).toBe(3);
    expect(result?.changes).toEqual([
      { shot: 2, op: 'updated', field: 'duration_seconds', from: '8.5s', to: '3.0s' },
    ]);
  });

  it('leaves `source` as the Agent’s — the user pressed 接受, they did not design it', () => {
    expect(applyPlanChange(PLAN_SHOTS, SHORTEN)?.shots[1]?.source).toBe('agent');
  });

  it('turns a delete into the same soft delete a manual 删除 makes', () => {
    const result = applyPlanChange(PLAN_SHOTS, DELETE_04);

    expect(result?.shots).toHaveLength(PLAN_SHOTS.length);
    expect(result?.shots[3]?.removed_by).toBe('user');
    expect(result?.changes[0]?.op).toBe('removed');
  });

  it('is null for everything `changeApplicability` refuses', () => {
    expect(applyPlanChange(PLAN_SHOTS, change({ op: 'replace' }))).toBeNull();
    expect(applyPlanChange(PLAN_SHOTS, change({ deltaSeconds: null }))).toBeNull();
    expect(applyPlanChange(PLAN_SHOTS, change({ targetShotId: 'shot-99' }))).toBeNull();
  });

  it('returns nothing but shots and changes — there is no command to reach', () => {
    const result = applyPlanChange(PLAN_SHOTS, SHORTEN);
    expect(Object.keys(result ?? {}).sort()).toEqual(['changes', 'shots']);
  });
});
