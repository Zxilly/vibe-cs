/*
 * `interaction` project — 玩家: the selection is the address.
 *
 * §4.4's whole claim is that picking a player is a navigation, so every
 * assertion below is either about `?player=` or about the Inspector that reads
 * it. The sort is deliberately *not* in the address: it is a way of looking at
 * one table, not a selection the rest of the workspace shares.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopClient } from '../../../data/desktopClient';
import { stubMatchMedia, type MatchMediaStub } from '../../../design/layout/collapse.testing';
import { DEMO } from '../test/fixtures';
import { renderWorkspace } from '../test/renderWorkspace';
import { ANALYSIS, BARE_ANALYSIS, DEMO_ID } from './test/rosterFixtures';
import { reasonOf } from '../../../test/reason';

let media: MatchMediaStub | null = null;

afterEach(() => {
  media?.restore();
  media = null;
});

/** Above §8's 1100 and above the context bar's own 1600, so nothing is folded. */
const UNFOLDED_PX = 1700;

function loaded(analysis = ANALYSIS): Partial<DesktopClient> {
  return {
    getDemo: vi.fn(() => Promise.resolve(DEMO)),
    getAnalysis: vi.fn(() => Promise.resolve(analysis)),
  };
}

function address(): string {
  return document.querySelector('[data-address]')?.textContent ?? '';
}

function open(query = '', analysis = ANALYSIS) {
  media = stubMatchMedia(UNFOLDED_PX);
  return renderWorkspace({
    url: `/match/${DEMO_ID}?view=players${query}`,
    client: loaded(analysis),
  });
}

describe('picking a player', () => {
  it('writes ?player= rather than keeping the selection in the view', async () => {
    open();
    const row = await waitFor(() => {
      const found = document.querySelector('[data-row-id="sable"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    fireEvent.click(row);
    await waitFor(() => {
      expect(address()).toContain('player=sable');
    });
    expect(address()).toContain('view=players');
  });

  it('fills the Inspector from the address, not from the click', async () => {
    open('&player=kael');

    expect(await screen.findByText('选中：Kael')).toBeTruthy();
    const detail = document.querySelector('[data-player-detail="kael"]');
    expect(detail).not.toBeNull();
    expect(detail?.textContent).toContain('27 / 14 / 5');
    expect(detail?.textContent).toContain('ak47');
    expect(detail?.textContent).toContain('1v3 残局');
  });

  it('marks the selected row and moves the mark when the address moves', async () => {
    const view = open('&player=kael');
    await waitFor(() => {
      expect(document.querySelector('[data-row-id="kael"]')?.getAttribute('data-active')).toBe('true');
    });

    fireEvent.click(document.querySelector('[data-row-id="rhea"]') as HTMLElement);
    await waitFor(() => {
      expect(document.querySelector('[data-row-id="rhea"]')?.getAttribute('data-active')).toBe('true');
    });
    expect(document.querySelector('[data-row-id="kael"]')?.getAttribute('data-active')).toBeNull();
    view.unmount();
  });

  it('keeps the selection visible when the analysis does not know the id', async () => {
    open('&player=STEAM_1%3A0%3A404');
    expect(await screen.findByText(/STEAM_1:0:404/u)).toBeTruthy();
    expect(screen.getByText(/这份分析里没有这名选手/u)).toBeTruthy();
  });
});

describe('sorting', () => {
  it('reorders the table without touching the address', async () => {
    open();
    const header = await screen.findByRole('button', { name: /ADR/u });
    const before = address();

    fireEvent.click(header); // ascending
    fireEvent.click(header); // descending
    await waitFor(() => {
      const ids = [...document.querySelectorAll('[data-row-id]')].map((row) =>
        row.getAttribute('data-row-id'),
      );
      expect(ids[0]).toBe('kael');
    });
    // The sort is a way of looking at one table, not a shared selection.
    expect(address()).toBe(before);
  });
});

describe('the Inspector’s actions', () => {
  it('disables 加入视频 and carries the shell’s reason', async () => {
    open('&player=kael');
    // The panel exists before the analysis lands; wait for the *loaded* one.
    await screen.findByText('选中：Kael');
    const add = document.querySelector(
      '[data-inspector="docked"] [data-match-add-to-video]',
    ) as HTMLButtonElement;
    expect(add.hasAttribute('disabled')).toBe(true);
    expect(reasonOf(add)).toContain('录制队列尚未接通');
    expect(add.textContent).toContain('把这名选手加入视频');
  });

  it('carries the focused player onto another view', async () => {
    open('&player=kael');
    fireEvent.click(await screen.findByRole('button', { name: '2D 回放' }));

    await waitFor(() => {
      expect(address()).toContain('view=replay');
    });
    expect(address()).toContain('player=kael');
  });
});

describe('an analysis with no event stream', () => {
  it('omits 首杀 rather than printing zeros, and says why in the Inspector', async () => {
    open('&player=kael', BARE_ANALYSIS);

    await waitFor(() => {
      expect(document.querySelector('[data-row-id="kael"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-match-view="players"]')?.textContent).not.toContain('首杀');
    expect(screen.getByText(/这份分析没有逐条击杀事件/u)).toBeTruthy();
  });
});
