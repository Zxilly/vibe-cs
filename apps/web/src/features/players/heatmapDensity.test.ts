import { describe, expect, it } from 'vitest';

import { aggregateHeatmapDensity } from './heatmapDensity';

describe('heatmap density', () => {
  it('counts exact visible evidence points in deterministic grid cells', () => {
    const result = aggregateHeatmapDensity([
      { evidenceId: 'a', kind: 'kills', xPercent: 5, yPercent: 5 },
      { evidenceId: 'b', kind: 'deaths', xPercent: 9.9, yPercent: 9.9 },
      { evidenceId: 'c', kind: 'kills', xPercent: 100, yPercent: 100 },
    ], 10);

    expect(result.maximum).toBe(2);
    expect(result.cells).toEqual([
      { key: '0:0', column: 0, row: 0, kills: 1, deaths: 1, count: 2, evidenceIds: ['a', 'b'] },
      { key: '9:9', column: 9, row: 9, kills: 1, deaths: 0, count: 1, evidenceIds: ['c'] },
    ]);
  });

  it('rejects non-finite or out-of-plane coordinates instead of moving evidence', () => {
    expect(() => aggregateHeatmapDensity([
      { evidenceId: 'bad', kind: 'kills', xPercent: -1, yPercent: Number.NaN },
    ], 10)).toThrow(/coordinate/i);
  });
});
