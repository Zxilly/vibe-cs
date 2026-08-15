/*
 * `markup` project — 道具与经济.
 *
 * The artboard's caption is the test plan: 「不完整的投掷物生命周期会明确降级」.
 * So the assertions are about what happens when a capability is unavailable —
 * the column goes away and the service's reason is printed, rather than a zero
 * appearing where a measurement should be.
 */

import { describe, expect, it } from 'vitest';

import { MATCH_ROSTER_SIZE, OVERTIME_ROUNDS } from '../../../domain/densityFixtures';
import { renderMarkup } from '../../../test/render';
import { markupAt } from '../test/renderWorkspace';
import { rosterIndex } from './duelsModel';
import {
  EconomyTable,
  PlayerUtilityDetail,
  RoundEconomyDetail,
  UtilityTable,
  UtilityTiles,
} from './UtilityView';
import { economyRows, utilityRows, utilityTotals } from './utilityModel';
import { ANALYSIS, BARE_ANALYSIS, densityAnalysis, INSIGHTS } from './test/rosterFixtures';

const INDEX = rosterIndex(ANALYSIS);
const ROWS = utilityRows(INSIGHTS, INDEX);
const ECONOMY = economyRows(INSIGHTS, ANALYSIS.rounds);

describe('the first paint', () => {
  const html = markupAt('/match/aurora?view=utility');

  it('is the view the address asked for', () => {
    expect(html).toContain('data-match-view="utility"');
  });

  it('is the shared skeleton with a stage name and no fabricated percentage', () => {
    expect(html).toContain('data-match-view-state="loading"');
    expect(html).toContain('data-match-view-skeleton');
    expect(html).toContain('正在读取比赛分析');
    expect(html).not.toContain('role="progressbar"');
  });

  it('states no count while the read is pending — 「共 0 名选手」 is a claim', () => {
    expect(html).not.toContain('名选手有道具记录');
  });
});

describe('the four tiles', () => {
  const html = renderMarkup(
    <UtilityTiles totals={utilityTotals(INSIGHTS)} damageAvailable flashAvailable />,
  );

  it('carries the artboard’s four labels', () => {
    expect(html).toContain('data-utility-tiles');
    expect(html).toContain('投掷物');
    expect(html).toContain('道具伤害');
    expect(html).toContain('生命周期不完整');
  });

  it('prints 「有效闪」 as the field it actually is', () => {
    expect(html).toContain('致盲人次');
    expect(html).not.toContain('有效闪');
  });

  it('sums the roster', () => {
    expect(html).toContain('41');
    expect(html).toContain('396');
  });

  it('draws the degradation tile dashed, as the artboard does', () => {
    expect(html).toContain('border-dashed');
  });

  it('dashes the numbers whose events did not decode instead of showing 0', () => {
    const degraded = renderMarkup(
      <UtilityTiles
        totals={utilityTotals(BARE_ANALYSIS.insights)}
        damageAvailable={false}
        flashAvailable={false}
      />,
    );
    expect(degraded).toContain('—');
  });
});

describe('the per-player table', () => {
  const html = renderMarkup(
    <UtilityTable
      rows={ROWS}
      activePlayerId="kael"
      onSelect={() => undefined}
      damageAvailable
      flashAvailable
    />,
  );

  it('is one row per player with a utility record, busiest first', () => {
    expect(html.match(/data-row-id="/gu)).toHaveLength(4);
    expect(html.indexOf('Sable')).toBeLessThan(html.indexOf('Kael'));
  });

  it('marks the row the address holds', () => {
    expect(html).toContain('data-row-id="kael" data-active="true"');
  });

  it('translates the item names and keeps their counts', () => {
    expect(html).toContain('闪光');
    expect(html).toContain('烟雾');
    expect(html).toContain('高爆');
  });

  it('prints the dash for a flash duration the wire said was incomplete', () => {
    expect(html).toContain('致盲时长');
    expect(html).toContain('—');
  });

  it('drops the flash and damage columns entirely when the events did not decode', () => {
    const degraded = renderMarkup(
      <UtilityTable
        rows={ROWS}
        activePlayerId={null}
        onSelect={() => undefined}
        damageAvailable={false}
        flashAvailable={false}
      />,
    );
    expect(degraded).not.toContain('致盲人次');
    expect(degraded).not.toContain('道具伤害');
    // What is measurable is still there.
    expect(degraded).toContain('投出');
  });
});

describe('the economy table', () => {
  const html = renderMarkup(
    <EconomyTable
      rows={ECONOMY}
      teamAName="Aurora"
      teamBName="Meridian"
      activeRound={2}
      onSelect={() => undefined}
      spendAvailable
    />,
  );

  it('is one row per round, in round order', () => {
    expect(html.match(/data-row-id="/gu)).toHaveLength(3);
    expect(html.indexOf('data-row-id="1"')).toBeLessThan(html.indexOf('data-row-id="3"'));
  });

  it('names sides as sides and the winner as a team', () => {
    expect(html).toContain('CT 购买');
    expect(html).toContain('T 购买');
    expect(html).toContain('Aurora');
    expect(html).toContain('Meridian');
  });

  it('keeps the unattributed purchases visible', () => {
    expect(html).toContain('未归属');
  });

  it('drops the spend columns when one price was missing', () => {
    const degraded = renderMarkup(
      <EconomyTable
        rows={ECONOMY}
        teamAName="Aurora"
        teamBName="Meridian"
        activeRound={null}
        onSelect={() => undefined}
        spendAvailable={false}
      />,
    );
    expect(degraded).not.toContain('花费');
    expect(degraded).toContain('CT 购买');
  });

  it('draws no equipment-value chart — purchases are not equipment value', () => {
    expect(html).not.toContain('装备价值');
    expect(html).not.toContain('枪局胜率');
  });
});

describe('the Inspector', () => {
  it('breaks one player’s throws down by item', () => {
    const html = renderMarkup(
      <PlayerUtilityDetail row={ROWS[1]!} damageAvailable flashAvailable />,
    );
    expect(html).toContain('data-utility-detail="kael"');
    expect(html).toContain('投掷物构成');
    expect(html).toContain('闪光');
    expect(html).toContain('12');
  });

  it('hides the gated numbers rather than showing a zero', () => {
    const html = renderMarkup(
      <PlayerUtilityDetail row={ROWS[1]!} damageAvailable={false} flashAvailable={false} />,
    );
    expect(html).not.toContain('道具伤害');
    expect(html).not.toContain('致盲人次');
  });

  it('breaks one round’s purchases down by side and states the unattributed ones', () => {
    const round = ECONOMY.find((row) => row.round === 2)!;
    const html = renderMarkup(<RoundEconomyDetail row={round} spendAvailable />);
    expect(html).toContain('data-economy-detail="2"');
    expect(html).toContain('CT');
    expect(html).toContain('购买条数');
    expect(html).toContain('没有带阵营');
  });
});

describe('density — the real volumes of `domain/densityFixtures`', () => {
  const analysis = densityAnalysis(OVERTIME_ROUNDS, 4);
  const index = rosterIndex(analysis);

  it('keeps the utility table to one row per roster member', () => {
    const rows = utilityRows(analysis.insights, index);
    expect(rows).toHaveLength(MATCH_ROSTER_SIZE);
    const html = renderMarkup(
      <UtilityTable
        rows={rows}
        activePlayerId={null}
        onSelect={() => undefined}
        damageAvailable
        flashAvailable
      />,
    );
    expect(html.match(/data-row-id="/gu)).toHaveLength(MATCH_ROSTER_SIZE);
    expect(html).toContain('overflow-auto');
  });

  it('keeps the economy table to one row per round and scrolls inside itself', () => {
    const rows = economyRows(analysis.insights, analysis.rounds);
    expect(rows).toHaveLength(OVERTIME_ROUNDS);
    const html = renderMarkup(
      <EconomyTable
        rows={rows}
        teamAName="Aurora"
        teamBName="Meridian"
        activeRound={null}
        onSelect={() => undefined}
        spendAvailable
      />,
    );
    expect(html.match(/data-row-id="/gu)).toHaveLength(OVERTIME_ROUNDS);
    expect(html).toContain('overflow-auto');
  });
});
