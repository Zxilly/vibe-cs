/*
 * pages/delivery — turning one activity record into the props `domain/task`'s
 * card takes: a summary, a cancel handler, a recovery action, and the links
 * back to whatever produced it.
 *
 * ── Two gates, both required ──────────────────────────────────────────────
 *
 * An action is offered only when **the lifecycle allows it and the service
 * offers it**:
 *
 *   `taskTransitions`      `taskMachine` accepts the event from where this
 *                          record stands (§4.3 — the page does not decide on
 *                          its own that something is cancellable)
 *   `available_actions`    the service's own list on `ActivityItem`, which
 *                          knows things the machine cannot: a download is only
 *                          retryable while the Steam account that owns it is
 *                          still configured, an analysis only while its demo is
 *                          still in the library.
 *
 * Either gate closing hides the button. They are not redundant — the machine
 * knows the shape of a life, the service knows this one's circumstances.
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

import { useCancelTask, useRetryRecordingPlan, useRetryTask } from '../../data/tasks';
import type { TaskLink, TaskSummary } from '../../domain/task';
import type { ActivityItem } from '../../shared/desktop/viewModels';
import { taskKindOfActivity, taskStagePositionOf, taskStatusOfActivity, toTaskSummary } from './taskModel';
import { canCancelTask, taskRestartEvent } from './taskTransitions';
import type { ServiceActionState } from '../../data/serviceAction';
import { recordingHref } from '../recording/recordingContract';

/** The address of one task record: `kind:jobId`, the service's own locator. */
export function taskDetailPath(item: ActivityItem): string {
  return `/delivery/task/${encodeURIComponent(item.id)}`;
}

export interface TaskCardBindings {
  readonly summary: TaskSummary;
  readonly links: readonly TaskLink[];
  /**
   * 「取消」. **Absent while the local service is unreachable**, which is the one
   * place this page hides an action instead of disabling it: `domain/task`'s
   * `TaskCard` takes a bare `onCancel` callback and has no slot for a disabled
   * reason, so the choice is between hiding it and offering a button that
   * silently fails. Reported as a gap — `TaskCard` wants the same
   * `{ disabled, disabledReason }` pair `Button` already understands.
   */
  readonly onCancel: (() => void) | undefined;
  /**
   * Present whenever the lifecycle and the service both allow a re-run, service
   * connectivity aside — a blocked one is `disabled` with a reason rather than
   * missing, per 「需要服务的动作变为禁用并写明原因，不隐藏、不静默失败」.
   */
  readonly restart:
    | {
      readonly label: 'retry' | 'restart';
      readonly run: () => void;
      readonly disabled: boolean;
      readonly disabledReason?: string | undefined;
    }
    | undefined;
}

export interface TaskActionsOptions {
  readonly service: ServiceActionState;
  readonly now?: Date | undefined;
}

/**
 * The one place the delivery surface binds a record to its writes. Both views
 * and the workbench digest call it, so 取消 means the same thing in all three.
 */
export function useTaskActions({ service, now }: TaskActionsOptions) {
  const navigate = useNavigate();
  const cancel = useCancelTask();
  const retry = useRetryTask();
  const retryRecording = useRetryRecordingPlan();

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
    const kind = taskKindOfActivity(item);
    const status = taskStatusOfActivity(item.status);
    const stage = taskStagePositionOf(item);
    const lifecycle = {
      kind,
      status,
      ...(stage === undefined ? {} : { stageId: stage.id }),
    };

    const serviceReady = !service.blocked;
    const jobId = item.job_id;

    const cancellable =
      jobId !== null
      && serviceReady
      && canCancelTask(lifecycle)
      && item.available_actions.includes('cancel');

    const restartEvent = taskRestartEvent(lifecycle);
    const retryAction = retryActionOf(item);
    const restartable = jobId !== null && restartEvent !== null && retryAction !== null;

    const run = (): void => {
      // Defensive: the button is disabled while the service is unreachable, and
      // a keyboard or a test that gets past that must still not fire an IPC
      // call that can only fail.
      if (!serviceReady) return;
      if (jobId === null || retryAction === null) return;
      if (retryAction === 'retry_recording') {
        retryRecording.mutate(
          { kind: item.kind, jobId },
          {
            // §4.5.3 ①: the plan is reviewed and confirmed on the recording
            // page. Navigating *is* the action here; nothing is started.
            onSuccess: (plan) => void navigate(recordingHref(plan.plan_id)),
          },
        );
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
      recovery: recoveryFor({ item, restartable, restartEvent, run, navigate, service }),
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
        restartable && restartEvent !== null
          ? {
            label: restartEvent.type === 'RESTART' ? 'restart' : 'retry',
            run,
            disabled: service.buttonProps.disabled,
            ...(service.buttonProps.disabledReason === undefined
              ? {}
              : { disabledReason: service.buttonProps.disabledReason }),
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
  readonly restartEvent: { readonly type: string } | null;
  readonly run: () => void;
  readonly navigate: (to: string) => void;
  readonly service: ServiceActionState;
}

function recoveryFor({ item, restartable, restartEvent, run, navigate, service }: RecoveryInput) {
  if (restartable && restartEvent !== null) {
    return {
      label: <Trans>重试</Trans>,
      onAction: run,
      ...(service.blocked ? { disabled: true } : {}),
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
  return item.subtype === 'montage' ? `/montage/${id}` : `/editor/${id}`;
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
