/*
 * Domain layer, 2 of 3 — `domain/map/`: the coordinate system.
 *
 * This module is the floor the whole map group stands on, so it is written to
 * be provable rather than convenient: no React, no DOM, no module state, every
 * function total over its documented domain. `mapProjection.test.ts` runs it in
 * the `unit` project and sweeps the square exhaustively.
 *
 * ── The transform ───────────────────────────────────────────────────────────
 * World → normalised is Valve's overview equation, the same one
 * `apps/web/src/shared/radar.ts` already uses on the analysis page (it returns
 * percentages; this returns fractions, which is the same number):
 *
 *   nx = (x − originX) / (unitsPerPixel · overviewSize)
 *   ny = (originY − y) / (unitsPerPixel · overviewSize)
 *
 * The y term is subtracted the other way round because world y grows north
 * while image y grows down.
 *
 * Normalised → canvas is a fit, not a stretch. The overview artwork is square;
 * a canvas need not be. Stretching would silently distort distances and
 * angles — and this widget's whole job is to make an angle ("交战轴 132°")
 * legible — so the square is inscribed in the viewport and centred, and the
 * leftover strip is empty. `extent` is the side of that inscribed square.
 *
 * ── Precision ───────────────────────────────────────────────────────────────
 * Nothing is rounded here. Rounding belongs at the edge, where a path string is
 * built (`pathGeometry.formatCoordinate`), because rounding mid-chain makes
 * `toWorld(toCanvas(p)) === p` stop holding and that identity is the cheapest
 * correctness check the group has.
 */

import { isUsableCalibration, type MapCalibration } from './mapCalibration';
import type { CanvasPoint, NormalizedPoint, WorldPoint } from './types';

/** The box a projection has to fill, in SVG user units. */
export interface MapViewport {
  readonly width: number;
  readonly height: number;
}

/** How the overview square sits inside a viewport. */
export interface OverviewFit {
  /** Side of the inscribed square, in canvas units. */
  readonly extent: number;
  /** Canvas x of the square's left edge. */
  readonly offsetX: number;
  /** Canvas y of the square's top edge. */
  readonly offsetY: number;
}

export interface MapProjection extends OverviewFit {
  readonly calibration: MapCalibration;
  readonly viewport: MapViewport;
  /** World → canvas. */
  toCanvas(point: WorldPoint): CanvasPoint;
  /** Canvas → world. The exact inverse of `toCanvas`. */
  toWorld(point: CanvasPoint): WorldPoint;
  /** A world-space distance in canvas units. Isotropic, because the fit is. */
  toCanvasLength(units: number): number;
  /** A canvas distance back in world units. */
  toWorldLength(length: number): number;
  /** Does the world point fall on the overview artwork at all? */
  covers(point: WorldPoint): boolean;
}

/** Side of the world square the overview covers, in Hammer units. */
export function worldSpan(calibration: MapCalibration): number {
  return calibration.unitsPerPixel * calibration.overviewSize;
}

/** World → the overview's unit square. Values outside [0,1] mean "off the artwork". */
export function worldToNormalized(calibration: MapCalibration, point: WorldPoint): NormalizedPoint {
  const span = worldSpan(calibration);
  return {
    x: (point.x - calibration.originX) / span,
    y: (calibration.originY - point.y) / span,
  };
}

/** The inverse of `worldToNormalized`. */
export function normalizedToWorld(calibration: MapCalibration, point: NormalizedPoint): WorldPoint {
  const span = worldSpan(calibration);
  return {
    x: point.x * span + calibration.originX,
    y: calibration.originY - point.y * span,
  };
}

/** True when a normalised point is on the artwork, edges included. */
export function coversNormalized(point: NormalizedPoint): boolean {
  return point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
}

/**
 * Inscribe the square overview in a viewport and centre it.
 *
 * A degenerate viewport (zero or negative side, non-finite side) yields a zero
 * extent rather than a throw: a container can legitimately measure 0 for one
 * frame, and a projection that draws nothing is a better answer there than a
 * crash inside a render.
 */
export function fitOverview(viewport: MapViewport): OverviewFit {
  const width = Number.isFinite(viewport.width) ? Math.max(0, viewport.width) : 0;
  const height = Number.isFinite(viewport.height) ? Math.max(0, viewport.height) : 0;
  const extent = Math.min(width, height);
  return {
    extent,
    offsetX: (width - extent) / 2,
    offsetY: (height - extent) / 2,
  };
}

/**
 * Build the projection.
 *
 * Throws on an unusable calibration instead of producing NaN geometry, because
 * NaN in an SVG `d` attribute is invisible: the path silently disappears and
 * the reader sees an empty, confident-looking map. Callers check
 * `isUsableCalibration` first and render a state; `MapCanvas` does exactly that.
 */
export function createMapProjection(calibration: MapCalibration, viewport: MapViewport): MapProjection {
  if (!isUsableCalibration(calibration)) {
    // The guard narrows the argument to `never` here, so the name is read back
    // through the parameter's declared type rather than the narrowed one.
    const named = calibration as MapCalibration | null | undefined;
    throw new TypeError(`unusable map calibration for ${named?.mapName ?? 'unknown map'}`);
  }

  const fit = fitOverview(viewport);
  const span = worldSpan(calibration);
  const { extent, offsetX, offsetY } = fit;

  return {
    calibration,
    viewport,
    extent,
    offsetX,
    offsetY,
    toCanvas(point) {
      const normalized = worldToNormalized(calibration, point);
      return {
        x: offsetX + normalized.x * extent,
        y: offsetY + normalized.y * extent,
      };
    },
    toWorld(point) {
      if (extent === 0) {
        // No inverse exists; report the overview's top-left rather than NaN.
        return { x: calibration.originX, y: calibration.originY };
      }
      return normalizedToWorld(calibration, {
        x: (point.x - offsetX) / extent,
        y: (point.y - offsetY) / extent,
      });
    },
    toCanvasLength(units) {
      return (units / span) * extent;
    },
    toWorldLength(length) {
      return extent === 0 ? 0 : (length / extent) * span;
    },
    covers(point) {
      return coversNormalized(worldToNormalized(calibration, point));
    },
  };
}
