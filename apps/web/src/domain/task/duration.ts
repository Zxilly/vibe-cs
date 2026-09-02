/*
 * Domain layer, layer 2 of 3 — task duration, as pure arithmetic.
 *
 * The reference writes durations in exactly two grammars, and they do not mean
 * the same thing:
 *
 *   「用时 6 分 41 秒」   a task that stopped. The number is final.
 *   「已用 1 分 52 秒」   a task still going. The number will grow.
 *
 * Presenting the second as the first claims the task is over. So the *kind* is
 * part of the value, and it is derived from the status rather than passed
 * alongside it — see `TASK_DURATION_KIND`.
 *
 * No words in this module. Units are `'hour' | 'minute' | 'second'` and the
 * kind is `'elapsed' | 'total'`; the Chinese (and its translations) live in
 * `TaskDuration.tsx`, behind the Lingui macros. That split is what lets the
 * whole calculation be exhausted in the `unit` project, with no i18n runtime
 * and no React.
 */

import type { TaskStatus } from './types';

export type TaskDurationUnit = 'hour' | 'minute' | 'second';

export interface TaskDurationPart {
  readonly unit: TaskDurationUnit;
  readonly value: number;
}

/** 已用 (still running) vs 用时 (finished). */
export type TaskDurationKind = 'elapsed' | 'total';

/**
 * `sub-second` is its own precision, not a zero. A task that took 400 ms did
 * not take 「0 秒」 — that reads as "instant" or as "unknown", and the artboard's
 * standing rule for the loading panel (「不显示虚构百分比」) is the same
 * objection: do not print a number the data does not support. `parts` is empty
 * for this precision and the component says 「不足 1 秒」.
 */
export type TaskDurationPrecision = 'exact' | 'sub-second';

export interface TaskDurationValue {
  readonly kind: TaskDurationKind;
  readonly precision: TaskDurationPrecision;
  /** Empty when `precision` is `sub-second`; otherwise one or two parts. */
  readonly parts: readonly TaskDurationPart[];
  /** The input after clamping, so the caller can put it in `<time datetime>`. */
  readonly ms: number;
}

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

/**
 * Which duration grammar a status calls for.
 *
 * `awaiting-confirmation` counts as elapsed: nothing has run, but whatever the
 * caller measured (time spent waiting for the user) is still accumulating.
 * `cancelling` likewise — the task has not stopped yet.
 */
export const TASK_DURATION_KIND: Readonly<Record<TaskStatus, TaskDurationKind>> = {
  queued: 'elapsed',
  running: 'elapsed',
  cancelling: 'elapsed',
  succeeded: 'total',
  failed: 'total',
  cancelled: 'total',
};

/**
 * Split a millisecond count into the one or two units worth printing.
 *
 * The rule is "two units, never three": the reference never writes three
 * (「6 分 41 秒」, 「1 分 48 秒」, 「1 分 52 秒」), and a second's precision under an
 * hour-scale number is noise. Concretely:
 *
 *   ≥ 1 h      hour + minute (minute dropped when 0)
 *   ≥ 1 min    minute + second (second dropped when 0)
 *   ≥ 1 s      second
 *   > 0        sub-second
 *   0 / < 0    「0 秒」 — a genuine zero, and the clamp for nonsense input
 *
 * A negative input is a clock skew or a bad subtraction upstream. It is clamped
 * rather than thrown: a task record must still render.
 */
export function taskDuration(ms: number, kind: TaskDurationKind): TaskDurationValue {
  const safe = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;

  if (safe > 0 && safe < MS_PER_SECOND) {
    return { kind, precision: 'sub-second', parts: [], ms: safe };
  }

  const totalSeconds = Math.floor(safe / MS_PER_SECOND);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);

  const parts: TaskDurationPart[] = [];
  if (hours > 0) {
    parts.push({ unit: 'hour', value: hours });
    if (minutes > 0) parts.push({ unit: 'minute', value: minutes });
  } else if (minutes > 0) {
    parts.push({ unit: 'minute', value: minutes });
    if (seconds > 0) parts.push({ unit: 'second', value: seconds });
  } else {
    parts.push({ unit: 'second', value: seconds });
  }

  return { kind, precision: 'exact', parts, ms: safe };
}

/** `taskDuration` with the grammar chosen by the task's status. */
export function taskDurationFor(ms: number, status: TaskStatus): TaskDurationValue {
  return taskDuration(ms, TASK_DURATION_KIND[status]);
}
