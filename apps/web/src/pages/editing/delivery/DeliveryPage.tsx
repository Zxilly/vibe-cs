/** Finished files and recorded media, optionally scoped to one Project. */

import { Trans } from '@lingui/react/macro';
import { useSearchParams } from 'react-router-dom';

import { useCleanupMissingOutputs, useOutputList } from '../../../data/outputs';
import { useStorageStatus } from '../../../data/config';
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
          title={<Trans>成品</Trans>}
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
              label: <Trans>清理无效记录</Trans>,
              onSelect: () => cleanup.mutate(undefined),
              disabled: cleanup.isPending,
              control: (
                <Button
                  size="md"
                  onClick={() => cleanup.mutate(undefined)}
                  {...(cleanup.isPending ? { disabled: true } : {})}
                >
                  <Trans>清理无效记录</Trans>
                </Button>
              ),
            },
          ]}
        />
      }
    >
      <OutputsView />
    </Page>
  );
}
