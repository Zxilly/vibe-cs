/*
 * `markup` project — 回合, the view §7 folded advantage and objective into.
 *
 * What is pinned: the two merged tabs are actually present (a survivor curve and
 * objective markers), the table never truncates silently, the 位置 column the
 * artboard draws is *absent* rather than filled with coordinates, and the
 * Inspector is the same round in the shape 「03 比赛工作区」 draws.
 */

import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { DesktopClientProvider, type DesktopClient } from '../../../data/desktopClient';
import { renderMarkup } from '../../../test/render';
import { RoundInspectorBody, RoundsPanels } from './RoundsView';
import { buildRoundDetail } from './roundDetail';
import { ANALYSIS, BARE_ANALYSIS, DEMO_ID } from './test/matchFixture';

/** Never answers: the round-review read stays pending, which is a real state. */
const PENDING: Partial<DesktopClient> = {
  getRoundReviewMetadata: () => new Promise(() => undefined),
};

function render(node: ReactElement): string {
  return renderMarkup(
    <DesktopClientProvider client={PENDING as DesktopClient}>{node}</DesktopClientProvider>,
  );
}

const detail = buildRoundDetail(ANALYSIS, 4);

function panels(selectedRound: number | null, analysis = ANALYSIS): string {
  return render(
    <RoundsPanels
      analysis={analysis}
      tickRate={analysis.tick_rate}
      selectedRound={selectedRound}
      selectedTick={null}
      onUpdateContext={() => undefined}
    />,
  );
}

describe('picking a round', () => {
  it('always draws the strip, so the picker never disappears', () => {
    expect(panels(null)).toContain('data-round-timeline');
    expect(panels(4)).toContain('data-round-timeline');
  });

  it('focuses the first round without requiring an address mutation', () => {
    const html = panels(null);
    expect(html).toContain('第 1 回合');
    expect(html).toContain('data-match-survivor-axis');
    expect(html).toMatch(/data-round-cell="1"[^>]*aria-current="true"/u);
  });

  it('says so plainly when the address names a round this match does not have', () => {
    expect(panels(99)).toContain('这场比赛没有第 99 回合');
  });
});

describe('the merged advantage tab', () => {
  const html = panels(4);

  it('draws the survivor curve as two lines that differ in shape, not only hue', () => {
    expect(html).toContain('data-match-survivor-axis');
    expect(html).toContain('stroke-dasharray="5 4"');
    expect(html).toContain('vector-effect="non-scaling-stroke"');
  });

  it('names both lines in words', () => {
    expect(html).toContain('Aurora 存活');
    expect(html).toContain('Meridian 存活');
  });

  it('hides the chart from assistive tech, because the table says the same thing', () => {
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/u);
  });
});

describe('the merged objective tab', () => {
  const html = panels(4);

  it('marks the bomb events on the axis and names them with their clock', () => {
    // Round 4 plants and defuses in the fixture.
    expect(html).toContain('data-match-objective-marker="bomb_plant"');
    expect(html).toContain('data-match-objective-marker="bomb_defuse"');
    expect(html).toContain('下包');
    expect(html).toContain('拆包');
  });
});

describe('the round event table', () => {
  const html = panels(4);

  it('says how much of the round it is showing — never a silent truncation', () => {
    expect(detail).not.toBeNull();
    expect(html).toContain(`击杀与目标事件 ${String(detail?.moments.length)} 条`);
    expect(html).toContain(`本回合共 ${String(detail?.eventCount)} 条事件`);
  });

  it('omits the 位置 column: a world coordinate is not a callout name', () => {
    expect(html).not.toContain('>位置<');
  });

  it('carries the man-advantage reading into every row', () => {
    expect(html).toContain('人数');
    expect(html).toMatch(/\d v \d/u);
  });

  it('offers 定位 per row, which writes the playhead', () => {
    expect(html).toContain('data-match-locate=');
    expect(html).toContain('定位');
  });

  it('scrolls inside its own container', () => {
    expect(html).toMatch(/overflow-auto/u);
  });
});

describe('a round with no events', () => {
  it('says which of the two things happened instead of showing an empty table', () => {
    const html = panels(4, BARE_ANALYSIS);
    expect(html).toContain('这一回合没有击杀或目标事件');
    expect(html).toContain('在 2D 回放里查看');
  });
});

describe('the Inspector', () => {
  const html = render(
    <RoundInspectorBody
      demoId={DEMO_ID}
      detail={detail as NonNullable<typeof detail>}
      tickRate={64}
      teamAName="Aurora"
      teamBName="Meridian"
      selectedTick={null}
      onUpdateContext={() => undefined}
    />,
  );

  it('states the round’s outcome in words and in the score', () => {
    expect(html).toContain('Aurora 胜');
    expect(html).toContain('击杀清场');
  });

  it('lists 回合内证据 as the domain row, in its own scroll container', () => {
    expect(html).toContain('data-match-round-evidence');
    expect(html).toContain('data-evidence-row=');
    expect(html).toMatch(/<ul[^>]*data-match-round-evidence[^>]*overflow-y-auto/u);
  });

  it('holds the note block open with a skeleton rather than claiming there is none', () => {
    expect(html).toContain('注释');
    expect(html).toContain('animate-pulse');
    expect(html).not.toContain('这一回合还没有注释');
  });
});
