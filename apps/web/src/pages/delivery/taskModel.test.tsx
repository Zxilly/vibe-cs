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
  toTaskSummary as buildTaskSummary,
  type TaskSummaryOptions,
} from './taskModel';

function toTaskSummary(item: ActivityItem, options: Partial<TaskSummaryOptions> = {}) {
  const { recovery = { label: '测试恢复', onAction: () => {} }, ...rest } = options;
  return buildTaskSummary(item, { ...rest, recovery });
}

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

  it('carries the service s sentence and refuses to guess the reason from it', () => {
    const failed = { ...ITEM, status: 'failed' as const, error: '磁盘空间不足' };
    const summary = toTaskSummary(failed);

    expect(summary.status).toBe('failed');
    /* The sentence says 磁盘空间不足 and there is no code beside it, so the
       reason stays `unknown` — reading it off the prose is the thing this
       module will not do. */
    expect(summary.failure?.reason).toBe('unknown');
    expect(summary.failure?.detail).toBe('磁盘空间不足');
  });

  it('names the reason from the service s code, and only from a code it has a name for', () => {
    const failed = { ...ITEM, status: 'failed' as const, error: '写入失败' };

    expect(toTaskSummary({ ...failed, failure: { code: 'disk_full', retryable: false } })
      .failure?.reason).toBe('disk-space');
    expect(toTaskSummary({ ...failed, failure: { code: 'input_missing', retryable: false } })
      .failure?.reason).toBe('source-missing');
    expect(toTaskSummary({ ...failed, failure: { code: 'timeout', retryable: true } })
      .failure?.reason).toBe('timeout');
    /* Absent and broken are the same next step, so both are game-unavailable. */
    expect(toTaskSummary({ ...failed, failure: { code: 'dependency_missing', retryable: false } })
      .failure?.reason).toBe('game-unavailable');
    expect(toTaskSummary({ ...failed, failure: { code: 'dependency_failed', retryable: true } })
      .failure?.reason).toBe('game-unavailable');
    /* No member of the five describes a denied write; naming the nearest one
       would send the user to free disk space they already have. */
    expect(toTaskSummary({ ...failed, failure: { code: 'permission_denied', retryable: false } })
      .failure?.reason).toBe('unknown');
    /* And the sentence survives whichever branch was taken. */
    expect(toTaskSummary({ ...failed, failure: { code: 'disk_full', retryable: false } })
      .failure?.detail).toBe('写入失败');
  });

  it('uses the recovery action supplied by the caller', () => {
    const failed = { ...ITEM, status: 'failed' as const };
    const withRecovery = toTaskSummary(failed, {
      recovery: { label: '重试', onAction: () => {} },
    });
    expect(withRecovery.failure?.recovery.disabled).toBeUndefined();
  });
});
