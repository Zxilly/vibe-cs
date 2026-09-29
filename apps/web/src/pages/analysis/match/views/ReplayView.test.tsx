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
} from '../../../../data/match';
import { ReplayView } from './ReplayView';
import { NativeShellProvider, unavailableNativeShell } from '../../../../data/nativeShell';
import { ANALYSIS, HEAT_POINTS, RADAR, REPLAY } from '../../../../test/fixtures/matchAnalysis';
import { markupView, queryResult, viewProps } from './test/renderView';

vi.mock('../../../../data/match', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../data/match')>();
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
  it('renders the returned radar through the native media seam under the same calibrated layers', () => {
    loaded();
    vi.mocked(useMapRadarOverview).mockReturnValue(queryResult({
      ...RADAR,
      image_url: '/api/maps/de_mirage/radar',
      image_mime: 'image/png',
      browser_displayable: true,
    }) as never);
    const mediaSrc = vi.fn(() => 'http://vibe-cs-media.localhost/maps/de_mirage/radar');
    const html = markupView(
      <NativeShellProvider shell={{ ...unavailableNativeShell, available: true, mediaSrc }}>
        <ReplayView.Body {...viewProps()} />
      </NativeShellProvider>,
    );
    expect(mediaSrc).toHaveBeenCalledWith('/api/maps/de_mirage/radar');
    expect(html).toContain('data-replay-basemap="true"');
    expect(html).toContain('src="http://vibe-cs-media.localhost/maps/de_mirage/radar"');
    expect(html).toContain('data-map-basemap-viewport="full"');
    expect(html).toContain('data-layer="players"');
    expect(html).not.toContain('data-testid="map-blueprint-grid"');
  });

  it('retains the coordinate grid when a returned radar is not browser-displayable', () => {
    loaded();
    vi.mocked(useMapRadarOverview).mockReturnValue(queryResult({
      ...RADAR, image_url: '/api/maps/de_mirage/radar', browser_displayable: false,
    }) as never);
    const html = markupView(<ReplayView.Body {...viewProps()} />);
    expect(html).not.toContain('data-replay-basemap');
    expect(html).toContain('data-testid="map-blueprint-grid"');
    expect(html).toContain('data-layer="players"');
  });

  it('starts with a focused map and keeps historical overlays out of the way', () => {
    loaded();
    const html = markupView(<ReplayView.Body {...viewProps()} />);
    expect(html).toContain('data-layer="players"');
    expect(html).not.toContain('data-layer="paths"');
    expect(html).not.toContain('data-layer="engagements"');
    expect(html).not.toContain('data-layer="heat"');
    expect(html).not.toContain('data-replay-rail');
    expect(html).toContain('2D 地图');
    expect(html).toContain('3D 视图');
    expect(html).toMatch(/option value="kael" selected/u);
  });

  it('keeps the exact playhead for transport without displaying raw ticks', () => {
    loaded();
    const html = markupView(<ReplayView.Body {...viewProps({ context: { tick: 149_128 } })} />);

    expect(html).toContain('data-replay-transport');
    expect(html).toContain('data-replay-tick="149128"');
    expect(html).toContain('播放控制');
  });

  it('omits implementation metadata from the replay surface', () => {
    loaded();
    const html = markupView(<ReplayView.Body {...viewProps()} />);
    expect(html).not.toContain('坐标来自本地 overview');
    expect(html).not.toContain('帧取一个采样点');
    expect(html).not.toContain('楼层只筛热力叠加');
    expect(html).not.toContain(' Hz');
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
    expect(html).not.toContain('精确来源与身份');
    expect(new DOMParser().parseFromString(html, 'text/html').body.textContent).not.toContain('tick');
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
