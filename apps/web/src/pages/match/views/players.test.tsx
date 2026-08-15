/*
 * `markup` project — 玩家.
 *
 * Two halves, for the reason `PlayersPage.test.tsx` already records:
 * `renderToStaticMarkup` never lets a query resolve, so the container can only
 * be asserted in its first paint, and everything that needs real numbers is
 * asserted by rendering the exported presentational halves directly.
 */

import { describe, expect, it } from 'vitest';

import { MATCH_ROSTER_SIZE, OVERTIME_ROUNDS } from '../../../domain/densityFixtures';
import { renderMarkup } from '../../../test/render';
import { markupAt } from '../test/renderWorkspace';
import { MatchScoreboard, PlayerMatchDetail } from './PlayersView';
import { scoreboardRows } from './playersModel';
import { ANALYSIS, BARE_ANALYSIS, densityAnalysis } from './test/rosterFixtures';

const ROWS = scoreboardRows(ANALYSIS);
const BARE_ROWS = scoreboardRows(BARE_ANALYSIS);

function scoreboard(options: { rows?: typeof ROWS; showOpeningDuels?: boolean; active?: string | null } = {}) {
  return renderMarkup(
    <MatchScoreboard
      rows={options.rows ?? ROWS}
      activePlayerId={options.active ?? null}
      onSelect={() => undefined}
      sort={null}
      onSortChange={() => undefined}
      showOpeningDuels={options.showOpeningDuels ?? true}
    />,
  );
}

describe('the first paint', () => {
  const html = markupAt('/match/aurora?view=players');

  it('is the view the address asked for', () => {
    expect(html).toContain('data-match-view="players"');
  });

  it('is the shared skeleton with a stage name and no fabricated percentage', () => {
    expect(html).toContain('data-match-view-state="loading"');
    expect(html).toContain('data-match-view-skeleton');
    expect(html).toContain('正在读取比赛分析');
    expect(html).not.toContain('role="progressbar"');
  });

  it('states no count while the read is pending — 「共 0 名选手」 is a claim', () => {
    expect(html).not.toContain('名选手 · 点一行');
  });

  it('says nothing is selected rather than inventing a player', () => {
    expect(html).toContain('data-inspector="docked"');
    expect(html).toContain('点左侧记分板的一行');
    expect(html).not.toContain('data-player-detail');
  });
});

describe('the scoreboard', () => {
  const html = scoreboard();

  it('is one row per player, team A first', () => {
    expect(html.match(/data-row-id="/gu)).toHaveLength(4);
    expect(html.indexOf('Kael')).toBeLessThan(html.indexOf('Sable'));
  });

  it('prints the team’s own name, not the side letter', () => {
    expect(html).toContain('Aurora');
    expect(html).toContain('Meridian');
  });

  it('carries the columns the artboard draws', () => {
    for (const header of ['选手', '队伍', '击杀', '死亡', '助攻', 'K/D', 'ADR', '爆头率', '高光']) {
      expect(`${header}:${String(html.includes(header))}`).toBe(`${header}:true`);
    }
  });

  it('formats the rates and ratios the way the mono columns need', () => {
    expect(html).toContain('1.93');
    expect(html).toContain('98.4');
    expect(html).toContain('62%');
  });

  it('marks the selected row rather than a row of its own', () => {
    const active = scoreboard({ active: 'sable' });
    expect(active).toContain('data-row-id="sable" data-active="true"');
  });

  it('scrolls inside its own container so the shell grows no second scrollbar', () => {
    expect(html).toContain('overflow-auto');
  });
});

describe('what is omitted rather than zeroed', () => {
  it('drops 首杀 / 首死 when the analysis carries no kill events', () => {
    const html = scoreboard({ rows: BARE_ROWS, showOpeningDuels: false });
    expect(html).not.toContain('首杀');
    // The rest of the scoreboard is still there — only the derived pair went.
    expect(html).toContain('ADR');
  });

  it('shows them, including a measured zero, when the events are there', () => {
    expect(scoreboard()).toContain('首杀 / 首死');
  });

  it('never prints a hit rate — there is no weapon-fire event to divide by', () => {
    const html = renderMarkup(
      <PlayerMatchDetail analysis={ANALYSIS} row={ROWS[0]!} addDisabledReason="录制队列尚未接通" />,
    );
    expect(html).not.toContain('命中');
  });
});

describe('one player’s detail', () => {
  const html = renderMarkup(
    <PlayerMatchDetail analysis={ANALYSIS} row={ROWS[0]!} addDisabledReason="录制队列尚未接通" />,
  );

  it('is addressed by the player it describes', () => {
    expect(html).toContain('data-player-detail="kael"');
  });

  it('draws the artboard’s four tiles', () => {
    expect(html).toContain('K / D / A');
    expect(html).toContain('27 / 14 / 5');
    expect(html).toContain('爆头率');
    expect(html).toContain('首杀 / 首死');
  });

  it('lists the weapons by the demo’s own spelling', () => {
    expect(html).toContain('data-player-weapons');
    expect(html).toContain('ak47');
  });

  it('lists this match’s highlights with the detector’s own phrasing', () => {
    expect(html).toContain('data-player-highlights');
    expect(html).toContain('1v3 残局');
    expect(html).toContain('三杀');
  });

  it('disables 加入视频 with the shell’s reason instead of hiding it', () => {
    expect(html).toContain('加入视频');
    expect(html).toContain('录制队列尚未接通');
  });

  it('says why the weapon panel is empty when there is no event stream', () => {
    const bare = renderMarkup(
      <PlayerMatchDetail analysis={BARE_ANALYSIS} row={BARE_ROWS[0]!} />,
    );
    expect(bare).toContain('这份分析没有逐条击杀事件');
    expect(bare).toContain('检测器没有在这一场里给他标出高光');
  });
});

describe('density — the real volumes of `domain/densityFixtures`', () => {
  const analysis = densityAnalysis(OVERTIME_ROUNDS, 4);
  const rows = scoreboardRows(analysis);

  it('is one row per roster member and no more', () => {
    expect(rows).toHaveLength(MATCH_ROSTER_SIZE);
    expect(scoreboard({ rows }).match(/data-row-id="/gu)).toHaveLength(MATCH_ROSTER_SIZE);
  });

  it('keeps the weapon panel to its stated limit plus 其他, over 30 rounds', () => {
    const html = renderMarkup(<PlayerMatchDetail analysis={analysis} row={rows[0]!} />);
    // Two weapons in the fixture, so 其他 never appears — the point is that the
    // panel is bounded by the limit and not by the number of kills.
    expect(html.match(/<li>/gu)?.length ?? 0).toBeLessThanOrEqual(5);
  });
});
