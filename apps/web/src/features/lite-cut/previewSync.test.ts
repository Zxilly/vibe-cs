import { describe, expect, it, vi } from 'vitest';

import { synchronizeMediaPreview, type PreviewMediaTarget } from './previewSync';

const mediaTarget = (duration: number): PreviewMediaTarget => ({
  currentTime: 0,
  duration,
  volume: 1,
  playbackRate: 1,
  pause: vi.fn(),
  play: vi.fn().mockResolvedValue(undefined),
});

describe('selected clip media synchronization', () => {
  it('seeks to the source offset after metadata becomes available', () => {
    const target = mediaTarget(Number.NaN);
    synchronizeMediaPreview(target, 12, 0.5, 2, false);
    expect(target.currentTime).toBe(0);

    Object.defineProperty(target, 'duration', { value: 30, configurable: true });
    synchronizeMediaPreview(target, 12, 0.5, 2, false);

    expect(target.currentTime).toBe(12);
    expect(target.volume).toBe(0.5);
    expect(target.playbackRate).toBe(2);
    expect(target.pause).toHaveBeenCalledTimes(2);
  });
});
