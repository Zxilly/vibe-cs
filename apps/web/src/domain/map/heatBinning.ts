/*
 * Domain layer, 2 of 3 — `domain/map/`: heat binning and the colour ladder.
 *
 * ── The rule this module exists to enforce ──────────────────────────────────
 * 「04 2D 回放与热力图」 states the density scale in absolute counts —
 * 「1 次 · 密度 · 34 次」 — and the states artboard states the general form of
 * the same rule twice: 「不显示虚构百分比」, 「有真实分母时才用进度条」.
 * Applied to a heat map that means four prohibitions, all of them enforced
 * here rather than left to the renderer:
 *
 *   1. No smoothing, no kernel, no interpolation. A bin's value is the sum of
 *      the samples that fell in it and nothing else. A Gaussian blur would put
 *      colour on squares where no player ever stood, which is exactly the
 *      「编造没有数据的区域」 the product forbids.
 *   2. Empty bins are not emitted. `bins` contains only occupied cells, so a
 *      renderer cannot paint a floor of "zero" that reads as measured.
 *   3. The ladder is anchored to the real extremes, not to 0..1. `minWeight`
 *      and `maxWeight` are the observed extremes and they are what the legend
 *      prints. The least dense occupied cell gets step 1, not step 0 — it was
 *      observed, so it is visible.
 *   4. Samples off the artwork are dropped and counted, never clamped. Clamping
 *      would stack out-of-bounds samples onto the border cells and invent an
 *      edge hot spot.
 *
 * ── Why binning is also what makes SVG viable ───────────────────────────────
 * A cross-match heat query can return tens of thousands of points. This
 * function collapses them into at most `gridSize²` cells before anything
 * reaches the DOM, and in practice into far fewer because a map's playable area
 * is a fraction of its bounding square. That bound is the reason `MapCanvas`
 * can stay pure SVG — see the note at the top of `MapCanvas.tsx`.
 *
 * Zero React, zero DOM, no colour: `step` is an index into a ladder the
 * component owns, so no hex or token name appears in this file and the whole
 * module is exhaustible in the `unit` project.
 */

import type { MapCalibration } from './mapCalibration';
import { coversNormalized, worldToNormalized } from './mapProjection';
import type { NormalizedPoint, WorldPoint } from './types';

/**
 * One observation. Field names follow `HeatPointRecord` in the desktop DTO
 * (`x`, `y`, `weight`, `floor`) so a page can forward rows without mapping;
 * everything the DTO carries for provenance — id, round, tick, evidence — stays
 * on the page, because binning must not depend on it.
 */
export interface HeatSample extends WorldPoint {
  /** Defaults to 1. A row that already aggregates carries its count here. */
  readonly weight?: number | undefined;
  /** 楼层, per the artboard's 地面 / 高层 segment. */
  readonly floor?: number | undefined;
}

/** An occupied cell of the grid. */
export interface HeatBin {
  /** Column index, 0 at the artwork's left edge. */
  readonly column: number;
  /** Row index, 0 at the artwork's top edge. */
  readonly row: number;
  /** How many samples landed here. */
  readonly count: number;
  /** Summed weight of those samples. This is what the ladder ranks. */
  readonly weight: number;
  /** Position of the cell in the overview's unit square, [0,1]. */
  readonly x: number;
  readonly y: number;
  /** Cell side in normalised units, i.e. `1 / gridSize`. */
  readonly size: number;
  /** Where the cell sits between the observed extremes, 0..1. */
  readonly intensity: number;
  /** 1-based rung of the colour ladder. Never 0: an observed cell is visible. */
  readonly step: number;
}

export interface HeatBinningOptions {
  /** Cells per side. Default 48. */
  readonly gridSize?: number | undefined;
  /** Rungs of the colour ladder. Default 9, matching the accent ramp. */
  readonly steps?: number | undefined;
  /** Keep only samples on this floor. Omit to keep every floor. */
  readonly floor?: number | undefined;
}

export interface HeatDistribution {
  /** Occupied cells only, ordered row-major so renders are deterministic. */
  readonly bins: readonly HeatBin[];
  readonly gridSize: number;
  readonly steps: number;
  /** Samples that were binned. */
  readonly sampleCount: number;
  /** Samples dropped for being off the artwork, on another floor, or non-finite. */
  readonly skippedCount: number;
  /** Observed extremes over occupied cells. Both 0 when nothing was binned. */
  readonly minWeight: number;
  readonly maxWeight: number;
}

/**
 * 48 cells per side over a 1024px overview is ~21px of artwork per cell, close
 * to a player's own footprint at that zoom, which is the coarsest grid that
 * still reads as "positions" rather than "regions". It is a default, not a
 * constant: a single-round path density wants a finer grid than a 12-match
 * death map, and the caller knows which it has.
 */
export const DEFAULT_HEAT_GRID_SIZE = 48;

/**
 * Nine rungs, because the legend gradient on 「04」 runs
 * accent-100 → accent-500 → accent-900 and the accent ramp has exactly nine
 * steps. Keeping the ladder and the ramp the same length means no rung has to
 * be invented by mixing.
 */
export const DEFAULT_HEAT_STEPS = 9;

const EMPTY_DISTRIBUTION_BINS: readonly HeatBin[] = [];

interface Accumulator {
  count: number;
  weight: number;
}

/** Grid index of a normalised coordinate. The far edge belongs to the last cell. */
function cellIndex(value: number, gridSize: number): number {
  const index = Math.floor(value * gridSize);
  return index >= gridSize ? gridSize - 1 : index;
}

function sanitiseGridSize(gridSize: number | undefined): number {
  if (gridSize === undefined || !Number.isFinite(gridSize)) return DEFAULT_HEAT_GRID_SIZE;
  return Math.max(1, Math.trunc(gridSize));
}

function sanitiseSteps(steps: number | undefined): number {
  if (steps === undefined || !Number.isFinite(steps)) return DEFAULT_HEAT_STEPS;
  return Math.max(1, Math.trunc(steps));
}

/**
 * Rank a weight on the ladder.
 *
 * `min` maps to 1 and `max` to `steps`, linearly. When every occupied cell
 * carries the same weight the range has no interior and they all sit at the
 * top rung — they are all simultaneously the densest cell, and the legend will
 * print the same number at both ends, which is the honest picture of that data.
 */
export function heatStep(weight: number, minWeight: number, maxWeight: number, steps: number): number {
  if (steps <= 1) return 1;
  if (!(maxWeight > minWeight)) return steps;
  const fraction = (weight - minWeight) / (maxWeight - minWeight);
  const rung = 1 + Math.floor(fraction * (steps - 1) + Number.EPSILON);
  return Math.min(steps, Math.max(1, rung));
}

/**
 * Bin points that are already in the overview's unit square.
 *
 * Separate from the world-space entry point so the grid logic can be tested
 * without a calibration in play, and so a caller that has normalised
 * coordinates from somewhere else does not have to invent world units.
 */
export function binNormalizedSamples(
  samples: ReadonlyArray<NormalizedPoint & { readonly weight?: number | undefined }>,
  options: HeatBinningOptions = {},
): HeatDistribution {
  const gridSize = sanitiseGridSize(options.gridSize);
  const steps = sanitiseSteps(options.steps);
  const cells = new Map<number, Accumulator>();
  let sampleCount = 0;
  let skippedCount = 0;

  for (const sample of samples) {
    const weight = sample.weight ?? 1;
    if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y) || !Number.isFinite(weight)) {
      skippedCount += 1;
      continue;
    }
    if (!coversNormalized(sample)) {
      skippedCount += 1;
      continue;
    }
    const column = cellIndex(sample.x, gridSize);
    const row = cellIndex(sample.y, gridSize);
    const key = row * gridSize + column;
    const cell = cells.get(key);
    if (cell) {
      cell.count += 1;
      cell.weight += weight;
    } else {
      cells.set(key, { count: 1, weight });
    }
    sampleCount += 1;
  }

  if (cells.size === 0) {
    return {
      bins: EMPTY_DISTRIBUTION_BINS,
      gridSize,
      steps,
      sampleCount,
      skippedCount,
      minWeight: 0,
      maxWeight: 0,
    };
  }

  let minWeight = Number.POSITIVE_INFINITY;
  let maxWeight = Number.NEGATIVE_INFINITY;
  for (const cell of cells.values()) {
    if (cell.weight < minWeight) minWeight = cell.weight;
    if (cell.weight > maxWeight) maxWeight = cell.weight;
  }

  const size = 1 / gridSize;
  const range = maxWeight - minWeight;
  const bins: HeatBin[] = [];
  for (const [key, cell] of cells) {
    const row = Math.floor(key / gridSize);
    const column = key - row * gridSize;
    bins.push({
      column,
      row,
      count: cell.count,
      weight: cell.weight,
      x: column * size,
      y: row * size,
      size,
      intensity: range > 0 ? (cell.weight - minWeight) / range : 1,
      step: heatStep(cell.weight, minWeight, maxWeight, steps),
    });
  }
  bins.sort((a, b) => (a.row === b.row ? a.column - b.column : a.row - b.row));

  return { bins, gridSize, steps, sampleCount, skippedCount, minWeight, maxWeight };
}

/** Bin world-space observations. The calibration decides where the artwork is. */
export function binWorldSamples(
  samples: readonly HeatSample[],
  calibration: MapCalibration,
  options: HeatBinningOptions = {},
): HeatDistribution {
  const wantedFloor = options.floor;
  const projected: Array<NormalizedPoint & { weight: number }> = [];
  let filteredOut = 0;

  for (const sample of samples) {
    if (wantedFloor !== undefined && sample.floor !== undefined && sample.floor !== wantedFloor) {
      filteredOut += 1;
      continue;
    }
    const normalized = worldToNormalized(calibration, sample);
    projected.push({ x: normalized.x, y: normalized.y, weight: sample.weight ?? 1 });
  }

  const distribution = binNormalizedSamples(projected, options);
  return filteredOut === 0
    ? distribution
    : { ...distribution, skippedCount: distribution.skippedCount + filteredOut };
}
