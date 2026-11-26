import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Ellipsis, FileX2, Film, FolderOpen, Play } from 'lucide-react';
import { useState } from 'react';

import { useNativeShell } from '../../../data/nativeShell';
import { Skeleton } from '../../../design/data';
import { Drawer } from '../../../design/feedback';
import { Blueprint, OverflowMenu } from '../../../design/layout';
import { Button, cn } from '../../../design/primitives';
import { formatTaskClock } from '../../../domain/task';
import type { OutputItem, Project } from '../../../shared/desktop/dto';
import { RouteLink } from '../../shared/navigation/RouteLink';
import { displayOutputPath, formatBytes, formatOutputMedia, outputDeletionRemovesFile, outputFileIsUsable, splitDisplayOutputPath } from '../../../domain/media/outputModel';

/** Keep the identity and actions visible; secondary facts remain in details. */
export const OUTPUT_ROW_COLUMNS = 'grid-cols-[calc(var(--w-output-preview)+2rem)_minmax(0,1fr)_7.5rem] @min-[760px]/outputs:grid-cols-[calc(var(--w-output-preview)+2rem)_minmax(0,1fr)_7.5rem_11.5rem] @min-[1050px]/outputs:grid-cols-[calc(var(--w-output-preview)+2rem)_minmax(0,1.35fr)_7.5rem_13.5rem_18.5rem]';

/** Reclaim the metadata column when no output on the current page has probed media facts. */
export const OUTPUT_ROW_COLUMNS_COMPACT = 'grid-cols-[calc(var(--w-output-preview)+2rem)_minmax(0,1fr)_7.5rem] @min-[760px]/outputs:grid-cols-[calc(var(--w-output-preview)+2rem)_minmax(0,1fr)_7.5rem_18.5rem]';

export interface OutputCardProps {
  readonly output: OutputItem;
  readonly project?: Pick<Project, 'name' | 'revision'> | undefined;
  readonly showMediaColumn?: boolean | undefined;
  readonly onReveal: (output: OutputItem) => void;
  readonly onDelete: (output: OutputItem) => void;
  readonly now?: Date | undefined;
  readonly timeZone?: string | undefined;
  readonly className?: string | undefined;
  readonly emphasized?: boolean | undefined;
}

export function OutputCard({ output, project, showMediaColumn = true, onReveal, onDelete, now, timeZone, className, emphasized = false }: OutputCardProps) {
  const shell = useNativeShell();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const usable = outputFileIsUsable(output.availability);
  const title = output.output_kind === 'export' ? project?.name ?? output.title : output.title;
  const size = formatBytes(output.size_bytes);
  const stamp = formatTaskClock(output.updated_at, {
    ...(now === undefined ? {} : { now }),
    ...(timeZone === undefined ? {} : { timeZone }),
  });
  const sourceTaskId = output.output_kind === 'export' ? `export:${output.id}` : null;
  const facts = formatOutputMedia(output.media);
  const streamUrl = usable ? shell.mediaSrc(`/api/outputs/${output.output_kind}/${output.id}/stream`) : null;
  const version = output.project_revision;
  const currentVersion = project !== undefined && version === project.revision;
  const shownPath = displayOutputPath(output.path);
  const pathParts = splitDisplayOutputPath(output.path);
  const removesFile = outputDeletionRemovesFile(output);
  const openDetails = () => { setPreviewOpen(false); setCopyNotice(null); setDetailsOpen(true); };
  const play = () => { setPreviewOpen(true); setCopyNotice(null); setDetailsOpen(true); };
  const removeLabel = removesFile ? t`删除文件` : t`移除记录`;

  return (
    <>
      <Blueprint as="article" data-output={output.id} data-output-kind={output.output_kind}
        data-output-availability={output.availability} data-output-emphasized={emphasized ? 'true' : undefined}
        className={cn(
          'grid min-h-24 border-b border-divider transition-colors last:border-b-0',
          showMediaColumn ? OUTPUT_ROW_COLUMNS : OUTPUT_ROW_COLUMNS_COMPACT,
          !usable
            ? 'bg-neutral-100/70'
            : emphasized
              ? 'bg-accent-100/60 hover:bg-accent-100'
              : 'bg-bg hover:bg-neutral-100',
          className,
        )}>
        <div className="flex items-center justify-center px-4 py-2.5">
          <button
            type="button"
            className={cn(
              'relative grid aspect-video w-[var(--w-output-preview)] flex-none place-items-center overflow-hidden rounded-md border transition-colors',
              usable
                ? 'border-divider bg-media text-on-media hover:border-accent-400'
                : 'border-dashed border-divider bg-surface-chrome text-neutral-500',
            )}
            aria-label={t`预览 ${title}`}
            disabled={!usable}
            onClick={play}
          >
            {usable ? (
              <>
                {streamUrl !== null && output.media?.width != null ? (
                  <video className="size-full object-contain" src={streamUrl} muted preload="metadata" aria-hidden="true" />
                ) : (
                  <Film className="size-5 opacity-60" aria-hidden="true" />
                )}
                <span className="absolute grid size-8 place-items-center rounded-full bg-media/85 text-on-media">
                  <Play className="size-4" aria-hidden="true" />
                </span>
              </>
            ) : (
              <span className="flex flex-col items-center justify-center gap-1 px-2 text-xs text-neutral-600">
                <FileX2 className="size-4 text-neutral-500" strokeWidth={1.6} aria-hidden="true" />
                <span><Trans>文件不在原位</Trans></span>
              </span>
            )}
          </button>
        </div>
        <div className="flex min-w-0 flex-col justify-center gap-1 border-l border-divider px-4 py-2.5">
          <h2 className={cn('min-w-0 text-base font-medium', !usable && 'text-neutral-700')}>
            <button type="button" className="block max-w-full break-words text-left hover:underline" onClick={openDetails}>{title}</button>
          </h2>
          {version === null ? null : <p className={cn('text-xs tabular-nums', currentVersion ? 'text-ok-text' : 'text-neutral-600')}>
            <Trans>第 {version} 版</Trans>{project === undefined ? null : <> · {currentVersion ? <Trans>当前作品版本</Trans> : <Trans>旧版本</Trans>}</>}
          </p>}
          <button type="button" className="min-w-0 max-w-full truncate text-left font-mono text-xs text-neutral-600 hover:text-text hover:underline" title={shownPath} aria-label={t`查看 ${title} 的完整路径`} onClick={openDetails}>
            <span data-output-file-name>{pathParts.fileName}</span>
          </button>
          {!showMediaColumn && !usable ? (
            <p className="text-xs text-neutral-600"><Trans>记录仍在，文件已被移动或删除</Trans></p>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col justify-center gap-1 border-l border-divider px-4 py-2.5 text-xs text-neutral-600">
          <span className="font-mono tabular-nums text-text">{size ?? '—'}</span>
          <span className="tabular-nums">{usable ? stamp : <Trans>文件缺失</Trans>}</span>
        </div>
        {showMediaColumn ? (
          <div className="hidden min-w-0 items-center border-l border-divider px-4 py-2.5 text-xs tabular-nums text-neutral-700 @min-[1050px]/outputs:flex">
            {usable ? facts.join(' · ') || '—' : <span className="text-neutral-600"><Trans>记录仍在，文件已被移动或删除</Trans></span>}
          </div>
        ) : null}
        <div data-output-actions className="col-span-3 flex flex-wrap items-center justify-end gap-1.5 border-t border-divider px-4 py-2.5 @min-[760px]/outputs:col-span-1 @min-[760px]/outputs:border-l @min-[760px]/outputs:border-t-0">
          {usable ? <>
            <Button variant="ghost" size="sm" onClick={play}><Play className="size-4" aria-hidden="true" /><Trans>播放</Trans></Button>
            <Button variant="ghost" size="sm" title={t`打开所在文件夹`} className="@min-[760px]/outputs:@max-[1050px]/outputs:px-2" onClick={() => onReveal(output)}><FolderOpen className="size-4" aria-hidden="true" /><span className="@min-[760px]/outputs:@max-[1050px]/outputs:sr-only"><Trans>打开所在文件夹</Trans></span></Button>
            <OverflowMenu
              label={t`${title} 的更多操作`}
              triggerLabel={<Ellipsis className="size-4" aria-hidden="true" />}
              iconOnly
              align="end"
              triggerClassName="rounded-md"
              items={[
                { id: 'details', label: t`查看详情`, onSelect: openDetails },
                { id: 'delete', label: <span className={cn(removesFile && 'text-fail-text')}>{removeLabel}</span>, onSelect: () => onDelete(output) },
              ]}
            />
          </> : <Button variant="secondary" size="sm" onClick={() => onDelete(output)}>{removeLabel}</Button>}
        </div>
      </Blueprint>
      <Drawer open={detailsOpen} title={title} description={version === null ? undefined : t`第 ${version} 版`} width="wide" onClose={() => setDetailsOpen(false)}>
        <div className="space-y-4">
          {previewOpen && streamUrl !== null ? <video className="aspect-video w-full bg-media object-contain" src={streamUrl} controls autoPlay aria-label={t`成品播放 ${title}`} /> : null}
          <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
            <dt className="text-neutral-600">{output.status === 'completed' ? <Trans>完成时间</Trans> : <Trans>更新时间</Trans>}</dt><dd>{stamp}</dd>
            <dt className="text-neutral-600"><Trans>文件名</Trans></dt><dd className="break-all font-mono text-xs">{output.file_name}</dd>
            <dt className="text-neutral-600"><Trans>文件大小</Trans></dt><dd>{size ?? '—'}</dd>
            <dt className="text-neutral-600"><Trans>文件参数</Trans></dt><dd>{facts.join(' · ') || t`参数不可读取`}</dd>
            <dt className="text-neutral-600"><Trans>文件类型</Trans></dt><dd>{output.managed ? <Trans>受管文件</Trans> : <Trans>外部文件</Trans>}</dd>
            <dt className="text-neutral-600"><Trans>完整路径</Trans></dt><dd className="break-all font-mono text-xs">{shownPath}</dd>
            {sourceTaskId === null ? null : <><dt className="text-neutral-600"><Trans>来源任务</Trans></dt><dd><RouteLink to={`/tasks/${encodeURIComponent(sourceTaskId)}`} size="sm"><Trans>查看任务</Trans></RouteLink></dd></>}
          </dl>
          {usable ? null : <p className="text-base text-neutral-700"><Trans>文件已不在原位，记录仍然保留。</Trans></p>}
          <div className="flex flex-wrap gap-2">
            {usable ? <Button size="sm" variant="secondary" onClick={() => onReveal(output)}><Trans>打开所在文件夹</Trans></Button> : null}
            <Button size="sm" variant="secondary" onClick={async () => {
              try {
                await navigator.clipboard.writeText(shownPath);
                setCopyNotice(t`已复制完整路径`);
              } catch {
                setCopyNotice(t`无法访问剪贴板，请选择上方完整路径手动复制。`);
              }
            }}><Trans>复制完整路径</Trans></Button>
          </div>
          {copyNotice === null ? null : <p role="status" className="text-base text-neutral-700">{copyNotice}</p>}
        </div>
      </Drawer>
    </>
  );
}

export function OutputCardSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="flex min-h-24 flex-wrap items-center gap-4 rounded-lg border border-divider bg-bg px-4 py-2.5 sm:flex-nowrap"
    >
      <Skeleton className="aspect-video h-auto w-[var(--w-output-preview)] flex-none rounded-md" />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-2">
        <Skeleton width="42%" className="h-4" />
        <Skeleton width="28%" className="h-3" />
        <Skeleton width="58%" className="h-3" />
      </div>
      <div className="hidden flex-none flex-col gap-1.5 sm:flex">
        <Skeleton width="4.5rem" className="h-3.5" />
        <Skeleton width="3.5rem" className="h-3" />
      </div>
      <div className="ml-auto flex flex-none items-center gap-1.5">
        <Skeleton width="4rem" className="h-[var(--h-ctl-sm)] rounded-md" />
        <Skeleton width="2rem" className="h-[var(--h-ctl-sm)] rounded-md" />
        <Skeleton width="2rem" className="h-[var(--h-ctl-sm)] rounded-md" />
      </div>
    </div>
  );
}
