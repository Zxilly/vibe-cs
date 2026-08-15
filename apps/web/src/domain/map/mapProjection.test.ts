import { describe, expect, it } from 'vitest';

import { findMapCalibration, type MapCalibration } from './mapCalibration';
import {
  coversNormalized,
  createMapProjection,
  fitOverview,
  normalizedToWorld,
  worldSpan,
  worldToNormalized,
} from './mapProjection';

/** de_mirage, the one entry this repository can check. */
const MIRAGE = findMapCalibration('de_mirage') as MapCalibration;

/** A synthetic map whose numbers are easy to do in the head: span = 1024. */
const UNIT_MAP: MapCalibration = {
  mapName: 'de_unit',
  originX: 0,
  originY: 1024,
  unitsPerPixel: 1,
  overviewSize: 1024,
  confidence: 'verified',
  provenance: 'test fixture',
};

describe('worldSpan', () => {
  it('is the world size of the overview square', () => {
    expect(worldSpan(MIRAGE)).toBe(5 * 1024);
    expect(worldSpan(UNIT_MAP)).toBe(1024);
  });
});

describe('worldToNormalized', () => {
  it('puts the overview origin at (0,0) and the far corner at (1,1)', () => {
    expect(worldToNormalized(MIRAGE, { x: MIRAGE.originX, y: MIRAGE.originY })).toEqual({ x: 0, y: 0 });
    const span = worldSpan(MIRAGE);
    const far = worldToNormalized(MIRAGE, { x: MIRAGE.originX + span, y: MIRAGE.originY - span });
    expect(far.x).toBeCloseTo(1, 12);
    expect(far.y).toBeCloseTo(1, 12);
  });

  it('flips y, because world y grows north and image y grows down', () => {
    const north = worldToNormalized(UNIT_MAP, { x: 0, y: 1024 });
    const south = worldToNormalized(UNIT_MAP, { x: 0, y: 0 });
    expect(north.y).toBe(0);
    expect(south.y).toBe(1);
  });

  it('agrees with the percentages shared/radar.ts produces for the same transform', () => {
    // apps/web/src/shared/radar.test.ts: pos_x -2048, pos_y 3072, scale 4,
    // (0, 1024) → 50% / 50%.
    const dust: MapCalibration = { ...UNIT_MAP, originX: -2048, originY: 3072, unitsPerPixel: 4 };
    const middle = worldToNormalized(dust, { x: 0, y: 1024 });
    expect(middle.x * 100).toBeCloseTo(50, 10);
    expect(middle.y * 100).toBeCloseTo(50, 10);
  });

  it('reports off-artwork points instead of clamping them', () => {
    const outside = worldToNormalized(UNIT_MAP, { x: -512, y: 2048 });
    expect(outside.x).toBeLessThan(0);
    expect(outside.y).toBeLessThan(0);
    expect(coversNormalized(outside)).toBe(false);
  });

  it('round-trips through normalizedToWorld across a full sweep of the square', () => {
    for (let step = 0; step <= 32; step += 1) {
      for (let other = 0; other <= 32; other += 1) {
        const point = { x: step / 32, y: other / 32 };
        const back = worldToNormalized(MIRAGE, normalizedToWorld(MIRAGE, point));
        expect(back.x).toBeCloseTo(point.x, 10);
        expect(back.y).toBeCloseTo(point.y, 10);
      }
    }
  });
});

describe('coversNormalized', () => {
  it('includes the edges and excludes anything past them', () => {
    expect(coversNormalized({ x: 0, y: 0 })).toBe(true);
    expect(coversNormalized({ x: 1, y: 1 })).toBe(true);
    expect(coversNormalized({ x: 0.5, y: 1.0001 })).toBe(false);
    expect(coversNormalized({ x: -0.0001, y: 0.5 })).toBe(false);
  });
});

describe('fitOverview', () => {
  it('inscribes the square and centres it rather than stretching', () => {
    expect(fitOverview({ width: 1000, height: 600 })).toEqual({ extent: 600, offsetX: 200, offsetY: 0 });
    expect(fitOverview({ width: 600, height: 1000 })).toEqual({ extent: 600, offsetX: 0, offsetY: 200 });
    expect(fitOverview({ width: 720, height: 720 })).toEqual({ extent: 720, offsetX: 0, offsetY: 0 });
  });

  it('degrades to a zero extent rather than throwing on an unmeasured box', () => {
    expect(fitOverview({ width: 0, height: 400 })).toEqual({ extent: 0, offsetX: 0, offsetY: 200 });
    expect(fitOverview({ width: Number.NaN, height: 400 })).toEqual({ extent: 0, offsetX: 0, offsetY: 200 });
    expect(fitOverview({ width: -100, height: -100 })).toEqual({ extent: 0, offsetX: 0, offsetY: 0 });
  });
});

describe('createMapProjection', () => {
  const projection = createMapProjection(MIRAGE, { width: 720, height: 720 });

  it('maps the overview corners onto the canvas corners', () => {
    expect(projection.toCanvas({ x: MIRAGE.originX, y: MIRAGE.originY })).toEqual({ x: 0, y: 0 });
    const span = worldSpan(MIRAGE);
    const far = projection.toCanvas({ x: MIRAGE.originX + span, y: MIRAGE.originY - span });
    expect(far.x).toBeCloseTo(720, 8);
    expect(far.y).toBeCloseTo(720, 8);
  });

  it('inverts exactly across a sweep of the canvas', () => {
    for (let column = 0; column <= 24; column += 1) {
      for (let row = 0; row <= 24; row += 1) {
        const canvas = { x: (column / 24) * 720, y: (row / 24) * 720 };
        const back = projection.toCanvas(projection.toWorld(canvas));
        expect(back.x).toBeCloseTo(canvas.x, 8);
        expect(back.y).toBeCloseTo(canvas.y, 8);
      }
    }
  });

  it('converts lengths isotropically in both directions', () => {
    const span = worldSpan(MIRAGE);
    expect(projection.toCanvasLength(span)).toBeCloseTo(720, 8);
    expect(projection.toCanvasLength(span / 2)).toBeCloseTo(360, 8);
    expect(projection.toWorldLength(720)).toBeCloseTo(span, 6);
    expect(projection.toWorldLength(projection.toCanvasLength(1234))).toBeCloseTo(1234, 6);
  });

  it('keeps the aspect ratio inside a non-square viewport', () => {
    const wide = createMapProjection(UNIT_MAP, { width: 1000, height: 600 });
    expect(wide.extent).toBe(600);
    expect(wide.offsetX).toBe(200);
    // The same world step is the same canvas step on both axes.
    const a = wide.toCanvas({ x: 0, y: 1024 });
    const b = wide.toCanvas({ x: 512, y: 512 });
    expect(b.x - a.x).toBeCloseTo(b.y - a.y, 10);
  });

  it('answers `covers` for points on and off the artwork', () => {
    expect(projection.covers({ x: MIRAGE.originX, y: MIRAGE.originY })).toBe(true);
    expect(projection.covers({ x: MIRAGE.originX - 1, y: MIRAGE.originY })).toBe(false);
  });

  it('throws on an unusable calibration rather than emitting NaN geometry', () => {
    expect(() => createMapProjection({ ...UNIT_MAP, unitsPerPixel: 0 }, { width: 720, height: 720 })).toThrow(
      /unusable map calibration for de_unit/u,
    );
  });

  it('stays total on an unmeasured viewport', () => {
    const collapsed = createMapProjection(UNIT_MAP, { width: 0, height: 0 });
    expect(collapsed.toCanvas({ x: 512, y: 512 })).toEqual({ x: 0, y: 0 });
    expect(collapsed.toWorld({ x: 10, y: 10 })).toEqual({ x: UNIT_MAP.originX, y: UNIT_MAP.originY });
    expect(collapsed.toWorldLength(10)).toBe(0);
  });
});
