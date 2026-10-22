/*
 * `markup` project — 「比较」.
 *
 * Available metrics retain explicit figures and a shared comparison scale.
 * Unsupported statistics do not occupy a permanent empty row.
 */

import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../../test/render';
import { PlayerComparePanel } from './PlayerComparePanel';
import { directoryItem } from './test/fixtures';

function render(node: Parameters<typeof renderMarkup>[0]): string {
  return renderMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

const kael = directoryItem();
const sable = directoryItem({
  steam_id: 'STEAM_SABLE',
  name: 'Sable',
  last_team: 'Meridian',
  stats: {
    matches: 58,
    kills: 1180,
    deaths: 922,
    assists: 200,
    headshots: 578,
    damage: 80_000,
    average_adr: 84.3,
    average_kill_death_ratio: 1.28,
  },
});

describe('with nothing selected', () => {
  it('says what ticking a box will do', () => {
    const html = render(<PlayerComparePanel players={[]} limit={2} onClear={() => undefined} />);
    expect(html).toContain('还没有选中选手');
    expect(html).toContain('最多 2 名');
  });
});

describe('with a focused row but nothing selected', () => {
  it('shows real context without pretending the player is selected', () => {
    const html = render(
      <PlayerComparePanel
        players={[]}
        focusedPlayer={kael}
        limit={2}
        onClear={() => undefined}
        onComparePlayer={() => undefined}
      />,
    );
    expect(html).toContain('data-focused-player="STEAM_KAEL"');
    expect(html).toContain('加入比较');
    expect(html).not.toContain('data-compare-card=');
    expect(html).toContain('1.42');
  });
});

describe('with one selected', () => {
  const html = render(<PlayerComparePanel players={[kael]} limit={2} onClear={() => undefined} />);

  it('gives one concise next step', () => {
    expect(html).toContain('再选择一名选手进行比较');
  });

  it('still offers the one thing that works with one player', () => {
    expect(html).toContain('href="/players/STEAM_KAEL"');
  });

  it('keeps the action short while exposing a long candidate name accessibly', () => {
    const name = 'A-player-name-that-would-overflow-the-inspector-footer';
    const html = render(<PlayerComparePanel
      players={[kael]}
      focusedPlayer={directoryItem({ steam_id: 'STEAM_CANDIDATE', name })}
      limit={2}
      onComparePlayer={() => undefined}
    />);
    expect(html).toContain(`aria-label="与 ${name} 比较"`);
    expect(html).toContain(`title="${name}"`);
    expect(html).toContain('>加入比较</button>');
  });
});

describe('with two selected', () => {
  const html = render(
    <PlayerComparePanel players={[kael, sable]} limit={2} onClear={() => undefined} />,
  );

  it('names both, in the order they were ticked', () => {
    expect(html).toContain('data-compare-card="STEAM_KAEL"');
    expect(html).toContain('data-compare-card="STEAM_SABLE"');
    expect(html.indexOf('STEAM_KAEL')).toBeLessThan(html.indexOf('STEAM_SABLE'));
  });

  it('writes both numbers above every bar pair', () => {
    // The bar is redundant with the figures, never a substitute for them.
    expect(html).toContain('1.42 · 1.28');
    expect(html).toContain('89.7 · 84.3');
    expect(html).toContain('57% · 49%');
  });

  it('scales the bars against each other, not against an invented ceiling', () => {
    // Kael leads K/D, so his bar is the full 100% and Sable s is 1.28/1.42.
    expect(html).toContain('width:100%');
    expect(html).toContain('width:90%');
  });

  it('only presents statistics that can be compared', () => {
    expect(html).not.toContain('data-compare-metric="rank"');
    expect(html).not.toContain('数据不可用');
  });
});

describe('a player with no measured statistic', () => {
  it('prints the dash and draws no bar at all', () => {
    const unmeasured = directoryItem({
      steam_id: 'STEAM_NEW',
      name: 'New',
      stats: {
        matches: 1,
        kills: 0,
        deaths: 0,
        assists: 0,
        headshots: 0,
        damage: 0,
        average_adr: null,
        average_kill_death_ratio: null,
      },
    });
    const html = render(
      <PlayerComparePanel players={[unmeasured, kael]} limit={2} onClear={() => undefined} />,
    );
    expect(html).toContain('— · 1.42');
    expect(html).toContain('width:0%');
  });
});
