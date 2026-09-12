/*
 * `markup` project — the address, the stages and the log of a task detail.
 */

import { describe, expect, it } from 'vitest';

import type { AnalysisRunEvent } from '../../shared/desktop/dto';
import type { ActivityItem } from '../../shared/desktop/viewModels';
import {
  analysisLogEntries,
  analysisStageEntries,
  parseTaskLocator,
  recordingStageEntries,
} from './taskDetailModel';

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
  available_actions: ['cancel'],
};

function event(sequence: number, stage: string, code: AnalysisRunEvent['message_code']): AnalysisRunEvent {
  return {
    run_id: 'run-1',
    sequence,
    stage: stage as AnalysisRunEvent['stage'],
    message_code: code,
    detail: null,
    created_at: `2026-08-15T09:0${String(sequence)}:00.000Z`,
  };
}

describe('parseTaskLocator', () => {
  it('splits the service s own kind:jobId locator', () => {
    expect(parseTaskLocator('recording:job-1')).toEqual({ kind: 'recording', jobId: 'job-1' });
    // A uuid job id contains no colon, but a future one might; only the first
    // separator counts.
    expect(parseTaskLocator('export:a:b')).toEqual({ kind: 'export', jobId: 'a:b' });
  });

  it('refuses anything that is not a locator, rather than asking the service', () => {
    expect(parseTaskLocator('t-42')).toBeNull();
    expect(parseTaskLocator('nonsense:job-1')).toBeNull();
    expect(parseTaskLocator('recording:')).toBeNull();
    expect(parseTaskLocator(':job-1')).toBeNull();
    expect(parseTaskLocator('')).toBeNull();
  });
});

describe('recordingStageEntries', () => {
  it('marks the stages before the pointer done and the pointer active', () => {
    const stages = recordingStageEntries(ITEM, 'running');
    expect(stages.map((stage) => stage.state)).toEqual([
      'done', 'done', 'active', 'pending', 'pending', 'pending',
    ]);
  });

  it('lights every stage on success, including the one the service never names', () => {
    const stages = recordingStageEntries({ ...ITEM, status: 'completed' }, 'succeeded');
    expect(stages.map((stage) => stage.state)).toEqual(Array.from({ length: 6 }, () => 'done'));
  });

  it('enters nothing when the stage message is unknown', () => {
    const stages = recordingStageEntries({ ...ITEM, stage: 'recording.stage.warping' }, 'running');
    expect(stages.every((stage) => stage.state === 'pending')).toBe(true);
  });
});

describe('analysisStageEntries', () => {
  it('stamps each stage with the event that entered it', () => {
    const stages = analysisStageEntries('parser_running', 'running', [
      event(1, 'validating_input', 'input_validation_started'),
      event(2, 'parser_running', 'parser_started'),
      // A second event in the same stage must not move the stamp.
      event(3, 'parser_running', 'input_verified'),
    ]);

    expect(stages).toHaveLength(5);
    expect(stages[0]?.at).toBe('2026-08-15T09:01:00.000Z');
    expect(stages[2]?.at).toBe('2026-08-15T09:02:00.000Z');
    expect(stages[2]?.state).toBe('active');
    expect(stages[4]?.at).toBeUndefined();
  });

  it('paints the stage a failed run stopped in, and only that one', () => {
    const stages = analysisStageEntries('parser_running', 'failed', []);
    expect(stages.map((stage) => stage.state)).toEqual([
      'done', 'done', 'failed', 'pending', 'pending',
    ]);
  });
});

describe('analysisLogEntries', () => {
  it('keys on the run s own sequence, since two events can share a stamp', () => {
    const entries = analysisLogEntries([
      event(1, 'validating_input', 'input_validation_started'),
      event(2, 'validating_input', 'input_verified'),
    ]);

    expect(entries.map((entry) => entry.id)).toEqual(['run-1-1', 'run-1-2']);
  });

  it('washes the lines that end a run badly, and nothing else', () => {
    const entries = analysisLogEntries([
      event(1, 'parser_running', 'parser_started'),
      event(2, 'failed', 'failed'),
    ]);

    expect(entries[0]?.emphasis).toBeUndefined();
    expect(entries[1]?.emphasis).toBe(true);
  });
});
