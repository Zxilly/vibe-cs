import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  ObsTuningPanel,
  canApplyObsTuning,
  type ObsTuningPanelState,
  type ObsTuningPlanView,
} from './ObsTuningPanel';

const plan: ObsTuningPlanView = {
  expectedFingerprint: 'a'.repeat(64),
  recordingActive: false,
  currentResolution: '1280 × 720',
  currentFrameRate: '30 FPS',
  targetResolution: '1920 × 1080',
  targetFrameRate: '60 FPS',
  changes: [
    { id: 'output_resolution', label: '成片分辨率', current: '1280x720', target: '1920x1080' },
    { id: 'frame_rate', label: '帧率', current: '30/1', target: '60/1' },
  ],
  warnings: [],
  excludedFields: ['基础画布', '编码器', '码率', '场景'],
};

const ready: ObsTuningPanelState = {
  status: 'ready',
  plan,
  backups: [{
    id: '7ca5306c-57ff-4127-9c62-bf5a664151b1',
    createdAt: '2026-08-10 14:30',
    reason: '应用前',
    resolution: '1280 × 720',
    frameRate: '30 FPS',
  }],
};

const callbacks = {
  onRefresh: vi.fn(async () => undefined),
  onApply: vi.fn(async () => ({ message: 'applied' })),
  onRestore: vi.fn(async () => ({ message: 'restored' })),
  onDelete: vi.fn(async () => ({ message: 'deleted' })),
};

describe('OBS tuning panel', () => {
  it('requires explicit confirmation and blocks plans while recording', () => {
    expect(canApplyObsTuning(plan, false, null)).toBe(false);
    expect(canApplyObsTuning(plan, true, null)).toBe(true);
    expect(canApplyObsTuning({ ...plan, recordingActive: true }, true, null)).toBe(false);
    expect(canApplyObsTuning(plan, true, 'refresh')).toBe(false);
  });

  it('renders an honest bounded scope, diff, and backup history', () => {
    const markup = renderToStaticMarkup(<ObsTuningPanel state={ready} {...callbacks} />);

    expect(markup).toContain('成片分辨率与有理帧率');
    expect(markup).toContain('基础画布、编码器、码率和场景均不在计划内');
    expect(markup).toContain('不会执行所谓的全自动调优');
    expect(markup).toContain('1280x720');
    expect(markup).toContain('1920x1080');
    expect(markup).toContain('7ca5306c');
    expect(markup).toContain('最多保留 32 份不含密码');
    expect(markup).toContain('确认应用计划');
    expect(markup).toContain('disabled');
  });

  it('does not expose mutation controls as usable when the service is unavailable', () => {
    const markup = renderToStaticMarkup(
      <ObsTuningPanel
        state={{ status: 'unavailable', message: '本地服务未连接。' }}
        {...callbacks}
      />,
    );

    expect(markup).toContain('本地服务未连接');
    expect(markup).not.toContain('确认应用计划');
    expect(callbacks.onApply).not.toHaveBeenCalled();
  });
});
