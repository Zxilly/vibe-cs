import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { PlayerDirectoryItem } from '../../shared/desktop/dto';
import {
  PlayerCompareInspector,
  PlayerComparisonSelectionBar,
  PlayerDirectoryScope,
  PlayerPowerTable,
} from './PlayerComparisonViews';

function player(overrides: Partial<PlayerDirectoryItem> = {}): PlayerDirectoryItem {
  return {
    steam_id: '76561198000000001',
    name: 'm0NESY',
    aliases: [],
    last_team: 'G2',
    last_match_at: '2026-08-10T08:00:00Z',
    stats: {
      matches: 12,
      kills: 245,
      deaths: 170,
      assists: 62,
      headshots: 98,
      damage: 22_450,
      average_adr: 88.4,
      average_kill_death_ratio: 1.42,
    },
    steam: {
      state: 'available',
      persona_name: 'm0NESY',
      real_name: null,
      profile_url: null,
      country_code: null,
      persona_state: null,
      last_logoff: null,
      created_at: null,
      avatar_url: '/api/players/76561198000000001/avatar',
      reason: null,
    },
    ...overrides,
  };
}

describe('player power-table', () => {
  it('shows dense multi-match evidence and real compare/detail actions without invented metrics', () => {
    const markup = renderToStaticMarkup(
      <PlayerPowerTable
        players={[
          player(),
          player({
            steam_id: '76561198000000002',
            name: 'NiKo',
            last_team: null,
            stats: {
              ...player().stats,
              matches: 10,
              average_adr: null,
            },
          }),
        ]}
        comparedIds={new Set(['76561198000000001'])}
        sort={{ key: 'adr', direction: 'desc' }}
        onSort={vi.fn()}
        onToggleCompare={vi.fn()}
        onInspect={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="玩家多比赛统计表"');
    expect(markup).toContain('aria-sort="descending"');
    expect(markup).toContain('m0NESY');
    expect(markup).toContain('245');
    expect(markup).toContain('1.44');
    expect(markup).toContain('40.0%');
    expect(markup).toContain('22,450');
    expect(markup).toContain('—');
    expect(markup).toContain('加入对比');
    expect(markup).toContain('查看详情');
    expect(markup).not.toMatch(/Rating|KAST|accuracy/i);
  });

  it('exposes each factual data column as a current-page sort control', () => {
    const markup = renderToStaticMarkup(
      <PlayerPowerTable
        players={[player()]}
        comparedIds={new Set()}
        sort={{ key: 'lastMatch', direction: 'desc' }}
        onSort={vi.fn()}
        onToggleCompare={vi.fn()}
        onInspect={vi.fn()}
      />,
    );

    expect(markup.match(/aria-sort=/g)).toHaveLength(12);
    expect(markup).toContain('aria-sort="descending"');
    expect(markup).toMatch(/<button[^>]*>玩家/);
    expect(markup).toMatch(/<button[^>]*>最近比赛/);
    expect(markup).toMatch(/<button[^>]*>Steam 证据/);
  });
});

describe('two-player comparison inspector', () => {
  it('compares only evidenced aggregates across the scanned Demo scope', () => {
    const markup = renderToStaticMarkup(
      <PlayerCompareInspector
        players={[
          player(),
          player({
            steam_id: '76561198000000002',
            name: 'NiKo',
            stats: {
              ...player().stats,
              matches: 9,
              kills: 180,
              deaths: 150,
              average_adr: null,
              average_kill_death_ratio: null,
            },
          }),
        ]}
        scannedDemos={87}
        scanComplete
        onFocus={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="玩家对比检查器"');
    expect(markup).toContain('m0NESY');
    expect(markup).toContain('NiKo');
    expect(markup).toContain('逐场平均 K/D');
    expect(markup).toContain('1.42');
    expect(markup).toContain('—');
    expect(markup).toContain('87 个已扫描 Demo');
    expect(markup).toContain('查看单人详情');
    expect(markup).toContain('清空对比');
    expect(markup).not.toMatch(/Rating|KAST|accuracy/i);
  });
});

describe('player directory data scope', () => {
  it('separates server pagination/search from current-page column sorting', () => {
    const markup = renderToStaticMarkup(
      <PlayerDirectoryScope page={2} pages={4} visible={24} total={82} />,
    );

    expect(markup).toContain('第 2 / 4 页');
    expect(markup).toContain('当前页 24 / 82 名玩家');
    expect(markup).toContain('搜索由服务端处理');
    expect(markup).toContain('列排序与对比仅作用于当前页');
  });
});

describe('compact comparison selection', () => {
  it('keeps the first selection visible while leaving the table available for a second player', () => {
    const markup = renderToStaticMarkup(
      <PlayerComparisonSelectionBar count={1} onOpen={vi.fn()} onClear={vi.fn()} />,
    );

    expect(markup).toContain('已选择 1 / 2 名玩家');
    expect(markup).toContain('打开检查器');
    expect(markup).toContain('清空对比');
  });
});
