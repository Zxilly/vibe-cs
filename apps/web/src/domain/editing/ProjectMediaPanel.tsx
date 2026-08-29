import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  CircleDashed,
  FileAudio2,
  FileVideo2,
  FolderInput,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { mediaAssetStreamPath } from '../../data/mediaAssets';
import { useNativeShell } from '../../data/nativeShell';
import { Empty, Skeleton } from '../../design/data';
import { Button, Input, NativeSelect, cn } from '../../design/primitives';
import type { MediaAsset, TimelineClip } from '../../shared/desktop/dto';
import { resolveTimelineMaterial } from './timelineMaterial';

export interface ProjectMediaPanelProps {
  readonly assets: readonly MediaAsset[];
  readonly timelineClips: readonly TimelineClip[];
  readonly selectedTimelineClipId: string | null;
  readonly pending: boolean;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly importAvailable: boolean;
  readonly importing: boolean;
  readonly onSelectTimelineClip: (clipId: string, startSeconds: number) => void;
  readonly onRequestRecording: (clipId: string) => void;
  readonly onImport: () => void;
  readonly onInsert: (asset: MediaAsset) => void;
  readonly onOverwrite: (asset: MediaAsset) => void;
  readonly onClose: () => void;
}

type MediaStateFilter = 'all' | 'planned' | 'recorded' | 'imported';

type ProjectMediaItem = {
  readonly key: string;
  readonly name: string;
  readonly durationSeconds: number | null;
  readonly kind: 'video' | 'audio';
  readonly state: 'planned' | 'recorded' | 'imported';
  readonly previewAssetId: string | null;
  readonly timelineClip: TimelineClip | null;
  readonly asset: MediaAsset | null;
};

export function ProjectMediaPanel({
  assets,
  timelineClips,
  selectedTimelineClipId,
  pending,
  readOnly,
  busy,
  importAvailable,
  importing,
  onSelectTimelineClip,
  onRequestRecording,
  onImport,
  onInsert,
  onOverwrite,
  onClose,
}: ProjectMediaPanelProps) {
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<MediaStateFilter>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const items = useMemo(() => projectMediaItems(timelineClips, assets), [assets, timelineClips]);

  useEffect(() => {
    if (selectedTimelineClipId !== null) setSelectedKey(`clip:${selectedTimelineClipId}`);
  }, [selectedTimelineClipId]);
  useEffect(() => {
    if (selectedKey !== null && !items.some((item) => item.key === selectedKey)) setSelectedKey(null);
  }, [items, selectedKey]);

  const selected = items.find((item) => item.key === selectedKey) ?? null;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = useMemo(() => items.filter((item) => (
    (stateFilter === 'all' || item.state === stateFilter)
    && (normalizedQuery === '' || item.name.toLocaleLowerCase().includes(normalizedQuery))
  )), [items, normalizedQuery, stateFilter]);
  const timelineItems = filtered.filter((item) => item.timelineClip !== null);
  const importedItems = filtered.filter((item) => item.asset !== null);
  const selectedAsset = selected?.asset ?? null;
  const canEditSource = selectedAsset !== null
    && selectedAsset.duration_seconds !== null
    && selectedAsset.duration_seconds > 0
    && !readOnly
    && !busy;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!canEditSource || selectedAsset === null || isTextEditingTarget(event.target)) return;
      if (event.key === ',') {
        event.preventDefault();
        onInsert(selectedAsset);
      } else if (event.key === '.') {
        event.preventDefault();
        onOverwrite(selectedAsset);
      }
    };
    globalThis.addEventListener('keydown', handleKeyDown);
    return () => globalThis.removeEventListener('keydown', handleKeyDown);
  }, [canEditSource, onInsert, onOverwrite, selectedAsset]);

  return (
    <section
      className="grid min-h-0 min-w-0 grid-rows-[36px_auto_178px_minmax(0,1fr)] overflow-hidden border border-divider bg-bg"
      aria-label={t`项目素材`}
    >
      <header className="flex items-center gap-2 border-b border-divider px-2.5">
        <h2 className="text-sm font-semibold"><Trans>项目素材</Trans></h2>
        <span className="text-2xs tabular-nums text-neutral-500">{items.length}</span>
        <Button
          className="ml-auto"
          size="sm"
          variant="ghost"
          disabled={!importAvailable || importing}
          aria-label={t`导入项目素材`}
          onClick={onImport}
        >
          <FolderInput className="size-3.5" aria-hidden="true" />
          <Trans>导入</Trans>
        </Button>
        <button
          type="button"
          className="grid size-7 place-items-center text-neutral-500 hover:bg-neutral-100 hover:text-text"
          aria-label={t`隐藏项目素材`}
          onClick={onClose}
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
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

      <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_36px]">
        <SourceStillPreview item={selected} />
        <div className="border-t border-divider bg-bg p-1.5">
          {selected?.state === 'planned' && selected.timelineClip !== null ? (
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
          ) : selectedAsset === null ? (
            <p className="truncate px-0.5 py-1 text-2xs text-neutral-500">
              {selected?.state === 'recorded' ? t`该片段已录制并位于时间线中。` : t`选择导入素材可插入或覆盖。`}
            </p>
          ) : (
            <div className="flex items-center gap-1.5">
              <Button
                className="flex-1"
                size="sm"
                variant="secondary"
                disabled={!canEditSource}
                aria-label={t`在播放头插入 ${selectedAsset.name}`}
                onClick={() => onInsert(selectedAsset)}
              >
                <Trans>插入</Trans>
                <span className="text-2xs text-neutral-500">,</span>
              </Button>
              <Button
                className="flex-1"
                size="sm"
                variant="ghost"
                disabled={!canEditSource}
                aria-label={t`在播放头覆盖 ${selectedAsset.name}`}
                onClick={() => onOverwrite(selectedAsset)}
              >
                <Trans>覆盖</Trans>
                <span className="text-2xs text-neutral-500">.</span>
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="min-h-0 overflow-y-auto border-t border-divider" aria-live="polite">
        {pending ? <Skeleton className="m-2 h-24" /> : filtered.length > 0 ? (
          <div role="listbox" aria-label={t`项目素材列表`}>
            <MediaItemSection
              label={t`时间线片段`}
              items={timelineItems}
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
    </section>
  );
}

function MediaItemSection({
  label,
  items,
  selectedKey,
  onSelect,
}: {
  readonly label: string;
  readonly items: readonly ProjectMediaItem[];
  readonly selectedKey: string | null;
  readonly onSelect: (item: ProjectMediaItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label={label}>
      <header className="sticky top-0 z-10 flex h-6 items-center gap-1.5 border-b border-divider bg-neutral-50 px-2.5 text-2xs font-semibold uppercase tracking-wide text-neutral-500">
        <span>{label}</span>
        <span className="tabular-nums">{items.length}</span>
      </header>
      <div className="divide-y divide-divider">
        {items.map((item) => {
          const selected = item.key === selectedKey;
          const Icon = item.state === 'planned' ? CircleDashed : item.kind === 'audio' ? FileAudio2 : FileVideo2;
          return (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={selected}
              aria-label={t`选择素材 ${item.name}`}
              className={cn(
                'grid w-full grid-cols-[30px_minmax(0,1fr)] gap-2 px-2.5 py-2 text-left hover:bg-neutral-100',
                selected && 'bg-accent-100 ring-1 ring-inset ring-accent-300',
              )}
              onClick={() => onSelect(item)}
            >
              <span className="grid size-[30px] place-items-center border border-divider bg-neutral-50 text-neutral-500">
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-text">{item.name}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-2xs text-neutral-500">
                  <span className="tabular-nums">{formatDuration(item.durationSeconds)}</span>
                  <span className={stateTone(item.state)}>{stateLabel(item.state)}</span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function SourceStillPreview({ item }: { readonly item: ProjectMediaItem | null }) {
  const shell = useNativeShell();
  const [mountedAssetIds, setMountedAssetIds] = useState<readonly string[]>([]);
  const [displayedAssetId, setDisplayedAssetId] = useState<string | null>(null);
  const previewAssetId = item?.previewAssetId ?? null;

  useEffect(() => {
    if (previewAssetId === null) return;
    setMountedAssetIds((current) => current.includes(previewAssetId)
      ? current
      : [...current.slice(-2), previewAssetId]);
  }, [previewAssetId]);

  const selectedPreviewReady = previewAssetId !== null && displayedAssetId === previewAssetId;
  return (
    <div className="relative min-h-0 overflow-hidden bg-neutral-900" aria-label={t`源素材预览`}>
      {mountedAssetIds.map((assetId) => {
        const source = shell.mediaSrc(mediaAssetStreamPath(assetId));
        return (
          <video
            key={assetId}
            className={cn(
              'pointer-events-none absolute inset-0 size-full bg-neutral-900 object-contain transition-opacity',
              displayedAssetId === assetId ? 'opacity-100' : 'opacity-0',
            )}
            src={source ?? undefined}
            preload="auto"
            muted
            playsInline
            tabIndex={-1}
            aria-hidden="true"
            data-source-preview-asset-id={assetId}
            data-source-preview-visible={displayedAssetId === assetId ? 'true' : 'false'}
            onLoadedData={() => {
              if (previewAssetId === assetId) setDisplayedAssetId(assetId);
            }}
          />
        );
      })}
      {item === null ? (
        <div className="absolute inset-0 grid place-items-center bg-neutral-900 px-4 text-center text-xs text-neutral-400">
          <Trans>选择素材以预览源画面</Trans>
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
        <div className="absolute inset-0 grid place-items-center bg-neutral-900 text-neutral-300">
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
  );
}

function projectMediaItems(
  clips: readonly TimelineClip[],
  assets: readonly MediaAsset[],
): ProjectMediaItem[] {
  const referencedAssetIds = new Set<string>();
  const timelineItems = clips.map((clip): ProjectMediaItem => {
    const material = resolveTimelineMaterial(clip.material);
    if (material.streamAssetId !== null) referencedAssetIds.add(material.streamAssetId);
    return {
      key: `clip:${clip.id}`,
      name: clip.name,
      durationSeconds: clip.placement.duration,
      kind: 'video',
      state: material.state,
      previewAssetId: material.streamAssetId,
      timelineClip: clip,
      asset: null,
    };
  });
  const importedItems = assets
    .filter((asset) => !referencedAssetIds.has(asset.id))
    .map((asset): ProjectMediaItem => ({
      key: `asset:${asset.id}`,
      name: asset.name,
      durationSeconds: asset.duration_seconds,
      kind: mediaKind(asset),
      state: 'imported',
      previewAssetId: mediaKind(asset) === 'video' ? asset.id : null,
      timelineClip: null,
      asset,
    }));
  return [...timelineItems, ...importedItems];
}

function mediaKind(asset: MediaAsset): 'video' | 'audio' {
  return asset.kind.toLocaleLowerCase().includes('audio') ? 'audio' : 'video';
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return t`时长未知`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.max(0, seconds - minutes * 60);
  return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(3).padStart(6, '0')}`;
}

function stateLabel(state: ProjectMediaItem['state']): string {
  if (state === 'planned') return t`准备录制`;
  if (state === 'recorded') return t`已录制`;
  return t`导入`;
}

function stateTone(state: ProjectMediaItem['state']): string {
  if (state === 'planned') return 'text-warn';
  if (state === 'recorded') return 'text-ok';
  return 'text-accent-text';
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches('input, textarea, select, [role="textbox"]');
}
