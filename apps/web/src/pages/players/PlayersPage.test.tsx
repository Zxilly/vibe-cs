/*
 * `markup` project — the /players frame.
 *
 * The first paint: queries pending, so the frame, the skeleton and the search
 * box. The §10.3 selection contract needs resolved rows and is asserted in
 * `PlayersPage.interaction.test.tsx`.
 */

import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { DesktopClientProvider, type DesktopClient } from '../../data/desktopClient';
import { renderMarkup } from '../../test/render';
import { PlayersPage } from '../PlayersPage';

const pending: Partial<DesktopClient> = {
  listPlayers: () => new Promise(() => undefined),
};

function at(url: string): string {
  return renderMarkup(
    <DesktopClientProvider client={pending as DesktopClient}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/players" element={<PlayersPage />} />
        </Routes>
      </MemoryRouter>
    </DesktopClientProvider>,
  );
}

describe('the page frame', () => {
  const html = at('/players');

  it('is a Page with a Toolbar carrying the §7 title', () => {
    expect(html).toContain('data-page=');
    expect(html).toContain('data-page-toolbar');
    expect(html).toContain('玩家目录');
  });

  it('keeps the search box out of the overflow slot', () => {
    // `actions` MAY fold into 「更多」; a search field inside a menu is not one.
    expect(html).toContain('data-toolbar-primary');
    expect(html).toContain('搜索选手或别名');
  });

  it('shows the comparison panel beside the table', () => {
    expect(html).toContain('data-inspector="docked"');
    expect(html).toContain('还没有选中选手');
  });

  it('loads with a table skeleton and no fabricated percentage', () => {
    expect(html).toContain('正在读取玩家目录');
    expect(html).not.toContain('role="progressbar"');
  });
});

describe('the URL is the state', () => {
  it('carries the sort onto the header cells', () => {
    const html = at('/players?sort=adr&dir=asc');
    expect(html).toContain('aria-sort="ascending"');
  });

  it('opens on K/D descending, the artboard s own ordering', () => {
    expect(at('/players')).toContain('aria-sort="descending"');
  });
});
