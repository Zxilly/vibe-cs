import { describe, expect, it } from 'vitest';

import { RECORDING_STAGE_IDS } from '../../design/feedback';

import { ANALYSIS_STAGE_IDS, TASK_STAGE_IDS, taskStageIds, taskStageIndex, taskStageStates } from './taskStages';
import type { TaskKind, TaskStatus } from './types';

describe('TASK_STAGE_IDS', () => {
  it('takes the six recording stages from the design layer rather than restating them', () => {
    expect(TASK_STAGE_IDS.recording).toBe(RECORDING_STAGE_IDS);
    expect(TASK_STAGE_IDS.recording).toHaveLength(6);
  });

  it('gives analysis the five stages §4.3 counts', () => {
    expect(ANALYSIS_STAGE_IDS).toHaveLength(5);
    expect(TASK_STAGE_IDS.analysis).toBe(ANALYSIS_STAGE_IDS);
  });

  it('leaves the kinds the reference draws no stage bar for empty', () => {
    for (const kind of ['montage', 'export', 'download'] as const) {
      expect(taskStageIds(kind), kind).toEqual([]);
    }
  });

  it('covers every kind', () => {
    const kinds: readonly TaskKind[] = ['analysis', 'recording', 'montage', 'export', 'download'];
    expect(Object.keys(TASK_STAGE_IDS).sort()).toEqual([...kinds].sort());
  });
});

describe('taskStageIndex', () => {
  it('finds a stage by id', () => {
    expect(taskStageIndex(RECORDING_STAGE_IDS, 'capture')).toBe(2);
  });

  it('reports an id it has never heard of as -1 instead of guessing', () => {
    expect(taskStageIndex(RECORDING_STAGE_IDS, 'colour_grade')).toBe(-1);
  });
});

describe('taskStageStates', () => {
  const stages = RECORDING_STAGE_IDS;

  it('leaves everything not started while the task is still waiting or queued', () => {
    for (const status of ['awaiting-confirmation', 'queued'] as const) {
      expect(taskStageStates(stages, -1, status), status).toEqual(
        ['pending', 'pending', 'pending', 'pending', 'pending', 'pending'],
      );
    }
  });

  it('paints the pointer active and everything before it done', () => {
    expect(taskStageStates(stages, 2, 'running')).toEqual(
      ['done', 'done', 'active', 'pending', 'pending', 'pending'],
    );
  });

  it('keeps reporting a stage while a cancel is being granted', () => {
    expect(taskStageStates(stages, 2, 'cancelling')).toEqual(
      ['done', 'done', 'active', 'pending', 'pending', 'pending'],
    );
  });

  it('marks every stage done when the task succeeded, whatever the pointer says', () => {
    expect(taskStageStates(stages, 3, 'succeeded')).toEqual(
      ['done', 'done', 'done', 'done', 'done', 'done'],
    );
  });

  it('fails exactly the stage it stopped on, so the reader knows where to look', () => {
    expect(taskStageStates(stages, 4, 'failed')).toEqual(
      ['done', 'done', 'done', 'done', 'failed', 'pending'],
    );
  });

  it('returns a cancelled stage to not-started rather than painting it failed', () => {
    // 「失败 · 磁盘空间不足」 carries a recovery action; 「已取消 · 可重新发起」
    // does not. Painting them alike would merge two records the artboard keeps
    // apart.
    const cancelled = taskStageStates(stages, 2, 'cancelled');

    expect(cancelled).toEqual(['done', 'done', 'pending', 'pending', 'pending', 'pending']);
    expect(cancelled).not.toContain('failed');
  });

  it('produces nothing at all for a kind with no drawn sequence', () => {
    const statuses: readonly TaskStatus[] = [
      'awaiting-confirmation', 'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled',
    ];
    for (const status of statuses) {
      expect(taskStageStates([], -1, status), status).toEqual([]);
    }
  });
});
