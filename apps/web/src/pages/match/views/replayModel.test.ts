/*
 * `unit` project — the arithmetic of 回放与热力图.
 *
 * No React and no DOM: everything asserted here is a function of the wire
 * records, which is the whole reason `replayModel.ts` is separate from the
 * view.
 */

import { describe, expect, it } from 'vitest';

import type { ReplayFrameRecord, ReplayPayload } from '../../../shared/desktop/dto';
import {
  PATH_SAMPLE_LIMIT,
  buildEngagements,
  buildPlayerTracks,
  clampTick,
  currentEventId,
  frameAtTick,
  frameIndexAtTick,
  heatFloors,
  heatSamplesOf,
  normaliseSide,
  pathStride,
  playerMarkers,
  replayEventRows,
  roundBounds,
  roundEvents,
  sliceReplay,
} from './replayModel';
import {
  ANALYSIS,
  HEAT_POINTS,
  REPLAY,
  REPLAY_FRAMES,
  ROUND_21,
  TICK_RATE,
} from './test/fixtures';

describe('roundBounds', () => {
  it('reads the selected round out of the analysis', () => {
    expect(roundBounds(ANALYSIS, 21)).toEqual({
      startTick: ROUND_21.startTick,
      endTick: ROUND_21.endTick,
    });
  });

  it('is null for 「整场」 and for a round the analysis does not have', () => {
    expect(roundBounds(ANALYSIS, null)).toBeNull();
    // A hand-edited `?round=99` is a navigation, not an error: the workspace
    // shows the whole match rather than an empty canvas.
    expect(roundBounds(ANALYSIS, 99)).toBeNull();
    expect(roundBounds(undefined, 21)).toBeNull();
  });
});

describe('sliceReplay', () => {
  it('takes the whole stream when no round is selected', () => {
    const slice = sliceReplay(REPLAY, null);
    expect(slice?.startTick).toBe(149_000);
    expect(slice?.endTick).toBe(149_512);
    expect(slice?.frames).toHaveLength(REPLAY_FRAMES.length);
    expect(slice?.tickRate).toBe(TICK_RATE);
  });

  it('intersects the round with what the stream actually covers', () => {
    /* The round runs 148 920–150 440 and the stream only 149 000–149 512, so
       the slice is the overlap. Trusting the round alone would ask the view for
       frames that were never decoded. */
    const slice = sliceReplay(REPLAY, { startTick: ROUND_21.startTick, endTick: ROUND_21.endTick });
    expect(slice?.startTick).toBe(149_000);
    expect(slice?.endTick).toBe(149_512);
  });

  it('is null when the round does not overlap the stream at all', () => {
    expect(sliceReplay(REPLAY, { startTick: 10, endTick: 900 })).toBeNull();
  });

  it('is null for a payload with no usable range', () => {
    const broken: ReplayPayload = {
      ...REPLAY,
      frames: [],
      fidelity: { ...REPLAY.fidelity, start_tick: 0, end_tick: 0 },
    };
    expect(sliceReplay(broken, null)).toBeNull();
    expect(sliceReplay(undefined, null)).toBeNull();
  });
});

describe('clampTick', () => {
  const range = { startTick: 100, endTick: 200 };

  it('keeps the playhead inside the slice and rounds to a whole tick', () => {
    expect(clampTick(150.7, range)).toBe(151);
    expect(clampTick(-4, range)).toBe(100);
    expect(clampTick(9_999, range)).toBe(200);
  });

  it('falls back to the start rather than propagating NaN', () => {
    expect(clampTick(Number.NaN, range)).toBe(100);
  });
});

describe('frameIndexAtTick', () => {
  it('finds the last frame at or before the playhead', () => {
    expect(frameIndexAtTick(REPLAY_FRAMES, 149_000)).toBe(0);
    expect(frameIndexAtTick(REPLAY_FRAMES, 149_100)).toBe(1);
    expect(frameIndexAtTick(REPLAY_FRAMES, 149_512)).toBe(REPLAY_FRAMES.length - 1);
  });

  it('is -1 before the first frame, and frameAtTick is null there', () => {
    expect(frameIndexAtTick(REPLAY_FRAMES, 1)).toBe(-1);
    expect(frameAtTick(REPLAY_FRAMES, 1)).toBeNull();
    expect(frameIndexAtTick([], 149_000)).toBe(-1);
  });
});

describe('pathStride', () => {
  it('is 1 while the track fits the budget', () => {
    expect(pathStride(10)).toBe(1);
    expect(pathStride(PATH_SAMPLE_LIMIT)).toBe(1);
  });

  it('thins a whole-match track down to the budget', () => {
    // §10.3 gap 1: ten players × 20 000 frames is megabytes of `d` attribute.
    const stride = pathStride(20_000);
    expect(stride).toBe(Math.ceil(20_000 / PATH_SAMPLE_LIMIT));
    expect(Math.ceil(20_000 / stride)).toBeLessThanOrEqual(PATH_SAMPLE_LIMIT);
  });
});

describe('buildPlayerTracks', () => {
  it('builds one track per player up to the playhead', () => {
    const tracks = buildPlayerTracks(REPLAY_FRAMES, 4);
    expect(tracks.paths.map((path) => path.playerId)).toEqual(['kael', 'sable', 'corvin']);
    expect(tracks.stride).toBe(1);
    expect(tracks.paths[0]?.samples).toHaveLength(5);
    // The trail ends at the playhead, not at the end of the stream.
    expect(tracks.paths[0]?.samples.at(-1)?.tick).toBe(REPLAY_FRAMES[4]?.tick);
  });

  it('keeps the frame at the playhead whatever the stride drops', () => {
    const tracks = buildPlayerTracks(REPLAY_FRAMES, 7, 3);
    expect(tracks.stride).toBeGreaterThan(1);
    expect(tracks.paths[0]?.samples.at(-1)?.tick).toBe(REPLAY_FRAMES[7]?.tick);
  });

  it('carries the side over from the frame and drops a team letter', () => {
    const tracks = buildPlayerTracks(REPLAY_FRAMES, 2);
    expect(tracks.paths.find((path) => path.playerId === 'kael')?.side).toBe('CT');
    expect(tracks.paths.find((path) => path.playerId === 'sable')?.side).toBe('T');
  });

  it('is empty before the first frame', () => {
    expect(buildPlayerTracks(REPLAY_FRAMES, -1)).toEqual({ paths: [], stride: 1, frameCount: 0 });
  });
});

describe('playerMarkers', () => {
  it('draws only the living', () => {
    // Sable dies at index 3 and Corvin at index 6 in the fixture.
    const late = REPLAY_FRAMES[7] ?? null;
    expect(playerMarkers(late).map((marker) => marker.playerId)).toEqual(['kael']);
  });

  it('carries the initial, the health and the weapon of the frame', () => {
    const [first] = playerMarkers(REPLAY_FRAMES[0] ?? null);
    expect(first?.initial).toBe('K');
    expect(first?.health).toBe(78);
    expect(first?.weapon).toBe('ak47');
  });

  it('is empty with no frame', () => {
    expect(playerMarkers(null)).toEqual([]);
  });
});

describe('buildEngagements', () => {
  const events = roundEvents(ANALYSIS, 21);

  it('reads both ends of the axis out of the frame at the kill tick', () => {
    const built = buildEngagements(events, REPLAY_FRAMES);
    expect(built.engagements.map((duel) => duel.id)).toEqual(['e-kill-sable', 'e-kill-corvin']);

    const first = built.engagements[0];
    expect(first?.attacker.playerName).toBe('Kael');
    expect(first?.victim.playerName).toBe('Sable');
    expect(first?.headshot).toBe(true);
    // Two different points, or there is no axis to draw.
    expect(first?.attacker.x).not.toBe(first?.victim.x);
  });

  it('carries 穿墙 through as the layer’s own qualifier', () => {
    const built = buildEngagements(events, REPLAY_FRAMES);
    expect(built.engagements.find((duel) => duel.id === 'e-kill-corvin')?.throughWall).toBe(true);
  });

  it('drops a kill it cannot place, and counts it', () => {
    const frames: readonly ReplayFrameRecord[] = [
      { tick: 149_128, players: [], projectiles: [], bomb: null },
    ];
    const built = buildEngagements(events, frames);
    expect(built.engagements).toHaveLength(0);
    // Two kills in the round; both unplaceable, and the count says so rather
    // than the map quietly drawing fewer axes than the list has rows.
    expect(built.skipped).toBe(2);
  });
});

describe('roundEvents / replayEventRows', () => {
  it('narrows to one round and orders by tick', () => {
    const rows = roundEvents(ANALYSIS, 21);
    expect(rows.every((row) => row.round === 21)).toBe(true);
    expect(rows.map((row) => row.event.tick)).toEqual([149_100, 149_128, 149_256, 149_320]);
  });

  it('lists every round when none is selected', () => {
    expect(roundEvents(ANALYSIS, null)).toHaveLength(ROUND_21_EVENT_COUNT);
    expect(roundEvents(undefined, null)).toEqual([]);
  });

  it('keeps kills and objectives and drops damage', () => {
    const rows = replayEventRows(roundEvents(ANALYSIS, 21));
    expect(rows.map((row) => row.id)).toEqual(['e-kill-sable', 'e-plant', 'e-kill-corvin']);
    expect(rows.map((row) => row.kind)).toEqual(['kill', 'objective', 'kill']);
  });

  it('can be narrowed further by the caller', () => {
    const rows = replayEventRows(roundEvents(ANALYSIS, 21), ['objective']);
    expect(rows.map((row) => row.id)).toEqual(['e-plant']);
  });
});

/** Only round 21 carries events in the fixture. */
const ROUND_21_EVENT_COUNT = 4;

describe('currentEventId', () => {
  const rows = replayEventRows(roundEvents(ANALYSIS, 21));

  it('is the last row at or before the playhead', () => {
    expect(currentEventId(rows, 149_128)).toBe('e-kill-sable');
    expect(currentEventId(rows, 149_300)).toBe('e-plant');
    expect(currentEventId(rows, 999_999)).toBe('e-kill-corvin');
  });

  it('is null before the first row and with no playhead', () => {
    expect(currentEventId(rows, 1)).toBeNull();
    expect(currentEventId(rows, null)).toBeNull();
  });
});

describe('heatSamplesOf / heatFloors', () => {
  it('narrows to the selected round and drops the unattributed points', () => {
    const samples = heatSamplesOf(HEAT_POINTS, 21);
    expect(samples).toHaveLength(4);
    // The point with `round: null` is kept only when no round is selected —
    // 「这一回合的位置」 must not include points that might belong to another.
    expect(heatSamplesOf(HEAT_POINTS, null)).toHaveLength(HEAT_POINTS.length);
  });

  it('reports the floors the cloud actually occupies', () => {
    expect(heatFloors(HEAT_POINTS)).toEqual([0, 1]);
    expect(heatFloors(undefined)).toEqual([]);
  });
});

describe('normaliseSide', () => {
  it('maps the two side spellings and nothing else', () => {
    expect(normaliseSide('CT')).toBe('CT');
    expect(normaliseSide(' t ')).toBe('T');
    // A team letter is not a side: sides swap at the half and the letter does not.
    expect(normaliseSide('A')).toBeUndefined();
    expect(normaliseSide('')).toBeUndefined();
  });
});
