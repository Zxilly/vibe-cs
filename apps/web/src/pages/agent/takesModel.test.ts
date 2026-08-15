/*
 * `unit` project — what `?mode=takes` is allowed to say.
 *
 * The assertions are as much about what is *absent* as about what is there:
 * there is no take here, no composition, and no metric that is not a wire
 * field. See `takesModel.ts`'s header.
 */

import { describe, expect, it } from 'vitest';

import {
  PLAN_SHOTS,
  SHOT_CRANE_REMOVED,
  SHOT_ESTABLISH,
  SHOT_POV,
  SHOT_TRACKING_EDITED,
} from '../../domain/agent/agentFixtures.testing';
import type { AgentPlan, AgentPlanShot } from '../../shared/desktop/dto';
import { formatSignedCount, planVersionFacts, planVersions } from './takesModel';

function plan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: 'P-118',
    title: 'Kael · Mirage 1v3 残局',
    status: 'awaiting_confirmation',
    revision: 7,
    shots: [...PLAN_SHOTS],
    origin: [],
    agent_baseline: {
      revision: 1,
      captured_at: '2026-08-15T09:02:00.000Z',
      shots: [...PLAN_SHOTS],
    },
    created_at: '2026-08-15T09:02:00.000Z',
    updated_at: '2026-08-15T09:47:00.000Z',
    ...overrides,
  };
}

describe('planVersions', () => {
  it('gives the baseline first and the current version second', () => {
    const versions = planVersions(plan());

    expect(versions.map((version) => version.id)).toEqual(['baseline', 'current']);
    expect(versions[0]?.revision).toBe(1);
    expect(versions[1]?.revision).toBe(7);
    expect(versions[1]?.current).toBe(true);
  });

  it('gives one version when the plan has never moved off the Agent’s', () => {
    // A comparison of a thing with itself is a column that says nothing.
    expect(planVersions(plan({ revision: 1 })).map((version) => version.id)).toEqual(['current']);
  });

  it('gives one version when the baseline somehow reads ahead of the plan', () => {
    expect(planVersions(plan({ revision: 0 }))).toHaveLength(1);
  });

  it('carries each version’s own timestamp', () => {
    const versions = planVersions(plan());
    expect(versions[0]?.at).toBe('2026-08-15T09:02:00.000Z');
    expect(versions[1]?.at).toBe('2026-08-15T09:47:00.000Z');
  });
});

describe('planVersionFacts', () => {
  const edited: readonly AgentPlanShot[] = [
    SHOT_ESTABLISH,
    SHOT_TRACKING_EDITED,
    SHOT_POV,
    SHOT_CRANE_REMOVED,
  ];

  it('reads the length and the count off the shots, deleted ones excluded', () => {
    const versions = planVersions(plan({ shots: [...edited] }));
    const facts = planVersionFacts(versions[1]!, versions[0]!);

    // 3.0 + 5.0 + 24.0, with the soft-deleted 6.5 out of the cut.
    expect(facts.durationSeconds).toBe(32);
    expect(facts.shotCount).toBe(3);
  });

  it('counts the shots that carry a risk, and the ones the user touched', () => {
    const versions = planVersions(plan({ shots: [...edited] }));
    const facts = planVersionFacts(versions[1]!, versions[0]!);

    expect(facts.riskyShotCount).toBe(1);
    expect(facts.userShotCount).toBe(1);
  });

  it('compares the current version against the baseline', () => {
    const versions = planVersions(plan({ shots: [...edited] }));
    const facts = planVersionFacts(versions[1]!, versions[0]!);

    expect(facts.durationDeltaSeconds).toBe(-10);
    expect(facts.shotCountDelta).toBe(-1);
  });

  it('has no delta on the baseline itself', () => {
    const versions = planVersions(plan());
    const facts = planVersionFacts(versions[0]!, versions[0]!);

    expect(facts.durationDeltaSeconds).toBeNull();
    expect(facts.shotCountDelta).toBeNull();
  });

  it('has no delta when there is nothing to compare against', () => {
    const versions = planVersions(plan({ revision: 1 }));
    expect(planVersionFacts(versions[0]!, null).durationDeltaSeconds).toBeNull();
  });

  it('never reports 击杀证据覆盖 or 运动镜头 — a plan carries neither', () => {
    const facts = planVersionFacts(planVersions(plan())[0]!, null);
    expect(Object.keys(facts).sort()).toEqual([
      'durationDeltaSeconds',
      'durationSeconds',
      'riskyShotCount',
      'shotCount',
      'shotCountDelta',
      'userShotCount',
    ]);
  });
});

describe('formatSignedCount', () => {
  it('signs a change and uses the minus sign, not a hyphen', () => {
    expect(formatSignedCount(1)).toBe('+1');
    expect(formatSignedCount(-2)).toBe('−2');
  });

  it('says ±0 rather than 0, so a row that did not move still reads as a delta', () => {
    expect(formatSignedCount(0)).toBe('±0');
  });

  it('does not blow up on a value that is not a number', () => {
    expect(formatSignedCount(Number.NaN)).toBe('±0');
  });
});
