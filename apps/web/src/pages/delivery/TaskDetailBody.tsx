/*
 * pages/delivery — the body of `/delivery/task/:taskId`, once the record has
 * arrived.
 *
 * `TaskDetailPage` owns the address, the frame and the three states a record
 * can be in on the way here (bad address / failed read / not yet loaded). This
 * component owns what is drawn when there *is* a record, which is why it takes
 * `item` rather than an id: the stage log query below only exists for one kind,
 * and asking for it before knowing the kind would mean a disabled query on
 * every visit.
 *
 * See `taskDetailModel.tsx` for the stage and log translation, and
 * `taskTransitions.ts` for why the two buttons are drawn from the machine.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

import { dataErrorMessage } from '../../data/errors';
import { useAnalysisRun } from '../../data/tasks';
import { TaskDetail, formatTaskClock, type TaskFact, type TaskLink } from '../../domain/task';
import type { ActivityItem } from '../../shared/desktop/dto';
import {
  analysisLogEntries,
  analysisStageEntries,
  recordingStageEntries,
} from './taskDetailModel';
import { taskStatusOfActivity } from './taskModel';
import { TASK_POLL_DETAIL_MS } from './taskPolling';
import { useTaskActions } from './useTaskActions';
import type { ServiceActionState } from '../../data/serviceAction';

export interface TaskDetailBodyProps {
  readonly item: ActivityItem;
  readonly service: ServiceActionState;
  readonly now?: Date | undefined;
}

export function TaskDetailBody({ item, service, now }: TaskDetailBodyProps) {
  const isAnalysis = item.kind === 'analysis';
  const analysis = useAnalysisRun(isAnalysis ? item.job_id : null, {
    pollWhileActiveMs: TASK_POLL_DETAIL_MS,
  });

  const bind = useTaskActions({ service, ...(now === undefined ? {} : { now }) });
  const bound = bind(item);
  const status = taskStatusOfActivity(item.status);

  const stages =
    item.kind === 'recording'
      ? recordingStageEntries(item, status)
      : isAnalysis
        ? analysisStageEntries(
          analysis.data?.run.stage ?? item.stage ?? '',
          status,
          analysis.data?.events ?? [],
        )
        : [];

  return (
    <TaskDetail
      className="m-6 min-h-0 flex-1"
      task={bound.summary}
      stages={stages}
      /* 查看阶段 points at this page; a link to where you already are is noise. */
      links={bound.links.filter((link: TaskLink) => link.id !== 'detail')}
      facts={detailFacts(item)}
      technicalDetails={technicalDetails(item)}
      log={
        !isAnalysis
          ? { status: 'ready', entries: [] }
          : analysis.isError
            ? {
              status: 'error',
              message: dataErrorMessage(analysis.error) ?? t`读取阶段日志失败。`,
              onRetry: () => void analysis.refetch(),
            }
            : analysis.data === undefined
              ? { status: 'loading' }
              : { status: 'ready', entries: analysisLogEntries(analysis.data.events) }
      }
      {...(bound.onCancel === undefined ? {} : { onCancel: bound.onCancel })}
      /*
       * The header's retry is only for a *cancelled* task (「重新发起」). A failed
       * one already carries its retry inside the failure Notice, where
       * 「每条都带一个主要恢复动作」 puts it — passing `onRetry` as well would
       * draw the same action twice, once in the header and once in the notice
       * three lines below it.
       */
      {...(bound.restart?.label === 'restart' && !bound.restart.disabled
        ? { onRetry: bound.restart.run }
        : {})}
    />
  );
}

/** The 340px rail: 开始 · 最近更新, plus the counted units when there are any. */
function detailFacts(item: ActivityItem): readonly TaskFact[] {
  const facts: TaskFact[] = [
    { id: 'started', label: <Trans>开始</Trans>, value: formatTaskClock(item.created_at) },
    { id: 'updated', label: <Trans>最近更新</Trans>, value: formatTaskClock(item.updated_at) },
  ];

  if (item.completed_units !== null && item.total_units !== null) {
    facts.push({
      id: 'units',
      label: <Trans>进度</Trans>,
      value: `${String(item.completed_units)} / ${String(item.total_units)}`,
    });
  }
  return facts;
}

/**
 * 「技术细节 · 进程、tick、编码参数」.
 *
 * None of those three are on the wire. What is: the locator the service
 * addresses this record by, the job id underneath it, and the export subtype —
 * the facts a bug report needs, which is what the drawer is for. They are
 * facts, not a stack trace, which `TaskDetail` structurally refuses to take.
 */
function technicalDetails(item: ActivityItem): readonly TaskFact[] {
  const facts: TaskFact[] = [
    { id: 'locator', label: <Trans>任务编号</Trans>, value: item.id },
    {
      id: 'kind',
      label: <Trans>类型</Trans>,
      value: item.subtype === null ? item.kind : `${item.kind} · ${item.subtype}`,
    },
  ];
  if (item.job_id !== null) {
    facts.push({ id: 'job', label: <Trans>作业编号</Trans>, value: item.job_id });
  }
  if (item.context_id !== null) {
    facts.push({ id: 'context', label: <Trans>来源对象</Trans>, value: item.context_id });
  }
  return facts;
}
