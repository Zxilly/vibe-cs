/*
 * `interaction` project — 道具与经济.
 *
 * The view has two selections rather than one — a player on the 道具 half and a
 * round on the 经济 half — and both are §4.4 parameters the rest of the
 * workspace already reads. What is pinned here is that each half writes its own
 * and the Inspector follows whichever the address holds.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopClient } from '../../../data/desktopClient';
import { stubMatchMedia, type MatchMediaStub } from '../../../design/layout/collapse.testing';
import { DEMO } from '../test/fixtures';
import { renderWorkspace } from '../test/renderWorkspace';
import { ANALYSIS, BARE_ANALYSIS, DEMO_ID } from './test/rosterFixtures';

let media: MatchMediaStub | null = null;

afterEach(() => {
  media?.restore();
  media = null;
});

const UNFOLDED_PX = 1700;

function open(query = '', analysis = ANALYSIS) {
  media = stubMatchMedia(UNFOLDED_PX);
  return renderWorkspace({
    url: `/match/${DEMO_ID}?view=utility${query}`,
    client: {
      getDemo: vi.fn(() => Promise.resolve(DEMO)),
      getAnalysis: vi.fn(() => Promise.resolve(analysis)),
    } as Partial<DesktopClient>,
  });
}

function address(): string {
  return document.querySelector('[data-address]')?.textContent ?? '';
}

async function row(id: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const found = document.querySelector(`[data-row-id="${id}"]`);
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
}

describe('the 道具 half', () => {
  it('writes ?player= when a row is picked', async () => {
    open();
    fireEvent.click(await row('kael'));

    await waitFor(() => {
      expect(address()).toContain('player=kael');
    });
    expect(address()).toContain('view=utility');
  });

  it('fills the Inspector with that player’s item breakdown', async () => {
    open('&player=kael');
    expect(await screen.findByText('选中：Kael')).toBeTruthy();

    const detail = document.querySelector('[data-utility-detail="kael"]');
    expect(detail).not.toBeNull();
    expect(detail?.textContent).toContain('闪光');
    expect(detail?.textContent).toContain('烟雾');
  });

  it('shows the four tiles, including the degradation one', async () => {
    open();
    const tiles = await waitFor(() => {
      const found = document.querySelector('[data-utility-tiles]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(tiles.textContent).toContain('生命周期不完整');
    // 41 throws − 34 detonations.
    expect(tiles.textContent).toContain('7');
  });
});

describe('the 经济 half', () => {
  it('swaps the board and writes ?round= when a round is picked', async () => {
    open();
    fireEvent.click(await screen.findByRole('radio', { name: '经济' }));

    fireEvent.click(await row('2'));
    await waitFor(() => {
      expect(address()).toContain('round=2');
    });
    expect(address()).toContain('view=utility');
  });

  it('fills the Inspector with that round’s purchases, by side', async () => {
    open('&round=2');
    expect(await screen.findByText('选中：第 2 回合')).toBeTruthy();

    const detail = document.querySelector('[data-economy-detail="2"]');
    expect(detail).not.toBeNull();
    expect(detail?.textContent).toContain('CT');
    expect(detail?.textContent).toContain('没有带阵营');
  });

  it('prefers the player over the round when the address carries both', async () => {
    open('&player=kael&round=2');
    expect(await screen.findByText('选中：Kael')).toBeTruthy();
    expect(document.querySelector('[data-economy-detail]')).toBeNull();
  });
});

describe('an analysis whose insights did not decode', () => {
  it('says so on the 道具 half rather than listing zeros', async () => {
    open('', BARE_ANALYSIS);

    expect(await screen.findByText('没有道具记录')).toBeTruthy();
    expect(screen.getByText(/no grenade lifecycle events were decoded/u)).toBeTruthy();
    expect(document.querySelector('[data-row-id]')).toBeNull();
  });

  it('says so on the 经济 half too, and the segment is the recovery', async () => {
    open('', BARE_ANALYSIS);
    fireEvent.click(await screen.findByRole('button', { name: '改看经济' }));

    expect(await screen.findByText('没有购买记录')).toBeTruthy();
    expect(screen.getByText(/no item_purchase events were decoded/u)).toBeTruthy();
  });

  it('leaves the Inspector saying what a selection would show', async () => {
    open('', BARE_ANALYSIS);
    expect(await screen.findByText(/点道具表的一行/u)).toBeTruthy();
  });
});
