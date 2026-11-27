/*
 * pages/delivery — turning one activity record into the props `domain/task`'s
 * card takes: a summary, a cancel handler, a recovery action, and the links
 * back to whatever produced it.
 *
 * `ActivityItem.available_actions` is authoritative for cancel, retry and the
 * `open_*` destinations. The UI does not reconstruct a second lifecycle from
 * the returned status, and it does not invent a destination the record did
 * not offer: a finished export links to 成品文件 because the service said
 * `open_outputs`, not because exports usually have one.
 *
 * ── Every failure gets a real recovery action ─────────────────────────────
 *
 * `TaskFailure.recovery` is required by the type, so the question is never
 * "whether" but "which". In order:
 *
 *   retryable            重试 — the mutation for its kind
 *   an export           「打开工程」 — §10.3 and `data/tasks.ts` both record that
 *                        there is no `retry_export`; the artboard draws exactly
 *                        this link beside the failed export
 *   anything else       「查看阶段日志」 — the detail page, which is where the
 *                        reason lives
 *
 * The last one is a navigation rather than a repair, and that is honest: a task
 * whose failure this build cannot act on should say where to look, not offer a
 * button that reruns nothing.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { useHref, useNavigate } from 'react-router-dom';

import { useCancelTask, useRetryTask } from '../../data/tasks';
import type { TaskLink, TaskSummary } from '.';
import type { ActivityAction, ActivityStateFilter } from '../../shared/desktop/dto';
import type { ActivityItem } from '../../shared/desktop/viewModels';
import { taskStatusOfActivity, toTaskSummary } from './taskModel';

/**
 * The task center's own state filters, in the order its segmented control shows
 * them. `/tasks?state=…` opens the list already filtered, so a 「查看进度」 or a
 * failure notice lands on the records it talks about instead of on 全部.
 */
export const TASK_CENTER_STATES = ['active', 'failed', 'completed', 'cancelled'] as const satisfies readonly ActivityStateFilter[];

/**
 * What a task-center link narrows to. `demoId` scopes the list to that Demo's
 * analysis runs (`kind=analysis` plus the Demo id, which the service keeps in
 * every analysis row's search text); it is for links that start from one Demo.
 */
export interface TaskCenterScope {
  readonly state?: ActivityStateFilter;
  readonly demoId?: string;
}

/** The task center, optionally opened on one state filter and/or one Demo. */
export function taskCenterPath({ state, demoId }: TaskCenterScope = {}): string {
  const params = new URLSearchParams();
  if (state !== undefined) params.set('state', state);
  if (demoId !== undefined) params.set('demo', demoId);
  const query = params.toString();
  return query === '' ? '/tasks' : `/tasks?${query}`;
}

/** The address of one task record: `kind:jobId`, the service's own locator. */
export function taskDetailPath(item: ActivityItem): string {
  return `/tasks/${encodeURIComponent(item.id)}`;
}

export interface TaskCardBindings {
  readonly summary: TaskSummary;
  readonly links: readonly TaskLink[];
  /** 「取消」, present only when the returned record offers it. */
  readonly onCancel: (() => void) | undefined;
  /** The cancel request for *this* record is still in flight. */
  readonly cancelPending: boolean;
  /** Present only when the returned record offers a supported retry action. */
  readonly restart:
    | {
      readonly label: 'retry' | 'restart';
      readonly run: () => void;
    }
    | undefined;
}

export interface TaskActionsOptions {
  readonly now?: Date | undefined;
}

/**
 * The one place the delivery surface binds a record to its writes. Both views
 * and the workbench digest call it, so 取消 means the same thing in all three.
 */
export function useTaskActions({ now }: TaskActionsOptions = {}) {
  const navigate = useNavigate();
  const cancel = useCancelTask();
  const retry = useRetryTask();

  /*
   * `domain/task`'s `TaskLink.href` reaches `design/primitives/Link`, which
   * takes a plain href and knows nothing about the router — deliberately, per
   * its own note. The router is in hash mode (§1.1), where `/tasks/x`
   * has to be written `#/tasks/x`, and `useHref` is react-router's
   * answer. It cannot be called per link (the number of links varies per
   * render), so the prefix is resolved once from the root path and applied by
   * hand. `RouteLink` does the same thing for a single destination.
   */
  const root = useHref('/');
  const routeHref = (path: string): string => `${root.replace(/\/$/u, '')}${path}`;

  return function bind(item: ActivityItem): TaskCardBindings {
    const status = taskStatusOfActivity(item.status);
    const jobId = item.job_id;
    const cancellable = jobId !== null && item.available_actions.includes('cancel');
    const retryAction = retryActionOf(item);
    const project = projectPathOf(item);
    /* A recording is re-run from its owning Project's 「录制缺失片段」
       confirmation, so it is restartable here only when the service names
       that Project (`project_id`). A run no Project owns falls through to the
       stage log rather than to a list it does not belong to. */
    const restartable = jobId !== null && retryAction !== null
      && (retryAction !== 'retry_recording' || project !== null);

    const run = (): void => {
      if (jobId === null || retryAction === null) return;
      if (retryAction === 'retry_recording') {
        if (project !== null) void navigate(project);
        return;
      }
      retry.mutate({
        kind: item.kind,
        jobId,
        ...(item.context_id === null ? {} : { contextId: item.context_id }),
      });
    };

    const summary = toTaskSummary(item, {
      ...(now === undefined ? {} : { now }),
      recovery: recoveryFor({ item, project, restartable, run, navigate }),
      ...(status === 'cancelled' && restartable ? { note: <Trans>可重新发起</Trans> } : {}),
    });

    return {
      summary,
      links: linksFor(item, project, restartable && status === 'failed', routeHref),
      onCancel:
        cancellable && jobId !== null
          ? () => cancel.mutate({ kind: item.kind, jobId })
          : undefined,
      cancelPending: cancel.isPending && cancel.variables.jobId === jobId,
      restart:
        restartable
          ? {
            label: status === 'cancelled' ? 'restart' : 'retry',
            run,
          }
          : undefined,
    };
  };
}

/** Which `ActivityAction` would re-run this record, or `null` for none. */
function retryActionOf(item: ActivityItem): 'retry_analysis' | 'retry_download' | 'retry_recording' | null {
  if (item.available_actions.includes('retry_analysis')) return 'retry_analysis';
  if (item.available_actions.includes('retry_download')) return 'retry_download';
  if (item.available_actions.includes('retry_recording')) return 'retry_recording';
  return null;
}

interface RecoveryInput {
  readonly item: ActivityItem;
  readonly project: string | null;
  readonly restartable: boolean;
  readonly run: () => void;
  readonly navigate: (to: string) => void;
}

function recoveryFor({ item, project, restartable, run, navigate }: RecoveryInput) {
  if (restartable) {
    return {
      label: item.kind === 'recording' ? <Trans>在作品中重新录制</Trans> : <Trans>重试</Trans>,
      onAction: run,
    };
  }

  if (project !== null) {
    return { label: <Trans>打开作品</Trans>, onAction: () => void navigate(project) };
  }

  return {
    label: <Trans>查看阶段日志</Trans>,
    onAction: () => void navigate(taskDetailPath(item)),
  };
}

/**
 * The workspace of the Project that owns this record: an export's Project, or
 * the Project a recording run was bound to (`project_id`,
 * `crates/application/src/routes/activity.rs`). A recording's `context_id` is
 * its Demo, so it cannot stand in here.
 */
function projectPathOf(item: ActivityItem): string | null {
  if (item.project_id === null) return null;
  return `/projects/${encodeURIComponent(item.project_id)}`;
}

/**
 * The `open_*` members of `available_actions`, as destinations. `open_analysis`
 * needs the demo behind the run, which is `context_id`
 * (`crates/application/src/routes/activity.rs`); a record without one has
 * nowhere to go and gets no link.
 */
function destinationLink(action: ActivityAction, item: ActivityItem): { id: string; label: ReactNode; path: string } | null {
  switch (action) {
    case 'open_outputs':
      return {
        id: 'outputs',
        label: <Trans>查看成品</Trans>,
        path: item.kind === 'export' && item.context_id !== null
          ? `/delivery?view=outputs&project=${encodeURIComponent(item.context_id)}`
          : '/delivery?view=outputs',
      };
    case 'open_library':
      return { id: 'library', label: <Trans>打开资料库</Trans>, path: '/library' };
    case 'open_match_history':
      return { id: 'match-history', label: <Trans>打开比赛历史</Trans>, path: '/library?view=steam' };
    case 'open_analysis':
      return item.context_id === null
        ? null
        : { id: 'analysis', label: <Trans>打开分析</Trans>, path: `/match/${encodeURIComponent(item.context_id)}` };
    default:
      return null;
  }
}

/** 「查看阶段」, then 「打开作品」 beside a failed, retryable record, then the record's `open_*` destinations. */
function linksFor(
  item: ActivityItem,
  project: string | null,
  failedWithRetry: boolean,
  routeHref: (path: string) => string,
): readonly TaskLink[] {
  const links: TaskLink[] = [
    { id: 'detail', label: <Trans>查看阶段</Trans>, href: routeHref(taskDetailPath(item)) },
  ];

  if (project !== null && failedWithRetry) {
    links.push({ id: 'project', label: <Trans>打开作品</Trans>, href: routeHref(project) });
  }
  for (const action of item.available_actions) {
    const destination = destinationLink(action, item);
    if (destination !== null) {
      links.push({ id: destination.id, label: destination.label, href: routeHref(destination.path) });
    }
  }
  return links;
}
