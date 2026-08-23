/*
 * `markup` project — 概览.
 *
 * The reading half of the view goes through TanStack, and
 * `renderToStaticMarkup` never resolves a promise, so what is rendered here is
 * `OverviewPanels` with a document in hand. The three claims worth pinning are
 * the ones the artboard and the previous phases' rules make:
 *
 *   · every block is a way into the view that owns it;
 *   · a number that cannot be derived is absent, not zero;
 *   · a preview says how much it is a preview of.
 */

import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../../test/render';
import { OverviewPanels, HIGHLIGHT_PREVIEW } from './OverviewView';
import { ANALYSIS, BARE_ANALYSIS } from './test/matchFixture';

const ADD_TO_VIDEO = { disabled: true, disabledReason: '录制队列尚未接通' };

function render(analysis = ANALYSIS, selectedRound: number | null = null): string {
  return renderMarkup(
    <OverviewPanels
      analysis={analysis}
      tickRate={analysis.tick_rate}
      selectedRound={selectedRound}
      onUpdateContext={() => undefined}
      addToVideo={ADD_TO_VIDEO}
    />,
  );
}

describe('the summary strip', () => {
  const html = render();

  it('prints the round tally counted off the round list', () => {
    expect(html).toContain('data-match-metric="rounds-won"');
    expect(html).toContain('13 - 11');
    expect(html).toContain('共 24 回合');
  });

  it('prints the opening-kill difference with its sign', () => {
    expect(html).toContain('data-match-metric="opening-kills"');
  });

  it('counts clutch *candidates* and says so, because wins are not on the wire', () => {
    expect(html).toContain('data-match-metric="clutch-candidates"');
    expect(html).toContain('按高光类型统计，胜负未记录');
  });

  it('states spatial evidence as a fraction rather than as the word 「可用」', () => {
    expect(html).toContain('data-match-metric="spatial"');
    expect(html).toContain('可以画进 2D 回放的事件');
  });

  it('does not restate the scoreboard the pinned context bar already carries', () => {
    /* `MatchContextBar` keeps its `Scoreboard` at every width and sits in
       `Page`'s toolbar above this view, so a second one would print
       「Aurora 13 : 11 Meridian」 twice on one screen. The team names still reach
       this view — the round strip's legend names both — but the scoreboard
       component is the bar's. */
    expect(html).not.toContain('data-scoreboard=');
    expect(html).toContain('Aurora 胜');
    expect(html).toContain('Meridian 胜');
  });
});

describe('a parse with nothing but rounds', () => {
  const html = render(BARE_ANALYSIS);

  it('omits every metric it cannot derive instead of rendering 0', () => {
    expect(html).toContain('data-match-metric="rounds-won"');
    expect(html).not.toContain('data-match-metric="highlights"');
    expect(html).not.toContain('data-match-metric="clutch-candidates"');
    expect(html).not.toContain('data-match-metric="spatial"');
    expect(html).not.toContain('data-match-metric="opening-kills"');
  });

  it('says the highlight pass found nothing, and still offers the timeline', () => {
    expect(html).toContain('这次分析没有检出高光候选');
    expect(html).toContain('data-round-timeline');
  });
});

describe('the three blocks are three doors', () => {
  const html = render();

  it('draws the round strip as the domain component, selection included', () => {
    expect(html).toContain('data-round-timeline');
    expect(html).toContain('data-round-cell="21"');
  });

  it('marks the selected round on the strip when the address carries one', () => {
    expect(render(ANALYSIS, 21)).toContain('data-round-cell="21" data-winner="a"');
    expect(render(ANALYSIS, 21)).toMatch(/data-round-cell="21"[^>]*aria-current="true"/u);
  });

  it('previews the strongest highlights and prints the total, not the slice', () => {
    expect(html).toContain('data-match-key-moments');
    const rows = html.match(/data-highlight-row=/gu) ?? [];
    expect(rows).toHaveLength(HIGHLIGHT_PREVIEW);
    expect(html).toContain('查看全部 18 条');
    expect(html).toMatch(/data-highlight-row="[^"]+"[^>]*aria-current="true"/u);
  });

  it('keeps the preview’s scroll inside its own container', () => {
    expect(html).toMatch(/<ul[^>]*data-match-key-moments[^>]*overflow-y-auto/u);
    expect(html).toMatch(/<ul[^>]*data-match-key-moments[^>]*overscroll-y-contain/u);
  });

  it('offers 加入作品 disabled with the supplied reason, never hidden', () => {
    expect(html).toContain('加入作品');
    expect(html).toContain('录制队列尚未接通');
  });

  it('invents no progress', () => {
    expect(html).not.toContain('role="progressbar"');
  });
});
