import type { RadarOverviewRecord } from './api/dto';

export type RadarTransform = NonNullable<RadarOverviewRecord['transform']>;

const OVERVIEW_SIZE = 1024;

/**
 * Convert a CS world-space point into percentages in a Valve overview image.
 *
 * `rotate` records that the overview artwork was quarter-turned while it was authored. Valve's
 * published `pos_x`, `pos_y`, and `scale` already describe the final overview orientation, so
 * applying a second rotation here would move otherwise correct coordinates off the map.
 */
export function worldToRadarPercent(
  point: readonly [number, number],
  transform: RadarTransform,
): [number, number] | null {
  const { pos_x: positionX, pos_y: positionY, scale } = transform;
  if (![point[0], point[1], positionX, positionY, scale].every(Number.isFinite) || scale <= 0) {
    return null;
  }

  const x = ((point[0] - positionX) / scale / OVERVIEW_SIZE) * 100;
  const y = ((positionY - point[1]) / scale / OVERVIEW_SIZE) * 100;
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

export function worldPointsToRadarPercent(
  points: ReadonlyArray<readonly [number, number]>,
  transform: RadarTransform | null,
): Array<[number, number]> | null {
  if (!transform) return null;
  const coordinates = points.map((point) => worldToRadarPercent(point, transform));
  return coordinates.every((point): point is [number, number] => point !== null) ? coordinates : null;
}
