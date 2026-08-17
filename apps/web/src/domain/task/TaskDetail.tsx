/*
 * Domain layer, layer 2 of 3 — the body of a task detail.
 *
 * 「补齐 · 规范与状态」draws it as 任务详情与阶段日志: a 52px header (类型 · 目标
 * 对象, the id in mono, a state tag, the source link, 打开结果), then a two-column
 * body — stage bar over 阶段日志 on the left, a 340px rail of facts on the right
 * that ends with a collapsed 「技术细节 · 进程、tick、编码参数」 row.
 *
 * This is that body, not the page: the route, the toolbar and the surrounding
 * `Page` belong to `pages/delivery`, and this component never assumes it is
 * alone on a screen.
 *
 * ── The rule about raw stacks ──────────────────────────────────────────────
 *
 * The artboard's own annotation on the log panel reads 「用户语言；实现细节收在
 * “技术细节”里」, and phase 1's `RouteBoundary` settled the same question for
 * errors: a stack trace is not laid out on the page, because a reader who can
 * act on it does not need it printed there.
 *
 * That is enforced structurally rather than by convention — **there is no prop
 * that takes a stack**. `technicalDetails` is a list of label/value facts
 * (进程 / tick / 编码参数, exactly what the artboard names), and the failure
 * shows a closed-set reason plus the backend's own sentence. A caller holding a
 * stack has nowhere to put it, which is the point.
 *
 * ── The three states of the log ────────────────────────────────────────────
 *
 * The header renders from `task`, which the page already has; the stage log
 * arrives separately and therefore has its own three paths, each drawn by the
 * design layer rather than by hand:
 *
 *   loading  `design/data`'s `TableSkeleton` — bars and a stage name, and no
 *            percentage (「加载中 · 表格骨架（不显示虚构百分比）」)
 *   error    `design/feedback`'s `Notice`, per §4.1's 「错误就地渲染成 Notice」
 *   empty    `design/data`'s `EmptyState`
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { EmptyState, TableSkeleton } from '../../design/data';
import { Notice } from '../../design/feedback';
import { Button, Link, Badge, cn } from '../../design/primitives';

import { RetryNotice, type RetryNoticeProps } from './RetryNotice';
import { StageTimeline, type TaskStageEntry } from './StageTimeline';
import { TaskDuration } from './TaskDuration';
import { taskDurationFor } from './duration';
import { formatTaskTime } from './taskClock';
import { TASK_STATUS_TAG_TONE, taskFailureLabels, taskKindLabels, taskStatusLabels } from './taskVocabulary';
import type { TaskArtifact, TaskFact, TaskLink, TaskLogEntry, TaskSummary } from './types';

/** The stage log, which streams in after the task record itself. */
export type TaskLogState =
  | { readonly status: 'ready'; readonly entries: readonly TaskLogEntry[] }
  | { readonly status: 'loading'; readonly stage?: ReactNode | undefined }
  | { readonly status: 'error'; readonly message: ReactNode; readonly onRetry: () => void };

export interface TaskDetailProps {
  readonly task: TaskSummary;
  /** The stage sequence with its per-stage facts. Empty for kinds with none. */
  readonly stages?: readonly TaskStageEntry[] | undefined;
  readonly log?: TaskLogState | undefined;
  /** 用时 / 片段 / 重试 / 来源 Demo — the rail's label/value rows. */
  readonly facts?: readonly TaskFact[] | undefined;
  /** 产物链接: 「打开结果 Kael_Mirage_1v3.mp4」. */
  readonly artifacts?: readonly TaskArtifact[] | undefined;
  /** 「来源方案 #P-118」 and friends. */
  readonly links?: readonly TaskLink[] | undefined;
  /** 进程、tick、编码参数. Facts, never a stack — see the module note. */
  readonly technicalDetails?: readonly TaskFact[] | undefined;
  readonly retry?: Omit<RetryNoticeProps, 'className'> | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly onCancel?: (() => void) | undefined;
  readonly timeZone?: string | undefined;
  readonly className?: string | undefined;
}

const CANCELLABLE = new Set(['queued', 'running', 'awaiting-confirmation']);
const RETRYABLE = new Set(['failed', 'cancelled']);

export function TaskDetail({
  task,
  stages,
  log = { status: 'ready', entries: [] },
  facts,
  artifacts,
  links,
  technicalDetails,
  retry,
  onRetry,
  onCancel,
  timeZone,
  className,
}: TaskDetailProps) {
  const kindLabel = taskKindLabels()[task.kind];

  return (
    <section
      data-task={task.id}
      data-task-kind={task.kind}
      data-task-status={task.status}
      aria-label={t`任务详情`}
      className={cn('flex min-h-0 flex-col border border-divider bg-bg', className)}
    >
      {/* 52px header. `--h-topbar` is 56 and `--h-panel-head` is 40; this row
          holds a 19px title and a 32px button, so it takes the panel-head token
          and lets the padding carry the difference. */}
      <header className="flex flex-none flex-wrap items-center gap-3 border-b border-divider px-4 py-2">
        <h2 className="min-w-0 truncate text-xl leading-tight">
          {kindLabel}
          {' · '}
          {task.subject}
        </h2>
        <span className="font-mono text-xs text-neutral-600">{task.id}</span>
        <Badge variant={TASK_STATUS_TAG_TONE[task.status]}>{taskStatusLabels()[task.status]}</Badge>

        <div className="ml-auto flex flex-wrap items-center gap-3">
          {links?.map((link) => (
            <Link key={link.id} href={link.href} size="sm">
              {link.label}
            </Link>
          ))}
          {artifacts?.map((artifact) => (
            <Link
              key={artifact.id}
              href={artifact.href}
              size="sm"
              className={cn(artifact.missing === true && 'text-fail-text')}
            >
              {artifact.label}
            </Link>
          ))}
          {onCancel !== undefined && CANCELLABLE.has(task.status) ? (
            <Button variant="secondary" size="sm" onClick={onCancel}>
              <Trans>取消</Trans>
            </Button>
          ) : null}
          {onRetry !== undefined && RETRYABLE.has(task.status) ? (
            <Button variant="primary" size="sm" onClick={onRetry}>
              {task.status === 'cancelled' ? <Trans>重新发起</Trans> : <Trans>重试</Trans>}
            </Button>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* `min-h-0` so the stage log's own scroll can actually engage: without
            it a flex child refuses to shrink below its content and the overflow
            moves back out to the page. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-4 lg:border-r lg:border-divider">
          <StageTimeline
            label={t`任务阶段`}
            stages={stages ?? []}
            {...(timeZone === undefined ? {} : { timeZone })}
          />

          {task.status === 'failed' ? (
            <Notice
              tone="danger"
              action={{
                label: task.failure.recovery.label,
                onAction: task.failure.recovery.onAction,
                ...(task.failure.recovery.disabled === undefined
                  ? {}
                  : { disabled: task.failure.recovery.disabled }),
              }}
              {...(task.failure.impact === undefined ? {} : { detail: task.failure.impact })}
            >
              {taskFailureLabels()[task.failure.reason]}
              {task.failure.detail === undefined ? null : <>{' · '}{task.failure.detail}</>}
            </Notice>
          ) : null}

          <StageLog log={log} {...(timeZone === undefined ? {} : { timeZone })} />
        </div>

        <div className="flex w-full flex-none flex-col gap-3 p-4 lg:w-[var(--w-panel)]">
          {facts === undefined || facts.length === 0 ? null : (
            <dl className="m-0 flex flex-col gap-2 text-sm">
              {facts.map((fact) => (
                <div key={fact.id} className="flex items-baseline justify-between gap-3">
                  <dt className="text-neutral-600">{fact.label}</dt>
                  <dd className="m-0 min-w-0 truncate text-end font-mono">{fact.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {task.durationMs === undefined ? null : (
            <p className="text-sm">
              <TaskDuration value={taskDurationFor(task.durationMs, task.status)} />
            </p>
          )}

          {retry === undefined ? null : <RetryNotice {...retry} />}

          {technicalDetails === undefined || technicalDetails.length === 0 ? null : (
            <details className="mt-auto border border-divider bg-neutral-100">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm">
                <ChevronRight size={14} strokeWidth={1.5} aria-hidden className="flex-none" />
                <Trans>技术细节</Trans>
                <span className="text-2xs text-neutral-600">
                  <Trans>进程、tick、编码参数</Trans>
                </span>
              </summary>
              <dl className="m-0 flex flex-col gap-2 border-t border-divider px-3 py-2 text-xs">
                {technicalDetails.map((fact) => (
                  <div key={fact.id} className="flex items-baseline justify-between gap-3">
                    <dt className="text-neutral-600">{fact.label}</dt>
                    <dd className="m-0 min-w-0 truncate text-end font-mono">{fact.value}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </div>
      </div>
    </section>
  );
}

function StageLog({ log, timeZone }: { readonly log: TaskLogState; readonly timeZone?: string | undefined }) {
  if (log.status === 'loading') {
    return (
      <TableSkeleton
        rows={5}
        {...(log.stage === undefined ? {} : { stage: log.stage })}
        className="min-h-0 flex-1"
      />
    );
  }

  if (log.status === 'error') {
    return (
      <Notice tone="danger" action={{ label: <Trans>重新加载</Trans>, onAction: log.onRetry }}>
        {log.message}
      </Notice>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col border border-divider">
      <div className="flex h-[var(--h-thead)] flex-none items-center gap-2.5 border-b border-divider px-2.5 font-heading text-xs tracking-caps">
        <Trans>阶段日志</Trans>
        {/* The heading carries `--tracking-caps`; the hint beside it is prose
            and returns to normal spacing. There is no `tracking-normal` in this
            theme (§3 resets `--tracking-*`), so it is spelled out. */}
        <span className="text-2xs [letter-spacing:normal] text-neutral-600">
          <Trans>用户语言；实现细节收在「技术细节」里</Trans>
        </span>
      </div>

      {log.entries.length === 0 ? (
        <EmptyState
          title={<Trans>还没有阶段日志</Trans>}
          description={<Trans>任务每进入一个阶段，都会在这里留下一行。</Trans>}
          headingLevel={3}
          /* No recovery action: an empty log is not a fault to recover from —
             the task simply has not reached its first stage. `EmptyState`
             requires the slot, so it is filled with nothing rather than with a
             button that would do nothing. */
          actions={null}
        />
      ) : (
        /*
         * The log scrolls inside its own panel. A recording run logs one line
         * per stage per clip — six stages over a twenty-clip run is 120 lines,
         * about 3400px — and the panel is inside a 700px-tall window, so
         * without this the detail page grew a second scrollbar and the 阶段 bar
         * above it scrolled off the top.
         */
        <ol className="m-0 flex min-h-0 flex-1 list-none flex-col overflow-y-auto py-2 pl-0 text-sm">
          {log.entries.map((entry) => (
            <li
              key={entry.id}
              data-emphasis={entry.emphasis === true ? 'true' : undefined}
              className={cn(
                'flex gap-3 px-3 py-1.5',
                entry.emphasis === true && 'bg-accent-100 text-accent-900',
              )}
            >
              <time
                dateTime={entry.at}
                className={cn(
                  // 54.4px on the `--spacing` base; the artboard's stamp column
                  // is 56px, and the mono digits are the same width either way.
                  'w-16 flex-none font-mono text-xs',
                  entry.emphasis === true ? 'text-accent-800' : 'text-neutral-600',
                )}
              >
                {formatTaskTime(entry.at, timeZone === undefined ? {} : { timeZone })}
              </time>
              <span className="min-w-0 flex-1">{entry.message}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
