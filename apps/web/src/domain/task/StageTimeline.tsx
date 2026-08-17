/*
 * Domain layer, layer 2 of 3 — the stage sequence of one task, horizontally.
 *
 * ── Why this wraps `design/feedback/StageBar` instead of redrawing it ───────
 *
 * `StageBar` already owns everything the two artboards draw as *the bar*: six
 * equal segments in `--color-ok` / `--color-accent` / `--color-fail` /
 * `--color-neutral-200`, the stage names underneath in `--text-2xs`, the
 * `aria-current="step"` on the running one and the `sr-only` state word that
 * keeps the four states apart without colour. All of that is layer 1 and none
 * of it is task-specific.
 *
 * What the task detail artboard adds on top is per-stage *fact*: when the stage
 * started (「09:06」 in the 阶段日志 column beside it) and how long it took
 * (「片段 1 采集完成 · 3.0 秒」), plus where a failed run stopped. Those are
 * domain facts about one task, not a property of the bar, so they live here and
 * `StageBar` stays reusable by anything else with a staged process.
 *
 * The result is one component with a bar it does not own and a meta row it
 * does. The meta row repeats `StageBar`'s own grid (`grid-flow-col` +
 * `auto-cols-fr` + `gap-1`) so a stage's time sits exactly under its segment;
 * that is the only piece of duplication, and it is duplication of a layout
 * rule, not of the six stage names — those are imported.
 */

import type { ReactNode } from 'react';

import { StageBar, type Stage, type StageState, recordingStages } from '../../design/feedback';
import { cn } from '../../design/primitives';

import { TaskDuration } from './TaskDuration';
import { taskDuration } from './duration';
import { formatTaskTime } from './taskClock';

export interface TaskStageEntry {
  readonly id: string;
  readonly label: ReactNode;
  readonly state: StageState;
  /** ISO 8601 — when the stage was entered. Rendered as 「09:06」. */
  readonly at?: string | undefined;
  /** How long the stage took, or has taken so far when it is the active one. */
  readonly durationMs?: number | undefined;
  /**
   * The failure point, in the user's language: 「观察者视角短暂丢失」. Shown under
   * the bar rather than inside it — a segment is 6px tall and a sentence does
   * not fit in it.
   */
  readonly note?: ReactNode | undefined;
}

export interface StageTimelineProps {
  /** Names the sequence as a whole, e.g. 「录制阶段」. Passed through to `StageBar`. */
  readonly label: string;
  readonly stages: readonly TaskStageEntry[];
  readonly timeZone?: string | undefined;
  readonly className?: string | undefined;
}

/** The grid `StageBar` lays its segments out on; the meta row must match it. */
const STAGE_GRID_CLASS = 'grid grid-flow-col auto-cols-fr gap-1';

export function StageTimeline({ label, stages, timeZone, className }: StageTimelineProps) {
  // Nothing to draw is not an empty state: 「导出」 and 「下载」 have no drawn
  // stage sequence at all (see `taskStages.ts`), and a 172px placeholder box
  // inside a task record would claim something is missing when nothing is.
  if (stages.length === 0) return null;

  const bar: Stage[] = stages.map((stage) => ({
    id: stage.id,
    label: stage.label,
    state: stage.state,
  }));

  const notes = stages.filter((stage) => stage.note !== undefined);

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <StageBar label={label} stages={bar} />

      {stages.some((stage) => stage.at !== undefined || stage.durationMs !== undefined) ? (
        <ul className={cn('m-0 list-none p-0', STAGE_GRID_CLASS)}>
          {stages.map((stage) => (
            <li
              key={stage.id}
              data-stage-meta={stage.id}
              className="flex min-w-0 flex-col gap-0.5 text-2xs text-neutral-600 last:text-end"
            >
              {/* The bar already shows the name; repeat it for a reader who
                  reaches this row on its own, without drawing it twice. */}
              <span className="sr-only">{stage.label}</span>
              {stage.at === undefined ? null : (
                <time dateTime={stage.at} className="truncate font-mono">
                  {formatTaskTime(stage.at, timeZone === undefined ? {} : { timeZone })}
                </time>
              )}
              {stage.durationMs === undefined ? null : (
                <TaskDuration
                  value={taskDuration(stage.durationMs, stage.state === 'active' ? 'elapsed' : 'total')}
                  className="truncate"
                />
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {notes.map((stage) => (
        <p
          key={stage.id}
          data-stage-note={stage.id}
          className={cn(
            'text-xs leading-normal',
            stage.state === 'failed' ? 'text-fail-text' : 'text-neutral-700',
          )}
        >
          {stage.label}
          {' · '}
          {stage.note}
        </p>
      ))}
    </div>
  );
}

/** Per-stage facts for a recording run, in the order the pipeline runs. */
export interface RecordingStageMeta {
  readonly state: StageState;
  readonly at?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly note?: ReactNode | undefined;
}

/**
 * The six recording stages with the caller's facts attached.
 *
 * Ids and labels come from `recordingStages()` — 启动 · 跳转 · 采集 · 稳定 ·
 * 编码 · 发布 are written down once, in the design layer, and this function
 * never repeats them. A caller that supplies fewer than six entries gets
 * `pending` for the rest, matching `recordingStages`'s own behaviour.
 */
export function recordingTaskStages(entries: readonly RecordingStageMeta[]): TaskStageEntry[] {
  const stages = recordingStages(entries.map((entry) => entry.state));

  return stages.map((stage, index) => {
    const meta = entries[index];
    return {
      id: stage.id,
      label: stage.label,
      state: stage.state,
      ...(meta?.at === undefined ? {} : { at: meta.at }),
      ...(meta?.durationMs === undefined ? {} : { durationMs: meta.durationMs }),
      ...(meta?.note === undefined ? {} : { note: meta.note }),
    };
  });
}
