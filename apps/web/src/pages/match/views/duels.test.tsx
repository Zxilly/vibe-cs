/*
 * `markup` project — 对位.
 *
 * The assertions that matter are the two about honesty: the matrix draws a
 * measured zero as a zero, and the view draws no engagement axis at all,
 * because `TimelineEvent` carries one position and an axis needs two.
 */

import { describe, expect, it } from 'vitest';

import { MATCH_ROSTER_SIZE, OVERTIME_ROUNDS } from '../../../domain/densityFixtures';
import { renderMarkup } from '../../../test/render';
import { markupAt } from '../test/renderWorkspace';
import {
  DuelMatrixTable,
  DuelSummary,
  MatchupList,
  OpeningDuelTable,
  PairKillList,
} from './DuelsView';
import {
  duelMatrix,
  matchupsAgainst,
  openingDuels,
  pairKills,
  rosterIndex,
} from './duelsModel';
import { ANALYSIS, BARE_ANALYSIS, densityAnalysis } from './test/rosterFixtures';

const INDEX = rosterIndex(ANALYSIS);
const MATRIX = duelMatrix(ANALYSIS, 'A');

function matrix(options: { active?: string | null; opponent?: string | null } = {}) {
  return renderMarkup(
    <DuelMatrixTable
      matrix={MATRIX}
      rowTeamName="Aurora"
      columnTeamName="Meridian"
      activePlayerId={options.active ?? null}
      activeOpponentId={options.opponent ?? null}
      onSelectPlayer={() => undefined}
      onSelectPair={() => undefined}
    />,
  );
}

describe('the first paint', () => {
  const html = markupAt('/match/aurora?view=duels');

  it('is the view the address asked for', () => {
    expect(html).toContain('data-match-view="duels"');
  });

  it('is the shared skeleton with a stage name and no fabricated percentage', () => {
    expect(html).toContain('data-match-view-state="loading"');
    expect(html).toContain('data-match-view-skeleton');
    expect(html).toContain('正在读取比赛分析');
    expect(html).not.toContain('role="progressbar"');
  });
});

describe('the matrix', () => {
  const html = matrix();

  it('names both axes in the corner cell', () => {
    expect(html).toContain('Aurora');
    expect(html).toContain('Meridian');
  });

  it('is one row per player of the row side and one column per opponent', () => {
    expect(html.match(/data-row-id="/gu)).toHaveLength(2);
    expect(html.match(/data-duel-cell="/gu)).toHaveLength(4);
  });

  it('says the whole sentence in the cell’s accessible name', () => {
    expect(html).toContain('aria-label="Kael 击杀 Sable 2 次"');
  });

  it('washes the densest cell with the accent and never with a bare colour', () => {
    expect(html).toContain('color-mix(in srgb, var(--color-accent) 34%, transparent)');
    expect(html).not.toMatch(/background-color:#/u);
  });

  it('totals the row', () => {
    expect(html).toContain('合计');
  });

  it('marks the selected pair without recolouring the wash', () => {
    const selected = matrix({ active: 'kael', opponent: 'sable' });
    expect(selected).toContain('aria-pressed="true"');
    expect(selected).toContain('data-row-id="kael" data-active="true"');
  });

  it('draws a measured zero as text, not as a control that opens nothing', () => {
    const bare = renderMarkup(
      <DuelMatrixTable
        matrix={duelMatrix(BARE_ANALYSIS, 'A')}
        rowTeamName="Aurora"
        columnTeamName="Meridian"
        activePlayerId={null}
        activeOpponentId={null}
        onSelectPlayer={() => undefined}
        onSelectPair={() => undefined}
      />,
    );
    expect(bare).not.toContain('data-duel-cell');
    expect(bare.match(/data-row-id="/gu)).toHaveLength(2);
  });
});

describe('the spatial half the artboard drew', () => {
  it('is absent — an engagement axis needs two positions and the wire sends one', () => {
    const html = matrix();
    expect(html).not.toContain('data-map-canvas');
    expect(html).not.toContain('交战轴');
  });
});

describe('the opening duels', () => {
  const duels = openingDuels(ANALYSIS.rounds);
  const html = renderMarkup(
    <OpeningDuelTable
      duels={duels}
      index={INDEX}
      tickRate={64}
      activeRound={2}
      onSelectRound={() => undefined}
      onLocate={() => undefined}
    />,
  );

  it('is one row per round that had an attributed first kill', () => {
    expect(html.match(/data-row-id="/gu)).toHaveLength(3);
  });

  it('names both ends of the exchange', () => {
    expect(html).toContain('Kael');
    expect(html).toContain('Sable');
  });

  it('prints the weapon the way the demo spells it', () => {
    expect(html).toContain('ak47');
    expect(html).toContain('awp');
  });

  it('marks 爆头 and 穿墙 with a word, not only a hue', () => {
    expect(html).toContain('爆头');
    expect(html).toContain('穿墙');
  });

  it('offers 定位 on every row and marks the round the address holds', () => {
    // The fourth occurrence is the column's visually hidden header label.
    expect(html.match(/>定位<\/button>/gu)).toHaveLength(3);
    expect(html).toContain('data-row-id="2" data-active="true"');
  });
});

describe('one pair’s exchanges', () => {
  const html = renderMarkup(
    <PairKillList
      killerName="Kael"
      victimName="Sable"
      kills={pairKills(ANALYSIS.rounds, 'kael', 'sable')}
      tickRate={64}
      onLocate={() => undefined}
    />,
  );

  it('counts the exchanges in its own head', () => {
    expect(html).toContain('data-duel-pair');
    expect(html).toContain('Kael');
    expect(html).toContain('Sable');
    expect(html).toContain('2');
  });

  it('omits 距离 and 位置 rather than printing an empty column', () => {
    expect(html).not.toContain('距离');
    expect(html).not.toContain('位置');
  });

  it('says why it is empty when there is no event stream', () => {
    const bare = renderMarkup(
      <PairKillList
        killerName="Kael"
        victimName="Sable"
        kills={[]}
        tickRate={64}
        onLocate={() => undefined}
      />,
    );
    expect(bare).toContain('这份分析没有逐条击杀事件');
  });
});

describe('one player’s opponents', () => {
  const html = renderMarkup(
    <MatchupList
      matchups={matchupsAgainst(ANALYSIS.insights, 'kael', INDEX)}
      index={INDEX}
      activeOpponentId="sable"
      onSelectOpponent={() => undefined}
    />,
  );

  it('lists the other side only — friendly fire is not a matchup', () => {
    expect(html.match(/data-duel-opponent="/gu)).toHaveLength(2);
    expect(html).not.toContain('data-duel-opponent="rhea"');
  });

  it('marks the chosen opponent', () => {
    expect(html).toContain('data-duel-opponent="sable" aria-current="true"');
  });
});

describe('the Inspector summary', () => {
  const html = renderMarkup(<DuelSummary analysis={ANALYSIS} playerId="kael" index={INDEX} />);

  it('adds up only measured fields', () => {
    expect(html).toContain('data-duel-summary="kael"');
    expect(html).toContain('对位击杀');
    expect(html).toContain('3');
    expect(html).toContain('伤害 出 / 入');
  });

  it('says so when the analysis has no matchups for the player', () => {
    const bare = renderMarkup(
      <DuelSummary analysis={BARE_ANALYSIS} playerId="kael" index={INDEX} />,
    );
    expect(bare).toContain('这份分析没有这名选手的对位记录');
  });
});

describe('density — the real volumes of `domain/densityFixtures`', () => {
  const analysis = densityAnalysis(OVERTIME_ROUNDS, 4);

  it('keeps the matrix at half a roster squared', () => {
    const big = duelMatrix(analysis, 'A');
    expect(big.rows).toHaveLength(MATCH_ROSTER_SIZE / 2);
    expect(big.columns).toHaveLength(MATCH_ROSTER_SIZE / 2);
    const html = renderMarkup(
      <DuelMatrixTable
        matrix={big}
        rowTeamName="Aurora"
        columnTeamName="Meridian"
        activePlayerId={null}
        activeOpponentId={null}
        onSelectPlayer={() => undefined}
        onSelectPair={() => undefined}
      />,
    );
    // 25 cells at most, and the scroll is the table's own.
    expect(html.match(/data-duel-cell="/gu)?.length ?? 0).toBeLessThanOrEqual(25);
    expect(html).toContain('overflow-auto');
  });

  it('keeps the opening-duel table at one row per round', () => {
    const duels = openingDuels(analysis.rounds);
    expect(duels).toHaveLength(OVERTIME_ROUNDS);
    const html = renderMarkup(
      <OpeningDuelTable
        duels={duels}
        index={rosterIndex(analysis)}
        tickRate={64}
        activeRound={null}
        onSelectRound={() => undefined}
        onLocate={() => undefined}
      />,
    );
    expect(html.match(/data-row-id="/gu)).toHaveLength(OVERTIME_ROUNDS);
  });
});
