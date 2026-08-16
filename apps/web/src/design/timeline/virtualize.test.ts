import { describe, expect, it } from 'vitest';

import { createSampleTimeline } from './sampleTimeline';
import { createTimeline, type Timeline } from './timelineModel';
import { createTimeScale } from './timeScale';
import { culledClipCount, DEFAULT_OVERSCAN_PX, visibleClips, visibleTimeRange } from './virtualize';

const AT_100 = createTimeScale(1); // 12 px/s

/** A match's worth of kill clips: 500 one-second clips, two seconds apart. */
function dense(): Timeline {
  return createTimeline({
    tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面' }],
    clips: Array.from({ length: 500 }, (_, index) => ({
      id: `k${index}`,
      trackId: 'v1',
      start: index * 2,
      duration: 1,
      sourceIn: 0,
      sourceDuration: 4,
      label: `kill ${index}`,
    })),
  });
}

describe('visibleTimeRange', () => {
  it('is the window plus a band each way', () => {
    const range = visibleTimeRange(AT_100, { scrollPx: 1200, widthPx: 1200 }, 600);
    expect(range.from).toBeCloseTo(50, 9); // (1200 − 600) / 12
    expect(range.to).toBeCloseTo(250, 9); // (1200 + 1200 + 600) / 12
  });

  it('does not run before the start of the sequence', () => {
    expect(visibleTimeRange(AT_100, { scrollPx: 0, widthPx: 1200 }).from).toBe(0);
  });

  it('narrows as the view zooms in', () => {
    const wide = visibleTimeRange(createTimeScale(0.125), { scrollPx: 0, widthPx: 1200 }, 0);
    const close = visibleTimeRange(createTimeScale(16), { scrollPx: 0, widthPx: 1200 }, 0);
    expect(wide.to).toBeGreaterThan(close.to * 100);
  });
});

describe('visibleClips', () => {
  it('renders everything before the viewport has been measured', () => {
    // First paint, before the ref has a layout. Culling to a zero-width window
    // would render an empty timeline and then fill it in, which flashes.
    const timeline = dense();
    expect(visibleClips(timeline, AT_100, { scrollPx: 0, widthPx: 0 })).toHaveLength(500);
  });

  it('drops the clips outside the window', () => {
    const timeline = dense();
    const mounted = visibleClips(timeline, AT_100, { scrollPx: 0, widthPx: 1200 }, { overscanPx: 0 });
    // 1200px at 12 px/s is [0, 100), and the clips sit at 0, 2, 4 … so k0
    // through k49 are in it. k50 starts exactly at 100 — the far edge is
    // exclusive, the same convention `rangesOverlap` uses for two clips that
    // merely touch.
    expect(mounted).toHaveLength(50);
    expect(mounted[0]?.id).toBe('k0');
    expect(mounted.at(-1)?.id).toBe('k49');
    expect(culledClipCount(timeline, AT_100, { scrollPx: 0, widthPx: 1200 }, { overscanPx: 0 })).toBe(450);
  });

  it('keeps a clip that merely straddles an edge', () => {
    // A clip starting before the window and ending inside it is on screen.
    const timeline = createTimeline({
      tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面' }],
      clips: [{ id: 'long', trackId: 'v1', start: 0, duration: 600, sourceIn: 0, sourceDuration: 600, label: 'L' }],
    });
    expect(visibleClips(timeline, AT_100, { scrollPx: 3000, widthPx: 1200 }, { overscanPx: 0 })).toHaveLength(1);
  });

  it('mounts the overscan band as well', () => {
    const timeline = dense();
    const tight = visibleClips(timeline, AT_100, { scrollPx: 2400, widthPx: 1200 }, { overscanPx: 0 });
    const banded = visibleClips(timeline, AT_100, { scrollPx: 2400, widthPx: 1200 });
    expect(banded.length).toBeGreaterThan(tight.length);
    // 600px each way at 12 px/s is 50s each way, i.e. 25 clips each side.
    expect(banded.length - tight.length).toBe(50);
    expect(DEFAULT_OVERSCAN_PX).toBe(600);
  });

  it('never culls what the pointer or the Inspector is holding', () => {
    // A clip being dragged travels away from where it is; losing its node
    // mid-gesture would strand the drag.
    const timeline = dense();
    const far = visibleClips(timeline, AT_100, { scrollPx: 0, widthPx: 1200 }, {
      overscanPx: 0,
      keepIds: new Set(['k400']),
    });
    expect(far.some((clip) => clip.id === 'k400')).toBe(true);
    expect(far).toHaveLength(51);
  });

  it('preserves the document’s order', () => {
    // The renderer groups by lane and relies on clips arriving in start order,
    // which `createTimeline` established; filtering must not disturb it.
    const timeline = createSampleTimeline();
    const mounted = visibleClips(timeline, AT_100, { scrollPx: 0, widthPx: 4000 });
    expect(mounted.map((clip) => clip.id)).toEqual(timeline.clips.map((clip) => clip.id));
  });
});
