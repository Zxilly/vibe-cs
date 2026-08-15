import { createActor } from 'xstate';
import { describe, expect, it } from 'vitest';

import { RECORDING_STAGE_IDS } from '../../design/feedback';

import {
  MAX_TASK_ATTEMPTS,
  TASK_REQUIRES_CONFIRMATION,
  taskMachine,
  taskMaxRetries,
  taskRetriesExhausted,
  taskRetryCount,
  taskStageStatesOf,
  taskStatusOf,
  type TaskMachineEvent,
  type TaskMachineInput,
} from './taskMachine';
import type { TaskStatus } from './types';

/* ── driving ─────────────────────────────────────────────────────────────── */

const RECORDING: TaskMachineInput = { kind: 'recording' };

function start(input: TaskMachineInput = RECORDING) {
  const actor = createActor(taskMachine, { input });
  actor.start();
  return actor;
}

type Actor = ReturnType<typeof start>;

function statusOf(actor: Actor): TaskStatus {
  return taskStatusOf(actor.getSnapshot());
}

function send(actor: Actor, ...events: readonly TaskMachineEvent[]): Actor {
  for (const event of events) actor.send(event);
  return actor;
}

const STAGE: TaskMachineEvent = { type: 'STAGE_ENTERED', stage: 'launch' };
const DISK_FULL: TaskMachineEvent = { type: 'FAILED', reason: 'disk-space' };

/** Every event, once, in one list — the matrix below sends all of them. */
const EVERY_EVENT: readonly TaskMachineEvent[] = [
  { type: 'CONFIRM' },
  STAGE,
  { type: 'SUCCEEDED' },
  DISK_FULL,
  { type: 'CANCEL' },
  { type: 'CANCELLED' },
  { type: 'RETRY' },
  { type: 'RESTART' },
];

/** A recording actor parked in each state, with one run already spent. */
const PARK: Readonly<Record<TaskStatus, readonly TaskMachineEvent[]>> = {
  'awaiting-confirmation': [],
  queued: [{ type: 'CONFIRM' }],
  running: [{ type: 'CONFIRM' }, STAGE],
  cancelling: [{ type: 'CONFIRM' }, STAGE, { type: 'CANCEL' }],
  succeeded: [{ type: 'CONFIRM' }, STAGE, { type: 'SUCCEEDED' }],
  failed: [{ type: 'CONFIRM' }, STAGE, DISK_FULL],
  cancelled: [{ type: 'CONFIRM' }, STAGE, { type: 'CANCEL' }, { type: 'CANCELLED' }],
};

function parkedIn(state: TaskStatus, input: TaskMachineInput = RECORDING): Actor {
  const actor = send(start(input), ...PARK[state]);
  expect(statusOf(actor), `parking in ${state}`).toBe(state);
  return actor;
}

/* ── the matrix ──────────────────────────────────────────────────────────── */

/**
 * Every state × every event. The cells that repeat the state name are the
 * important ones: they pin down which events are *ignored*, which is the half
 * of a lifecycle that silently rots.
 */
const MATRIX: Readonly<Record<TaskStatus, Readonly<Record<TaskMachineEvent['type'], TaskStatus>>>> = {
  'awaiting-confirmation': {
    // §4.5.3 ①: only CONFIRM starts it, and no backend event can.
    CONFIRM: 'queued',
    STAGE_ENTERED: 'awaiting-confirmation',
    SUCCEEDED: 'awaiting-confirmation',
    FAILED: 'awaiting-confirmation',
    CANCEL: 'cancelled',
    CANCELLED: 'awaiting-confirmation',
    RETRY: 'awaiting-confirmation',
    RESTART: 'awaiting-confirmation',
  },
  queued: {
    CONFIRM: 'queued',
    STAGE_ENTERED: 'running',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    CANCEL: 'cancelling',
    CANCELLED: 'cancelled',
    RETRY: 'queued',
    RESTART: 'queued',
  },
  running: {
    CONFIRM: 'running',
    STAGE_ENTERED: 'running',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    CANCEL: 'cancelling',
    CANCELLED: 'cancelled',
    RETRY: 'running',
    RESTART: 'running',
  },
  cancelling: {
    CONFIRM: 'cancelling',
    STAGE_ENTERED: 'cancelling',
    // The task beat the cancel — report where it actually ended.
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    CANCEL: 'cancelling',
    CANCELLED: 'cancelled',
    RETRY: 'cancelling',
    RESTART: 'cancelling',
  },
  succeeded: {
    CONFIRM: 'succeeded',
    STAGE_ENTERED: 'succeeded',
    SUCCEEDED: 'succeeded',
    FAILED: 'succeeded',
    CANCEL: 'succeeded',
    CANCELLED: 'succeeded',
    RETRY: 'succeeded',
    RESTART: 'succeeded',
  },
  failed: {
    CONFIRM: 'failed',
    STAGE_ENTERED: 'failed',
    SUCCEEDED: 'failed',
    FAILED: 'failed',
    CANCEL: 'failed',
    CANCELLED: 'failed',
    // Recording requires confirmation, so a retry goes back through it.
    RETRY: 'awaiting-confirmation',
    RESTART: 'failed',
  },
  cancelled: {
    CONFIRM: 'cancelled',
    STAGE_ENTERED: 'cancelled',
    SUCCEEDED: 'cancelled',
    FAILED: 'cancelled',
    CANCEL: 'cancelled',
    CANCELLED: 'cancelled',
    RETRY: 'cancelled',
    RESTART: 'awaiting-confirmation',
  },
};

describe('taskMachine · every state receives every event', () => {
  for (const [state, row] of Object.entries(MATRIX) as [TaskStatus, Record<TaskMachineEvent['type'], TaskStatus>][]) {
    describe(state, () => {
      for (const event of EVERY_EVENT) {
        const expected = row[event.type];
        const verb = expected === state ? 'ignores' : `moves to ${expected} on`;
        it(`${verb} ${event.type}`, () => {
          const actor = send(parkedIn(state), event);
          expect(statusOf(actor)).toBe(expected);
        });
      }
    });
  }
});

/* ── starting ────────────────────────────────────────────────────────────── */

describe('taskMachine · starting', () => {
  it('parks a recording task in front of its confirmation', () => {
    expect(TASK_REQUIRES_CONFIRMATION.recording).toBe(true);
    expect(statusOf(start({ kind: 'recording' }))).toBe('awaiting-confirmation');
  });

  it('queues every other kind straight away', () => {
    for (const kind of ['analysis', 'montage', 'export', 'download'] as const) {
      expect(statusOf(start({ kind })), kind).toBe('queued');
    }
  });

  it('never leaves the transient fork observable', () => {
    expect(start().getSnapshot().value).not.toBe('start');
  });

  it('counts no run until the work is actually queued', () => {
    const waiting = start();
    expect(waiting.getSnapshot().context.attempts).toBe(0);

    send(waiting, { type: 'CONFIRM' });
    expect(waiting.getSnapshot().context.attempts).toBe(1);
  });

  it('lets a caller override the confirmation gate and the stage list', () => {
    const actor = start({ kind: 'recording', requiresConfirmation: false, stages: ['only'] });

    expect(statusOf(actor)).toBe('queued');
    expect(actor.getSnapshot().context.stages).toEqual(['only']);
  });

  it('refuses to be started by a backend event alone (§4.5.3 ①)', () => {
    // The whole point of the rule: 接受变更不触发录制, 手动编辑不触发录制.
    const actor = send(start(), STAGE, { type: 'SUCCEEDED' }, DISK_FULL);

    expect(statusOf(actor)).toBe('awaiting-confirmation');
    expect(actor.getSnapshot().context.attempts).toBe(0);
    expect(actor.getSnapshot().context.failure).toBeNull();
  });
});

/* ── stages ──────────────────────────────────────────────────────────────── */

describe('taskMachine · stage pointer', () => {
  it('follows the backend through the six recording stages', () => {
    const actor = send(start(), { type: 'CONFIRM' });

    RECORDING_STAGE_IDS.forEach((stage, index) => {
      send(actor, { type: 'STAGE_ENTERED', stage });
      expect(actor.getSnapshot().context.stageIndex, stage).toBe(index);
    });
  });

  it('holds its place when the backend names a stage this build does not know', () => {
    const actor = send(start(), { type: 'CONFIRM' }, { type: 'STAGE_ENTERED', stage: 'capture' });
    expect(actor.getSnapshot().context.stageIndex).toBe(2);

    send(actor, { type: 'STAGE_ENTERED', stage: 'colour_grade' });
    expect(actor.getSnapshot().context.stageIndex).toBe(2);
    expect(statusOf(actor)).toBe('running');
  });

  it('reports the stage states the bar draws', () => {
    const actor = send(start(), { type: 'CONFIRM' }, { type: 'STAGE_ENTERED', stage: 'capture' });

    expect(taskStageStatesOf(actor.getSnapshot())).toEqual(
      ['done', 'done', 'active', 'pending', 'pending', 'pending'],
    );

    send(actor, DISK_FULL);
    expect(taskStageStatesOf(actor.getSnapshot())).toEqual(
      ['done', 'done', 'failed', 'pending', 'pending', 'pending'],
    );
  });

  it('gives a kind with no drawn sequence no stages at all', () => {
    const actor = start({ kind: 'export' });
    expect(taskStageStatesOf(actor.getSnapshot())).toEqual([]);
  });
});

/* ── failure and the retry budget ────────────────────────────────────────── */

describe('taskMachine · failure', () => {
  it('remembers the reason it stopped', () => {
    const actor = send(start(), { type: 'CONFIRM' }, DISK_FULL);
    expect(actor.getSnapshot().context.failure).toBe('disk-space');
  });

  it('clears the previous failure when the retry actually starts', () => {
    const actor = send(start(), { type: 'CONFIRM' }, DISK_FULL, { type: 'RETRY' });
    // Back at the confirmation gate, the old failure is still on record.
    expect(actor.getSnapshot().context.failure).toBe('disk-space');

    send(actor, { type: 'CONFIRM' });
    expect(actor.getSnapshot().context.failure).toBeNull();
    expect(actor.getSnapshot().context.stageIndex).toBe(-1);
  });
});

describe('taskMachine · retry budget', () => {
  const DIRECT: TaskMachineInput = { kind: 'export' };

  it('allows one run plus two retries by default', () => {
    expect(MAX_TASK_ATTEMPTS).toBe(3);

    const actor = start(DIRECT);
    expect(actor.getSnapshot().context.attempts).toBe(1);
    expect(taskRetryCount(actor.getSnapshot().context)).toBe(0);
    expect(taskMaxRetries(actor.getSnapshot().context)).toBe(2);

    send(actor, DISK_FULL, { type: 'RETRY' });
    expect(statusOf(actor)).toBe('queued');
    expect(taskRetryCount(actor.getSnapshot().context)).toBe(1);

    send(actor, DISK_FULL, { type: 'RETRY' });
    expect(statusOf(actor)).toBe('queued');
    expect(taskRetryCount(actor.getSnapshot().context)).toBe(2);
    expect(taskRetriesExhausted(actor.getSnapshot().context)).toBe(true);
  });

  it('stops retrying past the budget instead of looping', () => {
    const actor = send(start(DIRECT), DISK_FULL, { type: 'RETRY' }, DISK_FULL, { type: 'RETRY' }, DISK_FULL);

    expect(statusOf(actor)).toBe('failed');
    expect(taskRetriesExhausted(actor.getSnapshot().context)).toBe(true);

    send(actor, { type: 'RETRY' });
    expect(statusOf(actor)).toBe('failed');
    expect(actor.getSnapshot().context.attempts).toBe(MAX_TASK_ATTEMPTS);
    expect(actor.getSnapshot().context.failure).toBe('disk-space');
  });

  it('honours a caller-supplied budget of one attempt — no retry at all', () => {
    const actor = send(start({ kind: 'export', maxAttempts: 1 }), DISK_FULL);

    expect(taskMaxRetries(actor.getSnapshot().context)).toBe(0);
    expect(taskRetriesExhausted(actor.getSnapshot().context)).toBe(true);

    send(actor, { type: 'RETRY' });
    expect(statusOf(actor)).toBe('failed');
  });

  it('sends a recording retry back through the confirmation, not straight to work', () => {
    const actor = send(start(), { type: 'CONFIRM' }, DISK_FULL, { type: 'RETRY' });

    expect(statusOf(actor)).toBe('awaiting-confirmation');
    // The retry has not been spent yet — the run has not started.
    expect(actor.getSnapshot().context.attempts).toBe(1);

    send(actor, { type: 'CONFIRM' });
    expect(statusOf(actor)).toBe('queued');
    expect(taskRetryCount(actor.getSnapshot().context)).toBe(1);
  });
});

/* ── cancelling and restarting ───────────────────────────────────────────── */

describe('taskMachine · cancel', () => {
  it('separates asking to stop from having stopped', () => {
    const actor = send(start(), { type: 'CONFIRM' }, STAGE, { type: 'CANCEL' });

    expect(statusOf(actor)).toBe('cancelling');
    send(actor, { type: 'CANCELLED' });
    expect(statusOf(actor)).toBe('cancelled');
  });

  it('drops a task the user never confirmed straight to cancelled', () => {
    const actor = send(start(), { type: 'CANCEL' });

    expect(statusOf(actor)).toBe('cancelled');
    expect(actor.getSnapshot().context.attempts).toBe(0);
  });

  it('does not spend the failure budget on a restart', () => {
    const actor = send(start({ kind: 'export' }), { type: 'CANCEL' }, { type: 'CANCELLED' });
    expect(actor.getSnapshot().context.attempts).toBe(1);

    send(actor, { type: 'RESTART' });
    expect(statusOf(actor)).toBe('queued');
    expect(taskRetryCount(actor.getSnapshot().context)).toBe(0);
    expect(taskRetriesExhausted(actor.getSnapshot().context)).toBe(false);
  });

  it('re-asks for confirmation when a cancelled recording is re-launched', () => {
    const actor = send(start(), { type: 'CONFIRM' }, { type: 'CANCEL' }, { type: 'CANCELLED' }, { type: 'RESTART' });

    expect(statusOf(actor)).toBe('awaiting-confirmation');
    expect(actor.getSnapshot().context.attempts).toBe(0);
  });
});

/* ── terminality ─────────────────────────────────────────────────────────── */

describe('taskMachine · success is terminal', () => {
  it('finishes and stops listening', () => {
    const actor = send(start(), { type: 'CONFIRM' }, STAGE, { type: 'SUCCEEDED' });

    expect(actor.getSnapshot().status).toBe('done');
    expect(taskStageStatesOf(actor.getSnapshot()).every((state) => state === 'done')).toBe(true);
  });
});
