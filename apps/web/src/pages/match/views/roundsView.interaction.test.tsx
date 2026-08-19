/*
 * `interaction` project — 回合, where the selection lives.
 *
 * 概览 jumps out of itself; 回合 keeps the round and refines it, so what is
 * tested here is that the selection is the address at every step — including the
 * invariant `workspaceContext.ts` enforces on behalf of all nine views, that
 * moving to a different round throws away a playhead from the old one.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopClient } from '../../../data/desktopClient';
import { stubMatchMedia, type MatchMediaStub } from '../../../design/layout/collapse.testing';
import { REGULATION_ROUNDS } from '../../../domain/densityFixtures';
import { DEMO } from '../test/fixtures';
import { renderWorkspace } from '../test/renderWorkspace';
import { ANALYSIS, DEMO_ID } from './test/matchFixture';
import { reasonOf } from '../../../test/reason';

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
    getRoundReviewMetadata: vi.fn((demoId: string, round: number) =>
      Promise.resolve({
        demo_id: demoId,
        source_sha256: 'sha',
        round,
        comment: '第 2 杀的穿墙点可作为教学素材。',
        tags: [
          {
            id: 'tag-teach',
            name: '教学素材',
            color: '',
            created_at: '2026-08-14T00:00:00.000Z',
            updated_at: '2026-08-14T00:00:00.000Z',
          },
        ],
        updated_at: '2026-08-14T00:00:00.000Z',
      }),
    ),
  };
}

function address(): string {
  return document.querySelector('[data-address]')?.textContent ?? '';
}

async function openRounds(query = '') {
  media = stubMatchMedia(UNFOLDED_PX);
  renderWorkspace({ url: `/match/${DEMO_ID}?view=rounds${query}`, client: loaded() });
  await screen.findByText('回合时间线');
}

describe('nothing selected', () => {
  it('asks rather than picking a round behind the address’s back', async () => {
    await openRounds();

    expect(await screen.findByText('先选一个回合')).toBeTruthy();
    expect(address()).not.toContain('round=');
  });

  it('opens the first round when the recovery action is taken', async () => {
    await openRounds();

    fireEvent.click(await screen.findByRole('button', { name: '打开第 1 回合' }));
    await waitFor(() => {
      expect(address()).toContain('round=1');
    });
    // A refinement, not a jump: the view does not change.
    expect(address()).toContain('view=rounds');
  });
});

describe('walking the rounds', () => {
  it('writes the picked round without leaving the view', async () => {
    await openRounds();

    fireEvent.click(document.querySelector('[data-round-cell="4"]') as HTMLElement);
    await waitFor(() => {
      expect(address()).toContain('round=4');
    });
    expect(address()).toContain('view=rounds');
    expect(await screen.findByText('第 4 回合')).toBeTruthy();
  });

  it('steps to the neighbour in the round *list*', async () => {
    await openRounds('&round=4');

    fireEvent.click(document.querySelector('[data-match-round-next]') as HTMLElement);
    await waitFor(() => {
      expect(address()).toContain('round=5');
    });
  });

  it('disables the step that would leave the match, with the reason attached', async () => {
    await openRounds('&round=1');

    const previous = document.querySelector('[data-match-round-previous]') as HTMLElement;
    expect(previous.hasAttribute('disabled')).toBe(true);
    expect(reasonOf(previous)).toContain('已经是第一个回合');
  });
});

describe('定位 writes the playhead', () => {
  it('puts the tick in the address so the moment is shareable', async () => {
    await openRounds('&round=4');

    const locate = document.querySelector('[data-match-locate]') as HTMLElement;
    const tick = locate.getAttribute('data-match-locate');
    fireEvent.click(locate);
    await waitFor(() => {
      expect(address()).toContain(`tick=${String(tick)}`);
    });
  });

  it('drops a playhead from the round that is no longer selected', async () => {
    await openRounds('&round=4');

    const locate = document.querySelector('[data-match-locate]') as HTMLElement;
    fireEvent.click(locate);
    await waitFor(() => {
      expect(address()).toContain('tick=');
    });

    fireEvent.click(document.querySelector('[data-round-cell="9"]') as HTMLElement);
    await waitFor(() => {
      expect(address()).toContain('round=9');
    });
    // The invariant lives in `workspaceContext.ts`; this is the view honouring it.
    expect(address()).not.toContain('tick=');
  });
});

describe('§8 at the fold, with the density §10.3 measured', () => {
  /* 1100 × 700 is the artboard's own size and §8's single shell breakpoint.
     The fixture is `domain/densityFixtures.ts`'s numbers — `REGULATION_ROUNDS`
     rounds, `MATCH_ROSTER_SIZE` players — so this is the real volume, not an
     artboard sample of three. */
  it('folds the rail and the Inspector together and keeps the main action out', async () => {
    media = stubMatchMedia(1100);
    renderWorkspace({ url: `/match/${DEMO_ID}?view=rounds&round=4`, client: loaded() });
    await screen.findByText('回合时间线');

    expect(document.querySelector('[data-subnav="tabs"]')).not.toBeNull();
    const strip = document.querySelector('[data-inspector="summary"]');
    expect(strip).not.toBeNull();
    // §8's non-negotiable line, restated by this view's own panel.
    expect(strip?.querySelector('[data-match-add-to-video]')).not.toBeNull();
  });

  it('packs 24 cells into rows rather than overflowing the strip', async () => {
    media = stubMatchMedia(1100);
    renderWorkspace({ url: `/match/${DEMO_ID}?view=rounds`, client: loaded() });
    await screen.findByText('回合时间线');

    const strip = document.querySelector('[data-round-timeline-state="ready"]');
    expect(strip?.querySelectorAll('[data-round-cell]')).toHaveLength(REGULATION_ROUNDS);
    // `planRoundStrip` owns the packing; what matters here is that it ran.
    expect(Number(strip?.getAttribute('data-round-strip-rows'))).toBeGreaterThanOrEqual(1);
  });

  it('keeps the event table’s scroll inside the table', async () => {
    media = stubMatchMedia(1100);
    renderWorkspace({ url: `/match/${DEMO_ID}?view=rounds&round=4`, client: loaded() });
    await screen.findByText('回合内事件');

    const panel = document.querySelector('[data-match-panel="round-events"]');
    expect(panel?.querySelector('.overflow-auto')).not.toBeNull();
  });
});

describe('the Inspector is the same round', () => {
  it('names the selection and lists the round’s evidence', async () => {
    await openRounds('&round=4');

    expect(await screen.findByText('选中：第 4 回合')).toBeTruthy();
    expect(document.querySelector('[data-match-round-evidence]')).not.toBeNull();
    expect(document.querySelector('[data-inspector="docked"]')).not.toBeNull();
  });

  it('shows the round note once it lands, and the tags with it', async () => {
    await openRounds('&round=4');

    expect(await screen.findByText('第 2 杀的穿墙点可作为教学素材。')).toBeTruthy();
    expect(screen.getByText('教学素材')).toBeTruthy();
  });

  it('says nothing is selected rather than inventing a round', async () => {
    await openRounds();

    /* 「未选中任何回合」 is the panel's `summary`, which `design/layout/Inspector`
       only draws on the folded strip; docked, the body carries the sentence. */
    expect(
      await screen.findByText('在回合时间线里点一格，这一回合的证据与注释会出现在这里。'),
    ).toBeTruthy();
  });

  it('keeps 加入作品 visible and enabled for the selected round', async () => {
    await openRounds('&round=4');

    const add = document.querySelector('[data-match-add-to-video]') as HTMLElement;
    expect(add.textContent).toBe('把这个回合加入作品');
    expect(add.hasAttribute('disabled')).toBe(false);
  });

  it('hands the round to 2D 回放 with the playhead at its start', async () => {
    await openRounds('&round=4');

    fireEvent.click(await screen.findByRole('button', { name: '2D 回放' }));
    await waitFor(() => {
      expect(address()).toContain('view=replay');
    });
    expect(address()).toContain('round=4');
    expect(address()).toContain('tick=31000');
  });
});
