/*
 * `interaction` project — the playback engine of 回放与热力图.
 *
 * The one thing this file exists to prove is that the loop stops. A
 * `requestAnimationFrame` chain that outlived its component would go on calling
 * `setState` on a dead tree and — worse — would go on writing the address
 * (§4.4) after the user has walked to another view.
 *
 * jsdom does implement `requestAnimationFrame`, but on a real ~16 ms clock,
 * which would make every assertion here a race. So the two functions are
 * replaced with a queue the test drives by hand: `flush` runs whatever is
 * scheduled and advances a fake timestamp, and `pending` is how many callbacks
 * are outstanding. A cancelled handle really leaves the queue, so
 * 「pending === 0」 after unmount is a real statement about cancellation and not
 * about a spy having been called.
 */

import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useMapRadarOverview,
  useMatchAnalysis,
  useMatchHeatPoints,
  useMatchReplay,
} from '../../../data/match';
import type { MatchContextUpdateOptions } from '../viewContract';
import type { MatchContextPatch } from '../workspaceContext';
import { ReplayView } from './ReplayView';
import { ANALYSIS, HEAT_POINTS, RADAR, REPLAY } from './test/fixtures';
import { queryResult, renderView, viewProps } from './test/renderView';

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

/* ── the hand-driven frame queue ─────────────────────────────────────────── */

interface FrameQueue {
  pending(): number;
  flush(deltaMs: number): void;
  restore(): void;
}

function stubAnimationFrame(): FrameQueue {
  const originalRequest = window.requestAnimationFrame;
  const originalCancel = window.cancelAnimationFrame;
  const queue = new Map<number, FrameRequestCallback>();
  let nextHandle = 1;
  let now = 0;

  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const handle = nextHandle;
    nextHandle += 1;
    queue.set(handle, callback);
    return handle;
  }) as typeof window.requestAnimationFrame;

  window.cancelAnimationFrame = ((handle: number) => {
    queue.delete(handle);
  }) as typeof window.cancelAnimationFrame;

  return {
    pending: () => queue.size,
    flush(deltaMs: number) {
      now += deltaMs;
      const due = [...queue.entries()];
      queue.clear();
      act(() => {
        for (const [, callback] of due) callback(now);
      });
    },
    restore() {
      window.requestAnimationFrame = originalRequest;
      window.cancelAnimationFrame = originalCancel;
    },
  };
}

let frames: FrameQueue | null = null;

beforeEach(() => {
  vi.mocked(useMatchAnalysis).mockReturnValue(queryResult(ANALYSIS) as never);
  vi.mocked(useMatchReplay).mockReturnValue(queryResult(REPLAY) as never);
  vi.mocked(useMatchHeatPoints).mockReturnValue(queryResult(HEAT_POINTS) as never);
  vi.mocked(useMapRadarOverview).mockReturnValue(queryResult(RADAR) as never);
  frames = stubAnimationFrame();
});

afterEach(() => {
  frames?.restore();
  frames = null;
  vi.restoreAllMocks();
});

function tick(): number {
  const value = document.querySelector('[data-replay-tick]')?.getAttribute('data-replay-tick');
  return value === null || value === undefined || value === '' ? Number.NaN : Number(value);
}

function play(): void {
  fireEvent.click(screen.getByRole('button', { name: '播放' }));
}

describe('the playback loop', () => {
  it('advances the playhead while playing', () => {
    renderView(<ReplayView.Body {...viewProps()} />);
    expect(tick()).toBe(149_000);
    expect(frames?.pending()).toBe(0);

    play();
    expect(document.querySelector('[data-playing="true"]')).not.toBeNull();
    expect(frames?.pending()).toBe(1);

    // The first callback only establishes a baseline; the second releases a
    // step, because the loop accumulates and fires at STEP_MS.
    frames?.flush(100);
    expect(tick()).toBe(149_000);
    frames?.flush(100);
    // 0.1 s at 1× on a 64-tick stream.
    expect(tick()).toBe(149_006);
  });

  it('stops the loop when unmounted, and the queue really is empty', () => {
    const updateContext = vi.fn();
    const view = renderView(<ReplayView.Body {...viewProps({ updateContext })} />);

    play();
    frames?.flush(100);
    frames?.flush(100);
    const advanced = tick();
    expect(advanced).toBeGreaterThan(149_000);
    // Playing, so exactly one callback is outstanding.
    expect(frames?.pending()).toBe(1);

    const writesBefore = updateContext.mock.calls.length;
    view.unmount();

    // The effect's teardown cancelled the outstanding handle.
    expect(frames?.pending()).toBe(0);

    // And nothing revives it: flushing an empty queue runs nothing, schedules
    // nothing, and writes no more addresses.
    frames?.flush(100);
    frames?.flush(100);
    expect(frames?.pending()).toBe(0);
    expect(updateContext.mock.calls.length).toBe(writesBefore);
  });

  it('stops the loop on pause as well as on unmount', () => {
    renderView(<ReplayView.Body {...viewProps()} />);
    play();
    frames?.flush(100);
    expect(frames?.pending()).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: '暂停' }));
    expect(frames?.pending()).toBe(0);
  });

  it('throttles the address instead of writing it on every step', () => {
    const updateContext = vi.fn<(patch: MatchContextPatch, options?: MatchContextUpdateOptions) => void>();
    renderView(<ReplayView.Body {...viewProps({ updateContext })} />);

    play();
    // Eight steps of 100 ms is 0.8 s of wall clock — inside one throttle window.
    for (let index = 0; index < 9; index += 1) frames?.flush(100);

    const tickWrites = updateContext.mock.calls.filter(([patch]) => patch.tick !== undefined);
    expect(tickWrites.length).toBe(1);
    // A scrub is not navigation.
    expect(tickWrites[0]?.[1]).toEqual({ replace: true });
  });

  it('writes the address at once for a deliberate seek', () => {
    const updateContext = vi.fn<(patch: MatchContextPatch, options?: MatchContextUpdateOptions) => void>();
    renderView(<ReplayView.Body {...viewProps({ updateContext })} />);

    fireEvent.click(screen.getByRole('button', { name: '跳到出点' }));

    const tickWrites = updateContext.mock.calls.filter(([patch]) => patch.tick !== undefined);
    expect(tickWrites).toHaveLength(1);
    expect(tickWrites[0]?.[0].tick).toBe(149_512);
  });
});

describe('the layer switches', () => {
  it('paints the heat overlay only once it is switched on', () => {
    renderView(<ReplayView.Body {...viewProps({ context: { round: 21 } })} />);
    expect(document.querySelector('[data-layer="heat"]')).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: '热力叠加' }));

    const heat = document.querySelector('[data-layer="heat"]');
    expect(heat).not.toBeNull();
    // Binned, not scattered: `HeatLayer` takes a distribution and the bin count
    // is what bounds the node count.
    expect(Number(heat?.getAttribute('data-bins'))).toBeGreaterThan(0);
    // And the legend appears beside the switch that produced it.
    expect(screen.getByText(/当前统计：第 21 回合的位置事件/u)).toBeTruthy();
  });

  it('takes a layer away again', () => {
    renderView(<ReplayView.Body {...viewProps()} />);
    expect(document.querySelector('[data-layer="paths"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: '移动路线' }));
    expect(document.querySelector('[data-layer="paths"]')).toBeNull();
  });
});

describe('selection', () => {
  it('focuses a player through the address, not through local state', () => {
    const updateContext = vi.fn<(patch: MatchContextPatch, options?: MatchContextUpdateOptions) => void>();
    renderView(<ReplayView.Body {...viewProps({ updateContext })} />);

    fireEvent.click(screen.getByRole('button', { name: /Kael/u }));
    expect(updateContext).toHaveBeenCalledWith({ player: 'kael' });
  });

  it('takes a duel on the canvas to its tick and its evidence id', () => {
    const updateContext = vi.fn<(patch: MatchContextPatch, options?: MatchContextUpdateOptions) => void>();
    renderView(<ReplayView.Body {...viewProps({ updateContext, context: { round: 21 } })} />);

    const duel = document.querySelector('[data-engagement="e-kill-sable"]');
    expect(duel).not.toBeNull();
    fireEvent.click(duel as Element);

    expect(updateContext).toHaveBeenCalledWith(
      { evidence: 'e-kill-sable', tick: 149_128 },
      { replace: true },
    );
  });
});
