import { describe, expect, it } from 'vitest';

import { analysisScoreboardColumns, analysisScoreboardRows } from './analysisScoreboardPresentation';

describe('analysis scoreboard presentation', () => {
  it('uses the explicit current K/D value for ordering and display', () => {
    const rows = analysisScoreboardRows([
      { id: 'low', kills: 5, deaths: 10, assists: 2, adr: 40, headshot_rate: 0.2, kill_death_ratio: 0.5 },
      { id: 'high', kills: 15, deaths: 10, assists: 3, adr: 80, headshot_rate: 0.4, kill_death_ratio: 1.5 },
    ]);

    expect(analysisScoreboardColumns).toEqual(['player', 'K', 'D', 'A', 'K/D', 'ADR', 'HS%']);
    expect(rows.map((row) => row.id)).toEqual(['high', 'low']);
    expect(rows[0]).toMatchObject({ killDeathRatio: '1.50' });
    expect(rows[0]).not.toHaveProperty('rating');
  });
});
