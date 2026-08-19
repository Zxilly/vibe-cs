import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

import { useProjects } from '../data/projects';
import { Empty, Skeleton } from '../design/data';
import { Page, Toolbar } from '../design/layout';
import { Button } from '../design/primitives';
import type { ProjectStep, ProjectViewModel } from '../domain/project/projectViewModel';
import { projectStepAvailability, resolveProjectStep } from '../domain/project/projectWorkflow';
import { AgentWorkspace } from './AgentPage';
import { MontageWorkspace } from './MontagePage';
import { EditorWorkspaceLoader } from './EditorPage';
import { ProjectRecordingStep } from './project/ProjectRecordingStep';
import { ProjectSelectStep } from './project/ProjectSelectStep';
import { RouteLink } from './RouteLink';

export function ProjectWorkspacePage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const [params, setParams] = useSearchParams();
  const projects = useProjects();
  const project = projects.data.projects.find((entry) => entry.id === projectId)
    ?? (projectId === 'new' ? NEW_PROJECT : null);

  const requested = params.get('step');
  const step = project === null ? 'select' : resolveProjectStep(project, requested);

  useEffect(() => {
    if (project === null || requested === step) return;
    setParams({ step }, { replace: true });
  }, [project, requested, setParams, step]);

  if (projects.isPending) {
    return (
      <Page toolbar={<Toolbar title={<Trans>作品工作区</Trans>} meta={projectId} />}>
        <div className="flex flex-col gap-5 p-7" role="status" aria-busy="true">
          <Skeleton className="h-12" />
          <Skeleton className="h-48" />
        </div>
      </Page>
    );
  }

  if (project === null) {
    return (
      <Page toolbar={<Toolbar title={<Trans>作品工作区</Trans>} meta={projectId} />}>
        <div className="p-7">
          <Empty title={<Trans>找不到这份作品</Trans>} description={<Trans>它可能来自尚未读取成功的旧工程。</Trans>} actions={<RouteLink to="/projects"><Trans>返回作品列表</Trans></RouteLink>} />
        </div>
      </Page>
    );
  }

  const availability = projectStepAvailability(project);

  return (
    <Page toolbar={<Toolbar leading={<RouteLink to="/projects"><Trans>‹ 作品</Trans></RouteLink>} title={project.id === 'new' ? <Trans>新作品</Trans> : project.name} meta={<StepLabel step={step} />} />}>
      <div className="flex min-h-0 flex-1 flex-col">
        <nav aria-label={t`作品步骤`} className="flex-none border-b border-divider p-3">
          <ol className="m-0 grid list-none grid-cols-4 gap-2 p-0">
            {availability.map((entry) => (
              <li key={entry.step}>
                <Button
                  variant={entry.step === step ? 'primary' : 'secondary'}
                  size="md"
                  block
                  disabled={!entry.enabled}
                  {...(entry.disabledReason === null ? {} : { disabledReason: entry.disabledReason })}
                  onClick={() => setParams({ step: entry.step })}
                >
                  <StepLabel step={entry.step} />
                </Button>
              </li>
            ))}
          </ol>
        </nav>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <StepContent
            step={step}
            project={project}
            tasksPending={projects.tasksPending}
            tasksError={projects.tasksError}
            onReloadTasks={() => void projects.refetchTasks()}
          />
        </div>
      </div>
    </Page>
  );
}

function StepLabel({ step }: { readonly step: ProjectStep }) {
  switch (step) {
    case 'select': return <Trans>选材</Trans>;
    case 'shotlist': return <Trans>剪辑单</Trans>;
    case 'record': return <Trans>录制</Trans>;
    case 'export': return <Trans>导出</Trans>;
  }
}

function StepContent({
  step,
  project,
  tasksPending,
  tasksError,
  onReloadTasks,
}: {
  readonly step: ProjectStep;
  readonly project: ProjectViewModel;
  readonly tasksPending: boolean;
  readonly tasksError: string | null;
  readonly onReloadTasks: () => void;
}) {
  if (step === 'select') return <ProjectSelectStep project={project} />;
  if (step === 'shotlist') return <ShotListMode project={project} />;
  if (step === 'record') {
    return (
      <ProjectRecordingStep
        project={project}
        tasksPending={tasksPending}
        tasksError={tasksError}
        onReload={onReloadTasks}
      />
    );
  }
  const descriptions: Record<ProjectStep, React.ReactNode> = {
    select: <Trans>比赛工作区与证据检索加入的片段会汇总到这里。</Trans>,
    shotlist: <Trans>当前剪辑模式：{project.editingMode}。快速剪辑与多轨编辑能力将在这里呈现。</Trans>,
    record: <Trans>这份作品的录制队列与片段进度会显示在这里。</Trans>,
    export: <Trans>导出设置与这份作品的成品文件会显示在这里。</Trans>,
  };
  return (
    <section data-project-step={step} className="m-7 flex min-h-48 flex-col justify-center gap-2 border border-divider p-5">
      <h2 className="text-xl"><StepLabel step={step} /></h2>
      <p className="text-sm text-neutral-700">{descriptions[step]}</p>
    </section>
  );
}

function ShotListMode({ project }: { readonly project: ProjectViewModel }) {
  const modes = [
    { id: 'agent', label: <Trans>Agent 模式</Trans> },
    { id: 'quick', label: <Trans>快速模式</Trans> },
    { id: 'multitrack', label: <Trans>精剪模式</Trans> },
  ] as const;
  /* Mode contract: Agent and quick projects keep their existing write-through
     behavior. Multitrack owns a local revisioned document and persists only
     through its Save action. There is no bidirectional conversion between the
     three document shapes, so another mode stays disabled instead of implying
     that a switch would carry edits across. */
  const reason = project.editingMode === 'multitrack'
    ? t`精剪修改不会跨模式同步；切换前请保存，当前版本没有转换契约`
    : t`当前版本没有跨模式双向转换契约；所有修改会保留在当前模式`;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-editing-mode={project.editingMode}>
      <div className="flex flex-none items-center gap-2 border-b border-divider px-4 py-2">
        <span className="text-xs text-neutral-600"><Trans>剪辑模式</Trans></span>
        {modes.map((mode) => (
          <Button
            key={mode.id}
            size="sm"
            variant={mode.id === project.editingMode ? 'primary' : 'secondary'}
            disabled={mode.id !== project.editingMode}
            {...(mode.id === project.editingMode ? {} : { disabledReason: reason })}
          >
            {mode.label}
          </Button>
        ))}
        <span className="ml-auto text-xs text-neutral-600">
          {project.editingMode === 'multitrack'
            ? <Trans>精剪修改保留在本地，切换步骤前请保存</Trans>
            : <Trans>修改会自动保留在当前模式</Trans>}
        </span>
      </div>
      {project.source.kind === 'plan' || project.id === 'new' ? (
        <AgentWorkspace
          embedded
          {...(project.id === 'new' ? {} : { planId: project.source.id })}
          recordingTarget={`/projects/${encodeURIComponent(project.id)}?step=record&prepare=1`}
        />
      ) : project.source.kind === 'montage' ? (
        <MontageWorkspace embedded projectId={project.source.id} />
      ) : <EditorWorkspaceLoader embedded projectId={project.source.id} />}
    </div>
  );
}

const NEW_PROJECT: ProjectViewModel = {
  id: 'new',
  source: { kind: 'plan', id: 'new' },
  name: '',
  editingMode: 'agent',
  shotList: null,
  clipCount: 0,
  recordingTasks: [],
  outputFiles: [],
  demoIds: [],
  currentStep: 'shotlist',
  status: 'active',
  updatedAt: '1970-01-01T00:00:00.000Z',
};
