/*
 * Domain layer, 2 of 3 — `domain/map/`: the density overlay.
 *
 * Reference: 「04 2D 回放与热力图」, the 热力叠加 layer and the 热力图图例 panel
 * on its right rail. The legend there is the whole specification of this
 * component's honesty contract, in three lines:
 *
 *   a gradient running accent-100 → accent-500 → accent-900
 *   「1 次」 … 「34 次」  — absolute observed counts at both ends, not 0–100%
 *   「当前统计：Kael 在 Mirage 的死亡位置，覆盖 12 场比赛。」 — what is counted
 *
 * So the scale is anchored to what was measured, the reader is told what the
 * ends mean, and nothing is coloured that was not observed. The arithmetic that
 * guarantees the last part is in `heatBinning.ts` — no smoothing, no empty
 * cells, no clamping of off-map samples — and this file only paints what comes
 * back. It takes a `HeatDistribution`, not raw points, so there is no API here
 * that could put ten thousand nodes on screen.
 *
 * Colour comes from the accent ramp's nine steps, one per rung of the ladder,
 * addressed as Tailwind classes off `--color-accent-*`. No value is mixed, so
 * there is no hex here and none in the ladder module either.
 *
 * The layer is not selectable. A bin is an aggregate over samples that belong
 * to different rounds, players and ticks; selecting one could not report a
 * single object, and the artboard's rule is that every selection can go back to
 * 回合 / tick / 选手. The individual events stay selectable on `EngagementLayer`.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { cn } from '../../design/layout';
import { DEFAULT_HEAT_STEPS, type HeatDistribution } from './heatBinning';
import { LayerEmpty } from './LayerEmpty';
import type { MapProjection } from './mapProjection';

/**
 * The ladder. Nine rungs of the accent ramp, low to high, exactly the gradient
 * 「04」 draws for the legend (accent-100 → accent-500 → accent-900).
 */
export const HEAT_STEP_FILL: readonly string[] = [
  'fill-accent-100',
  'fill-accent-200',
  'fill-accent-300',
  'fill-accent-400',
  'fill-accent-500',
  'fill-accent-600',
  'fill-accent-700',
  'fill-accent-800',
  'fill-accent-900',
];

/** The same ladder as backgrounds, for the legend's stepped bar. */
export const HEAT_STEP_BACKGROUND: readonly string[] = [
  'bg-accent-100',
  'bg-accent-200',
  'bg-accent-300',
  'bg-accent-400',
  'bg-accent-500',
  'bg-accent-600',
  'bg-accent-700',
  'bg-accent-800',
  'bg-accent-900',
];

function rungClass(step: number, ladder: readonly string[]): string {
  const index = Math.min(ladder.length, Math.max(1, Math.trunc(step))) - 1;
  return ladder[index] ?? ladder[ladder.length - 1] ?? '';
}

export interface HeatLayerProps {
  readonly projection: MapProjection;
  /** Already binned. See the module note on why this is not a point list. */
  readonly distribution: HeatDistribution;
  /** Shown / hidden is the page's state, not this component's. */
  readonly visible?: boolean | undefined;
  /**
   * What the numbers count, for the accessible summary: 「Kael 在 Mirage 的
   * 死亡位置」. The legend panel prints the same phrase.
   */
  readonly subject?: string | undefined;
  readonly className?: string | undefined;
}

export function HeatLayer({ projection, distribution, visible = true, subject, className }: HeatLayerProps) {
  if (!visible) return null;

  const { bins, maxWeight, sampleCount } = distribution;
  if (bins.length === 0) {
    return (
      <LayerEmpty
        layer="heat"
        label={subject === undefined ? t`热力叠加：没有采样点` : t`热力叠加：${subject} 没有采样点`}
      />
    );
  }

  const cellSize = projection.extent / distribution.gridSize;
  /*
   * The accessible name quotes only numbers the distribution actually holds —
   * how many samples were binned and how dense the densest cell is. Both are
   * measured, neither is a percentage.
   */
  const summary =
    subject === undefined
      ? t`热力叠加，共 ${sampleCount} 个采样点，最密处 ${maxWeight} 次`
      : t`热力叠加：${subject}，共 ${sampleCount} 个采样点，最密处 ${maxWeight} 次`;

  return (
    <g className={className} data-layer="heat" data-bins={bins.length} role="img" aria-label={summary}>
      {bins.map((bin) => (
        <rect
          key={`${bin.row}:${bin.column}`}
          x={projection.offsetX + bin.x * projection.extent}
          y={projection.offsetY + bin.y * projection.extent}
          width={cellSize}
          height={cellSize}
          className={cn(rungClass(bin.step, HEAT_STEP_FILL), 'opacity-70')}
          data-step={bin.step}
          data-weight={bin.weight}
        />
      ))}
    </g>
  );
}

export interface HeatLegendProps {
  readonly distribution: HeatDistribution;
  /** 「当前统计：Kael 在 Mirage 的死亡位置，覆盖 12 场比赛。」 */
  readonly caption?: ReactNode | undefined;
  readonly className?: string | undefined;
}

/**
 * The right-rail legend of 「04」.
 *
 * Drawn as discrete rungs rather than a CSS gradient so that what the reader
 * matches a cell against is the same finite ladder the cells were assigned
 * from. A continuous bar would imply a continuous scale that the binning does
 * not produce.
 *
 * When nothing was binned the bar is not drawn at all — a scale with no
 * measurements has no ends to label, and printing 「0 次 … 0 次」 would be the
 * fabricated denominator the states artboard rules out.
 */
export function HeatLegend({ distribution, caption, className }: HeatLegendProps) {
  const { bins, minWeight, maxWeight, steps } = distribution;
  const rungs = Math.min(steps, HEAT_STEP_BACKGROUND.length) || DEFAULT_HEAT_STEPS;

  if (bins.length === 0) {
    return (
      <div className={cn('flex flex-col gap-2 text-xs leading-normal text-neutral-700', className)}>
        <p>
          <Trans>当前条件下没有采样点，因此没有密度可比。</Trans>
        </p>
        {caption}
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid="heat-legend">
      <div
        className="flex h-[14px] border border-divider"
        role="img"
        aria-label={t`密度色阶，从 ${minWeight} 次到 ${maxWeight} 次`}
      >
        {Array.from({ length: rungs }, (_, index) => (
          <span key={index} className={cn('flex-1', rungClass(index + 1, HEAT_STEP_BACKGROUND))} />
        ))}
      </div>
      <div className="flex justify-between text-2xs text-neutral-600">
        <span>
          <Trans>{minWeight} 次</Trans>
        </span>
        <span>
          <Trans>密度</Trans>
        </span>
        <span>
          <Trans>{maxWeight} 次</Trans>
        </span>
      </div>
      {caption === undefined ? null : <p className="text-xs leading-normal text-neutral-700">{caption}</p>}
    </div>
  );
}
