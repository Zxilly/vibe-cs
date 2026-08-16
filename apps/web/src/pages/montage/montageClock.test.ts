import { describe, expect, it } from 'vitest';

import { readSaveStamp, splitMinutesSeconds } from './montageClock';

const NOW = new Date('2026-08-16T12:00:00.000Z');

describe('readSaveStamp', () => {
  it('reads the artboard stamp: 「上次保存 3 分钟前」', () => {
    expect(readSaveStamp('2026-08-16T11:57:00.000Z', NOW)).toEqual({ kind: 'minutes', value: 3 });
  });

  it('says 「刚刚」 inside a minute rather than 「0 分钟前」', () => {
    expect(readSaveStamp('2026-08-16T11:59:30.000Z', NOW)).toEqual({ kind: 'now' });
  });

  it('treats a stamp from the future as 「刚刚」, never as a negative count', () => {
    expect(readSaveStamp('2026-08-16T12:05:00.000Z', NOW)).toEqual({ kind: 'now' });
  });

  it('rounds down to whole minutes and whole hours', () => {
    expect(readSaveStamp('2026-08-16T11:00:30.000Z', NOW)).toEqual({ kind: 'minutes', value: 59 });
    expect(readSaveStamp('2026-08-16T10:59:30.000Z', NOW)).toEqual({ kind: 'hours', value: 1 });
    expect(readSaveStamp('2026-08-15T13:00:00.000Z', NOW)).toEqual({ kind: 'hours', value: 23 });
  });

  it('falls back to the absolute stamp past a day, because 「30 小时前」 is arithmetic', () => {
    expect(readSaveStamp('2026-08-15T09:12:00.000Z', NOW, { timeZone: 'UTC' })).toEqual({
      kind: 'clock',
      text: '08-15 09:12',
    });
  });

  it('answers null for an unparseable timestamp so the header can omit the clause', () => {
    expect(readSaveStamp('not-a-date', NOW)).toBeNull();
  });
});

describe('splitMinutesSeconds', () => {
  it('splits 「2 分 04 秒」 with the seconds zero-padded', () => {
    expect(splitMinutesSeconds(124)).toEqual({ minutes: 2, seconds: '04' });
  });

  it('rounds to the nearest second and carries into the minute', () => {
    expect(splitMinutesSeconds(119.6)).toEqual({ minutes: 2, seconds: '00' });
  });

  it('has a zero form, which is different from having no answer', () => {
    expect(splitMinutesSeconds(0)).toEqual({ minutes: 0, seconds: '00' });
    expect(splitMinutesSeconds(Number.NaN)).toBeNull();
    expect(splitMinutesSeconds(-1)).toBeNull();
  });
});
