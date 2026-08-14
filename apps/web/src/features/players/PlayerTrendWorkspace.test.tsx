import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import type { PlayerMatchPage } from '../../shared/desktop/dto';
import { PlayerTrendWorkspace } from './PlayerTrendWorkspace';

const matches: PlayerMatchPage = {
  steam_id: '76561198000000001',
  page: 1,
  page_size: 20,
  total: 3,
  coverage: { projected_demos: 3, total_analyses: 3, projection_complete: true },
  items: [
    { demo_id: '11111111-1111-4111-8111-111111111111', demo_name: 'M3', map_name: 'de_mirage', match_date: null, cataloged_at: '2026-08-14T08:00:00Z', team: 'A', kills: 20, deaths: 10, assists: 4, headshots: 5, damage: 2000, adr: 100, kill_death_ratio: 2 },
    { demo_id: '22222222-2222-4222-8222-222222222222', demo_name: 'M2', map_name: 'de_anubis', match_date: null, cataloged_at: '2026-08-13T08:00:00Z', team: 'B', kills: 15, deaths: 10, assists: 4, headshots: 5, damage: 1500, adr: null, kill_death_ratio: 1.5 },
    { demo_id: '33333333-3333-4333-8333-333333333333', demo_name: 'M1', map_name: 'de_inferno', match_date: '2026-08-01T08:00:00Z', cataloged_at: '2026-08-12T08:00:00Z', team: 'A', kills: 10, deaths: 10, assists: 4, headshots: 5, damage: 1000, adr: 50, kill_death_ratio: 1 },
  ],
};

describe('PlayerTrendWorkspace', () => {
  it('renders an exact paged trajectory with nullable values and producer links', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter><PlayerTrendWorkspace matches={matches} /></MemoryRouter>,
    );

    expect(markup).toContain('data-trend-metric="adr"');
    expect(markup).toContain('1–3 / 3');
    expect(markup).toContain('M2');
    expect(markup).toContain('—');
    expect(markup).toContain('demo=11111111-1111-4111-8111-111111111111');
    expect(markup).toContain('player=76561198000000001');
    expect(markup).toContain('<svg');
  });
});
