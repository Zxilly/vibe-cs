import { describe, expect, it } from 'vitest';

import { worldPointsToRadarPercent, worldToRadarPercent } from './radar';

const transform = {
  pos_x: -2048,
  pos_y: 3072,
  scale: 4,
  rotate: false,
  zoom: null,
};

describe('worldToRadarPercent', () => {
  it('maps the overview origin and extent into image percentages', () => {
    expect(worldToRadarPercent([-2048, 3072], transform)).toEqual([0, 0]);
    expect(worldToRadarPercent([2048, -1024], transform)).toEqual([100, 100]);
    expect(worldToRadarPercent([0, 1024], transform)).toEqual([50, 50]);
  });

  it('supports an overview whose source artwork carries the rotate flag', () => {
    const dust2 = {
      pos_x: -2476,
      pos_y: 3239,
      scale: 4.4,
      rotate: true,
      zoom: 1.1,
    };
    const ctSpawn: [number, number] = [
      dust2.pos_x + 0.62 * 1024 * dust2.scale,
      dust2.pos_y - 0.21 * 1024 * dust2.scale,
    ];
    const mapped = worldToRadarPercent(ctSpawn, dust2);

    expect(mapped?.[0]).toBeCloseTo(62, 8);
    expect(mapped?.[1]).toBeCloseTo(21, 8);
  });

  it('rejects an invalid transform for the entire coordinate set', () => {
    expect(worldPointsToRadarPercent([[0, 0]], { ...transform, scale: 0 })).toBeNull();
  });
});
