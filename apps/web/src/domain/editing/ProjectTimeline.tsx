import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  Bookmark,
  Camera,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Eye,
  Grid2X2,
  LayoutList,
  Link2,
  List,
  LockKeyhole,
  MoveRight,
  MousePointer2,
  Settings2,
  SquarePlus,
  Star,
  Scissors,
  Trash2,
  Undo2,
  Volume2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useAssetWaveform, useRecordedClipWaveform } from '../../data/mediaAssets';
import { mediaAssetStreamPath } from '../../data/mediaAssets';
import { useNativeShell } from '../../data/nativeShell';
import { ReviewPanel } from '../../design/review';
import {
  BASE_PIXELS_PER_SECOND,
  createTimeScale,
  formatMillisecondTimecode,
  pxToTime,
  rulerTicks,
  timeToPx,
} from '../../design/timeline/timeScale';
import { Waveform } from '../media';
import { cn } from '../../design/primitives';
import type {
  EditingDocument,
  EditorMarker,
  ProjectChangeGroup,
  TimelineClip,
  TimelineTrack,
} from '../../shared/desktop/dto';
import {
  hasTimelineDelta,
  projectStoryTimelineChanges,
  type TimelineClipChange,
} from './timelineChangeProjection';
import { resolveTimelineMaterial } from './timelineMaterial';
import { deleteRippleClip, moveRippleClip, splitRippleClip, trimRippleClip } from './timelineEditing';
import {
  clipMediaDuration,
  moveTimelineClip,
  snapTimeToFrame,
  trimTimelineClip,
} from './timelineInteraction';

export interface ProjectTimelineProps {
  readonly document: EditingDocument;
  readonly selectedClipId: string | null;
  readonly timelineTimeSeconds: number;
  readonly reviewGroup: ProjectChangeGroup | null;
  readonly readOnly: boolean;
  readonly onSelectClip: (clipId: string) => void;
  readonly onInspectClip: (clipId: string) => void;
  readonly onSeek: (seconds: number) => void;
  readonly onTogglePlayback: () => void;
  readonly onReplaceClip: (clip: TimelineClip) => void;
  readonly onReplaceTrack: (track: TimelineTrack) => void;
  readonly onReplaceTrackClips: (trackId: string, clips: readonly TimelineClip[]) => void;
  readonly onRemoveClip: (clipId: string) => void;
  readonly canUndo: boolean;
  readonly onUndo: () => void;
}

interface RenderedTrack {
  readonly id: string;
  readonly kind: 'video' | 'audio' | 'text';
  readonly label: string;
  readonly ariaLabel: string;
  readonly clips: readonly TimelineClip[];
  readonly controls: 'video' | 'audio' | 'none';
  readonly icon: React.ReactNode;
  readonly track: TimelineTrack;
  readonly derivedAudio: boolean;
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
  timelineTimeSeconds,
  reviewGroup,
  readOnly,
  onSelectClip,
  onInspectClip,
  onSeek,
  onTogglePlayback,
  onReplaceClip,
  onReplaceTrack,
  onReplaceTrackClips,
  onRemoveClip,
  canUndo,
  onUndo,
}: ProjectTimelineProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(1_000);
  const [zoomMultiplier, setZoomMultiplier] = useState(1);
  const [changeFilter, setChangeFilter] = useState<'all' | 'selected'>('all');
  const [scrollLeft, setScrollLeft] = useState(0);
  const seekFrameRef = useRef<number | null>(null);
  const queuedSeekRef = useRef<number | null>(null);
  const story = document.tracks.find((track) => track.id === document.story_track_id) ?? null;
  const clips = story?.clips ?? [];
  const selectedClip = document.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === selectedClipId) ?? null;
  const selectedTrack = document.tracks.find((track) => track.clips.some((clip) => clip.id === selectedClipId)) ?? null;
  const playheadSeconds = Math.min(
    document.duration_seconds,
    Math.max(0, timelineTimeSeconds),
  );
  const renderedTracks = useMemo(() => buildRenderedTracks(document), [document]);
  const recordedCount = clips.filter((clip) => resolveTimelineMaterial(clip.material).state === 'recorded').length;
  const plannedCount = clips.length - recordedCount;
  const changeProjection = useMemo(
    () => projectStoryTimelineChanges(clips, document.story_track_id, reviewGroup),
    [clips, document.story_track_id, reviewGroup],
  );
  const directChanges = useMemo(
    () => changeProjection.changes.filter((change) => !change.rippleOnly),
    [changeProjection.changes],
  );
  const selectedChange = directChanges.find((change) => change.clipId === selectedClipId) ?? null;
  const displayedChanges = changeFilter === 'selected'
    ? selectedChange === null ? [] : [selectedChange]
    : directChanges;
  const changeByClipId = useMemo(
    () => new Map(displayedChanges
      .filter((change) => change.current !== null)
      .map((change) => [change.clipId, change] as const)),
    [displayedChanges],
  );
  const ghostChanges = displayedChanges.filter((change) => change.kind === 'removed'
    || (change.kind === 'modified' && (hasTimelineDelta(change.startDelta) || change.durationDelta < 0)));
  const rippleChange = changeProjection.changes.find((change) => change.rippleOnly) ?? null;
  const reviewChangeCount = Math.max(changeProjection.operationCount, directChanges.length);

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
    ...renderedTracks.map((track) => track.kind === 'video' ? '30fr' : '27fr'),
    '20fr',
    '20fr',
  ].join(' ');
  const canSplit = !readOnly
    && selectedClip !== null
    && selectedTrack?.id === document.story_track_id
    && playheadSeconds > selectedClip.placement.start + 1 / document.fps
    && playheadSeconds < selectedClip.placement.start + selectedClip.placement.duration - 1 / document.fps;
  const canDelete = !readOnly && selectedClip !== null;

  const selectAdjacentChange = (direction: -1 | 1) => {
    if (directChanges.length === 0) return;
    const index = directChanges.findIndex((change) => change.clipId === selectedClipId);
    const nextIndex = index < 0
      ? direction > 0 ? 0 : directChanges.length - 1
      : (index + direction + directChanges.length) % directChanges.length;
    const next = directChanges[nextIndex];
    if (next?.current === null || next === undefined) return;
    onSelectClip(next.current.id);
    onSeek(next.current.placement.start);
  };

  const splitSelected = () => {
    if (!canSplit || selectedClip === null || selectedTrack === null) return;
    const clips = splitRippleClip(
      selectedTrack.clips,
      selectedClip.id,
      playheadSeconds,
      globalThis.crypto.randomUUID(),
    );
    onReplaceTrackClips(selectedTrack.id, clips);
  };

  const deleteSelected = () => {
    if (!canDelete || selectedClip === null || selectedTrack === null) return;
    const index = selectedTrack.clips.findIndex((clip) => clip.id === selectedClip.id);
    const nextSelection = selectedTrack.clips[index + 1] ?? selectedTrack.clips[index - 1] ?? null;
    if (selectedTrack.id === document.story_track_id) {
      onReplaceTrackClips(selectedTrack.id, deleteRippleClip(selectedTrack.clips, selectedClip.id));
    } else {
      onRemoveClip(selectedClip.id);
    }
    if (nextSelection !== null) onSelectClip(nextSelection.id);
  };

  useEffect(() => () => {
    if (seekFrameRef.current !== null) cancelAnimationFrame(seekFrameRef.current);
  }, []);

  const pointerTime = (event: React.PointerEvent<HTMLElement>) => {
    const viewport = viewportRef.current;
    if (viewport === null) return null;
    const bounds = viewport.getBoundingClientRect();
    const trackHead = Number.parseFloat(getComputedStyle(viewport).getPropertyValue('--w-track-head')) || 0;
    const contentX = event.clientX - bounds.left - trackHead + viewport.scrollLeft;
    return Math.min(document.duration_seconds, snapTimeToFrame(pxToTime(scale, contentX), document.fps));
  };

  const seekFromPointer = (event: React.PointerEvent<HTMLElement>) => {
    const time = pointerTime(event);
    if (time !== null) onSeek(time);
  };

  const queueSeekFromPointer = (event: React.PointerEvent<HTMLElement>) => {
    const time = pointerTime(event);
    if (time === null) return;
    queuedSeekRef.current = time;
    if (seekFrameRef.current !== null) return;
    seekFrameRef.current = requestAnimationFrame(() => {
      seekFrameRef.current = null;
      const queued = queuedSeekRef.current;
      queuedSeekRef.current = null;
      if (queued !== null) onSeek(queued);
    });
  };

  return (
    <ReviewPanel
      className="relative flex min-h-0 select-none flex-col"
      aria-label={t`时间轴`}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
        if (event.key === ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          onTogglePlayback();
          return;
        }
        if (event.key.toLowerCase() === 's' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          splitSelected();
          return;
        }
        if ((event.key === 'Delete' || event.key === 'Backspace') && canDelete) {
          event.preventDefault();
          deleteSelected();
          return;
        }
        if (event.key.toLowerCase() === 'z' && (event.ctrlKey || event.metaKey) && canUndo && !readOnly) {
          event.preventDefault();
          onUndo();
        }
      }}
    >
      <header className="flex h-[var(--h-panel-head)] flex-none items-center gap-3 border-b border-divider px-3">
        <h2 className="text-base font-semibold"><Trans>时间轴（变更审阅）</Trans></h2>
        {reviewChangeCount === 0 ? null : (
          <>
            <span className="text-xs text-neutral-500"><Trans>{reviewChangeCount} 处变更</Trans></span>
            <span className="flex items-center overflow-hidden rounded-sm border border-divider">
              <button type="button" className="grid size-7 place-items-center hover:bg-neutral-100" aria-label={t`上一个变更`} onClick={() => selectAdjacentChange(-1)}><ChevronLeft className="size-3.5" aria-hidden="true" /></button>
              <button type="button" className="grid size-7 place-items-center border-l border-divider hover:bg-neutral-100" aria-label={t`下一个变更`} onClick={() => selectAdjacentChange(1)}><ChevronRight className="size-3.5" aria-hidden="true" /></button>
            </span>
            <select
              aria-label={t`变更筛选`}
              className="h-7 rounded-sm border border-divider bg-bg px-2 text-2xs"
              value={changeFilter}
              onChange={(event) => setChangeFilter(event.currentTarget.value as 'all' | 'selected')}
            >
              <option value="all"><Trans>全部变更</Trans></option>
              <option value="selected" disabled={selectedChange === null}><Trans>所选变更</Trans></option>
            </select>
          </>
        )}
        <span className="ml-auto flex items-center gap-2 text-neutral-500">
          <button
            type="button"
            className="grid size-[var(--h-ctl-sm)] place-items-center rounded-sm hover:bg-neutral-100"
            aria-label={t`缩小时间轴`}
            onClick={() => setZoomMultiplier((value) => Math.max(0.5, value / 1.25))}
          >
            <ZoomOut className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
          </button>
          <input
            type="range"
            aria-label={t`时间轴缩放`}
            min="0.5"
            max="4"
            step="0.25"
            value={zoomMultiplier}
            className="timeline-zoom w-14"
            onChange={(event) => setZoomMultiplier(Number(event.currentTarget.value))}
          />
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

      <TimelineToolStrip
        canSplit={canSplit}
        canDelete={canDelete}
        canUndo={canUndo && !readOnly}
        onSplit={splitSelected}
        onDelete={deleteSelected}
        onUndo={onUndo}
      />

      <div className="grid h-8 flex-none grid-cols-[var(--w-track-head)_minmax(0,1fr)] border-b border-divider font-mono text-2xs text-neutral-500">
        <span />
        <div
          className="relative min-w-0 cursor-col-resize overflow-hidden"
          onPointerDown={(event) => {
            if (event.button === 0 && !(event.target instanceof Element && event.target.closest('button'))) {
              event.preventDefault();
              seekFromPointer(event);
            }
          }}
        >
          <div className="relative h-full" style={{ width: contentWidth, transform: `translateX(${-scrollLeft}px)` }}>
            {ticks.filter((tick) => tick.major).map((tick) => (
              <span key={tick.time} className="absolute inset-y-0 -translate-x-1/2 border-l border-divider px-1 py-1" style={{ left: tick.px }}>{tick.label}</span>
            ))}
          </div>
        </div>
      </div>

      <TimelineReviewLane
        changes={displayedChanges}
        selectedChange={selectedChange}
        rippleChange={rippleChange}
        scale={scale}
        contentWidth={contentWidth}
        scrollLeft={scrollLeft}
        onSelectChange={(change) => {
          if (change.current === null) return;
          onSelectClip(change.current.id);
          onSeek(change.current.placement.start);
        }}
        onUndo={onUndo}
        canUndo={canUndo && !readOnly}
      />

      <div
        ref={viewportRef}
        className={cn(
          'min-h-0 flex-1 overflow-y-hidden',
          contentWidth <= viewportWidth + 0.5 ? 'overflow-x-hidden' : 'overflow-x-auto',
        )}
        role="region"
        aria-label={t`时间轴内容`}
        onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
        onPointerDown={(event) => {
          if (event.button === 0 && event.target === event.currentTarget) {
            event.preventDefault();
            seekFromPointer(event);
          }
        }}
      >
        <div
          className="grid h-full"
          style={{ minWidth: `calc(var(--w-track-head) + ${contentWidth}px)`, gridTemplateRows: rowTemplate }}
          onPointerDown={(event) => {
            if (event.button === 0 && !(event.target instanceof Element && event.target.closest('button'))) {
              event.preventDefault();
              seekFromPointer(event);
            }
          }}
        >
          {renderedTracks.map((track) => (
            <TimelineTrackRow
              key={track.id}
              track={track}
              scale={scale}
              contentWidth={contentWidth}
              selectedClipId={selectedClipId}
              fps={document.fps}
              readOnly={readOnly}
              onSelectClip={onSelectClip}
              onInspectClip={onInspectClip}
              onReplaceClip={onReplaceClip}
              onReplaceTrack={onReplaceTrack}
              onReplaceTrackClips={onReplaceTrackClips}
              storyTrackId={document.story_track_id}
              changeByClipId={changeByClipId}
              ghostChanges={ghostChanges}
            />
          ))}
          <TimelineMarkerRow markers={document.markers} scale={scale} contentWidth={contentWidth} ticks={ticks} />
          <TimelineEventRow clips={clips} scale={scale} contentWidth={contentWidth} ticks={ticks} />
        </div>
      </div>

      <footer className="flex h-14 flex-none items-center gap-5 border-t border-divider px-2 text-2xs text-neutral-600">
        <span><Trans>提案时长：</Trans><strong className="font-mono font-medium text-text">{formatMillisecondTimecode(document.duration_seconds)}</strong></span>
        {changeProjection.previousDuration !== null && changeProjection.previousDuration > 0 && hasTimelineDelta(changeProjection.currentDuration - changeProjection.previousDuration) ? (
          <span className="text-neutral-500"><Trans>原</Trans> <span className="font-mono">{formatMillisecondTimecode(changeProjection.previousDuration)}</span></span>
        ) : null}
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
        className="absolute bottom-14 top-[var(--h-panel-head)] z-20 w-px bg-accent-600"
        style={{ left: `calc(var(--w-track-head) + ${timeToPx(scale, playheadSeconds) - scrollLeft}px)` }}
      >
        <span className="absolute left-1/2 top-1 -translate-x-1/2 whitespace-nowrap rounded-sm bg-accent-600 px-1.5 py-0.5 font-mono text-2xs text-bg">
          {formatMillisecondTimecode(playheadSeconds)}
        </span>
        <button
          type="button"
          role="slider"
          aria-label={t`时间轴播放头`}
          aria-valuemin={0}
          aria-valuemax={document.duration_seconds}
          aria-valuenow={playheadSeconds}
          aria-valuetext={formatMillisecondTimecode(playheadSeconds)}
          className="absolute -left-2 top-0 h-full w-4 touch-none select-none cursor-col-resize bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            seekFromPointer(event);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
              event.preventDefault();
              queueSeekFromPointer(event);
            }
          }}
          onPointerUp={(event) => {
            event.preventDefault();
            queuedSeekRef.current = null;
            if (seekFrameRef.current !== null) {
              cancelAnimationFrame(seekFrameRef.current);
              seekFrameRef.current = null;
            }
            seekFromPointer(event);
            event.currentTarget.releasePointerCapture?.(event.pointerId);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const direction = event.key === 'ArrowRight' ? 1 : -1;
            const step = event.shiftKey ? 1 : 1 / document.fps;
            onSeek(Math.min(document.duration_seconds, Math.max(0, playheadSeconds + direction * step)));
          }}
        />
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
      rows.push({ id: `${track.id}:video`, kind: 'video', label: t`视频轨道 1`, ariaLabel: track.name, clips: track.clips, controls: 'video', icon: <Camera className="size-4" />, track, derivedAudio: false });
      rows.push({ id: `${track.id}:audio`, kind: 'audio', label: t`音频轨道 1`, ariaLabel: t`${track.name} 音频`, clips: track.clips, controls: 'audio', icon: <SquarePlus className="size-4" />, track, derivedAudio: true });
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
      track,
      derivedAudio: false,
    });
  }
  return rows;
}

const TimelineTrackRow = memo(function TimelineTrackRow({ track, scale, contentWidth, selectedClipId, fps, readOnly, onSelectClip, onInspectClip, onReplaceClip, onReplaceTrack, onReplaceTrackClips, storyTrackId, changeByClipId, ghostChanges }: {
  readonly track: RenderedTrack;
  readonly scale: ReturnType<typeof createTimeScale>;
  readonly contentWidth: number;
  readonly selectedClipId: string | null;
  readonly fps: number;
  readonly readOnly: boolean;
  readonly onSelectClip: (clipId: string) => void;
  readonly onInspectClip: (clipId: string) => void;
  readonly onReplaceClip: (clip: TimelineClip) => void;
  readonly onReplaceTrack: (track: TimelineTrack) => void;
  readonly onReplaceTrackClips: (trackId: string, clips: readonly TimelineClip[]) => void;
  readonly storyTrackId: string;
  readonly changeByClipId: ReadonlyMap<string, TimelineClipChange>;
  readonly ghostChanges: readonly TimelineClipChange[];
}) {
  return (
    <div className="grid min-h-0 grid-cols-[var(--w-track-head)_minmax(0,1fr)] border-b border-divider" role="row" aria-label={track.ariaLabel}>
      <TimelineTrackHead
        icon={track.icon}
        label={track.label}
        controls={track.controls}
        track={track.track}
        readOnly={readOnly}
        onReplaceTrack={onReplaceTrack}
      />
      <div className="relative min-h-0 overflow-hidden" style={{ width: contentWidth }}>
        {track.track.id === storyTrackId ? (
          <TimelineChangeGhosts
            changes={ghostChanges}
            scale={scale}
            audio={track.kind === 'audio'}
          />
        ) : null}
        {track.clips.map((clip) => (
          <TimelineClipCell
            key={`${track.id}:${clip.id}`}
            clip={clip}
            kind={track.kind}
            selected={selectedClipId === clip.id}
            scale={scale}
            fps={fps}
            readOnly={readOnly || track.track.locked || track.derivedAudio}
            change={changeByClipId.get(clip.id) ?? null}
            onSelect={() => onSelectClip(clip.id)}
            onInspect={() => onInspectClip(clip.id)}
            onReplace={(replacement, mode) => {
              if (track.track.id !== storyTrackId) {
                onReplaceClip(replacement);
                return;
              }
              const clips = mode === 'move'
                ? moveRippleClip(track.track.clips, replacement.id, replacement.placement.start)
                : trimRippleClip(track.track.clips, replacement);
              onReplaceTrackClips(track.track.id, clips);
            }}
          />
        ))}
      </div>
    </div>
  );
}, (previous, next) => previous.track === next.track
  && previous.scale.pixelsPerSecond === next.scale.pixelsPerSecond
  && previous.contentWidth === next.contentWidth
  && previous.selectedClipId === next.selectedClipId
  && previous.fps === next.fps
  && previous.readOnly === next.readOnly
  && previous.storyTrackId === next.storyTrackId
  && previous.changeByClipId === next.changeByClipId
  && previous.ghostChanges === next.ghostChanges);

const TimelineClipCell = memo(function TimelineClipCell({ clip, kind, selected, scale, fps, readOnly, change, onSelect, onInspect, onReplace }: {
  readonly clip: TimelineClip;
  readonly kind: RenderedTrack['kind'];
  readonly selected: boolean;
  readonly scale: ReturnType<typeof createTimeScale>;
  readonly fps: number;
  readonly readOnly: boolean;
  readonly change: TimelineClipChange | null;
  readonly onSelect: () => void;
  readonly onInspect: () => void;
  readonly onReplace: (clip: TimelineClip, mode: 'move' | 'start' | 'end') => void;
}) {
  const shell = useNativeShell();
  const material = resolveTimelineMaterial(clip.material);
  const [visualClip, setVisualClip] = useState(clip);
  const gesture = useRef<{
    readonly pointerId: number;
    readonly clientX: number;
    readonly mode: 'move' | 'start' | 'end';
    readonly clip: TimelineClip;
  } | null>(null);
  useEffect(() => setVisualClip(clip), [clip]);
  if (kind === 'audio') {
    return (
      <div
        className={cn(
          'absolute inset-y-0 z-10 border-r border-divider',
          change?.kind === 'added' && 'border-ok-border bg-ok-surface',
          change?.kind === 'modified' && 'border-accent-400 bg-accent-100',
        )}
        style={{
          left: timeToPx(scale, clip.placement.start),
          width: Math.max(2, timeToPx(scale, clip.placement.duration)),
        }}
      >
        <TimelineClipWaveform clip={clip} change={change} />
        {change === null ? null : <TimelineClipChangeOverlay change={change} clip={clip} scale={scale} compact />}
      </div>
    );
  }
  const visualLeft = timeToPx(scale, visualClip.placement.start);
  const visualWidth = Math.max(2, timeToPx(scale, visualClip.placement.duration));
  const beginGesture = (event: React.PointerEvent<HTMLElement>, mode: 'move' | 'start' | 'end') => {
    if (readOnly || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    gesture.current = { pointerId: event.pointerId, clientX: event.clientX, mode, clip };
    onSelect();
  };
  const updateGesture = (event: React.PointerEvent<HTMLElement>) => {
    const active = gesture.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    const deltaSeconds = pxToTime(scale, event.clientX - active.clientX);
    const next = active.mode === 'move'
      ? moveTimelineClip(active.clip, active.clip.placement.start + deltaSeconds, fps)
      : trimTimelineClip(
        active.clip,
        active.mode,
        active.mode === 'start'
          ? active.clip.placement.start + deltaSeconds
          : active.clip.placement.start + active.clip.placement.duration + deltaSeconds,
        fps,
        clipMediaDuration(active.clip),
      );
    setVisualClip(next);
  };
  const finishGesture = (event: React.PointerEvent<HTMLElement>) => {
    const active = gesture.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    gesture.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (JSON.stringify(visualClip.placement) !== JSON.stringify(clip.placement)) {
      onReplace(visualClip, active.mode);
    }
  };
  return (
    <button
      type="button"
      className={cn(
        'absolute inset-y-0.5 z-10 touch-none select-none overflow-hidden border border-divider bg-neutral-100 text-left outline-none',
        change?.kind === 'added' && 'border-ok-border bg-ok-surface',
        change?.kind === 'modified' && 'border-accent-400 bg-accent-100',
        selected && 'ring-1 ring-inset ring-accent-600',
      )}
      style={{ left: visualLeft, width: visualWidth }}
      aria-disabled={readOnly}
      onClick={onSelect}
      onDoubleClick={onInspect}
      onPointerDown={(event) => beginGesture(event, 'move')}
      onPointerMove={updateGesture}
      onPointerUp={finishGesture}
      onPointerCancel={() => { gesture.current = null; setVisualClip(clip); }}
      onKeyDown={(event) => {
        if (readOnly || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
        event.preventDefault();
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        onReplace(
          moveTimelineClip(clip, clip.placement.start + direction * (event.shiftKey ? 1 : 1 / fps), fps),
          'move',
        );
      }}
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
      {change === null ? null : <TimelineClipChangeOverlay change={change} clip={visualClip} scale={scale} />}
      <span className="absolute inset-x-0 bottom-0 truncate bg-neutral-900/80 px-1 py-px text-2xs text-bg">{clip.name}</span>
      {selected && !readOnly ? (
        <>
          <span
            role="separator"
            aria-label={t`裁切片段起点`}
            className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize border-l-2 border-accent-500 bg-accent-100/20"
            onPointerDown={(event) => beginGesture(event, 'start')}
            onPointerMove={updateGesture}
            onPointerUp={finishGesture}
          />
          <span
            role="separator"
            aria-label={t`裁切片段终点`}
            className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize border-r-2 border-accent-500 bg-accent-100/20"
            onPointerDown={(event) => beginGesture(event, 'end')}
            onPointerMove={updateGesture}
            onPointerUp={finishGesture}
          />
        </>
      ) : null}
    </button>
  );
}, (previous, next) => previous.clip === next.clip
  && previous.kind === next.kind
  && previous.selected === next.selected
  && previous.scale.pixelsPerSecond === next.scale.pixelsPerSecond
  && previous.fps === next.fps
  && previous.readOnly === next.readOnly
  && previous.change === next.change);

function TimelineToolStrip({
  canSplit,
  canDelete,
  canUndo,
  onSplit,
  onDelete,
  onUndo,
}: {
  readonly canSplit: boolean;
  readonly canDelete: boolean;
  readonly canUndo: boolean;
  readonly onSplit: () => void;
  readonly onDelete: () => void;
  readonly onUndo: () => void;
}) {
  const tools = [
    { label: t`选择工具`, icon: <MousePointer2 className="size-4" aria-hidden="true" />, enabled: true, pressed: true, action: undefined },
    { label: t`在播放头切分片段`, icon: <Scissors className="size-4" aria-hidden="true" />, enabled: canSplit, pressed: false, action: onSplit },
    { label: t`删除所选片段并闭合间隙`, icon: <Trash2 className="size-4" aria-hidden="true" />, enabled: canDelete, pressed: false, action: onDelete },
    { label: t`撤销上一次剪辑`, icon: <Undo2 className="size-4" aria-hidden="true" />, enabled: canUndo, pressed: false, action: onUndo },
  ] as const;
  return (
    <aside className="absolute bottom-14 left-0 top-[var(--h-panel-head)] z-50 flex w-10 flex-col items-center gap-1 border-r border-divider bg-bg pt-1" aria-label={t`时间轴工具`}>
      {tools.map((tool) => (
        <button
          key={tool.label}
          type="button"
          className={cn(
            'grid size-8 place-items-center rounded-sm text-neutral-600 hover:bg-neutral-100 hover:text-text disabled:text-neutral-300',
            tool.pressed && 'bg-accent-100 text-accent-text',
          )}
          aria-label={tool.label}
          aria-pressed={tool.pressed}
          disabled={!tool.enabled}
          onClick={tool.action}
        >
          {tool.icon}
        </button>
      ))}
    </aside>
  );
}

function TimelineReviewLane({
  changes,
  selectedChange,
  rippleChange,
  scale,
  contentWidth,
  scrollLeft,
  onSelectChange,
  onUndo,
  canUndo,
}: {
  readonly changes: readonly TimelineClipChange[];
  readonly selectedChange: TimelineClipChange | null;
  readonly rippleChange: TimelineClipChange | null;
  readonly scale: ReturnType<typeof createTimeScale>;
  readonly contentWidth: number;
  readonly scrollLeft: number;
  readonly onSelectChange: (change: TimelineClipChange) => void;
  readonly onUndo: () => void;
  readonly canUndo: boolean;
}) {
  const selectedStart = selectedChange?.current?.placement.start
    ?? selectedChange?.previous?.placement.start
    ?? 0;
  const popoverLeft = Math.max(4, Math.min(timeToPx(scale, selectedStart), contentWidth - 260));
  return (
    <div className="grid h-16 flex-none grid-cols-[var(--w-track-head)_minmax(0,1fr)] border-b border-divider bg-neutral-100/60">
      <div className="flex items-center gap-2 border-r border-divider py-2 pl-12 pr-3 text-2xs font-medium text-neutral-600">
        <span className="rounded-sm border border-accent-200 bg-accent-100 px-1 font-mono text-accent-text">Δ</span>
        <Trans>变更注释</Trans>
      </div>
      <div className="relative min-w-0 overflow-hidden">
        <div
          className="relative h-full"
          style={{ width: contentWidth, transform: `translateX(${-scrollLeft}px)` }}
        >
          {changes.map((change) => {
            if (change.rippleOnly || change === selectedChange) return null;
            const start = change.current?.placement.start ?? change.previous?.placement.start ?? 0;
            return (
              <button
                key={`change-pin:${change.clipId}`}
                type="button"
                className={cn(
                  'absolute top-2 grid h-6 min-w-6 place-items-center rounded-sm border px-1 font-mono text-2xs font-semibold',
                  change.kind === 'removed'
                    ? 'border-fail-border bg-fail-surface text-fail-text'
                    : change.kind === 'added'
                      ? 'border-ok-border bg-ok-surface text-ok'
                      : 'border-accent-300 bg-accent-100 text-accent-text',
                )}
                style={{ left: timeToPx(scale, start) }}
                aria-label={t`查看变更 ${change.number}`}
                onClick={() => onSelectChange(change)}
              >
                {change.kind === 'added' ? '+' : change.kind === 'removed' ? '−' : 'Δ'}{change.number}
              </button>
            );
          })}
          {rippleChange === null ? null : <TimelineRippleIndicator change={rippleChange} scale={scale} />}
          {selectedChange === null ? null : (
            <TimelineChangePopover
              change={selectedChange}
              left={popoverLeft}
              onUndo={onUndo}
              canUndo={canUndo}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function TimelineChangeGhosts({
  changes,
  scale,
  audio,
}: {
  readonly changes: readonly TimelineClipChange[];
  readonly scale: ReturnType<typeof createTimeScale>;
  readonly audio: boolean;
}) {
  return <>{changes.map((change) => {
    const previous = change.previous;
    if (previous === null) return null;
    const current = change.current;
    const shortened = current !== null
      && !hasTimelineDelta(change.startDelta)
      && change.durationDelta < 0;
    const start = shortened
      ? current.placement.start + current.placement.duration
      : previous.placement.start;
    const duration = shortened
      ? -change.durationDelta
      : previous.placement.duration;
    if (duration <= 0) return null;
    return (
      <span
        key={`ghost:${change.clipId}`}
        className={cn(
          'pointer-events-none absolute inset-y-1 z-0 overflow-hidden border border-dashed border-fail-border bg-fail-surface/75 text-2xs text-fail-text',
          audio && 'inset-y-0 bg-fail-surface/60',
        )}
        style={{ left: timeToPx(scale, start), width: Math.max(2, timeToPx(scale, duration)) }}
        aria-label={t`原位置 ${previous.name}`}
      >
        {audio ? null : <span className="absolute left-1 top-1 whitespace-nowrap"><Trans>原位置</Trans></span>}
      </span>
    );
  })}</>;
}

function TimelineRippleIndicator({
  change,
  scale,
}: {
  readonly change: TimelineClipChange;
  readonly scale: ReturnType<typeof createTimeScale>;
}) {
  if (change.current === null || !hasTimelineDelta(change.startDelta)) return null;
  return (
    <span
      className="pointer-events-none absolute top-1 z-30 flex h-5 items-center gap-1 rounded-sm border border-accent-200 bg-accent-100 px-1.5 text-2xs font-medium text-accent-text"
      style={{ left: timeToPx(scale, change.current.placement.start) }}
      aria-label={t`后续片段移动 ${formatSignedSeconds(change.startDelta)}`}
    >
      <MoveRight className="size-3" aria-hidden="true" />
      <Trans>后续片段 {formatSignedSeconds(change.startDelta)}</Trans>
    </span>
  );
}

function TimelineClipChangeOverlay({
  change,
  clip,
  scale,
  compact = false,
}: {
  readonly change: TimelineClipChange;
  readonly clip: TimelineClip;
  readonly scale: ReturnType<typeof createTimeScale>;
  readonly compact?: boolean | undefined;
}) {
  const originalOut = change.originalOut;
  const extensionStart = originalOut === null ? null : originalOut - clip.placement.start;
  const showsExtension = change.kind === 'modified'
    && change.durationDelta > 0
    && extensionStart !== null
    && extensionStart >= 0
    && extensionStart < clip.placement.duration;
  return (
    <span className="pointer-events-none absolute inset-0 z-20" aria-hidden="true">
      {showsExtension ? (
        <span
          className="absolute inset-y-0 border-l border-dashed border-fail-border bg-ok-surface/80"
          style={{ left: timeToPx(scale, extensionStart), right: 0 }}
        >
          {compact ? null : (
            <>
              <span className="absolute -left-px top-0 whitespace-nowrap px-1 text-2xs text-fail-text"><Trans>原出点</Trans></span>
              <span className="absolute bottom-4 right-1 font-mono text-2xs font-medium text-ok">{formatSignedSeconds(change.durationDelta)}</span>
            </>
          )}
        </span>
      ) : null}
    </span>
  );
}

function TimelineChangePopover({
  change,
  left,
  onUndo,
  canUndo,
}: {
  readonly change: TimelineClipChange;
  readonly left: number;
  readonly onUndo: () => void;
  readonly canUndo: boolean;
}) {
  const current = change.current;
  if (current === null) return null;
  return (
    <aside
      className="absolute inset-y-1 z-40 flex w-64 flex-col justify-center rounded-sm border border-divider bg-bg px-2 text-xs shadow-sm"
      style={{ left }}
      aria-label={t`时间轴变更 ${change.number}`}
    >
      <div className="flex items-center gap-2 font-semibold leading-4">
        <span className="rounded-sm bg-accent-100 px-1.5 py-0.5 font-mono text-2xs text-accent-text">Δ{change.number}</span>
        <span className="truncate">{current.name}</span>
      </div>
      {change.previous === null ? (
        <p className="text-2xs text-neutral-600"><Trans>Agent 新增片段 · {formatSeconds(current.placement.duration)}</Trans></p>
      ) : (
        <p className="flex items-center gap-1.5 text-2xs text-neutral-600">
          <span className="font-mono">{formatSeconds(change.previous.placement.duration)}</span>
          <span aria-hidden="true">→</span>
          <span className="font-mono">{formatSeconds(current.placement.duration)}</span>
          {hasTimelineDelta(change.durationDelta) ? <span className="rounded-sm bg-ok-surface px-1 text-ok"><Trans>波纹 {formatSignedSeconds(change.durationDelta)}</Trans></span> : null}
        </p>
      )}
      <div className="mt-1 flex items-center gap-2 border-t border-divider pt-1">
        <span className="text-2xs text-ok"><Trans>已应用到提案</Trans></span>
        <button type="button" className="ml-auto h-6 rounded-sm border border-divider px-2 text-2xs hover:bg-neutral-100 disabled:text-neutral-300" disabled={!canUndo} onClick={onUndo}><Trans>撤销变更组</Trans></button>
      </div>
    </aside>
  );
}

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(3)}s`;
}

function formatSignedSeconds(seconds: number): string {
  return `${seconds >= 0 ? '+' : ''}${seconds.toFixed(3)}s`;
}

function TimelineClipWaveform({ clip, change }: { readonly clip: TimelineClip; readonly change: TimelineClipChange | null }) {
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
      className={cn(
        '!h-full !min-h-0 !rounded-none !border-0 bg-accent-100 [&_.blueprint]:border-0 [&_svg_path:first-child]:fill-accent-400 [&_svg_path:nth-child(2)]:stroke-accent-600',
        change?.kind === 'added' && 'bg-ok-surface [&_svg_path:first-child]:fill-ok-border [&_svg_path:nth-child(2)]:stroke-ok',
      )}
    />
  );
}

function TimelineTrackHead({ icon, label, controls, track, readOnly = true, onReplaceTrack }: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly controls: RenderedTrack['controls'];
  readonly track?: TimelineTrack | undefined;
  readonly readOnly?: boolean | undefined;
  readonly onReplaceTrack?: ((track: TimelineTrack) => void) | undefined;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 border-r border-divider py-2 pl-12 pr-2 text-xs font-medium">
      {controls === 'none' ? (
        <span className="flex-none text-neutral-600">{icon}</span>
      ) : (
        <span className="grid h-[var(--h-ctl-sm)] w-7 flex-none place-items-center rounded-sm bg-accent-600 font-mono text-2xs font-semibold text-bg">
          {controls === 'video' ? 'V1' : 'A1'}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {controls === 'none' || track === undefined ? null : (
        <span className="flex flex-none items-center text-neutral-500">
          <button
            type="button"
            className={cn('grid size-5 place-items-center rounded-sm hover:bg-neutral-100', track.muted && 'text-fail-text')}
            aria-label={controls === 'audio' ? t`切换轨道静音` : t`切换视频轨道输出`}
            aria-pressed={track.muted}
            disabled={readOnly}
            onClick={() => onReplaceTrack?.({ ...track, muted: !track.muted })}
          >
            {controls === 'audio' ? <Volume2 className="size-3" aria-hidden="true" /> : <Eye className="size-3" aria-hidden="true" />}
          </button>
          <button
            type="button"
            className={cn('grid size-5 place-items-center rounded-sm hover:bg-neutral-100', track.locked && 'text-accent-text')}
            aria-label={t`切换轨道锁定`}
            aria-pressed={track.locked}
            disabled={readOnly && !track.locked}
            onClick={() => onReplaceTrack?.({ ...track, locked: !track.locked })}
          >
            <LockKeyhole className="size-3" aria-hidden="true" />
          </button>
        </span>
      )}
    </div>
  );
}

const TimelineMarkerRow = memo(function TimelineMarkerRow({ markers, scale, contentWidth, ticks }: { readonly markers: readonly EditorMarker[]; readonly scale: ReturnType<typeof createTimeScale>; readonly contentWidth: number; readonly ticks: ReturnType<typeof rulerTicks> }) {
  return (
    <div className="grid min-h-0 grid-cols-[var(--w-track-head)_minmax(0,1fr)] border-b border-divider" role="row" aria-label={t`标记`}>
      <TimelineTrackHead icon={<Bookmark className="size-4" />} label={t`标记`} controls="none" />
      <div className="relative min-h-0 overflow-hidden" style={{ width: contentWidth }}><TimelineGrid ticks={ticks} />{markers.map((marker) => <span key={marker.id} className="absolute inset-y-1 flex items-center gap-1.5 text-2xs text-neutral-700" style={{ left: timeToPx(scale, marker.time) }}><span className="h-full w-1.5" style={{ backgroundColor: marker.color }} aria-hidden="true" /><span className="whitespace-nowrap">{marker.label}</span></span>)}</div>
    </div>
  );
}, (previous, next) => previous.markers === next.markers
  && previous.scale.pixelsPerSecond === next.scale.pixelsPerSecond
  && previous.contentWidth === next.contentWidth);

const TimelineEventRow = memo(function TimelineEventRow({ clips, scale, contentWidth, ticks }: { readonly clips: readonly TimelineClip[]; readonly scale: ReturnType<typeof createTimeScale>; readonly contentWidth: number; readonly ticks: ReturnType<typeof rulerTicks> }) {
  return (
    <div className="grid min-h-0 grid-cols-[var(--w-track-head)_minmax(0,1fr)] border-b border-divider" role="row" aria-label={t`事件`}>
      <TimelineTrackHead icon={<Star className="size-4" />} label={t`事件`} controls="none" />
      <div className="relative min-h-0 overflow-hidden" style={{ width: contentWidth }}><TimelineGrid ticks={ticks} />{clips.map((clip) => <span key={`event:${clip.id}`} className="absolute inset-y-0 flex items-center gap-1.5 text-2xs text-neutral-700" style={{ left: timeToPx(scale, clip.placement.start) }}><span className="h-3 w-1.5 bg-ok" aria-hidden="true" /><span>{clip.name.split(' · ')[0]}</span></span>)}</div>
    </div>
  );
}, (previous, next) => previous.clips === next.clips
  && previous.scale.pixelsPerSecond === next.scale.pixelsPerSecond
  && previous.contentWidth === next.contentWidth);

function TimelineGrid({ ticks }: { readonly ticks: ReturnType<typeof rulerTicks> }) {
  return <>{ticks.filter((tick) => tick.major).map((tick) => <span key={`grid:${tick.time}`} className="pointer-events-none absolute inset-y-0 border-l border-divider" style={{ left: tick.px }} aria-hidden="true" />)}</>;
}

function TimelineFooterButton({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return <button type="button" className="grid size-[var(--h-ctl-sm)] place-items-center rounded-sm border border-divider" aria-label={label}>{children}</button>;
}
