import { describe, expect, it } from 'vitest';

import {
  createFittedTimeScale,
  createTimeScale,
  formatMillisecondTimecode,
  rulerTicks,
  timelineFollowScroll,
  timeToPx,
} from './timeScale';

describe('timeline time scale', () => {
  it('keeps ruler and content positions in the same pixel space', () => {
    const scale = createTimeScale(0.5);
    const tick = rulerTicks(scale, { toSeconds: 180 }).find((value) => value.time === 30);
    expect(tick?.px).toBe(timeToPx(scale, 30));
  });

  it('formats proposal and playhead milliseconds without rollover drift', () => {
    expect(formatMillisecondTimecode(183.4)).toBe('03:03.400');
    expect(formatMillisecondTimecode(59.9996)).toBe('01:00.000');
  });

  it('fits long sequences below the ordinary interactive zoom ladder', () => {
    const scale = createFittedTimeScale(900, 7_200);
    expect(timeToPx(scale, 7_200)).toBeCloseTo(900);
    expect(scale.zoom).toBeLessThan(0.125);
  });

  it('uses Premiere page-follow during playback and minimal reveal while paused', () => {
    expect(timelineFollowScroll({
      scrollPx: 0,
      playheadPx: 1_001,
      viewportPx: 1_000,
      mode: 'page',
    })).toBe(1_000);
    expect(timelineFollowScroll({
      scrollPx: 0,
      playheadPx: 1_001,
      viewportPx: 1_000,
      mode: 'reveal',
    })).toBe(21);
    expect(timelineFollowScroll({
      scrollPx: 0,
      playheadPx: 2_501,
      viewportPx: 1_000,
      mode: 'page',
    })).toBe(2_000);
  });
});
