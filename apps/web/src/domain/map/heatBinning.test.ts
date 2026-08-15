import { describe, expect, it } from 'vitest';

import {
  binNormalizedSamples,
  binWorldSamples,
  DEFAULT_HEAT_GRID_SIZE,
  DEFAULT_HEAT_STEPS,
  heatStep,
} from './heatBinning';
import type { MapCalibration } from './mapCalibration';

/** Span 1024, origin at the top-left of the world square: normalised = x/1024. */
const UNIT_MAP: MapCalibration = {
  mapName: 'de_unit',
  originX: 0,
  originY: 1024,
  unitsPerPixel: 1,
  overviewSize: 1024,
  confidence: 'verified',
  provenance: 'test fixture',
};

describe('heatStep', () => {
  it('puts the least dense observed cell on rung 1 and the densest on the top rung', () => {
    expect(heatStep(1, 1, 34, 9)).toBe(1);
    expect(heatStep(34, 1, 34, 9)).toBe(9);
  });

  it('never returns 0 — an observed cell is always visible', () => {
    for (let weight = 1; weight <= 34; weight += 1) {
      expect(heatStep(weight, 1, 34, 9)).toBeGreaterThanOrEqual(1);
      expect(heatStep(weight, 1, 34, 9)).toBeLessThanOrEqual(9);
    }
  });

  it('is monotone in weight', () => {
    let previous = 0;
    for (let weight = 1; weight <= 34; weight += 1) {
      const step = heatStep(weight, 1, 34, 9);
      expect(step).toBeGreaterThanOrEqual(previous);
      previous = step;
    }
  });

  it('puts every cell on the top rung when they all carry the same weight', () => {
    expect(heatStep(7, 7, 7, 9)).toBe(9);
  });
});

describe('binNormalizedSamples', () => {
  it('reports an empty distribution rather than a grid of zeroes', () => {
    const distribution = binNormalizedSamples([], { gridSize: 4 });
    expect(distribution.bins).toEqual([]);
    expect(distribution.sampleCount).toBe(0);
    expect(distribution.minWeight).toBe(0);
    expect(distribution.maxWeight).toBe(0);
  });

  it('emits only occupied cells — 1 point on a 4×4 grid is 1 bin, not 16', () => {
    const distribution = binNormalizedSamples([{ x: 0.1, y: 0.1 }], { gridSize: 4 });
    expect(distribution.bins).toHaveLength(1);
    expect(distribution.bins[0]).toMatchObject({ column: 0, row: 0, count: 1, weight: 1 });
  });

  it('sums weight and counts samples per cell', () => {
    const distribution = binNormalizedSamples(
      [
        { x: 0.1, y: 0.1, weight: 2 },
        { x: 0.2, y: 0.2, weight: 3 },
        { x: 0.9, y: 0.1 },
      ],
      { gridSize: 4 },
    );
    expect(distribution.bins).toHaveLength(2);
    expect(distribution.bins[0]).toMatchObject({ column: 0, row: 0, count: 2, weight: 5 });
    expect(distribution.bins[1]).toMatchObject({ column: 3, row: 0, count: 1, weight: 1 });
    expect(distribution.sampleCount).toBe(3);
  });

  it('anchors the ladder to the observed extremes', () => {
    const distribution = binNormalizedSamples(
      [
        { x: 0.1, y: 0.1, weight: 1 },
        { x: 0.9, y: 0.1, weight: 34 },
      ],
      { gridSize: 4, steps: 9 },
    );
    expect(distribution.minWeight).toBe(1);
    expect(distribution.maxWeight).toBe(34);
    expect(distribution.bins.map((bin) => bin.step)).toEqual([1, 9]);
    expect(distribution.bins.map((bin) => bin.intensity)).toEqual([0, 1]);
  });

  /*
   * The honesty rule of the module, as a test: an off-artwork sample is dropped
   * and counted, never folded onto the nearest edge cell — clamping would
   * invent a border hot spot out of samples that were never on the map.
   */
  it('drops off-artwork samples instead of clamping them onto the border', () => {
    const distribution = binNormalizedSamples(
      [
        { x: -0.5, y: 0.5 },
        { x: 1.5, y: 0.5 },
        { x: 0.5, y: -2 },
        { x: 0.5, y: 0.5 },
      ],
      { gridSize: 4 },
    );
    expect(distribution.bins).toHaveLength(1);
    expect(distribution.bins[0]).toMatchObject({ column: 2, row: 2 });
    expect(distribution.skippedCount).toBe(3);
    expect(distribution.sampleCount).toBe(1);
  });

  it('drops non-finite coordinates and weights', () => {
    const distribution = binNormalizedSamples(
      [
        { x: Number.NaN, y: 0.5 },
        { x: 0.5, y: Number.POSITIVE_INFINITY },
        { x: 0.5, y: 0.5, weight: Number.NaN },
      ],
      { gridSize: 4 },
    );
    expect(distribution.bins).toEqual([]);
    expect(distribution.skippedCount).toBe(3);
  });

  it('gives the far edge to the last cell, exhaustively over a small grid', () => {
    const gridSize = 4;
    for (let index = 0; index <= gridSize; index += 1) {
      const value = index / gridSize;
      const distribution = binNormalizedSamples([{ x: value, y: value }], { gridSize });
      const expected = index === gridSize ? gridSize - 1 : index;
      expect(distribution.bins[0]?.column).toBe(expected);
      expect(distribution.bins[0]?.row).toBe(expected);
    }
  });

  it('places each bin at its own cell of the unit square', () => {
    const distribution = binNormalizedSamples([{ x: 0.6, y: 0.3 }], { gridSize: 4 });
    expect(distribution.bins[0]).toMatchObject({ x: 0.5, y: 0.25, size: 0.25 });
  });

  it('orders bins row-major, so a render is deterministic', () => {
    const distribution = binNormalizedSamples(
      [
        { x: 0.9, y: 0.9 },
        { x: 0.1, y: 0.9 },
        { x: 0.9, y: 0.1 },
        { x: 0.1, y: 0.1 },
      ],
      { gridSize: 4 },
    );
    expect(distribution.bins.map((bin) => [bin.row, bin.column])).toEqual([
      [0, 0],
      [0, 3],
      [3, 0],
      [3, 3],
    ]);
  });

  it('bounds the node count at gridSize² however many samples arrive', () => {
    const samples = Array.from({ length: 10_000 }, (_, index) => ({
      x: (index % 997) / 997,
      y: ((index * 7) % 991) / 991,
    }));
    const distribution = binNormalizedSamples(samples, { gridSize: 16 });
    expect(distribution.sampleCount).toBe(10_000);
    expect(distribution.bins.length).toBeLessThanOrEqual(16 * 16);
  });

  it('falls back to the documented defaults for absent or nonsense options', () => {
    const distribution = binNormalizedSamples([{ x: 0.5, y: 0.5 }]);
    expect(distribution.gridSize).toBe(DEFAULT_HEAT_GRID_SIZE);
    expect(distribution.steps).toBe(DEFAULT_HEAT_STEPS);
    expect(binNormalizedSamples([{ x: 0.5, y: 0.5 }], { gridSize: 0, steps: -3 }).gridSize).toBe(1);
    expect(binNormalizedSamples([{ x: 0.5, y: 0.5 }], { gridSize: 0, steps: -3 }).steps).toBe(1);
  });
});

describe('binWorldSamples', () => {
  it('projects through the calibration before binning', () => {
    const distribution = binWorldSamples([{ x: 128, y: 896 }], UNIT_MAP, { gridSize: 4 });
    expect(distribution.bins).toHaveLength(1);
    expect(distribution.bins[0]).toMatchObject({ column: 0, row: 0 });
  });

  it('keeps only the requested floor and counts what it dropped', () => {
    const distribution = binWorldSamples(
      [
        { x: 128, y: 896, floor: 0 },
        { x: 128, y: 896, floor: 1 },
        { x: 128, y: 896 },
      ],
      UNIT_MAP,
      { gridSize: 4, floor: 0 },
    );
    // The floorless sample is kept: a record with no floor is not evidence of
    // being on another one.
    expect(distribution.sampleCount).toBe(2);
    expect(distribution.skippedCount).toBe(1);
    expect(distribution.bins[0]?.count).toBe(2);
  });

  it('drops world samples that fall outside the overview square', () => {
    const distribution = binWorldSamples([{ x: -4000, y: 4000 }], UNIT_MAP, { gridSize: 4 });
    expect(distribution.bins).toEqual([]);
    expect(distribution.skippedCount).toBe(1);
  });
});
