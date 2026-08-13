import { describe, expect, it } from 'vitest';

import {
  averageKillDeathRatio,
  compareKillDeathRatio,
  formatKillDeathRatio,
} from './performanceMetrics';

describe('truthful performance metric presentation', () => {
  it('derives K/D from kills and deaths for raw count-only inputs', () => {
    expect(formatKillDeathRatio({ kills: 18, deaths: 12 })).toBe('1.50');
    expect(formatKillDeathRatio({ kills: 3, deaths: 0 })).toBe('∞');
    expect(formatKillDeathRatio({ kills: 0, deaths: 0 })).toBe('—');
  });

  it('averages and sorts by the same derived K/D contract', () => {
    const players = [
      { kills: 9, deaths: 14 },
      { kills: 18, deaths: 12 },
    ];

    expect(averageKillDeathRatio(players)).toBeCloseTo((9 / 14 + 18 / 12) / 2);
    expect([...players].sort(compareKillDeathRatio)[0]).toBe(players[1]);
  });
});
