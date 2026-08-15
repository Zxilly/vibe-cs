/*
 * `unit` project — the profile's arithmetic.
 *
 * Everything here is about the difference between "zero" and "not measured".
 * The tables rank on these numbers, and a player who was never measured must
 * not be ranked below one who was measured and found bad.
 */

import { describe, expect, it } from 'vitest';

import {
  NO_VALUE,
  formatDay,
  formatFixed,
  formatMonthDay,
  formatPercent,
  headshotRate,
  nameInitial,
  trendAverage,
  trendGeometry,
  trendSeries,
  trendValue,
} from './playerStats';
import { playerMatch, playerMatches } from './test/fixtures';

describe('derived statistics', () => {
  it('is headshots ÷ kills', () => {
    expect(headshotRate({ kills: 100, headshots: 57 })).toBeCloseTo(0.57);
  });

  it('is null with no kills — a rate needs its denominator', () => {
    expect(headshotRate({ kills: 0, headshots: 0 })).toBeNull();
  });
});

describe('formatting', () => {
  it('prints the dash for a statistic that was never measured', () => {
    expect(formatFixed(null, 2)).toBe(NO_VALUE);
    expect(formatFixed(undefined, 2)).toBe(NO_VALUE);
    expect(formatFixed(Number.NaN, 2)).toBe(NO_VALUE);
    expect(formatPercent(null)).toBe(NO_VALUE);
  });

  it('distinguishes a measured zero from a missing one', () => {
    expect(formatFixed(0, 2)).toBe('0.00');
    expect(formatPercent(0)).toBe('0%');
  });

  it('keeps the columns fixed-width', () => {
    expect(formatFixed(1.42, 2)).toBe('1.42');
    expect(formatFixed(89.7, 1)).toBe('89.7');
    expect(formatPercent(0.574)).toBe('57%');
  });

  it('prints the artboard s two date shapes', () => {
    expect(formatDay('2026-08-14T20:11:00Z')).toBe('2026-08-14');
    expect(formatMonthDay('2026-08-14T20:11:00Z')).toBe('08-14');
    expect(formatMonthDay(null)).toBe('');
  });

  it('takes a whole code point for the initial plate', () => {
    expect(nameInitial('Kael')).toBe('K');
    expect(nameInitial('  sable ')).toBe('s');
    expect(nameInitial('')).toBe('?');
    // A surrogate pair must not be split in half.
    expect(nameInitial('𝕶ael')).toBe('𝕶');
  });
});

describe('the trend series', () => {
  it('reads left to right in time', () => {
    // `listPlayerMatches` answers newest-first; a trend line drawn in that order
    // would show every slope backwards.
    const series = trendSeries(playerMatches(3), 'kd');
    // The fixture walks 1.90 / 1.85 / 1.80 newest-first, so ascending here is
    // the reversal. Compared with a tolerance because the fixture builds the
    // values by subtraction and 1.9 − 0.05 is not exactly 1.85 in binary.
    expect(series.map((point) => point.value)).toEqual([
      expect.closeTo(1.8, 6),
      expect.closeTo(1.85, 6),
      expect.closeTo(1.9, 6),
    ]);
  });

  it('drops a match with no value instead of plotting it at zero', () => {
    const series = trendSeries(
      [playerMatch({ kill_death_ratio: null }), playerMatch({ kill_death_ratio: 1.2 })],
      'kd',
    );
    expect(series).toHaveLength(1);
    expect(series[0]?.value).toBe(1.2);
  });

  it('derives 爆头率 per match rather than looking for a field', () => {
    expect(trendValue(playerMatch({ kills: 20, headshots: 5 }), 'headshot')).toBeCloseTo(0.25);
    expect(trendValue(playerMatch({ kills: 0, headshots: 0 }), 'headshot')).toBeNull();
  });

  it('averages only what it plotted', () => {
    expect(trendAverage(trendSeries(playerMatches(3), 'kd'))).toBeCloseTo(1.85);
    expect(trendAverage([])).toBeNull();
  });
});

describe('the chart geometry', () => {
  const series = trendSeries(playerMatches(4), 'kd');

  it('is empty for an empty series — no path, no average, no axis numbers', () => {
    expect(trendGeometry([], 560, 170)).toEqual({
      path: '',
      averageY: null,
      maximum: 0,
      minimum: 0,
    });
  });

  it('draws one command per point, starting with a move', () => {
    const geometry = trendGeometry(series, 560, 170);
    expect(geometry.path.startsWith('M')).toBe(true);
    expect(geometry.path.split(/[ML]/u).filter((part) => part !== '')).toHaveLength(series.length);
  });

  it('spans the full width', () => {
    const geometry = trendGeometry(series, 560, 170);
    expect(geometry.path).toContain('M0 ');
    expect(geometry.path).toContain('L560 ');
  });

  it('anchors the band to the observed extremes, padded so they are not on the frame', () => {
    const geometry = trendGeometry(series, 560, 170);
    const values = series.map((point) => point.value);
    expect(geometry.minimum).toBeLessThan(Math.min(...values));
    expect(geometry.maximum).toBeGreaterThan(Math.max(...values));
  });

  it('draws a flat line rather than dividing by zero when every value is equal', () => {
    const flat = trendSeries(
      [playerMatch({ kill_death_ratio: 1 }), playerMatch({ kill_death_ratio: 1 })],
      'kd',
    );
    const geometry = trendGeometry(flat, 100, 100);
    expect(geometry.path).toBe('M0 50 L100 50');
    expect(geometry.averageY).toBe(50);
  });

  it('centres a single point instead of pinning it to the left edge', () => {
    const one = trendSeries([playerMatch({ kill_death_ratio: 1.5 })], 'kd');
    expect(trendGeometry(one, 100, 100).path).toBe('M50 50');
  });

  it('puts the average rule inside the box', () => {
    const geometry = trendGeometry(series, 560, 170);
    expect(geometry.averageY).not.toBeNull();
    expect(geometry.averageY ?? -1).toBeGreaterThan(0);
    expect(geometry.averageY ?? 999).toBeLessThan(170);
  });
});
