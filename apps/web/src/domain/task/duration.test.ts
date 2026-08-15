import { describe, expect, it } from 'vitest';

import { TASK_DURATION_KIND, taskDuration, taskDurationFor } from './duration';
import type { TaskStatus } from './types';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe('taskDuration', () => {
  it('reports a genuine zero as 0 seconds, not as sub-second', () => {
    const value = taskDuration(0, 'total');

    expect(value.precision).toBe('exact');
    expect(value.parts).toEqual([{ unit: 'second', value: 0 }]);
    expect(value.ms).toBe(0);
  });

  it('refuses to round anything under a second down to zero', () => {
    for (const ms of [1, 400, 999]) {
      const value = taskDuration(ms, 'total');

      expect(value.precision, String(ms)).toBe('sub-second');
      expect(value.parts, String(ms)).toEqual([]);
      expect(value.ms, String(ms)).toBe(ms);
    }
  });

  it('prints whole seconds on their own', () => {
    expect(taskDuration(SECOND, 'total').parts).toEqual([{ unit: 'second', value: 1 }]);
    expect(taskDuration(59 * SECOND + 999, 'total').parts).toEqual([{ unit: 'second', value: 59 }]);
  });

  it('prints the artboard durations exactly as drawn', () => {
    // 「用时 6 分 41 秒」 and 「已用 1 分 52 秒」, the two the reference writes out.
    expect(taskDuration(6 * MINUTE + 41 * SECOND, 'total').parts).toEqual([
      { unit: 'minute', value: 6 },
      { unit: 'second', value: 41 },
    ]);
    expect(taskDuration(MINUTE + 52 * SECOND, 'elapsed').parts).toEqual([
      { unit: 'minute', value: 1 },
      { unit: 'second', value: 52 },
    ]);
  });

  it('drops a zero seconds tail rather than writing 「3 分 0 秒」', () => {
    expect(taskDuration(3 * MINUTE, 'total').parts).toEqual([{ unit: 'minute', value: 3 }]);
  });

  it('never writes three units past an hour', () => {
    const value = taskDuration(HOUR + 12 * MINUTE + 33 * SECOND, 'total');

    expect(value.parts).toEqual([
      { unit: 'hour', value: 1 },
      { unit: 'minute', value: 12 },
    ]);
  });

  it('drops a zero minutes tail on a whole hour', () => {
    expect(taskDuration(2 * HOUR, 'total').parts).toEqual([{ unit: 'hour', value: 2 }]);
    expect(taskDuration(2 * HOUR + 4 * SECOND, 'total').parts).toEqual([{ unit: 'hour', value: 2 }]);
  });

  it('clamps input a clock skew or a bad subtraction could produce', () => {
    for (const ms of [-1, -HOUR, Number.NaN, Number.POSITIVE_INFINITY * -1]) {
      const value = taskDuration(ms, 'total');

      expect(value.precision, String(ms)).toBe('exact');
      expect(value.parts, String(ms)).toEqual([{ unit: 'second', value: 0 }]);
      expect(value.ms, String(ms)).toBe(0);
    }
  });

  it('carries the kind through untouched — the caller does not re-derive it', () => {
    expect(taskDuration(5 * MINUTE, 'elapsed').kind).toBe('elapsed');
    expect(taskDuration(5 * MINUTE, 'total').kind).toBe('total');
  });

  it('truncates rather than rounds, so a number never overshoots its own task', () => {
    expect(taskDuration(1999, 'total').parts).toEqual([{ unit: 'second', value: 1 }]);
  });
});

describe('TASK_DURATION_KIND', () => {
  const UNFINISHED: readonly TaskStatus[] = ['awaiting-confirmation', 'queued', 'running', 'cancelling'];
  const FINISHED: readonly TaskStatus[] = ['succeeded', 'failed', 'cancelled'];

  it('says 已用 for every task that has not stopped', () => {
    for (const status of UNFINISHED) {
      expect(TASK_DURATION_KIND[status], status).toBe('elapsed');
    }
  });

  it('says 用时 only for a task that has stopped', () => {
    for (const status of FINISHED) {
      expect(TASK_DURATION_KIND[status], status).toBe('total');
    }
  });

  it('covers every status — a new one cannot slip through untyped', () => {
    expect(Object.keys(TASK_DURATION_KIND).sort()).toEqual([...UNFINISHED, ...FINISHED].sort());
  });
});

describe('taskDurationFor', () => {
  it('reads the same milliseconds two ways depending on whether the task is over', () => {
    const running = taskDurationFor(MINUTE + 52 * SECOND, 'running');
    const stopped = taskDurationFor(MINUTE + 52 * SECOND, 'succeeded');

    expect(running.kind).toBe('elapsed');
    expect(stopped.kind).toBe('total');
    expect(running.parts).toEqual(stopped.parts);
  });
});
