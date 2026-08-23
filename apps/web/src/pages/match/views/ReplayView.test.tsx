/*
 * `markup` project — what 回放与热力图 renders.
 *
 * The reads are replaced with `vi.mock` rather than stubbed at the IPC client:
 * `renderToStaticMarkup` is synchronous, so a real query never settles inside
 * it and every assertion would be about the loading state. The pure exports of
 * `data/match` (`analysisIsMissing`) are kept, because the view branches on one
 * of them.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  useMapRadarOverview,
  useMatchAnalysis,
  useMatchHeatPoints,
  useMatchReplay,
} from '../../../data/match';
import { ReplayView } from './ReplayView';
import { ANALYSIS, HEAT_POINTS, RADAR, REPLAY } from './test/fixtures';
import { markupView, queryResult, viewProps } from './test/renderView';

vi.mock('../../../data/match', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../data/match')>();
  return {
    ...actual,
    useMatchAnalysis: vi.fn(),
    useMatchReplay: vi.fn(),
    useMatchHeatPoints: vi.fn(),
    useMapRadarOverview: vi.fn(),
  };
});

interface LoadedOptions {
  readonly replay?: unknown;
  readonly replayError?: unknown;
  readonly analysisError?: unknown;
  readonly pending?: boolean;
}

function loaded({ replay = REPLAY, replayError, analysisError, pending = false }: LoadedOptions = {}) {
  /* A pending read has no data — the two together would be a state the query
     layer never produces, and a test that renders it proves nothing. */
  vi.mocked(useMatchAnalysis).mockReturnValue(
    queryResult(pending || analysisError !== undefined ? undefined : ANALYSIS, {
      isPending: pending,
      ...(analysisError === undefined ? {} : { error: analysisError }),
    }) as never,
  );
  vi.mocked(useMatchReplay).mockReturnValue(
    queryResult(pending || replayError !== undefined ? undefined : replay, {
      isPending: pending,
      ...(replayError === undefined ? {} : { error: replayError }),
    }) as never,
  );
  vi.mocked(useMatchHeatPoints).mockReturnValue(
    queryResult(pending ? undefined : HEAT_POINTS, { isPending: pending }) as never,
  );
  vi.mocked(useMapRadarOverview).mockReturnValue(
    queryResult(pending ? undefined : RADAR, { isPending: pending }) as never,
  );
}

describe('the body', () => {
  it('draws the artboard’s four layer switches, and only the four it can draw', () => {
    loaded();
    const html = markupView(<ReplayView.Body {...viewProps()} />);

    expect(html).toContain('data-match-view="replay"');
    expect(html).toContain('选手位置');
    expect(html).toContain('移动路线');
    expect(html).toContain('击杀事件');
    expect(html).toContain('热力叠加');
    // 投掷物与火 / C4 生命周期 have no layer in `domain/map`; an inert checkbox
    // would be worse than an absent one.
    expect(html).not.toContain('投掷物与火');
    expect(html).not.toContain('C4 生命周期');
  });

  it('mounts the three switched-on layers and leaves heat off', () => {
    loaded();
    const html = markupView(<ReplayView.Body {...viewProps()} />);

    expect(html).toContain('data-layer="players"');
    expect(html).toContain('data-layer="paths"');
    expect(html).toContain('data-layer="engagements"');
    // 热力叠加 is unchecked on the artboard, so nothing is painted for it.
    expect(html).not.toContain('data-layer="heat"');
  });

  it('lists the roster and marks the focused player', () => {
    loaded();
    const html = markupView(<ReplayView.Body {...viewProps({ context: { player: 'kael' } })} />);

    expect(html).toContain('data-replay-player="kael"');
    expect(html).toContain('data-replay-player="sable"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-player-marker="kael"');
  });

  it('focuses the first roster player by default without needing a URL player', () => {
    loaded();
    const html = markupView(<ReplayView.Body {...viewProps()} />);

    expect(html).toMatch(/data-replay-player="kael"[^>]*aria-pressed="true"/u);
  });

  it('prints the playhead in ticks beside the transport', () => {
    loaded();
    const html = markupView(<ReplayView.Body {...viewProps({ context: { tick: 149_128 } })} />);

    expect(html).toContain('data-replay-transport');
    expect(html).toContain('data-replay-tick="149128"');
    expect(html).toContain('播放控制');
  });

  it('states where the numbers came from, including the thinning factor', () => {
    loaded();
    const html = markupView(<ReplayView.Body {...viewProps()} />);
    expect(html).toContain('坐标来自本地 overview 雷达标定');
    // Nine frames is well inside the sample budget, so nothing is thinned and
    // the sentence about thinning is absent rather than saying 「每 1 帧」.
    expect(html).not.toContain('帧取一个采样点');
  });

  it('offers a floor segment only because this cloud has two floors', () => {
    loaded();
    const html = markupView(<ReplayView.Body {...viewProps()} />);
    expect(html).toContain('楼层只筛热力叠加');
  });

  it('renders the map’s empty state when the round misses the stream', () => {
    loaded();
    // Round 7 runs 52 000–57 400; the fixture stream starts at 149 000.
    const html = markupView(<ReplayView.Body {...viewProps({ context: { round: 7 } })} />);
    expect(html).toContain('第 7 回合落在回放流的范围之外');
    expect(html).toContain('看整场');
  });

  it('puts a failed replay read in place, with a way out', () => {
    loaded({ replayError: { message: '解码失败' } });
    const html = markupView(<ReplayView.Body {...viewProps()} />);
    expect(html).toContain('读不到这场比赛的回放');
    expect(html).toContain('解码失败');
    expect(html).toContain('重新读取回放');
  });

  it('sends an unanalysed demo back to the library rather than showing an error', () => {
    loaded({ analysisError: { status: 404, message: 'not analysed' } });
    const html = markupView(<ReplayView.Body {...viewProps()} />);
    // The 404 recovery is shared with the other six views (`NotAnalysedState`):
    // the action is offered here, not only on the page it points at.
    expect(html).toContain('开始分析');
    expect(html).toContain('回到资料库');
  });

  it('shows a skeleton, no progress bar and no claim about frames while loading', () => {
    loaded({ pending: true });
    const html = markupView(<ReplayView.Body {...viewProps()} />);
    expect(html).toContain('正在读取空间证据');
    // 「加载中 · 骨架（不显示虚构百分比）」: no denominator exists, so no bar.
    expect(html).not.toContain('role="progressbar"');
    // And no provenance line either — 「这一段有 0 帧」 would be a claim.
    expect(html).not.toContain('坐标来自本地 overview');
  });
});

const Inspector = ReplayView.Inspector!;

describe('the Inspector', () => {
  it('is the artboard’s list-view alternative: kills and objectives, in tick order', () => {
    loaded();
    const html = markupView(<Inspector {...viewProps({ context: { round: 21 } })} />);

    expect(html).toContain('第 21 回合 · 事件');
    expect(html).toContain('data-evidence-row="e-kill-sable"');
    expect(html).toContain('data-evidence-row="e-plant"');
    expect(html).toContain('data-evidence-row="e-kill-corvin"');
    // `damage` is not a moment; it is a running total the scoreboard states.
    expect(html).not.toContain('data-evidence-row="e-dmg"');
    expect(html).toContain('只列击杀与目标事件，共 3 条');
  });

  it('carries the workspace’s 加入作品 state and its reason', () => {
    loaded();
    const html = markupView(<Inspector {...viewProps({ context: { round: 21 } })} />);
    expect(html).toContain('把这个回合加入作品');
    expect(html).toContain('录制队列尚未接通');
  });

  it('says what an empty list means instead of showing nothing', () => {
    loaded();
    const html = markupView(<Inspector {...viewProps({ context: { round: 18 } })} />);
    expect(html).toContain('这一段没有可列出的事件');
    expect(html).toContain('看整场');
  });
});
