/*
 * Domain layer, layer 2 of 3 — the one task lifecycle machine (spec §4.3).
 *
 * §4.3 in full: 「统一成 domain/task/taskMachine.ts 一台机器，阶段序列由任务类型
 * 参数化。工作台首页、交付页、任务详情、资料库行内进度共享同一台机器的快照，不各自
 * 维护进度状态。机器的输入来自 data/tasks.ts 的 query，输出只是呈现状态——推进由
 * 后端事件驱动，前端不模拟进度」.
 *
 * Three consequences, all visible in the code below:
 *
 *   1. **No actors, no timers, no promises.** Every transition is caused by an
 *      event the caller sends. There is nothing in this file that could advance
 *      a task on its own, which is the mechanical form of 「前端不模拟进度」.
 *   2. **States are spelled exactly like `TaskStatus`**, so `snapshot.value`
 *      *is* the display status and no lookup table sits between the machine and
 *      the card. `taskStatusOf` is a cast with a guard, not a mapping.
 *   3. **Stage sequences come from `taskStages.ts`**, parameterised by kind,
 *      which in turn imports the six recording stage ids from
 *      `design/feedback/StageBar` rather than restating them.
 *
 * ── What §4.3 does not settle, and why it is settled this way ───────────────
 *
 * (a) **Confirmation.** §4.5.3 ① 「录制只由一次显式确认启动。接受变更不触发录制，
 *     手动编辑不触发录制，切换会话不触发录制」, and it adds that this 「必须落进
 *     taskMachine，不能只靠 UI 摆放」. So a recording task starts in
 *     `awaiting-confirmation`, and the **only** event that leaves that state
 *     towards work is `CONFIRM`. No backend event can start it — `STAGE_ENTERED`
 *     and `SUCCEEDED` are ignored there, not queued up.
 *
 * (b) **Cancellation.** §4.3 is silent; 「11 输出与任务记录」 is not. It draws a
 *     running task with a 「取消」 link and a finished-with-「已取消」 record
 *     annotated 「可重新发起」, and 「01 工作台首页」 draws 「停止」 on a running
 *     recording. Cancelling is therefore a request (`CANCEL`) that the backend
 *     confirms (`CANCELLED`) — the intermediate `cancelling` state is `dto.ts`'s
 *     own `JobStatus` value, and it exists because a cancel that has been asked
 *     for but not granted must not look like a cancel that has landed. A task
 *     that finishes or fails while cancelling ends where it actually ended:
 *     that race is real and losing it would report a completed export as
 *     cancelled.
 *
 * (c) **Retry budget.** §4.3 is silent. The task detail artboard counts retries
 *     as a fact of the record (「重试 1」) rather than as an endless loop, and
 *     the RetryNotice this directory ships has to be able to say 「已达上限，不再
 *     自动重试」 — a sentence with no meaning unless a limit exists. The limit is
 *     `MAX_TASK_ATTEMPTS = 3`: one run plus two retries. Three is the smallest
 *     number that lets a transient fault (「观察者视角短暂丢失」, the one the
 *     阶段日志 records recovering from) be retried more than once while still
 *     surfacing a deterministic fault — a missing file, a full disk — before it
 *     has been re-attempted enough times to look like flakiness. Past the
 *     budget `RETRY` is **ignored**, leaving the task in `failed` with its
 *     recovery action: 「不再自动重试」 is a stop, not a new state.
 *
 * (d) **Restart after cancel is not a retry.** 「已取消 · 08-14 22:03 · 可重新
 *     发起」 has no retry count attached to it, and a task the user stopped on
 *     purpose has not consumed any part of a *failure* budget. `RESTART` is its
 *     own event and it resets the attempt counter; `RETRY` (from `failed`)
 *     spends it. Both go back through `awaiting-confirmation` when the kind
 *     requires confirmation — (a) says 只由一次显式确认启动, and a restart is a
 *     start.
 */

import { assign, setup, type SnapshotFrom } from 'xstate';

import type { StageState } from '../../design/feedback';

import { TASK_STAGE_IDS, taskStageIndex, taskStageStates } from './taskStages';
import type { TaskFailureReason, TaskKind, TaskStatus } from './types';

/** One run plus two retries — see note (c). */
export const MAX_TASK_ATTEMPTS = 3;

/**
 * Which kinds may not start without an explicit confirmation (§4.5.3 ①).
 *
 * Only `recording`. The rule names 录制 and nothing else, and widening it would
 * put a confirmation step in front of an export the user already asked for. A
 * montage that reaches the recorder is a `recording` task by kind, so it is
 * covered by this row rather than by a second one.
 */
export const TASK_REQUIRES_CONFIRMATION: Readonly<Record<TaskKind, boolean>> = {
  analysis: false,
  recording: true,
  montage: false,
  export: false,
  download: false,
};

export interface TaskMachineInput {
  readonly kind: TaskKind;
  /** Overrides `TASK_STAGE_IDS[kind]`, for a backend that reports its own. */
  readonly stages?: readonly string[] | undefined;
  /** Overrides `TASK_REQUIRES_CONFIRMATION[kind]`. */
  readonly requiresConfirmation?: boolean | undefined;
  /** Overrides `MAX_TASK_ATTEMPTS`. */
  readonly maxAttempts?: number | undefined;
}

export interface TaskMachineContext {
  readonly kind: TaskKind;
  readonly stages: readonly string[];
  /** Position in `stages`; `-1` before any stage has been entered. */
  readonly stageIndex: number;
  /** Runs started. `0` while waiting for confirmation, `1` on the first run. */
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly requiresConfirmation: boolean;
  readonly failure: TaskFailureReason | null;
}

export type TaskMachineEvent =
  /** The one explicit start. §4.5.3 ①. */
  | { readonly type: 'CONFIRM' }
  /** The backend entered a stage. Unknown ids leave the pointer where it was. */
  | { readonly type: 'STAGE_ENTERED'; readonly stage: string }
  | { readonly type: 'SUCCEEDED' }
  | { readonly type: 'FAILED'; readonly reason: TaskFailureReason }
  /** The user asked to stop. */
  | { readonly type: 'CANCEL' }
  /** The backend confirmed the stop. */
  | { readonly type: 'CANCELLED' }
  /** Re-run a failed task; spends the attempt budget. */
  | { readonly type: 'RETRY' }
  /** Re-launch a cancelled task; resets the budget. */
  | { readonly type: 'RESTART' };

export const taskMachine = setup({
  types: {
    context: {} as TaskMachineContext,
    input: {} as TaskMachineInput,
    events: {} as TaskMachineEvent,
  },
  guards: {
    needsConfirmation: ({ context }) => context.requiresConfirmation,
    canRetry: ({ context }) => context.attempts < context.maxAttempts,
    canRetryWithConfirmation: ({ context }) =>
      context.attempts < context.maxAttempts && context.requiresConfirmation,
  },
  actions: {
    /**
     * Entry of `queued`, so it runs on the first start and on every re-start
     * through exactly one place. Clearing the stage pointer and the failure
     * here is what makes a retried task render as a fresh run rather than as
     * the old one with a new badge.
     */
    startRun: assign(({ context }) => ({
      attempts: context.attempts + 1,
      stageIndex: -1,
      failure: null,
    })),
    resetAttempts: assign({ attempts: 0 }),
    enterStage: assign(({ context, event }) => {
      if (event.type !== 'STAGE_ENTERED') return {};
      const index = taskStageIndex(context.stages, event.stage);
      // A stage this build does not know about must not drag the pointer back
      // to -1: the stages already completed did complete.
      return index < 0 ? {} : { stageIndex: index };
    }),
    recordFailure: assign(({ event }) =>
      event.type === 'FAILED' ? { failure: event.reason } : {}),
  },
}).createMachine({
  id: 'task',
  context: ({ input }) => ({
    kind: input.kind,
    stages: input.stages ?? TASK_STAGE_IDS[input.kind],
    stageIndex: -1,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? MAX_TASK_ATTEMPTS,
    requiresConfirmation: input.requiresConfirmation ?? TASK_REQUIRES_CONFIRMATION[input.kind],
    failure: null,
  }),
  initial: 'start',
  states: {
    /**
     * Transient. xstate 5 takes a literal `initial`, and which state a task
     * starts in depends on its kind, so the choice is an `always` fork that
     * resolves before the first snapshot is read. `start` is never observable.
     */
    start: {
      always: [
        { guard: 'needsConfirmation', target: 'awaiting-confirmation' },
        { target: 'queued' },
      ],
    },

    /**
     * §4.5.3 ①. Only `CONFIRM` starts the work. `STAGE_ENTERED` / `SUCCEEDED` /
     * `FAILED` are ignored on purpose: if the backend can push an unconfirmed
     * recording into `running`, the rule is decoration.
     */
    'awaiting-confirmation': {
      on: {
        CONFIRM: { target: 'queued' },
        CANCEL: { target: 'cancelled' },
      },
    },

    queued: {
      entry: 'startRun',
      on: {
        STAGE_ENTERED: { target: 'running', actions: 'enterStage' },
        SUCCEEDED: { target: 'succeeded' },
        FAILED: { target: 'failed', actions: 'recordFailure' },
        CANCEL: { target: 'cancelling' },
        CANCELLED: { target: 'cancelled' },
      },
    },

    running: {
      on: {
        STAGE_ENTERED: { actions: 'enterStage' },
        SUCCEEDED: { target: 'succeeded' },
        FAILED: { target: 'failed', actions: 'recordFailure' },
        CANCEL: { target: 'cancelling' },
        // Another window, or the backend itself, may stop the job without this
        // machine having asked.
        CANCELLED: { target: 'cancelled' },
      },
    },

    cancelling: {
      on: {
        CANCELLED: { target: 'cancelled' },
        // The task beat the cancel. Report where it actually ended — see (b).
        SUCCEEDED: { target: 'succeeded' },
        FAILED: { target: 'failed', actions: 'recordFailure' },
        STAGE_ENTERED: { actions: 'enterStage' },
      },
    },

    /** Terminal. A produced output is not un-produced by a later event. */
    succeeded: { type: 'final' },

    failed: {
      on: {
        RETRY: [
          { guard: 'canRetryWithConfirmation', target: 'awaiting-confirmation' },
          { guard: 'canRetry', target: 'queued' },
          // Budget spent: no transition. 「已达上限，不再自动重试」 is this
          // absence, and `taskRetriesExhausted` reads it off the context.
        ],
      },
    },

    cancelled: {
      on: {
        RESTART: [
          { guard: 'needsConfirmation', target: 'awaiting-confirmation', actions: 'resetAttempts' },
          { target: 'queued', actions: 'resetAttempts' },
        ],
      },
    },
  },
});

export type TaskSnapshot = SnapshotFrom<typeof taskMachine>;

const TASK_STATUSES: readonly TaskStatus[] = [
  'awaiting-confirmation',
  'queued',
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
];

/**
 * The machine's state as a display status. The states are named for the
 * statuses, so this reads the value rather than translating it; the guard is
 * only there because `start` exists as a type.
 */
export function taskStatusOf(snapshot: TaskSnapshot): TaskStatus {
  const value = snapshot.value;
  return (TASK_STATUSES as readonly string[]).includes(value) ? (value as TaskStatus) : 'queued';
}

/** Retries used so far — the artboard's 「重试 1」. The first run is not one. */
export function taskRetryCount(context: TaskMachineContext): number {
  return Math.max(0, context.attempts - 1);
}

/** Retries allowed. `MAX_TASK_ATTEMPTS` counts the first run; this does not. */
export function taskMaxRetries(context: TaskMachineContext): number {
  return Math.max(0, context.maxAttempts - 1);
}

/** 「已达上限，不再自动重试」. */
export function taskRetriesExhausted(context: TaskMachineContext): boolean {
  return context.attempts >= context.maxAttempts;
}

/** Per-stage states for `StageBar` / `StageTimeline`, straight off a snapshot. */
export function taskStageStatesOf(snapshot: TaskSnapshot): StageState[] {
  return taskStageStates(snapshot.context.stages, snapshot.context.stageIndex, taskStatusOf(snapshot));
}
