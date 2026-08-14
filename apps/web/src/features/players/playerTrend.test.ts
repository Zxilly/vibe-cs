import { describe, expect, it } from 'vitest';

import type { PlayerMatchPage } from '../../shared/desktop/dto';
import { derivePlayerTrend } from './playerTrend';

function page(): PlayerMatchPage {
  return {
    steam_id: '76561198000000001',
    page: 1,
    page_size: 20,
    total: 6,
    coverage: { projected_demos: 6, total_analyses: 6, projection_complete: true },
    items: Array.from({ length: 6 }, (_, index) => ({
      demo_id: `00000000-0000-4000-8000-00000000000${index}`,
      demo_name: `M${6 - index}`,
      map_name: 'de_mirage',
      match_date: index === 0 ? '2026-08-14T08:00:00Z' : null,
      cataloged_at: `2026-08-${String(14 - index).padStart(2, '0')}T08:00:00Z`,
      team: index % 2 === 0 ? 'A' : 'B',
      kills: 20 - index,
      deaths: 10,
      assists: 3,
      headshots: 5,
      damage: 2000 - index * 100,
      adr: index === 2 ? null : 100 - index * 5,
      kill_death_ratio: index === 2 ? null : (20 - index) / 10,
    })),
  };
}

describe('player trend', () => {
  it('projects the exact selected page oldest-to-newest without inventing missing values', () => {
    const trend = derivePlayerTrend(page(), 'adr');

    expect(trend.points.map((point) => point.demoName)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5', 'M6']);
    expect(trend.points[3]?.value).toBeNull();
    expect(trend.points[5]?.matchDate).toBe('2026-08-14T08:00:00Z');
    expect(trend.points[0]?.href).toContain('player=76561198000000001');
    expect(trend.window).toEqual({ first: 1, last: 6, total: 6 });
  });

  it('compares equal recent and prior subwindows as arithmetic rather than a verdict', () => {
    const trend = derivePlayerTrend(page(), 'kills');

    expect(trend.comparison).toEqual({ sampleSize: 3, priorAverage: 16, recentAverage: 19, delta: 3 });
    expect(trend.minimum).toBe(15);
    expect(trend.maximum).toBe(20);
  });
});
