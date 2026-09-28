import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { usePlaybackClock } from './usePlaybackClock';

afterEach(() => vi.unstubAllGlobals());

it('feeds the renderer every frame while publishing React state on the same throttled clock', () => {
  let id = 0;
  const pending = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { pending.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => pending.delete(handle));
  const frame = (time: number) => act(() => {
    const callbacks = [...pending.values()]; pending.clear();
    callbacks.forEach((callback) => callback(time));
  });
  let rendererTime = 0;
  const publications: number[] = [];
  const onFrame = vi.fn((seconds: number) => { rendererTime += seconds; });
  const view = renderHook(({ playing }) => usePlaybackClock({
    playing, onFrame, onAdvance: () => publications.push(rendererTime),
  }), { initialProps: { playing: true } });
  frame(0); frame(16); frame(32); frame(48);
  expect(onFrame).toHaveBeenCalledTimes(3);
  expect(rendererTime).toBeCloseTo(0.048);
  expect(publications).toEqual([0.032]);
  frame(2_000);
  expect(rendererTime).toBeCloseTo(0.048);
  view.rerender({ playing: false });
  expect(pending.size).toBe(0);
  view.unmount();
});
