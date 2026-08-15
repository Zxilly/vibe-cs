/*
 * `markup` project — what Review 与注释 renders.
 *
 * The condition the artboard sets for this panel is that both columns cite
 * evidence and that an unavailable capability is drawn as such rather than
 * filled with a derived number. Both are asserted here, in both directions:
 * with the capabilities on, and with them off.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  useCreateMatchAnnotation,
  useDeleteMatchAnnotation,
  useGenerateMatchReview,
  useMatchAnalysis,
  useMatchAnnotations,
  useUpdateMatchAnnotation,
} from '../../../data/match';
import { ReviewView } from './ReviewView';
import {
  ANALYSIS,
  ANALYSIS_WITHOUT_INSIGHTS,
  ANNOTATIONS,
  REVIEW_RESULT,
} from './test/fixtures';
import { markupView, mutationResult, queryResult, viewProps } from './test/renderView';

vi.mock('../../../data/match', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../data/match')>();
  return {
    ...actual,
    useMatchAnalysis: vi.fn(),
    useMatchAnnotations: vi.fn(),
    useGenerateMatchReview: vi.fn(),
    useCreateMatchAnnotation: vi.fn(),
    useUpdateMatchAnnotation: vi.fn(),
    useDeleteMatchAnnotation: vi.fn(),
  };
});

interface SceneOptions {
  readonly analysis?: unknown;
  readonly analysisError?: unknown;
  readonly pending?: boolean;
  readonly reviewData?: unknown;
  readonly reviewError?: unknown;
}

function scene(options: SceneOptions = {}) {
  const { analysis = ANALYSIS, analysisError, pending = false, reviewData, reviewError } = options;
  vi.mocked(useMatchAnalysis).mockReturnValue(
    queryResult(pending || analysisError !== undefined ? undefined : analysis, {
      isPending: pending,
      ...(analysisError === undefined ? {} : { error: analysisError }),
    }) as never,
  );
  vi.mocked(useMatchAnnotations).mockReturnValue(
    queryResult(pending ? undefined : ANNOTATIONS, { isPending: pending }) as never,
  );
  vi.mocked(useGenerateMatchReview).mockReturnValue(
    mutationResult({
      data: reviewData,
      error: reviewError ?? null,
    }) as never,
  );
  vi.mocked(useCreateMatchAnnotation).mockReturnValue(mutationResult() as never);
  vi.mocked(useUpdateMatchAnnotation).mockReturnValue(mutationResult() as never);
  vi.mocked(useDeleteMatchAnnotation).mockReturnValue(mutationResult() as never);
}

const Inspector = ReviewView.Inspector!;

describe('自动洞察', () => {
  it('draws one card per rule the document can actually answer', () => {
    scene();
    const html = markupView(<ReviewView.Body {...viewProps({ context: { view: 'review' } })} />);

    expect(html).toContain('data-match-view="review"');
    expect(html).toContain('data-insight="opening-kills"');
    expect(html).toContain('data-insight="matchup"');
    expect(html).toContain('data-insight="utility"');
    expect(html).toContain('自动洞察 · 由规则从证据推出');
  });

  it('states the count each rule was derived from', () => {
    scene();
    const html = markupView(<ReviewView.Body {...viewProps()} />);
    expect(html).toContain('首杀取每个回合最早的一次击杀事件');
    expect(html).toContain('这场共记录了 1 组对位');
    expect(html).toContain('闪到 7 人次');
  });

  it('draws an unavailable capability as the dashed card, in the service’s words', () => {
    scene();
    const html = markupView(<ReviewView.Body {...viewProps()} />);
    expect(html).toContain('data-insight-gap="purchase_events"');
    expect(html).toContain('这批 Demo 没有购买事件，经济曲线画不出来。');
    // A refusal without a sentence still says it is a refusal.
    expect(html).toContain('data-insight-gap="purchase_spend"');
    expect(html).toContain('服务没有说明原因；这一项不用推算值填空。');
  });

  it('draws no card at all when every capability is off', () => {
    scene({ analysis: ANALYSIS_WITHOUT_INSIGHTS });
    const html = markupView(<ReviewView.Body {...viewProps()} />);
    expect(html).not.toContain('data-insight="matchup"');
    expect(html).not.toContain('data-insight="utility"');
    expect(html).toContain('data-insight-gap="matchups"');
    expect(html).toContain('这份解析没有逐对位归因。');
  });
});

describe('AI 点评', () => {
  it('says what an empty column means rather than showing nothing', () => {
    scene();
    const html = markupView(<ReviewView.Body {...viewProps()} />);
    expect(html).toContain('没有配置模型时这一栏不会有内容，自动洞察不受影响');
    expect(html).toContain('语气：专业');
  });

  it('prints the prose, every cited id, and where the words came from', () => {
    scene({ reviewData: REVIEW_RESULT });
    const html = markupView(<ReviewView.Body {...viewProps()} />);

    expect(html).toContain('Aurora 赢在中路的信息优势。');
    expect(html).toContain('引用了 3 条证据');
    // Resolved against the two id spaces this match has…
    expect(html).toContain('data-citation="highlight"');
    expect(html).toContain('data-citation="event"');
    // …and the one that resolves to neither is still listed, because the claim
    // is that every id the model was given is shown.
    expect(html).toContain('data-citation="unknown"');
    expect(html).toContain('unknown-evidence');
    expect(html).toContain('gpt-test');
    expect(html).toContain('这次直接用了同一批证据上次的结果');
  });

  it('renders a failed generation in place, with a way out', () => {
    scene({ reviewError: { message: '没有配置模型' } });
    const html = markupView(<ReviewView.Body {...viewProps()} />);
    expect(html).toContain('生成点评失败');
    expect(html).toContain('没有配置模型');
    expect(html).toContain('自动洞察不受影响');
  });

  it('keeps 导出 HTML 可见但禁用，并说明原因', () => {
    scene();
    const html = markupView(<ReviewView.Body {...viewProps()} />);
    expect(html).toContain('导出 HTML');
    expect(html).toContain('没有导出复盘 HTML 的命令');
  });
});

describe('我的注释', () => {
  it('counts them on the tab and previews them beside the prose', () => {
    scene();
    const html = markupView(<ReviewView.Body {...viewProps()} />);
    expect(html).toContain('R21 的穿墙点可做教学');
    expect(html).toContain('待处理');
    expect(html).toContain('已处理');
  });
});

describe('the Inspector', () => {
  it('splits the tally and states why a new note may not be possible', () => {
    scene();
    const html = markupView(<Inspector {...viewProps()} />);
    expect(html).toContain('结论与注释');
    expect(html).toContain('地址里还没有选中的证据');
  });

  it('changes its sentence once the address carries an anchor', () => {
    scene();
    const html = markupView(
      <Inspector {...viewProps({ context: { evidence: 'e-kill-sable', round: 21, tick: 149_128 } })} />,
    );
    expect(html).toContain('当前锚点是一条证据');
  });
});

describe('three states', () => {
  it('shows skeletons while the document is in flight', () => {
    scene({ pending: true });
    const html = markupView(<ReviewView.Body {...viewProps()} />);
    expect(html).toContain('animate-pulse');
    expect(html).not.toContain('role="progressbar"');
  });

  it('sends an unanalysed demo back to the library', () => {
    scene({ analysisError: { status: 404, message: 'not analysed' } });
    const html = markupView(<ReviewView.Body {...viewProps()} />);
    // The 404 recovery is shared with the other six views (`NotAnalysedState`):
    // the action is offered here, not only on the page it points at.
    expect(html).toContain('开始分析');
    expect(html).toContain('回到资料库');
  });

  it('puts a failed read in place with a retry', () => {
    scene({ analysisError: { message: '解析结果损坏' } });
    const html = markupView(<ReviewView.Body {...viewProps()} />);
    expect(html).toContain('读不到这场比赛的分析结果');
    expect(html).toContain('解析结果损坏');
  });
});
