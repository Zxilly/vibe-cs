/*
 * `markup` project — the /players/:playerId frame.
 *
 * The route parameter is the page's contract with the address bar (§7) and it
 * has to be visible even before the profile loads: 「资料库 › 玩家档案」 is the
 * crumb, and the id is the only thing the route itself knows.
 */

import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { DesktopClientProvider, type DesktopClient } from '../../data/desktopClient';
import { renderMarkup } from '../../test/render';
import { PlayerProfilePage } from '../PlayerProfilePage';

const pending: Partial<DesktopClient> = {
  getPlayer: () => new Promise(() => undefined),
  listPlayerMatches: () => new Promise(() => undefined),
  listPlayerMaps: () => new Promise(() => undefined),
  getPlayerHeatmap: () => new Promise(() => undefined),
};

function at(url: string): string {
  return renderMarkup(
    <DesktopClientProvider client={pending as DesktopClient}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/players/:playerId" element={<PlayerProfilePage />} />
        </Routes>
      </MemoryRouter>
    </DesktopClientProvider>,
  );
}

describe('the page frame', () => {
  const html = at('/players/kael');

  it('is a Page with a Toolbar', () => {
    expect(html).toContain('data-page=');
    expect(html).toContain('data-page-toolbar');
    expect(html).toContain('玩家档案');
  });

  it('shows the id it was given, which is all the route knows yet', () => {
    expect(html).toContain('kael');
  });

  // The title bar's crumb says where you *are*; this is the way back, and the
  // two are not the same affordance.
  it('leaves parent navigation to the shell breadcrumb', () => {
    expect(html).not.toContain('‹ 玩家目录');
    expect(html).not.toContain('href="/players"');
  });

  it('lays out the trend column and the map column', () => {
    expect(html).toContain('data-player-trend');
    expect(html).toContain('data-player-maps');
    expect(html).toContain('data-player-recent');
  });

  it('keeps the artboard s honest note about a statistic the demos lack', () => {
    expect(html).toContain('段位历史不可用');
  });

  it('takes the scroll boundary over — each column scrolls on its own', () => {
    expect(html).not.toMatch(/data-page-body="true" class="[^"]*overflow-auto/u);
  });
});

describe('the §7 query parameters', () => {
  it('selects the trend metric', () => {
    expect(at('/players/kael?metric=adr')).toContain('data-player-trend="adr"');
    expect(at('/players/kael')).toContain('data-player-trend="kd"');
    expect(at('/players/kael?metric=nonsense')).toContain('data-player-trend="kd"');
  });

  it('selects the heat-map subject and the map', () => {
    expect(at('/players/kael?map=de_nuke')).toContain('data-player-heatmap="de_nuke"');
  });
});
