import { describe, expect, it } from 'vitest';

import { formatTickCount as matchTickCount, formatTickRange as matchTickRange } from '../match/matchTime';
import {
  formatShotDuration,
  formatSignedSeconds,
  formatStripTimecode,
  formatTickCount,
  formatTickRange,
} from './shotFormat';

describe('formatShotDuration', () => {
  it('always prints one decimal, so a column of shots lines up', () => {
    expect(formatShotDuration(3)).toBe('3.0s');
    expect(formatShotDuration(8.5)).toBe('8.5s');
    expect(formatShotDuration(24)).toBe('24.0s');
  });

  it('rounds rather than truncating', () => {
    expect(formatShotDuration(8.46)).toBe('8.5s');
  });

  it('keeps its box when the number is broken', () => {
    expect(formatShotDuration(Number.NaN)).toBe('0.0s');
    expect(formatShotDuration(Number.POSITIVE_INFINITY)).toBe('0.0s');
  });
});

describe('formatSignedSeconds', () => {
  it('uses U+2212, the artboard glyph, and not a hyphen', () => {
    expect(formatSignedSeconds(-5.5)).toBe('−5.5s');
    expect(formatSignedSeconds(-5.5)).not.toContain('-');
  });

  it('signs an increase as well, because a delta with no sign is ambiguous', () => {
    expect(formatSignedSeconds(9)).toBe('+9.0s');
  });

  it('writes 「compared, and the same」 rather than an empty cell', () => {
    expect(formatSignedSeconds(0)).toBe('±0s');
    expect(formatSignedSeconds(Number.NaN)).toBe('±0s');
  });
});

describe('formatStripTimecode', () => {
  it('prints the ruler marks the artboard prints', () => {
    expect(formatStripTimecode(0)).toBe('00:00');
    expect(formatStripTimecode(10.5)).toBe('00:11');
    expect(formatStripTimecode(42)).toBe('00:42');
  });

  it('carries over into minutes', () => {
    expect(formatStripTimecode(124)).toBe('02:04');
  });

  it('never prints a negative or a NaN clock', () => {
    expect(formatStripTimecode(-9)).toBe('00:00');
    expect(formatStripTimecode(Number.NaN)).toBe('00:00');
  });
});

describe('the tick reading', () => {
  it('is `domain/match`’s, re-exported rather than re-implemented', () => {
    // One spelling of 「148 620」 in the product: the evidence row, the highlight
    // list and the shot card must not disagree about the grouping.
    expect(formatTickCount).toBe(matchTickCount);
    expect(formatTickRange).toBe(matchTickRange);
    expect(formatTickRange(148_620, 148_812)).toBe(matchTickRange(148_620, 148_812));
  });
});
