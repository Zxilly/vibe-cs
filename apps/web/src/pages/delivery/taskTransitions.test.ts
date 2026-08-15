/*
 * `unit` project — the machine, not a status comparison, decides what a task
 * record may do.
 *
 * These are the assertions that would break if someone replaced
 * `snapshot.can(event)` with `status === 'failed'`: the two disagree in three
 * places, and every one of them is a rule from §4.3 / §4.5.3 rather than a
 * detail.
 */

import { describe, expect, it } from 'vitest';

import { canCancelTask, replayEvents, taskRestartEvent, taskSnapshotFor } from './taskTransitions';

describe('replay', () => {
  it('lands the machine where the service says the task is', () => {
    expect(taskSnapshotFor({ kind: 'analysis', status: 'running' }).value).toBe('running');
    expect(taskSnapshotFor({ kind: 'analysis', status: 'failed' }).value).toBe('failed');
    expect(taskSnapshotFor({ kind: 'analysis', status: 'cancelled' }).value).toBe('cancelled');
    expect(taskSnapshotFor({ kind: 'analysis', status: 'succeeded' }).value).toBe('succeeded');
  });

  it('starts a recording in 等待确认 and sends no CONFIRM of its own', () => {
    expect(taskSnapshotFor({ kind: 'recording', status: 'awaiting-confirmation' }).value).toBe(
      'awaiting-confirmation',
    );
    expect(replayEvents({ kind: 'recording', status: 'awaiting-confirmation' })).toEqual([]);
  });

  it('confirms a recording the service already started, because it evidently was', () => {
    // §4.5.3 ① is about *this* app not starting one silently; a queued job on
    // the wire is proof the confirmation already happened.
    expect(taskSnapshotFor({ kind: 'recording', status: 'running' }).value).toBe('running');
  });

  it('moves the stage pointer only for an id this build knows', () => {
    const known = taskSnapshotFor({ kind: 'recording', status: 'running', stageId: 'capture' });
    const unknown = taskSnapshotFor({ kind: 'recording', status: 'running', stageId: 'no-such-stage' });

    expect(known.context.stageIndex).toBe(2);
    expect(unknown.context.stageIndex).toBe(-1);
    // …and an unknown stage still means the task is running.
    expect(unknown.value).toBe('running');
  });
});

describe('what the page may offer', () => {
  it('offers 取消 while the task can still be stopped', () => {
    expect(canCancelTask({ kind: 'analysis', status: 'running' })).toBe(true);
    expect(canCancelTask({ kind: 'analysis', status: 'queued' })).toBe(true);
    expect(canCancelTask({ kind: 'recording', status: 'awaiting-confirmation' })).toBe(true);
  });

  it('does not offer 取消 twice: a cancel already asked for is not askable again', () => {
    expect(canCancelTask({ kind: 'analysis', status: 'cancelling' })).toBe(false);
    expect(canCancelTask({ kind: 'analysis', status: 'cancelled' })).toBe(false);
    expect(canCancelTask({ kind: 'analysis', status: 'succeeded' })).toBe(false);
  });

  it('tells 重试 from 重新发起 — a cancelled task spent no failure budget', () => {
    expect(taskRestartEvent({ kind: 'export', status: 'failed' })).toEqual({ type: 'RETRY' });
    expect(taskRestartEvent({ kind: 'export', status: 'cancelled' })).toEqual({ type: 'RESTART' });
    expect(taskRestartEvent({ kind: 'export', status: 'running' })).toBeNull();
    expect(taskRestartEvent({ kind: 'export', status: 'succeeded' })).toBeNull();
  });
});
