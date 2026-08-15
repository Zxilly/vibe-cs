/*
 * pages/players — the arithmetic behind 「06 玩家目录」 and 「玩家档案与趋势」.
 *
 * Pure and React-free, so `playerStats.test.ts` runs it in the `unit` project.
 * Two things are enforced here rather than in a component:
 *
 *   1. **A missing statistic is `null`, never 0.** `PlayerAggregateStats`
 *      declares `average_adr` and `average_kill_death_ratio` nullable, and a
 *      player with no analysed rounds genuinely has no ADR. Printing 「0.0」
 *      would rank them below someone who was measured and found bad, which is
 *      a different claim. Every derivation below propagates `null`, and the
 *      table renders it as an em dash.
 *   2. **A rate needs its denominator.** 爆头率 is headshots ÷ kills; with no
 *      kills there is no rate, not a rate of zero. Same for the map table's
 *      win rate, which is why that one is *not* here — see the note on
 *      `PlayerMapTable`.
 */

import type { PlayerAggregateStats, PlayerMatch } from '../../shared/desktop/dto';

/* ── derived statistics ──────────────────────────────────────────────────── */

/** 爆头率, as a fraction in [0, 1], or `null` when there were no kills. */
export function headshotRate(stats: Pick<PlayerAggregateStats, 'kills' | 'headshots'>): number | null {
  if (stats.kills <= 0) return null;
  return stats.headshots / stats.kills;
}

/* ── formatting ──────────────────────────────────────────────────────────── */

/**
 * The em dash the tables print for an absent number. A single constant so the
 * 「没有这个数」 glyph cannot drift between the directory, the profile and the
 * comparison panel.
 */
export const NO_VALUE = '—';

/**
 * Fixed-point, or the dash. `Number.prototype.toFixed` rather than `Intl`
 * because these columns are mono and fixed-width by design — a locale that
 * groups thousands or swaps the decimal separator would make the column ragged
 * between rows, and 1.42 is not a quantity anyone reads as a word.
 */
export function formatFixed(value: number | null | undefined, digits: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  return value.toFixed(digits);
}

/** 「57%」 from a fraction in [0, 1]. Rounded, because the artboard prints
 *  whole percents and a decimal here suggests a precision the sample size does
 *  not support. */
export function formatPercent(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction)) return NO_VALUE;
  return `${String(Math.round(fraction * 100))}%`;
}

/** 「08-14」, matching the artboard's 最近出场 column. Empty rather than a dash
 *  when the service sent no date, so the caller can pick the placeholder. */
export function formatDay(matchDate: string | null): string {
  if (matchDate === null) return '';
  return matchDate.slice(0, 10);
}

export function formatMonthDay(matchDate: string | null): string {
  const day = formatDay(matchDate);
  return day.length === 10 ? day.slice(5) : day;
}

/**
 * The single-letter plate the profile header draws to the left of the name
 * (「K」 for Kael). The first code point, not the first UTF-16 unit — a name
 * starting with an astral character would otherwise render as half a surrogate
 * pair.
 */
export function nameInitial(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return '?';
  return [...trimmed][0] ?? '?';
}

/* ── the trend chart ─────────────────────────────────────────────────────── */

/** The three metrics the profile's segmented control offers, per the artboard
 *  (「K/D · ADR · 爆头率」). */
export const TREND_METRICS = ['kd', 'adr', 'headshot'] as const;
export type TrendMetric = (typeof TREND_METRICS)[number];

/**
 * 「最近 20 场」, the artboard's own window. Also the page size the profile asks
 * `listPlayerMatches` for, so the chart never draws from a sample the match
 * table below it does not also list.
 */
export const TREND_WINDOW = 20;

/** One point of the chart: the value, and enough identity to name it. */
export interface TrendPoint {
  readonly demoId: string;
  readonly label: string;
  readonly value: number;
}

/**
 * The metric's value for one match, or `null` when it was not measured.
 * 爆头率 is derived rather than sent, which is why this is a function of the
 * whole row instead of a field lookup.
 */
export function trendValue(match: PlayerMatch, metric: TrendMetric): number | null {
  switch (metric) {
    case 'kd':
      return match.kill_death_ratio;
    case 'adr':
      return match.adr;
    case 'headshot':
      return headshotRate(match);
  }
}

/**
 * The series, oldest first.
 *
 * `listPlayerMatches` answers newest-first (it is the 最近比赛 list), and a
 * trend line has to read left-to-right in time or the slope means the opposite
 * of what it looks like. Reversing here — once, in a tested function — is
 * cheaper than remembering it at three call sites.
 *
 * Matches with no value for this metric are dropped rather than plotted at
 * zero: a gap in the line is honest, a dip to zero is not.
 */
export function trendSeries(
  matches: readonly PlayerMatch[],
  metric: TrendMetric,
): readonly TrendPoint[] {
  const points: TrendPoint[] = [];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    if (match === undefined) continue;
    const value = trendValue(match, metric);
    if (value === null || !Number.isFinite(value)) continue;
    points.push({
      demoId: match.demo_id,
      label: `${match.map_name ?? NO_VALUE} · ${formatMonthDay(match.match_date)}`,
      value,
    });
  }
  return points;
}

/** The mean of a series — the artboard's 「灰线为该指标的个人均值」. */
export function trendAverage(points: readonly TrendPoint[]): number | null {
  if (points.length === 0) return null;
  const total = points.reduce((sum, point) => sum + point.value, 0);
  return total / points.length;
}

/* ── chart geometry ──────────────────────────────────────────────────────── */

export interface TrendGeometry {
  /** `d` for the polyline. Empty when there is nothing to draw. */
  readonly path: string;
  /** `y` of the average rule, or `null` when there is no average. */
  readonly averageY: number | null;
  /** The value at the top and the bottom of the box, for the axis labels. */
  readonly maximum: number;
  readonly minimum: number;
}

/**
 * The chart, in view-box units.
 *
 * The band is padded by 10% of the observed range so the extremes are not drawn
 * on the frame, and a series whose values are all equal gets a flat line
 * through the middle rather than a division by zero. The scale is anchored to
 * the *observed* extremes and both are returned, so the axis prints numbers
 * that were measured — the same rule `domain/map/heatBinning` states for the
 * heat ladder.
 */
export function trendGeometry(
  points: readonly TrendPoint[],
  width: number,
  height: number,
): TrendGeometry {
  if (points.length === 0) return { path: '', averageY: null, maximum: 0, minimum: 0 };

  const values = points.map((point) => point.value);
  const rawMax = Math.max(...values);
  const rawMin = Math.min(...values);
  const pad = rawMax === rawMin ? Math.max(Math.abs(rawMax) * 0.1, 0.5) : (rawMax - rawMin) * 0.1;
  const maximum = rawMax + pad;
  const minimum = rawMin - pad;
  const span = maximum - minimum;

  const y = (value: number): number => height - ((value - minimum) / span) * height;
  const step = points.length === 1 ? 0 : width / (points.length - 1);

  const path = points
    .map((point, index) => {
      const x = points.length === 1 ? width / 2 : index * step;
      return `${index === 0 ? 'M' : 'L'}${round(x)} ${round(y(point.value))}`;
    })
    .join(' ');

  const average = trendAverage(points);
  return {
    path,
    averageY: average === null ? null : round(y(average)),
    maximum,
    minimum,
  };
}

/** Two decimals is under a tenth of a view-box unit at these sizes, and it
 *  keeps the `d` attribute short enough that the markup test can read it. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
