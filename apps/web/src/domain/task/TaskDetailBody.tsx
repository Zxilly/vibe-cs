/*
 * pages/delivery — the body of `/tasks/:taskId`, once the record has
 * arrived.
 *
 * `TaskDetailPage` owns the address, the frame and the three states a record
 * can be in on the way here (bad address / failed read / not yet loaded). This
 * component owns what is drawn when there *is* a record, which is why it takes
 * `item` rather than an id: the stage log query below only exists for one kind,
 * and asking for it before knowing the kind would mean a disabled query on
 * every visit.
 *
 * See `taskDetailModel.tsx` for the stage and log translation.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

import { dataErrorMessage } from '../../data/errors';
import { useAnalysisRun, useExportJob } from '../../data/tasks';
import { TaskDetail, formatTaskClock, type TaskFact, type TaskLink } from '.';
import type { ActivityItem } from '../../shared/desktop/viewModels';
import {
  analysisLogEntries,
  analysisStageEntries,
  recordingStageEntries,
} from './taskDetailModel';
import { taskProgressOfActivity, taskStatusOfActivity } from './taskModel';
import { TASK_POLL_DETAIL_MS } from './taskPolling';
import { formatTaskProgress } from './taskProgress';
import { useTaskActions } from './useTaskActions';

export interface TaskDetailBodyProps {
  readonly item: ActivityItem;
  readonly now?: Date | undefined;
  readonly compact?: boolean | undefined;
}

export function TaskDetailBody({ item, now, compact = false }: TaskDetailBodyProps) {
  const isAnalysis = item.kind === 'analysis';
  const analysis = useAnalysisRun(isAnalysis ? item.job_id : null, {
    pollWhileActiveMs: TASK_POLL_DETAIL_MS,
  });
  /* The activity record titles an export by its Project; the file it wrote
     lives on the job record, and only 技术细节 prints it. */
  const exportJob = useExportJob(item.kind === 'export' ? item.job_id : null);

  const bind = useTaskActions(now === undefined ? {} : { now });
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
      {...(item.kind === 'export' ? { title: <Trans>成片导出</Trans> } : {})}
      showId={compact}
      stages={stages}
      /* On the task page 查看阶段 points at where you already are, which is
         noise; the compact panel and the drawer are not that page, so there
         the same link is the way to an address that can be shared. */
      links={bound.links.flatMap((link: TaskLink): TaskLink[] =>
        link.id !== 'detail' ? [link] : compact ? [{ ...link, label: <Trans>打开任务页</Trans> }] : [])}
      facts={detailFacts(item)}
      technicalDetails={technicalDetails(item, exportJob.data?.job.output_path ?? null)}
      technicalDetailsExpanded={item.kind === 'export'}
      compact={compact}
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
      cancelPending={bound.cancelPending}
      /*
       * The header's retry is only for a *cancelled* task (「重新发起」). A failed
       * one already carries its retry inside the failure Notice, where
       * 「每条都带一个主要恢复动作」 puts it — passing `onRetry` as well would
       * draw the same action twice, once in the header and once in the notice
       * three lines below it.
       */
      {...(bound.restart?.label === 'restart'
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

  const progress = taskProgressOfActivity(item);
  if (progress !== undefined && progress.unit !== 'percent') {
    facts.push({ id: 'units', label: <Trans>进度</Trans>, value: formatTaskProgress(progress) });
  }
  return facts;
}

/**
 * 「技术细节 · 查看诊断信息」.
 *
 * None of those three are on the wire. What is: the locator the service
 * addresses this record by, the job id underneath it, and the export subtype —
 * the facts a bug report needs, which is what the drawer is for. They are
 * facts, not a stack trace, which `TaskDetail` structurally refuses to take.
 */
function technicalDetails(item: ActivityItem, outputPath: string | null): readonly TaskFact[] {
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
  if (outputPath !== null && outputPath.trim() !== '') {
    facts.push({ id: 'output-path', label: <Trans>文件路径</Trans>, value: outputPath });
  }
  return facts;
}
