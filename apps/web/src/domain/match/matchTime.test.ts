import { describe, expect, it } from 'vitest';

import { formatFrameTimecode, formatTimecode } from '../../design/timeline/timeScale';
import {
  CS2_TICK_RATE,
  formatSeconds,
  formatTickClock,
  formatTickCount,
  formatTickRange,
  formatTickRangeSeconds,
  formatTickTimecode,
  resolveTickRate,
  secondsToTick,
  tickRangeSeconds,
  tickToSeconds,
  TICK_GROUP_SEPARATOR,
  TICK_RANGE_DASH,
} from './matchTime';

describe('CS2_TICK_RATE', () => {
  it('is 64, the rate CS2 records at and the rate the context bar prints', () => {
    expect(CS2_TICK_RATE).toBe(64);
  });
});

describe('resolveTickRate', () => {
  it('passes a usable rate through, integer or not', () => {
    expect(resolveTickRate(128)).toBe(128);
    expect(resolveTickRate(63.5)).toBe(63.5);
    expect(resolveTickRate(0.5)).toBe(0.5);
  });

  it('falls back to the CS2 rate rather than dividing by zero or by NaN', () => {
    expect(resolveTickRate(0)).toBe(CS2_TICK_RATE);
    expect(resolveTickRate(-64)).toBe(CS2_TICK_RATE);
    expect(resolveTickRate(Number.NaN)).toBe(CS2_TICK_RATE);
    expect(resolveTickRate(Number.POSITIVE_INFINITY)).toBe(CS2_TICK_RATE);
    expect(resolveTickRate(undefined)).toBe(CS2_TICK_RATE);
  });
});

describe('tickToSeconds / secondsToTick', () => {
  it('divides by the rate', () => {
    expect(tickToSeconds(0)).toBe(0);
    expect(tickToSeconds(64)).toBe(1);
    expect(tickToSeconds(148_920)).toBeCloseTo(2326.875, 6);
    expect(tickToSeconds(128, 128)).toBe(1);
  });

  it('keeps negative ticks negative — a range may run backwards', () => {
    expect(tickToSeconds(-64)).toBe(-1);
    expect(secondsToTick(-1)).toBe(-64);
  });

  it('survives a non-integer rate', () => {
    expect(tickToSeconds(127, 63.5)).toBe(2);
    expect(secondsToTick(2, 63.5)).toBe(127);
  });

  it('rounds a seek to the nearest whole tick, never to a fraction of one', () => {
    expect(secondsToTick(1.001)).toBe(64);
    expect(secondsToTick(1.008)).toBe(65);
    expect(Number.isInteger(secondsToTick(3.14159))).toBe(true);
  });

  it('answers 0 for a non-finite input instead of propagating NaN', () => {
    expect(tickToSeconds(Number.NaN)).toBe(0);
    expect(tickToSeconds(Number.POSITIVE_INFINITY)).toBe(0);
    expect(secondsToTick(Number.NaN)).toBe(0);
  });

  it('round-trips a whole tick', () => {
    for (const tick of [0, 1, 63, 64, 65, 148_920, -3200]) {
      expect(secondsToTick(tickToSeconds(tick))).toBe(tick);
    }
  });
});

describe('tickRangeSeconds', () => {
  it('measures the interval a highlight covers', () => {
    expect(tickRangeSeconds(148_920, 150_440)).toBeCloseTo(23.75, 6);
    expect(tickRangeSeconds(0, 64)).toBe(1);
  });

  it('is negative when the range runs backwards', () => {
    expect(tickRangeSeconds(150_440, 148_920)).toBeCloseTo(-23.75, 6);
  });
});

describe('formatTickClock', () => {
  it('delegates to timeScale.formatTimecode on the derived seconds', () => {
    expect(formatTickClock(0)).toBe(formatTimecode(0));
    expect(formatTickClock(148_920)).toBe(formatTimecode(148_920 / 64));
  });

  it('is mm:ss under the hour and h:mm:ss over it', () => {
    expect(formatTickClock(64 * 19)).toBe('00:19');
    expect(formatTickClock(64 * 43)).toBe('00:43');
    expect(formatTickClock(64 * 3599)).toBe('59:59');
    expect(formatTickClock(64 * 3600)).toBe('1:00:00');
    expect(formatTickClock(64 * 3661)).toBe('1:01:01');
  });

  it('signs a negative tick', () => {
    expect(formatTickClock(-64 * 90)).toBe('-01:30');
  });
});

describe('formatTickTimecode', () => {
  it('prints hh:mm:ss:ff with the tick as the last field', () => {
    expect(formatTickTimecode(0)).toBe('00:00:00:00');
    expect(formatTickTimecode(1)).toBe('00:00:00:01');
    expect(formatTickTimecode(63)).toBe('00:00:00:63');
    // 64 ticks is one whole second, so the last field wraps rather than
    // reaching the rate itself.
    expect(formatTickTimecode(64)).toBe('00:00:01:00');
  });

  it('crosses the hour', () => {
    expect(formatTickTimecode(64 * 3600)).toBe('01:00:00:00');
    expect(formatTickTimecode(64 * 3661 + 7)).toBe('01:01:01:07');
  });

  it('signs a negative tick without losing a field', () => {
    expect(formatTickTimecode(-64)).toBe('-00:00:01:00');
  });

  it('honours a non-CS2 rate in both the seconds and the frame field', () => {
    expect(formatTickTimecode(128, 128)).toBe('00:00:01:00');
    expect(formatTickTimecode(127, 128)).toBe('00:00:00:127');
  });

  it('rounds only the frame field of a fractional rate; seconds keep the rate', () => {
    // 127 / 63.5 is exactly 2s, so the frame field is 0 and the seconds field 2.
    expect(formatTickTimecode(127, 63.5)).toBe('00:00:02:00');
    expect(formatTickTimecode(127, 63.5)).toBe(formatFrameTimecode(2, 64));
  });

  it('falls back to the CS2 rate when the header gave none', () => {
    expect(formatTickTimecode(64, 0)).toBe(formatTickTimecode(64));
    expect(formatTickTimecode(64, Number.NaN)).toBe(formatTickTimecode(64));
  });
});

describe('formatTickCount', () => {
  it('groups by three with a thin space, as the reference writes it', () => {
    expect(formatTickCount(148_920)).toBe(`148${TICK_GROUP_SEPARATOR}920`);
    expect(formatTickCount(1_284_632)).toBe(
      `1${TICK_GROUP_SEPARATOR}284${TICK_GROUP_SEPARATOR}632`,
    );
  });

  it('leaves anything under four digits alone', () => {
    expect(formatTickCount(0)).toBe('0');
    expect(formatTickCount(7)).toBe('7');
    expect(formatTickCount(999)).toBe('999');
    expect(formatTickCount(1000)).toBe(`1${TICK_GROUP_SEPARATOR}000`);
  });

  it('keeps the sign outside the grouping', () => {
    expect(formatTickCount(-148_920)).toBe(`-148${TICK_GROUP_SEPARATOR}920`);
  });

  it('truncates a fractional tick rather than printing a decimal point', () => {
    expect(formatTickCount(1000.7)).toBe(`1${TICK_GROUP_SEPARATOR}000`);
  });

  it('answers 0 for a non-finite tick', () => {
    expect(formatTickCount(Number.NaN)).toBe('0');
    expect(formatTickCount(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('formatTickRange', () => {
  it('joins two grouped ticks with an en dash', () => {
    expect(formatTickRange(148_920, 150_440)).toBe(
      `148${TICK_GROUP_SEPARATOR}920${TICK_RANGE_DASH}150${TICK_GROUP_SEPARATOR}440`,
    );
  });
});

describe('formatSeconds / formatTickRangeSeconds', () => {
  it('rounds to one decimal by default', () => {
    expect(formatSeconds(23.75)).toBe(23.8);
    expect(formatSeconds(1.84)).toBe(1.8);
    expect(formatSeconds(42)).toBe(42);
  });

  it('takes a digit count, clamped to something a display can hold', () => {
    expect(formatSeconds(1.2345, 0)).toBe(1);
    expect(formatSeconds(1.2345, 3)).toBe(1.235);
    expect(formatSeconds(1.2345, -2)).toBe(1);
  });

  it('answers 0 for a non-finite input', () => {
    expect(formatSeconds(Number.NaN)).toBe(0);
  });

  it('measures a highlight the way the row prints it', () => {
    expect(formatTickRangeSeconds(148_920, 150_440)).toBe(23.8);
    expect(formatTickRangeSeconds(149_340, 149_420)).toBe(1.3);
  });
});
