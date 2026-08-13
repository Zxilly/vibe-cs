import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { DemoSummary } from '../../shared/desktop/dto';
import { LibraryPage, LibraryWorkspaceSummary } from './LibraryPage';

function demo(overrides: Partial<DemoSummary>): DemoSummary {
  return {
    id: 'demo-1',
    path: 'D:\\Demos\\major.dem',
    filename: 'major.dem',
    display_name: 'Major final',
    map_name: 'de_mirage',
    played_at: '2026-08-12T00:00:00Z',
    duration_seconds: 2_940,
    total_rounds: 21,
    score_team_a: 13,
    score_team_b: 8,
    team_a_name: 'FURIA',
    team_b_name: 'Falcons',
    status: 'ready',
    lifecycle_status: 'ready',
    players: [],
    source: 'local',
    remark: '',
    updated_at: '2026-08-12T01:02:03Z',
    ...overrides,
  };
}

describe('library wide-workspace summary', () => {
  it('turns persisted demos into an actionable map and analysis index', () => {
    const onMapFilter = vi.fn();
    const markup = renderToStaticMarkup(
      <LibraryWorkspaceSummary
        demos={[
          demo({ id: 'mirage-ready' }),
          demo({ id: 'mirage-discovered', lifecycle_status: 'discovered', status: 'pending', total_rounds: 0 }),
          demo({ id: 'inferno-ready', map_name: 'de_inferno', total_rounds: 18 }),
        ]}
        activeMap="all"
        onMapFilter={onMapFilter}
      />,
    );

    expect(markup).toContain('aria-label="比赛概况"');
    expect(markup).toContain('MIRAGE');
    expect(markup).toContain('INFERNO');
    expect(markup).toContain('>39<');
    expect(markup).toContain('aria-pressed="false"');
    expect(onMapFilter).not.toHaveBeenCalled();
  });
});

describe('library server-query controls', () => {
  it('restores column visibility from the URL and keeps the selector beside table controls', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/library?columns=map,played']}>
        <LibraryPage />
      </MemoryRouter>,
    );

    expect(markup).toContain('data-testid="library-column-visibility"');
    expect(markup).toContain('data-column="map"');
    expect(markup).toContain('data-column="played"');
    expect(markup).not.toContain('data-column="score"');
    expect(markup).not.toContain('data-column="duration"');
    expect(markup).not.toContain('data-column="rounds"');
    expect(markup).not.toContain('data-column="updated"');
  });

  it('restores search, map, exact lifecycle status, and table sort from the URL', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/library?q=m0NESY&map=de_mirage&status=indexing&sort=map_desc&page=3&page_size=20']}>
        <LibraryPage />
      </MemoryRouter>,
    );

    expect(markup).toContain('value="m0NESY"');
    expect(markup).toContain('value="de_mirage"');
    expect(markup).toContain('value="indexing" selected=""');
    expect(markup).toContain('aria-sort="descending"><button type="button">地图');
  });
});
