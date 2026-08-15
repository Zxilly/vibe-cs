/*
 * Domain layer, layer 2 of 3 — a task duration in words.
 *
 * The arithmetic is `duration.ts`, which has no words in it; this is the other
 * half. It exists as its own component because the same value appears in three
 * places (the card's status line, the detail rail's 「用时」 row, the per-stage
 * row of `StageTimeline`) and the distinction the reference draws —
 *
 *   「用时 6 分 41 秒」  the task is over, the number is final
 *   「已用 1 分 52 秒」  the task is running, the number will grow
 *
 * — has to survive all three. Passing a pre-formatted string around would lose
 * it at the first call site that forgot.
 *
 * `<time dateTime>` carries the machine-readable form (ISO 8601 duration), so
 * the rendered text can stay as short as the artboard draws it.
 */

import { Trans } from '@lingui/react/macro';
import { Fragment } from 'react';

import type { TaskDurationPart, TaskDurationValue } from './duration';

/** ISO 8601 duration, for `<time dateTime>`: 401 s → `PT401S`. */
function isoDuration(ms: number): string {
  return `PT${String(Math.floor(ms / 1000))}S`;
}

function DurationPartText({ part }: { part: TaskDurationPart }) {
  // Bound to a plain identifier: the Lingui macro names its placeholder after
  // the expression, and a member expression has no name to take.
  const value = part.value;

  switch (part.unit) {
    case 'hour':
      return <Trans>{value} 小时</Trans>;
    case 'minute':
      return <Trans>{value} 分</Trans>;
    case 'second':
      return <Trans>{value} 秒</Trans>;
  }
}

function DurationText({ value }: { value: TaskDurationValue }) {
  if (value.precision === 'sub-second') return <Trans>不足 1 秒</Trans>;

  return (
    <>
      {value.parts.map((part, index) => (
        <Fragment key={part.unit}>
          {index === 0 ? null : ' '}
          <DurationPartText part={part} />
        </Fragment>
      ))}
    </>
  );
}

export interface TaskDurationProps {
  readonly value: TaskDurationValue;
  readonly className?: string | undefined;
}

export function TaskDuration({ value, className }: TaskDurationProps) {
  const duration = <DurationText value={value} />;

  return (
    <time
      dateTime={isoDuration(value.ms)}
      data-duration-kind={value.kind}
      {...(className === undefined ? {} : { className })}
    >
      {value.kind === 'total' ? <Trans>用时 {duration}</Trans> : <Trans>已用 {duration}</Trans>}
    </time>
  );
}
