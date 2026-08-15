/*
 * `interaction` project — 概览 is a set of doors.
 *
 * The brief for this view is that every block leads into the view that owns it,
 * and §4.4 says a lead is a *navigation*: 「URL 是唯一真值」. So every assertion
 * here reads the address bar after a click rather than reading component state —
 * if the address did not move, the back button and a copied link did not either.
 *
 * The whole shell is mounted (not the panels), because the thing under test is
 * the seam between the view and `updateContext`.
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

/** Wide enough that neither the rail nor the Inspector nor the bar has folded. */
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

async function openOverview(url = `/match/${DEMO_ID}?view=overview`) {
  media = stubMatchMedia(UNFOLDED_PX);
  renderWorkspace({ url, client: loaded() });
  await screen.findByText('本场结果');
}

describe('the round strip is the door to 回合', () => {
  it('opens the picked round in the view that owns round detail', async () => {
    await openOverview();

    fireEvent.click(document.querySelector('[data-round-cell="21"]') as HTMLElement);
    await waitFor(() => {
      expect(address()).toContain('view=rounds');
    });
    expect(address()).toContain('round=21');
  });

  it('shows the round the address arrived with as selected', async () => {
    await openOverview(`/match/${DEMO_ID}?view=overview&round=7`);

    expect(document.querySelector('[data-match-view-context]')?.textContent).toContain('R7');
    expect(
      document.querySelector('[data-round-cell="7"]')?.getAttribute('aria-current'),
    ).toBe('true');
  });
});

describe('关键时刻 is the door to 高光', () => {
  it('walks a single moment into 高光 with its round selected', async () => {
    await openOverview();

    // `h-0` is the highest-confidence candidate in the fixture, on round 24.
    fireEvent.click(document.querySelector('[data-match-open-highlight="h-0"]') as HTMLElement);
    await waitFor(() => {
      expect(address()).toContain('view=highlights');
    });
    expect(address()).toContain('round=24');
  });

  it('walks the whole list into 高光 without inventing a selection', async () => {
    await openOverview();

    fireEvent.click(screen.getByRole('button', { name: '查看全部 18 条' }));
    await waitFor(() => {
      expect(address()).toContain('view=highlights');
    });
    expect(address()).not.toContain('round=');
  });
});

describe('加入视频', () => {
  it('is disabled on every row and says why, rather than being hidden', async () => {
    await openOverview();

    const buttons = screen.getAllByRole('button', { name: '加入视频' });
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.hasAttribute('disabled')).toBe(true);
      expect(button.getAttribute('title')).toBe('录制队列尚未接通');
    }
  });
});

describe('the three states', () => {
  it('renders the failure in place with a way to retry', async () => {
    media = stubMatchMedia(UNFOLDED_PX);
    renderWorkspace({
      url: `/match/${DEMO_ID}?view=overview`,
      client: {
        getDemo: () => Promise.resolve(DEMO),
        getAnalysis: () => Promise.reject(new Error('分析文件读不到')),
      },
    });

    expect(await screen.findByText(/分析文件读不到/u)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '重试' }).length).toBeGreaterThan(0);
  });

  it('treats a 404 as 「还没分析」 and offers the action that fixes it', async () => {
    media = stubMatchMedia(UNFOLDED_PX);
    renderWorkspace({
      url: `/match/${DEMO_ID}?view=overview`,
      client: {
        getDemo: () => Promise.resolve(DEMO),
        getAnalysis: () => Promise.reject(Object.assign(new Error('not found'), { status: 404 })),
      },
    });

    expect(await screen.findByRole('button', { name: /开始分析/u })).toBeTruthy();
    // 「不隐藏、不静默失败」: the service is down under vitest, so the action is
    // present and disabled with the reason attached.
    expect(screen.getByRole('button', { name: /开始分析/u }).hasAttribute('disabled')).toBe(true);
  });
});
