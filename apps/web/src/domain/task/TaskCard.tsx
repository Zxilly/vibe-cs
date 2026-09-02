/*
 * Domain layer, layer 2 of 3 — one task, as a card.
 *
 * The same shape appears twice in the reference and this component is both:
 * the 任务记录 entries of 「11 输出与任务记录」 and the 64px task rows of
 * 「01 工作台首页」. Reading the four entries the rail draws, a card is always
 *
 *   [marker] 录制 · Kael_Mirage_1v3                          #A-2481
 *            已完成 · 09:12 · 用时 6 分 41 秒 · 4 个片段
 *            ▓▓▓▓▓▓ 启动 跳转 采集 稳定 编码 发布        ← bar *or* stages
 *            查看结果 Kael_Mirage_1v3.mp4
 *
 * ── The progress rule ──────────────────────────────────────────────────────
 *
 * 「有真实分母时才用进度条，否则只给阶段名」 (「补齐 · 规范与状态」). `progress` is
 * therefore optional and its absence is a real branch, not a degraded one:
 *
 *   progress present   ProgressBar plus its readout (「62%」「2/6」)
 *   stages present     StageBar — the stage names, no number
 *   neither            nothing. A card with no denominator and no drawn stage
 *                      sequence (an export, a download) says the stage in its
 *                      status line and draws no graphic at all.
 *
 * Nothing here computes a percentage from a stage index. That would be the
 * front end simulating progress, which §4.3 forbids in as many words.
 *
 * ── Failure ────────────────────────────────────────────────────────────────
 *
 * A failed task renders a `Notice`, and `Notice` requires an action; `types.ts`
 * requires a `TaskFailure` on a failed task and a `recovery` on the failure. So
 * 「每条都带一个主要恢复动作」 is checked by the compiler at the call site rather
 * than by review here.
 *
 * ── Layer ──────────────────────────────────────────────────────────────────
 *
 * Pure presentation (§2.1 rule 6): no query, no store, no `data/**`. Everything
 * it draws arrives in `task`; everything it can do arrives as a callback.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { Alert, ProgressBar, StageBar, StatusDot, type Stage } from '../../design/feedback';
import { Button, Link, cn } from '../../design/primitives';
import { Skeleton } from '../../design/data';

import { TaskDuration } from './TaskDuration';
import { taskDurationFor } from './duration';
import { formatTaskClock } from './taskClock';
import {
  TASK_STATUS_DOT,
  taskFailureLabels,
  taskKindLabels,
  taskProgressUnitLabels,
  taskStatusLabels,
} from './taskVocabulary';
import type { TaskLink, TaskProgress, TaskProgressUnit, TaskSummary } from './types';

const HEADING_TAG = { 3: 'h3', 4: 'h4' } as const;

/**
 * The readout beside the bar. 「62%」 for a percentage, 「2/6」 for anything
 * counted — both drawn on 「01 工作台首页」, in the mono face, right aligned.
 */
const PROGRESS_READOUT: Readonly<Record<TaskProgressUnit, (progress: TaskProgress) => string>> = {
  percent: (progress) => `${String(progress.completed)}%`,
  stages: (progress) => `${String(progress.completed)}/${String(progress.total)}`,
  clips: (progress) => `${String(progress.completed)}/${String(progress.total)}`,
  bytes: (progress) => `${String(progress.completed)}/${String(progress.total)}`,
};

export interface TaskCardProps {
  readonly task: TaskSummary;
  /**
   * The drawn stage sequence, already labelled — build it with
   * `design/feedback`'s `recordingStages()` and `taskStageStates()`. Omitted
   * for the kinds the reference draws no bar for.
   */
  readonly stages?: readonly Stage[] | undefined;
  /** 「来源任务 #A-2481」「打开工程」 — navigation, not actions. */
  readonly links?: readonly TaskLink[] | undefined;
  /** 「取消」/「停止」. Rendered only while the task can still be stopped. */
  readonly onCancel?: (() => void) | undefined;
  /** Lets a stamp from today drop its date. See `taskClock.ts`. */
  readonly now?: Date | undefined;
  readonly timeZone?: string | undefined;
  readonly headingLevel?: 3 | 4 | undefined;
  /** Dense summaries can omit the technical locator; detail views still carry it. */
  readonly showId?: boolean | undefined;
  /** Drawer summaries cap diagnostic prose; the detail surface keeps it complete. */
  readonly compact?: boolean | undefined;
  readonly className?: string | undefined;
}

const CANCELLABLE = new Set(['queued', 'running', 'awaiting-confirmation']);

export function TaskCard({
  task,
  stages,
  links,
  onCancel,
  now,
  timeZone,
  headingLevel = 3,
  showId = true,
  compact = false,
  className,
}: TaskCardProps) {
  const Heading = HEADING_TAG[headingLevel];
  const kindLabel = taskKindLabels()[task.kind];
  const statusLabel = taskStatusLabels()[task.status];
  const failed = task.status === 'failed';

  const startedAt = formatTaskClock(task.startedAt, {
    ...(now === undefined ? {} : { now }),
    ...(timeZone === undefined ? {} : { timeZone }),
  });

  /* The status line, in the artboard's order: 状态 · 阶段 · 时刻 · 耗时 · 备注. */
  const facts: ReactNode[] = [statusLabel];
  if (failed) facts.push(taskFailureLabels()[task.failure.reason]);
  if (task.stage !== undefined) facts.push(<TaskStageText stage={task.stage} />);
  facts.push(<time dateTime={task.startedAt}>{startedAt}</time>);
  if (task.durationMs !== undefined) {
    facts.push(<TaskDuration value={taskDurationFor(task.durationMs, task.status)} />);
  }
  if (task.note !== undefined) facts.push(task.note);

  return (
    <article
      data-task={task.id}
      data-task-kind={task.kind}
      data-task-status={task.status}
      data-task-density={compact ? 'compact' : 'default'}
      className={cn('flex gap-3', className)}
    >
      <StatusDot status={TASK_STATUS_DOT[task.status]} size="lg" className="mt-1.5" />

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-baseline gap-3">
          <Heading className="min-w-0 truncate text-base leading-tight font-normal">
            {kindLabel}
            {' · '}
            {task.subject}
          </Heading>
          {showId ? <span className="ml-auto flex-none font-mono text-xs text-neutral-600">{task.id}</span> : null}
        </div>

        <p className={cn('text-xs leading-normal', failed ? 'text-fail-text' : 'text-neutral-600')}>
          <Separated items={facts} />
        </p>

        {task.progress === undefined
          ? stages === undefined || stages.length === 0
            ? null
            : <StageBar label={t`任务阶段`} stages={stages} />
          : <TaskProgressRow progress={task.progress} />}

        {task.status === 'failed' ? (
          <Alert
            variant="danger"
            action={{
              label: task.failure.recovery.label,
              onAction: task.failure.recovery.onAction,
              ...(task.failure.recovery.disabled === undefined
                ? {}
                : { disabled: task.failure.recovery.disabled }),
            }}
            {...(compact || task.failure.impact === undefined ? {} : { detail: task.failure.impact })}
            className={cn(compact && 'min-w-0')}
          >
            {compact ? (
              <span className="line-clamp-2 min-w-0 break-words [overflow-wrap:anywhere]">
                {task.failure.detail ?? taskFailureLabels()[task.failure.reason]}
              </span>
            ) : (
              task.failure.detail ?? taskFailureLabels()[task.failure.reason]
            )}
          </Alert>
        ) : null}

        {(task.artifacts !== undefined && task.artifacts.length > 0)
          || (links !== undefined && links.length > 0)
          || (onCancel !== undefined && CANCELLABLE.has(task.status)) ? (
            <div className="flex flex-wrap items-center gap-3">
              {task.artifacts?.map((artifact) => (
                // A missing artifact keeps its link — 「文件不在原位」 is a record
                // that still resolves to something (the relocate flow); the
                // colour is what says the file is gone.
                <Link
                  key={artifact.id}
                  href={artifact.href}
                  size="sm"
                  className={cn(artifact.missing === true && 'text-fail-text')}
                >
                  {artifact.label}
                </Link>
              ))}
              {links?.map((link) => (
                <Link key={link.id} href={link.href} size="sm">
                  {link.label}
                </Link>
              ))}
              {onCancel !== undefined && CANCELLABLE.has(task.status) ? (
                <Button variant="ghost" size="sm" onClick={onCancel} className="ml-auto">
                  <Trans>取消</Trans>
                </Button>
              ) : null}
            </div>
          ) : null}
      </div>
    </article>
  );
}

/** 「阶段 3/5 位置采样」, or just the stage name when there is no count. */
function TaskStageText({ stage }: { stage: NonNullable<TaskSummary['stage']> }) {
  const label = stage.label;

  if (stage.index === undefined || stage.count === undefined) return <>{label}</>;

  const index = stage.index;
  const count = stage.count;
  return <Trans>阶段 {index}/{count} {label}</Trans>;
}

/** The bar plus its right-aligned mono readout, as drawn on the home artboard. */
function TaskProgressRow({ progress }: { progress: TaskProgress }) {
  const readout = PROGRESS_READOUT[progress.unit](progress);
  const unitLabel = taskProgressUnitLabels()[progress.unit];

  return (
    <div className="flex items-center gap-4">
      <ProgressBar
        value={progress.completed}
        max={progress.total}
        label={t`任务进度`}
        valueText={readout}
        className="flex-1"
      />
      <span className="flex-none text-end font-mono text-sm">
        {readout}
        <span className="sr-only"> {unitLabel}</span>
      </span>
    </div>
  );
}

/** Joins the status line with the artboard's 「 · 」 separator. */
function Separated({ items }: { items: readonly ReactNode[] }) {
  return (
    <>
      {items.map((item, index) => (
        // The index is the identity here: these are positional fragments of one
        // sentence, not a list of things that can be reordered.
        <span key={index}>
          {index === 0 ? null : ' · '}
          {item}
        </span>
      ))}
    </>
  );
}

/**
 * The loading row of the 任务记录 rail. `design/data`'s `Skeleton` bars, no
 * percentage — 「加载中 · 表格骨架（不显示虚构百分比）」 applies to a task list as
 * much as to a table, and a task whose record has not arrived has no stage to
 * name either.
 */
export function TaskCardSkeleton({ className }: { readonly className?: string | undefined }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t`加载后台任务`}
      className={cn('flex gap-3', className)}
    >
      <span aria-hidden="true" className="mt-1.5 block size-[9px] flex-none animate-pulse bg-neutral-200" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton width="46%" className="h-3.5" />
        <Skeleton width="72%" />
      </div>
    </div>
  );
}
