/*
 * `interaction` project — 队伍.
 *
 * §7 created this view and gave it the `/lineups` takeover, and the thing that
 * makes it a *workspace* view rather than a directory is that it is scoped to
 * one match and writes into the same §4.4 address as the other eight. So the
 * assertions are: picking a player is the `player` parameter (the same one the
 * context bar's chip clears), and picking a round walks into 回合.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopClient } from '../../../data/desktopClient';
import { stubMatchMedia, type MatchMediaStub } from '../../../design/layout/collapse.testing';
import { DEMO } from '../test/fixtures';
import { renderWorkspace } from '../test/renderWorkspace';
import { ANALYSIS, DEMO_ID } from './test/matchFixture';

let media: MatchMediaStub | null = null;

afterEach(() => {
  media?.restore();
  media = null;
});

const UNFOLDED_PX = 1700;

function loaded(): Partial<DesktopClient> {
  return {
    getDemo: vi.fn(() => Promise.resolve(DEMO)),
    getAnalysis: vi.fn(() => Promise.resolve(ANALYSIS)),
  };
}

function address(): string {
  return document.querySelector('[data-address]')?.textContent ?? '';
}

async function openTeams(query = '') {
  media = stubMatchMedia(UNFOLDED_PX);
  renderWorkspace({ url: `/match/${DEMO_ID}?view=teams${query}`, client: loaded() });
  await screen.findByText('回合结束方式');
}

describe('阵营', () => {
  it('focuses a player through the address, not through local state', async () => {
    await openTeams();

    fireEvent.click(document.querySelector('[data-row-id="kael"]') as HTMLElement);
    await waitFor(() => {
      expect(address()).toContain('player=kael');
    });
    expect(address()).toContain('view=teams');
  });

  it('shows the focused player in the Inspector, with only the fields the wire has', async () => {
    await openTeams('&player=kael');

    expect(await screen.findByText('选中：Kael')).toBeTruthy();
    // Scoped to the panel: 爆头率 is also a column header in both roster tables.
    const inspector = document.querySelector('[data-inspector="docked"]');
    expect(inspector?.textContent).toContain('K / D / A');
    expect(inspector?.textContent).toContain('爆头率');
    expect(inspector?.textContent).toContain('Aurora');
    // 首杀 / 残局 are two more artboard columns `PlayerAnalysis` cannot answer.
    expect(inspector?.textContent).not.toContain('首杀');
    expect(inspector?.textContent).not.toContain('残局');
  });

  it('hands the player to the views that go deeper, keeping the focus', async () => {
    await openTeams('&player=kael');

    fireEvent.click(await screen.findByRole('button', { name: '玩家视图' }));
    await waitFor(() => {
      expect(address()).toContain('view=players');
    });
    expect(address()).toContain('player=kael');
  });

  it('focuses Team A’s first player without writing the address', async () => {
    await openTeams();

    expect(await screen.findByText('选中：Kael')).toBeTruthy();
    expect(document.querySelector('[data-row-id="kael"]')?.getAttribute('data-active')).toBe('true');
    expect(address()).not.toContain('player=');
  });

  it('keeps 加入作品 visible and enabled once a player is focused', async () => {
    await openTeams('&player=kael');

    const add = document.querySelector('[data-match-add-to-video]') as HTMLElement;
    expect(add.textContent).toBe('把这名选手加入作品');
    expect(add.hasAttribute('disabled')).toBe(false);
  });
});

describe('经济', () => {
  it('walks a round into 回合, which is the view that owns round detail', async () => {
    await openTeams();

    fireEvent.click(document.querySelector('[data-row-id="12"]') as HTMLElement);
    await waitFor(() => {
      expect(address()).toContain('view=rounds');
    });
    expect(address()).toContain('round=12');
  });

  it('prints the per-side totals and refuses to total a spend it cannot', async () => {
    await openTeams();

    const total = document.querySelector('[data-match-economy-total]');
    expect(total).not.toBeNull();
    // The fixture's last round carries no price, so both totals are 「—」.
    expect(total?.textContent).toContain('—');
    expect(total?.textContent).toContain('共 24 回合');
  });
});

describe('the three states', () => {
  it('renders a failed analysis in place, with a retry beside it', async () => {
    media = stubMatchMedia(UNFOLDED_PX);
    renderWorkspace({
      url: `/match/${DEMO_ID}?view=teams`,
      client: {
        getDemo: () => Promise.resolve(DEMO),
        getAnalysis: () => Promise.reject(new Error('分析文件读不到')),
      },
    });

    expect(await screen.findByText(/分析文件读不到/u)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '重试' }).length).toBeGreaterThan(0);
  });
});
