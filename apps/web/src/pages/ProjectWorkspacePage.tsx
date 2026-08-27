import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { ChevronRight, CircleCheck } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { useConvertMontageToEditor, useMontageProject } from '../data/montage';
import { useAgentComposition } from '../data/plans';
import { useNativeShell } from '../data/nativeShell';
import { useProjects } from '../data/projects';
import { Empty, Skeleton } from '../design/data';
import { Alert, Dialog, StatusDot } from '../design/feedback';
import { Page, Toolbar } from '../design/layout';
import { Button, Seg, cn } from '../design/primitives';
import {
  projectModeTransition,
  type ProjectModeTransition,
} from '../domain/project/projectModeTransition';
import type {
  ProjectEditingMode,
  ProjectStep,
  ProjectViewModel,
} from '../domain/project/projectViewModel';
import {
  PROJECT_STEPS,
  projectStepAvailability,
  resolveProjectStep,
  type ProjectStepAvailability,
} from '../domain/project/projectWorkflow';
import { AgentWorkspace } from './AgentPage';
import { MontageWorkspace } from './MontagePage';
import { EditorWorkspaceLoader } from './EditorPage';
import { ProjectRecordingStep } from './project/ProjectRecordingStep';
import { ProjectSelectStep } from './project/ProjectSelectStep';
import { RouteLink } from './RouteLink';
import { TASK_POLL_DETAIL_MS } from './delivery/taskPolling';

export function ProjectWorkspacePage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const [params, setParams] = useSearchParams();
  const projects = useProjects({ taskPollWhileActiveMs: TASK_POLL_DETAIL_MS });
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
    <Page
      toolbar={
        <ProjectWorkspaceToolbar
          project={project}
          step={step}
          availability={availability}
          onStep={(next) => setParams({ step: next })}
        />
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
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

function ProjectWorkspaceToolbar({
  project,
  step,
  availability,
  onStep,
}: {
  readonly project: ProjectViewModel;
  readonly step: ProjectStep;
  readonly availability: readonly ProjectStepAvailability[];
  readonly onStep: (step: ProjectStep) => void;
}) {
  const currentIndex = PROJECT_STEPS.indexOf(step);
  return (
    <Toolbar
      title={project.id === 'new' ? <Trans>新作品</Trans> : project.name}
      height="topbar"
      className="gap-3"
    >
      <nav aria-label={t`作品步骤`} className="min-w-0 overflow-x-auto">
        <ol className="m-0 flex min-w-max list-none items-center p-0">
          {availability.map((entry, index) => (
            <li key={entry.step} className="flex items-center">
              {index === 0 ? null : (
                <ChevronRight className="mx-1 size-3.5 text-neutral-400" strokeWidth={1.5} aria-hidden="true" />
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={!entry.enabled}
                aria-current={entry.step === step ? 'step' : undefined}
                className={cn(
                  'gap-2 px-2',
                  entry.step === step ? 'font-semibold text-text' : 'text-neutral-600',
                )}
                {...(entry.disabledReason === null ? {} : { disabledReason: entry.disabledReason })}
                onClick={() => onStep(entry.step)}
              >
                <StatusDot
                  size="sm"
                  status={index < currentIndex ? 'ok' : entry.step === step ? 'running' : 'idle'}
                />
                <StepLabel step={entry.step} />
              </Button>
            </li>
          ))}
        </ol>
      </nav>
    </Toolbar>
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
  if (step === 'export') return <ProjectExportStep project={project} />;
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

function ProjectExportStep({ project }: { readonly project: ProjectViewModel }) {
  const shell = useNativeShell();
  const output = project.outputFiles.find((item) => item.status === 'completed') ?? null;

  if (output === null) {
    return (
      <section data-project-step="export" className="m-7 flex min-h-48 flex-col justify-center gap-2 border border-divider p-5">
        <h2 className="text-xl"><Trans>导出</Trans></h2>
        <p className="text-sm text-neutral-700"><Trans>导出设置与这份作品的成品文件会显示在这里。</Trans></p>
      </section>
    );
  }
  const outputPath = output.path;
  return (
    <section
      data-project-step="export"
      aria-live="polite"
      className="flex min-h-0 flex-1 items-center justify-center px-7 py-12 text-center"
    >
      <div className="flex w-full max-w-[var(--w-overlay)] flex-col items-center gap-5">
        <CircleCheck className="size-20 text-ok" strokeWidth={1.5} aria-hidden="true" />
        <div>
          <h2 className="font-heading text-4xl"><Trans>成品可用</Trans></h2>
          <p className="mt-2 text-md text-neutral-700">
          <Trans>最终视频已经生成，可以从成品文件页播放、定位或管理。</Trans>
          </p>
        </div>
        <p className="w-full break-all border-y border-divider px-3 py-4 text-left font-mono text-xs text-neutral-600">
          {outputPath}
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Button asChild variant="secondary" size="lg">
            <RouteLink to="/delivery?view=outputs"><Trans>查看成品</Trans></RouteLink>
          </Button>
        <Button
          variant="primary"
          size="lg"
          disabled={!shell.available}
          onClick={() => void shell.reveal(outputPath)}
        >
          <Trans>定位文件</Trans>
        </Button>
        </div>
      </div>
    </section>
  );
}

function ShotListMode({ project }: { readonly project: ProjectViewModel }) {
  const navigate = useNavigate();
  const composition = useAgentComposition(
    project.source.kind === 'plan' && project.id !== 'new' ? project.source.id : null,
  );
  const montageCopy = useMontageProject(
    project.source.kind === 'plan' ? (composition.data?.id ?? null) : null,
    { enabled: composition.data !== null && composition.data !== undefined },
  );
  const convertToEditor = useConvertMontageToEditor();
  const [transition, setTransition] = useState<ProjectModeTransition | null>(null);
  const modes = [
    { id: 'agent', label: <Trans>Agent 辅助</Trans> },
    { id: 'quick', label: <Trans>快速剪辑</Trans> },
    { id: 'multitrack', label: <Trans>多轨精剪</Trans> },
  ] as const;
  const quickCopyId = montageCopy.data?.id ?? null;

  const chooseMode = (target: ProjectEditingMode) => {
    if (target === project.editingMode) return;
    setTransition(projectModeTransition(project.editingMode, target, quickCopyId));
  };

  const confirmTransition = () => {
    if (transition?.action === 'open_copy' && transition.copyProjectId !== null) {
      void navigate(`/projects/${encodeURIComponent(`montage:${transition.copyProjectId}`)}?step=shotlist`);
    } else if (transition?.action === 'create_copy' && project.source.kind === 'montage') {
      convertToEditor.mutate(project.source.id, {
        onSuccess: (editor) => {
          void navigate(`/projects/${encodeURIComponent(`editor:${editor.id}`)}?step=shotlist`);
        },
      });
    }
    setTransition(null);
  };

  const modeSwitcher = (
    <Seg
      name="project-editing-mode"
      size="sm"
      value={project.editingMode}
      aria-label={t`制作方式`}
      options={modes.map((mode) => ({ value: mode.id, label: mode.label }))}
      onChange={chooseMode}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-editing-mode={project.editingMode}>
      {project.editingMode === 'agent' ? null : (
        <Toolbar
          height="panel"
          title={<Trans>制作方式</Trans>}
          meta={
            project.editingMode === 'multitrack'
              ? <Trans>多轨修改保留在本地，切换步骤前请保存</Trans>
              : <Trans>转换会创建副本，源作品与后续修改不会互相同步</Trans>
          }
        >
          {modeSwitcher}
        </Toolbar>
      )}
      {convertToEditor.error === null ? null : (
        <Alert
          variant="danger"
          action={{ label: <Trans>关闭</Trans>, onAction: () => convertToEditor.reset() }}
        >
          <Trans>没有创建多轨副本。请确认素材文件仍然可用后重试。</Trans>
        </Alert>
      )}
      {project.source.kind === 'plan' || project.id === 'new' ? (
        <AgentWorkspace
          embedded
          toolbarContent={modeSwitcher}
          {...(project.id === 'new' ? {} : { planId: project.source.id })}
          projectId={project.id}
          demoId={project.demoIds[0] ?? null}
          demoIds={project.demoIds}
          recordingTarget={`/projects/${encodeURIComponent(project.id)}?step=record&prepare=1`}
        />
      ) : project.source.kind === 'montage' ? (
        <MontageWorkspace embedded projectId={project.source.id} />
      ) : <EditorWorkspaceLoader embedded projectId={project.source.id} />}
      <Dialog
        open={transition !== null}
        title={transition === null ? '' : transitionTitle(transition)}
        confirmLabel={
          transition?.action === 'none'
            ? <Trans>知道了</Trans>
            : transition?.action === 'open_copy'
              ? <Trans>打开副本</Trans>
              : <Trans>创建并打开副本</Trans>
        }
        confirmDisabled={convertToEditor.isPending}
        onClose={() => setTransition(null)}
        onConfirm={confirmTransition}
      >
        {transition === null ? null : transitionExplanation(transition)}
      </Dialog>
    </div>
  );
}

function transitionTitle(transition: ProjectModeTransition): ReactNode {
  if (transition.action === 'none') return <Trans>请选择当前制作方式支持的目标</Trans>;
  return transition.to === 'quick'
    ? <Trans>打开快速剪辑副本？</Trans>
    : <Trans>复制为多轨精剪？</Trans>;
}

function transitionExplanation(transition: ProjectModeTransition): ReactNode {
  switch (transition.reason) {
    case 'current':
      return null;
    case 'agent_copy_ready':
      return <Trans>将打开由已确认 Composition 生成的快速剪辑工程。Agent 剪辑单保持不变，两边后续修改不会同步。</Trans>;
    case 'agent_needs_composition':
      return <Trans>先完成录制并建立 Composition，系统才有真实片段可复制到快速剪辑。现在不会创建空工程。</Trans>;
    case 'agent_to_multitrack_via_quick':
      return <Trans>Agent 镜头的转换路径：真实 Take → 快速剪辑副本 → 多轨精剪。</Trans>;
    case 'quick_to_multitrack_copy':
      return <Trans>会新建一个多轨工程，复制当前片段顺序和裁切。包装、背景音乐与转场不会复制，源快速剪辑不会被修改，也不会反向同步。</Trans>;
    case 'quick_cannot_rebuild_agent_evidence':
      return <Trans>快速剪辑仅保留成片素材与秒级裁切；Agent 剪辑单需从 Demo、选手与证据重新建立。</Trans>;
    case 'multitrack_has_no_lossless_reverse':
      return <Trans>多轨工程可能包含图层、关键帧、效果与独立音频，降级会丢失信息。请保留当前工程并从原来源另建副本。</Trans>;
  }
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
