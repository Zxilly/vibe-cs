/*
 * `interaction` project — 对位.
 *
 * Two things are pinned here that no markup test can see: a matrix cell is a
 * *pair* selection whose row half lands in the address, and 定位 leaves for the
 * replay view carrying the round and the tick — which is the only reason the
 * opening-duel table is worth having.
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
    url: `/match/${DEMO_ID}?view=duels${query}`,
    client: {
      getDemo: vi.fn(() => Promise.resolve(DEMO)),
      getAnalysis: vi.fn(() => Promise.resolve(analysis)),
    } satisfies Partial<DesktopClient> as Partial<DesktopClient>,
  });
}

function address(): string {
  return document.querySelector('[data-address]')?.textContent ?? '';
}

async function cell(killer: string, victim: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const found = document.querySelector(`[data-duel-cell="${killer}>${victim}"]`);
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
}

describe('the matrix is a pair selector', () => {
  it('writes the row player into the address when a cell is picked', async () => {
    open();
    fireEvent.click(await cell('Kael', 'Sable'));

    await waitFor(() => {
      expect(address()).toContain('player=kael');
    });
    expect(address()).toContain('view=duels');
  });

  it('opens that pair’s exchanges under the grid', async () => {
    open();
    fireEvent.click(await cell('Kael', 'Sable'));

    const pair = await waitFor(() => {
      const found = document.querySelector('[data-duel-pair]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(pair.textContent).toContain('Kael');
    expect(pair.textContent).toContain('Sable');
    // Both of Kael's kills on Sable, and nothing from the other pairs.
    expect(pair.querySelectorAll('li')).toHaveLength(2);
  });

  it('shows the whole matchup list when only the row is picked', async () => {
    open();
    const row = await waitFor(() => {
      const found = document.querySelector('[data-row-id="kael"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    fireEvent.click(row);

    await waitFor(() => {
      expect(document.querySelectorAll('[data-duel-opponent]')).toHaveLength(2);
    });
    expect(address()).toContain('player=kael');
    expect(document.querySelector('[data-duel-pair]')).toBeNull();
  });

  it('drops the opponent when the row player changes', async () => {
    open();
    fireEvent.click(await cell('Kael', 'Sable'));
    await waitFor(() => {
      expect(document.querySelector('[data-duel-pair]')).not.toBeNull();
    });

    fireEvent.click(document.querySelector('[data-row-id="rhea"]') as HTMLElement);
    await waitFor(() => {
      expect(address()).toContain('player=rhea');
    });
    expect(document.querySelector('[data-duel-pair]')).toBeNull();
  });

  it('follows the focused player’s side, so the row axis is their half', async () => {
    open('&player=sable');
    await waitFor(() => {
      expect(document.querySelector('[data-row-id="sable"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-row-id="kael"]')).toBeNull();
  });
});

describe('the Inspector follows the same address', () => {
  it('sums only the measured matchup fields', async () => {
    open('&player=kael');
    expect(await screen.findByText('选中：Kael')).toBeTruthy();
    const summary = document.querySelector('[data-duel-summary="kael"]');
    expect(summary).not.toBeNull();
    expect(summary?.textContent).toContain('对位击杀');
  });

  it('says nothing is selected before a cell is picked', async () => {
    open();
    await waitFor(() => {
      expect(document.querySelector('[data-row-id="kael"]')).not.toBeNull();
    });
    expect(screen.getByText(/点矩阵里的一个单元格或一行/u)).toBeTruthy();
  });
});

describe('首杀对决', () => {
  it('swaps the whole board and lists one row per round', async () => {
    open();
    fireEvent.click(await screen.findByRole('radio', { name: '首杀对决' }));

    await waitFor(() => {
      expect(document.querySelector('[data-row-id="1"]')).not.toBeNull();
    });
    expect(document.querySelectorAll('[data-row-id]')).toHaveLength(3);
    expect(document.querySelector('[data-duel-cell]')).toBeNull();
  });

  it('selects the round and the tick from a row, without leaving the view', async () => {
    open();
    fireEvent.click(await screen.findByRole('radio', { name: '首杀对决' }));
    const row = await waitFor(() => {
      const found = document.querySelector('[data-row-id="1"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    fireEvent.click(row);
    await waitFor(() => {
      expect(address()).toContain('round=1');
    });
    expect(address()).toContain('tick=10100');
    expect(address()).toContain('view=duels');
  });

  it('定位 leaves for the replay view carrying the round and the tick', async () => {
    open();
    fireEvent.click(await screen.findByRole('radio', { name: '首杀对决' }));
    const locate = await screen.findAllByRole('button', { name: '定位' });

    fireEvent.click(locate[0] as HTMLElement);
    await waitFor(() => {
      expect(address()).toContain('view=replay');
    });
    const at = address();
    expect(at).toContain('round=1');
    expect(at).toContain('tick=10100');
  });
});

describe('an analysis with no matchups', () => {
  it('states the service’s reason instead of drawing a grid of zeros', async () => {
    open('', BARE_ANALYSIS);

    expect(await screen.findByText('没有可用的对位数据')).toBeTruthy();
    expect(screen.getByText(/no identified attacker-target combat pairs/u)).toBeTruthy();
    expect(document.querySelector('[data-duel-cell]')).toBeNull();
  });

  it('offers the other segment as the recovery, and it says why it is empty too', async () => {
    open('', BARE_ANALYSIS);
    fireEvent.click(await screen.findByRole('button', { name: '改看首杀对决' }));

    expect(await screen.findByText('没有可归属的首杀')).toBeTruthy();
    expect(screen.getByText(/这份分析没有逐条击杀事件/u)).toBeTruthy();
  });
});
