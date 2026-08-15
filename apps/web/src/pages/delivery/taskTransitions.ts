/*
 * pages/delivery — asking `taskMachine` what this task is allowed to do.
 *
 * The rule this file exists to enforce: **the page never decides on its own
 * that a task can be cancelled or retried.** §4.3 makes `domain/task/taskMachine`
 * the one lifecycle, and the two writes the delivery surface performs are
 * transitions of it — so the buttons are drawn from `snapshot.can(event)` and
 * the same event is sent to the machine before the mutation fires. A status
 * string compared against a hand-written set (`status === 'failed'`) would be a
 * second, silent copy of the lifecycle, which is exactly what one machine is
 * for.
 *
 * ── Why a snapshot is rebuilt instead of an actor being kept ───────────────
 *
 * A task record arrives from the service already in the middle of its life. The
 * machine has no way to be "put" into a state — that is the point of a state
 * machine — so the snapshot is reached the only legal way, by replaying the
 * events that would have produced it. `replayEvents` is that replay, and it is
 * short because the machine is: confirm, enter a stage, then end.
 *
 * The alternative (one long-lived actor per row, fed by the poll) is what the
 * detail page will want when it grows a live log; for a list of fifty records
 * that redraw on every poll it would mean fifty actors to create, subscribe and
 * dispose. Replay is pure, so the answer is cacheable — and it is cached, keyed
 * by the three inputs it depends on.
 *
 * ── The events, and which ones the page may send ──────────────────────────
 *
 * `CANCEL`   the user asked to stop. The service confirms with `CANCELLED`;
 *            `cancelling` in between is a real state and not a spinner.
 * `RETRY`    a failed task, spending one of `MAX_TASK_ATTEMPTS`.
 * `RESTART`  a cancelled task, which spends nothing — 「已取消 · 可重新发起」 on
 *            「11 输出与任务记录」 carries no retry count.
 *
 * `CONFIRM` is not sent from here. §4.5.3 ① reserves it for the one explicit
 * confirmation a recording starts from, which lives on `/recording` — the
 * delivery page's 重试录制 hands the plan over rather than starting it.
 */

import { createActor } from 'xstate';

import type { TaskKind, TaskMachineEvent, TaskSnapshot, TaskStatus } from '../../domain/task';
import { taskMachine } from '../../domain/task';

export interface TaskLifecycleState {
  readonly kind: TaskKind;
  readonly status: TaskStatus;
  /** The stage id the service reports, when this build recognises it. */
  readonly stageId?: string | undefined;
}

/**
 * The events that take a `taskMachine` from its initial state to `state`.
 *
 * `CONFIRM` is sent for anything past 等待确认: the service reporting a queued
 * recording *is* the evidence that the confirmation happened (on the recording
 * page, in this session or an earlier one). It is a no-op for kinds that never
 * wait, because `queued` does not handle it.
 *
 * `STAGE_ENTERED` is sent for every status that means work started, even when
 * the stage id is unknown — the transition to `running` is what a stage entry
 * means, and `enterStage` already refuses to move the pointer for an id it does
 * not recognise (a stage this build has not heard of must not undo the ones it
 * has).
 */
export function replayEvents({ status, stageId }: TaskLifecycleState): readonly TaskMachineEvent[] {
  if (status === 'awaiting-confirmation') return [];

  const events: TaskMachineEvent[] = [{ type: 'CONFIRM' }];
  if (status !== 'queued') events.push({ type: 'STAGE_ENTERED', stage: stageId ?? '' });

  switch (status) {
    case 'succeeded':
      events.push({ type: 'SUCCEEDED' });
      break;
    case 'failed':
      // The reason is the closed-set `unknown` for the same cause `taskModel`
      // documents: the wire carries free text and no code. Nothing downstream
      // of the machine reads it — the card renders `TaskFailure`, not context.
      events.push({ type: 'FAILED', reason: 'unknown' });
      break;
    case 'cancelling':
      events.push({ type: 'CANCEL' });
      break;
    case 'cancelled':
      events.push({ type: 'CANCELLED' });
      break;
    default:
      break;
  }

  return events;
}

const SNAPSHOTS = new Map<string, TaskSnapshot>();

/** A `taskMachine` snapshot standing where this task record stands. */
export function taskSnapshotFor(state: TaskLifecycleState): TaskSnapshot {
  const key = `${state.kind}|${state.status}|${state.stageId ?? ''}`;
  const cached = SNAPSHOTS.get(key);
  if (cached !== undefined) return cached;

  const actor = createActor(taskMachine, { input: { kind: state.kind } });
  actor.start();
  for (const event of replayEvents(state)) actor.send(event);
  const snapshot = actor.getSnapshot();
  actor.stop();

  SNAPSHOTS.set(key, snapshot);
  return snapshot;
}

/** Whether the machine accepts this event from where the task now stands. */
export function taskCan(state: TaskLifecycleState, event: TaskMachineEvent): boolean {
  return taskSnapshotFor(state).can(event);
}

/** 「取消」/「停止」 is offered. */
export function canCancelTask(state: TaskLifecycleState): boolean {
  return taskCan(state, { type: 'CANCEL' });
}

/**
 * 「重试」 or 「重新发起」 is offered, and which of the two it is.
 *
 * `null` means neither — a succeeded task, a running one, or a failed one whose
 * attempt budget is spent (`MAX_TASK_ATTEMPTS`; the machine simply has no
 * transition left, which is 「已达上限，不再自动重试」 expressed as an absence).
 */
export function taskRestartEvent(state: TaskLifecycleState): TaskMachineEvent | null {
  if (taskCan(state, { type: 'RETRY' })) return { type: 'RETRY' };
  if (taskCan(state, { type: 'RESTART' })) return { type: 'RESTART' };
  return null;
}
