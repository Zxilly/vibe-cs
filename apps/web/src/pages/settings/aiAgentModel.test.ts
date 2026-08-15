/*
 * `unit` project — 设置 · AI 与 Agent's pure decisions.
 *
 * The one that matters most is the last describe block: §4.5.3 rule ① says
 * 「录制只由一次显式确认启动」, and the switch that shows it must read the place
 * the product enforces it rather than a `true` typed into a settings file.
 */

import { describe, expect, it } from 'vitest';

import { retentionOptionId } from '../../data/sessions';
import { TASK_REQUIRES_CONFIRMATION } from '../../domain/task';
import type { AgentSessionRetention } from '../../shared/desktop/dto';
import {
  RECORDING_CONFIRMATION_LOCKED_ON,
  RETENTION_PRESETS,
  TAKE_LIMIT_MAX,
  TAKE_LIMIT_MIN,
  clampTakeLimit,
  retentionChoices,
  retentionFromOptionId,
} from './aiAgentModel';

describe('the retention presets', () => {
  it('are the artboard’s four, in its order', () => {
    expect(RETENTION_PRESETS).toEqual([
      { mode: 'all' },
      { mode: 'recent_count', count: 50 },
      { mode: 'max_age_days', days: 30 },
      { mode: 'none' },
    ]);
  });

  it('flatten to four distinct option ids', () => {
    const ids = RETENTION_PRESETS.map(retentionOptionId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('offer exactly the four when the stored policy is one of them', () => {
    expect(retentionChoices({ mode: 'max_age_days', days: 30 })).toEqual(RETENTION_PRESETS);
  });

  it('append the stored policy when it is none of them, rather than snapping to a preset', () => {
    /* A control that showed 「最近 50 条」 over a stored 20 would write 50 the
       first time anything else on the page was touched. */
    const stored: AgentSessionRetention = { mode: 'recent_count', count: 20 };
    const choices = retentionChoices(stored);
    expect(choices).toHaveLength(RETENTION_PRESETS.length + 1);
    expect(choices.at(-1)).toEqual(stored);
    expect(choices.map(retentionOptionId)).toContain(retentionOptionId(stored));
  });

  it('maps an option id back to its whole value, payload included', () => {
    const choices = retentionChoices({ mode: 'all' });
    expect(retentionFromOptionId('recent_count:50', choices)).toEqual({
      mode: 'recent_count',
      count: 50,
    });
    expect(retentionFromOptionId('max_age_days:30', choices)).toEqual({
      mode: 'max_age_days',
      days: 30,
    });
  });

  it('returns null for an id nobody offered, so a stray change writes nothing', () => {
    expect(retentionFromOptionId('recent_count:7', retentionChoices({ mode: 'all' }))).toBeNull();
    expect(retentionFromOptionId('', retentionChoices({ mode: 'all' }))).toBeNull();
  });
});

describe('clampTakeLimit', () => {
  it('leaves a value inside the range alone', () => {
    expect(clampTakeLimit(5)).toBe(5);
    expect(clampTakeLimit(TAKE_LIMIT_MIN)).toBe(TAKE_LIMIT_MIN);
    expect(clampTakeLimit(TAKE_LIMIT_MAX)).toBe(TAKE_LIMIT_MAX);
  });

  it('clamps rather than rejecting — a stored 0 still puts the thumb somewhere', () => {
    expect(clampTakeLimit(0)).toBe(TAKE_LIMIT_MIN);
    expect(clampTakeLimit(-4)).toBe(TAKE_LIMIT_MIN);
    expect(clampTakeLimit(99)).toBe(TAKE_LIMIT_MAX);
  });

  it('rounds, because the control has integer steps', () => {
    expect(clampTakeLimit(4.4)).toBe(4);
    expect(clampTakeLimit(4.6)).toBe(5);
  });

  it('never yields NaN, which would detach the thumb from the track', () => {
    expect(clampTakeLimit(Number.NaN)).toBe(TAKE_LIMIT_MIN);
    expect(clampTakeLimit(Number.POSITIVE_INFINITY)).toBe(TAKE_LIMIT_MIN);
  });
});

describe('§4.5.3 rule ①, as the settings panel reads it', () => {
  it('is on, and it is the task machine’s answer rather than a literal', () => {
    expect(RECORDING_CONFIRMATION_LOCKED_ON).toBe(true);
    expect(RECORDING_CONFIRMATION_LOCKED_ON).toBe(TASK_REQUIRES_CONFIRMATION.recording);
  });
});
