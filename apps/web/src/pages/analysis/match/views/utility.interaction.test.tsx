import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AnalysisWorkspace } from '../../../../shared/desktop/viewModels';
import type { DesktopClient } from '../../../../data/desktopClient';
import { stubMatchMedia, type MatchMediaStub } from '../../../../design/layout/collapse.testing';
import { DEMO } from '../test/fixtures';
import { renderWorkspace } from '../test/renderWorkspace';
import { ANALYSIS, BARE_ANALYSIS, DEMO_ID, INSIGHTS } from './test/rosterFixtures';

let media: MatchMediaStub | null = null;
afterEach(() => { media?.restore(); media = null; });

const equipmentAnalysis: AnalysisWorkspace = {
  ...ANALYSIS,
  insights: {
    ...INSIGHTS,
    round_economy: INSIGHTS.round_economy.map((row, index) => ({
      ...row,
      freeze_end_tick: (ANALYSIS.rounds.find((round) => round.number === row.round)?.start_tick ?? 0) + 10,
      team_equipment: [
        { team: 'A', buy_type: index === 0 ? 'full_buy' : 'force_buy', side: index === 0 ? 'T' : 'CT', equipment_value: index === 0 ? 25_000 : 7_000 },
        { team: 'B', buy_type: 'full_buy', side: index === 0 ? 'CT' : 'T', equipment_value: 20_000 },
      ],
    })),
  },
};

function open(query = '', analysis: AnalysisWorkspace = equipmentAnalysis) {
  media = stubMatchMedia(1700);
  return renderWorkspace({
    url: `/match/${DEMO_ID}?view=utility${query}`,
    client: {
      getDemo: vi.fn(() => Promise.resolve(DEMO)),
      getAnalysis: vi.fn(() => Promise.resolve(analysis)),
    } as Partial<DesktopClient>,
  });
}
const address = () => document.querySelector('[data-address]')?.textContent ?? '';

describe('utility and round economy', () => {
  it('presents utility and team equipment together without changing the initial selection', async () => {
    open();
    expect(await screen.findByRole('img', { name: '两队逐回合装备价值' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '道具' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '回合经济' })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: '经济' })).toBeNull();
    expect(address()).not.toContain('round=');
    expect(address()).not.toContain('player=');
  });

  it('selects the real round and compares its teams instead of summing their equipment', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: '第 2 回合装备' }));
    await waitFor(() => expect(address()).toContain('round=2'));
    expect(screen.getByRole('button', { name: '第 2 回合装备' }).getAttribute('aria-pressed')).toBe('true');
    const panel = screen.getByRole('region', { name: '回合经济' });
    expect(panel.textContent).toContain('$7,000 / $20,000');
    expect(panel.textContent).toContain('$13,000');
    expect(panel.textContent).toContain('购买类型强起 / 全起');
    expect(panel.textContent).not.toContain('两队合计');
  });

  it('keeps per-player breakdown available through the utility details', async () => {
    open();
    fireEvent.click(await screen.findByText('选手道具明细'));
    const row = await waitFor(() => {
      const node = document.querySelector('[data-row-id="kael"]');
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    fireEvent.click(row);
    await waitFor(() => expect(address()).toContain('player=kael'));
    const detail = document.querySelector('[data-utility-detail="kael"]');
    expect(detail?.textContent).toContain('投掷物构成');
    expect(detail?.closest('details')?.open).toBe(true);
  });

  it('clears player focus when choosing a round and preserves purchase details', async () => {
    open('&player=kael');
    fireEvent.click(await screen.findByRole('button', { name: '第 2 回合装备' }));
    await waitFor(() => expect(address()).not.toContain('player='));
    fireEvent.click(screen.getByText('购买明细'));
    expect(document.querySelector('[data-economy-detail="2"]')?.textContent).toContain('购买条数');
  });

  it('shows missing data without inventing equipment or utility zeros', async () => {
    open('', BARE_ANALYSIS);
    expect(await screen.findByText('暂无装备价值数据')).toBeTruthy();
    expect(screen.queryByRole('img', { name: '两队逐回合装备价值' })).toBeNull();
    expect(screen.getByRole('region', { name: '道具' }).textContent).not.toContain('0 次');
    expect(screen.queryByText(/点道具表的一行/)).toBeNull();
  });
});
