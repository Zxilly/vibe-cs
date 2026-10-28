/** Filter and page recorded media and exports, with optional Project scope. */

import { t } from '@lingui/core/macro';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Trans } from '@lingui/react/macro';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { dataErrorMessage } from '../../../data/errors';
import { useDeleteOutput, useOutputList, useRevealOutput } from '../../../data/outputs';
import { useProjects } from '../../../data/projects';
import { clampPage, Empty, Pagination } from '../../../design/data';
import { Alert } from '../../../design/feedback';
import { Toolbar } from '../../../design/layout';
import { Badge, Button, Seg } from '../../../design/primitives';
import type { DeleteOutputResult, OutputItem, OutputQuery } from '../../../shared/desktop/dto';
import { RouteLink } from '../../shared/navigation/RouteLink';
import { DeleteOutputDialog } from './DeleteOutputDialog';
import { OUTPUT_ROW_COLUMNS, OutputCard, OutputCardSkeleton } from './OutputCard';
import { cn } from '../../../design/cn';
import { outputDeletionOutcome, outputDeletionRemovesFile } from '../../../domain/media/outputModel';

/** Bound the number of previews loaded on one page. */
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

/** Translate the visible filter into the output-list query. */
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

function deletionNotice(result: DeleteOutputResult): string {
  switch (outputDeletionOutcome(result)) {
    case 'file-deleted':
      return t`文件已删除。`;
    case 'file-staged':
      return t`记录已移除，文件还留在暂存目录里。到恢复中心清理暂存成片可以释放空间。`;
    case 'record-only':
      return t`记录已移除，磁盘上的文件没有变化。`;
  }
}

export interface OutputsViewProps {
  readonly now?: Date | undefined;
}

export function OutputsView({ now }: OutputsViewProps) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const projectId = params.get('project');
  const projects = useProjects();
  const [filter, setFilter] = useState<OutputFilter>('all');
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<OutputItem | null>(null);

  const outputs = useOutputList({ page, page_size: OUTPUT_PAGE_SIZE, ...filterQuery(filter), ...(projectId === null ? {} : { project_id: projectId }) });
  const reveal = useRevealOutput();
  const remove = useDeleteOutput();

  // A deletion or cleanup can remove the final page. Keep the query on the
  // same valid page the shared pager displays, using a successful list read.
  useEffect(() => {
    if (!outputs.isSuccess) return;
    const nextPage = clampPage(page, outputs.data.total, OUTPUT_PAGE_SIZE);
    if (nextPage !== page) setPage(nextPage);
  }, [outputs.isSuccess, outputs.data?.total, page]);

  const items = outputs.data?.items ?? [];
  const scopedProject = projectId === null ? null : projects.data?.find((project) => project.id === projectId) ?? null;
  const scopeLabel = projectId === null ? null : scopedProject?.name
    ?? (projects.isPending ? t`正在加载作品…` : projects.isError ? t`指定作品` : t`已删除的作品`);

  const onReveal = (output: OutputItem): void => {
    reveal.mutate(output.path, {
      onSuccess: (revealed) => {
        setNotice(revealed ? null : t`只有桌面端能在文件管理器里定位文件。`);
      },
      onError: (error) => setNotice(dataErrorMessage(error) ?? t`无法定位这个文件。`),
    });
  };

  const confirmDelete = (output: OutputItem): Promise<unknown> =>
    remove.mutateAsync(
      { kind: output.output_kind, id: output.id, deleteFile: outputDeletionRemovesFile(output) },
      { onSuccess: (result) => setNotice(deletionNotice(result)) },
    );

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
        {scopeLabel === null ? null : (
          <Badge variant="accent" asChild>
            <button
              type="button"
              data-output-scope={projectId}
              className="max-w-full gap-1.5 hover:bg-accent-200"
              aria-label={t`清除作品筛选：${scopeLabel}`}
              onClick={() => void navigate('/delivery')}
            >
              <span className="truncate"><Trans>作品：{scopeLabel}</Trans></span>
              <X className="size-3 flex-none" strokeWidth={2} aria-hidden="true" />
            </button>
          </Badge>
        )}
      </Toolbar>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-6">
        {notice === null ? null : (
          <Alert
            variant="info"
            action={{ label: <Trans>知道了</Trans>, onAction: () => setNotice(null) }}
          >
            {notice}
          </Alert>
        )}

        {!outputs.isError ? null : (
          <Alert
            variant="danger"
            action={{ label: <Trans>重新加载</Trans>, disabled: outputs.isFetching, onAction: () => void outputs.refetch() }}
          >
            <Trans>无法加载成品文件。</Trans>
          </Alert>
        )}

        {outputs.isError ? null : outputs.isPending ? (
          <div role="status" aria-busy="true" className="grid gap-3">
            <p className="text-sm text-neutral-600"><Trans>正在加载成品文件…</Trans></p>
            {Array.from({ length: 4 }, (_unused, index) => (
              <OutputCardSkeleton key={index} />
            ))}
          </div>
        ) : items.length === 0 ? (
          filter !== 'all' ? (
            <Empty
              headingLevel={2}
              title={filter === 'missing' ? <Trans>没有缺失的文件</Trans> : <Trans>没有符合筛选条件的成品文件</Trans>}
              actions={<Button onClick={() => { setFilter('all'); setPage(1); }}><Trans>显示全部类型</Trans></Button>}
            />
          ) : scopeLabel === null ? (
            <Empty
              headingLevel={2}
              preset="no-outputs"
              actions={
                <RouteLink to="/projects/new">
                  <Trans>新建作品</Trans>
                </RouteLink>
              }
            />
          ) : (
            <Empty
              headingLevel={2}
              title={<Trans>「{scopeLabel}」还没有成品文件</Trans>}
              description={<Trans>录制或导出完成后，文件会出现在这里。</Trans>}
              actions={
                <RouteLink to="/delivery">
                  <Trans>查看全部成品文件</Trans>
                </RouteLink>
              }
            />
          )
        ) : (
          <div className="@container/outputs border-t border-divider">
            <div
              className={cn('grid h-10 border-x border-b border-divider bg-neutral-50 text-xs font-medium text-neutral-700', OUTPUT_ROW_COLUMNS)}
              aria-hidden="true"
            >
              <span className="flex items-center px-4"><Trans>预览</Trans></span>
              <span className="flex items-center border-l border-divider px-4"><Trans>成品</Trans></span>
              <span className="flex items-center border-l border-divider px-4"><Trans>文件大小</Trans></span>
              <span className="hidden items-center border-l border-divider px-4 @min-[1050px]/outputs:flex"><Trans>时长 · 分辨率 · 帧率 · 编码</Trans></span>
              <span className="hidden items-center justify-end border-l border-divider px-4 @min-[760px]/outputs:flex"><Trans>操作</Trans></span>
            </div>
            {items.map((output, index) => (
              <OutputCard
                key={`${output.output_kind}:${output.id}`}
                output={output}
                project={projects.data?.find((project) => project.id === output.project_id)}
                emphasized={page === 1 && filter === 'all' && index === 0}
                onReveal={onReveal}
                onDelete={setPendingDelete}
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

      <DeleteOutputDialog
        output={pendingDelete}
        onClose={() => {
          setPendingDelete(null);
          remove.reset();
        }}
        onDelete={confirmDelete}
        deleting={remove.isPending}
        error={remove.isError ? dataErrorMessage(remove.error) ?? t`没有删除，记录和文件都还在。` : null}
      />
    </>
  );
}
