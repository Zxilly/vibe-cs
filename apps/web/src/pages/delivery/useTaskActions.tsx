/*
 * pages/delivery — turning one activity record into the props `domain/task`'s
 * card takes: a summary, a cancel handler, a recovery action, and the links
 * back to whatever produced it.
 *
 * `ActivityItem.available_actions` is authoritative for cancel and retry. The
 * UI does not reconstruct a second lifecycle from the returned status.
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
import { useHref, useNavigate } from 'react-router-dom';

import { useCancelTask, useRetryTask } from '../../data/tasks';
import type { TaskLink, TaskSummary } from '../../domain/task';
import type { ActivityItem } from '../../shared/desktop/viewModels';
import { taskStatusOfActivity, toTaskSummary } from './taskModel';

/** The address of one task record: `kind:jobId`, the service's own locator. */
export function taskDetailPath(item: ActivityItem): string {
  return `/delivery/task/${encodeURIComponent(item.id)}`;
}

export interface TaskCardBindings {
  readonly summary: TaskSummary;
  readonly links: readonly TaskLink[];
  /** 「取消」, present only when the returned record offers it. */
  readonly onCancel: (() => void) | undefined;
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
   * its own note. The router is in hash mode (§1.1), where `/delivery/task/x`
   * has to be written `#/delivery/task/x`, and `useHref` is react-router's
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
    const restartable = jobId !== null && retryAction !== null;

    const run = (): void => {
      if (jobId === null || retryAction === null) return;
      if (retryAction === 'retry_recording') {
        void navigate('/projects');
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
      recovery: recoveryFor({ item, restartable, run, navigate }),
      ...(status === 'cancelled' ? { note: <Trans>可重新发起</Trans> } : {}),
    });

    return {
      summary,
      links: linksFor(item, restartable && status === 'failed', routeHref),
      onCancel:
        cancellable && jobId !== null
          ? () => cancel.mutate({ kind: item.kind, jobId })
          : undefined,
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
  readonly restartable: boolean;
  readonly run: () => void;
  readonly navigate: (to: string) => void;
}

function recoveryFor({ item, restartable, run, navigate }: RecoveryInput) {
  if (restartable) {
    return {
      label: item.kind === 'recording' ? <Trans>打开作品</Trans> : <Trans>重试</Trans>,
      onAction: run,
    };
  }

  const project = projectPathOf(item);
  if (project !== null) {
    return { label: <Trans>打开作品</Trans>, onAction: () => void navigate(project) };
  }

  return {
    label: <Trans>查看阶段日志</Trans>,
    onAction: () => void navigate(taskDetailPath(item)),
  };
}

/**
 * Where a failed export's project lives. `context_id` is the project id
 * (`crates/application/src/routes/activity.rs`) and `subtype` says which editor
 * owns it — the same two export kinds `taskModel` reads for 合辑.
 */
function projectPathOf(item: ActivityItem): string | null {
  if (item.kind !== 'export' || item.context_id === null) return null;
  const id = encodeURIComponent(item.context_id);
  return `/projects/${id}`;
}

/** 「查看阶段」 and, for an export, 「打开工程」 beside it. */
function linksFor(
  item: ActivityItem,
  failedWithRetry: boolean,
  routeHref: (path: string) => string,
): readonly TaskLink[] {
  const links: TaskLink[] = [
    { id: 'detail', label: <Trans>查看阶段</Trans>, href: routeHref(taskDetailPath(item)) },
  ];

  const project = projectPathOf(item);
  if (project !== null && failedWithRetry) {
    links.push({ id: 'project', label: <Trans>打开作品</Trans>, href: routeHref(project) });
  }
  return links;
}
