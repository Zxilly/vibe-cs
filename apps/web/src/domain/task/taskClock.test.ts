import { describe, expect, it } from 'vitest';

import { formatTaskClock, formatTaskTime } from './taskClock';

const UTC = { timeZone: 'UTC' } as const;

describe('formatTaskTime', () => {
  it('stamps a log line with hours and minutes only', () => {
    expect(formatTaskTime('2026-08-15T09:09:41Z', UTC)).toBe('09:09');
  });

  it('pads both fields so a column of stamps stays aligned', () => {
    expect(formatTaskTime('2026-08-15T07:05:00Z', UTC)).toBe('07:05');
  });

  it('writes midnight as 00:00, never as 24:00', () => {
    expect(formatTaskTime('2026-08-15T00:00:00Z', UTC)).toBe('00:00');
  });

  it('reads the instant in the zone it was asked for', () => {
    const iso = '2026-08-15T23:30:00Z';

    expect(formatTaskTime(iso, UTC)).toBe('23:30');
    expect(formatTaskTime(iso, { timeZone: 'Asia/Shanghai' })).toBe('07:30');
  });

  it('shows an unparseable stamp as it arrived instead of blanking it', () => {
    expect(formatTaskTime('not-a-timestamp', UTC)).toBe('not-a-timestamp');
  });
});

describe('formatTaskClock', () => {
  it('writes the long form when it has no opinion about today', () => {
    expect(formatTaskClock('2026-08-15T08:40:00Z', UTC)).toBe('08-15 08:40');
  });

  it('drops the date only when the stamp falls on the reader’s today', () => {
    const now = new Date('2026-08-15T21:00:00Z');

    expect(formatTaskClock('2026-08-15T09:12:00Z', { ...UTC, now })).toBe('09:12');
    expect(formatTaskClock('2026-08-14T22:03:00Z', { ...UTC, now })).toBe('08-14 22:03');
  });

  it('decides "same day" in the reader’s zone, not in UTC', () => {
    // 2026-08-15T23:30Z is already 08-16 in Shanghai, so against a Shanghai
    // "today" of 08-15 the date has to stay on.
    const now = new Date('2026-08-15T04:00:00Z');
    const iso = '2026-08-15T23:30:00Z';

    expect(formatTaskClock(iso, { timeZone: 'UTC', now })).toBe('23:30');
    expect(formatTaskClock(iso, { timeZone: 'Asia/Shanghai', now })).toBe('08-16 07:30');
  });

  it('does not treat the same day of another year as today', () => {
    const now = new Date('2026-08-15T09:00:00Z');

    expect(formatTaskClock('2025-08-15T09:12:00Z', { ...UTC, now })).toBe('08-15 09:12');
  });

  it('shows an unparseable stamp as it arrived', () => {
    expect(formatTaskClock('', UTC)).toBe('');
    expect(formatTaskClock('待补', UTC)).toBe('待补');
  });
});
