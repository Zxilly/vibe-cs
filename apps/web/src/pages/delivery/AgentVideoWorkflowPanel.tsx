import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

import { toDataError } from '../../data/errors';
import { useNativeShell } from '../../data/nativeShell';
import { useExportAgentComposition } from '../../data/plans';
import { useAgentVideoWorkflow } from '../../data/tasks';
import { Alert } from '../../design/feedback';
import { Button, Badge, cn } from '../../design/primitives';
import type { AgentVideoWorkflowStage } from '../../shared/desktop/dto';
import { RouteLink } from '../RouteLink';
import { TASK_POLL_DETAIL_MS } from './taskPolling';

const STAGES: readonly AgentVideoWorkflowStage[] = [
  'recording',
  'registering_takes',
  'exporting',
  'completed',
];

const STAGE_INDEX: Readonly<Record<AgentVideoWorkflowStage, number>> = {
  recording: 0,
  registering_takes: 1,
  ready_to_export: 2,
  exporting: 2,
  completed: 3,
  failed: -1,
};

export function AgentVideoWorkflowPanel({ recordingJobId }: { readonly recordingJobId: string }) {
  const shell = useNativeShell();
  const workflow = useAgentVideoWorkflow(recordingJobId, {
    pollWhileActiveMs: TASK_POLL_DETAIL_MS,
  });
  const exportComposition = useExportAgentComposition(workflow.data?.plan_id ?? '');
  const failure = toDataError(workflow.error, '读取 Agent 成片流程失败。');

  if (failure?.status === 404) return null;
  if (failure !== null) {
    return (
      <Alert
        variant="danger"
        action={{ label: <Trans>重试</Trans>, onAction: () => void workflow.refetch() }}
      >
        {failure.message}
      </Alert>
    );
  }
  if (workflow.data === undefined) {
    return <div className="h-16 animate-pulse border border-divider bg-neutral-100" />;
  }

  const data = workflow.data;
  const pointer = STAGE_INDEX[data.stage];
  const canExport = data.stage === 'ready_to_export'
    || (data.stage === 'failed' && data.composition.items.length === data.total_shots);
  const exportFailure = toDataError(exportComposition.error, '没有启动导出。');

  return (
    <section
      aria-label={t`Agent 成片流程`}
      aria-live="polite"
      className="mx-6 mt-6 border border-divider bg-surface"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-divider px-4 py-3">
        <h2 className="min-w-0 flex-1 font-heading text-sm"><Trans>Agent 成片流程</Trans></h2>
        <Badge variant={data.stage === 'completed' ? 'accent' : 'neutral'}>
          {workflowLabel(data.stage)}
        </Badge>
        <span className="font-mono text-xs text-neutral-600">
          <Trans>{data.recorded_takes} 条 Take · {data.total_shots} 个镜头</Trans>
        </span>
      </header>

      <ol className="grid grid-cols-4 border-b border-divider">
        {STAGES.map((stage, index) => (
          <li
            key={stage}
            aria-current={index === pointer ? 'step' : undefined}
            className={cn(
              'border-r border-divider px-3 py-2 text-center text-xs last:border-r-0',
              data.stage === 'failed' && index === Math.max(pointer, 0)
                ? 'text-fail-text'
                : index <= pointer
                  ? 'bg-accent-subtle text-accent-text'
                  : 'text-neutral-500',
            )}
          >
            {workflowLabel(stage)}
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-xs text-neutral-700">
        <p className="min-w-0 flex-1">{workflowDetail(data.stage, data.composition.error)}</p>
        {canExport ? (
          <Button
            size="sm"
            disabled={exportComposition.isPending}
            onClick={() => exportComposition.mutate()}
          >
            {exportComposition.isPending ? <Trans>正在启动导出</Trans> : <Trans>继续导出</Trans>}
          </Button>
        ) : null}
        {data.composition.output_path === null ? null : (
          <Button
            size="sm"
            variant="secondary"
            disabled={!shell.available}
            onClick={() => void shell.reveal(data.composition.output_path ?? '')}
          >
            <Trans>定位成品</Trans>
          </Button>
        )}
        {data.stage === 'completed' ? (
          <RouteLink to="/delivery?view=outputs" size="sm"><Trans>查看成品</Trans></RouteLink>
        ) : null}
      </div>

      {exportFailure === null ? null : (
        <div className="px-4 pb-3 text-xs text-fail-text">{exportFailure.message}</div>
      )}
    </section>
  );
}

function workflowLabel(stage: AgentVideoWorkflowStage) {
  switch (stage) {
    case 'recording': return <Trans>录制片段</Trans>;
    case 'registering_takes': return <Trans>登记 Take</Trans>;
    case 'ready_to_export': return <Trans>等待导出</Trans>;
    case 'exporting': return <Trans>组合与导出</Trans>;
    case 'completed': return <Trans>成品可用</Trans>;
    case 'failed': return <Trans>需要处理</Trans>;
  }
}

function workflowDetail(stage: AgentVideoWorkflowStage, error: string | null) {
  switch (stage) {
    case 'recording':
      return <Trans>正在逐个录制镜头；已完成片段会保留，失败后只重试未完成部分。</Trans>;
    case 'registering_takes':
      return <Trans>录制已结束，正在把结果绑定到镜头并建立 Composition。</Trans>;
    case 'ready_to_export':
      return <Trans>Take 与 Composition 已确认；当前环境没有自动启动导出，可从这里继续。</Trans>;
    case 'exporting':
      return <Trans>正在按已确认的 Composition 组合片段并生成最终视频。</Trans>;
    case 'completed':
      return <Trans>最终视频已经生成，可以查看或在文件管理器中定位。</Trans>;
    case 'failed':
      return error === null
        ? <Trans>流程没有跑完；使用任务里的恢复动作继续，不会重复已完成的录制。</Trans>
        : <Trans>流程没有跑完：{error}</Trans>;
  }
}
