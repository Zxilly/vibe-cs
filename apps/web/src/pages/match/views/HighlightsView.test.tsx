/*
 * `markup` project — what 高光 renders.
 *
 * The list is `domain/match/HighlightRow`, so the assertions here are about
 * what this view decides: which chips exist, which rows are shown, what the
 * footer counts, and that the two batch actions state their situation instead
 * of disappearing.
 */

import { describe, expect, it, vi } from 'vitest';

import { useMatchAnalysis } from '../../../data/match';
import { HighlightsView } from './HighlightsView';
import { ANALYSIS } from './test/fixtures';
import { markupView, queryResult, viewProps } from './test/renderView';

vi.mock('../../../data/match', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../data/match')>();
  return { ...actual, useMatchAnalysis: vi.fn() };
});

function analysis(overrides: { readonly error?: unknown; readonly pending?: boolean; readonly data?: unknown } = {}) {
  vi.mocked(useMatchAnalysis).mockReturnValue(
    queryResult(
      overrides.pending === true || overrides.error !== undefined
        ? undefined
        : (overrides.data ?? ANALYSIS),
      {
        isPending: overrides.pending ?? false,
        ...(overrides.error === undefined ? {} : { error: overrides.error }),
      },
    ) as never,
  );
}

const Inspector = HighlightsView.Inspector!;

describe('the list', () => {
  it('draws one row per highlight, newest round first', () => {
    analysis();
    const html = markupView(<HighlightsView.Body {...viewProps({ context: { view: 'highlights' } })} />);

    expect(html).toContain('data-match-view="highlights"');
    const order = ['h-21-clutch', 'h-21-wallbang', 'h-18-multi', 'h-7-noscope'].map((id) =>
      html.indexOf(`data-highlight-row="${id}"`),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('prints the analyser’s own label rather than the folded kind', () => {
    analysis();
    const html = markupView(<HighlightsView.Body {...viewProps()} />);
    expect(html).toContain('1v3 残局');
    expect(html).toContain('三杀后拆包，剩余 1.8 秒');
  });

  it('offers a chip per kind that is present, with its count, and none that is not', () => {
    analysis();
    const html = markupView(<HighlightsView.Body {...viewProps()} />);

    expect(html).toContain('残局');
    expect(html).toContain('多杀');
    expect(html).toContain('穿墙');
    expect(html).toContain('盲狙');
    // 赛点 / 经济翻盘 exist in the vocabulary and have no wire kind; a chip for
    // them could only ever produce an empty list.
    expect(html).not.toContain('赛点');
    expect(html).not.toContain('经济翻盘');
  });

  it('states the total beside the filtered count — nothing is silently cut', () => {
    analysis();
    const html = markupView(<HighlightsView.Body {...viewProps()} />);
    expect(html).toContain('共 4 条高光，当前筛出 4 条');
  });

  it('disables 加入作品 with the supplied reason instead of hiding it', () => {
    analysis();
    const html = markupView(<HighlightsView.Body {...viewProps()} />);
    expect(html).toContain('加入作品');
    expect(html).toContain('录制队列尚未接通');
  });

  it('marks the row the address points at', () => {
    analysis();
    const html = markupView(
      <HighlightsView.Body {...viewProps({ context: { round: 21, tick: 148_920 } })} />,
    );
    expect(html).toContain('aria-current="true"');
  });

  it('shows row-shaped skeletons while loading, never a percentage bar', () => {
    analysis({ pending: true });
    const html = markupView(<HighlightsView.Body {...viewProps()} />);
    expect(html).toContain('data-highlight-row-skeleton');
    expect(html).not.toContain('role="progressbar"');
  });

  it('says what an empty detection means, and offers somewhere to go', () => {
    analysis({ data: { ...ANALYSIS, highlights: [] } });
    const html = markupView(<HighlightsView.Body {...viewProps()} />);
    expect(html).toContain('这场比赛没有检出高光');
    expect(html).toContain('逐回合看');
  });

  it('puts a failed read in place with a retry', () => {
    analysis({ error: { message: '索引坏了' } });
    const html = markupView(<HighlightsView.Body {...viewProps()} />);
    expect(html).toContain('读不到这场比赛的高光');
    expect(html).toContain('索引坏了');
  });

  it('sends an unanalysed demo back to the library', () => {
    analysis({ error: { status: 404, message: 'not analysed' } });
    const html = markupView(<HighlightsView.Body {...viewProps()} />);
    // The 404 recovery is shared with the other six views (`NotAnalysedState`):
    // the action is offered here, not only on the page it points at.
    expect(html).toContain('开始分析');
    expect(html).toContain('回到资料库');
  });
});

describe('the Inspector', () => {
  it('describes the highlight the address points at', () => {
    analysis();
    const html = markupView(<Inspector {...viewProps({ context: { round: 21, tick: 149_340 } })} />);

    expect(html).toContain('选中：第 21 回合的高光');
    expect(html).toContain('穿墙');
    expect(html).toContain('A 大道 18.7m');
    expect(html).toContain('把这条高光加入作品');
  });

  it('says what to do when nothing is selected', () => {
    analysis();
    const html = markupView(<Inspector {...viewProps()} />);
    expect(html).toContain('未选中高光');
    expect(html).toContain('这里会显示那条高光的回合、选手与 tick 区间');
  });

  it('folds to a summary strip that still counts the highlights (§8 rule 2)', () => {
    analysis();
    const html = markupView(<Inspector {...viewProps({ collapsed: true })} />);
    expect(html).toContain('共 4 条高光');
    // The main action rides the strip; §8 forbids it entering an overflow.
    expect(html).toContain('data-match-add-to-video');
  });
});
