import { describe, expect, it } from 'vitest';

import { nextScopedFrameIndex, scopeReplayFrames } from './replayRoundScope';

describe('round-scoped replay', () => {
  it('keeps only spatial evidence inside the selected round', () => {
    const frames = [
      { tick: 90 },
      { tick: 100 },
      { tick: 160 },
      { tick: 200 },
      { tick: 201 },
    ];

    expect(scopeReplayFrames(frames, { start_tick: 100, end_tick: 200 }, null)).toEqual({
      frames: [frames[1], frames[2], frames[3]],
      initialIndex: 0,
    });
  });

  it('seeks to a preferred tick only when it belongs to the selected round', () => {
    const frames = [{ tick: 100 }, { tick: 160 }, { tick: 200 }];
    const round = { start_tick: 100, end_tick: 200 };

    expect(scopeReplayFrames(frames, round, 150).initialIndex).toBe(1);
    expect(scopeReplayFrames(frames, round, 201).initialIndex).toBe(0);
  });

  it('loops playback inside the selected round frame list', () => {
    expect(nextScopedFrameIndex(0, 3)).toBe(1);
    expect(nextScopedFrameIndex(2, 3)).toBe(0);
    expect(nextScopedFrameIndex(12, 0)).toBe(0);
  });
});
