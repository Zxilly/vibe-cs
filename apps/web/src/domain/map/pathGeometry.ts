/*
 * Domain layer, 2 of 3 — `domain/map/`: polyline and marker geometry.
 *
 * Everything a layer needs to turn a list of canvas points into SVG attribute
 * strings, kept out of the components so it can be exhausted in the `unit`
 * project. No React, no DOM, no colour.
 *
 * ── Rounding ───────────────────────────────────────────────────────────────
 * Coordinates are rounded to `COORDINATE_PRECISION` decimals *here and nowhere
 * else*. A path with 600 points at full float precision is ~14 KB of attribute
 * text per player; three decimals of an SVG user unit is a thousandth of a CSS
 * pixel, so the rounding is invisible and the markup shrinks by more than half.
 * Doing it at the string boundary keeps `toWorld(toCanvas(p)) === p` intact in
 * `mapProjection`.
 *
 * ── Angles ─────────────────────────────────────────────────────────────────
 * The artboard prints 「交战轴 132° · 距离 18.7m」, so the group needs one
 * definition of "the angle of an axis" and it must be a *world* angle: a canvas
 * angle would be the world angle mirrored, because canvas y grows downward.
 * `worldBearingDegrees` therefore takes world points. 0° is east (+x) and the
 * angle grows counter-clockwise, matching the game's own yaw convention, and
 * the result is normalised into [0, 360).
 */

import type { CanvasPoint, WorldPoint } from './types';

/** Decimals kept in generated path data. See the note above. */
export const COORDINATE_PRECISION = 3;

/**
 * One Hammer unit is one inch; the artboard prints distances in metres
 * (「距离 18.7m」), so the group needs the conversion in exactly one place.
 */
export const HAMMER_UNITS_PER_METRE = 39.37;

/** Round and strip the trailing zeros an SVG attribute does not need. */
export function formatCoordinate(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Number(value.toFixed(COORDINATE_PRECISION));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** Drop the points an SVG cannot draw, rather than emitting `NaN` into `d`. */
export function finitePoints(points: readonly CanvasPoint[]): CanvasPoint[] {
  return points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

/**
 * `M x y L x y …` for a polyline. Returns `''` for fewer than two drawable
 * points: a `d` of `''` renders nothing, whereas `M x y` alone renders nothing
 * *and* still costs a DOM node, and a one-sample track is not a path.
 */
export function polylineCommand(points: readonly CanvasPoint[]): string {
  const usable = finitePoints(points);
  if (usable.length < 2) return '';
  const [head, ...rest] = usable;
  if (!head) return '';
  const start = `M ${formatCoordinate(head.x)} ${formatCoordinate(head.y)}`;
  return rest.reduce(
    (command, point) => `${command} L ${formatCoordinate(point.x)} ${formatCoordinate(point.y)}`,
    start,
  );
}

/**
 * A triangular head at `to`, pointing away from `from`, as a closed `d`.
 *
 * This is how a track says which end is the end. A dash pattern or a colour
 * ramp along the line would also encode direction, but both are unreadable at
 * the widths a 720px canvas gives a 600-sample track, and a colour ramp would
 * collide with the selection colour.
 *
 * Returns `''` when the two points coincide — there is no direction to draw,
 * and inventing one would point somewhere arbitrary.
 */
export function arrowHeadCommand(from: CanvasPoint, to: CanvasPoint, size: number): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length === 0 || !Number.isFinite(size) || size <= 0) return '';

  const ux = dx / length;
  const uy = dy / length;
  // Perpendicular, half-width = size / 2 so the head is as wide as it is long.
  const px = -uy * (size / 2);
  const py = ux * (size / 2);
  const baseX = to.x - ux * size;
  const baseY = to.y - uy * size;

  return [
    `M ${formatCoordinate(to.x)} ${formatCoordinate(to.y)}`,
    `L ${formatCoordinate(baseX + px)} ${formatCoordinate(baseY + py)}`,
    `L ${formatCoordinate(baseX - px)} ${formatCoordinate(baseY - py)}`,
    'Z',
  ].join(' ');
}

/** An X, the artboard's mark for a death, centred on a point. */
export function crossCommand(centre: CanvasPoint, size: number): string {
  if (!Number.isFinite(centre.x) || !Number.isFinite(centre.y) || !Number.isFinite(size) || size <= 0) {
    return '';
  }
  const arm = size / 2;
  const left = formatCoordinate(centre.x - arm);
  const right = formatCoordinate(centre.x + arm);
  const top = formatCoordinate(centre.y - arm);
  const bottom = formatCoordinate(centre.y + arm);
  return `M ${left} ${top} L ${right} ${bottom} M ${right} ${top} L ${left} ${bottom}`;
}

/** Bearing of a world-space axis in degrees: 0 = east, growing counter-clockwise. */
export function worldBearingDegrees(from: WorldPoint, to: WorldPoint): number | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return null;
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/** Straight-line world distance in metres, for 「距离 18.7m」. */
export function worldDistanceMetres(from: WorldPoint, to: WorldPoint): number | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  return Math.hypot(dx, dy) / HAMMER_UNITS_PER_METRE;
}

/** Summed length of a canvas polyline, for deciding whether a head fits. */
export function polylineLength(points: readonly CanvasPoint[]): number {
  const usable = finitePoints(points);
  let total = 0;
  for (let index = 1; index < usable.length; index += 1) {
    const previous = usable[index - 1];
    const current = usable[index];
    if (!previous || !current) continue;
    total += Math.hypot(current.x - previous.x, current.y - previous.y);
  }
  return total;
}
