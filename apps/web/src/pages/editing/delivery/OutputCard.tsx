import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Ellipsis, Film, FolderOpen, Play } from 'lucide-react';
import { useState } from 'react';

import { useNativeShell } from '../../../data/nativeShell';
import { Drawer } from '../../../design/feedback';
import { Blueprint, OverflowMenu } from '../../../design/layout';
import { Button, cn } from '../../../design/primitives';
import { formatTaskClock } from '../../../domain/task';
import type { OutputItem, Project } from '../../../shared/desktop/dto';
import { RouteLink } from '../../shared/navigation/RouteLink';
import { displayOutputPath, formatBytes, formatOutputMedia, outputDeletionRemovesFile, outputFileIsUsable, splitDisplayOutputPath } from '../../../domain/media/outputModel';

/** Keep the identity and actions visible; secondary facts remain in details. */
export const OUTPUT_ROW_COLUMNS = 'grid-cols-[calc(var(--w-output-preview)+2rem)_minmax(12rem,1fr)_7rem_17rem] min-[1200px]:grid-cols-[calc(var(--w-output-preview)+2rem)_minmax(12rem,1.35fr)_7rem_14rem_17rem]';

export interface OutputCardProps {
  readonly output: OutputItem;
  readonly project?: Pick<Project, 'name' | 'revision'> | undefined;
  readonly onReveal: (output: OutputItem) => void;
  readonly onDelete: (output: OutputItem) => void;
  readonly now?: Date | undefined;
  readonly timeZone?: string | undefined;
  readonly className?: string | undefined;
  readonly emphasized?: boolean | undefined;
}

export function OutputCard({ output, project, onReveal, onDelete, now, timeZone, className, emphasized = false }: OutputCardProps) {
  const shell = useNativeShell();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const usable = outputFileIsUsable(output.availability);
  const title = output.output_kind === 'export' ? project?.name ?? output.title : output.title;
  const size = formatBytes(output.size_bytes);
  const stamp = formatTaskClock(output.status === 'completed' ? output.updated_at : output.created_at, {
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
  const [directoryHead, directoryTail] = splitDirectoryTail(pathParts.directory);
  const removesFile = outputDeletionRemovesFile(output);
  const openDetails = () => { setPreviewOpen(false); setCopyNotice(null); setDetailsOpen(true); };
  const play = () => { setPreviewOpen(true); setCopyNotice(null); setDetailsOpen(true); };
  const removeLabel = removesFile ? t`删除文件` : t`移除记录`;

  return (
    <>
      <Blueprint as="article" data-output={output.id} data-output-kind={output.output_kind}
        data-output-availability={output.availability} data-output-emphasized={emphasized ? 'true' : undefined}
        className={cn('grid min-h-30 border-x border-b', OUTPUT_ROW_COLUMNS,
          usable ? 'border-divider' : 'border-fail-border', emphasized && usable ? 'bg-accent-100' : 'bg-bg', className)}>
        <div className="flex items-center justify-center px-4 py-2">
          <button type="button" className="relative grid aspect-video w-[var(--w-output-preview)] flex-none place-items-center overflow-hidden rounded-sm border border-divider bg-media text-on-media"
            aria-label={t`预览 ${title}`} disabled={!usable}
            onClick={play}>
            {streamUrl !== null && output.media?.width != null ? <video className="size-full object-contain" src={streamUrl} muted preload="metadata" aria-hidden="true" />
              : <Film className="size-5" aria-hidden="true" />}
            {usable ? <span className="absolute grid size-8 place-items-center rounded-sm bg-media/90"><Play className="size-4" aria-hidden="true" /></span>
              : <span className="absolute inset-0 grid place-items-center bg-media text-xs"><Trans>文件不在原位</Trans></span>}
          </button>
        </div>
        <div className="flex min-w-0 flex-col justify-center gap-1.5 border-l border-divider px-4 py-2">
          <h2 className="min-w-0 text-base font-medium"><button type="button" className="block max-w-full break-words text-left hover:underline" onClick={openDetails}>{title}</button></h2>
          {version === null ? null : <p className={cn('text-xs', currentVersion ? 'text-ok' : 'text-neutral-600')}>
            <Trans>第 {version} 版</Trans>{project === undefined ? null : <> · {currentVersion ? <Trans>当前作品版本</Trans> : <Trans>旧版本</Trans>}</>}
          </p>}
          {/* The file name is what tells rows apart on disk; the directory gives way in its middle, keeping the drive and the folder that holds the file. */}
          <button type="button" className="flex min-w-0 flex-col items-start gap-0.5 text-left" title={shownPath} aria-label={t`查看 ${title} 的完整路径`} onClick={openDetails}>
            <span data-output-file-name className="max-w-full truncate text-sm text-text">{pathParts.fileName}</span>
            {pathParts.directory === '' ? null : <span data-output-directory className="flex w-full min-w-0 font-mono text-xs text-neutral-600">
              <span className="min-w-[4ch] truncate">{directoryHead}</span><span className="flex-none">{directoryTail}</span>
            </span>}
          </button>
          {sourceTaskId === null ? null : <RouteLink to={`/tasks/${encodeURIComponent(sourceTaskId)}`} size="sm" className="self-start"><Trans>来源任务</Trans></RouteLink>}
        </div>
        <div className="flex min-w-0 flex-col justify-center gap-1 border-l border-divider px-4 py-2 text-xs text-neutral-600">
          <span>{size ?? '—'}</span><span>{usable ? stamp : <Trans>文件缺失</Trans>}</span>
          <span>{output.managed ? <Trans>受管文件</Trans> : <Trans>外部文件</Trans>}</span>
        </div>
        <div className="hidden min-w-0 items-center border-l border-divider px-4 py-2 text-xs text-neutral-700 min-[1200px]:flex">
          {usable ? facts.join(' · ') || '—' : <Trans>记录仍在，文件已被移动或删除</Trans>}
        </div>
        <div data-output-actions className="flex items-center justify-end gap-1 border-l border-divider px-2 py-2">
          {usable ? <>
            <Button variant="ghost" size="sm" onClick={play}><Play className="size-4" aria-hidden="true" /><Trans>播放</Trans></Button>
            <Button variant="ghost" size="sm" onClick={() => onReveal(output)}><FolderOpen className="size-4" aria-hidden="true" /><Trans>打开所在文件夹</Trans></Button>
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
          </> : <Button variant="ghost" size="sm" onClick={() => onDelete(output)}>{removeLabel}</Button>}
        </div>
      </Blueprint>
      <Drawer open={detailsOpen} title={title} description={version === null ? undefined : t`第 ${version} 版`} width="wide" onClose={() => setDetailsOpen(false)}>
        <div className="space-y-4">
          {previewOpen && streamUrl !== null ? <video className="aspect-video w-full bg-media object-contain" src={streamUrl} controls autoPlay aria-label={t`成品播放 ${title}`} /> : null}
          <dl className="space-y-2 text-sm">
            <dt className="text-neutral-600">{output.status === 'completed' ? <Trans>完成时间</Trans> : <Trans>更新时间</Trans>}</dt><dd>{stamp}</dd>
            <dt className="text-neutral-600"><Trans>文件名</Trans></dt><dd className="break-all font-mono text-xs">{output.file_name}</dd>
            <dt className="text-neutral-600"><Trans>文件大小</Trans></dt><dd>{size ?? '—'}</dd>
            <dt className="text-neutral-600"><Trans>文件参数</Trans></dt><dd>{facts.join(' · ') || t`参数不可读取`}</dd>
            <dt className="text-neutral-600"><Trans>完整路径</Trans></dt><dd className="break-all font-mono text-xs">{shownPath}</dd>
          </dl>
          {usable ? null : <p className="text-sm text-neutral-700"><Trans>文件已不在原位，记录仍然保留。</Trans></p>}
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
          {copyNotice === null ? null : <p role="status" className="text-sm text-neutral-700">{copyNotice}</p>}
        </div>
      </Drawer>
    </>
  );
}

/** The directory's last folder stays whole; everything before it is what gets elided. */
function splitDirectoryTail(directory: string): readonly [string, string] {
  const trimmed = directory.slice(0, -1);
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return cut === -1 ? ['', directory] : [directory.slice(0, cut + 1), directory.slice(cut + 1)];
}

export function OutputCardSkeleton() {
  return <div role="status" aria-busy="true" className="flex min-h-30 gap-4 border border-divider p-4">
    <span aria-hidden="true" className="aspect-video w-[var(--w-output-preview)] flex-none animate-pulse bg-neutral-200" />
    <div className="flex flex-1 flex-col gap-2"><span aria-hidden="true" className="h-4 w-2/5 animate-pulse bg-neutral-200" /><span aria-hidden="true" className="h-3 w-3/5 animate-pulse bg-neutral-100" /></div>
  </div>;
}
