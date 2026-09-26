/*
 * `interaction` project — the profile header once the reads have landed.
 *
 * Two facts about the `Toolbar` that only a resolved profile can show: the
 * meta line never prints a label with nothing after it, and the page's action
 * is a working link into the latest match workspace rather than a primary
 * button that can never be pressed.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { DesktopClientProvider, type DesktopClient } from '../../../data/desktopClient';
import { renderInteractive } from '../../../test/render';
import { PlayerProfilePage } from './PlayerProfilePage';
import { directoryItem, playerHeatmap, playerMapItem, playerMatches } from './test/fixtures';

const coverage = { projected_demos: 3, total_analyses: 3, projection_complete: true };

function stubClient(lastMatchDate: string | null, matchCount = 3): Partial<DesktopClient> {
  const items = playerMatches(matchCount);
  return {
    getPlayer: () =>
      Promise.resolve({ player: directoryItem({ last_match_date: lastMatchDate }), coverage }),
    listPlayerMatches: () =>
      Promise.resolve({ steam_id: 'STEAM_KAEL', items, total: items.length, page: 1, page_size: 20, coverage }),
    listPlayerMaps: () =>
      Promise.resolve({ steam_id: 'STEAM_KAEL', items: [playerMapItem()], total: 1, page: 1, page_size: 20, coverage }),
    getPlayerHeatmap: () => Promise.resolve(playerHeatmap()),
  };
}

function mount(client: Partial<DesktopClient>) {
  return renderInteractive(
    <DesktopClientProvider client={client as DesktopClient}>
      <MemoryRouter initialEntries={['/players/STEAM_KAEL']}>
        <Routes>
          <Route path="/players/:playerId" element={<PlayerProfilePage />} />
        </Routes>
      </MemoryRouter>
    </DesktopClientProvider>,
  );
}

async function meta(): Promise<string> {
  const node = await screen.findByText(/别名 3 个/u);
  return node.closest('[data-toolbar-meta]')?.textContent ?? node.textContent ?? '';
}

describe('the header meta line', () => {
  it('prints 最近出场 with its date when the demo carries one', async () => {
    mount(stubClient('2026-08-14T20:11:00Z'));
    expect(await meta()).toContain('最近出场 08-14');
  });

  it('leaves 最近出场 out entirely when there is no date — never a dangling label', async () => {
    mount(stubClient(null));
    const text = await meta();
    expect(text).toContain('Aurora · 64 场 · 别名 3 个');
    expect(text).not.toContain('最近出场');
    expect(text.trimEnd()).not.toMatch(/·$/u);
  });
});

describe('the page action', () => {
  it('is a link into the latest match workspace, not a primary button that can never be pressed', async () => {
    mount(stubClient('2026-08-14T20:11:00Z'));
    const link = await screen.findByRole('link', { name: '去比赛工作区做集锦' });
    // `playerMatches` is newest first, so index 0 is the latest.
    expect(link.getAttribute('href')).toBe('/match/demo-0');
    expect(screen.queryByText('做一条集锦')).toBeNull();
    expect(screen.queryByRole('button', { name: '做一条集锦' })).toBeNull();
  });

  it('offers nothing when the player has no analysed match to open', async () => {
    mount(stubClient(null, 0));
    await screen.findByText('还没有比赛');
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: '去比赛工作区做集锦' })).toBeNull();
    });
  });
});

describe('independent profile reads', () => {
  it('keeps pending matches out of the empty and measured trend states', async () => {
    const client = { ...stubClient(null), listPlayerMatches: () => new Promise<never>(() => undefined) };
    mount(client);
    await meta();
    expect(screen.getByText('正在读取比赛趋势')).toBeTruthy();
    expect(screen.getByText('正在读取最近比赛')).toBeTruthy();
    expect(screen.queryByText('还没有比赛')).toBeNull();
    expect(screen.queryByText('还没有可画的趋势')).toBeNull();
    expect(screen.queryByText(/最近 20 场里有 0 场/u)).toBeNull();
  });

  it('reports a failed map read and retries it without losing the profile', async () => {
    const client = stubClient(null);
    const listPlayerMaps = vi.fn().mockRejectedValueOnce(new Error('map statistics unavailable')).mockImplementation(client.listPlayerMaps!);
    mount({ ...client, listPlayerMaps });
    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain('地图统计没能读出来');
    expect(screen.queryByText('还没有按地图的数据')).toBeNull();
    fireEvent.click(within(error).getByRole('button', { name: '重试' }));
    await screen.findByRole('table', { name: '按地图的成绩' });
    expect(listPlayerMaps).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { name: 'Kael' })).toBeTruthy();
  });
});
