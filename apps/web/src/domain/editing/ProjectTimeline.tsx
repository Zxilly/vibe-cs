import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  Bookmark,
  Camera,
  Clapperboard,
  Eye,
  Grid2X2,
  LayoutList,
  Link2,
  List,
  LockKeyhole,
  Settings2,
  SquarePlus,
  Star,
  Volume2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useAssetWaveform, useRecordedClipWaveform } from '../../data/mediaAssets';
import { mediaAssetStreamPath } from '../../data/mediaAssets';
import { useNativeShell } from '../../data/nativeShell';
import { ReviewPanel } from '../../design/review';
import {
  BASE_PIXELS_PER_SECOND,
  createTimeScale,
  formatMillisecondTimecode,
  rulerTicks,
  timeToPx,
} from '../../design/timeline/timeScale';
import { Waveform } from '../media';
import { cn } from '../../design/primitives';
import type {
  EditingDocument,
  EditorMarker,
  TimelineClip,
} from '../../shared/desktop/dto';
import { resolveTimelineMaterial } from './timelineMaterial';

export interface ProjectTimelineProps {
  readonly document: EditingDocument;
  readonly selectedClipId: string | null;
  readonly previewOffsetSeconds: number;
  readonly onSelectClip: (clipId: string) => void;
  readonly onInspectClip: (clipId: string) => void;
}

interface RenderedTrack {
  readonly id: string;
  readonly kind: 'video' | 'audio' | 'text';
  readonly label: string;
  readonly ariaLabel: string;
  readonly clips: readonly TimelineClip[];
  readonly controls: 'video' | 'audio' | 'none';
  readonly icon: React.ReactNode;
}

/**
 * Deep Timeline Module over the canonical Editing Document.
 *
 * It owns one time geometry for ruler, Timeline Placement, markers, events,
 * and playhead. It never creates a second editable timeline model.
 */
export function ProjectTimeline({
  document,
  selectedClipId,
  previewOffsetSeconds,
  onSelectClip,
  onInspectClip,
}: ProjectTimelineProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(1_000);
  const [zoomMultiplier, setZoomMultiplier] = useState(1);
  const story = document.tracks.find((track) => track.id === document.story_track_id) ?? null;
  const clips = story?.clips ?? [];
  const selectedClip = document.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === selectedClipId) ?? null;
  const playheadSeconds = Math.min(
    document.duration_seconds,
    Math.max(0, (selectedClip?.placement.start ?? 0) + previewOffsetSeconds),
  );
  const renderedTracks = useMemo(() => buildRenderedTracks(document), [document]);
  const recordedCount = clips.filter((clip) => resolveTimelineMaterial(clip.material).state === 'recorded').length;
  const plannedCount = clips.length - recordedCount;

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (element === null || typeof ResizeObserver === 'undefined') return undefined;
    const update = () => {
      const trackHead = Number.parseFloat(getComputedStyle(element).getPropertyValue('--w-track-head')) || 0;
      setViewportWidth(Math.max(1, element.clientWidth - trackHead));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fitZoom = viewportWidth / Math.max(document.duration_seconds, 1) / BASE_PIXELS_PER_SECOND;
  const scale = createTimeScale(fitZoom * zoomMultiplier);
  const contentWidth = Math.max(viewportWidth, timeToPx(scale, document.duration_seconds));
  const ticks = rulerTicks(scale, {
    toSeconds: document.duration_seconds,
    minMajorGapPx: 110,
    minMinorGapPx: 28,
  });
  const rowTemplate = [
    ...renderedTracks.map((track) => track.kind === 'video' ? '27fr' : '25fr'),
    '24fr',
    '24fr',
  ].join(' ');

  return (
    <ReviewPanel className="relative flex min-h-0 flex-col" aria-label={t`时间轴`}>
      <header className="flex h-[clamp(25px,2.9vh,28px)] flex-none items-center gap-3 border-b border-divider px-3">
        <h2 className="text-sm font-semibold"><Trans>时间轴（编辑预览）</Trans></h2>
        <span className="ml-auto flex items-center gap-2 text-neutral-500">
          <button
            type="button"
            className="grid size-[var(--h-ctl-sm)] place-items-center rounded-sm hover:bg-neutral-100"
            aria-label={t`缩小时间轴`}
            onClick={() => setZoomMultiplier((value) => Math.max(0.5, value / 1.25))}
          >
            <ZoomOut className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
          </button>
          <span className="h-1 w-12 rounded-full bg-neutral-200">
            <span className="block h-1 rounded-full bg-accent-500" style={{ width: `${Math.min(100, zoomMultiplier * 55)}%` }} />
          </span>
          <button
            type="button"
            className="grid size-[var(--h-ctl-sm)] place-items-center rounded-sm hover:bg-neutral-100"
            aria-label={t`放大时间轴`}
            onClick={() => setZoomMultiplier((value) => Math.min(4, value * 1.25))}
          >
            <ZoomIn className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button type="button" className="h-[var(--h-ctl-sm)] rounded-sm border border-divider px-2 text-2xs" onClick={() => setZoomMultiplier(1)}><Trans>适应</Trans></button>
        </span>
      </header>

      <div className="grid h-[clamp(25px,2.9vh,28px)] flex-none grid-cols-[var(--w-track-head)_minmax(0,1fr)] border-b border-divider font-mono text-2xs text-neutral-500">
        <span />
        <div className="relative min-w-0 overflow-hidden">
          <div className="relative h-full" style={{ width: contentWidth }}>
            {ticks.filter((tick) => tick.major).map((tick) => (
              <span key={tick.time} className="absolute inset-y-0 -translate-x-1/2 border-l border-divider px-1 py-1" style={{ left: tick.px }}>{tick.label}</span>
            ))}
          </div>
        </div>
      </div>

      <div ref={viewportRef} className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="grid h-full" style={{ minWidth: `calc(var(--w-track-head) + ${contentWidth}px)`, gridTemplateRows: rowTemplate }}>
          {renderedTracks.map((track) => (
            <TimelineTrackRow
              key={track.id}
              track={track}
              scale={scale}
              contentWidth={contentWidth}
              selectedClipId={selectedClipId}
              onSelectClip={onSelectClip}
              onInspectClip={onInspectClip}
            />
          ))}
          <TimelineMarkerRow markers={document.markers} scale={scale} contentWidth={contentWidth} ticks={ticks} />
          <TimelineEventRow clips={clips} scale={scale} contentWidth={contentWidth} ticks={ticks} />
        </div>
      </div>

      <footer className="flex h-[clamp(40px,5.2vh,50px)] flex-none items-center gap-5 border-t border-divider px-2 text-2xs text-neutral-600">
        <span><Trans>提案时长：</Trans><strong className="font-mono font-medium text-text">{formatMillisecondTimecode(document.duration_seconds)}</strong></span>
        <span className="flex items-center gap-1.5"><span className="size-2 bg-accent-400" /><Trans>已录制 {recordedCount}</Trans></span>
        <span className="flex items-center gap-1.5"><span className="size-2 bg-neutral-200" /><Trans>未录制 {plannedCount}</Trans></span>
        <span className="ml-auto flex items-center gap-2">
          <button type="button" className="flex h-[var(--h-ctl-sm)] items-center gap-1.5 rounded-sm border border-divider px-2"><LayoutList className="size-3.5" aria-hidden="true" /><Trans>阻塞显示</Trans></button>
          <TimelineFooterButton label={t`时间轴设置`}><Settings2 className="size-3.5" aria-hidden="true" /></TimelineFooterButton>
          <TimelineFooterButton label={t`网格视图`}><Grid2X2 className="size-3.5" aria-hidden="true" /></TimelineFooterButton>
          <TimelineFooterButton label={t`列表视图`}><List className="size-3.5" aria-hidden="true" /></TimelineFooterButton>
        </span>
      </footer>

      <div
        className="pointer-events-none absolute bottom-[clamp(40px,5.2vh,50px)] top-[clamp(25px,2.9vh,28px)] z-20 w-px bg-accent-600"
        style={{ left: `calc(var(--w-track-head) + ${timeToPx(scale, playheadSeconds)}px)` }}
        aria-hidden="true"
      >
        <span className="absolute left-1/2 top-1 -translate-x-1/2 whitespace-nowrap rounded-sm bg-accent-600 px-1.5 py-0.5 font-mono text-2xs text-bg">
          {formatMillisecondTimecode(playheadSeconds)}
        </span>
      </div>
    </ReviewPanel>
  );
}

function buildRenderedTracks(document: EditingDocument): RenderedTrack[] {
  const visible = [...document.tracks]
    .filter((track) => !track.hidden)
    .sort((left, right) => left.order - right.order);
  const rows: RenderedTrack[] = [];
  for (const track of visible) {
    if (track.id === document.story_track_id) {
      rows.push({ id: `${track.id}:video`, kind: 'video', label: t`视频轨道 1`, ariaLabel: track.name, clips: track.clips, controls: 'video', icon: <Camera className="size-4" /> });
      rows.push({ id: `${track.id}:audio`, kind: 'audio', label: t`音频轨道 1`, ariaLabel: t`${track.name} 音频`, clips: track.clips, controls: 'audio', icon: <SquarePlus className="size-4" /> });
      continue;
    }
    rows.push({
      id: track.id,
      kind: track.kind === 'audio' ? 'audio' : track.kind === 'text' ? 'text' : 'video',
      label: track.name,
      ariaLabel: track.name,
      clips: track.clips,
      controls: track.kind === 'audio' ? 'audio' : track.kind === 'text' ? 'none' : 'video',
      icon: track.kind === 'audio' ? <Volume2 className="size-4" /> : <Camera className="size-4" />,
    });
  }
  return rows;
}

function TimelineTrackRow({ track, scale, contentWidth, selectedClipId, onSelectClip, onInspectClip }: {
  readonly track: RenderedTrack;
  readonly scale: ReturnType<typeof createTimeScale>;
  readonly contentWidth: number;
  readonly selectedClipId: string | null;
  readonly onSelectClip: (clipId: string) => void;
  readonly onInspectClip: (clipId: string) => void;
}) {
  return (
    <div className="grid min-h-0 grid-cols-[var(--w-track-head)_minmax(0,1fr)] border-b border-divider" role="row" aria-label={track.ariaLabel}>
      <TimelineTrackHead icon={track.icon} label={track.label} controls={track.controls} />
      <div className="relative min-h-0 overflow-hidden" style={{ width: contentWidth }}>
        {track.clips.map((clip) => (
          <TimelineClipCell
            key={`${track.id}:${clip.id}`}
            clip={clip}
            kind={track.kind}
            selected={selectedClipId === clip.id}
            left={timeToPx(scale, clip.placement.start)}
            width={Math.max(2, timeToPx(scale, clip.placement.duration))}
            onSelect={() => onSelectClip(clip.id)}
            onInspect={() => onInspectClip(clip.id)}
          />
        ))}
      </div>
    </div>
  );
}

function TimelineClipCell({ clip, kind, selected, left, width, onSelect, onInspect }: {
  readonly clip: TimelineClip;
  readonly kind: RenderedTrack['kind'];
  readonly selected: boolean;
  readonly left: number;
  readonly width: number;
  readonly onSelect: () => void;
  readonly onInspect: () => void;
}) {
  const shell = useNativeShell();
  const material = resolveTimelineMaterial(clip.material);
  if (kind === 'audio') {
    return <div className="absolute inset-y-0 border-r border-divider" style={{ left, width }}><TimelineClipWaveform clip={clip} /></div>;
  }
  return (
    <button
      type="button"
      className={cn('absolute inset-y-0.5 overflow-hidden border-r border-divider bg-neutral-100 text-left outline-none', selected && 'ring-1 ring-inset ring-accent-500')}
      style={{ left, width }}
      onClick={onSelect}
      onDoubleClick={onInspect}
      aria-label={`${clip.name} ${clip.placement.duration.toFixed(1)}s · ${material.state === 'planned' ? t`未录制` : t`已录制`}`}
    >
      {kind === 'text' ? <span className="grid size-full place-items-center text-2xs">{clip.name}</span> : material.streamAssetId === null ? (
        <span className="grid size-full place-items-center text-2xs text-neutral-500"><Trans>待录制</Trans></span>
      ) : (
        <>
          <video className="pointer-events-none size-full bg-neutral-900 object-cover" src={shell.mediaSrc(mediaAssetStreamPath(material.streamAssetId)) ?? undefined} preload="metadata" muted tabIndex={-1} aria-hidden="true" />
          <Clapperboard className="absolute left-1 top-1 size-3 rounded-sm border border-neutral-700 bg-neutral-900/75 p-px text-bg" aria-hidden="true" />
          <Link2 className="absolute right-1 top-1 size-3 rounded-sm border border-neutral-700 bg-neutral-900/75 p-px text-bg" aria-hidden="true" />
        </>
      )}
      <span className="absolute inset-x-0 bottom-0 truncate bg-neutral-900/80 px-1 py-px text-2xs text-bg">{clip.name}</span>
    </button>
  );
}

function TimelineClipWaveform({ clip }: { readonly clip: TimelineClip }) {
  const locator = resolveTimelineMaterial(clip.material).waveform;
  const asset = useAssetWaveform(locator?.kind === 'asset' ? locator.id : null, 120);
  const take = useRecordedClipWaveform(locator?.kind === 'take' ? locator.id : null, 120);
  if (locator === null) return <div className="size-full bg-neutral-100" />;
  const query = locator.kind === 'asset' ? asset : take;
  return (
    <Waveform
      peaks={query.data?.waveform ?? []}
      durationSeconds={clip.placement.duration}
      loading={query.isPending}
      symmetric
      className="!h-full !min-h-0 !rounded-none !border-0 bg-accent-100 [&_.blueprint]:border-0 [&_svg_path:first-child]:fill-accent-400 [&_svg_path:nth-child(2)]:stroke-accent-600"
    />
  );
}

function TimelineTrackHead({ icon, label, controls }: { readonly icon: React.ReactNode; readonly label: string; readonly controls: RenderedTrack['controls'] }) {
  return (
    <div className="flex min-w-0 items-center gap-3 border-r border-divider px-3 text-xs font-medium">
      <span className="text-neutral-600">{icon}</span><span className="truncate">{label}</span>
      {controls === 'none' ? null : <span className="ml-auto flex items-center gap-2 text-neutral-500">{controls === 'audio' ? <Volume2 className="size-3.5" aria-hidden="true" /> : <Eye className="size-3.5" aria-hidden="true" />}<LockKeyhole className="size-3.5" aria-hidden="true" /></span>}
    </div>
  );
}

function TimelineMarkerRow({ markers, scale, contentWidth, ticks }: { readonly markers: readonly EditorMarker[]; readonly scale: ReturnType<typeof createTimeScale>; readonly contentWidth: number; readonly ticks: ReturnType<typeof rulerTicks> }) {
  return (
    <div className="grid min-h-0 grid-cols-[var(--w-track-head)_minmax(0,1fr)] border-b border-divider" role="row" aria-label={t`标记`}>
      <TimelineTrackHead icon={<Bookmark className="size-4" />} label={t`标记`} controls="none" />
      <div className="relative min-h-0" style={{ width: contentWidth }}><TimelineGrid ticks={ticks} />{markers.map((marker) => <span key={marker.id} className="absolute inset-y-1 flex items-center gap-1.5 text-2xs text-neutral-700" style={{ left: timeToPx(scale, marker.time) }}><span className="h-full w-1.5" style={{ backgroundColor: marker.color }} aria-hidden="true" /><span className="whitespace-nowrap">{marker.label}</span></span>)}</div>
    </div>
  );
}

function TimelineEventRow({ clips, scale, contentWidth, ticks }: { readonly clips: readonly TimelineClip[]; readonly scale: ReturnType<typeof createTimeScale>; readonly contentWidth: number; readonly ticks: ReturnType<typeof rulerTicks> }) {
  return (
    <div className="grid min-h-0 grid-cols-[var(--w-track-head)_minmax(0,1fr)] border-b border-divider" role="row" aria-label={t`事件`}>
      <TimelineTrackHead icon={<Star className="size-4" />} label={t`事件`} controls="none" />
      <div className="relative min-h-0" style={{ width: contentWidth }}><TimelineGrid ticks={ticks} />{clips.map((clip) => <span key={`event:${clip.id}`} className="absolute inset-y-0 flex items-center gap-1.5 text-2xs text-neutral-700" style={{ left: timeToPx(scale, clip.placement.start) }}><span className="h-3 w-1.5 bg-ok" aria-hidden="true" /><span>{clip.name.split(' · ')[0]}</span></span>)}</div>
    </div>
  );
}

function TimelineGrid({ ticks }: { readonly ticks: ReturnType<typeof rulerTicks> }) {
  return <>{ticks.filter((tick) => tick.major).map((tick) => <span key={`grid:${tick.time}`} className="pointer-events-none absolute inset-y-0 border-l border-divider" style={{ left: tick.px }} aria-hidden="true" />)}</>;
}

function TimelineFooterButton({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return <button type="button" className="grid size-[var(--h-ctl-sm)] place-items-center rounded-sm border border-divider" aria-label={label}>{children}</button>;
}
