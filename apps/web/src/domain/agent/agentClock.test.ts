import { describe, expect, it } from 'vitest';

import { formatAgentTime, readSessionStamp } from './agentClock';

const UTC = { timeZone: 'UTC' } as const;

/** 2026-08-15 09:02 UTC — the drawer's 「当前」 row. */
const TODAY = '2026-08-15T09:02:00.000Z';
const YESTERDAY = '2026-08-14T21:40:00.000Z';
const OLDER = '2026-08-13T18:00:00.000Z';
const NOW = new Date('2026-08-15T10:00:00.000Z');

describe('formatAgentTime', () => {
  it('prints the 09:47 an edit-notice line carries', () => {
    expect(formatAgentTime('2026-08-15T09:47:12.000Z', UTC)).toBe('09:47');
  });
});

describe('readSessionStamp', () => {
  it('gives today the time of day', () => {
    expect(readSessionStamp(TODAY, { ...UTC, now: NOW })).toEqual({ kind: 'time', text: '09:02' });
  });

  it('gives yesterday its own bucket, and keeps the time for the title', () => {
    const stamp = readSessionStamp(YESTERDAY, { ...UTC, now: NOW });

    expect(stamp.kind).toBe('yesterday');
    // The word 「昨天」 is the component's; this module holds no copy.
    expect(stamp.text).toBe('21:40');
  });

  it('gives anything older the date alone — 「08-13」, no time', () => {
    expect(readSessionStamp(OLDER, { ...UTC, now: NOW })).toEqual({ kind: 'date', text: '08-13' });
  });

  it('compares calendar days, not elapsed hours', () => {
    // 23:50 → 00:10 is ten minutes apart and still 「昨天」.
    const stamp = readSessionStamp('2026-08-14T23:50:00.000Z', {
      ...UTC,
      now: new Date('2026-08-15T00:10:00.000Z'),
    });
    expect(stamp.kind).toBe('yesterday');

    // …while 00:10 and 23:50 of the *same* day are 23 hours apart and both 「今天」.
    const sameDay = readSessionStamp('2026-08-15T00:10:00.000Z', {
      ...UTC,
      now: new Date('2026-08-15T23:50:00.000Z'),
    });
    expect(sameDay.kind).toBe('time');
  });

  it('answers in the reader’s zone, not the machine’s', () => {
    // 2026-08-15T00:30Z is still 08-14 in New York, so relative to 08-15 there
    // it is 「昨天」 — and relative to 08-15 in UTC it is 「今天」.
    const options = { now: new Date('2026-08-15T12:00:00.000Z') };

    expect(readSessionStamp('2026-08-15T00:30:00.000Z', { ...options, timeZone: 'UTC' }).kind).toBe('time');
    expect(readSessionStamp('2026-08-15T00:30:00.000Z', { ...options, timeZone: 'America/New_York' }).kind).toBe(
      'yesterday',
    );
  });

  it('takes the dated form when nobody said what today is', () => {
    expect(readSessionStamp(TODAY, UTC)).toEqual({ kind: 'date', text: '08-15' });
  });

  it('shows an unparseable stamp as it arrived rather than blanking the cell', () => {
    expect(readSessionStamp('not a date', { ...UTC, now: NOW })).toEqual({ kind: 'date', text: 'not a date' });
  });

  it('does not call a future stamp 「昨天」', () => {
    expect(readSessionStamp('2026-08-16T09:00:00.000Z', { ...UTC, now: NOW }).kind).toBe('date');
  });
});
