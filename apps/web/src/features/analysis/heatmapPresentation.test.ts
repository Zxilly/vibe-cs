import { describe, expect, it } from 'vitest';

import type { HeatPointRecord } from '../../shared/desktop/dto';
import {
  filterHeatmapPoints,
  heatmapEvidenceIntent,
  nextHeatmapPointIndex,
  projectHeatmapPoints,
  summarizeHeatmapPoints,
} from './heatmapPresentation';

const points: HeatPointRecord[] = [
  {
    id: 'round:7/event:kill-640-1/kill:killer',
    round: 7,
    tick: 640,
    x: 100,
    y: 200,
    weight: 1,
    floor: 0,
    kind: 'kill',
    player_id: 'killer',
    side: 'T',
    event_kind: 'kill',
  },
  {
    id: 'round:7/event:kill-640-1/death:victim',
    round: 7,
    tick: 640,
    x: 10,
    y: 20,
    weight: 1,
    floor: 0,
    kind: 'death',
    player_id: 'victim',
    side: 'CT',
    event_kind: 'death',
  },
  {
    id: 'round:8/event:damage-900-1/damage:victim',
    round: 8,
    tick: 900,
    x: 80,
    y: 120,
    weight: 0.35,
    floor: 0,
    kind: 'damage',
    player_id: 'victim',
    side: 'T',
    event_kind: 'damage',
  },
];

describe('heatmap evidence presentation', () => {
  it('keeps killer kills and victim deaths as distinct role-scoped evidence', () => {
    expect(filterHeatmapPoints(points, {
      mode: 'kills',
      floor: null,
      side: 'all',
      playerId: null,
      round: null,
    }).map((point) => point.id)).toEqual([
      'round:7/event:kill-640-1/kill:killer',
    ]);
    expect(filterHeatmapPoints(points, {
      mode: 'deaths',
      floor: null,
      side: 'all',
      playerId: null,
      round: null,
    }).map((point) => point.id)).toEqual([
      'round:7/event:kill-640-1/death:victim',
    ]);
  });

  it('keeps a point fixed when mode, side, player, or floor filters hide other evidence', () => {
    const allCoordinates = projectHeatmapPoints(points, points, null);
    const killOnly = filterHeatmapPoints(points, {
      mode: 'kills',
      floor: 0,
      side: 'T',
      playerId: 'killer',
      round: 7,
    });
    const filteredCoordinates = projectHeatmapPoints(points, killOnly, null);
    const kill = points[0];
    expect(kill).toBeDefined();
    if (!kill) throw new Error('fixture must include killer evidence');

    expect(filteredCoordinates.get(kill.id)).toEqual(allCoordinates.get(kill.id));
    expect(filteredCoordinates.get(kill.id)).not.toEqual([50, 50]);
  });

  it('filters only by the evidenced T/CT side instead of inferring a global team', () => {
    expect(filterHeatmapPoints(points, {
      mode: 'all',
      floor: null,
      side: 'CT',
      playerId: null,
      round: null,
    }).map((point) => point.player_id)).toEqual(['victim']);
    expect(points.every((point) => point.side === 'T' || point.side === 'CT')).toBe(true);
  });

  it('filters by the authoritative round while keeping all-round mode explicit', () => {
    expect(filterHeatmapPoints(points, {
      mode: 'all',
      floor: null,
      side: 'all',
      playerId: null,
      round: 7,
    }).map((point) => point.id)).toEqual([
      'round:7/event:kill-640-1/kill:killer',
      'round:7/event:kill-640-1/death:victim',
    ]);
    expect(filterHeatmapPoints(points, {
      mode: 'all',
      floor: null,
      side: 'all',
      playerId: null,
      round: null,
    })).toHaveLength(3);
  });

  it('builds truthful watch, round, and replay intents from one selected point', () => {
    const point = points[0];
    expect(point).toBeDefined();
    if (!point) throw new Error('fixture must include event evidence');

    expect(heatmapEvidenceIntent('demo-1', point)).toEqual({
      evidenceId: 'demo:demo-1/event:kill-640-1',
      watch: { start_tick: 640 },
      round: {
        tab: 'rounds',
        round: 7,
        tick: 640,
        playerId: 'killer',
        evidenceId: 'demo:demo-1/event:kill-640-1',
      },
      replay: {
        tab: 'replay',
        round: 7,
        tick: 640,
        playerId: 'killer',
        evidenceId: 'demo:demo-1/event:kill-640-1',
      },
    });
  });

  it('keeps one roving marker tab stop and wraps arrow navigation', () => {
    expect(nextHeatmapPointIndex(80, 0, 1)).toBe(1);
    expect(nextHeatmapPointIndex(80, 79, 1)).toBe(0);
    expect(nextHeatmapPointIndex(80, 0, -1)).toBe(79);
    expect(nextHeatmapPointIndex(0, 0, 1)).toBe(0);
  });

  it('summarizes only the visible evidence slice', () => {
    const visible = filterHeatmapPoints(points, {
      mode: 'all',
      floor: null,
      side: 'all',
      playerId: null,
      round: 7,
    });

    expect(summarizeHeatmapPoints(visible)).toEqual({
      floorCount: 1,
      kinds: [
        { kind: 'death', count: 1 },
        { kind: 'kill', count: 1 },
      ],
    });
  });
});
