import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { MatchContextBar } from './MatchContextBar';
import { MATCH, TEAM_A, TEAM_B } from './matchFixtures.testing';

const BASE = { match: MATCH, teamA: TEAM_A, teamB: TEAM_B } as const;

describe('MatchContextBar', () => {
  it('draws the context bar of the 03 比赛工作区 artboard', () => {
    const html = renderMarkup(<MatchContextBar {...BASE} backLink={<a href="/library">资料库</a>} />);

    expect(html).toContain('data-match-context-bar="expanded"');
    expect(html).toContain('data-match-back=""');
    expect(html).toContain('资料库');
    expect(html).toContain('data-match-map-code=""');
    expect(html).toContain('MRG');
    expect(html).toContain('Aurora');
    expect(html).toContain('13 : 11');
    expect(html).toContain('Mirage');
    expect(html).toContain('2026-08-14');
    expect(html).toContain('24 回合');
  });

  it('takes the 56px bar from --h-topbar, which §3.4 names for it', () => {
    const html = renderMarkup(<MatchContextBar {...BASE} />);

    expect(html).toContain('h-[var(--h-topbar)]');
    expect(html).not.toContain('h-[56px]');
  });

  it('states the tick rate rather than assuming 64 everywhere downstream', () => {
    const sixtyFour = renderMarkup(<MatchContextBar {...BASE} />);
    const oneTwentyEight = renderMarkup(
      <MatchContextBar {...BASE} match={{ ...MATCH, tickRate: 128 }} />,
    );

    expect(sixtyFour).toContain('64 tick');
    expect(oneTwentyEight).toContain('128 tick');
  });

  it('falls back to the CS2 rate when the demo header carried none', () => {
    const html = renderMarkup(<MatchContextBar {...BASE} match={{ ...MATCH, tickRate: undefined }} />);

    expect(html).toContain('64 tick');
  });

  it('draws no map plate for a map with no known abbreviation', () => {
    const html = renderMarkup(<MatchContextBar {...BASE} match={{ ...MATCH, mapCode: undefined }} />);

    expect(html).not.toContain('data-match-map-code');
    expect(html).toContain('Mirage');
  });

  it('carries the round range the workspace is looking at', () => {
    const html = renderMarkup(<MatchContextBar {...BASE} roundRange="当前 R21" />);

    expect(html).toContain('data-match-round-range=""');
    expect(html).toContain('当前 R21');
  });

  it('draws the 聚焦选手 chips with the artboard accent / neutral split', () => {
    const html = renderMarkup(
      <MatchContextBar
        {...BASE}
        focusedPlayers={[
          { id: 'kael', name: 'Kael', primary: true },
          { id: 'rhea', name: 'Rhea' },
        ]}
        onAddFocusedPlayer={() => {}}
      />,
    );

    expect(html).toContain('data-match-focus=""');
    expect(html).toContain('聚焦选手');
    expect(html).toContain('Kael');
    expect(html).toContain('Rhea');
    expect(html).toContain('＋ 添加选手');
  });

  it('makes a removable chip a button and an inert one a span', () => {
    const inert = renderMarkup(
      <MatchContextBar {...BASE} focusedPlayers={[{ id: 'kael', name: 'Kael' }]} />,
    );
    const removable = renderMarkup(
      <MatchContextBar {...BASE} focusedPlayers={[{ id: 'kael', name: 'Kael', onRemove: () => {} }]} />,
    );

    expect(inert).not.toContain('<button');
    expect(removable).toContain('<button');
  });

  it('keeps the primary actions in the bar at every width (§8)', () => {
    const expanded = renderMarkup(
      <MatchContextBar {...BASE} actions={<button type="button">用 Agent 制作视频</button>} />,
    );
    const collapsed = renderMarkup(
      <MatchContextBar
        {...BASE}
        collapsed
        actions={<button type="button">用 Agent 制作视频</button>}
      />,
    );

    for (const html of [expanded, collapsed]) {
      expect(html).toContain('data-match-actions=""');
      expect(html).toContain('用 Agent 制作视频');
    }
  });

  it('folds the metadata and the focus chips into a disclosure at the breakpoint', () => {
    const html = renderMarkup(
      <MatchContextBar {...BASE} collapsed focusedPlayers={[{ id: 'kael', name: 'Kael' }]} />,
    );

    expect(html).toContain('data-match-context-bar="collapsed"');
    expect(html).toContain('data-match-details-toggle=""');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('比赛信息');
    // The fold announces what it took rather than swallowing it silently.
    expect(html).toContain('聚焦 1');
  });

  it('keeps the identity visible in the folded bar', () => {
    const html = renderMarkup(<MatchContextBar {...BASE} collapsed backLink={<a href="/library">资料库</a>} />);

    expect(html).toContain('资料库');
    expect(html).toContain('MRG');
    expect(html).toContain('13 : 11');
  });

  it('renders a skeleton while loading without collapsing the bar height', () => {
    const html = renderMarkup(
      <MatchContextBar {...BASE} loading actions={<button type="button">用 Agent 制作视频</button>} />,
    );

    expect(html).toContain('data-match-context-state="loading"');
    expect(html).toContain('h-[var(--h-topbar)]');
    expect(html).toContain('animate-pulse');
    // The escape hatch and the primary action survive a load in progress.
    expect(html).toContain('用 Agent 制作视频');
  });

  it('renders a failure as an in-place Notice and keeps the bar (§4.1)', () => {
    const html = renderMarkup(
      <MatchContextBar
        {...BASE}
        backLink={<a href="/library">资料库</a>}
        failure={{ message: '这场比赛没能读出来', onRetry: () => {} }}
      />,
    );

    expect(html).toContain('这场比赛没能读出来');
    expect(html).toContain('重试');
    expect(html).toContain('role="alert"');
    // The way back is exactly what a user with a broken workspace needs.
    expect(html).toContain('资料库');
  });

  it('renders with no backend, no store and no query', () => {
    expect(() => renderMarkup(<MatchContextBar {...BASE} />)).not.toThrow();
  });
});
