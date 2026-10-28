/* Plot available values from recent matches in chronological order.
 * Missing values are omitted; the caption states the measured sample size. */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { Empty, Skeleton } from '../../../design/data';
import { Alert } from '../../../design/feedback';
import { Seg, type SegOption } from '../../../design/primitives';
import type { PlayerMatch } from '../../../shared/desktop/dto';
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

/** View-box units. The artboard's box is 560 × 170; the SVG stretches to its
 *  container (`preserveAspectRatio="none"`, as `Waveform` and `RoundsView`
 *  draw their own horizontal lines), so these are a ratio anchor rather than a
 *  pixel commitment — the same disposition `MAP_CANVAS_EXTENT` records. The
 *  strokes are `non-scaling` so a wide panel does not fatten the line. */
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
  readonly loading?: boolean | undefined;
  readonly error?: { readonly message: string; readonly onRetry: () => void } | undefined;
}

export function PlayerTrend({ matches, metric, onMetricChange, loading = false, error }: PlayerTrendProps) {
  const points = trendSeries(matches, metric);
  const geometry = trendGeometry(points, CHART_WIDTH, CHART_HEIGHT);
  const average = trendAverage(points);
  const first = points[0];
  const last = points[points.length - 1];

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
        {loading || error !== undefined ? null : <span className="text-xs text-neutral-600">
          <Trans>
            最近 {TREND_WINDOW} 场 · {points.length} 场有数据 · 虚线为均值
          </Trans>
        </span>}
      </div>

      {loading ? (
        <div role="status" aria-busy="true" className="flex flex-col gap-2">
          <Skeleton className="h-[170px]" />
          <span className="text-xs text-neutral-600"><Trans>正在读取比赛趋势</Trans></span>
        </div>
      ) : error !== undefined ? (
        <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: error.onRetry }}>
          <Trans>比赛趋势没能读出来：{error.message}</Trans>
        </Alert>
      ) : points.length === 0 ? (
        <Empty
          title={<Trans>暂无趋势数据</Trans>}
          description={
            <Trans>最近比赛中没有可用的 {metricName(metric)} 数据。</Trans>
          }
          actions={null}
        />
      ) : (
        <div className="border border-divider">
          <svg
            viewBox={`0 0 ${String(CHART_WIDTH)} ${String(CHART_HEIGHT)}`}
            preserveAspectRatio="none"
            className="block h-[170px] w-full"
            role="img"
            aria-label={t`${metricName(metric)} 趋势，共 ${points.length} 场，从 ${printValue(metric, geometry.minimum)} 到 ${printValue(metric, geometry.maximum)}，均值 ${printValue(metric, average)}`}
          >
            {/* Hairlines two steps lighter than the mean rule, so the one
                dashed line the caption names cannot be mistaken for a
                gridline when the mean happens to land on one. */}
            <g className="stroke-neutral-200" strokeWidth={1}>
              <path
                d={`M0 ${String(CHART_HEIGHT / 4)} H${String(CHART_WIDTH)} M0 ${String(CHART_HEIGHT / 2)} H${String(CHART_WIDTH)} M0 ${String((CHART_HEIGHT * 3) / 4)} H${String(CHART_WIDTH)}`}
                fill="none"
                vectorEffect="non-scaling-stroke"
              />
            </g>
            {geometry.averageY === null ? null : (
              <path
                d={`M0 ${String(geometry.averageY)} H${String(CHART_WIDTH)}`}
                className="stroke-neutral-500"
                strokeWidth={1}
                strokeDasharray="5 4"
                fill="none"
                vectorEffect="non-scaling-stroke"
                data-trend-average=""
              />
            )}
            <path
              d={geometry.path}
              className="stroke-accent-800"
              strokeWidth={2}
              fill="none"
              vectorEffect="non-scaling-stroke"
              data-trend-path=""
            />
          </svg>
        </div>
      )}

      {/* The time axis: which match the line starts and ends on. The 最近比赛
          list beside the chart names every match; this only anchors the two
          ends so the slope can be read as a direction in time. */}
      {loading || error !== undefined || first === undefined || last === undefined || first === last ? null : (
        <div className="flex justify-between gap-3 text-xs text-neutral-600" data-trend-axis="">
          <span className="min-w-0 truncate">
            <Trans>最早 {first.label}</Trans>
          </span>
          <span className="min-w-0 truncate text-right">
            <Trans>最近 {last.label}</Trans>
          </span>
        </div>
      )}

      {/* The axis, as text beside the box rather than inside it: a `<text>` in
          an SVG that scales with its container would scale its own type, and
          §3.2's sizes are not negotiable per container width. */}
      {loading || error !== undefined || points.length === 0 ? null : <div className="flex justify-between font-mono text-xs text-neutral-600">
        <span>
          <Trans>低 {printValue(metric, points.length === 0 ? null : geometry.minimum)}</Trans>
        </span>
        <span>
          <Trans>均值 {printValue(metric, average)}</Trans>
        </span>
        <span>
          <Trans>高 {printValue(metric, points.length === 0 ? null : geometry.maximum)}</Trans>
        </span>
      </div>}
    </section>
  );
}
