import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { stubMatchMedia, type MatchMediaStub } from '../../../../design/layout/collapse.testing';
import { DEMO } from '../test/fixtures';
import { renderWorkspace } from '../test/renderWorkspace';
import { ANALYSIS, DEMO_ID, ROUNDS } from './test/rosterFixtures';

let media: MatchMediaStub | null = null;
afterEach(() => {
  media?.restore();
  media = null;
});

it.each(['overview', 'duels', 'players'] as const)(
  '%s keeps an unattributed first kill unavailable instead of promoting the next kill',
  async (view) => {
    media = stubMatchMedia(1700);
    renderWorkspace({
      url: `/match/${DEMO_ID}?view=${view}`,
      client: {
        getDemo: vi.fn(() => Promise.resolve(DEMO)),
        getAnalysis: vi.fn(() => Promise.resolve({ ...ANALYSIS, rounds: [ROUNDS[0]!] })),
      },
    });
    if (view === 'overview') {
      await screen.findByText('本场结果');
      const metric = document.querySelector('[data-match-metric="opening-kills"]');
      expect(metric?.textContent).toContain('1 条未归属');
      expect(metric?.textContent).toContain('—');
    } else if (view === 'duels') {
      fireEvent.click(await screen.findByRole('radio', { name: '首杀对决' }));
      expect(await screen.findByText('没有可归属的首杀')).toBeTruthy();
      expect(screen.getByText('首杀事件缺少选手信息，无法显示对位。')).toBeTruthy();
      expect(document.querySelector('[data-row-id="1"]')).toBeNull();
    } else {
      const row = await waitFor(() => {
        const found = document.querySelector<HTMLElement>('[data-row-id="kael"]');
        expect(found).not.toBeNull();
        return found!;
      });
      expect(within(row).getByText('— / —')).toBeTruthy();
      expect(screen.getByText(/1 个回合的首杀无法核实/u)).toBeTruthy();
    }
  },
);
