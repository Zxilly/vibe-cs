import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { TEAM_A, TEAM_B } from './matchFixtures.testing';
import { Scoreboard } from './Scoreboard';
import type { MatchPeriod } from './types';

describe('Scoreboard', () => {
  it('draws the 「Aurora 13 : 11 Meridian」 of the 03 比赛工作区 context bar', () => {
    const html = renderMarkup(<Scoreboard teamA={TEAM_A} teamB={TEAM_B} />);

    expect(html).toContain('data-scoreboard=""');
    expect(html).toContain('data-scoreboard-team="a"');
    expect(html).toContain('Aurora');
    expect(html).toContain('13 : 11');
    expect(html).toContain('Meridian');
  });

  it('takes the score off the §3.2 type scale rather than a literal 18px', () => {
    const html = renderMarkup(<Scoreboard teamA={TEAM_A} teamB={TEAM_B} size="md" />);

    expect(html).toContain('text-lg');
    expect(html).not.toMatch(/font-size:\s*\d/u);
  });

  it('carries the side as a word and a glyph, never as a hue alone (§6.2)', () => {
    const html = renderMarkup(<Scoreboard teamA={TEAM_A} teamB={TEAM_B} />);

    expect(html).toContain('data-team-side="ct"');
    expect(html).toContain('data-team-side="t"');
    // The two-letter word is in the markup, so the badge survives greyscale.
    expect(html).toContain('>CT</span>');
    expect(html).toContain('>T</span>');
    // And the full name reaches assistive technology.
    expect(html).toContain('反恐精英');
    expect(html).toContain('恐怖分子');
  });

  it('draws no side badge for a team whose side is unknown', () => {
    const html = renderMarkup(
      <Scoreboard teamA={{ ...TEAM_A, side: undefined }} teamB={{ ...TEAM_B, side: undefined }} />,
    );

    expect(html).not.toContain('data-team-side');
  });

  it('says 比分未知 rather than inventing a zero for an unanalysed demo', () => {
    const html = renderMarkup(
      <Scoreboard teamA={{ ...TEAM_A, score: null }} teamB={{ ...TEAM_B, score: null }} />,
    );

    expect(html).toContain('—');
    expect(html).toContain('未知');
    expect(html).not.toContain('0 : 0');
  });

  it('gives the score one spoken sentence and hides the three visual spans', () => {
    const html = renderMarkup(<Scoreboard teamA={TEAM_A} teamB={TEAM_B} />);

    expect(html).toContain('比分 13 比 11');
    const score = html.slice(html.indexOf('data-scoreboard-score'));
    expect(score.slice(0, 120)).toContain('aria-hidden="true"');
  });

  it('lists the halves and the overtime as their own periods', () => {
    const periods: MatchPeriod[] = [
      { id: 'h1', label: '上半', teamAScore: 8, teamBScore: 4 },
      { id: 'h2', label: '下半', teamAScore: 4, teamBScore: 7 },
      { id: 'ot1', label: '加时 1', teamAScore: 1, teamBScore: 0, overtime: true },
    ];
    const html = renderMarkup(<Scoreboard teamA={TEAM_A} teamB={TEAM_B} periods={periods} />);

    expect(html).toContain('data-scoreboard-period="h1"');
    expect(html).toContain('data-scoreboard-period="h2"');
    expect(html).toContain('data-scoreboard-period="ot1"');
    expect(html).toContain('加时 1');
  });

  it('states the side swap in words instead of leaving it to two changed badges', () => {
    const periods: MatchPeriod[] = [{ id: 'h1', label: '上半', teamAScore: 8, teamBScore: 4 }];
    const html = renderMarkup(
      <Scoreboard teamA={TEAM_A} teamB={TEAM_B} periods={periods} sidesSwapped />,
    );

    expect(html).toContain('data-scoreboard-swapped=""');
    expect(html).toContain('攻守已交换');
  });

  it('draws no period list when there are no periods to draw', () => {
    const html = renderMarkup(<Scoreboard teamA={TEAM_A} teamB={TEAM_B} periods={[]} />);

    expect(html).not.toContain('data-scoreboard-periods');
  });

  it('renders with no backend, no store and no query — props in, markup out', () => {
    expect(() => renderMarkup(<Scoreboard teamA={TEAM_A} teamB={TEAM_B} />)).not.toThrow();
  });
});
