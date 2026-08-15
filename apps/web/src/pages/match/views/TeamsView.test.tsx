/*
 * `markup` project — 队伍, the view §7 created and no artboard draws.
 *
 * Because there is no reference cell for it, the assertions here are mostly
 * about the *claims* the view makes: the economy table says it is keyed by side
 * rather than by team, a spend it cannot total prints 「—」, and the two
 * scoreboard columns `PlayerAnalysis` cannot answer (首杀 / 残局) are absent
 * rather than zero.
 */

import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../../test/render';
import { TeamsPanels } from './TeamsView';
import { ANALYSIS, BARE_ANALYSIS, INSIGHTS } from './test/matchFixture';

function render(analysis = ANALYSIS, selectedPlayer: string | null = null): string {
  return renderMarkup(
    <TeamsPanels
      analysis={analysis}
      selectedPlayer={selectedPlayer}
      selectedRound={null}
      onUpdateContext={() => undefined}
    />,
  );
}

describe('阵营 — one panel per team', () => {
  const html = render();

  it('draws both rosters, named as the analysis named them', () => {
    expect(html).toContain('data-match-panel="team-a"');
    expect(html).toContain('data-match-panel="team-b"');
    expect(html).toContain('Aurora');
    expect(html).toContain('Meridian');
  });

  it('prints the side as a word, not as a hue', () => {
    // `TEAM_SIDE` labels, not the CT/T abbreviations alone.
    expect(html).toContain('反恐精英');
    expect(html).toContain('恐怖分子');
  });

  it('carries the scoreboard columns the wire can answer', () => {
    for (const header of ['选手', 'ADR', '爆头率']) expect(html).toContain(header);
  });

  it('omits 首杀 and 残局: PlayerAnalysis carries neither and nothing derives them', () => {
    expect(html).not.toContain('>首杀<');
    expect(html).not.toContain('>残局<');
  });

  it('marks the focused player as the active row', () => {
    const focused = render(ANALYSIS, 'kael');
    expect(focused).toMatch(/data-row-id="kael"[^>]*aria-current/u);
  });
});

describe('经济 — by side, and it says so', () => {
  const html = render();

  it('states in the panel head that the totals are per side, not per team', () => {
    expect(html).toContain('data-match-panel="economy"');
    expect(html).toContain('购买事件带的是当回合的阵营，不是队伍');
    expect(html).toContain('CT 购买');
    expect(html).toContain('T 花费');
  });

  it('prints an em dash rather than a low total when a round carried no price', () => {
    expect(html).toContain('data-match-economy-total');
    expect(html).toContain('有回合缺少价格');
  });

  it('surfaces the purchases the analyser could not attribute', () => {
    expect(html).toContain('data-match-economy-unattributed');
  });

  it('keeps its scroll inside the table', () => {
    expect(html).toMatch(/overflow-auto/u);
  });
});

describe('经济 — when the pass could not run', () => {
  it('separates a missing insights block from a declined capability', () => {
    expect(render(BARE_ANALYSIS)).toContain('这份分析结果里没有洞察数据');

    const blocked = render({
      ...ANALYSIS,
      insights: {
        ...INSIGHTS,
        availability: {
          ...INSIGHTS.availability,
          purchase_events: { available: false, reason: '这批 Demo 没有购买事件' },
        },
      },
    });
    // The service's own sentence, verbatim.
    expect(blocked).toContain('这批 Demo 没有购买事件');
    expect(blocked).not.toContain('data-match-economy-total');
  });
});

describe('回合 — how each team won', () => {
  const html = render();

  it('breaks the wins down by end reason and totals them', () => {
    expect(html).toContain('data-match-panel="round-outcomes"');
    expect(html).toContain('击杀清场');
    expect(html).toContain('13 - 11');
  });

  it('drops a reason nobody won a round with, rather than printing a row of zeros', () => {
    expect(html).not.toContain('结束原因未知');
  });
});

describe('a parse with nothing but rounds', () => {
  const html = render(BARE_ANALYSIS);

  it('drops the 高光 column when the highlight pass produced nothing', () => {
    expect(html).not.toContain('>高光<');
  });

  it('still draws both rosters and the round breakdown', () => {
    expect(html).toContain('data-match-panel="team-a"');
    expect(html).toContain('data-match-panel="round-outcomes"');
  });

  it('invents no progress', () => {
    expect(html).not.toContain('role="progressbar"');
  });
});
