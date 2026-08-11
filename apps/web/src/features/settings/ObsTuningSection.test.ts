import { describe, expect, it } from 'vitest';

import type { ObsVideoBackup, ObsVideoTuningPlan } from '../../shared/desktop/dto';
import {
  canCommitObsTuningRefresh,
  obsTuningGateState,
  toObsTuningPanelState,
} from './ObsTuningSection';

const plan: ObsVideoTuningPlan = {
  current: {
    base_width: 2560,
    base_height: 1440,
    output_width: 1280,
    output_height: 720,
    fps_numerator: 60_000,
    fps_denominator: 1_001,
  },
  target: {
    base_width: 2560,
    base_height: 1440,
    output_width: 1920,
    output_height: 1080,
    fps_numerator: 60,
    fps_denominator: 1,
  },
  diff: [
    { field: 'output_resolution', current: '1280x720', target: '1920x1080' },
    { field: 'frame_rate', current: '60000/1001', target: '60/1' },
  ],
  expected_fingerprint: 'a'.repeat(64),
  recording_active: false,
  warnings: ['OBS output video settings already match the saved defaults', 'future warning'],
  managed_fields: ['output_resolution', 'frame_rate'],
  excluded_fields: ['base_canvas', 'encoder', 'bitrate', 'scene'],
};

const backup: ObsVideoBackup = {
  id: '7ca5306c-57ff-4127-9c62-bf5a664151b1',
  created_at: 'invalid-but-preserved',
  reason: 'before_restore',
  settings: plan.current,
  settings_fingerprint: 'b'.repeat(64),
};

describe('OBS tuning presentation', () => {
  it('reports loading, browser preview, missing saved config, and unsaved edits honestly', () => {
    const base = {
      serviceAvailable: true,
      serviceLoading: false,
      savedConfigAvailable: true,
      savedObsConfigured: true,
      hasUnsavedRuntimeSettings: false,
    };

    expect(obsTuningGateState({ ...base, serviceLoading: true })).toMatchObject({ status: 'loading' });
    expect(obsTuningGateState({ ...base, serviceAvailable: false })).toMatchObject({
      status: 'unavailable',
      message: expect.stringContaining('不会伪造'),
    });
    expect(obsTuningGateState({ ...base, savedConfigAvailable: false })).toMatchObject({
      status: 'unavailable',
      message: expect.stringContaining('先保存'),
    });
    expect(obsTuningGateState({ ...base, hasUnsavedRuntimeSettings: true })).toMatchObject({
      status: 'unavailable',
      message: expect.stringContaining('未保存'),
    });
    expect(obsTuningGateState(base)).toBeNull();
  });

  it('maps wire values without hiding rational FPS or excluded fields', () => {
    const state = toObsTuningPanelState(plan, [backup]);

    expect(state.status).toBe('ready');
    if (state.status !== 'ready') throw new Error('expected ready state');
    expect(state.plan.currentResolution).toBe('1280 × 720');
    expect(state.plan.currentFrameRate).toBe('60000/1001 · 59.94 FPS');
    expect(state.plan.targetFrameRate).toBe('60/1 · 60 FPS');
    expect(state.plan.changes.map((change) => change.label)).toEqual(['成片分辨率', '帧率']);
    expect(state.plan.excludedFields).toEqual(['基础画布', '编码器', '码率', '场景']);
    expect(state.plan.warnings).toEqual([
      'OBS 输出视频设置已匹配保存的录制默认值。',
      'future warning',
    ]);
    expect(state.backups[0]).toMatchObject({
      reason: '恢复前',
      createdAt: 'invalid-but-preserved',
      resolution: '1280 × 720',
    });
  });

  it('rejects stale, aborted, and newly gated refresh responses', () => {
    const unsavedGate = obsTuningGateState({
      serviceAvailable: true,
      serviceLoading: false,
      savedConfigAvailable: true,
      savedObsConfigured: true,
      hasUnsavedRuntimeSettings: true,
    });

    expect(canCommitObsTuningRefresh(4, 4, false, null)).toBe(true);
    expect(canCommitObsTuningRefresh(3, 4, false, null)).toBe(false);
    expect(canCommitObsTuningRefresh(4, 4, true, null)).toBe(false);
    expect(canCommitObsTuningRefresh(4, 4, false, unsavedGate)).toBe(false);
  });
});
