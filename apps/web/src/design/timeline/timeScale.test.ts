import { describe, expect, it } from 'vitest';

import { createTimeScale, formatMillisecondTimecode, rulerTicks, timeToPx } from './timeScale';

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
});
