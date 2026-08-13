import { describe, expect, it } from 'vitest';

import { replayFrameDelayMs } from './replayClock';

describe('replay frame clock', () => {
  it('compresses the real M1 sparse gap instead of pretending to wait in real time', () => {
    expect(replayFrameDelayMs(72_447, 84_555, 64, 1, 'event_sparse')).toBe(750);
    expect(replayFrameDelayMs(72_447, 84_555, 64, 0.5, 'event_sparse')).toBe(1_500);
    expect(replayFrameDelayMs(72_447, 84_555, 64, 2, 'event_sparse')).toBe(375);
  });

  it('uses the recorded tick distance instead of a fixed frame interval', () => {
    expect(replayFrameDelayMs(1_000, 1_064, 64, 1)).toBe(1_000);
    expect(replayFrameDelayMs(1_000, 1_008, 64, 1)).toBe(125);
    expect(replayFrameDelayMs(1_000, 1_064, 64, 2)).toBe(500);
  });

  it('keeps valid entity snapshot gaps on the recorded tick clock', () => {
    expect(replayFrameDelayMs(72_447, 84_555, 64, 1, 'entity_snapshots')).toBe(189_187.5);
  });

  it('uses a bounded fallback for invalid or discontinuous replay data', () => {
    expect(replayFrameDelayMs(1_064, 1_000, 64, 1)).toBe(100);
    expect(replayFrameDelayMs(1_000, 1_064, 0, 1)).toBe(100);
    expect(replayFrameDelayMs(1_000, 1_064, 64, 0)).toBe(100);
  });
});
