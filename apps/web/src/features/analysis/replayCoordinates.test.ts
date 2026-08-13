import { describe, expect, it } from 'vitest';

import type { ReplayFrameRecord } from '../../shared/desktop/dto';
import {
  REPLAY_WORLD_BOUNDS_LIMITS,
  replayWorldBounds,
  worldPointsBounds,
  worldPointsToRelativePercent,
} from './replayCoordinates';

function frame(
  tick: number,
  points: Array<readonly [number, number]>,
): ReplayFrameRecord {
  return {
    tick,
    players: points.map(([x, y], index) => ({
      id: `player-${tick}-${index}`,
      name: `Player ${index}`,
      team: index % 2 === 0 ? 'A' : 'B',
      position: [x, y, 0],
      yaw: 0,
      health: 100,
      armor: 0,
      alive: true,
      weapon: '',
      input: null,
    })),
    projectiles: [],
    bomb: null,
  };
}

describe('event-sparse replay coordinates', () => {
  it('keeps the same world position fixed while the current evidence frame changes', () => {
    const frames = [
      frame(100, [[0, 0], [100, 100]]),
      frame(200, [[100, 100], [200, 200]]),
    ];
    const bounds = replayWorldBounds(frames);

    expect(bounds).not.toBeNull();
    expect(worldPointsToRelativePercent([[100, 100]], bounds)).toEqual([[50, 50]]);
    expect(worldPointsToRelativePercent([[100, 100]], bounds)).toEqual([[50, 50]]);
  });

  it('uses finite visible replay evidence and ignores inactive or malformed coordinates', () => {
    const replayFrame = frame(100, [[0, 0], [Number.NaN, Number.POSITIVE_INFINITY]]);
    replayFrame.projectiles = [
      { kind: 'smoke', position: [300, -200, 0], active: true, radius: null, masks_vision: true },
      { kind: 'flash', position: [-999, -999, 0], active: false, radius: null, masks_vision: false },
    ];
    replayFrame.bomb = { position: [-300, 400, 0], state: 'planted', carrier_id: null };

    expect(replayWorldBounds([replayFrame])).toEqual({
      minX: -300,
      maxX: 300,
      minY: -200,
      maxY: 400,
    });
  });

  it('does not inspect evidence beyond the validated replay protocol budget', () => {
    const replayFrame = frame(100, [[0, 0]]);
    replayFrame.projectiles = Array.from(
      { length: REPLAY_WORLD_BOUNDS_LIMITS.projectilesPerFrame + 1 },
      (_, index) => ({
        kind: 'smoke',
        position: index === REPLAY_WORLD_BOUNDS_LIMITS.projectilesPerFrame
          ? [1_000_000, 1_000_000, 0]
          : [index, index, 0],
        active: true,
        radius: null,
        masks_vision: true,
      }),
    );

    expect(replayWorldBounds([replayFrame])).toEqual({
      minX: 0,
      maxX: REPLAY_WORLD_BOUNDS_LIMITS.projectilesPerFrame - 1,
      minY: 0,
      maxY: REPLAY_WORLD_BOUNDS_LIMITS.projectilesPerFrame - 1,
    });
  });

  it('preserves world-space aspect ratio and centers the shorter axis', () => {
    const bounds = { minX: 0, maxX: 200, minY: 0, maxY: 100 };

    expect(worldPointsToRelativePercent([[0, 0], [200, 100]], bounds)).toEqual([
      [10, 30],
      [90, 70],
    ]);
  });

  it('derives one stable bound from the complete evidence set', () => {
    const bounds = worldPointsBounds([[0, 0], [100, 50], [200, 100]]);

    expect(worldPointsToRelativePercent([[100, 50]], bounds)).toEqual([[50, 50]]);
    expect(worldPointsToRelativePercent([[200, 100]], bounds)).toEqual([[90, 70]]);
  });

  it('fails closed when finite coordinates overflow the relative extent', () => {
    const bounds = replayWorldBounds([
      frame(100, [[-Number.MAX_VALUE, 0], [Number.MAX_VALUE, 1]]),
    ]);

    expect(bounds).toBeNull();
    expect(worldPointsToRelativePercent([[0, 0]], bounds)).toEqual([[50, 50]]);
  });
});
