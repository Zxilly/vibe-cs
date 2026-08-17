/*
 * pages/home — 「最近输出」, the 440px rail of 「01 工作台首页」.
 *
 * The artboard's rail is `--w-inspector-wide` (440) and holds two outputs with
 * a 132×74 thumbnail each — the same card the delivery page draws, at the size
 * `--w-track-head` already names. So this is `pages/delivery/OutputCard` with a
 * shorter list, imported across rather than copied: the two surfaces show the
 * same object and 定位文件 must mean the same thing in both.
 *
 * The rail's other two blocks (进行中的工程, and the environment line at the
 * bottom) belong to the editor and the shell respectively; they are left for
 * their own phases rather than approximated here.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';

import { dataErrorMessage } from '../../data/errors';
import { useDeleteOutput, useOutputList, useRevealOutput } from '../../data/outputs';
import { Empty } from '../../design/data';
import { Alert } from '../../design/feedback';
import { Toolbar } from '../../design/layout';
import type { OutputItem } from '../../shared/desktop/dto';
import { OutputCard, OutputCardSkeleton } from '../delivery/OutputCard';
import type { ServiceActionState } from '../../data/serviceAction';
import { RouteLink } from '../RouteLink';

/** What the artboard draws. */
const RECENT_OUTPUT_COUNT = 2;

export interface RecentOutputsPanelProps {
  readonly service: ServiceActionState;
  readonly now?: Date | undefined;
}

export function RecentOutputsPanel({ service, now }: RecentOutputsPanelProps) {
  const outputs = useOutputList({ page: 1, page_size: RECENT_OUTPUT_COUNT });
  const reveal = useRevealOutput();
  const remove = useDeleteOutput();
  const [notice, setNotice] = useState<string | null>(null);

  const items = outputs.data?.items ?? [];

  const onReveal = (output: OutputItem): void => {
    reveal.mutate(output.path, {
      onSuccess: (revealed) => setNotice(revealed ? null : t`只有桌面端能在文件管理器里定位文件。`),
      onError: (error) => setNotice(dataErrorMessage(error) ?? t`无法定位这个文件。`),
    });
  };

  const onDelete = (output: OutputItem): void => {
    remove.mutate(
      { kind: output.output_kind, id: output.id },
      { onError: (error) => setNotice(dataErrorMessage(error) ?? t`移除记录失败。`) },
    );
  };

  return (
    <>
      <Toolbar
        height="panel"
        title={<Trans>最近输出</Trans>}
        primary={
          <RouteLink to="/delivery" size="sm">
            <Trans>全部输出</Trans>
          </RouteLink>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {notice === null ? null : (
          <Alert variant="info" action={{ label: <Trans>知道了</Trans>, onAction: () => setNotice(null) }}>
            {notice}
          </Alert>
        )}

        {outputs.isError ? (
          <Alert
            variant="danger"
            action={{ label: <Trans>重新加载</Trans>, onAction: () => void outputs.refetch() }}
          >
            {dataErrorMessage(outputs.error) ?? t`读取输出列表失败。`}
          </Alert>
        ) : outputs.isPending ? (
          <OutputCardSkeleton />
        ) : items.length === 0 ? (
          <Empty
            preset="no-outputs"
            actions={
              <RouteLink to="/agent">
                <Trans>用 Agent 制作视频</Trans>
              </RouteLink>
            }
          />
        ) : (
          items.map((output) => (
            <OutputCard
              key={`${output.output_kind}:${output.id}`}
              output={output}
              onReveal={onReveal}
              onDelete={onDelete}
              service={service}
              {...(now === undefined ? {} : { now })}
            />
          ))
        )}
      </div>
    </>
  );
}
