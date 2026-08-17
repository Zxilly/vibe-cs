/*
 * pages/players — 「最近 20 场」 of 「玩家档案与趋势」.
 *
 * The artboard draws a segmented control (K/D · ADR · 爆头率), a caption
 * 「最近 20 场 · 灰线为该指标的个人均值」, and a framed 170px box holding three
 * hairline gridlines, one accent polyline and one dashed neutral rule at the
 * mean, with three axis numbers down the left.
 *
 * ── Why an inline SVG and no chart library ─────────────────────────────────
 *
 * One polyline over at most 20 points is 20 numbers in a `d` attribute — one
 * DOM node, no dependency, no runtime layout pass. `domain/map/MapCanvas`
 * makes the same argument for the map surface at a much larger scale. Bringing
 * a charting package in for this would add a bundle, a theme adapter and a
 * second set of colour decisions for a single path.
 *
 * ── The picture is never the only channel ──────────────────────────────────
 *
 * The reference's rule for the map canvas — 「右侧提供列表式替代视图，不只靠画布
 * 传达信息」 — applies to a line just as much. So the SVG carries a written
 * `aria-label` naming the metric, the window, the range and the mean; the axis
 * prints the observed extremes rather than a round number; and the 按地图 table
 * beneath it holds the same underlying matches in rows. A reader who never sees
 * the line loses nothing but the shape.
 *
 * ── Nothing is invented ────────────────────────────────────────────────────
 *
 * `trendSeries` drops a match with no value for the metric instead of plotting
 * it at zero, and the caption says how many matches the line is actually drawn
 * from. `trendGeometry` anchors the band to the observed extremes, so the axis
 * numbers are measurements — the same rule `heatBinning` states for the heat
 * ladder.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { Empty } from '../../design/data';
import { Seg, type SegOption } from '../../design/primitives';
import type { PlayerMatch } from '../../shared/desktop/dto';
import {
  TREND_METRICS,
  TREND_WINDOW,
  formatFixed,
  formatPercent,
  trendAverage,
  trendGeometry,
  trendSeries,
  type TrendMetric,
} from './playerStats';

/** View-box units. The artboard's box is 560 × 170; the SVG scales to its
 *  container, so these are a ratio anchor rather than a pixel commitment —
 *  the same disposition `MAP_CANVAS_EXTENT` records. */
const CHART_WIDTH = 560;
const CHART_HEIGHT = 170;

function metricLabel(metric: TrendMetric): ReactNode {
  switch (metric) {
    case 'kd':
      return <Trans>K/D</Trans>;
    case 'adr':
      return <Trans>ADR</Trans>;
    case 'headshot':
      return <Trans>爆头率</Trans>;
  }
}

function metricName(metric: TrendMetric): string {
  switch (metric) {
    case 'kd':
      return 'K/D';
    case 'adr':
      return 'ADR';
    case 'headshot':
      return t`爆头率`;
  }
}

/** The axis and the accessible summary print the metric in its own units. */
function printValue(metric: TrendMetric, value: number | null): string {
  if (metric === 'headshot') return formatPercent(value);
  return formatFixed(value, metric === 'adr' ? 1 : 2);
}

export interface PlayerTrendProps {
  /** Newest first, as `listPlayerMatches` answers. `trendSeries` reverses it. */
  readonly matches: readonly PlayerMatch[];
  readonly metric: TrendMetric;
  readonly onMetricChange: (metric: TrendMetric) => void;
}

export function PlayerTrend({ matches, metric, onMetricChange }: PlayerTrendProps) {
  const points = trendSeries(matches, metric);
  const geometry = trendGeometry(points, CHART_WIDTH, CHART_HEIGHT);
  const average = trendAverage(points);

  const options: readonly SegOption<TrendMetric>[] = TREND_METRICS.map((value) => ({
    value,
    label: metricLabel(value),
  }));

  return (
    <section className="flex flex-col gap-3" data-player-trend={metric}>
      <div className="flex flex-wrap items-center gap-2.5">
        <Seg
          name="player-trend"
          value={metric}
          options={options}
          onChange={onMetricChange}
          aria-label={t`趋势指标`}
        />
        <div className="flex-1" aria-hidden="true" />
        <span className="text-2xs text-neutral-600">
          <Trans>
            最近 {TREND_WINDOW} 场里有 {points.length} 场有这个指标 · 灰线为个人均值
          </Trans>
        </span>
      </div>

      {points.length === 0 ? (
        <Empty
          title={<Trans>还没有可画的趋势</Trans>}
          description={
            <Trans>这名选手最近的比赛里没有 {metricName(metric)} 的取值，所以这里没有线可画。</Trans>
          }
          actions={null}
        />
      ) : (
        <div className="border border-divider">
          <svg
            viewBox={`0 0 ${String(CHART_WIDTH)} ${String(CHART_HEIGHT)}`}
            className="block h-[170px] w-full"
            role="img"
            aria-label={t`${metricName(metric)} 趋势，共 ${points.length} 场，从 ${printValue(metric, geometry.minimum)} 到 ${printValue(metric, geometry.maximum)}，均值 ${printValue(metric, average)}`}
          >
            <g className="stroke-neutral-300" strokeWidth={1}>
              <path
                d={`M0 ${String(CHART_HEIGHT / 4)} H${String(CHART_WIDTH)} M0 ${String(CHART_HEIGHT / 2)} H${String(CHART_WIDTH)} M0 ${String((CHART_HEIGHT * 3) / 4)} H${String(CHART_WIDTH)}`}
                fill="none"
              />
            </g>
            {geometry.averageY === null ? null : (
              <path
                d={`M0 ${String(geometry.averageY)} H${String(CHART_WIDTH)}`}
                className="stroke-neutral-500"
                strokeWidth={1}
                strokeDasharray="5 4"
                fill="none"
                data-trend-average=""
              />
            )}
            <path
              d={geometry.path}
              className="stroke-accent-800"
              strokeWidth={2}
              fill="none"
              data-trend-path=""
            />
          </svg>
        </div>
      )}

      {/* The axis, as text beside the box rather than inside it: a `<text>` in
          an SVG that scales with its container would scale its own type, and
          §3.2's sizes are not negotiable per container width. */}
      <div className="flex justify-between font-mono text-2xs text-neutral-600">
        <span>
          <Trans>低 {printValue(metric, points.length === 0 ? null : geometry.minimum)}</Trans>
        </span>
        <span>
          <Trans>均值 {printValue(metric, average)}</Trans>
        </span>
        <span>
          <Trans>高 {printValue(metric, points.length === 0 ? null : geometry.maximum)}</Trans>
        </span>
      </div>
    </section>
  );
}
