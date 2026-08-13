import type { ReplayFrameRecord } from '../../shared/desktop/dto';

export type ReplayWorldBounds = Readonly<{
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}>;

const RELATIVE_MAP_PADDING_PERCENT = 10;

export const REPLAY_WORLD_BOUNDS_LIMITS = Object.freeze({
  frames: 20_000,
  playersPerFrame: 64,
  projectilesPerFrame: 512,
});

export function worldPointsBounds(
  points: ReadonlyArray<readonly [number, number]>,
): ReplayWorldBounds | null {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)
    || !Number.isFinite(minY) || !Number.isFinite(maxY)) return null;
  const width = maxX - minX;
  const height = maxY - minY;
  return Number.isFinite(width) && Number.isFinite(height)
    ? { minX, maxX, minY, maxY }
    : null;
}

export function replayWorldBounds(frames: readonly ReplayFrameRecord[]): ReplayWorldBounds | null {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  const include = (point: readonly [number, number, number]) => {
    const [x, y] = point;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  };

  const frameCount = Math.min(frames.length, REPLAY_WORLD_BOUNDS_LIMITS.frames);
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const replayFrame = frames[frameIndex];
    if (!replayFrame) continue;
    if (replayFrame.bomb) include(replayFrame.bomb.position);
    const playerCount = Math.min(
      replayFrame.players.length,
      REPLAY_WORLD_BOUNDS_LIMITS.playersPerFrame,
    );
    for (let playerIndex = 0; playerIndex < playerCount; playerIndex += 1) {
      const player = replayFrame.players[playerIndex];
      if (player) include(player.position);
    }
    const projectileCount = Math.min(
      replayFrame.projectiles.length,
      REPLAY_WORLD_BOUNDS_LIMITS.projectilesPerFrame,
    );
    for (let projectileIndex = 0; projectileIndex < projectileCount; projectileIndex += 1) {
      const projectile = replayFrame.projectiles[projectileIndex];
      if (projectile?.active) include(projectile.position);
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)
    || !Number.isFinite(minY) || !Number.isFinite(maxY)) return null;
  const width = maxX - minX;
  const height = maxY - minY;
  return Number.isFinite(width) && Number.isFinite(height)
    ? { minX, maxX, minY, maxY }
    : null;
}

export function worldPointsToRelativePercent(
  points: ReadonlyArray<readonly [number, number]>,
  bounds: ReplayWorldBounds | null,
): Array<[number, number]> {
  if (!bounds) return points.map(() => [50, 50]);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const extent = 100 - RELATIVE_MAP_PADDING_PERCENT * 2;
  const worldExtent = Math.max(width, height);
  const horizontalExtent = worldExtent > 0 ? (width / worldExtent) * extent : 0;
  const verticalExtent = worldExtent > 0 ? (height / worldExtent) * extent : 0;
  const horizontalStart = (100 - horizontalExtent) / 2;
  const verticalStart = (100 - verticalExtent) / 2;
  return points.map(([x, y]) => {
    const relativeX = width > 0 ? horizontalStart + ((x - bounds.minX) / width) * horizontalExtent : 50;
    const relativeY = height > 0 ? verticalStart + ((y - bounds.minY) / height) * verticalExtent : 50;
    return Number.isFinite(relativeX) && Number.isFinite(relativeY)
      ? [relativeX, relativeY]
      : [50, 50];
  });
}
