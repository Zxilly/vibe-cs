/*
 * `unit` project — the manual edit as arithmetic (§4.5.3 rule ②, §4.5.4).
 *
 * The three properties these tests exist for, and which no rendering test could
 * state as plainly:
 *
 *   an edit produces a `'user'` shot and nothing that awaits approval;
 *   a delete is reversible and keeps the shot's number;
 *   a field put back where it started produces no change line at all.
 */

import { describe, expect, it } from 'vitest';

import {
  PLAN_SHOTS,
  SHOT_CRANE,
  SHOT_TRACKING,
} from '../../domain/agent/agentFixtures.testing';
import type { AgentPlanShot } from '../../shared/desktop/dto';

import {
  SHOT_DRAFT_FIELDS,
  SHOT_WIRE_FIELD,
  applyShotDraft,
  draftChanges,
  draftIsValid,
  planHasUserEdits,
  readShotDraft,
  removeShot,
  replaceShot,
  restoreShot,
  saveShotDraft,
  shotPosition,
  userTouchedCount,
  validateShotDraft,
  type ShotLabelSource,
} from './planEditModel';

/** Latin camera terms and plain view words: enough to assert on, no i18n. */
const LABELS: ShotLabelSource = {
  kind: (kind) => kind.toUpperCase(),
  view: (view) => view,
};

describe('readShotDraft', () => {
  it('round-trips a shot that nobody touched', () => {
    const draft = readShotDraft(SHOT_TRACKING);

    expect(draft.title).toBe(SHOT_TRACKING.title);
    expect(draft.kind).toBe('tracking');
    expect(draft.duration).toBe('8.5');
    expect(draft.startTick).toBe('148812');
    expect(draftChanges(SHOT_TRACKING, draft, 2, LABELS)).toEqual([]);
  });

  it('opens the note empty — a note describes this edit, not the last one', () => {
    expect(readShotDraft(SHOT_TRACKING).note).toBe('');
  });
});

describe('validateShotDraft', () => {
  const draft = readShotDraft(SHOT_TRACKING);

  it('accepts the shot as it stands', () => {
    expect(validateShotDraft(draft)).toEqual({});
    expect(draftIsValid(draft)).toBe(true);
  });

  it('rejects an empty title', () => {
    expect(validateShotDraft({ ...draft, title: '   ' }).title).toBeDefined();
  });

  it('rejects a duration that is not a number, and one below zero', () => {
    expect(validateShotDraft({ ...draft, duration: '' }).duration).toBeDefined();
    expect(validateShotDraft({ ...draft, duration: '八秒' }).duration).toBeDefined();
    expect(validateShotDraft({ ...draft, duration: '-1' }).duration).toBeDefined();
  });

  it('accepts a zero-length shot — 「不好」 is the user’s call, not the form’s', () => {
    expect(validateShotDraft({ ...draft, duration: '0' })).toEqual({});
  });

  it('rejects a fractional tick', () => {
    expect(validateShotDraft({ ...draft, startTick: '148812.5' }).startTick).toBeDefined();
  });

  it('rejects a range that runs backwards, and says so on the end field', () => {
    const errors = validateShotDraft({ ...draft, startTick: '200', endTick: '100' });
    expect(errors.endTick).toBeDefined();
    expect(errors.startTick).toBeUndefined();
  });

  it('lets an empty rationale through — the artboard has shots with none', () => {
    expect(validateShotDraft({ ...draft, rationale: '' })).toEqual({});
  });
});

describe('applyShotDraft', () => {
  it('marks the shot as the user’s, and never as awaiting anything', () => {
    const draft = { ...readShotDraft(SHOT_TRACKING), duration: '5' };
    const next = applyShotDraft(SHOT_TRACKING, draft);

    expect(next?.source).toBe('user');
    expect(next?.duration_seconds).toBe(5);
    // §4.5.3 ②: the shape has no approval field, so there is nothing to set.
    expect(Object.keys(next ?? {})).toEqual(Object.keys(SHOT_TRACKING));
  });

  it('keeps `params`, the evidence and the risks the Agent attached', () => {
    const shot: AgentPlanShot = { ...SHOT_TRACKING, params: { hlae: true } };
    const next = applyShotDraft(shot, { ...readShotDraft(shot), title: '跟随突破 · 短' });

    expect(next?.params).toEqual({ hlae: true });
    expect(next?.evidence_refs).toEqual(shot.evidence_refs);
    expect(next?.risks).toEqual(shot.risks);
  });

  it('refuses an invalid draft rather than writing NaN into the plan', () => {
    expect(applyShotDraft(SHOT_TRACKING, { ...readShotDraft(SHOT_TRACKING), duration: 'x' })).toBeNull();
  });

  it('trims the title but leaves the rationale as typed', () => {
    const next = applyShotDraft(SHOT_TRACKING, {
      ...readShotDraft(SHOT_TRACKING),
      title: '  跟随突破  ',
      rationale: '  留白  ',
    });
    expect(next?.title).toBe('跟随突破');
    expect(next?.rationale).toBe('  留白  ');
  });
});

describe('draftChanges', () => {
  const base = readShotDraft(SHOT_TRACKING);

  it('names the dto field, so the notice and the plan use one spelling', () => {
    const [change] = draftChanges(SHOT_TRACKING, { ...base, duration: '5' }, 2, LABELS);

    expect(change).toEqual({
      shot: 2,
      op: 'updated',
      field: 'duration_seconds',
      from: '8.5s',
      to: '5.0s',
    });
  });

  it('covers every draft field with a wire name', () => {
    for (const field of SHOT_DRAFT_FIELDS) {
      expect(SHOT_WIRE_FIELD[field]).toBeTruthy();
    }
  });

  it('emits one line per moved field and none for the rest', () => {
    const changes = draftChanges(
      SHOT_TRACKING,
      { ...base, kind: 'dolly', view: 'player_pov', endTick: '149132' },
      2,
      LABELS,
    );

    expect(changes.map((change) => change.field)).toEqual(['kind', 'view', 'end_tick']);
    expect(changes[0]?.from).toBe('TRACKING');
    expect(changes[0]?.to).toBe('DOLLY');
  });

  it('says nothing when a number is retyped in another spelling', () => {
    expect(draftChanges(SHOT_TRACKING, { ...base, duration: '8.50' }, 2, LABELS)).toEqual([]);
  });

  it('says nothing about the note — a note is not a field of the shot', () => {
    expect(draftChanges(SHOT_TRACKING, { ...base, note: '起手留给建立镜头' }, 2, LABELS)).toEqual([]);
  });

  it('ignores a field that cannot be parsed rather than writing a broken line', () => {
    expect(draftChanges(SHOT_TRACKING, { ...base, duration: '   ' }, 2, LABELS)).toEqual([]);
  });
});

describe('the list operations', () => {
  it('numbers a shot by its place in the whole array, removed shots included', () => {
    const shots = replaceShot(PLAN_SHOTS, { ...SHOT_TRACKING, removed_by: 'user' });

    expect(shotPosition(shots, 'shot-04')).toBe(4);
    expect(shotPosition(shots, 'shot-99')).toBe(0);
  });

  it('removes softly: the shot stays, its number stays, its text stays', () => {
    const result = removeShot(PLAN_SHOTS, 'shot-04');

    expect(result?.shots).toHaveLength(PLAN_SHOTS.length);
    const removed = result?.shots.find((shot) => shot.id === 'shot-04');
    expect(removed?.removed_by).toBe('user');
    expect(removed?.title).toBe(SHOT_CRANE.title);
    expect(removed?.rationale).toBe(SHOT_CRANE.rationale);
  });

  it('writes a removal with no field, so it cannot merge with a field edit', () => {
    expect(removeShot(PLAN_SHOTS, 'shot-04')?.changes).toEqual([
      { shot: 4, op: 'removed', field: null, from: null, to: null },
    ]);
  });

  it('refuses to remove twice — one delete is one notice', () => {
    const once = removeShot(PLAN_SHOTS, 'shot-04');
    expect(removeShot(once?.shots ?? [], 'shot-04')).toBeNull();
  });

  it('restores what it removed, and only what was removed', () => {
    const removed = removeShot(PLAN_SHOTS, 'shot-04');
    const restored = restoreShot(removed?.shots ?? [], 'shot-04');

    expect(restored?.shots.find((shot) => shot.id === 'shot-04')).toEqual(SHOT_CRANE);
    expect(restored?.changes[0]?.op).toBe('restored');
    expect(restoreShot(PLAN_SHOTS, 'shot-04')).toBeNull();
  });

  it('leaves the array alone when the id is unknown', () => {
    expect(removeShot(PLAN_SHOTS, 'shot-99')).toBeNull();
    expect(replaceShot(PLAN_SHOTS, { ...SHOT_TRACKING, id: 'shot-99' })).toBe(PLAN_SHOTS);
  });
});

describe('saveShotDraft', () => {
  it('returns the whole plan, not a delta — `AgentPlanEdit.shots` takes it all', () => {
    const draft = { ...readShotDraft(SHOT_TRACKING), duration: '5' };
    const result = saveShotDraft(PLAN_SHOTS, 'shot-02', draft, LABELS);

    expect(result?.shots).toHaveLength(PLAN_SHOTS.length);
    expect(result?.shots[1]?.duration_seconds).toBe(5);
    expect(result?.shots[0]).toBe(PLAN_SHOTS[0]);
  });

  it('is null when the save moved nothing — 放弃 by way of 保存 is not an edit', () => {
    expect(saveShotDraft(PLAN_SHOTS, 'shot-02', readShotDraft(SHOT_TRACKING), LABELS)).toBeNull();
  });

  it('is null for an unknown shot and for an invalid draft', () => {
    const draft = readShotDraft(SHOT_TRACKING);
    expect(saveShotDraft(PLAN_SHOTS, 'shot-99', draft, LABELS)).toBeNull();
    expect(saveShotDraft(PLAN_SHOTS, 'shot-02', { ...draft, title: '' }, LABELS)).toBeNull();
  });
});

describe('userTouchedCount', () => {
  it('counts nothing on a plan the Agent alone wrote', () => {
    expect(userTouchedCount(PLAN_SHOTS)).toBe(0);
    expect(planHasUserEdits(PLAN_SHOTS)).toBe(false);
  });

  it('counts an edited shot and a removed shot alike — both are the user’s hand', () => {
    const edited = replaceShot(PLAN_SHOTS, { ...SHOT_TRACKING, source: 'user' });
    const both = removeShot(edited, 'shot-04');

    expect(userTouchedCount(both?.shots ?? [])).toBe(2);
    expect(planHasUserEdits(both?.shots ?? [])).toBe(true);
  });

  it('does not count a shot the Agent removed', () => {
    const shots = replaceShot(PLAN_SHOTS, { ...SHOT_CRANE, removed_by: 'agent' });
    expect(userTouchedCount(shots)).toBe(0);
  });
});
