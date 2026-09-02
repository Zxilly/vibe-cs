/*
 * pages/delivery — 交付 › 输出, the `?view=outputs` face of §7's `/delivery`.
 *
 * 「11 输出与任务记录」 lays it out as: a 46px filter strip (全部 · 录制结果 ·
 * 导出成片 · 文件缺失, sort on the right), a two-column grid of cards, and a
 * 52px footer strip. This is that column; the 520px 任务记录 rail beside it is
 * `TaskRecordRail`, placed by `DeliveryPage`.
 *
 * ── Density (§10.3) ───────────────────────────────────────────────────────
 *
 * The grid is one column until it has room for two, and the scroll lives on the
 * grid's own container — never on the body, which `design/layout/Page` and
 * `base.css` both forbid. The footer prints 共 N 条 through `Pagination`, so a
 * library of 34 outputs (the artboard's own count) is paged rather than
 * silently cut.
 *
 * ── The footer sentence is the service's, not ours ────────────────────────
 *
 * 「删除受管文件会先进入可回滚暂存，24 小时后清除。」 is drawn on the artboard and
 * matches `DeleteOutputResult.file_action`'s `managed_file_pending_cleanup`. It
 * is printed as standing policy; what actually happened to a particular file is
 * reported per deletion, from the result the mutation returns.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';

import { dataErrorMessage } from '../../data/errors';
import { useDeleteOutput, useOutputList, useRevealOutput } from '../../data/outputs';
import { Empty, Pagination } from '../../design/data';
import { Alert } from '../../design/feedback';
import { Toolbar } from '../../design/layout';
import { Seg } from '../../design/primitives';
import type { OutputItem, OutputQuery } from '../../shared/desktop/dto';
import { RouteLink } from '../RouteLink';
import { OutputCard, OutputCardSkeleton } from './OutputCard';
import { outputDeletionRemovesFile } from './outputModel';
import type { ServiceActionState } from '../../data/serviceAction';

/** Two rows of two on a 1100px window; the artboard draws four cards. */
export const OUTPUT_PAGE_SIZE = 12;

const OUTPUT_FILTERS = ['all', 'recording', 'export', 'missing'] as const;
type OutputFilter = (typeof OUTPUT_FILTERS)[number];

function filterLabels(): Readonly<Record<OutputFilter, string>> {
  return {
    all: t`全部`,
    recording: t`录制结果`,
    export: t`导出成片`,
    missing: t`文件缺失`,
  };
}

/** The artboard's four chips, as an `OutputQuery`. */
function filterQuery(filter: OutputFilter): OutputQuery {
  switch (filter) {
    case 'recording':
      return { kind: 'recording' };
    case 'export':
      return { kind: 'export' };
    case 'missing':
      return { availability: 'missing' };
    case 'all':
      return {};
  }
}

export interface OutputsViewProps {
  readonly service: ServiceActionState;
  readonly now?: Date | undefined;
}

export function OutputsView({ service, now }: OutputsViewProps) {
  const [filter, setFilter] = useState<OutputFilter>('all');
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);

  const outputs = useOutputList({ page, page_size: OUTPUT_PAGE_SIZE, ...filterQuery(filter) });
  const reveal = useRevealOutput();
  const remove = useDeleteOutput();

  const items = outputs.data?.items ?? [];
  const errorMessage = outputs.isError
    ? dataErrorMessage(outputs.error) ?? t`读取成片列表失败。`
    : undefined;

  const onReveal = (output: OutputItem): void => {
    reveal.mutate(output.path, {
      onSuccess: (revealed) => {
        setNotice(revealed ? null : t`只有桌面端能在文件管理器里定位文件。`);
      },
      onError: (error) => setNotice(dataErrorMessage(error) ?? t`无法定位这个文件。`),
    });
  };

  const onDelete = (output: OutputItem): void => {
    /*
     * `deleteFile` stays false: 「移除记录不会删除文件」 is what the artboard
     * promises beside an external file, and the destructive form belongs behind
     * the confirmation dialog phase 3b owns. A managed file therefore keeps its
     * bytes until 清理 runs, which is the safe direction to be wrong in.
     */
    remove.mutate(
      { kind: output.output_kind, id: output.id },
      {
        onSuccess: (result) => {
          setNotice(
            result.warning
            ?? (outputDeletionRemovesFile(output)
              ? t`记录已移除，文件仍在原处。`
              : t`记录已移除，外部文件未被删除。`),
          );
        },
        onError: (error) => setNotice(dataErrorMessage(error) ?? t`移除记录失败。`),
      },
    );
  };

  const labels = filterLabels();

  return (
    <>
      <Toolbar
        height="bar"
        tone="chrome"
        meta={outputs.data?.scan_limited === true ? <Trans>目录很大，只扫描了一部分</Trans> : undefined}
      >
        <Seg
          name="delivery-output-filter"
          aria-label={t`按类型筛选成品文件`}
          size="sm"
          value={filter}
          options={OUTPUT_FILTERS.map((value) => ({ value, label: labels[value] }))}
          onChange={(value) => {
            setFilter(value);
            setPage(1);
          }}
        />
      </Toolbar>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-7">
        {notice === null ? null : (
          <Alert
            variant="info"
            action={{ label: <Trans>知道了</Trans>, onAction: () => setNotice(null) }}
          >
            {notice}
          </Alert>
        )}

        {errorMessage === undefined ? null : (
          <Alert
            variant="danger"
            action={{ label: <Trans>重新加载</Trans>, onAction: () => void outputs.refetch() }}
          >
            {errorMessage}
          </Alert>
        )}

        {errorMessage !== undefined ? null : outputs.isPending ? (
          <div className="grid gap-3">
            {Array.from({ length: 4 }, (_unused, index) => (
              <OutputCardSkeleton key={index} />
            ))}
          </div>
        ) : items.length === 0 ? (
          <Empty
            preset="no-outputs"
            actions={
              <RouteLink to="/projects/new?step=shotlist">
                <Trans>新建作品</Trans>
              </RouteLink>
            }
          />
        ) : (
          <div className="min-w-[68rem] border-t border-divider">
            <div
              className="grid h-10 grid-cols-[var(--w-track-head)_minmax(15rem,1.35fr)_9rem_15rem_minmax(15rem,1fr)_6rem] border-x border-b border-divider bg-neutral-50 text-2xs font-medium tracking-wide text-neutral-700"
              aria-hidden="true"
            >
              <span className="flex items-center px-4"><Trans>预览</Trans></span>
              <span className="flex items-center border-l border-divider px-4"><Trans>文件名</Trans></span>
              <span className="flex items-center border-l border-divider px-4"><Trans>文件大小</Trans></span>
              <span className="flex items-center border-l border-divider px-4"><Trans>时长 · 分辨率 · 帧率 · 编码</Trans></span>
              <span className="flex items-center border-l border-divider px-4"><Trans>文件路径</Trans></span>
              <span className="flex items-center justify-center border-l border-divider px-2"><Trans>操作</Trans></span>
            </div>
            {items.map((output, index) => (
              <OutputCard
                key={`${output.output_kind}:${output.id}`}
                output={output}
                layout="row"
                emphasized={page === 1 && filter === 'all' && index === 0}
                onReveal={onReveal}
                onDelete={onDelete}
                service={service}
                {...(now === undefined ? {} : { now })}
              />
            ))}
          </div>
        )}
      </div>

      <Pagination
        page={page}
        pageSize={OUTPUT_PAGE_SIZE}
        total={outputs.data?.total ?? 0}
        onPageChange={setPage}
      />

      <p className="flex-none border-t border-divider px-6 py-3 text-xs text-neutral-700">
        <Trans>删除受管文件会先进入可回滚暂存，24 小时后清除。移除记录不会删除外部文件。</Trans>
      </p>
    </>
  );
}
