import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  Bookmark,
  BookmarkPlus,
  Camera,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  ClipboardPaste,
  Copy,
  Eye,
  Link2,
  LockKeyhole,
  MoveRight,
  MousePointer2,
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
import { OverflowMenu } from '../../design/layout';
import { Drawer } from '../../design/feedback';
import { Button, cn } from '../../design/primitives';
import {
  BASE_PIXELS_PER_SECOND,
  createTimeScale,
  formatMillisecondTimecode,
  pxToTime,
  rulerTicks,
  timeToPx,
} from '../../design/timeline/timeScale';
import { DEFAULT_TIMELINE_MARKER_COLOR } from '../../design/timeline';
import { Waveform } from '../media';
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
import {
  deleteRippleClips,
  moveRippleClip,
  pasteFreePositionedClipsAtTime,
  pasteRippleClipsAtTime,
  removeTimelineRange,
  splitRippleClip,
  trimRippleClip,
} from './timelineEditing';
import {
  clipMediaDuration,
  moveTimelineClip,
  resolveTimelineSnap,
  snapTimeToFrame,
  trimTimelineClip,
} from './timelineInteraction';

export interface ProjectTimelineProps {
  readonly document: EditingDocument;
  readonly selectedClipId: string | null;
  readonly selectedClipIds: readonly string[];
  readonly targetTrackId: string;
  readonly timelineTimeSeconds: number;
  readonly reviewGroup: ProjectChangeGroup | null;
  readonly readOnly: boolean;
  readonly onSelectClip: (clipId: string, additive?: boolean) => void;
  readonly onTargetTrack: (trackId: string) => void;
  readonly onInspectClip: (clipId: string) => void;
  readonly onSeek: (seconds: number) => void;
  readonly onTogglePlayback: () => void;
  readonly onShuttle: (direction: -1 | 0 | 1) => void;
  readonly onReplaceClip: (clip: TimelineClip) => void;
  readonly onReplaceTrack: (track: TimelineTrack) => void;
  readonly onReplaceTrackClips: (trackId: string, clips: readonly TimelineClip[]) => void;
  readonly onReplaceTrackClipGroups: (groups: readonly { readonly trackId: string; readonly clips: readonly TimelineClip[] }[]) => void;
  readonly onInsertTrack: (track: TimelineTrack, index: number) => void;
  readonly onRemoveTrack: (trackId: string) => void;
  readonly onReorderTracks: (trackIds: readonly string[]) => void;
  readonly onReplaceMarkers: (markers: readonly EditorMarker[]) => void;
  readonly canUndo: boolean;
  readonly onUndo: () => void;
}

interface RenderedTrack {
  readonly id: string;
  readonly kind: 'video' | 'audio' | 'text';
  readonly label: string;
  readonly ariaLabel: string;
  readonly clips: readonly TimelineClip[];
  readonly controls: 'video' | 'audio' | 'text' | 'none';
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
  selectedClipIds,
  targetTrackId,
  timelineTimeSeconds,
  reviewGroup,
  readOnly,
  onSelectClip,
  onTargetTrack,
  onInspectClip,
  onSeek,
  onTogglePlayback,
  onShuttle,
  onReplaceClip,
  onReplaceTrack,
  onReplaceTrackClips,
  onReplaceTrackClipGroups,
  onInsertTrack,
  onRemoveTrack,
  onReorderTracks,
  onReplaceMarkers,
  canUndo,
  onUndo,
}: ProjectTimelineProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(1_000);
  const [zoomMultiplier, setZoomMultiplier] = useState(1);
  const [changeFilter, setChangeFilter] = useState<'all' | 'selected'>('all');
  const [scrollLeft, setScrollLeft] = useState(0);
  const [snapGuideTime, setSnapGuideTime] = useState<number | null>(null);
  const [markerDraft, setMarkerDraft] = useState<EditorMarker | null>(null);
  const [rangeInSeconds, setRangeInSeconds] = useState<number | null>(null);
  const [rangeOutSeconds, setRangeOutSeconds] = useState<number | null>(null);
  const [clipboard, setClipboard] = useState<{
    readonly groups: readonly {
      readonly trackId: string;
      readonly clips: readonly TimelineClip[];
    }[];
  } | null>(null);
  const seekFrameRef = useRef<number | null>(null);
  const queuedSeekRef = useRef<number | null>(null);
  const story = document.tracks.find((track) => track.id === document.story_track_id) ?? null;
  const clips = story?.clips ?? [];
  const selectedClip = document.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === selectedClipId) ?? null;
  const selectedTrack = document.tracks.find((track) => track.clips.some((clip) => clip.id === selectedClipId)) ?? null;
  const targetTrack = document.tracks.find((track) => track.id === targetTrackId) ?? story;
  const rangeTargetTrack = targetTrack;
  const selectedClipIdSet = useMemo(() => new Set(selectedClipIds), [selectedClipIds]);
  const selectedTrackGroups = useMemo(() => document.tracks.flatMap((track) => {
    const selected = track.clips.filter((clip) => selectedClipIdSet.has(clip.id));
    return selected.length === 0 ? [] : [{ track, clips: selected }];
  }), [document.tracks, selectedClipIdSet]);
  const selectedTrackClipIds = selectedTrack === null
    ? new Set<string>()
    : new Set(selectedTrack.clips.filter((clip) => selectedClipIdSet.has(clip.id)).map((clip) => clip.id));
  const playheadSeconds = Math.min(
    document.duration_seconds,
    Math.max(0, timelineTimeSeconds),
  );
  const editPlayheadSeconds = snapTimeToFrame(playheadSeconds, document.fps);
  const snapPoints = useMemo(() => [
    ...document.tracks.flatMap((track) => track.clips.flatMap((clip) => [
      { time: clip.placement.start, clipId: clip.id },
      { time: clip.placement.start + clip.placement.duration, clipId: clip.id },
    ])),
    ...document.markers.map((marker) => ({ time: marker.time, clipId: null })),
    { time: playheadSeconds, clipId: null },
  ], [document.markers, document.tracks, playheadSeconds]);
  const renderedTracks = useMemo(() => buildRenderedTracks(document), [document]);
  const nonStoryTrackIds = useMemo(() => [...document.tracks]
    .filter((track) => track.id !== document.story_track_id)
    .sort((left, right) => left.order - right.order)
    .map((track) => track.id), [document.story_track_id, document.tracks]);
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
    && selectedTrackClipIds.size === 1
    && selectedClip !== null
    && selectedTrack?.id === document.story_track_id
    && editPlayheadSeconds > selectedClip.placement.start + 1 / document.fps
    && editPlayheadSeconds < selectedClip.placement.start + selectedClip.placement.duration - 1 / document.fps;
  const canDelete = !readOnly && selectedTrackGroups.length > 0;
  const canCopy = selectedTrackGroups.length > 0;
  const clipboardTracks = clipboard === null
    ? []
    : clipboard.groups.length === 1
      ? [targetTrack]
      : clipboard.groups.map((group) => document.tracks.find((track) => track.id === group.trackId) ?? null);
  const canPaste = !readOnly
    && clipboard !== null
    && clipboardTracks.length === clipboard.groups.length
    && clipboardTracks.every((track) => track !== null && !track.locked);
  const rangeStart = rangeInSeconds === null || rangeOutSeconds === null
    ? null
    : Math.min(rangeInSeconds, rangeOutSeconds);
  const rangeEnd = rangeInSeconds === null || rangeOutSeconds === null
    ? null
    : Math.max(rangeInSeconds, rangeOutSeconds);
  const canExtractRange = !readOnly
    && rangeTargetTrack !== null
    && !rangeTargetTrack.locked
    && rangeStart !== null
    && rangeEnd !== null
    && rangeEnd - rangeStart >= 1 / document.fps;
  const canRippleTrimToPlayhead = !readOnly
    && selectedClip !== null
    && selectedTrack?.id === document.story_track_id
    && editPlayheadSeconds > selectedClip.placement.start + 1 / document.fps
    && editPlayheadSeconds < selectedClip.placement.start + selectedClip.placement.duration - 1 / document.fps;

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
      editPlayheadSeconds,
      globalThis.crypto.randomUUID(),
    );
    onReplaceTrackClips(selectedTrack.id, clips);
  };

  const deleteSelected = () => {
    if (!canDelete) return;
    const updates = selectedTrackGroups.map(({ track, clips: selected }) => {
      const ids = new Set(selected.map((clip) => clip.id));
      return {
        trackId: track.id,
        clips: track.id === document.story_track_id
          ? deleteRippleClips(track.clips, ids)
          : track.clips.filter((clip) => !ids.has(clip.id)),
      };
    });
    const remaining = document.tracks.flatMap((track) => track.clips.filter((clip) => !selectedClipIdSet.has(clip.id)));
    const nextSelection = remaining[0] ?? null;
    onReplaceTrackClipGroups(updates);
    if (nextSelection !== null) onSelectClip(nextSelection.id, false);
  };

  const copySelected = () => {
    if (!canCopy) return;
    setClipboard({
      groups: selectedTrackGroups.map(({ track, clips: selected }) => ({ trackId: track.id, clips: selected })),
    });
  };

  const pasteClipboard = () => {
    if (!canPaste || clipboard === null) return;
    const pastedIds: string[] = [];
    const updates = clipboard.groups.map((group, groupIndex) => {
      const track = clipboardTracks[groupIndex]!;
      const clipIds = group.clips.map(() => globalThis.crypto.randomUUID());
      pastedIds.push(...clipIds);
      return {
        trackId: track.id,
        clips: track.id === document.story_track_id
          ? pasteRippleClipsAtTime(track.clips, group.clips, editPlayheadSeconds, clipIds, globalThis.crypto.randomUUID())
          : pasteFreePositionedClipsAtTime(track.clips, group.clips, editPlayheadSeconds, clipIds),
      };
    });
    onReplaceTrackClipGroups(updates);
    pastedIds.forEach((clipId, index) => onSelectClip(clipId, index > 0));
  };

  const addTrack = (kind: TimelineTrack['kind']) => {
    if (readOnly) return;
    const number = document.tracks.filter((track) => track.kind === kind).length + 1;
    const kindLabel = kind === 'video' ? t`视频` : kind === 'audio' ? t`音频` : t`文字`;
    onInsertTrack({
      id: globalThis.crypto.randomUUID(),
      name: `${kindLabel} ${number}`,
      kind,
      order: document.tracks.length,
      muted: false,
      locked: false,
      hidden: false,
      clips: [],
    }, document.tracks.length);
  };
  const reorderTrack = (trackId: string, direction: -1 | 1) => {
    if (readOnly || trackId === document.story_track_id) return;
    const nonStoryIds = [...nonStoryTrackIds];
    const index = nonStoryIds.indexOf(trackId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= nonStoryIds.length) return;
    [nonStoryIds[index], nonStoryIds[target]] = [nonStoryIds[target]!, nonStoryIds[index]!];
    onReorderTracks([document.story_track_id, ...nonStoryIds]);
  };
  const addMarker = () => {
    if (readOnly) return;
    const number = document.markers.length + 1;
    onReplaceMarkers([...document.markers, {
      id: globalThis.crypto.randomUUID(),
      time: editPlayheadSeconds,
      label: t`标记 ${number}`,
      color: DEFAULT_TIMELINE_MARKER_COLOR,
    }]);
  };
  const extractRange = () => {
    if (!canExtractRange || rangeTargetTrack === null || rangeStart === null || rangeEnd === null) return;
    onReplaceTrackClips(
      rangeTargetTrack.id,
      removeTimelineRange(
        rangeTargetTrack.clips,
        rangeStart,
        rangeEnd,
        globalThis.crypto.randomUUID(),
        rangeTargetTrack.id === document.story_track_id,
      ),
    );
    setRangeInSeconds(null);
    setRangeOutSeconds(null);
  };
  const rippleTrimToPlayhead = (edge: 'start' | 'end') => {
    if (!canRippleTrimToPlayhead || selectedClip === null || selectedTrack === null) return;
    const replacement = trimTimelineClip(
      selectedClip,
      edge,
      editPlayheadSeconds,
      document.fps,
      clipMediaDuration(selectedClip),
    );
    onReplaceTrackClips(selectedTrack.id, trimRippleClip(selectedTrack.clips, replacement));
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
        if (event.key.toLowerCase() === 'j' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          onShuttle(-1);
          return;
        }
        if (event.key.toLowerCase() === 'k' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          onShuttle(0);
          return;
        }
        if (event.key.toLowerCase() === 'l' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          onShuttle(1);
          return;
        }
        if (event.key.toLowerCase() === 'c' && (event.ctrlKey || event.metaKey) && !event.altKey) {
          event.preventDefault();
          copySelected();
          return;
        }
        if (event.key.toLowerCase() === 'v' && (event.ctrlKey || event.metaKey) && !event.altKey && canPaste) {
          event.preventDefault();
          pasteClipboard();
          return;
        }
        if (event.key.toLowerCase() === 's' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          splitSelected();
          return;
        }
        if (event.key.toLowerCase() === 'm' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          addMarker();
          return;
        }
        if (event.key.toLowerCase() === 'i' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          setRangeInSeconds(editPlayheadSeconds);
          return;
        }
        if (event.key.toLowerCase() === 'o' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          setRangeOutSeconds(editPlayheadSeconds);
          return;
        }
        if (event.key.toLowerCase() === 'q' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          rippleTrimToPlayhead('start');
          return;
        }
        if (event.key.toLowerCase() === 'w' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          rippleTrimToPlayhead('end');
          return;
        }
        if (event.key === "'" && !event.ctrlKey && !event.metaKey && !event.altKey && canExtractRange) {
          event.preventDefault();
          extractRange();
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
        <OverflowMenu
          label={t`添加轨道`}
          triggerLabel={<><SquarePlus className="size-3.5" aria-hidden="true" /><Trans>添加轨道</Trans></>}
          align="start"
          triggerClassName="h-7 rounded-sm border border-divider px-2 text-xs disabled:text-neutral-300"
          items={[
            { id: 'video', label: t`添加视频轨道`, disabled: readOnly, onSelect: () => addTrack('video') },
            { id: 'audio', label: t`添加音频轨道`, disabled: readOnly, onSelect: () => addTrack('audio') },
            { id: 'text', label: t`添加文字轨道`, disabled: readOnly, onSelect: () => addTrack('text') },
          ]}
        />
        <span className="max-w-40 truncate text-2xs text-neutral-500"><Trans>目标：</Trans>{targetTrack?.name ?? '—'}</span>
        <span className="flex items-center overflow-hidden rounded-sm border border-divider text-2xs">
          <button type="button" className="h-7 px-2 font-mono hover:bg-neutral-100" aria-label={t`在播放头标记入点`} onClick={() => setRangeInSeconds(editPlayheadSeconds)}>I</button>
          <button type="button" className="h-7 border-l border-divider px-2 font-mono hover:bg-neutral-100" aria-label={t`在播放头标记出点`} onClick={() => setRangeOutSeconds(editPlayheadSeconds)}>O</button>
          {rangeStart === null || rangeEnd === null ? null : (
            <span className="border-l border-divider px-2 font-mono text-accent-text">{formatMillisecondTimecode(rangeStart)}–{formatMillisecondTimecode(rangeEnd)}</span>
          )}
          {rangeInSeconds === null && rangeOutSeconds === null ? null : (
            <button type="button" className="h-7 border-l border-divider px-2 hover:bg-neutral-100" aria-label={t`清除入出点`} onClick={() => { setRangeInSeconds(null); setRangeOutSeconds(null); }}>×</button>
          )}
        </span>
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
        canCopy={canCopy}
        canPaste={canPaste}
        canUndo={canUndo && !readOnly}
        canAddMarker={!readOnly}
        canExtractRange={canExtractRange}
        canRippleTrim={canRippleTrimToPlayhead}
        onSplit={splitSelected}
        onDelete={deleteSelected}
        onCopy={copySelected}
        onPaste={pasteClipboard}
        onUndo={onUndo}
        onAddMarker={addMarker}
        onExtractRange={extractRange}
        onRippleTrimStart={() => rippleTrimToPlayhead('start')}
        onRippleTrimEnd={() => rippleTrimToPlayhead('end')}
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
              selectedClipIds={selectedClipIdSet}
              fps={document.fps}
              readOnly={readOnly}
              onSelectClip={onSelectClip}
              onInspectClip={onInspectClip}
              onReplaceClip={onReplaceClip}
              onReplaceTrack={onReplaceTrack}
              onReplaceTrackClips={onReplaceTrackClips}
              onRemoveTrack={onRemoveTrack}
              storyTrackId={document.story_track_id}
              changeByClipId={changeByClipId}
              ghostChanges={ghostChanges}
              snapPoints={snapPoints}
              snapThresholdSeconds={10 / scale.pixelsPerSecond}
              onSnapChange={setSnapGuideTime}
              nonStoryTrackIds={nonStoryTrackIds}
              onReorderTrack={reorderTrack}
              targetTrackId={targetTrackId}
              onTargetTrack={onTargetTrack}
            />
          ))}
          <TimelineMarkerRow
            markers={document.markers}
            scale={scale}
            contentWidth={contentWidth}
            ticks={ticks}
            onSeek={onSeek}
            onEditMarker={(marker) => setMarkerDraft({ ...marker })}
          />
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
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault();
              const editPoints = [...new Set([
                0,
                document.duration_seconds,
                ...clips.flatMap((clip) => [clip.placement.start, clip.placement.start + clip.placement.duration]),
              ])].sort((left, right) => left - right);
              const next = event.key === 'ArrowDown'
                ? editPoints.find((time) => time > playheadSeconds + 0.5 / document.fps)
                : [...editPoints].reverse().find((time) => time < playheadSeconds - 0.5 / document.fps);
              if (next !== undefined) onSeek(next);
              return;
            }
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const direction = event.key === 'ArrowRight' ? 1 : -1;
            const step = event.shiftKey ? 1 : 1 / document.fps;
            onSeek(Math.min(document.duration_seconds, Math.max(0, playheadSeconds + direction * step)));
          }}
        />
      </div>
      {snapGuideTime === null ? null : (
        <span
          className="pointer-events-none absolute bottom-14 top-[var(--h-panel-head)] z-30 w-0.5 bg-accent-400/80"
          style={{ left: `calc(var(--w-track-head) + ${timeToPx(scale, snapGuideTime) - scrollLeft}px)` }}
          aria-label={t`吸附到 ${formatMillisecondTimecode(snapGuideTime)}`}
        />
      )}
      {rangeStart === null || rangeEnd === null || rangeEnd <= rangeStart ? null : (
        <span
          className="pointer-events-none absolute bottom-14 top-[var(--h-panel-head)] z-10 border-x border-accent-400 bg-accent-100/35"
          style={{
            left: `calc(var(--w-track-head) + ${timeToPx(scale, rangeStart) - scrollLeft}px)`,
            width: timeToPx(scale, rangeEnd - rangeStart),
          }}
          aria-label={t`入出点范围 ${formatMillisecondTimecode(rangeStart)} 到 ${formatMillisecondTimecode(rangeEnd)}`}
        />
      )}
      <Drawer
        open={markerDraft !== null}
        title={<Trans>编辑标记</Trans>}
        description={markerDraft === null ? undefined : formatMillisecondTimecode(markerDraft.time)}
        width="standard"
        onClose={() => setMarkerDraft(null)}
        footer={markerDraft === null ? undefined : (
          <>
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                onReplaceMarkers(document.markers.filter((marker) => marker.id !== markerDraft.id));
                setMarkerDraft(null);
              }}
            >
              <Trans>删除标记</Trans>
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={markerDraft.label.trim() === ''}
              onClick={() => {
                onReplaceMarkers(document.markers.map((marker) => marker.id === markerDraft.id
                  ? {
                    ...markerDraft,
                    label: markerDraft.label.trim(),
                    time: snapTimeToFrame(Math.min(document.duration_seconds, Math.max(0, markerDraft.time)), document.fps),
                  }
                  : marker));
                setMarkerDraft(null);
              }}
            >
              <Trans>保存标记</Trans>
            </Button>
          </>
        )}
      >
        {markerDraft === null ? <span /> : (
          <div className="space-y-3">
            <label className="flex flex-col gap-1 text-xs">
              <Trans>名称</Trans>
              <input className="border border-divider bg-bg px-2 py-1.5" value={markerDraft.label} onChange={(event) => setMarkerDraft({ ...markerDraft, label: event.currentTarget.value })} />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <Trans>时间</Trans>
              <input type="number" min={0} max={document.duration_seconds} step={1 / document.fps} className="border border-divider bg-bg px-2 py-1.5 font-mono" value={markerDraft.time} onChange={(event) => setMarkerDraft({ ...markerDraft, time: Number(event.currentTarget.value) })} />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Trans>颜色</Trans>
              <input type="color" value={markerDraft.color} onChange={(event) => setMarkerDraft({ ...markerDraft, color: event.currentTarget.value.toUpperCase() })} />
            </label>
          </div>
        )}
      </Drawer>
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
      controls: track.kind === 'audio' ? 'audio' : track.kind === 'text' ? 'text' : 'video',
      icon: track.kind === 'audio' ? <Volume2 className="size-4" /> : <Camera className="size-4" />,
      track,
      derivedAudio: false,
    });
  }
  return rows;
}

const TimelineTrackRow = memo(function TimelineTrackRow({ track, scale, contentWidth, selectedClipId, selectedClipIds, fps, readOnly, onSelectClip, onInspectClip, onReplaceClip, onReplaceTrack, onReplaceTrackClips, onRemoveTrack, storyTrackId, changeByClipId, ghostChanges, snapPoints, snapThresholdSeconds, onSnapChange, nonStoryTrackIds, onReorderTrack, targetTrackId, onTargetTrack }: {
  readonly track: RenderedTrack;
  readonly scale: ReturnType<typeof createTimeScale>;
  readonly contentWidth: number;
  readonly selectedClipId: string | null;
  readonly selectedClipIds: ReadonlySet<string>;
  readonly fps: number;
  readonly readOnly: boolean;
  readonly onSelectClip: (clipId: string, additive?: boolean) => void;
  readonly onInspectClip: (clipId: string) => void;
  readonly onReplaceClip: (clip: TimelineClip) => void;
  readonly onReplaceTrack: (track: TimelineTrack) => void;
  readonly onReplaceTrackClips: (trackId: string, clips: readonly TimelineClip[]) => void;
  readonly onRemoveTrack: (trackId: string) => void;
  readonly storyTrackId: string;
  readonly changeByClipId: ReadonlyMap<string, TimelineClipChange>;
  readonly ghostChanges: readonly TimelineClipChange[];
  readonly snapPoints: readonly { readonly time: number; readonly clipId: string | null }[];
  readonly snapThresholdSeconds: number;
  readonly onSnapChange: (time: number | null) => void;
  readonly nonStoryTrackIds: readonly string[];
  readonly onReorderTrack: (trackId: string, direction: -1 | 1) => void;
  readonly targetTrackId: string;
  readonly onTargetTrack: (trackId: string) => void;
}) {
  const nonStoryIndex = nonStoryTrackIds.indexOf(track.track.id);
  return (
    <div className="grid min-h-0 grid-cols-[var(--w-track-head)_minmax(0,1fr)] border-b border-divider" role="row" aria-label={track.ariaLabel}>
      <TimelineTrackHead
        icon={track.icon}
        label={track.label}
        controls={track.controls}
        track={track.track}
        readOnly={readOnly}
        onReplaceTrack={onReplaceTrack}
        removable={track.track.id !== storyTrackId && !track.derivedAudio}
        onRemoveTrack={onRemoveTrack}
        canMoveUp={!track.derivedAudio && nonStoryIndex > 0}
        canMoveDown={!track.derivedAudio && nonStoryIndex >= 0 && nonStoryIndex < nonStoryTrackIds.length - 1}
        onMoveTrack={onReorderTrack}
        targeted={targetTrackId === track.track.id}
        onTargetTrack={onTargetTrack}
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
            derivedAudio={track.derivedAudio}
            selected={selectedClipIds.has(clip.id)}
            primary={selectedClipId === clip.id}
            scale={scale}
            fps={fps}
            readOnly={readOnly || track.track.locked || track.derivedAudio}
            change={changeByClipId.get(clip.id) ?? null}
            onSelect={(additive) => onSelectClip(clip.id, additive)}
            onInspect={() => onInspectClip(clip.id)}
            snapPoints={snapPoints}
            snapThresholdSeconds={snapThresholdSeconds}
            onSnapChange={onSnapChange}
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
  && previous.selectedClipIds === next.selectedClipIds
  && previous.fps === next.fps
  && previous.readOnly === next.readOnly
  && previous.storyTrackId === next.storyTrackId
  && previous.changeByClipId === next.changeByClipId
  && previous.ghostChanges === next.ghostChanges
  && previous.snapPoints === next.snapPoints
  && previous.snapThresholdSeconds === next.snapThresholdSeconds
  && previous.nonStoryTrackIds === next.nonStoryTrackIds
  && previous.targetTrackId === next.targetTrackId);

const TimelineClipCell = memo(function TimelineClipCell({ clip, kind, derivedAudio, selected, primary, scale, fps, readOnly, change, onSelect, onInspect, onReplace, snapPoints, snapThresholdSeconds, onSnapChange }: {
  readonly clip: TimelineClip;
  readonly kind: RenderedTrack['kind'];
  readonly derivedAudio: boolean;
  readonly selected: boolean;
  readonly primary: boolean;
  readonly scale: ReturnType<typeof createTimeScale>;
  readonly fps: number;
  readonly readOnly: boolean;
  readonly change: TimelineClipChange | null;
  readonly onSelect: (additive: boolean) => void;
  readonly onInspect: () => void;
  readonly onReplace: (clip: TimelineClip, mode: 'move' | 'start' | 'end') => void;
  readonly snapPoints: readonly { readonly time: number; readonly clipId: string | null }[];
  readonly snapThresholdSeconds: number;
  readonly onSnapChange: (time: number | null) => void;
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
  if (derivedAudio) {
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
    const additive = event.ctrlKey || event.metaKey;
    onSelect(additive);
    if (additive) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    gesture.current = { pointerId: event.pointerId, clientX: event.clientX, mode, clip };
  };
  const updateGesture = (event: React.PointerEvent<HTMLElement>) => {
    const active = gesture.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    const deltaSeconds = pxToTime(scale, event.clientX - active.clientX);
    const rawAnchor = active.mode === 'end'
      ? active.clip.placement.start + active.clip.placement.duration + deltaSeconds
      : active.clip.placement.start + deltaSeconds;
    const snap = event.shiftKey
      ? { anchorTime: rawAnchor, snapTime: null }
      : resolveTimelineSnap(
        rawAnchor,
        active.mode === 'move' ? [0, active.clip.placement.duration] : [0],
        snapPoints.filter((point) => point.clipId !== active.clip.id).map((point) => point.time),
        snapThresholdSeconds,
      );
    onSnapChange(snap.snapTime);
    const next = active.mode === 'move'
      ? moveTimelineClip(active.clip, snap.anchorTime, fps)
      : trimTimelineClip(
        active.clip,
        active.mode,
        snap.anchorTime,
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
    onSnapChange(null);
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
      onClick={(event) => {
        if (event.detail === 0) onSelect(event.ctrlKey || event.metaKey);
      }}
      onDoubleClick={onInspect}
      onPointerDown={(event) => beginGesture(event, 'move')}
      onPointerMove={updateGesture}
      onPointerUp={finishGesture}
      onPointerCancel={() => { gesture.current = null; setVisualClip(clip); onSnapChange(null); }}
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
      {kind === 'audio' ? (
        <TimelineClipWaveform clip={clip} change={change} />
      ) : kind === 'text' ? <span className="grid size-full place-items-center text-2xs">{clip.name}</span> : material.streamAssetId === null ? (
        <span className="grid size-full place-items-center text-2xs text-neutral-500"><Trans>待录制</Trans></span>
      ) : (
        <>
          <video className="pointer-events-none size-full bg-neutral-900 object-cover" src={shell.mediaSrc(mediaAssetStreamPath(material.streamAssetId)) ?? undefined} preload="metadata" muted tabIndex={-1} aria-hidden="true" />
          <Clapperboard className="absolute left-1 top-1 size-3 rounded-sm border border-neutral-700 bg-neutral-900/75 p-px text-bg" aria-hidden="true" />
          <Link2 className="absolute right-1 top-1 size-3 rounded-sm border border-neutral-700 bg-neutral-900/75 p-px text-bg" aria-hidden="true" />
        </>
      )}
      {change === null ? null : <TimelineClipChangeOverlay change={change} clip={visualClip} scale={scale} />}
      {clip.transition_in === null ? null : <span className="pointer-events-none absolute left-0 top-0 z-20 border-l-8 border-t-8 border-l-accent-500 border-t-transparent" aria-label={t`入场转场 ${clip.transition_in}`} />}
      {clip.transition_out === null ? null : <span className="pointer-events-none absolute right-0 top-0 z-20 border-r-8 border-t-8 border-r-accent-500 border-t-transparent" aria-label={t`出场转场 ${clip.transition_out}`} />}
      <span className="absolute inset-x-0 bottom-0 truncate bg-neutral-900/80 px-1 py-px text-2xs text-bg">{clip.name}</span>
      {primary && !readOnly ? (
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
  && previous.derivedAudio === next.derivedAudio
  && previous.selected === next.selected
  && previous.primary === next.primary
  && previous.scale.pixelsPerSecond === next.scale.pixelsPerSecond
  && previous.fps === next.fps
  && previous.readOnly === next.readOnly
  && previous.change === next.change
  && previous.snapPoints === next.snapPoints
  && previous.snapThresholdSeconds === next.snapThresholdSeconds);

function TimelineToolStrip({
  canSplit,
  canDelete,
  canCopy,
  canPaste,
  canUndo,
  canAddMarker,
  canExtractRange,
  canRippleTrim,
  onSplit,
  onDelete,
  onCopy,
  onPaste,
  onUndo,
  onAddMarker,
  onExtractRange,
  onRippleTrimStart,
  onRippleTrimEnd,
}: {
  readonly canSplit: boolean;
  readonly canDelete: boolean;
  readonly canCopy: boolean;
  readonly canPaste: boolean;
  readonly canUndo: boolean;
  readonly canAddMarker: boolean;
  readonly canExtractRange: boolean;
  readonly canRippleTrim: boolean;
  readonly onSplit: () => void;
  readonly onDelete: () => void;
  readonly onCopy: () => void;
  readonly onPaste: () => void;
  readonly onUndo: () => void;
  readonly onAddMarker: () => void;
  readonly onExtractRange: () => void;
  readonly onRippleTrimStart: () => void;
  readonly onRippleTrimEnd: () => void;
}) {
  const tools = [
    { label: t`选择工具`, icon: <MousePointer2 className="size-4" aria-hidden="true" />, enabled: true, pressed: true, action: undefined },
    { label: t`在播放头切分片段`, icon: <Scissors className="size-4" aria-hidden="true" />, enabled: canSplit, pressed: false, action: onSplit },
    { label: t`在播放头添加标记`, icon: <BookmarkPlus className="size-4" aria-hidden="true" />, enabled: canAddMarker, pressed: false, action: onAddMarker },
    { label: t`提取入出点范围`, icon: <span className="font-mono text-sm" aria-hidden="true">'</span>, enabled: canExtractRange, pressed: false, action: onExtractRange },
    { label: t`波纹裁切片段起点到播放头`, icon: <span className="font-mono text-xs" aria-hidden="true">Q</span>, enabled: canRippleTrim, pressed: false, action: onRippleTrimStart },
    { label: t`波纹裁切播放头到片段终点`, icon: <span className="font-mono text-xs" aria-hidden="true">W</span>, enabled: canRippleTrim, pressed: false, action: onRippleTrimEnd },
    { label: t`复制所选片段`, icon: <Copy className="size-4" aria-hidden="true" />, enabled: canCopy, pressed: false, action: onCopy },
    { label: t`在播放头粘贴片段`, icon: <ClipboardPaste className="size-4" aria-hidden="true" />, enabled: canPaste, pressed: false, action: onPaste },
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

function TimelineTrackHead({ icon, label, controls, track, readOnly = true, removable = false, canMoveUp = false, canMoveDown = false, targeted = false, onReplaceTrack, onRemoveTrack, onMoveTrack, onTargetTrack }: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly controls: RenderedTrack['controls'];
  readonly track?: TimelineTrack | undefined;
  readonly readOnly?: boolean | undefined;
  readonly removable?: boolean | undefined;
  readonly canMoveUp?: boolean | undefined;
  readonly canMoveDown?: boolean | undefined;
  readonly targeted?: boolean | undefined;
  readonly onReplaceTrack?: ((track: TimelineTrack) => void) | undefined;
  readonly onRemoveTrack?: ((trackId: string) => void) | undefined;
  readonly onMoveTrack?: ((trackId: string, direction: -1 | 1) => void) | undefined;
  readonly onTargetTrack?: ((trackId: string) => void) | undefined;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 border-r border-divider py-2 pl-12 pr-2 text-xs font-medium">
      {controls === 'none' ? (
        <span className="flex-none text-neutral-600">{icon}</span>
      ) : (
        <button
          type="button"
          className={cn(
            'grid h-[var(--h-ctl-sm)] w-7 flex-none place-items-center rounded-sm border font-mono text-2xs font-semibold',
            targeted ? 'border-accent-600 bg-accent-600 text-bg' : 'border-divider bg-bg text-neutral-500 hover:bg-neutral-100',
          )}
          aria-label={t`设为目标轨道 ${label}`}
          aria-pressed={targeted}
          onClick={() => track === undefined ? undefined : onTargetTrack?.(track.id)}
        >
          {controls === 'video' ? 'V1' : controls === 'audio' ? 'A1' : 'T1'}
        </button>
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {track === undefined ? null : (
        <span className="flex flex-none items-center text-neutral-500">
          {controls === 'none' || controls === 'text' ? null : (
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
          )}
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
          {removable ? (
            <>
              <button type="button" className="grid size-5 place-items-center rounded-sm hover:bg-neutral-100 disabled:text-neutral-300" aria-label={t`上移轨道 ${track.name}`} disabled={readOnly || track.locked || !canMoveUp} onClick={() => onMoveTrack?.(track.id, -1)}><ChevronUp className="size-3" aria-hidden="true" /></button>
              <button type="button" className="grid size-5 place-items-center rounded-sm hover:bg-neutral-100 disabled:text-neutral-300" aria-label={t`下移轨道 ${track.name}`} disabled={readOnly || track.locked || !canMoveDown} onClick={() => onMoveTrack?.(track.id, 1)}><ChevronDown className="size-3" aria-hidden="true" /></button>
              <button
                type="button"
                className="grid size-5 place-items-center rounded-sm hover:bg-fail-surface hover:text-fail-text"
                aria-label={t`删除轨道 ${track.name}`}
                disabled={readOnly || track.locked}
                onClick={() => onRemoveTrack?.(track.id)}
              >
                <Trash2 className="size-3" aria-hidden="true" />
              </button>
            </>
          ) : null}
        </span>
      )}
    </div>
  );
}

const TimelineMarkerRow = memo(function TimelineMarkerRow({ markers, scale, contentWidth, ticks, onSeek, onEditMarker }: {
  readonly markers: readonly EditorMarker[];
  readonly scale: ReturnType<typeof createTimeScale>;
  readonly contentWidth: number;
  readonly ticks: ReturnType<typeof rulerTicks>;
  readonly onSeek: (seconds: number) => void;
  readonly onEditMarker: (marker: EditorMarker) => void;
}) {
  return (
    <div className="grid min-h-0 grid-cols-[var(--w-track-head)_minmax(0,1fr)] border-b border-divider" role="row" aria-label={t`标记`}>
      <TimelineTrackHead icon={<Bookmark className="size-4" />} label={t`标记`} controls="none" />
      <div className="relative min-h-0 overflow-hidden" style={{ width: contentWidth }}>
        <TimelineGrid ticks={ticks} />
        {markers.map((marker) => (
          <button
            key={marker.id}
            type="button"
            className="absolute inset-y-1 z-10 flex items-center gap-1.5 text-2xs text-neutral-700 hover:bg-neutral-100 focus-visible:ring-1 focus-visible:ring-accent-500"
            style={{ left: timeToPx(scale, marker.time) }}
            aria-label={t`标记 ${marker.label} ${formatMillisecondTimecode(marker.time)}`}
            onClick={() => onSeek(marker.time)}
            onDoubleClick={() => onEditMarker(marker)}
          >
            <span className="h-full w-1.5" style={{ backgroundColor: marker.color }} aria-hidden="true" />
            <span className="whitespace-nowrap">{marker.label}</span>
          </button>
        ))}
      </div>
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
