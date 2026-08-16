/*
 * `markup` project — the wire record turned into the display model.
 *
 * These are the four decisions the module header states, asserted rather than
 * described: the montage inference, the progress denominator rule, the honest
 * failure reason, and the stage translation.
 */

import { describe, expect, it } from 'vitest';

import type { ActivityItem } from '../../shared/desktop/viewModels';
import {
  taskKindOfActivity,
  taskProgressOfActivity,
  taskStagePositionOf,
  taskStatusOfActivity,
  toTaskSummary,
} from './taskModel';

const ITEM: ActivityItem = {
  id: 'recording:job-1',
  kind: 'recording',
  subtype: null,
  job_id: 'job-1',
  context_id: 'demo-1',
  subject: 'Kael_Mirage_1v3',
  status: 'running',
  stage: 'recording.stage.capturing',
  progress_percent: null,
  completed_units: 3,
  total_units: 5,
  unit: 'stages',
  error: null,
  failure: null,
  created_at: '2026-08-15T09:05:00.000Z',
  updated_at: '2026-08-15T09:11:41.000Z',
  available_actions: ['cancel', 'open_outputs'],
};

describe('kind', () => {
  it('reads 合辑 off the export subtype, the only place it exists', () => {
    expect(taskKindOfActivity(ITEM)).toBe('recording');
    expect(taskKindOfActivity({ ...ITEM, kind: 'export', subtype: 'montage' })).toBe('montage');
    expect(taskKindOfActivity({ ...ITEM, kind: 'export', subtype: 'editor' })).toBe('export');
    // An unrecognised subtype stays 导出 rather than becoming a sixth kind.
    expect(taskKindOfActivity({ ...ITEM, kind: 'export', subtype: 'something-new' })).toBe('export');
  });
});

describe('status', () => {
  it('folds the pipeline s own middles into 运行中', () => {
    expect(taskStatusOfActivity('downloading')).toBe('running');
    expect(taskStatusOfActivity('decompressing')).toBe('running');
    expect(taskStatusOfActivity('importing')).toBe('running');
    expect(taskStatusOfActivity('preparing')).toBe('queued');
    expect(taskStatusOfActivity('completed')).toBe('succeeded');
  });
});

describe('progress', () => {
  it('uses the counted form when the service sent a denominator', () => {
    expect(taskProgressOfActivity(ITEM)).toEqual({ completed: 3, total: 5, unit: 'stages' });
  });

  it('falls back to a percentage only when the service computed one', () => {
    const item = { ...ITEM, completed_units: null, total_units: null, unit: null, progress_percent: 62 };
    expect(taskProgressOfActivity(item)).toEqual({ completed: 62, total: 100, unit: 'percent' });
  });

  it('draws no bar at all without a real denominator — null is not zero', () => {
    const item = { ...ITEM, completed_units: null, total_units: null, unit: null, progress_percent: null };
    expect(taskProgressOfActivity(item)).toBeUndefined();

    const empty = { ...ITEM, completed_units: 0, total_units: 0, progress_percent: null };
    expect(taskProgressOfActivity(empty)).toBeUndefined();
  });
});

describe('stage', () => {
  it('translates the service s recording message into the drawn stage id', () => {
    expect(taskStagePositionOf(ITEM)?.id).toBe('capture');
  });

  it('says nothing for a stage this build does not recognise', () => {
    expect(taskStagePositionOf({ ...ITEM, stage: 'recording.stage.teleporting' })).toBeUndefined();
    expect(taskStagePositionOf({ ...ITEM, stage: null })).toBeUndefined();
  });

  it('numbers an analysis stage 「阶段 3/5」', () => {
    const analysis = { ...ITEM, kind: 'analysis' as const, stage: 'parser_running' };
    expect(taskStagePositionOf(analysis)).toMatchObject({ id: 'parser_running', index: 3, count: 5 });
  });
});

describe('toTaskSummary', () => {
  it('measures a finished task between its own two stamps', () => {
    const done = { ...ITEM, status: 'completed' as const };
    expect(toTaskSummary(done).durationMs).toBe(401_000);
  });

  it('measures a running task against now, not against updated_at', () => {
    const summary = toTaskSummary(ITEM, { now: new Date('2026-08-15T09:07:00.000Z') });
    expect(summary.durationMs).toBe(120_000);
  });

  it('omits the duration rather than inventing a clock', () => {
    expect(toTaskSummary(ITEM).durationMs).toBeUndefined();
  });

  it('carries the service s sentence and refuses to guess the reason', () => {
    const failed = { ...ITEM, status: 'failed' as const, error: '磁盘空间不足' };
    const summary = toTaskSummary(failed);

    expect(summary.status).toBe('failed');
    expect(summary.failure?.reason).toBe('unknown');
    expect(summary.failure?.detail).toBe('磁盘空间不足');
  });

  it('always hands a failure some recovery action, and marks a missing one useless', () => {
    const failed = { ...ITEM, status: 'failed' as const };
    expect(toTaskSummary(failed).failure?.recovery.disabled).toBe(true);

    const withRecovery = toTaskSummary(failed, {
      recovery: { label: '重试', onAction: () => {} },
    });
    expect(withRecovery.failure?.recovery.disabled).toBeUndefined();
  });
});
