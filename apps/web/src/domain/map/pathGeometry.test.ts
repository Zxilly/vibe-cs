import { describe, expect, it } from 'vitest';

import {
  arrowHeadCommand,
  COORDINATE_PRECISION,
  crossCommand,
  finitePoints,
  formatCoordinate,
  HAMMER_UNITS_PER_METRE,
  polylineCommand,
  polylineLength,
  worldBearingDegrees,
  worldDistanceMetres,
} from './pathGeometry';

describe('formatCoordinate', () => {
  it('rounds to the documented precision and drops trailing zeros', () => {
    expect(COORDINATE_PRECISION).toBe(3);
    expect(formatCoordinate(1.23456)).toBe('1.235');
    expect(formatCoordinate(2)).toBe('2');
    expect(formatCoordinate(2.5000001)).toBe('2.5');
  });

  it('never emits -0 or a non-finite token into an attribute', () => {
    expect(formatCoordinate(-0)).toBe('0');
    expect(formatCoordinate(-0.0001)).toBe('0');
    expect(formatCoordinate(Number.NaN)).toBe('0');
    expect(formatCoordinate(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('finitePoints', () => {
  it('keeps only the points an SVG can draw', () => {
    expect(
      finitePoints([
        { x: 1, y: 2 },
        { x: Number.NaN, y: 2 },
        { x: 1, y: Number.POSITIVE_INFINITY },
      ]),
    ).toEqual([{ x: 1, y: 2 }]);
  });
});

describe('polylineCommand', () => {
  it('builds an M/L chain', () => {
    expect(
      polylineCommand([
        { x: 0, y: 0 },
        { x: 10, y: 20 },
        { x: 30.4567, y: 5 },
      ]),
    ).toBe('M 0 0 L 10 20 L 30.457 5');
  });

  it('returns an empty command for anything that is not a line', () => {
    expect(polylineCommand([])).toBe('');
    expect(polylineCommand([{ x: 1, y: 1 }])).toBe('');
    expect(
      polylineCommand([
        { x: Number.NaN, y: 1 },
        { x: 1, y: 1 },
      ]),
    ).toBe('');
  });
});

describe('arrowHeadCommand', () => {
  it('points along the segment and is as wide as it is long', () => {
    expect(arrowHeadCommand({ x: 0, y: 0 }, { x: 10, y: 0 }, 10)).toBe('M 10 0 L 0 5 L 0 -5 Z');
    expect(arrowHeadCommand({ x: 0, y: 0 }, { x: 0, y: 10 }, 10)).toBe('M 0 10 L -5 0 L 5 0 Z');
  });

  it('draws nothing when there is no direction to draw', () => {
    expect(arrowHeadCommand({ x: 3, y: 3 }, { x: 3, y: 3 }, 10)).toBe('');
    expect(arrowHeadCommand({ x: 0, y: 0 }, { x: 10, y: 0 }, 0)).toBe('');
    expect(arrowHeadCommand({ x: 0, y: 0 }, { x: Number.NaN, y: 0 }, 10)).toBe('');
  });
});

describe('crossCommand', () => {
  it('draws two strokes through the centre', () => {
    expect(crossCommand({ x: 10, y: 10 }, 4)).toBe('M 8 8 L 12 12 M 12 8 L 8 12');
  });

  it('draws nothing for a degenerate mark', () => {
    expect(crossCommand({ x: 10, y: 10 }, 0)).toBe('');
    expect(crossCommand({ x: Number.NaN, y: 10 }, 4)).toBe('');
  });
});

describe('worldBearingDegrees', () => {
  it('reads 0° east and grows counter-clockwise, in world space', () => {
    const origin = { x: 0, y: 0 };
    expect(worldBearingDegrees(origin, { x: 1, y: 0 })).toBeCloseTo(0, 10);
    expect(worldBearingDegrees(origin, { x: 0, y: 1 })).toBeCloseTo(90, 10);
    expect(worldBearingDegrees(origin, { x: -1, y: 0 })).toBeCloseTo(180, 10);
    expect(worldBearingDegrees(origin, { x: 0, y: -1 })).toBeCloseTo(270, 10);
  });

  it('normalises into [0, 360)', () => {
    for (let degrees = 0; degrees < 360; degrees += 5) {
      const radians = (degrees * Math.PI) / 180;
      const bearing = worldBearingDegrees({ x: 0, y: 0 }, { x: Math.cos(radians), y: Math.sin(radians) });
      expect(bearing).not.toBeNull();
      expect(bearing as number).toBeGreaterThanOrEqual(0);
      expect(bearing as number).toBeLessThan(360);
      expect(bearing as number).toBeCloseTo(degrees, 8);
    }
  });

  it('has no answer for two coincident points, and says so', () => {
    expect(worldBearingDegrees({ x: 5, y: 5 }, { x: 5, y: 5 })).toBeNull();
    expect(worldBearingDegrees({ x: Number.NaN, y: 5 }, { x: 5, y: 5 })).toBeNull();
  });
});

describe('worldDistanceMetres', () => {
  it('converts Hammer units to metres', () => {
    expect(HAMMER_UNITS_PER_METRE).toBeCloseTo(39.37, 5);
    expect(worldDistanceMetres({ x: 0, y: 0 }, { x: HAMMER_UNITS_PER_METRE, y: 0 })).toBeCloseTo(1, 10);
    // 「距离 18.7m」 on the artboard.
    expect(worldDistanceMetres({ x: 0, y: 0 }, { x: 18.7 * HAMMER_UNITS_PER_METRE, y: 0 })).toBeCloseTo(18.7, 8);
  });

  it('returns null rather than NaN for unusable input', () => {
    expect(worldDistanceMetres({ x: Number.NaN, y: 0 }, { x: 0, y: 0 })).toBeNull();
  });
});

describe('polylineLength', () => {
  it('sums the segments and ignores undrawable points', () => {
    expect(
      polylineLength([
        { x: 0, y: 0 },
        { x: 3, y: 4 },
        { x: 3, y: 14 },
      ]),
    ).toBe(15);
    expect(polylineLength([{ x: 0, y: 0 }])).toBe(0);
    expect(polylineLength([])).toBe(0);
  });
});
