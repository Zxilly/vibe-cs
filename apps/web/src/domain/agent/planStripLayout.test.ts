import { describe, expect, it } from 'vitest';

import {
  PLAN_SHOTS,
  SHOT_CRANE_REMOVED,
  SHOT_ESTABLISH,
  SHOT_POV,
  SHOT_TRACKING,
  makePlanShots,
} from './agentFixtures.testing';
import { planDuration, planShotCount, planStripSegments, stripRulerMarks } from './planStripLayout';

const LEAD = { leadSeconds: 3, leadLabel: '留白' };

describe('planDuration', () => {
  it('adds the four shots of 方案 #P-118 to the artboard总时长', () => {
    // 3.0 + 8.5 + 24.0 + 6.5 = 42.0, which is what every 07 header prints.
    expect(planDuration(PLAN_SHOTS)).toBe(42);
  });

  it('counts the 留白 block, which is part of the cut', () => {
    expect(planDuration(PLAN_SHOTS, LEAD)).toBe(45);
  });

  it('leaves a deleted shot out of the total — it is not in the video', () => {
    const shots = [SHOT_ESTABLISH, SHOT_TRACKING, SHOT_POV, SHOT_CRANE_REMOVED];
    expect(planDuration(shots)).toBe(35.5);
    expect(planShotCount(shots)).toBe(3);
  });

  it('treats a broken duration as zero rather than poisoning the total', () => {
    const broken = { ...SHOT_ESTABLISH, duration_seconds: Number.NaN };
    expect(planDuration([broken, SHOT_POV])).toBe(24);
  });
});

describe('planStripSegments', () => {
  it('gives one block per shot and percentages that sum to 100', () => {
    const segments = planStripSegments(PLAN_SHOTS);

    expect(segments).toHaveLength(PLAN_SHOTS.length);
    expect(segments.reduce((sum, segment) => sum + segment.percent, 0)).toBeCloseTo(100, 6);
  });

  it('adds the lead-in only when it has a length', () => {
    expect(planStripSegments(PLAN_SHOTS, LEAD)[0]).toMatchObject({ id: 'lead', tone: 'lead', index: null });
    expect(planStripSegments(PLAN_SHOTS, { leadSeconds: 0 })[0]?.id).toBe('shot-01');
  });

  it('numbers the shots one-based, in list order', () => {
    expect(planStripSegments(PLAN_SHOTS).map((segment) => segment.index)).toEqual([1, 2, 3, 4]);
    expect(planStripSegments(PLAN_SHOTS, LEAD).map((segment) => segment.index)).toEqual([null, 1, 2, 3, 4]);
  });

  it('marks the longest shot as the 主体段 and everything else as an ordinary one', () => {
    const tones = planStripSegments(PLAN_SHOTS).map((segment) => segment.tone);
    // 03 选手 POV, 24.0s, is the longest of the four.
    expect(tones).toEqual(['shot', 'shot', 'main', 'shot']);
  });

  it('keeps a deleted shot at its own width so the two compare rows line up', () => {
    const before = planStripSegments(PLAN_SHOTS);
    const after = planStripSegments([SHOT_ESTABLISH, SHOT_TRACKING, SHOT_POV, SHOT_CRANE_REMOVED]);

    expect(after.at(-1)?.tone).toBe('removed');
    // Same denominator, so every block is exactly where it was on the row above.
    expect(after.map((segment) => segment.percent)).toEqual(before.map((segment) => segment.percent));
  });

  it('never calls a deleted shot the 主体段, even when it is the longest', () => {
    const removedLongest = { ...SHOT_POV, removed_by: 'user' as const };
    const tones = planStripSegments([SHOT_ESTABLISH, removedLongest]).map((segment) => segment.tone);

    expect(tones).toEqual(['shot', 'removed']);
  });

  it('splits evenly instead of dividing by zero when every duration is zero', () => {
    const zeroed = PLAN_SHOTS.map((shot) => ({ ...shot, duration_seconds: 0 }));
    const segments = planStripSegments(zeroed);

    expect(segments.map((segment) => segment.percent)).toEqual([25, 25, 25, 25]);
    // A zero-length plan has no 主体段 to point at.
    expect(segments.every((segment) => segment.tone === 'shot')).toBe(true);
  });

  it('clamps a negative duration to zero rather than dropping the block', () => {
    const segments = planStripSegments([{ ...SHOT_ESTABLISH, duration_seconds: -4 }, SHOT_POV]);

    expect(segments).toHaveLength(2);
    expect(segments[0]?.percent).toBe(0);
    expect(segments[1]?.percent).toBeCloseTo(100, 6);
  });

  it('returns nothing for a plan with no shots and no lead', () => {
    expect(planStripSegments([])).toEqual([]);
  });

  it('carries the title through untouched, however long it is', () => {
    const shots = makePlanShots(15);
    const segments = planStripSegments(shots);

    expect(segments).toHaveLength(15);
    expect(segments[0]?.label).toBe(shots[0]?.title);
  });
});

describe('stripRulerMarks', () => {
  it('spans the whole plan and ends on its real length, not a round number', () => {
    expect(stripRulerMarks(42)).toEqual([0, 10.5, 21, 31.5, 42]);
  });

  it('always draws at least two marks, whatever it is asked for', () => {
    expect(stripRulerMarks(42, 1)).toHaveLength(2);
    expect(stripRulerMarks(42, 0)).toEqual([0, 42]);
  });

  it('collapses to zeros for a plan with no length instead of producing NaN', () => {
    expect(stripRulerMarks(Number.NaN)).toEqual([0, 0, 0, 0, 0]);
  });
});
