import { describe, expect, it, vi } from 'vitest';

import type { AppConfig, ObsDiagnosis, ObsVideoSettings } from '../../shared/api/dto';
import {
  formatObsFrameRate,
  hasUnsavedObsRuntimeSettings,
  retryObsDiagnosis,
} from './obsDiagnostics';

const config = {
  obs: {
    host: '127.0.0.1',
    port: 4455,
    password: '',
    executable: 'C:\\OBS\\obs64.exe',
    scene: 'Capture',
  },
  recording: { resolution: '1920x1080', fps: 60 },
} as AppConfig;

const diagnosis = { ready: true } as ObsDiagnosis;

describe('OBS diagnosis presentation', () => {
  it('detects only settings that affect saved OBS launch or diagnosis', () => {
    expect(hasUnsavedObsRuntimeSettings(config, structuredClone(config))).toBe(false);

    const changed = structuredClone(config);
    changed.obs.scene = 'Replay';
    expect(hasUnsavedObsRuntimeSettings(changed, config)).toBe(true);

    const unrelated = structuredClone(config);
    unrelated.locale = 'en-US';
    expect(hasUnsavedObsRuntimeSettings(unrelated, config)).toBe(false);
  });

  it('formats both integral and rational OBS frame rates', () => {
    const video = { fps_numerator: 60, fps_denominator: 1 } as ObsVideoSettings;
    expect(formatObsFrameRate(video)).toBe('60 FPS');
    expect(formatObsFrameRate({ ...video, fps_numerator: 60_000, fps_denominator: 1_001 }))
      .toBe('59.94 FPS');
  });

  it('retries startup diagnosis with a bounded number of attempts', async () => {
    const diagnose = vi.fn<() => Promise<ObsDiagnosis>>()
      .mockRejectedValueOnce(new Error('not listening'))
      .mockRejectedValueOnce(new Error('still starting'))
      .mockResolvedValue(diagnosis);
    const wait = vi.fn(async () => undefined);

    await expect(retryObsDiagnosis(diagnose, { attempts: 4, delayMs: 0, wait }))
      .resolves.toBe(diagnosis);
    expect(diagnose).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);

    const unavailable = vi.fn<() => Promise<ObsDiagnosis>>()
      .mockRejectedValue(new Error('unavailable'));
    await expect(retryObsDiagnosis(unavailable, { attempts: 999, delayMs: 0, wait }))
      .rejects.toThrow('unavailable');
    expect(unavailable).toHaveBeenCalledTimes(10);
  });
});
