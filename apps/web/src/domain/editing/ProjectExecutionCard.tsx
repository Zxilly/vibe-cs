import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { CheckCircle2, CircleAlert, CircleSlash, LoaderCircle } from 'lucide-react';

import { Button } from '../../design/primitives';
import type { ActivityItem } from '../../shared/desktop/viewModels';

export function executionStatusLabel(execution: ActivityItem): string {
  const recording = execution.kind === 'recording';
  switch (execution.status) {
    case 'completed': return recording ? t`录制完成` : t`导出完成`;
    case 'failed': return recording ? t`录制失败` : t`导出失败`;
    case 'cancelled': return recording ? t`录制已取消` : t`导出已取消`;
    case 'cancelling': return t`正在取消`;
    case 'queued': return t`等待执行`;
    default: return recording ? t`正在录制` : t`正在导出`;
  }
}

/** One presentation of the host task, shared by the toolbar and conversation. */
export function ProjectExecutionCard({ execution, pending, onCancel, onOpenOutputs, onRetry, retryDisabled = false }: {
  readonly execution: ActivityItem;
  readonly pending: boolean;
  readonly onCancel: (execution: ActivityItem) => void;
  readonly onOpenOutputs: () => void;
  readonly onRetry?: ((execution: ActivityItem) => void) | undefined;
  readonly retryDisabled?: boolean;
}) {
  const failed = execution.status === 'failed';
  const completed = execution.status === 'completed';
  const cancelled = execution.status === 'cancelled';
  return (
    <section className="min-w-0 space-y-3 rounded-sm border border-divider bg-bg p-4" aria-label={executionStatusLabel(execution)} data-project-execution={execution.id}>
      <div className="flex flex-wrap items-center gap-2 text-sm font-medium" role="status">
        {completed ? <CheckCircle2 className="size-4 flex-none text-ok" aria-hidden="true" />
          : failed ? <CircleAlert className="size-4 flex-none text-fail-text" aria-hidden="true" />
            : cancelled ? <CircleSlash className="size-4 flex-none text-neutral-600" aria-hidden="true" />
              : <LoaderCircle className="size-4 flex-none animate-spin text-accent-700" aria-hidden="true" />}
        <span>{executionStatusLabel(execution)}</span>
        {execution.progress_percent === null || cancelled || failed ? null : <span className="ml-auto font-mono text-xs text-neutral-600">{execution.progress_percent}%</span>}
      </div>
      {execution.subject === null ? null : execution.kind === 'export'
        ? <details className="text-sm text-neutral-600"><summary className="cursor-pointer"><Trans>文件信息</Trans></summary><p className="mt-2 break-all font-mono text-xs">{execution.subject}</p></details>
        : <p className="break-words text-base">{execution.subject}</p>}
      <p className="text-sm text-neutral-700">
        {completed ? execution.kind === 'recording'
          ? <Trans>录制结果已就绪。导出前会重新检查当前作品的素材状态。</Trans>
          : <Trans>文件已生成；仍需人工观看检查画面与音画同步。</Trans>
          : failed ? <Trans>任务未完成。作品与已有素材保留，请检查错误后重试。</Trans>
            : cancelled ? <Trans>任务已取消。作品、已有素材和旧成品仍保留。</Trans>
              : <Trans>任务正在本机执行。关闭此详情不会取消任务。</Trans>}
      </p>
      {execution.error === null ? null : <p className="break-words text-sm text-fail-text">{execution.error}</p>}
      <div className="flex flex-wrap gap-2">
        {execution.job_id === null || !execution.available_actions.includes('cancel') ? null : <Button size="sm" variant="secondary" disabled={pending} aria-label={execution.kind === 'recording' ? t`取消录制任务` : t`取消导出任务`} onClick={() => onCancel(execution)}><Trans>取消</Trans></Button>}
        {!execution.available_actions.includes('open_outputs') ? null : <Button size="sm" variant="secondary" onClick={onOpenOutputs}><Trans>查看成品</Trans></Button>}
        {onRetry === undefined || (!failed && !cancelled) ? null : <Button size="sm" variant="secondary" disabled={retryDisabled || pending} onClick={() => onRetry(execution)}>{execution.kind === 'recording' ? <Trans>重新录制</Trans> : <Trans>返回导出设置</Trans>}</Button>}
      </div>
    </section>
  );
}
