/** Finished files and recorded media, optionally scoped to one Project. */

import { Trans } from '@lingui/react/macro';
import { useSearchParams } from 'react-router-dom';

import { useCleanupMissingOutputs, useOutputList } from '../../../data/outputs';
import { useStorageStatus } from '../../../data/config';
import { dataErrorMessage } from '../../../data/errors';
import { Alert } from '../../../design/feedback';
import { Page, Toolbar } from '../../../design/layout';
import { Button } from '../../../design/primitives';
import { OutputsView } from './OutputsView';
import { formatBytes } from '../../../domain/media/outputModel';

export function DeliveryPage() {
  const [params] = useSearchParams();
  const projectId = params.get('project');
  /*
   * 「34 个输出 · 218 GB 可用」. Both halves are real reads: the count is the
   * output list's own `total` (a one-row page, so the count arrives without
   * fetching a page of cards this bar does not draw), and the free space is
   * `StorageStatus.filesystem_available_bytes`.
   */
  const outputCount = useOutputList({ page: 1, page_size: 1, ...(projectId === null ? {} : { project_id: projectId }) });
  const storage = useStorageStatus();
  const cleanup = useCleanupMissingOutputs();

  const total = outputCount.data?.total;
  const available = formatBytes(storage.data?.filesystem_available_bytes ?? null);

  return (
    <Page
      scroll={false}
      toolbar={
        <Toolbar
          title={<Trans>成品文件</Trans>}
          meta={
            total === undefined ? undefined : available === null ? (
              <Trans>{total} 个成品文件</Trans>
            ) : (
              <Trans>{total} 个成品文件 · {available} 可用</Trans>
            )
          }
          inlineActionsWhenCollapsed={1}
          actions={[
            {
              id: 'cleanup',
              label: cleanup.isPending ? <Trans>正在清理…</Trans> : <Trans>清理无效记录</Trans>,
              onSelect: () => cleanup.mutate(undefined),
              disabled: cleanup.isPending,
              control: (
                <Button
                  size="md"
                  onClick={() => cleanup.mutate(undefined)}
                  aria-busy={cleanup.isPending}
                  {...(cleanup.isPending ? { disabled: true } : {})}
                >
                  {cleanup.isPending ? <Trans>正在清理…</Trans> : <Trans>清理无效记录</Trans>}
                </Button>
              ),
            },
          ]}
        />
      }
    >
      {cleanup.isError ? (
        <div className="px-6 pt-4">
          <Alert variant="danger" detail={dataErrorMessage(cleanup.error)} action={{ label: <Trans>重试</Trans>, onAction: () => cleanup.mutate(undefined) }}>
            <Trans>清理没有完成，请重试。</Trans>
          </Alert>
        </div>
      ) : cleanup.isSuccess ? (
        <div className="px-6 pt-4">
          <Alert variant="info" action={{ label: <Trans>知道了</Trans>, onAction: () => cleanup.reset() }}>
            <Trans>已检查 {cleanup.data.inspected} 条记录，移除 {cleanup.data.deleted} 条无效记录。磁盘文件没有变化。</Trans>
            {cleanup.data.scan_limited ? <p className="mt-1"><Trans>本次只扫描了部分目录，仍可能有未检查的记录。</Trans></p> : null}
          </Alert>
        </div>
      ) : null}
      <OutputsView key={projectId ?? 'all'} />
    </Page>
  );
}
