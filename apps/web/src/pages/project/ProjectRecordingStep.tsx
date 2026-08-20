import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useQuickCheck } from '../../data/config';
import { dataErrorMessage } from '../../data/errors';
import { useServiceAction } from '../../data/serviceAction';
import { activityIsActive, useRecordingJob } from '../../data/tasks';
import { Empty, Skeleton } from '../../design/data';
import { Alert, StatusDot, type StatusDotStatus } from '../../design/feedback';
import type { ProjectViewModel } from '../../domain/project/projectViewModel';
import type { DependencyCheck } from '../../shared/desktop/dto';
import type { ActivityItem } from '../../shared/desktop/viewModels';
import { RecordingPlanWorkspace } from '../RecordingPage';
import { RouteLink } from '../RouteLink';
import { settingsPath } from '../settings/settingsRoutes';
import { TaskFeedList } from '../delivery/TaskFeedList';
import { TASK_POLL_DETAIL_MS } from '../delivery/taskPolling';
import { useTaskActions } from '../delivery/useTaskActions';

export interface ProjectRecordingStepProps {
  readonly project: ProjectViewModel;
  readonly tasksPending: boolean;
  readonly tasksError: string | null;
  readonly onReload: () => void;
}

/**
 * The recording step and the activity drawer intentionally consume the same
 * unfiltered activity-feed query. `useProjects` assigns those records to their
 * project; this component only renders that assignment and never keeps a
 * second queue. Per-clip detail comes from the recording job record because the
 * activity row only carries stage progress.
 */
export function ProjectRecordingStep({
  project,
  tasksPending,
  tasksError,
  onReload,
}: ProjectRecordingStepProps) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const service = useServiceAction();
  const checks = useQuickCheck();
  const bind = useTaskActions({ service });

  const recordPath = `/projects/${encodeURIComponent(project.id)}?step=record`;
  const shotListPath = `/projects/${encodeURIComponent(project.id)}?step=shotlist`;
  const preparing = params.get('prepare') === '1';
  const canPrepare = project.source.kind === 'plan';
  const showPlanner = canPrepare
    && (preparing || (!tasksPending && tasksError === null && project.recordingTasks.length === 0));

  if (!canPrepare) {
    return (
      <Empty
        className="m-7"
        title={<Trans>这类作品不需要录制步骤</Trans>}
        description={<Trans>快速模式和精剪模式直接从现有素材导出，不会启动 CS2 录制管线。</Trans>}
        actions={<RouteLink to={`/projects/${encodeURIComponent(project.id)}?step=export`}><Trans>前往导出</Trans></RouteLink>}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-project-recording-step>
      <RecordingEnvironmentNotice
        checks={checks.data?.checks ?? []}
        error={dataErrorMessage(checks.error)}
        onReload={() => void checks.refetch()}
        onSettings={() => void navigate(settingsPath('game'))}
      />

      {showPlanner ? (
        <RecordingPlanWorkspace
          embedded
          agentPlanId={project.source.id}
          successTarget={recordPath}
          backTarget={shotListPath}
        />
      ) : (
        <section className="flex min-h-0 flex-1 flex-col" aria-label={t`录制队列`}>
          <header className="flex h-[var(--h-panel-head)] flex-none items-center gap-3 border-b border-divider px-5">
            <h2 className="font-heading text-sm tracking-caps"><Trans>录制队列</Trans></h2>
            <span className="text-xs text-neutral-600"><Trans>{project.recordingTasks.length} 个任务</Trans></span>
            <div className="flex-1" aria-hidden="true" />
            <RouteLink to={`${recordPath}&prepare=1`} size="sm"><Trans>准备新的录制</Trans></RouteLink>
            <RouteLink to={settingsPath('recording-defaults')} size="sm"><Trans>录制设置</Trans></RouteLink>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <TaskFeedList
              items={project.recordingTasks}
              bind={bind}
              isLoading={tasksPending}
              {...(tasksError === null ? {} : { errorMessage: tasksError })}
              onReload={onReload}
              emptyTitle={<Trans>还没有录制任务</Trans>}
              emptyDescription={<Trans>从剪辑单点击「送去录制」，检查环境后即可开始。</Trans>}
              emptyActions={<RouteLink to={`${recordPath}&prepare=1`}><Trans>准备录制</Trans></RouteLink>}
              renderAfter={(task) => <RecordingClipProgress task={task} />}
            />
          </div>
        </section>
      )}
    </div>
  );
}

function RecordingEnvironmentNotice({
  checks,
  error,
  onReload,
  onSettings,
}: {
  readonly checks: readonly DependencyCheck[];
  readonly error: string | null;
  readonly onReload: () => void;
  readonly onSettings: () => void;
}) {
  if (error !== null) {
    return (
      <Alert className="m-4 mb-0" variant="danger" action={{ label: <Trans>重试</Trans>, onAction: onReload }}>
        <Trans>读不到录制环境状态：{error}</Trans>
      </Alert>
    );
  }

  const missing = checks.filter((check) => check.state === 'missing');
  if (missing.length === 0) return null;

  return (
    <Alert
      className="m-4 mb-0"
      variant="warning"
      action={{ label: <Trans>去设置</Trans>, onAction: onSettings }}
      detail={
        <ul className="flex list-none flex-col gap-1 p-0">
          {missing.map((check) => (
            <li key={check.kind} data-recording-environment-missing={check.kind}>
              {check.label}{check.detail === '' ? '' : ` — ${check.detail}`}
            </li>
          ))}
        </ul>
      }
    >
      <Trans>录制环境还没准备好；录制前校验会保持开始按钮禁用，并写明阻塞原因。</Trans>
    </Alert>
  );
}

function RecordingClipProgress({ task }: { readonly task: ActivityItem }) {
  const active = activityIsActive(task);
  const job = useRecordingJob(task.job_id, {
    pollMs: active ? TASK_POLL_DETAIL_MS : false,
  });
  const failure = dataErrorMessage(job.error);

  if (task.job_id === null) return null;
  if (failure !== null) {
    return (
      <Alert className="mt-3" variant="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void job.refetch() }}>
        <Trans>读不到逐片段进度：{failure}</Trans>
      </Alert>
    );
  }
  if (job.data === undefined) return <Skeleton className="mt-3" width="72%" />;

  const completed = job.data.outputs.length;
  return (
    <div className="mt-3 border-t border-divider pt-3" data-recording-clips={job.data.items.length}>
      <p className="mb-2 text-xs text-neutral-600">
        <Trans>片段进度 {completed}/{job.data.items.length}</Trans>
      </p>
      <ol className="grid list-none grid-cols-1 gap-2 p-0 md:grid-cols-2">
        {job.data.items.map((item, index) => {
          const state = clipState(task, index, completed, job.data.current_index);
          return (
            <li key={item.id ?? `${item.demo_id}:${String(index)}`} className="flex min-w-0 items-center gap-2 text-xs" data-recording-clip-state={state.id}>
              <StatusDot status={state.dot} size="sm" />
              <span className="truncate">{item.title}</span>
              <span className="ml-auto flex-none text-neutral-600">{state.label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function clipState(
  task: ActivityItem,
  index: number,
  completed: number,
  currentIndex: number,
): { readonly id: 'completed' | 'active' | 'pending' | 'stopped'; readonly dot: StatusDotStatus; readonly label: ReactNode } {
  if (index < completed) return { id: 'completed', dot: 'ok', label: <Trans>已完成</Trans> };
  if (activityIsActive(task) && index === currentIndex) {
    return { id: 'active', dot: 'running', label: <Trans>录制中</Trans> };
  }
  if (task.status === 'failed' || task.status === 'cancelled') {
    return { id: 'stopped', dot: task.status === 'failed' ? 'fail' : 'warn', label: <Trans>未完成</Trans> };
  }
  return { id: 'pending', dot: 'idle', label: <Trans>等待</Trans> };
}
