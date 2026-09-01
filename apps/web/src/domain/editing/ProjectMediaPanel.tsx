import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  FileAudio2,
  FileVideo2,
  FolderInput,
  Grid2X2,
  Link2,
  List,
  Pause,
  Play,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { mediaAssetStreamPath, mediaAssetThumbnailPath } from '../../data/mediaAssets';
import { useNativeShell } from '../../data/nativeShell';
import { Empty, Skeleton } from '../../design/data';
import { Dialog, Tooltip } from '../../design/feedback';
import { Button, Input, NativeSelect, Seg, cn } from '../../design/primitives';
import type { MediaAsset, TimelineClip, TimelineClipMaterializationState, TimelineTrack } from '../../shared/desktop/dto';
import {
  clearProjectMediaDrag,
  isStillImageMediaAsset,
  mediaAssetEditDuration,
  projectMediaAssetKind,
  writeProjectMediaDrag,
} from './mediaDrag';
import { resolveTimelineMaterial } from './timelineMaterial';
import type { SourceMediaPatch } from './sourceMediaEditing';

export interface ProjectMediaPanelProps {
  readonly assets: readonly MediaAsset[];
  readonly timelineTracks: readonly TimelineTrack[];
  readonly deliveryStateByClipId?: ReadonlyMap<string, TimelineClipMaterializationState>;
  readonly projectFps: number;
  readonly selectedTimelineClipId: string | null;
  readonly matchedSourceFrame: { readonly clipId: string; readonly sourceTime: number } | null;
  readonly pending: boolean;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly canEditAsset: (asset: MediaAsset, sourcePatch: ProjectSourcePatch) => boolean;
  readonly sourcePatchTargets: (asset: MediaAsset, sourcePatch: ProjectSourcePatch) => ProjectSourcePatchTargets;
  readonly importAvailable: boolean;
  readonly relinkAvailable: boolean;
  readonly importing: boolean;
  readonly docked?: boolean;
  readonly onSelectTimelineClip: (clipId: string, startSeconds: number) => void;
  readonly onRequestRecording: (clipId: string) => void;
  readonly onImport: () => void;
  readonly onInsert: (asset: MediaAsset, sourceRange: ProjectSourceRange, sourcePatch: ProjectSourcePatch) => void;
  readonly onOverwrite: (asset: MediaAsset, sourceRange: ProjectSourceRange, sourcePatch: ProjectSourcePatch) => void;
  readonly canReplace: (asset: MediaAsset, sourceRange: ProjectSourceRange) => boolean;
  readonly onReplace: (asset: MediaAsset, sourceRange: ProjectSourceRange) => void;
  readonly onRelink: (asset: MediaAsset) => void;
  readonly onDelete: (asset: MediaAsset) => void;
  readonly onClose?: (() => void) | undefined;
}

export interface ProjectSourceRange {
  readonly sourceIn: number;
  readonly sourceOut: number;
}

export type ProjectSourcePatch = SourceMediaPatch;

export interface ProjectSourcePatchTargets {
  readonly video: string | null;
  readonly audio: string | null;
}

type MediaStateFilter = 'all' | 'planned' | 'recorded' | 'imported';
type ProjectMediaView = 'list' | 'icon';
const EMPTY_DELIVERY_STATES = new Map<string, TimelineClipMaterializationState>();

type ProjectMediaItem = {
  readonly key: string;
  readonly name: string;
  readonly durationSeconds: number | null;
  readonly kind: 'video' | 'audio';
  readonly state: 'planned' | 'recorded' | 'stale' | 'imported';
  readonly previewAssetId: string | null;
  readonly isStillImage: boolean;
  readonly timelineClip: TimelineClip | null;
  readonly sourceAsset: MediaAsset | null;
  readonly importedAsset: MediaAsset | null;
};

export function ProjectMediaPanel({
  assets,
  timelineTracks,
  deliveryStateByClipId = EMPTY_DELIVERY_STATES,
  projectFps,
  selectedTimelineClipId,
  matchedSourceFrame,
  pending,
  readOnly,
  busy,
  canEditAsset,
  sourcePatchTargets,
  importAvailable,
  relinkAvailable,
  importing,
  docked = false,
  onSelectTimelineClip,
  onRequestRecording,
  onImport,
  onInsert,
  onOverwrite,
  canReplace,
  onReplace,
  onRelink,
  onDelete,
  onClose,
}: ProjectMediaPanelProps) {
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<MediaStateFilter>('all');
  const [view, setView] = useState<ProjectMediaView>('list');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sourceTimes, setSourceTimes] = useState<Readonly<Record<string, number>>>({});
  const [sourceRanges, setSourceRanges] = useState<Readonly<Record<string, ProjectSourceRange>>>({});
  const [sourcePatches, setSourcePatches] = useState<Readonly<Record<string, ProjectSourcePatch>>>({});
  const [deleteCandidate, setDeleteCandidate] = useState<MediaAsset | null>(null);
  const items = useMemo(
    () => projectMediaItems(timelineTracks, assets, deliveryStateByClipId),
    [assets, deliveryStateByClipId, timelineTracks],
  );

  useEffect(() => {
    if (selectedTimelineClipId !== null) setSelectedKey(`clip:${selectedTimelineClipId}`);
  }, [selectedTimelineClipId]);
  useEffect(() => {
    if (matchedSourceFrame === null) return;
    const key = `clip:${matchedSourceFrame.clipId}`;
    setSelectedKey(key);
    setSourceTimes((current) => ({ ...current, [key]: matchedSourceFrame.sourceTime }));
  }, [matchedSourceFrame]);
  useEffect(() => {
    if (selectedKey !== null && !items.some((item) => item.key === selectedKey)) setSelectedKey(null);
  }, [items, selectedKey]);

  const selected = items.find((item) => item.key === selectedKey) ?? null;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = useMemo(() => items.filter((item) => (
    (stateFilter === 'all' || item.state === stateFilter || (stateFilter === 'planned' && item.state === 'stale'))
    && (normalizedQuery === '' || item.name.toLocaleLowerCase().includes(normalizedQuery))
  )), [items, normalizedQuery, stateFilter]);
  const plannedItems = filtered.filter((item) => item.state === 'planned' || item.state === 'stale');
  const recordedItems = filtered.filter((item) => item.state === 'recorded');
  const importedItems = filtered.filter((item) => item.importedAsset !== null);
  const selectedSourceAsset = selected?.sourceAsset ?? null;
  const selectedImportedAsset = selected?.importedAsset ?? null;
  const selectedDuration = selected?.durationSeconds ?? 0;
  const defaultSourceRange = useMemo<ProjectSourceRange>(
    () => selected?.timelineClip === null || selected?.timelineClip === undefined
      ? { sourceIn: 0, sourceOut: selectedDuration }
      : {
          sourceIn: selected.timelineClip.placement.source_in,
          sourceOut: selected.timelineClip.placement.source_out,
        },
    [selected?.timelineClip, selectedDuration],
  );
  const selectedSourceRange = selected === null ? defaultSourceRange : sourceRanges[selected.key] ?? defaultSourceRange;
  const selectedSourceTime = selected === null
    ? 0
    : sourceTimes[selected.key] ?? selectedSourceRange.sourceIn;
  const setSelectedSourceTime = (time: number) => {
    if (selected === null) return;
    setSourceTimes((current) => ({
      ...current,
      [selected.key]: Math.min(selectedDuration, Math.max(0, time)),
    }));
  };
  const setSelectedSourceRange = (range: ProjectSourceRange) => {
    if (selected === null) return;
    setSourceRanges((current) => ({ ...current, [selected.key]: range }));
  };
  const defaultSourcePatch: ProjectSourcePatch = {
    video: selected?.kind === 'video',
    audio: selectedSourceAsset?.has_audio === true,
  };
  const selectedSourcePatch = selected === null
    ? defaultSourcePatch
    : sourcePatches[selected.key] ?? defaultSourcePatch;
  const selectedSourcePatchTargets = selectedImportedAsset === null
    ? { video: null, audio: null }
    : sourcePatchTargets(selectedImportedAsset, selectedSourcePatch);
  const setSelectedSourcePatch = (sourcePatch: ProjectSourcePatch) => {
    if (selected === null) return;
    setSourcePatches((current) => ({ ...current, [selected.key]: sourcePatch }));
  };
  const canEditSource = selectedImportedAsset !== null
    && selectedImportedAsset.metadata_status.status === 'ready'
    && selectedImportedAsset.duration_seconds !== null
    && selectedImportedAsset.duration_seconds > 0
    && !readOnly
    && !busy
    && (selectedSourcePatch.video || selectedSourcePatch.audio)
    && canEditAsset(selectedImportedAsset, selectedSourcePatch);
  const canReplaceSource = selectedImportedAsset !== null
    && selectedImportedAsset.metadata_status.status === 'ready'
    && !readOnly
    && !busy
    && canReplace(selectedImportedAsset, selectedSourceRange);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!canEditSource || selectedImportedAsset === null || isTextEditingTarget(event.target)) return;
      if (event.key === ',') {
        event.preventDefault();
        onInsert(selectedImportedAsset, selectedSourceRange, selectedSourcePatch);
      } else if (event.key === '.') {
        event.preventDefault();
        onOverwrite(selectedImportedAsset, selectedSourceRange, selectedSourcePatch);
      }
    };
    globalThis.addEventListener('keydown', handleKeyDown);
    return () => globalThis.removeEventListener('keydown', handleKeyDown);
  }, [canEditSource, onInsert, onOverwrite, selectedImportedAsset, selectedSourcePatch, selectedSourceRange]);

  return (
    <section
      className="grid min-h-0 min-w-0 grid-rows-[36px_auto_272px_minmax(0,1fr)] overflow-hidden border border-divider bg-bg"
      aria-label={t`项目素材`}
    >
      <header className="flex items-center gap-2 border-b border-divider px-2.5">
        {docked ? null : <h2 className="text-sm font-semibold"><Trans>项目素材</Trans></h2>}
        <span className="text-2xs tabular-nums text-neutral-500">
          <Trans>
            待录 {items.filter((item) => item.state === 'planned' || item.state === 'stale').length}
            {' · '}
            已录 {items.filter((item) => item.state === 'recorded').length}
          </Trans>
        </span>
        <Seg<ProjectMediaView>
          className="ml-auto"
          name="project-media-view"
          aria-label={t`项目素材视图`}
          value={view}
          options={[
            {
              value: 'list',
              label: <><List className="size-3.5" aria-hidden="true" /><span className="sr-only"><Trans>列表视图</Trans></span></>,
            },
            {
              value: 'icon',
              label: <><Grid2X2 className="size-3.5" aria-hidden="true" /><span className="sr-only"><Trans>图标视图</Trans></span></>,
            },
          ]}
          onChange={setView}
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={!importAvailable || importing}
          aria-label={t`导入项目素材`}
          onClick={onImport}
        >
          <FolderInput className="size-3.5" aria-hidden="true" />
          <Trans>导入</Trans>
        </Button>
        {docked ? null : <button
          type="button"
          className="grid size-7 place-items-center text-neutral-500 hover:bg-neutral-100 hover:text-text"
          aria-label={t`隐藏项目素材`}
          onClick={onClose}
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>}
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)_104px] gap-1.5 border-b border-divider p-2">
        <label className="relative min-w-0">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-neutral-500" aria-hidden="true" />
          <Input
            className="pl-7"
            size="sm"
            type="search"
            ground="bg"
            value={query}
            aria-label={t`搜索项目素材`}
            placeholder={t`搜索素材`}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <NativeSelect
          size="sm"
          value={stateFilter}
          aria-label={t`筛选素材状态`}
          onChange={(event) => setStateFilter(event.currentTarget.value as MediaStateFilter)}
        >
          <option value="all">{t`全部状态`}</option>
          <option value="planned">{t`准备录制`}</option>
          <option value="recorded">{t`已录制`}</option>
          <option value="imported">{t`导入素材`}</option>
        </NativeSelect>
      </div>

      <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_72px]">
        <SourceMonitor
          item={selected}
          fps={projectFps}
          sourceTime={selectedSourceTime}
          sourceRange={selectedSourceRange}
          onSourceTimeChange={setSelectedSourceTime}
          onSourceRangeChange={setSelectedSourceRange}
        />
        <div className="border-t border-divider bg-bg p-1">
          {(selected?.state === 'planned' || selected?.state === 'stale') && selected.timelineClip !== null ? (
            <Button
              className="w-full"
              size="sm"
              variant="secondary"
              disabled={readOnly || busy}
              aria-label={t`录制片段 ${selected.name}`}
              onClick={() => {
                if (selected.timelineClip !== null) onRequestRecording(selected.timelineClip.id);
              }}
            >
              <Trans>录制此片段</Trans>
            </Button>
          ) : selectedSourceAsset === null ? (
            <p className="truncate px-0.5 py-2 text-2xs text-neutral-500">
              {selected?.state === 'recorded' ? t`该片段缺少可解析的素材记录。` : t`选择导入素材可插入或覆盖。`}
            </p>
          ) : selectedImportedAsset === null ? (
            <div className="flex h-full items-center gap-1">
              <p className={cn(
                'min-w-0 flex-1 truncate text-2xs',
                selectedSourceAsset.metadata_status.status === 'unavailable' ? 'text-fail-text' : 'text-neutral-500',
              )}>
                {selectedSourceAsset.metadata_status.status === 'unavailable'
                  ? t`源文件不可用，请重新定位。`
                  : t`该片段已录制并位于时间线中。`}
              </p>
              <Button
                size="sm"
                variant="secondary"
                disabled={!relinkAvailable || busy}
                aria-label={t`重新定位素材 ${selectedSourceAsset.name}`}
                onClick={() => onRelink(selectedSourceAsset)}
              >
                <Link2 className="size-3.5" aria-hidden="true" />
                <Trans>重新定位</Trans>
              </Button>
            </div>
          ) : (
            <div>
              <div className="mb-0.5 flex min-w-0 items-center gap-0.5">
                {selected?.kind === 'video' ? (
                  <button
                    type="button"
                    className={cn(
                      'h-6 min-w-6 rounded-sm border px-1 font-mono text-2xs font-semibold',
                      selectedSourcePatch.video ? 'border-accent-500 bg-accent-100 text-accent-text' : 'border-divider text-neutral-400',
                    )}
                    aria-label={t`包含源视频`}
                    aria-pressed={selectedSourcePatch.video}
                    onClick={() => setSelectedSourcePatch({ ...selectedSourcePatch, video: !selectedSourcePatch.video })}
                  >V</button>
                ) : null}
                {selectedSourceAsset?.has_audio === true ? (
                  <button
                    type="button"
                    className={cn(
                      'h-6 min-w-6 rounded-sm border px-1 font-mono text-2xs font-semibold',
                      selectedSourcePatch.audio ? 'border-accent-500 bg-accent-100 text-accent-text' : 'border-divider text-neutral-400',
                    )}
                    aria-label={t`包含源音频`}
                    aria-pressed={selectedSourcePatch.audio}
                    onClick={() => setSelectedSourcePatch({ ...selectedSourcePatch, audio: !selectedSourcePatch.audio })}
                  >A</button>
                ) : null}
                <p className="min-w-0 flex-1 truncate text-2xs text-neutral-500">
                  {selectedSourcePatch.video ? `V → ${selectedSourcePatchTargets.video ?? t`无视频目标`}` : null}
                  {selectedSourcePatch.video && selectedSourcePatch.audio ? ' · ' : null}
                  {selectedSourcePatch.audio ? `A → ${selectedSourcePatchTargets.audio ?? t`无音频目标`}` : null}
                  {!selectedSourcePatch.video && !selectedSourcePatch.audio ? t`未启用源声道` : null}
                </p>
                <Button
                  size="sm"
                  icon
                  variant="ghost"
                  disabled={!relinkAvailable || busy}
                  aria-label={t`重新定位素材 ${selectedImportedAsset.name}`}
                  onClick={() => onRelink(selectedImportedAsset)}
                >
                  <Link2 className="size-3.5" aria-hidden="true" />
                </Button>
                <Button
                  className="text-fail-text"
                  size="sm"
                  icon
                  variant="ghost"
                  disabled={busy}
                  aria-label={t`从项目移除素材 ${selectedImportedAsset.name}`}
                  onClick={() => setDeleteCandidate(selectedImportedAsset)}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  className="flex-1"
                  size="sm"
                  variant="secondary"
                  disabled={!canEditSource}
                  aria-label={t`在播放头插入 ${selectedImportedAsset.name}`}
                  onClick={() => onInsert(selectedImportedAsset, selectedSourceRange, selectedSourcePatch)}
                >
                  <Trans>插入</Trans>
                  <span className="text-2xs text-neutral-500">,</span>
                </Button>
                <Button
                  className="flex-1"
                  size="sm"
                  variant="ghost"
                  disabled={!canEditSource}
                  aria-label={t`在播放头覆盖 ${selectedImportedAsset.name}`}
                  onClick={() => onOverwrite(selectedImportedAsset, selectedSourceRange, selectedSourcePatch)}
                >
                  <Trans>覆盖</Trans>
                  <span className="text-2xs text-neutral-500">.</span>
                </Button>
                <Tooltip content={canReplaceSource
                  ? t`保留所选片段的时间位置、时长、效果和关键帧，只替换源素材`
                  : t`需要先选择兼容片段，并确保源入点之后有足够素材`} side="top">
                  <span className="flex-1">
                    <Button
                      className="w-full"
                      size="sm"
                      variant="ghost"
                      disabled={!canReplaceSource}
                      aria-label={t`用 ${selectedImportedAsset.name} 替换所选片段`}
                      onClick={() => onReplace(selectedImportedAsset, selectedSourceRange)}
                    >
                      <Trans>替换</Trans>
                    </Button>
                  </span>
                </Tooltip>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="min-h-0 overflow-y-auto border-t border-divider" aria-live="polite">
        {pending ? <Skeleton className="m-2 h-24" /> : filtered.length > 0 ? (
          <div role="listbox" aria-label={t`项目素材列表`}>
            <MediaItemSection
              label={t`准备录制`}
              items={plannedItems}
              view={view}
              selectedKey={selectedKey}
              onSelect={(item) => {
                setSelectedKey(item.key);
                if (item.timelineClip !== null) {
                  onSelectTimelineClip(item.timelineClip.id, item.timelineClip.placement.start);
                }
              }}
            />
            <MediaItemSection
              label={t`已录制`}
              items={recordedItems}
              view={view}
              selectedKey={selectedKey}
              onSelect={(item) => {
                setSelectedKey(item.key);
                if (item.timelineClip !== null) {
                  onSelectTimelineClip(item.timelineClip.id, item.timelineClip.placement.start);
                }
              }}
            />
            <MediaItemSection
              label={t`导入素材`}
              items={importedItems}
              view={view}
              selectedKey={selectedKey}
              onSelect={(item) => setSelectedKey(item.key)}
            />
          </div>
        ) : (
          <Empty
            className="m-3 min-h-40"
            title={normalizedQuery === '' && stateFilter === 'all' ? <Trans>项目还没有素材</Trans> : <Trans>没有匹配的素材</Trans>}
            description={normalizedQuery === '' && stateFilter === 'all'
              ? <Trans>时间线待录制片段、已录制片段和导入素材都会显示在这里。</Trans>
              : <Trans>调整搜索词或素材状态筛选。</Trans>}
            actions={normalizedQuery !== '' || stateFilter !== 'all' ? undefined : (
              <Button size="sm" variant="secondary" disabled={!importAvailable || importing} onClick={onImport}>
                <Trans>导入文件</Trans>
              </Button>
            )}
          />
        )}
      </div>

      <Dialog
        open={deleteCandidate !== null}
        title={<Trans>从项目移除素材？</Trans>}
        confirmLabel={<Trans>移除素材</Trans>}
        tone="destructive"
        confirmDisabled={busy}
        onConfirm={() => {
          if (deleteCandidate === null) return;
          const candidate = deleteCandidate;
          setDeleteCandidate(null);
          onDelete(candidate);
        }}
        onClose={() => setDeleteCandidate(null)}
      >
        <p><Trans>只移除项目中的素材记录；磁盘上的源文件不会删除。</Trans></p>
      </Dialog>
    </section>
  );
}

function MediaItemSection({
  label,
  items,
  view,
  selectedKey,
  onSelect,
}: {
  readonly label: string;
  readonly items: readonly ProjectMediaItem[];
  readonly view: ProjectMediaView;
  readonly selectedKey: string | null;
  readonly onSelect: (item: ProjectMediaItem) => void;
}) {
  const shell = useNativeShell();
  if (items.length === 0) return null;
  return (
    <section aria-label={label}>
      <header className="sticky top-0 z-10 flex h-6 items-center gap-1.5 border-b border-divider bg-neutral-50 px-2.5 text-2xs font-semibold uppercase tracking-wide text-neutral-500">
        <span>{label}</span>
        <span className="tabular-nums">{items.length}</span>
      </header>
      <div
        className={view === 'icon' ? 'grid grid-cols-2 gap-2 p-2' : 'divide-y divide-divider'}
        data-project-media-view={view}
      >
        {items.map((item) => {
          const selected = item.key === selectedKey;
          const Icon = item.state === 'planned' || item.state === 'stale'
            ? CircleDashed
            : item.kind === 'audio' ? FileAudio2 : FileVideo2;
          const draggableAsset = item.importedAsset?.metadata_status.status === 'ready'
            ? item.importedAsset
            : null;
          const sourceTime = item.timelineClip?.placement.source_in ?? 0;
          const thumbnail = item.kind === 'video' && item.previewAssetId !== null
            ? shell.mediaSrc(mediaAssetThumbnailPath(item.previewAssetId, sourceTime))
            : null;
          return (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={selected}
              aria-label={t`选择素材 ${item.name}`}
              className={cn(
                'min-w-0 text-left hover:bg-neutral-100',
                view === 'icon'
                  ? 'overflow-hidden border border-divider bg-bg p-1.5'
                  : 'grid w-full grid-cols-[30px_minmax(0,1fr)] gap-2 px-2.5 py-2',
                draggableAsset !== null && item.durationSeconds !== null && item.durationSeconds > 0
                  ? 'cursor-grab active:cursor-grabbing'
                  : 'cursor-default',
                selected && 'bg-accent-100 ring-1 ring-inset ring-accent-300',
              )}
              draggable={draggableAsset !== null && item.durationSeconds !== null && item.durationSeconds > 0}
              onClick={() => onSelect(item)}
              onDragStart={(event) => {
                if (draggableAsset === null || writeProjectMediaDrag(event.dataTransfer, draggableAsset) === null) {
                  event.preventDefault();
                  return;
                }
                onSelect(item);
              }}
              onDragEnd={clearProjectMediaDrag}
            >
              {view === 'icon' ? (
                <span className="relative mb-1.5 grid aspect-video w-full place-items-center overflow-hidden bg-neutral-900 text-neutral-300">
                  {thumbnail === null ? (
                    <Icon className="size-6" aria-hidden="true" />
                  ) : (
                    <img
                      className="size-full object-cover"
                      src={thumbnail}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      draggable={false}
                      aria-hidden="true"
                    />
                  )}
                  <span className="absolute bottom-1 right-1 bg-neutral-950/80 px-1 font-mono text-2xs text-bg">
                    {formatDuration(item.durationSeconds)}
                  </span>
                </span>
              ) : (
                <span className="grid size-[30px] place-items-center border border-divider bg-neutral-50 text-neutral-500">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
              )}
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-text">{item.name}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-2xs text-neutral-500">
                  {view === 'icon' ? null : <span className="tabular-nums">{formatDuration(item.durationSeconds)}</span>}
                  <span className={stateTone(item.state)}>{stateLabel(item.state)}</span>
                  {item.sourceAsset?.metadata_status.status === 'unavailable' ? (
                    <span className="text-fail-text"><Trans>不可用</Trans></span>
                  ) : null}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function SourceMonitor({ item, fps, sourceTime, sourceRange, onSourceTimeChange, onSourceRangeChange }: {
  readonly item: ProjectMediaItem | null;
  readonly fps: number;
  readonly sourceTime: number;
  readonly sourceRange: ProjectSourceRange;
  readonly onSourceTimeChange: (seconds: number) => void;
  readonly onSourceRangeChange: (range: ProjectSourceRange) => void;
}) {
  const shell = useNativeShell();
  const [mountedAssets, setMountedAssets] = useState<readonly {
    readonly id: string;
    readonly kind: 'video' | 'audio' | 'image';
  }[]>([]);
  const [displayedAssetId, setDisplayedAssetId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const mediaRefs = useRef(new Map<string, HTMLMediaElement>());
  const previewAssetId = item?.previewAssetId ?? null;
  const duration = Math.max(0, item?.durationSeconds ?? 0);
  const frame = 1 / Math.max(1, fps);

  useEffect(() => {
    if (item !== null) return;
    for (const media of mediaRefs.current.values()) {
      if (!media.paused) media.pause();
    }
    setMountedAssets([]);
    setDisplayedAssetId(null);
    setPlaying(false);
  }, [item]);

  useEffect(() => {
    if (previewAssetId === null) return;
    setMountedAssets((current) => current.some((asset) => asset.id === previewAssetId)
      ? current
      : [
          ...current.filter((asset) => asset.id !== displayedAssetId).slice(-1),
          ...current.filter((asset) => asset.id === displayedAssetId),
          {
            id: previewAssetId,
            kind: item?.isStillImage === true ? 'image' : item?.kind === 'audio' ? 'audio' : 'video',
          },
        ]);
  }, [displayedAssetId, item?.isStillImage, item?.kind, previewAssetId]);

  useEffect(() => {
    for (const [assetId, media] of mediaRefs.current) {
      if (assetId !== previewAssetId && !media.paused) media.pause();
    }
    setPlaying(false);
  }, [previewAssetId]);

  const seekLatest = () => {
    if (previewAssetId === null) return;
    const media = mediaRefs.current.get(previewAssetId);
    if (media === undefined || media.seeking || Math.abs(media.currentTime - sourceTime) <= 0.5 * frame) return;
    try {
      media.currentTime = sourceTime;
    } catch {
      // Metadata readiness events retry the same authoritative source playhead.
    }
  };
  useEffect(seekLatest, [frame, previewAssetId, sourceTime]);

  const togglePlayback = () => {
    if (previewAssetId === null) return;
    const media = mediaRefs.current.get(previewAssetId);
    if (media === undefined) return;
    if (!media.paused) {
      media.pause();
      setPlaying(false);
      return;
    }
    if (media.currentTime < sourceRange.sourceIn || media.currentTime >= sourceRange.sourceOut - 0.5 * frame) {
      media.currentTime = sourceRange.sourceIn;
      onSourceTimeChange(sourceRange.sourceIn);
    }
    void media.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };
  const stepFrame = (direction: -1 | 1) => {
    const next = Math.min(duration, Math.max(0, sourceTime + direction * frame));
    onSourceTimeChange(next);
  };
  const canMarkSourceRange = item !== null && duration >= frame;
  const markSourceIn = () => {
    const sourceIn = Math.min(duration - frame, Math.max(0, sourceTime));
    onSourceRangeChange({
      sourceIn,
      sourceOut: Math.min(duration, Math.max(sourceIn + frame, sourceRange.sourceOut)),
    });
  };
  const markSourceOut = () => {
    const sourceOut = Math.min(duration, Math.max(frame, sourceTime + frame));
    onSourceRangeChange({
      sourceIn: Math.max(0, Math.min(sourceRange.sourceIn, sourceOut - frame)),
      sourceOut,
    });
  };

  const selectedPreviewReady = previewAssetId !== null && displayedAssetId === previewAssetId;
  return (
    <div
      className="grid min-h-0 grid-rows-[minmax(0,1fr)_52px] bg-neutral-900"
      aria-label={t`源素材预览`}
      onKeyDown={(event) => {
        if (event.key.toLowerCase() === 'i') {
          event.preventDefault();
          if (canMarkSourceRange) markSourceIn();
        } else if (event.key.toLowerCase() === 'o') {
          event.preventDefault();
          if (canMarkSourceRange) markSourceOut();
        } else if (event.key === ' ') {
          event.preventDefault();
          togglePlayback();
        }
      }}
    >
      <div className="relative min-h-0 overflow-hidden">
        {mountedAssets.map(({ id: assetId, kind }) => {
          const source = shell.mediaSrc(mediaAssetStreamPath(assetId));
          const className = cn(
            'pointer-events-none absolute inset-0 size-full bg-neutral-900 object-contain transition-opacity',
            displayedAssetId === assetId ? 'opacity-100' : 'opacity-0',
          );
          if (kind === 'image') {
            return (
              <img
                key={assetId}
                className={className}
                src={source ?? undefined}
                alt=""
                draggable={false}
                aria-hidden="true"
                data-source-preview-asset-id={assetId}
                data-source-preview-visible={displayedAssetId === assetId ? 'true' : 'false'}
                onLoad={() => {
                  if (previewAssetId === assetId) setDisplayedAssetId(assetId);
                }}
              />
            );
          }
          const MediaElement = kind === 'audio' ? 'audio' : 'video';
          return (
            <MediaElement
              key={assetId}
              ref={(element) => {
                if (element === null) mediaRefs.current.delete(assetId);
                else mediaRefs.current.set(assetId, element);
              }}
              className={kind === 'audio' ? 'hidden' : className}
              src={source ?? undefined}
              preload="auto"
              playsInline
              tabIndex={-1}
              aria-hidden="true"
              data-source-preview-asset-id={assetId}
              data-source-preview-visible={displayedAssetId === assetId ? 'true' : 'false'}
              onLoadedMetadata={seekLatest}
              onLoadedData={() => {
                if (previewAssetId === assetId) {
                  setDisplayedAssetId(assetId);
                  seekLatest();
                }
              }}
              onSeeked={seekLatest}
              onTimeUpdate={(event) => {
                if (previewAssetId !== assetId) return;
                const current = event.currentTarget.currentTime;
                if (current >= sourceRange.sourceOut - 0.5 * frame) {
                  event.currentTarget.pause();
                  setPlaying(false);
                  onSourceTimeChange(sourceRange.sourceOut);
                  return;
                }
                onSourceTimeChange(current);
              }}
              onPause={() => {
                if (previewAssetId === assetId) setPlaying(false);
              }}
            />
          );
        })}
        {item === null ? (
          <div className="absolute inset-0 grid place-items-center bg-neutral-900 px-4 text-center text-xs text-neutral-400">
            <Trans>选择素材以预览源画面</Trans>
          </div>
        ) : item.sourceAsset?.metadata_status.status === 'unavailable' ? (
          <div className="absolute inset-0 grid place-items-center bg-neutral-900 px-4 text-center text-xs text-fail-text">
            <span>
              <Link2 className="mx-auto mb-2 size-8" strokeWidth={1.2} aria-hidden="true" />
              <span className="block"><Trans>源文件不可用</Trans></span>
              <span className="mt-1 block text-2xs text-neutral-400"><Trans>重新定位后可继续预览和编辑。</Trans></span>
            </span>
          </div>
        ) : item.state === 'planned' ? (
          <div className="absolute inset-0 grid place-items-center bg-neutral-900 px-4 text-center text-xs text-neutral-300">
            <span>
              <CircleDashed className="mx-auto mb-2 size-8" strokeWidth={1.2} aria-hidden="true" />
              <span className="block"><Trans>准备录制</Trans></span>
              {item.timelineClip?.capture_intent === null || item.timelineClip?.capture_intent === undefined ? null : (
                <span className="mt-1 block text-2xs text-neutral-400">
                  {item.timelineClip.capture_intent.player_id} · tick {item.timelineClip.capture_intent.start_tick}–{item.timelineClip.capture_intent.end_tick}
                </span>
              )}
            </span>
          </div>
        ) : item.kind === 'audio' ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center bg-neutral-900 text-neutral-300">
            <FileAudio2 className="size-10" strokeWidth={1.2} aria-hidden="true" />
          </div>
        ) : selectedPreviewReady ? null : (
          <div className="absolute inset-0 grid place-items-center bg-neutral-900/45 px-4 text-center text-xs text-neutral-300">
            <Trans>正在准备 {item.name}</Trans>
          </div>
        )}
        {item === null ? null : (
          <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-neutral-950/70 px-2 py-1 text-2xs text-neutral-100">
            <span className="truncate">{item.name}</span>
            <span className="flex-none tabular-nums">{formatDuration(item.durationSeconds)}</span>
          </div>
        )}
      </div>
      <div className="border-t border-neutral-700 bg-neutral-950 text-neutral-100">
        <div className="flex h-7 items-center justify-center gap-1">
          <button type="button" className="grid size-6 place-items-center" aria-label={t`源素材上一帧`} disabled={item === null} onClick={() => stepFrame(-1)}><ChevronLeft className="size-3.5" aria-hidden="true" /></button>
          <button type="button" className="grid size-6 place-items-center" aria-label={playing ? t`暂停源素材` : t`播放源素材`} disabled={previewAssetId === null || item?.isStillImage === true} onClick={togglePlayback}>{playing ? <Pause className="size-3.5" aria-hidden="true" /> : <Play className="size-3.5" aria-hidden="true" />}</button>
          <button type="button" className="grid size-6 place-items-center" aria-label={t`源素材下一帧`} disabled={item === null} onClick={() => stepFrame(1)}><ChevronRight className="size-3.5" aria-hidden="true" /></button>
          <span className="ml-1 font-mono text-2xs">{formatSourceTime(sourceTime)}</span>
          <button type="button" className="ml-auto h-6 px-1.5 font-mono text-2xs" aria-label={t`标记源入点`} disabled={!canMarkSourceRange} onClick={markSourceIn}>I</button>
          <button type="button" className="h-6 px-1.5 font-mono text-2xs" aria-label={t`标记源出点`} disabled={!canMarkSourceRange} onClick={markSourceOut}>O</button>
          <button type="button" className="mr-1 h-6 px-1.5 text-2xs" aria-label={t`清除源入出点`} disabled={item === null} onClick={() => onSourceRangeChange({ sourceIn: 0, sourceOut: duration })}>×</button>
        </div>
        <div className="relative h-6">
          <div className="pointer-events-none absolute inset-x-2 top-2 h-2 overflow-visible bg-neutral-700">
            <span
              className="absolute inset-y-0 bg-accent-500/75"
              style={{
                left: `${duration <= 0 ? 0 : sourceRange.sourceIn / duration * 100}%`,
                width: `${duration <= 0 ? 0 : (sourceRange.sourceOut - sourceRange.sourceIn) / duration * 100}%`,
              }}
            />
            <span
              className="absolute -bottom-1 -top-1 w-px bg-neutral-50"
              style={{ left: `${duration <= 0 ? 0 : sourceTime / duration * 100}%` }}
            />
          </div>
          <input
            type="range"
            className="absolute inset-0 z-10 size-full cursor-ew-resize opacity-0 disabled:cursor-default"
            min={0}
            max={Math.max(frame, duration)}
            step={frame}
            value={sourceTime}
            disabled={item === null}
            aria-label={t`源素材播放头`}
            aria-valuetext={formatSourceTime(sourceTime)}
            onChange={(event) => onSourceTimeChange(event.currentTarget.valueAsNumber)}
          />
        </div>
      </div>
    </div>
  );
}

function projectMediaItems(
  tracks: readonly TimelineTrack[],
  assets: readonly MediaAsset[],
  deliveryStateByClipId: ReadonlyMap<string, TimelineClipMaterializationState>,
): ProjectMediaItem[] {
  const referencedAssetIds = new Set<string>();
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const timelineItems = tracks
    .filter((track) => track.kind !== 'text')
    .flatMap((track) => track.clips.map((clip): ProjectMediaItem => {
      const material = resolveTimelineMaterial(clip.material, clip.placement);
      const deliveryState = deliveryStateByClipId.get(clip.id);
      if (material.streamAssetId !== null) referencedAssetIds.add(material.streamAssetId);
      const sourceAsset = material.streamAssetId === null ? null : assetsById.get(material.streamAssetId) ?? null;
      return {
        key: `clip:${clip.id}`,
        name: clip.name,
        durationSeconds: sourceAsset === null
          ? clip.material.kind === 'planned' ? clip.placement.duration : clip.material.media_duration_seconds
          : mediaAssetEditDuration(sourceAsset),
        kind: track.kind === 'audio' ? 'audio' : 'video',
        state: deliveryState === 'stale'
          ? 'stale'
          : deliveryState === 'unbound' || deliveryState === 'unrecorded'
            ? 'planned'
            : material.state,
        previewAssetId: sourceAsset?.metadata_status.status === 'unavailable' ? null : material.streamAssetId,
        isStillImage: sourceAsset === null
          ? typeof clip.metadata === 'object' && clip.metadata !== null && !Array.isArray(clip.metadata)
            && typeof clip.metadata.media_kind === 'string' && clip.metadata.media_kind.toLowerCase().startsWith('image')
          : isStillImageMediaAsset(sourceAsset),
        timelineClip: clip,
        sourceAsset,
        importedAsset: null,
      };
    }));
  const importedItems = assets
    .filter((asset) => !referencedAssetIds.has(asset.id))
    .map((asset): ProjectMediaItem => ({
      key: `asset:${asset.id}`,
      name: asset.name,
      durationSeconds: mediaAssetEditDuration(asset),
      kind: projectMediaAssetKind(asset),
      state: 'imported',
      previewAssetId: asset.metadata_status.status === 'ready' ? asset.id : null,
      isStillImage: isStillImageMediaAsset(asset),
      timelineClip: null,
      sourceAsset: asset,
      importedAsset: asset,
    }));
  return [...timelineItems, ...importedItems];
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return t`时长未知`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.max(0, seconds - minutes * 60);
  return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(3).padStart(6, '0')}`;
}

function formatSourceTime(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const remainder = Math.max(0, seconds - minutes * 60);
  return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(3).padStart(6, '0')}`;
}

function stateLabel(state: ProjectMediaItem['state']): string {
  if (state === 'planned') return t`准备录制`;
  if (state === 'stale') return t`需要重录`;
  if (state === 'recorded') return t`已录制`;
  return t`导入`;
}

function stateTone(state: ProjectMediaItem['state']): string {
  if (state === 'planned') return 'text-warn';
  if (state === 'stale') return 'text-fail-text';
  if (state === 'recorded') return 'text-ok';
  return 'text-accent-text';
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches('input, textarea, select, [role="textbox"]');
}
