/*
 * `markup` project — 「比较」.
 *
 * The two things worth pinning are both about honesty: a statistic the demos do
 * not carry is drawn as the artboard's dashed 「数据不可用」 rail rather than as a
 * zero bar, and every bar's value is also written out in figures so the picture
 * is never the only channel.
 */

import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
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
      />,
    );
    expect(html).toContain('data-focused-player="STEAM_KAEL"');
    expect(html).toContain('尚未加入比较');
    expect(html).toContain('1.42');
  });
});

describe('with one selected', () => {
  const html = render(<PlayerComparePanel players={[kael]} limit={2} onClear={() => undefined} />);

  it('states the cap in words, as the selection bar does', () => {
    expect(html).toContain('再勾一名选手才能比较');
    expect(html).toContain('最多 2 名');
  });

  it('still offers the one thing that works with one player', () => {
    expect(html).toContain('href="/players/STEAM_KAEL"');
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

  it('draws 段位分布 as the artboard s dashed unavailable rail', () => {
    expect(html).toContain('data-compare-metric="rank"');
    expect(html).toContain('数据不可用');
    expect(html).toContain('border-dashed');
  });

  it('says which artboard columns the service does not send', () => {
    expect(html).toContain('首杀、残局胜率与常用地图');
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
