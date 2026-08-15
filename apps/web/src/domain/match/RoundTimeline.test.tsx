import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { ROUNDS } from './matchFixtures.testing';
import { RoundTimeline } from './RoundTimeline';
import type { RoundSummary } from './types';

const NAMES = { teamAName: 'Aurora', teamBName: 'Meridian' } as const;

describe('RoundTimeline', () => {
  it('draws the 「回合时间线」 panel of the 03 比赛工作区 artboard', () => {
    const html = renderMarkup(<RoundTimeline rounds={ROUNDS} {...NAMES} />);

    expect(html).toContain('data-round-timeline=""');
    expect(html).toContain('回合时间线');
    expect(html).toContain('点击回合进入逐回合复盘');
    expect(html).toContain('data-round-timeline-state="ready"');
  });

  it('draws one cell per round, numbered', () => {
    const html = renderMarkup(<RoundTimeline rounds={ROUNDS} {...NAMES} />);

    for (const round of ROUNDS) expect(html).toContain(`data-round-cell="${round.number}"`);
    expect(html.split('data-round-cell=')).toHaveLength(ROUNDS.length + 1);
  });

  it('lays 24 cells out in one grid row of 24 columns', () => {
    const html = renderMarkup(<RoundTimeline rounds={ROUNDS} {...NAMES} />);

    expect(html).toContain('data-round-strip-rows="1"');
    expect(html).toContain('repeat(24, minmax(0, 1fr))');
  });

  it('wraps a long overtime instead of shrinking the cells past legibility', () => {
    const long: RoundSummary[] = Array.from({ length: 58 }, (_, index) => ({
      number: index + 1,
      winner: index % 2 === 0 ? 'a' : 'b',
      reason: 'elimination',
    }));
    const html = renderMarkup(<RoundTimeline rounds={long} {...NAMES} />);

    expect(html).toContain('data-round-strip-rows="2"');
    expect(html).toContain('repeat(29, minmax(0, 1fr))');
  });

  it('encodes the winner as an edge position as well as a hue (§6.2)', () => {
    const html = renderMarkup(<RoundTimeline rounds={ROUNDS.slice(0, 2)} {...NAMES} />);

    // Team A's rule sits before the body, team B's after it.
    const first = html.slice(html.indexOf('data-round-cell="1"'), html.indexOf('data-round-cell="2"'));
    const second = html.slice(html.indexOf('data-round-cell="2"'));
    expect(first).toContain('data-winner="a"');
    expect(first).toContain('order-1');
    expect(second.slice(0, 400)).toContain('data-winner="b"');
    expect(second.slice(0, 400)).toContain('order-3');
  });

  it('says who won and how, in words, on every cell', () => {
    const html = renderMarkup(<RoundTimeline rounds={ROUNDS.slice(0, 4)} {...NAMES} />);

    expect(html).toContain('Aurora');
    expect(html).toContain('Meridian');
    expect(html).toContain('击杀清场');
    expect(html).toContain('炸弹引爆');
    expect(html).toContain('拆弹成功');
    expect(html).toContain('时间耗尽');
  });

  it('marks a key round with a second edge rule and with the word', () => {
    const html = renderMarkup(<RoundTimeline rounds={ROUNDS} {...NAMES} />);

    expect(html).toContain('data-key-round=""');
    expect(html).toContain('关键回合');
    expect(html.split('data-key-round=""')).toHaveLength(2);
  });

  it('marks the selected round with aria-current, not with colour alone', () => {
    const html = renderMarkup(<RoundTimeline rounds={ROUNDS} selectedRound={21} {...NAMES} />);

    expect(html.split('aria-current="true"')).toHaveLength(2);
    const cell = html.slice(html.indexOf('data-round-cell="21"'));
    expect(cell.slice(0, 200)).toContain('aria-current="true"');
  });

  it('gives the strip a single tab stop that lands on the selected round', () => {
    const html = renderMarkup(<RoundTimeline rounds={ROUNDS} selectedRound={21} {...NAMES} />);

    expect(html.split('tabindex="0"')).toHaveLength(2);
    const cell = html.slice(html.indexOf('data-round-cell="21"'));
    expect(cell.slice(0, 200)).toContain('tabindex="0"');
  });

  it('falls back to the first cell for the tab stop when nothing is selected', () => {
    const html = renderMarkup(<RoundTimeline rounds={ROUNDS} {...NAMES} />);

    expect(html.split('tabindex="0"')).toHaveLength(2);
    const first = html.slice(html.indexOf('data-round-cell="1"'));
    expect(first.slice(0, 200)).toContain('tabindex="0"');
  });

  it('teaches the legend the position, not only the hue', () => {
    const html = renderMarkup(<RoundTimeline rounds={ROUNDS} {...NAMES} />);

    expect(html).toContain('data-legend-position="top"');
    expect(html).toContain('data-legend-position="bottom"');
  });

  it('renders the 「这场还没分析」 empty state with its recovery action', () => {
    const html = renderMarkup(
      <RoundTimeline rounds={[]} {...NAMES} emptyActions={<button type="button">开始分析</button>} />,
    );

    expect(html).toContain('data-round-timeline-state="empty"');
    expect(html).toContain('这场还没分析');
    expect(html).toContain('开始分析');
    expect(html).not.toContain('data-round-cell');
  });

  it('renders a skeleton while loading, with no fabricated percentage', () => {
    const html = renderMarkup(<RoundTimeline rounds={[]} loading {...NAMES} />);

    expect(html).toContain('data-round-timeline-state="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('animate-pulse');
    expect(html).not.toMatch(/\d+%<\//u);
  });

  it('renders a failure as an in-place Notice with a recovery action (§4.1)', () => {
    const html = renderMarkup(
      <RoundTimeline
        rounds={ROUNDS}
        {...NAMES}
        failure={{ message: '回合数据没能读出来', onRetry: () => {} }}
      />,
    );

    expect(html).toContain('回合数据没能读出来');
    expect(html).toContain('重试');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('data-round-cell');
  });

  it('renders with no backend, no store and no query', () => {
    expect(() => renderMarkup(<RoundTimeline rounds={ROUNDS} {...NAMES} />)).not.toThrow();
  });
});
