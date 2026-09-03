import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  Bookmark,
  Camera,
  Captions,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Diamond,
  Download,
  Ellipsis,
  Eye,
  Link2,
  LockKeyhole,
  Magnet,
  MoveHorizontal,
  MoveRight,
  Repeat2,
  SquarePlus,
  Star,
  Type,
  Scissors,
  Volume2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { useAssetWaveform, useRecordedClipWaveform } from '../../data/mediaAssets';
import { useNativeShell } from '../../data/nativeShell';
import { ReviewPanel } from '../../design/review/ReviewPanel';
import { OverflowMenu } from '../../design/layout';
import { Dialog, Drawer, Tooltip } from '../../design/feedback';
import { Button, cn } from '../../design/primitives';
import {
  MAX_ZOOM,
  createFittedTimeScale,
  formatMillisecondTimecode,
  pxToTime,
  rulerTicks,
  timelineFollowScroll,
  timeToPx,
  type TimeScale,
  zoomAtAnchor,
} from '../../design/timeline/timeScale';
import {
  DEFAULT_EDITOR_TEXT_BACKGROUND,
  DEFAULT_EDITOR_TEXT_COLOR,
  DEFAULT_TIMELINE_MARKER_COLOR,
} from '../../design/timeline';
import {
  formatTimelinePosition,
  parseTimelinePosition,
  type TimelineTimeDisplayMode,
} from '../../design/timeline/timelineTimecode';
import { Waveform } from '../media';
import type {
  EditingDocument,
  EditorMarker,
  ExportJobRecord,
  NestedSequenceMedia,
  ProjectChangeGroup,
  TimelineClip,
  TimelineClipMaterializationState,
  TimelineTrack,
} from '../../shared/desktop/dto';
import {
  hasTimelineDelta,
  projectStoryTimelineChanges,
  type TimelineClipChange,
} from './timelineChangeProjection';
import { timelineTrackLayout } from './timelineTrackLayout';
import { TimelineFilmstrip } from './TimelineFilmstrip';
import { TimelineToolStrip, type TimelineEditTool } from './TimelineToolStrip';
import type { TimelineThumbnailMode } from './timelineFilmstripGeometry';
import { resolveTimelineMaterial } from './timelineMaterial';
import { planTimelineAddEdit } from './timelineAddEdit';
import { timelineSelectionState, timelineTrackSelection } from './timelineSelection';
import {
  clearTimelineClipSyncReference,
  restoreTimelineClipSync,
  timelineClipOutOfSyncFrames,
  unlinkTimelineClipWithSyncReference,
} from './timelineSyncStatus';
import { adjacentMarker, adjacentTimelineTime, timelineEditPoints } from './timelineNavigation';
import {
  applyTimelineCutTransition,
  planDefaultTimelineTransitions,
  setTimelineTransitionDuration,
  timelineCutTransition,
  timelineTransition,
  type TimelineCutTransition,
  type TimelineTransitionAlignment,
} from './timelineTransitions';
import {
  planTimelinePasteInsert,
  planTimelinePasteOverwrite,
  resolveTimelinePasteTargets,
  type TimelineClipboard,
} from './timelinePaste';
import { pasteTimelineClipAttributes, type TimelinePasteAttributeSelection } from './timelinePasteAttributes';
import {
  clearProjectMediaDrag,
  hasProjectMediaDrag,
  readProjectMediaDrag,
  type ProjectMediaDragPayload,
} from './mediaDrag';
import { clipLocalTimeAtTimeline, evaluateClipKeyframeProperty, setClipVolumeAtTime } from './keyframeEditing';
import { closeAllTimelineGaps, closeTimelineGap, timelineGaps, type TimelineGap } from './timelineGaps';
import { repeatedFrameClipIds, timelineThroughEditCuts } from './timelineDisplayEvidence';
import {
  evaluateTrackAudioProperty,
  moveTrackAudioKeyframe,
  removeTrackAudioKeyframe,
  setTrackAudioAtTime,
  trackAudioKeyframeAtTime,
  upsertTrackAudioKeyframe,
  type TrackAudioProperty,
} from './trackAudioEditing';
import { readTimelineClipboard, writeTimelineClipboard } from './timelineWorkspaceSession';
import { MarkerEditorFields, normalizeEditorMarker } from './MarkerEditorFields';
import { adjacentCaptionClip, serializeCaptionSrt, timelineCaptionClips } from './captionEditing';
import { projectRenderPreviewSegments } from './renderPreview';
import {
  deleteRippleClips,
  extractTimelineRange,
  liftTimelineRange,
  moveRippleClip,
  moveRippleClipGroup,
  moveFreeClipGroup,
  planCrossTrackMove,
  trimFreeClipGroup,
  trimRippleClipGroup,
  timelineClipsInRange,
  trimRippleClip,
  rippleTrimTrackClip,
  type TimelineCrossTrackMovePlan,
} from './timelineEditing';
import {
  clipMediaDuration,
  clipLocalTimeAtSourceTime,
  clipSourceTimeAtLocalTime,
  canRollTimelineEdit,
  canRateStretchTimelineClip,
  canSlideTimelineClip,
  canSlipTimelineClip,
  constrainClipGroupSlipDelta,
  constrainClipGroupTrimDelta,
  adjustLinearGainByTrackDelta,
  dbToLinearGain,
  gainToTrackPercent,
  linearGainToDb,
  MAX_CLIP_GAIN_DB,
  MIN_CLIP_GAIN_DB,
  setClipSpeedSegmentSpeed,
  slipTimelineClip,
  timelineEdgeScrollStep,
  moveTimelineClip,
  resolveTimelineSnap,
  rollTimelineEdit,
  rollTimelineEdits,
  rateStretchTimelineClip,
  slideTimelineClip,
  snapTimeToFrame,
  splitClipSpeedSegment,
  trimTimelineClip,
  type TimelineRollingPreview,
  type TimelineSlidePreview,
} from './timelineInteraction';


interface SelectedTimelineTransition {
  readonly trackId: string;
  readonly clipId: string;
  readonly channel: 'video' | 'audio';
  readonly edge: 'in' | 'out';
}

interface SelectedTimelineGap extends TimelineGap {
  readonly trackId: string;
}

interface TimelineDisplaySettings {
  readonly names: boolean;
  readonly thumbnailMode: TimelineThumbnailMode;
  readonly waveforms: boolean;
  readonly keyframes: boolean;
  readonly repeatedFrames: boolean;
  readonly throughEdits: boolean;
}

export interface TimelineMediaDrop {
  readonly assetId: string;
  readonly trackId: string;
  readonly timeSeconds: number;
  readonly mode: 'insert' | 'overwrite';
}

export interface ProjectTimelineProps {
  readonly docked?: boolean;
  readonly project: ProjectTimelineProject;
  readonly evidence: ProjectTimelineEvidence;
  readonly selection: ProjectTimelineSelection;
  readonly transport: ProjectTimelineTransport;
  readonly editing: ProjectTimelineEditing;
  readonly services: ProjectTimelineServices;
  readonly history: ProjectTimelineHistory;
}

export interface ProjectTimelineProject {
  readonly id: string;
  readonly revision: number;
  readonly document: EditingDocument;
  readonly readOnly: boolean;
}

export interface ProjectTimelineEvidence {
  readonly deliveryStateByClipId?: ReadonlyMap<string, TimelineClipMaterializationState>;
  readonly sourceMarkersByAssetId?: ReadonlyMap<string, readonly EditorMarker[]>;
  readonly renderPreviews?: readonly ExportJobRecord[];
  readonly renderPreviewPending?: boolean;
  readonly nestedSequenceMediaByClipId?: ReadonlyMap<string, NestedSequenceMedia>;
  readonly nestedSequencePending?: boolean;
  readonly reviewGroup: ProjectChangeGroup | null;
}

export interface ProjectTimelineSelection {
  readonly selectedClipId: string | null;
  readonly selectedClipIds: readonly string[];
  readonly targetTrackId: string | null;
  readonly targetTrackIds: readonly string[];
  readonly syncLockedTrackIds: readonly string[];
  readonly linkedSelectionEnabled: boolean;
  readonly onSelectClip: (clipId: string, additive?: boolean, range?: boolean) => void;
  readonly onSelectClips: (clipIds: readonly string[]) => void;
  readonly onPromoteClip: (clipId: string) => void;
  readonly onTargetTrack: (trackId: string, kind: TimelineTrack['kind']) => void;
  readonly onToggleSyncLock: (trackId: string, kind: TimelineTrack['kind'], allOfKind: boolean) => void;
  readonly onToggleLinkedSelection: () => void;
  readonly onInspectClip: (clipId: string) => void;
  readonly onMatchFrame: (clipId: string, sourceTime: number) => void;
}

export interface ProjectTimelineTransport {
  readonly timelineTimeSeconds: number;
  readonly rangeInSeconds: number | null;
  readonly rangeOutSeconds: number | null;
  readonly playing: boolean;
  readonly loopPlaybackEnabled: boolean;
  readonly onSeek: (seconds: number) => void;
  readonly onRangeChange: (rangeInSeconds: number | null, rangeOutSeconds: number | null) => void;
  readonly onTogglePlayback: () => void;
  readonly onToggleLoopPlayback: () => void;
  readonly onShuttle: (direction: -1 | 0 | 1) => void;
}

export interface ProjectTimelineEditing {
  readonly onReplaceClip: (clip: TimelineClip) => void;
  readonly onReplaceTrack: (track: TimelineTrack) => void;
  readonly onReplaceTrackClips: (trackId: string, clips: readonly TimelineClip[]) => void;
  readonly onReplaceTrackClipGroups: (
    groups: readonly { readonly trackId: string; readonly clips: readonly TimelineClip[] }[],
    markers?: readonly EditorMarker[],
  ) => void;
  readonly onApplyCrossTrackMove: (plan: TimelineCrossTrackMovePlan) => void;
  readonly onReplaceClips: (clips: readonly TimelineClip[], intent: 'link' | 'group') => void;
  readonly onPreviewClips: (clips: readonly TimelineClip[]) => void;
  readonly onPreviewRollingEdit: (preview: TimelineRollingPreview | null) => void;
  readonly onPreviewSlideEdit: (preview: TimelineSlidePreview | null) => void;
  readonly onTrimPlaybackRangeChange: (range: { readonly start: number; readonly end: number } | null) => void;
  readonly onInsertTrack: (track: TimelineTrack, index: number) => void;
  readonly onRemoveTrack: (trackId: string) => void;
  readonly onReorderTracks: (trackIds: readonly string[]) => void;
  readonly onReplaceMarkers: (markers: readonly EditorMarker[]) => void;
  readonly onReplaceSettings: (settings: EditingDocument['settings']) => void;
  readonly onDropMediaAsset: (drop: TimelineMediaDrop) => void;
}

export interface ProjectTimelineServices {
  readonly onRenderPreview?: ((start: number, end: number) => void) | undefined;
  readonly onClearRenderPreviews?: (() => void) | undefined;
  readonly onCreateNestedSequence?: ((clipIds: readonly string[], name: string) => void) | undefined;
  readonly onOpenNestedSequence?: ((projectId: string) => void) | undefined;
  readonly onRefreshNestedSequence?: ((clipId: string) => void) | undefined;
}

export interface ProjectTimelineHistory {
  readonly canUndo: boolean;
  readonly onUndo: () => void;
  readonly canRedo: boolean;
  readonly onRedo: () => void;
}

interface RenderedTrack {
  readonly id: string;
  readonly kind: 'video' | 'audio' | 'text' | 'caption';
  readonly targetLabel: string;
  readonly label: string;
  readonly ariaLabel: string;
  readonly clips: readonly TimelineClip[];
  readonly controls: 'video' | 'audio' | 'text' | 'caption' | 'none';
  readonly icon: React.ReactNode;
  readonly track: TimelineTrack;
  readonly derivedAudio: boolean;
}

const MIN_TRACK_HEIGHT = 32;
const MAX_TRACK_HEIGHT = 180;
const EMPTY_DELIVERY_STATES = new Map<string, TimelineClipMaterializationState>();
const EMPTY_SOURCE_MARKERS = new Map<string, readonly EditorMarker[]>();
const EMPTY_NESTED_SEQUENCE_MEDIA = new Map<string, NestedSequenceMedia>();

function defaultTrackHeight(track: RenderedTrack): number {
  if (track.kind === 'video') return 84;
  if (track.kind === 'audio') return 64;
  return 52;
}

/**
 * Deep Timeline Module over the canonical Editing Document.
 *
 * It owns one time geometry for ruler, Timeline Placement, markers, events,
 * and playhead. It never creates a second editable timeline model.
 */
export function ProjectTimeline({
  docked = false,
  project: {
    id: projectId,
    revision: projectRevision,
    document,
    readOnly,
  },
  evidence: {
    deliveryStateByClipId = EMPTY_DELIVERY_STATES,
    sourceMarkersByAssetId = EMPTY_SOURCE_MARKERS,
    renderPreviews = [],
    renderPreviewPending = false,
    nestedSequenceMediaByClipId = EMPTY_NESTED_SEQUENCE_MEDIA,
    nestedSequencePending = false,
    reviewGroup,
  },
  selection: {
    selectedClipId,
    selectedClipIds,
    targetTrackId,
    targetTrackIds,
    syncLockedTrackIds,
    linkedSelectionEnabled,
    onSelectClip,
    onSelectClips,
    onPromoteClip,
    onTargetTrack,
    onToggleSyncLock,
    onToggleLinkedSelection,
    onInspectClip,
    onMatchFrame,
  },
  transport: {
    timelineTimeSeconds,
    rangeInSeconds,
    rangeOutSeconds,
    playing: transportPlaying,
    loopPlaybackEnabled,
    onSeek,
    onRangeChange,
    onTogglePlayback,
    onToggleLoopPlayback,
    onShuttle,
  },
  editing: {
    onReplaceClip,
    onReplaceTrack,
    onReplaceTrackClips,
    onReplaceTrackClipGroups,
    onApplyCrossTrackMove,
    onReplaceClips,
    onPreviewClips,
    onPreviewRollingEdit,
    onPreviewSlideEdit,
    onTrimPlaybackRangeChange,
    onInsertTrack,
    onRemoveTrack,
    onReorderTracks,
    onReplaceMarkers,
    onReplaceSettings,
    onDropMediaAsset,
  },
  services: {
    onRenderPreview,
    onClearRenderPreviews,
    onCreateNestedSequence,
    onOpenNestedSequence,
    onRefreshNestedSequence,
  },
  history: {
    canUndo,
    onUndo,
    canRedo,
    onRedo,
  },
}: ProjectTimelineProps) {
  const nativeShell = useNativeShell();
  const viewportRef = useRef<HTMLDivElement>(null);
  const timelinePanelRef = useRef<HTMLDivElement>(null);
  const timelineWheelHandlerRef = useRef<(event: WheelEvent) => void>(() => undefined);
  const [viewportWidth, setViewportWidth] = useState(1_000);
  const [zoomMultiplier, setZoomMultiplier] = useState(1);
  const [timeDisplayMode, setTimeDisplayMode] = useState<TimelineTimeDisplayMode>('timecode');
  const [displaySettings, setDisplaySettings] = useState<TimelineDisplaySettings>({
    names: true,
    thumbnailMode: 'head',
    waveforms: true,
    keyframes: true,
    repeatedFrames: true,
    throughEdits: true,
  });
  const [smoothScrollEnabled, setSmoothScrollEnabled] = useState(false);
  const [editTool, setEditTool] = useState<TimelineEditTool>('selection');
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [rollingPreviewTime, setRollingPreviewTime] = useState<number | null>(null);
  const [ratePreviewDuration, setRatePreviewDuration] = useState<number | null>(null);
  const [slidePreviewTime, setSlidePreviewTime] = useState<number | null>(null);
  const [mediaDropPreview, setMediaDropPreview] = useState<(ProjectMediaDragPayload & {
    readonly trackId: string;
    readonly timeSeconds: number;
    readonly mode: 'insert' | 'overwrite';
  }) | null>(null);
  const [changeFilter, setChangeFilter] = useState<'all' | 'selected'>('all');
  const [scrollLeft, setScrollLeft] = useState(0);
  const [snapGuideTime, setSnapGuideTime] = useState<number | null>(null);
  const [markerDraft, setMarkerDraft] = useState<EditorMarker | null>(null);
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null);
  const [selectedEditPoint, setSelectedEditPoint] = useState<{ readonly clipId: string; readonly edge: 'start' | 'end' } | null>(null);
  const [trimModeEdit, setTrimModeEdit] = useState<{ readonly trackId: string; readonly leftClipId: string; readonly rightClipId: string; readonly editTime: number } | null>(null);
  const [additionalTrimModeEdits, setAdditionalTrimModeEdits] = useState<readonly { readonly trackId: string; readonly leftClipId: string; readonly rightClipId: string; readonly editTime: number }[]>([]);
  const activeTrimModeEdits = trimModeEdit === null ? [] : [trimModeEdit, ...additionalTrimModeEdits];
  const selectedTrimModeEditKeys = useMemo(() => new Set(activeTrimModeEdits.map((edit) => (
    `${edit.trackId}:${edit.leftClipId}:${edit.rightClipId}`
  ))), [additionalTrimModeEdits, trimModeEdit]);
  const [textDraft, setTextDraft] = useState<{
    readonly kind: 'text' | 'caption';
    readonly start: number;
    readonly maximumDuration: number;
    readonly content: string;
    readonly duration: number;
  } | null>(null);
  const [nestedSequenceName, setNestedSequenceName] = useState<string | null>(null);
  const [crossTrackTargetId, setCrossTrackTargetId] = useState<string | null>(null);
  const [trackHeights, setTrackHeights] = useState<Readonly<Record<string, number>>>({});
  const [collapsedTrackRows, setCollapsedTrackRows] = useState<ReadonlySet<string>>(new Set());
  const [marqueeBounds, setMarqueeBounds] = useState<{
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  } | null>(null);
  const marqueeGesture = useRef<{
    readonly pointerId: number;
    readonly startClientX: number;
    readonly startClientY: number;
    readonly startContentX: number;
    readonly startContentY: number;
    readonly additive: boolean;
    readonly initialSelection: readonly string[];
    active: boolean;
    lastClientX: number;
    lastClientY: number;
  } | null>(null);
  const handGesture = useRef<{
    readonly pointerId: number;
    readonly clientX: number;
    readonly clientY: number;
    readonly scrollLeft: number;
    readonly scrollTop: number;
  } | null>(null);
  const marqueeScrollFrameRef = useRef<number | null>(null);
  const marqueeWindowMouseUpRef = useRef<(() => void) | null>(null);
  const [clipboard, setClipboard] = useState<TimelineClipboard | null>(null);
  const [transitionClipboard, setTransitionClipboard] = useState<TimelineCutTransition | null>(null);
  const [selectedTransition, setSelectedTransition] = useState<SelectedTimelineTransition | null>(null);
  const [selectedGap, setSelectedGap] = useState<SelectedTimelineGap | null>(null);
  const [pasteAttributesOpen, setPasteAttributesOpen] = useState(false);
  const [pasteAttributeSelection, setPasteAttributeSelection] = useState<TimelinePasteAttributeSelection>({
    transform: true,
    effects: true,
    keyframes: true,
    transitions: true,
    audio: false,
  });
  const [clipboardSessionProjectId, setClipboardSessionProjectId] = useState<string | null>(null);
  useEffect(() => {
    setClipboard(readTimelineClipboard(projectId, globalThis.localStorage));
    setClipboardSessionProjectId(projectId);
  }, [projectId]);
  useEffect(() => {
    if (clipboardSessionProjectId !== projectId) return;
    writeTimelineClipboard(projectId, globalThis.localStorage, clipboard);
  }, [clipboard, clipboardSessionProjectId, projectId]);
  useEffect(() => {
    if (selectedMarkerId !== null && !document.markers.some((marker) => marker.id === selectedMarkerId)) {
      setSelectedMarkerId(null);
    }
  }, [document.markers, selectedMarkerId]);
  const seekFrameRef = useRef<number | null>(null);
  const queuedSeekRef = useRef<number | null>(null);
  const pendingZoomScrollRef = useRef<number | null>(null);
  const timelineScrollLeftRef = useRef(scrollLeft);
  timelineScrollLeftRef.current = scrollLeft;
  const dragPointerXRef = useRef<number | null>(null);
  const dragScrollFrameRef = useRef<number | null>(null);
  const dragScrollUpdateRef = useRef<((scrollLeft: number) => void) | null>(null);
  const story = document.tracks.find((track) => track.id === document.story_track_id) ?? null;
  const clips = story?.clips ?? [];
  const selectedClip = document.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === selectedClipId) ?? null;
  const selectedTrack = document.tracks.find((track) => track.clips.some((clip) => clip.id === selectedClipId)) ?? null;
  const selectedTransitionTrack = selectedTransition === null
    ? null
    : document.tracks.find((track) => track.id === selectedTransition.trackId) ?? null;
  const selectedCutTransition = selectedTransition === null || selectedTransitionTrack === null
    ? null
    : timelineCutTransition(
        selectedTransitionTrack,
        selectedTransition.clipId,
        selectedTransition.channel,
        selectedTransition.edge,
        document.fps,
      );
  const selectedGapTrack = selectedGap === null
    ? null
    : document.tracks.find((track) => track.id === selectedGap.trackId) ?? null;
  useEffect(() => {
    if (selectedTransition === null) return;
    const track = document.tracks.find((candidate) => candidate.id === selectedTransition.trackId);
    if (track === undefined
      || !selectedClipIds.includes(selectedTransition.clipId)
      || !track.clips.some((clip) => clip.id === selectedTransition.clipId)) {
      setSelectedTransition(null);
    }
  }, [document.tracks, selectedClipIds, selectedTransition]);
  useEffect(() => {
    if (selectedGap === null) return;
    const exists = selectedGapTrack !== null && timelineGaps(selectedGapTrack.clips).some((gap) => (
      Math.abs(gap.start - selectedGap.start) <= 1e-6 && Math.abs(gap.end - selectedGap.end) <= 1e-6
    ));
    if (!exists) setSelectedGap(null);
  }, [selectedGap, selectedGapTrack]);
  const targetTrackIdSet = useMemo(() => new Set(targetTrackIds), [targetTrackIds]);
  const syncLockedTrackIdSet = useMemo(() => new Set(syncLockedTrackIds), [syncLockedTrackIds]);
  const targetedTracks = useMemo(
    () => document.tracks.filter((track) => targetTrackIdSet.has(track.id)),
    [document.tracks, targetTrackIdSet],
  );
  const {
    selectedClipIdSet,
    selectedTrackGroups,
    selectedClips,
    editableSelectedTrackGroups,
    sharedLinkGroupId,
    canChangeLinks,
    canGroup,
    canUngroup,
    canNestSelection,
    selectedNestedClip,
  } = useMemo(
    () => timelineSelectionState(document, selectedClipIds, readOnly),
    [document, readOnly, selectedClipIds],
  );
  const allTimelineClips = useMemo(() => document.tracks.flatMap((track) => track.clips), [document.tracks]);
  const outOfSyncFramesByClipId = useMemo(() => new Map(allTimelineClips.map((clip) => [
    clip.id,
    timelineClipOutOfSyncFrames(clip, allTimelineClips, document.fps),
  ])), [allTimelineClips, document.fps]);
  const canCreateNestedSequence = !nestedSequencePending && canNestSelection;
  const selectedNestedMedia = selectedNestedClip === null
    ? null
    : nestedSequenceMediaByClipId.get(selectedNestedClip.id) ?? null;
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
  const playheadSnapTimes = useMemo(() => [
    ...document.tracks.flatMap((track) => track.clips.flatMap((clip) => [
      clip.placement.start,
      clip.placement.start + clip.placement.duration,
    ])),
    ...document.markers.map((marker) => marker.time),
  ], [document.markers, document.tracks]);
  const activeSnapPoints = useMemo(
    () => snapEnabled ? snapPoints : [],
    [snapEnabled, snapPoints],
  );
  const renderedTracks = useMemo(() => buildRenderedTracks(document), [document]);
  const nonStoryTrackIds = useMemo(() => [...document.tracks]
    .filter((track) => track.id !== document.story_track_id)
    .sort((left, right) => left.order - right.order)
    .map((track) => track.id), [document.story_track_id, document.tracks]);
  const recordedCount = clips.filter((clip) => (
    timelineClipMaterialState(clip, deliveryStateByClipId.get(clip.id)) === 'recorded'
  )).length;
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

  const fitScale = createFittedTimeScale(viewportWidth, document.duration_seconds);
  const fitZoom = fitScale.zoom;
  const maximumZoomMultiplier = Math.max(1, MAX_ZOOM / fitZoom);
  const effectiveZoomMultiplier = Math.min(maximumZoomMultiplier, Math.max(1, zoomMultiplier));
  const scale = createFittedTimeScale(viewportWidth, document.duration_seconds, effectiveZoomMultiplier);
  const displayedDuration = ratePreviewDuration ?? document.duration_seconds;
  const contentWidth = Math.max(viewportWidth, timeToPx(scale, displayedDuration));
  const thumbnailWindowStartPx = Math.max(0, Math.floor(scrollLeft / 160) * 160 - 160);
  const thumbnailWindowEndPx = thumbnailWindowStartPx + viewportWidth + 320;
  const ticks = rulerTicks(scale, {
    toSeconds: displayedDuration,
    minMajorGapPx: 110,
    minMinorGapPx: 28,
  });
  const renderPreviewSegments = projectRenderPreviewSegments(renderPreviews, projectRevision);
  const previewRangeStart = rangeInSeconds === null || rangeOutSeconds === null
    ? null
    : Math.min(rangeInSeconds, rangeOutSeconds);
  const previewRangeEnd = rangeInSeconds === null || rangeOutSeconds === null
    ? null
    : Math.max(rangeInSeconds, rangeOutSeconds);
  useLayoutEffect(() => {
    const nextScrollLeft = pendingZoomScrollRef.current;
    const viewport = viewportRef.current;
    if (nextScrollLeft === null || viewport === null) return;
    pendingZoomScrollRef.current = null;
    viewport.scrollLeft = nextScrollLeft;
    timelineScrollLeftRef.current = nextScrollLeft;
    setScrollLeft(nextScrollLeft);
  }, [contentWidth, effectiveZoomMultiplier]);
  const setTimelineScroll = (requestedLeft: number, requestedTop?: number) => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const trackHead = Number.parseFloat(getComputedStyle(viewport).getPropertyValue('--w-track-head')) || 0;
    const maximumLeft = Math.max(0, trackHead + contentWidth - viewport.clientWidth);
    const nextLeft = Math.min(maximumLeft, Math.max(0, requestedLeft));
    viewport.scrollLeft = nextLeft;
    timelineScrollLeftRef.current = nextLeft;
    setScrollLeft(nextLeft);
    if (requestedTop !== undefined) {
      viewport.scrollTop = Math.min(
        Math.max(0, viewport.scrollHeight - viewport.clientHeight),
        Math.max(0, requestedTop),
      );
    }
  };
  const changeZoomMultiplier = (requested: number, requestedAnchorPx?: number) => {
    const nextMultiplier = Math.min(maximumZoomMultiplier, Math.max(1, requested));
    if (Math.abs(nextMultiplier - effectiveZoomMultiplier) <= 1e-6) return;
    const viewport = viewportRef.current;
    if (viewport !== null) {
      const trackHead = Number.parseFloat(getComputedStyle(viewport).getPropertyValue('--w-track-head')) || 0;
      const contentViewportWidth = Math.max(1, viewport.clientWidth - trackHead);
      const visiblePlayheadTime = rollingPreviewTime ?? slidePreviewTime ?? playheadSeconds;
      const playheadViewportPx = timeToPx(scale, visiblePlayheadTime) - viewport.scrollLeft;
      const anchorPx = requestedAnchorPx === undefined
        ? playheadViewportPx >= 0 && playheadViewportPx <= contentViewportWidth
          ? playheadViewportPx
          : contentViewportWidth / 2
        : Math.min(contentViewportWidth, Math.max(0, requestedAnchorPx));
      const nextScale = createFittedTimeScale(viewportWidth, document.duration_seconds, nextMultiplier);
      const nextContentWidth = Math.max(viewportWidth, timeToPx(nextScale, displayedDuration));
      const maximumScroll = Math.max(0, trackHead + nextContentWidth - viewport.clientWidth);
      pendingZoomScrollRef.current = Math.min(maximumScroll, zoomAtAnchor({
        from: scale,
        to: nextScale,
        scrollPx: viewport.scrollLeft,
        anchorPx,
      }));
    }
    setZoomMultiplier(nextMultiplier);
  };
  const scrollTimelinePage = (direction: -1 | 1) => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const trackHead = Number.parseFloat(getComputedStyle(viewport).getPropertyValue('--w-track-head')) || 0;
    setTimelineScroll(viewport.scrollLeft + direction * Math.max(1, viewport.clientWidth - trackHead));
  };
  const handleTimelineWheel = (event: WheelEvent) => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? Math.max(1, viewport.clientHeight)
        : 1;
    const deltaX = event.deltaX * unit;
    const deltaY = event.deltaY * unit;
    const primaryDelta = Math.abs(deltaY) >= Math.abs(deltaX) ? deltaY : deltaX;
    if (event.target instanceof Element && event.target.closest('[data-timeline-zoom-navigator]')) {
      event.preventDefault();
      changeZoomMultiplier(effectiveZoomMultiplier * (2 ** (-primaryDelta / 480)));
      return;
    }
    if (event.altKey) {
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      const trackHead = Number.parseFloat(getComputedStyle(viewport).getPropertyValue('--w-track-head')) || 0;
      const anchorPx = event.clientX - bounds.left - trackHead;
      changeZoomMultiplier(effectiveZoomMultiplier * (2 ** (-primaryDelta / 480)), anchorPx);
      return;
    }
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      setTimelineScroll(viewport.scrollLeft, viewport.scrollTop + primaryDelta);
      return;
    }
    const horizontalDelta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
    setTimelineScroll(viewport.scrollLeft + horizontalDelta);
  };
  timelineWheelHandlerRef.current = handleTimelineWheel;
  useEffect(() => {
    const panel = timelinePanelRef.current;
    if (panel === null) return;
    const handleWheel = (event: WheelEvent) => timelineWheelHandlerRef.current(event);
    panel.addEventListener('wheel', handleWheel, { passive: false });
    return () => panel.removeEventListener('wheel', handleWheel);
  }, []);
  const previousPlayheadSecondsRef = useRef(playheadSeconds);
  useLayoutEffect(() => {
    const playheadMoved = Math.abs(previousPlayheadSecondsRef.current - playheadSeconds) > 1e-6;
    previousPlayheadSecondsRef.current = playheadSeconds;
    if (!transportPlaying && !playheadMoved) return;
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const trackHead = Number.parseFloat(getComputedStyle(viewport).getPropertyValue('--w-track-head')) || 0;
    const contentViewportWidth = Math.max(1, viewport.clientWidth - trackHead);
    const playheadPx = timeToPx(scale, playheadSeconds);
    const next = transportPlaying && smoothScrollEnabled
      ? playheadPx - contentViewportWidth / 2
      : timelineFollowScroll({
          scrollPx: viewport.scrollLeft,
          playheadPx,
          viewportPx: contentViewportWidth,
          mode: transportPlaying ? 'page' : 'reveal',
        });
    if (Math.abs(next - viewport.scrollLeft) <= 0.01) return;
    setTimelineScroll(next);
  }, [contentWidth, playheadSeconds, scale, smoothScrollEnabled, transportPlaying]);
  const rowTemplate = [
    ...renderedTracks.map((track) => `${collapsedTrackRows.has(track.id)
      ? MIN_TRACK_HEIGHT
      : trackHeights[track.id] ?? defaultTrackHeight(track)}px`),
    '44px',
    '44px',
  ].join(' ');
  const updateTrackHeight = (rowId: string, height: number) => {
    setCollapsedTrackRows((current) => {
      if (!current.has(rowId)) return current;
      const next = new Set(current);
      next.delete(rowId);
      return next;
    });
    setTrackHeights((current) => ({
      ...current,
      [rowId]: Math.min(MAX_TRACK_HEIGHT, Math.max(MIN_TRACK_HEIGHT, height)),
    }));
  };
  const toggleTrackCollapse = (rowId: string) => {
    setCollapsedTrackRows((current) => {
      const next = new Set(current);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };
  const toggleDisplaySetting = (key: keyof TimelineDisplaySettings) => {
    setDisplaySettings((current) => ({ ...current, [key]: !current[key] }));
  };
  const clipCrossesTime = (clip: TimelineClip, time: number) => time > clip.placement.start + 0.5 / document.fps
    && time < clip.placement.start + clip.placement.duration - 0.5 / document.fps;
  const canAddEdit = !readOnly && targetedTracks.some((track) => (
    !track.locked && track.clips.some((clip) => clipCrossesTime(clip, editPlayheadSeconds))
  ));
  const canAddEditAll = !readOnly && document.tracks.some((track) => (
    !track.locked && track.clips.some((clip) => clipCrossesTime(clip, editPlayheadSeconds))
  ));
  const canDelete = !readOnly && editableSelectedTrackGroups.length > 0;
  const canCloseSelectedGap = !readOnly
    && selectedGap !== null
    && selectedGapTrack?.locked === false
    && selectedGapTrack.id !== document.story_track_id;
  const targetedGapTracks = targetedTracks.filter((track) => (
    !track.locked && track.id !== document.story_track_id && timelineGaps(track.clips).length > 0
  ));
  const canCloseAllGaps = !readOnly && targetedGapTracks.length > 0;
  const canCopy = selectedTrackGroups.length > 0;
  const selectedClipboard = canCopy ? timelineClipboardFromSelection(selectedTrackGroups) : null;
  const canToggleClipEnabled = !readOnly && editableSelectedTrackGroups.length > 0;
  const canPaste = !readOnly
    && clipboard !== null
    && resolveTimelinePasteTargets(document.tracks, targetTrackIdSet, clipboard) !== null;
  const canDuplicate = !readOnly
    && selectedClipboard !== null
    && resolveTimelinePasteTargets(document.tracks, targetTrackIdSet, selectedClipboard) !== null;
  const pasteAttributeSource = clipboard?.groups.flatMap((group) => group.clips)[0] ?? null;
  const canPasteAttributes = !readOnly && pasteAttributeSource !== null && editableSelectedTrackGroups.length > 0;
  const canCopyTransition = selectedCutTransition !== null;
  const canPasteTransition = !readOnly
    && selectedTransition !== null
    && selectedTransitionTrack?.locked === false
    && transitionClipboard?.channel === selectedTransition.channel;
  const rangeStart = rangeInSeconds === null || rangeOutSeconds === null
    ? null
    : Math.min(rangeInSeconds, rangeOutSeconds);
  const rangeEnd = rangeInSeconds === null || rangeOutSeconds === null
    ? null
    : Math.max(rangeInSeconds, rangeOutSeconds);
  const editableTargetedTracks = targetedTracks.filter((track) => !track.locked);
  const canEditRange = !readOnly
    && editableTargetedTracks.length > 0
    && rangeStart !== null
    && rangeEnd !== null
    && rangeEnd - rangeStart >= 1 / document.fps;
  const canLiftRange = canEditRange;
  const canExtractRange = canEditRange;
  const canRippleTrimToPlayhead = !readOnly
    && selectedClip !== null
    && selectedTrack?.id === document.story_track_id
    && !selectedTrack.locked
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
  const matchFrameClip = [...targetedTracks]
    .sort((left, right) => right.order - left.order)
    .flatMap((track) => track.clips)
    .find((clip) => editPlayheadSeconds >= clip.placement.start
      && editPlayheadSeconds < clip.placement.start + clip.placement.duration) ?? null;
  const matchFrame = () => {
    if (matchFrameClip === null) return;
    onMatchFrame(
      matchFrameClip.id,
      clipSourceTimeAtLocalTime(matchFrameClip, editPlayheadSeconds - matchFrameClip.placement.start),
    );
  };
  const extendSelectedEditToPlayhead = () => {
    if (readOnly || selectedEditPoint === null) return;
    const track = document.tracks.find((candidate) => candidate.clips.some((clip) => clip.id === selectedEditPoint.clipId));
    const clip = track?.clips.find((candidate) => candidate.id === selectedEditPoint.clipId);
    if (track === undefined || track.locked || clip === undefined) return;
    const replacement = trimTimelineClip(
      clip,
      selectedEditPoint.edge,
      editPlayheadSeconds,
      document.fps,
      clipMediaDuration(clip),
    );
    if (JSON.stringify(replacement.placement) === JSON.stringify(clip.placement)) return;
    onReplaceTrackClips(
      track.id,
      track.id === document.story_track_id
        ? trimRippleClip(track.clips, replacement)
        : track.clips.map((candidate) => candidate.id === clip.id ? replacement : candidate),
    );
  };
  const previewCrossTrackTarget = (sourceTrackId: string, candidateTrackId: string | null): string | null => {
    const source = document.tracks.find((track) => track.id === sourceTrackId);
    const target = document.tracks.find((track) => track.id === candidateTrackId);
    const storyBoundary = source?.id === document.story_track_id || target?.id === document.story_track_id;
    const storySupported = !storyBoundary
      || (source?.kind === 'video'
        && target?.kind === 'video'
        );
    const accepted = source !== undefined
      && target !== undefined
      && source.id !== target.id
      && !source.locked
      && !target.locked
      && source.kind === target.kind
      && storySupported
      ? target.id
      : null;
    setCrossTrackTargetId(accepted);
    return accepted;
  };
  const moveSelectionAcrossTrack = (
    sourceTrackId: string,
    targetTrackId: string,
    anchorClipId: string,
    proposedAnchorStart: number,
  ): boolean => {
    const source = document.tracks.find((track) => track.id === sourceTrackId);
    const anchor = source?.clips.find((clip) => clip.id === anchorClipId);
    if (source === undefined || anchor === undefined) return false;
    const selectedSource = editableSelectedTrackGroups.find((group) => group.track.id === sourceTrackId)?.clips ?? [anchor];
    const plan = planCrossTrackMove({
      tracks: document.tracks,
      storyTrackId: document.story_track_id,
      sourceTrackId,
      targetTrackId,
      clipIds: new Set(selectedSource.map((clip) => clip.id)),
      anchorClipId,
      proposedAnchorStart,
      fps: document.fps,
      audioTrackId: document.tracks.find((track) => track.kind === 'audio' && !track.locked)?.id ?? null,
      newAudioTrackName: t`音频 ${document.tracks.filter((track) => track.kind === 'audio').length + 1}`,
      followLinkedClips: linkedSelectionEnabled,
      createId: () => globalThis.crypto.randomUUID(),
    });
    if (plan === null) return false;
    const delta = proposedAnchorStart - anchor.placement.start;
    const updates = [...plan.updates];
    const plannedTrackIds = new Set(plan.updates.map((update) => update.trackId));
    for (const group of editableSelectedTrackGroups) {
      if (plannedTrackIds.has(group.track.id)) continue;
      const ids = new Set(group.clips.map((clip) => clip.id));
      const groupAnchor = group.clips[0];
      if (groupAnchor === undefined) continue;
      updates.push({
        trackId: group.track.id,
        clips: group.track.id === document.story_track_id
          ? moveRippleClipGroup(group.track.clips, ids, groupAnchor.id, groupAnchor.placement.start + delta)
          : moveFreeClipGroup(group.track.clips, ids, groupAnchor.id, groupAnchor.placement.start + delta, document.fps),
      });
    }
    onApplyCrossTrackMove({ ...plan, updates });
    onSelectClips([
      ...plan.movedClipIds,
      ...editableSelectedTrackGroups
        .filter((group) => group.track.id !== sourceTrackId)
        .flatMap((group) => group.clips.map((clip) => clip.id)),
    ]);
    return true;
  };
  const exitTrimMode = () => {
    setTrimModeEdit(null);
    setAdditionalTrimModeEdits([]);
    setRollingPreviewTime(null);
    onPreviewRollingEdit(null);
    onTrimPlaybackRangeChange(null);
  };
  const presentTrimModeEdits = (edits: typeof activeTrimModeEdits) => {
    const primary = edits[0];
    if (primary === undefined) {
      exitTrimMode();
      return;
    }
    setTrimModeEdit(primary);
    setAdditionalTrimModeEdits(edits.slice(1));
    setRollingPreviewTime(primary.editTime);
    onPreviewRollingEdit({
      leftClipId: primary.leftClipId,
      rightClipId: primary.rightClipId,
      editTime: primary.editTime,
    });
    onTrimPlaybackRangeChange({
      start: Math.max(0, primary.editTime - 1.5),
      end: Math.min(document.duration_seconds, primary.editTime + 1.5),
    });
    onSeek(primary.editTime);
  };
  const enterTrimMode = () => {
    const story = document.tracks.find((track) => track.id === document.story_track_id);
    if (story === undefined || story.locked) return;
    const points = rollingEditPoints(story.clips, document.fps);
    const selectedPoint = selectedEditPoint === null ? undefined : points.find((point) => (
      selectedEditPoint.edge === 'end'
        ? point.left.id === selectedEditPoint.clipId
        : point.right.id === selectedEditPoint.clipId
    ));
    const point = selectedPoint ?? [...points].sort((left, right) => (
      Math.abs(left.left.placement.start + left.left.placement.duration - editPlayheadSeconds)
      - Math.abs(right.left.placement.start + right.left.placement.duration - editPlayheadSeconds)
    ))[0];
    if (point === undefined) return;
    const editTime = point.left.placement.start + point.left.placement.duration;
    const preview = { trackId: story.id, leftClipId: point.left.id, rightClipId: point.right.id, editTime };
    setEditTool('rolling');
    presentTrimModeEdits([preview]);
    onShuttle(0);
  };
  const toggleTrimMode = () => trimModeEdit === null ? enterTrimMode() : exitTrimMode();
  const toggleTrimModeEdit = (edit: { readonly trackId: string; readonly leftClipId: string; readonly rightClipId: string; readonly editTime: number }) => {
    if (trimModeEdit === null) return;
    const key = `${edit.trackId}:${edit.leftClipId}:${edit.rightClipId}`;
    const index = activeTrimModeEdits.findIndex((candidate) => `${candidate.trackId}:${candidate.leftClipId}:${candidate.rightClipId}` === key);
    if (index >= 0) {
      if (activeTrimModeEdits.length === 1) return;
      presentTrimModeEdits(activeTrimModeEdits.filter((_, candidateIndex) => candidateIndex !== index));
    } else presentTrimModeEdits([...activeTrimModeEdits, edit]);
  };
  const adjustTrimMode = (frames: number) => {
    if (trimModeEdit === null || readOnly) return;
    const requestedDelta = frames / document.fps;
    const grouped = new Map<string, typeof activeTrimModeEdits>();
    for (const edit of activeTrimModeEdits) grouped.set(edit.trackId, [...(grouped.get(edit.trackId) ?? []), edit]);
    const preliminary = [...grouped].map(([trackId, edits]) => {
      const track = document.tracks.find((candidate) => candidate.id === trackId);
      if (track === undefined || track.locked) return null;
      const rolled = rollTimelineEdits(track.clips, edits, requestedDelta, document.fps);
      return rolled === null ? null : { track, rolled };
    });
    if (preliminary.some((item) => item === null)) return;
    const ready = preliminary.filter((item): item is NonNullable<typeof item> => item !== null);
    const delta = requestedDelta < 0
      ? Math.max(...ready.map((item) => item.rolled.delta))
      : Math.min(...ready.map((item) => item.rolled.delta));
    const updates = ready.map(({ track }) => {
      const edits = grouped.get(track.id)!;
      const rolled = rollTimelineEdits(track.clips, edits, delta, document.fps)!;
      return { trackId: track.id, clips: rolled.clips };
    });
    const nextEdits = activeTrimModeEdits.map((edit) => ({ ...edit, editTime: edit.editTime + delta }));
    onReplaceTrackClipGroups(updates);
    presentTrimModeEdits(nextEdits);
  };

  const addEditAt = ({
    time,
    allTracks = false,
    followLinkedClips = true,
    explicitTrackId = null,
    snap = false,
  }: {
    readonly time: number;
    readonly allTracks?: boolean;
    readonly followLinkedClips?: boolean;
    readonly explicitTrackId?: string | null;
    readonly snap?: boolean;
  }) => {
    if (readOnly) return;
    const editTime = snap && snapEnabled
      ? resolveTimelineSnap(
          time,
          [0],
          activeSnapPoints.map((point) => point.time),
          10 / scale.pixelsPerSecond,
        ).anchorTime
      : time;
    const plan = planTimelineAddEdit({
      tracks: document.tracks,
      targetTrackIds: explicitTrackId === null ? targetTrackIdSet : new Set([explicitTrackId]),
      timelineTime: snapTimeToFrame(editTime, document.fps),
      fps: document.fps,
      allTracks,
      followLinkedClips,
      createId: () => globalThis.crypto.randomUUID(),
    });
    if (plan === null) return;
    onReplaceTrackClipGroups(plan.updates);
    onSelectClips(plan.rightClipIds);
  };
  const addEdit = () => addEditAt({ time: editPlayheadSeconds });
  const addEditAll = () => addEditAt({ time: editPlayheadSeconds, allTracks: true });
  const defaultTransitionUpdates = (
    channel: 'video' | 'audio',
    mode: 'at_playhead' | 'selection',
    tracks = document.tracks,
  ) => planDefaultTimelineTransitions({
    tracks,
    storyTrackId: document.story_track_id,
    targetTrackIds: targetTrackIdSet,
    selectedClipIds: selectedClipIdSet,
    timelineTime: editPlayheadSeconds,
    channel,
    mode,
    fps: document.fps,
  });
  const applyDefaultTransition = (channel: 'video' | 'audio') => {
    if (readOnly) return;
    const updates = defaultTransitionUpdates(channel, 'at_playhead');
    if (updates.length > 0) onReplaceTrackClipGroups(updates);
  };
  const applyDefaultTransitionsToSelection = () => {
    if (readOnly) return;
    const videoUpdates = defaultTransitionUpdates('video', 'selection');
    const videoByTrack = new Map(videoUpdates.map((update) => [update.trackId, update.clips]));
    const tracksWithVideo = document.tracks.map((track) => ({
      ...track,
      clips: [...(videoByTrack.get(track.id) ?? track.clips)],
    }));
    const audioUpdates = defaultTransitionUpdates('audio', 'selection', tracksWithVideo);
    const updatesByTrack = new Map(videoUpdates.map((update) => [update.trackId, update]));
    for (const update of audioUpdates) updatesByTrack.set(update.trackId, update);
    if (updatesByTrack.size > 0) onReplaceTrackClipGroups([...updatesByTrack.values()]);
  };
  const closeSelectedGap = () => {
    if (!canCloseSelectedGap || selectedGap === null || selectedGapTrack === null) return;
    onReplaceTrackClips(selectedGapTrack.id, closeTimelineGap(selectedGapTrack.clips, selectedGap));
    setSelectedGap(null);
  };
  const closeAllTargetGaps = () => {
    if (!canCloseAllGaps) return;
    onReplaceTrackClipGroups(targetedGapTracks.map((track) => ({
      trackId: track.id,
      clips: closeAllTimelineGaps(track.clips),
    })));
    setSelectedGap(null);
  };
  const replaceSelectedCutTransition = (transition: TimelineCutTransition | null) => {
    if (readOnly || selectedTransition === null || selectedTransitionTrack === null || selectedTransitionTrack.locked) return;
    const clips = applyTimelineCutTransition(
      selectedTransitionTrack,
      selectedTransition.clipId,
      selectedTransition.channel,
      selectedTransition.edge,
      transition,
      document.fps,
    );
    if (JSON.stringify(clips) !== JSON.stringify(selectedTransitionTrack.clips)) {
      onReplaceTrackClips(selectedTransitionTrack.id, clips);
    }
  };
  const alignSelectedCutTransition = (alignment: Exclude<TimelineTransitionAlignment, 'custom_start'>) => {
    if (selectedCutTransition === null) return;
    replaceSelectedCutTransition({ ...selectedCutTransition, alignment });
  };
  const copySelectedTransition = () => {
    if (selectedCutTransition !== null) setTransitionClipboard(selectedCutTransition);
  };
  const pasteSelectedTransition = () => {
    if (canPasteTransition && transitionClipboard !== null) replaceSelectedCutTransition(transitionClipboard);
  };

  const deleteSelected = () => {
    if (!canDelete) return;
    const updates = editableSelectedTrackGroups.map(({ track, clips: selected }) => {
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
    if (selectedClipboard !== null) setClipboard(selectedClipboard);
  };
  const cutSelected = () => {
    if (!canCopy || !canDelete) return;
    copySelected();
    deleteSelected();
  };
  const toggleSelectedClipEnabled = () => {
    if (!canToggleClipEnabled) return;
    const enable = editableSelectedTrackGroups.some((group) => group.clips.some((clip) => !clip.placement.enabled));
    onReplaceTrackClipGroups(editableSelectedTrackGroups.map((group) => {
      const ids = new Set(group.clips.map((clip) => clip.id));
      return {
        trackId: group.track.id,
        clips: group.track.clips.map((clip) => ids.has(clip.id)
          ? { ...clip, placement: { ...clip.placement, enabled: enable } }
          : clip),
      };
    }));
  };
  const toggleSelectedClipLinks = () => {
    if (!canChangeLinks) return;
    if (sharedLinkGroupId !== null) {
      onReplaceClips(selectedClips.map(unlinkTimelineClipWithSyncReference), 'link');
      return;
    }
    const linkGroupId = globalThis.crypto.randomUUID();
    onReplaceClips(selectedClips.map((clip) => ({
      ...clearTimelineClipSyncReference(clip),
      link_group_id: linkGroupId,
    })), 'link');
  };
  const restoreClipSync = (clipId: string) => {
    const track = document.tracks.find((candidate) => candidate.clips.some((clip) => clip.id === clipId));
    const clip = track?.clips.find((candidate) => candidate.id === clipId);
    if (track === undefined || track.locked || track.id === document.story_track_id || clip === undefined) return;
    const replacement = restoreTimelineClipSync(clip, allTimelineClips, document.fps);
    if (replacement === clip) return;
    onReplaceClip(replacement);
  };
  const groupSelectedClips = () => {
    if (!canGroup) return;
    const groupId = globalThis.crypto.randomUUID();
    onReplaceClips(selectedClips.map((clip) => ({ ...clip, group_id: groupId })), 'group');
  };
  const ungroupSelectedClips = () => {
    if (!canUngroup) return;
    onReplaceClips(selectedClips.map((clip) => ({ ...clip, group_id: null })), 'group');
  };

  const pasteClipboard = (mode: 'overwrite' | 'insert') => {
    if (!canPaste || clipboard === null) return;
    const input = {
      tracks: document.tracks,
      targetTrackIds: targetTrackIdSet,
      clipboard,
      timelineTime: editPlayheadSeconds,
      createId: () => globalThis.crypto.randomUUID(),
    };
    const plan = mode === 'insert'
      ? planTimelinePasteInsert({ ...input, fps: document.fps })
      : planTimelinePasteOverwrite(input);
    if (plan === null) return;
    onReplaceTrackClipGroups(plan.updates);
    onSelectClips(plan.pastedClipIds);
  };
  const duplicateSelected = () => {
    if (!canDuplicate || selectedClipboard === null) return;
    const plan = planTimelinePasteOverwrite({
      tracks: document.tracks,
      targetTrackIds: targetTrackIdSet,
      clipboard: selectedClipboard,
      timelineTime: editPlayheadSeconds,
      createId: () => globalThis.crypto.randomUUID(),
    });
    if (plan === null) return;
    onReplaceTrackClipGroups(plan.updates);
    onSelectClips(plan.pastedClipIds);
  };
  const applyPasteAttributes = () => {
    if (!canPasteAttributes || pasteAttributeSource === null) return;
    onReplaceTrackClipGroups(editableSelectedTrackGroups.map((group) => {
      const ids = new Set(group.clips.map((clip) => clip.id));
      return {
        trackId: group.track.id,
        clips: group.track.clips.map((clip) => ids.has(clip.id)
          ? pasteTimelineClipAttributes(
              pasteAttributeSource,
              clip,
              pasteAttributeSelection,
              document.fps,
              () => globalThis.crypto.randomUUID(),
            )
          : clip),
      };
    }));
    setPasteAttributesOpen(false);
  };

  const addTrack = (kind: TimelineTrack['kind']) => {
    if (readOnly) return;
    const number = document.tracks.filter((track) => track.kind === kind).length + 1;
    const kindLabel = kind === 'video'
      ? t`视频`
      : kind === 'audio'
        ? t`音频`
        : kind === 'caption'
          ? t`字幕`
          : t`文字`;
    onInsertTrack({
      id: globalThis.crypto.randomUUID(),
      name: `${kindLabel} ${number}`,
      kind,
      order: document.tracks.length,
      muted: false,
      solo: false,
      volume: 1,
      pan: 0,
      keyframes: [],
      locked: false,
      hidden: false,
      clips: [],
    }, document.tracks.length);
  };
  const openTextClipDraft = (kind: 'text' | 'caption') => {
    if (readOnly) return;
    const frame = 1 / document.fps;
    const start = Math.min(editPlayheadSeconds, Math.max(0, document.duration_seconds - frame));
    const maximumDuration = Math.max(frame, document.duration_seconds - start);
    setTextDraft({
      kind,
      start,
      maximumDuration,
      content: kind === 'caption' ? t`字幕` : t`文字`,
      duration: Math.min(5, maximumDuration),
    });
  };
  const insertTextClip = () => {
    if (readOnly || textDraft === null) return;
    const content = textDraft.content.trim();
    const duration = snapTimeToFrame(
      Math.min(textDraft.maximumDuration, Math.max(1 / document.fps, textDraft.duration)),
      document.fps,
    );
    if (content === '' || duration < 1 / document.fps) return;
    const clipId = globalThis.crypto.randomUUID();
    const clip: TimelineClip = {
      id: clipId,
      name: content.slice(0, 80),
      capture_intent: null,
      material: { kind: 'planned' },
      placement: {
        start: textDraft.start,
        duration,
        source_in: 0,
        source_out: duration,
        speed: 1,
        reverse: false,
        frame_hold_source_time: null,
        volume: 1,
        pan: 0,
        enabled: true,
      },
      transform: { x: 0, y: textDraft.kind === 'caption' ? 360 : 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
      effects: [],
      transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null },
      text: {
        content,
        font_family: 'Arial',
        font_asset_id: null,
        font_size: textDraft.kind === 'caption' ? 48 : 72,
        color: DEFAULT_EDITOR_TEXT_COLOR,
        background: DEFAULT_EDITOR_TEXT_BACKGROUND,
        align: 'center',
      },
      metadata: {},
      group_id: null,
      link_group_id: null,
      keyframes: [],
      speed_segments: [],
    };
    const existing = document.tracks.find((track) => track.id === targetTrackId && track.kind === textDraft.kind && !track.locked)
      ?? document.tracks.find((track) => track.kind === textDraft.kind && !track.locked)
      ?? null;
    if (existing === null) {
      const number = document.tracks.filter((track) => track.kind === textDraft.kind).length + 1;
      const trackId = globalThis.crypto.randomUUID();
      onInsertTrack({
        id: trackId,
        name: `${textDraft.kind === 'caption' ? t`字幕` : t`文字`} ${number}`,
        kind: textDraft.kind,
        order: document.tracks.length,
        muted: false,
        solo: false,
        volume: 1,
        pan: 0,
        keyframes: [],
        locked: false,
        hidden: false,
        clips: [clip],
      }, document.tracks.length);
      onTargetTrack(trackId, textDraft.kind);
    } else {
      onReplaceTrackClips(existing.id, [...existing.clips, clip].sort((left, right) => (
        left.placement.start - right.placement.start || left.id.localeCompare(right.id)
      )));
      onTargetTrack(existing.id, textDraft.kind);
    }
    setTextDraft(null);
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
  const selectedMarker = selectedMarkerId === null
    ? null
    : document.markers.find((marker) => marker.id === selectedMarkerId) ?? null;
  const navigateEditPoint = (direction: -1 | 1, allTracks = false) => {
    const next = adjacentTimelineTime(timelineEditPoints({
      tracks: document.tracks,
      targetTrackIds: targetTrackIdSet,
      allTracks,
      duration: document.duration_seconds,
    }), playheadSeconds, direction, document.fps);
    if (next !== null) onSeek(next);
  };
  const navigateMarker = (direction: -1 | 1) => {
    const marker = adjacentMarker(document.markers, playheadSeconds, direction, document.fps);
    if (marker === null) return;
    setSelectedMarkerId(marker.id);
    onSeek(marker.time);
  };
  const captions = timelineCaptionClips(document.tracks);
  const navigateCaption = (direction: -1 | 1) => {
    const clip = adjacentCaptionClip(captions, playheadSeconds, direction);
    if (clip === null) return;
    onSelectClip(clip.id);
    onSeek(clip.placement.start);
  };
  const exportCaptions = () => {
    if (captions.length === 0 || !nativeShell.available) return;
    const bytes = new TextEncoder().encode(`\uFEFF${serializeCaptionSrt(document.tracks)}`);
    void nativeShell.saveBytes({
      title: t`导出字幕`,
      defaultFileName: 'captions.srt',
      filters: [{ name: 'SubRip', extensions: ['srt'] }],
      bytes,
    });
  };
  const addMarker = () => {
    if (readOnly) return;
    const existing = document.markers.find((marker) => Math.abs(marker.time - editPlayheadSeconds) <= 0.5 / document.fps);
    if (existing !== undefined) {
      setSelectedMarkerId(existing.id);
      setMarkerDraft({ ...existing });
      return;
    }
    const number = document.markers.length + 1;
    const marker: EditorMarker = {
      id: globalThis.crypto.randomUUID(),
      time: editPlayheadSeconds,
      duration: 0,
      label: t`标记 ${number}`,
      color: DEFAULT_TIMELINE_MARKER_COLOR,
      kind: 'comment',
      comment: '',
    };
    setSelectedMarkerId(marker.id);
    onReplaceMarkers([...document.markers, marker]);
  };
  const editSelectedMarker = () => {
    if (selectedMarker !== null) setMarkerDraft({ ...selectedMarker });
  };
  const deleteSelectedMarker = () => {
    if (readOnly || selectedMarker === null) return;
    onReplaceMarkers(document.markers.filter((marker) => marker.id !== selectedMarker.id));
    setSelectedMarkerId(null);
  };
  const clearMarkers = () => {
    if (readOnly || document.markers.length === 0) return;
    onReplaceMarkers([]);
    setSelectedMarkerId(null);
  };
  const editTargetedRange = (mode: 'lift' | 'extract') => {
    if (!canEditRange || rangeStart === null || rangeEnd === null) return;
    const copiedGroups = editableTargetedTracks.flatMap((track) => {
      const copied = timelineClipsInRange(track.clips, rangeStart, rangeEnd);
      return copied.length === 0 ? [] : [{ trackId: track.id, trackKind: track.kind, clips: copied }];
    });
    setClipboard(copiedGroups.length === 0 ? null : {
      originTime: rangeStart,
      duration: rangeEnd - rangeStart,
      groups: copiedGroups,
    });
    onReplaceTrackClipGroups(editableTargetedTracks.map((track) => ({
      trackId: track.id,
      clips: mode === 'lift'
        ? liftTimelineRange(track.clips, rangeStart, rangeEnd, globalThis.crypto.randomUUID())
        : extractTimelineRange(track.clips, rangeStart, rangeEnd, globalThis.crypto.randomUUID()),
    })), mode === 'extract'
      ? document.markers.filter((marker) => marker.time < rangeStart || marker.time >= rangeEnd)
      : undefined);
    onRangeChange(null, null);
  };
  const liftRange = () => editTargetedRange('lift');
  const extractRange = () => editTargetedRange('extract');
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
    if (dragScrollFrameRef.current !== null) cancelAnimationFrame(dragScrollFrameRef.current);
    if (marqueeScrollFrameRef.current !== null) cancelAnimationFrame(marqueeScrollFrameRef.current);
    if (marqueeWindowMouseUpRef.current !== null) window.removeEventListener('mouseup', marqueeWindowMouseUpRef.current);
  }, []);

  const timeAtClientX = (clientX: number) => {
    if (!Number.isFinite(clientX)) return null;
    const viewport = viewportRef.current;
    if (viewport === null) return null;
    const bounds = viewport.getBoundingClientRect();
    const trackHead = Number.parseFloat(getComputedStyle(viewport).getPropertyValue('--w-track-head')) || 0;
    const contentX = clientX - bounds.left - trackHead + viewport.scrollLeft;
    if (contentX < 0) return null;
    return Math.min(
      document.duration_seconds,
      snapTimeToFrame(pxToTime(scale, contentX), document.fps),
    );
  };

  const pointerTime = (event: React.PointerEvent<HTMLElement>) => {
    const time = timeAtClientX(event.clientX);
    if (time === null || !event.shiftKey) return time;
    return resolveTimelineSnap(
      time,
      [0],
      playheadSnapTimes,
      10 / scale.pixelsPerSecond,
    ).anchorTime;
  };

  const snapEditTime = (timeSeconds: number, bypass: boolean): number => {
    if (!snapEnabled || bypass) {
      setSnapGuideTime(null);
      return timeSeconds;
    }
    const snap = resolveTimelineSnap(
      timeSeconds,
      [0],
      snapPoints.map((point) => point.time),
      10 / scale.pixelsPerSecond,
    );
    setSnapGuideTime(snap.snapTime);
    return snap.anchorTime;
  };

  const canDropMediaOnTrack = (track: RenderedTrack, payload: ProjectMediaDragPayload) => (
    !readOnly
    && !track.track.locked
    && !track.derivedAudio
    && track.kind === payload.kind
  );

  const previewMediaDrop = (event: React.DragEvent<HTMLElement>, track: RenderedTrack) => {
    if (!hasProjectMediaDrag(event.dataTransfer)) return;
    const payload = readProjectMediaDrag(event.dataTransfer);
    if (payload === null || !canDropMediaOnTrack(track, payload)) {
      event.dataTransfer.dropEffect = 'none';
      if (mediaDropPreview?.trackId === track.track.id) setMediaDropPreview(null);
      setSnapGuideTime(null);
      return;
    }
    const rawTimeSeconds = timeAtClientX(event.clientX);
    if (rawTimeSeconds === null) return;
    const timeSeconds = snapEditTime(rawTimeSeconds, event.shiftKey);
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setMediaDropPreview({
      ...payload,
      trackId: track.track.id,
      timeSeconds,
      mode: event.ctrlKey || event.metaKey ? 'insert' : 'overwrite',
    });
  };

  const commitMediaDrop = (event: React.DragEvent<HTMLElement>, track: RenderedTrack) => {
    const payload = readProjectMediaDrag(event.dataTransfer);
    const rawTimeSeconds = timeAtClientX(event.clientX);
    const timeSeconds = rawTimeSeconds === null ? null : snapEditTime(rawTimeSeconds, event.shiftKey);
    setMediaDropPreview(null);
    setSnapGuideTime(null);
    clearProjectMediaDrag();
    if (payload === null || timeSeconds === null || !canDropMediaOnTrack(track, payload)) return;
    event.preventDefault();
    event.stopPropagation();
    onDropMediaAsset({
      assetId: payload.assetId,
      trackId: track.track.id,
      timeSeconds,
      mode: event.ctrlKey || event.metaKey ? 'insert' : 'overwrite',
    });
  };

  const seekFromPointer = (event: React.PointerEvent<HTMLElement>) => {
    const time = pointerTime(event);
    if (time !== null) onSeek(time);
  };

  const marqueeContentPosition = (clientX: number, clientY: number) => {
    const viewport = viewportRef.current;
    if (viewport === null) return null;
    const bounds = viewport.getBoundingClientRect();
    return {
      x: clientX - bounds.left + viewport.scrollLeft,
      y: clientY - bounds.top + viewport.scrollTop,
    };
  };

  const refreshMarqueeSelection = (clientX: number, clientY: number) => {
    const gesture = marqueeGesture.current;
    const viewport = viewportRef.current;
    if (gesture === null || viewport === null) return;
    const position = marqueeContentPosition(clientX, clientY);
    if (position === null) return;
    const bounds = {
      left: Math.min(gesture.startContentX, position.x),
      top: Math.min(gesture.startContentY, position.y),
      width: Math.abs(position.x - gesture.startContentX),
      height: Math.abs(position.y - gesture.startContentY),
    };
    setMarqueeBounds(bounds);
    const viewportBounds = viewport.getBoundingClientRect();
    const intersected = [...viewport.querySelectorAll<HTMLElement>('[data-timeline-clip-id]')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const contentRect = {
          left: rect.left - viewportBounds.left + viewport.scrollLeft,
          right: rect.right - viewportBounds.left + viewport.scrollLeft,
          top: rect.top - viewportBounds.top + viewport.scrollTop,
          bottom: rect.bottom - viewportBounds.top + viewport.scrollTop,
        };
        return contentRect.right >= bounds.left
          && contentRect.left <= bounds.left + bounds.width
          && contentRect.bottom >= bounds.top
          && contentRect.top <= bounds.top + bounds.height;
      })
      .map((element) => element.dataset.timelineClipId)
      .filter((clipId): clipId is string => clipId !== undefined);
    onSelectClips(gesture.additive
      ? [...new Set([...gesture.initialSelection, ...intersected])]
      : [...new Set(intersected)]);
  };

  const stopMarqueeAutoScroll = () => {
    if (marqueeScrollFrameRef.current !== null) cancelAnimationFrame(marqueeScrollFrameRef.current);
    marqueeScrollFrameRef.current = null;
  };

  const ensureMarqueeAutoScroll = () => {
    if (marqueeScrollFrameRef.current !== null) return;
    const tick = () => {
      const gesture = marqueeGesture.current;
      const viewport = viewportRef.current;
      if (gesture === null || !gesture.active || viewport === null) {
        marqueeScrollFrameRef.current = null;
        return;
      }
      const bounds = viewport.getBoundingClientRect();
      const trackHead = Number.parseFloat(getComputedStyle(viewport).getPropertyValue('--w-track-head')) || 0;
      const horizontalStep = timelineEdgeScrollStep(
        gesture.lastClientX,
        bounds.left + trackHead,
        bounds.right,
      );
      const verticalStep = timelineEdgeScrollStep(
        gesture.lastClientY,
        bounds.top,
        bounds.bottom,
        40,
        18,
      );
      const maximumLeft = Math.max(0, trackHead + contentWidth - viewport.clientWidth);
      const maximumTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const nextLeft = Math.min(maximumLeft, Math.max(0, viewport.scrollLeft + horizontalStep));
      const nextTop = Math.min(maximumTop, Math.max(0, viewport.scrollTop + verticalStep));
      if (Math.abs(nextLeft - viewport.scrollLeft) > 0.01 || Math.abs(nextTop - viewport.scrollTop) > 0.01) {
        viewport.scrollLeft = nextLeft;
        viewport.scrollTop = nextTop;
        timelineScrollLeftRef.current = nextLeft;
        setScrollLeft(nextLeft);
        refreshMarqueeSelection(gesture.lastClientX, gesture.lastClientY);
      }
      marqueeScrollFrameRef.current = requestAnimationFrame(tick);
    };
    marqueeScrollFrameRef.current = requestAnimationFrame(tick);
  };

  const finishMarqueeSelection = () => {
    stopMarqueeAutoScroll();
    if (marqueeWindowMouseUpRef.current !== null) {
      window.removeEventListener('mouseup', marqueeWindowMouseUpRef.current);
      marqueeWindowMouseUpRef.current = null;
    }
    marqueeGesture.current = null;
    setMarqueeBounds(null);
  };

  const updateMarqueeSelection = (event: React.PointerEvent<HTMLElement>) => {
    const gesture = marqueeGesture.current;
    if (gesture === null || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    gesture.lastClientX = event.clientX;
    gesture.lastClientY = event.clientY;
    const deltaX = Math.abs(event.clientX - gesture.startClientX);
    const deltaY = Math.abs(event.clientY - gesture.startClientY);
    if (!gesture.active && deltaX <= 5 && deltaY <= 5) return;
    gesture.active = true;
    refreshMarqueeSelection(event.clientX, event.clientY);
    ensureMarqueeAutoScroll();
    if (marqueeWindowMouseUpRef.current === null) {
      const finishFromWindow = () => finishMarqueeSelection();
      marqueeWindowMouseUpRef.current = finishFromWindow;
      window.addEventListener('mouseup', finishFromWindow, { once: true });
    }
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

  const updateDragAutoScroll = (clientX: number | null, onScroll?: (scrollLeft: number) => void) => {
    dragPointerXRef.current = clientX;
    if (clientX === null) dragScrollUpdateRef.current = null;
    else if (onScroll !== undefined) dragScrollUpdateRef.current = onScroll;
    if (clientX === null) {
      if (dragScrollFrameRef.current !== null) cancelAnimationFrame(dragScrollFrameRef.current);
      dragScrollFrameRef.current = null;
      return;
    }
    if (dragScrollFrameRef.current !== null) return;
    const tick = () => {
      const pointerX = dragPointerXRef.current;
      const viewport = viewportRef.current;
      if (pointerX === null || viewport === null) {
        dragScrollFrameRef.current = null;
        return;
      }
      const bounds = viewport.getBoundingClientRect();
      const trackHead = Number.parseFloat(getComputedStyle(viewport).getPropertyValue('--w-track-head')) || 0;
      const step = timelineEdgeScrollStep(pointerX, bounds.left + trackHead, bounds.right);
      if (step !== 0) {
        const maximum = Math.max(0, trackHead + contentWidth - viewport.clientWidth);
        const next = Math.min(maximum, Math.max(0, viewport.scrollLeft + step));
        if (Math.abs(next - viewport.scrollLeft) > 0.01) {
          viewport.scrollLeft = next;
          timelineScrollLeftRef.current = next;
          setScrollLeft(next);
          dragScrollUpdateRef.current?.(next);
        }
      }
      dragScrollFrameRef.current = requestAnimationFrame(tick);
    };
    dragScrollFrameRef.current = requestAnimationFrame(tick);
  };

  return (
    <div ref={timelinePanelRef} className="contents">
    <ReviewPanel
      className="relative flex min-h-0 select-none flex-col focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-500"
      aria-label={t`时间轴`}
      tabIndex={0}
      onPointerDownCapture={(event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement
          || target instanceof HTMLTextAreaElement
          || target instanceof HTMLSelectElement
          || (target instanceof HTMLElement && target.isContentEditable)) return;
        event.currentTarget.focus({ preventScroll: true });
      }}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
        if (event.key === ' ' && event.target instanceof HTMLButtonElement) return;
        if (event.key.toLowerCase() === 't' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          toggleTrimMode();
          return;
        }
        if (event.key === 'Escape' && trimModeEdit !== null) {
          event.preventDefault();
          exitTrimMode();
          return;
        }
        if (event.key === 'PageUp' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          scrollTimelinePage(-1);
          return;
        }
        if (event.key === 'PageDown' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          scrollTimelinePage(1);
          return;
        }
        if (event.key === '\\' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          changeZoomMultiplier(1);
          return;
        }
        if ((event.key === '=' || event.key === '+') && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          changeZoomMultiplier(effectiveZoomMultiplier * 1.25);
          return;
        }
        if (event.key === '-' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          changeZoomMultiplier(effectiveZoomMultiplier / 1.25);
          return;
        }
        if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight')
          && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          const direction = event.key === 'ArrowRight' ? 1 : -1;
          const frames = event.shiftKey ? 5 : 1;
          if (trimModeEdit !== null) {
            adjustTrimMode(direction * frames);
            return;
          }
          onSeek(Math.min(
            document.duration_seconds,
            Math.max(0, playheadSeconds + direction * frames / document.fps),
          ));
          return;
        }
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
          if (trimModeEdit !== null && transportPlaying) {
            const frames = Math.round((playheadSeconds - trimModeEdit.editTime) * document.fps);
            onShuttle(0);
            adjustTrimMode(frames);
            return;
          }
          onShuttle(0);
          return;
        }
        if (event.key.toLowerCase() === 'l' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          onShuttle(1);
          return;
        }
        if (event.key.toLowerCase() === 'h' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          setEditTool('hand');
          return;
        }
        if (event.key.toLowerCase() === 'z' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          setEditTool('zoom');
          return;
        }
        if (event.key.toLowerCase() === 'v' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          exitTrimMode();
          setEditTool('selection');
          onPreviewClips([]);
          setRollingPreviewTime(null);
          setRatePreviewDuration(null);
          setSlidePreviewTime(null);
          onPreviewRollingEdit(null);
          onPreviewSlideEdit(null);
          return;
        }
        if (event.key.toLowerCase() === 'a' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          setEditTool(event.shiftKey ? 'track_backward' : 'track_forward');
          onPreviewClips([]);
          setRollingPreviewTime(null);
          setRatePreviewDuration(null);
          setSlidePreviewTime(null);
          onPreviewRollingEdit(null);
          onPreviewSlideEdit(null);
          return;
        }
        if (event.key.toLowerCase() === 'y' && !event.ctrlKey && !event.metaKey && !event.altKey && !readOnly) {
          event.preventDefault();
          onShuttle(0);
          setEditTool('slip');
          onPreviewClips([]);
          setRollingPreviewTime(null);
          setRatePreviewDuration(null);
          setSlidePreviewTime(null);
          onPreviewRollingEdit(null);
          onPreviewSlideEdit(null);
          return;
        }
        if (event.key.toLowerCase() === 'b' && !event.ctrlKey && !event.metaKey && !event.altKey && !readOnly) {
          event.preventDefault();
          onShuttle(0);
          setEditTool('ripple');
          onPreviewClips([]);
          setRollingPreviewTime(null);
          setRatePreviewDuration(null);
          setSlidePreviewTime(null);
          onPreviewRollingEdit(null);
          onPreviewSlideEdit(null);
          return;
        }
        if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey && !event.altKey && !readOnly) {
          event.preventDefault();
          onShuttle(0);
          setEditTool('rolling');
          onPreviewClips([]);
          setRollingPreviewTime(null);
          setRatePreviewDuration(null);
          setSlidePreviewTime(null);
          onPreviewRollingEdit(null);
          onPreviewSlideEdit(null);
          return;
        }
        if (event.key.toLowerCase() === 'r' && !event.ctrlKey && !event.metaKey && !event.altKey && !readOnly) {
          event.preventDefault();
          onShuttle(0);
          setEditTool('rate');
          onPreviewClips([]);
          setRollingPreviewTime(null);
          setRatePreviewDuration(null);
          setSlidePreviewTime(null);
          onPreviewRollingEdit(null);
          onPreviewSlideEdit(null);
          return;
        }
        if (event.key.toLowerCase() === 'u' && !event.ctrlKey && !event.metaKey && !event.altKey && !readOnly) {
          event.preventDefault();
          onShuttle(0);
          setEditTool('slide');
          onPreviewClips([]);
          setRollingPreviewTime(null);
          setRatePreviewDuration(null);
          setSlidePreviewTime(null);
          onPreviewRollingEdit(null);
          onPreviewSlideEdit(null);
          return;
        }
        if (event.key.toLowerCase() === 'c' && !event.ctrlKey && !event.metaKey && !event.altKey && !readOnly) {
          event.preventDefault();
          onShuttle(0);
          setEditTool('razor');
          onPreviewClips([]);
          setRollingPreviewTime(null);
          setRatePreviewDuration(null);
          setSlidePreviewTime(null);
          onPreviewRollingEdit(null);
          onPreviewSlideEdit(null);
          return;
        }
        if (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey) && !event.altKey) {
          event.preventDefault();
          if (event.shiftKey) {
            if (canAddEditAll) addEditAll();
          } else if (canAddEdit) addEdit();
          return;
        }
        if (event.key.toLowerCase() === 'd' && (event.ctrlKey || event.metaKey) && !event.altKey) {
          event.preventDefault();
          applyDefaultTransition(event.shiftKey ? 'audio' : 'video');
          return;
        }
        if (event.key.toLowerCase() === 'd' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          applyDefaultTransitionsToSelection();
          return;
        }
        if (event.key === '/' && event.shiftKey && (event.ctrlKey || event.metaKey) && !event.altKey) {
          event.preventDefault();
          duplicateSelected();
          return;
        }
        if (event.key.toLowerCase() === 'v' && event.altKey && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          if (canPasteAttributes) setPasteAttributesOpen(true);
          return;
        }
        const clearRangeShortcut = event.altKey
          || (event.shiftKey && (event.ctrlKey || event.metaKey));
        if (clearRangeShortcut && event.key.toLowerCase() === 'i') {
          event.preventDefault();
          onRangeChange(null, rangeOutSeconds);
          return;
        }
        if (clearRangeShortcut && event.key.toLowerCase() === 'o') {
          event.preventDefault();
          onRangeChange(rangeInSeconds, null);
          return;
        }
        if (clearRangeShortcut && event.key.toLowerCase() === 'x') {
          event.preventDefault();
          onRangeChange(null, null);
          return;
        }
        if (event.key.toLowerCase() === 'c' && (event.ctrlKey || event.metaKey) && !event.altKey) {
          event.preventDefault();
          if (canCopyTransition) copySelectedTransition();
          else copySelected();
          return;
        }
        if (event.key.toLowerCase() === 'x' && (event.ctrlKey || event.metaKey) && !event.altKey) {
          event.preventDefault();
          cutSelected();
          return;
        }
        if (event.key.toLowerCase() === 'a' && (event.ctrlKey || event.metaKey) && !event.altKey) {
          event.preventDefault();
          onSelectClips(event.shiftKey
            ? []
            : targetedTracks.flatMap((track) => track.clips.map((clip) => clip.id)));
          return;
        }
        if (event.key.toLowerCase() === 'e' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          toggleSelectedClipEnabled();
          return;
        }
        if (event.key.toLowerCase() === 'e' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          extendSelectedEditToPlayhead();
          return;
        }
        if (event.key.toLowerCase() === 'f' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          matchFrame();
          return;
        }
        if (event.key.toLowerCase() === 'l' && (event.ctrlKey || event.metaKey) && !event.altKey) {
          event.preventDefault();
          toggleSelectedClipLinks();
          return;
        }
        if (event.key.toLowerCase() === 'g' && (event.ctrlKey || event.metaKey) && !event.altKey) {
          event.preventDefault();
          if (event.shiftKey) ungroupSelectedClips();
          else groupSelectedClips();
          return;
        }
        if (event.key.toLowerCase() === 'v' && (event.ctrlKey || event.metaKey) && !event.altKey && (canPasteTransition || canPaste)) {
          event.preventDefault();
          if (canPasteTransition) pasteSelectedTransition();
          else pasteClipboard(event.shiftKey ? 'insert' : 'overwrite');
          return;
        }
        if (event.key.toLowerCase() === 's' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          setSnapEnabled((enabled) => !enabled);
          return;
        }
        if (event.key.toLowerCase() === 'm' && event.altKey && event.shiftKey && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          clearMarkers();
          return;
        }
        if (event.key.toLowerCase() === 'm'
          && event.altKey
          && (event.ctrlKey || event.metaKey)
          && !event.shiftKey) {
          event.preventDefault();
          deleteSelectedMarker();
          return;
        }
        if (event.key.toLowerCase() === 'm' && event.shiftKey && (event.ctrlKey || event.metaKey) && !event.altKey) {
          event.preventDefault();
          navigateMarker(-1);
          return;
        }
        if (event.key.toLowerCase() === 'm' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          navigateMarker(1);
          return;
        }
        if (event.key.toLowerCase() === 'm' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          addMarker();
          return;
        }
        if (event.key.toLowerCase() === 'i' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          if (rangeInSeconds !== null) onSeek(rangeInSeconds);
          return;
        }
        if (event.key.toLowerCase() === 'o' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          if (rangeOutSeconds !== null) onSeek(rangeOutSeconds);
          return;
        }
        if (event.key.toLowerCase() === 'i' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          onRangeChange(editPlayheadSeconds, rangeOutSeconds);
          return;
        }
        if (event.key.toLowerCase() === 'o' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          onRangeChange(rangeInSeconds, editPlayheadSeconds);
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
        if ((event.key === ';' || event.key === ':') && event.shiftKey && !event.altKey) {
          event.preventDefault();
          navigateEditPoint(event.ctrlKey || event.metaKey ? -1 : 1);
          return;
        }
        if (event.key === ';' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && canLiftRange) {
          event.preventDefault();
          liftRange();
          return;
        }
        if (event.key === "'" && !event.ctrlKey && !event.metaKey && !event.altKey && canExtractRange) {
          event.preventDefault();
          extractRange();
          return;
        }
        if ((event.key === 'Delete' || event.key === 'Backspace') && canCloseSelectedGap) {
          event.preventDefault();
          closeSelectedGap();
          return;
        }
        if ((event.key === 'Delete' || event.key === 'Backspace') && canDelete) {
          event.preventDefault();
          deleteSelected();
          return;
        }
        if (event.key.toLowerCase() === 'z'
          && (event.ctrlKey || event.metaKey)
          && event.shiftKey
          && canRedo
          && !readOnly) {
          event.preventDefault();
          onRedo();
          return;
        }
        if (event.key.toLowerCase() === 'z'
          && (event.ctrlKey || event.metaKey)
          && !event.shiftKey
          && canUndo
          && !readOnly) {
          event.preventDefault();
          onUndo();
        }
      }}
    >
      <header className="flex h-[var(--h-panel-head)] flex-none items-center gap-2 border-b border-divider px-2">
        {docked ? null : <h2 className="text-base font-semibold"><Trans>时间轴（修改审阅）</Trans></h2>}
        {trimModeEdit === null ? null : (
          <Tooltip content={t`←/→ 调整 1 帧；Shift 调整 5 帧；Ctrl/Shift 点击剪辑点切换多选；Space 或 J/K/L 循环预览`} side="bottom">
            <span className="flex h-7 flex-none items-center gap-1.5 rounded-sm border border-accent-300 bg-accent-100 px-2 text-2xs text-accent-text" role="status">
              <strong><Trans>修剪模式</Trans> · {activeTrimModeEdits.length}</strong>
              <span className="font-mono">{formatMillisecondTimecode(trimModeEdit.editTime)}</span>
              <button type="button" className="rounded-sm px-1 hover:bg-accent-200" aria-label={t`退出修剪模式`} onClick={exitTrimMode}>×</button>
            </span>
          </Tooltip>
        )}
        {selectedCutTransition === null ? null : (
          <span className="flex h-7 flex-none items-center overflow-hidden rounded-sm border border-accent-300 bg-accent-100 text-2xs text-accent-text">
            <span className="max-w-28 truncate px-2 font-medium">{selectedCutTransition.channel === 'video' ? t`视频转场` : t`音频转场`} · {selectedCutTransition.kind}</span>
            {([
              ['end_at_cut', t`到剪辑点结束`],
              ['center_at_cut', t`以剪辑点为中心`],
              ['start_at_cut', t`从剪辑点开始`],
            ] as const).map(([alignment, label]) => (
              <Tooltip key={alignment} content={label} side="bottom">
                <button
                  type="button"
                  className={cn('h-7 border-l border-accent-200 px-1.5 font-mono hover:bg-accent-200', selectedCutTransition.alignment === alignment && 'bg-accent-200 font-semibold')}
                  aria-label={label}
                  aria-pressed={selectedCutTransition.alignment === alignment}
                  disabled={readOnly}
                  onClick={() => alignSelectedCutTransition(alignment)}
                >{alignment === 'end_at_cut' ? '◀|' : alignment === 'center_at_cut' ? '◀|▶' : '|▶'}</button>
              </Tooltip>
            ))}
          </span>
        )}
        <OverflowMenu
          label={t`添加到时间轴`}
          triggerLabel={<SquarePlus className="size-3.5" aria-hidden="true" />}
          align="start"
          triggerClassName="h-7 gap-1 rounded-sm border border-divider px-1.5 text-xs disabled:text-neutral-300"
          items={[
            { id: 'video', label: t`添加视频轨道`, disabled: readOnly, onSelect: () => addTrack('video') },
            { id: 'audio', label: t`添加音频轨道`, disabled: readOnly, onSelect: () => addTrack('audio') },
            { id: 'text', label: t`添加文字轨道`, disabled: readOnly, onSelect: () => addTrack('text') },
            { id: 'caption', label: t`添加字幕轨道`, disabled: readOnly, onSelect: () => addTrack('caption') },
            { id: 'text-clip', label: t`在播放头添加文字`, disabled: readOnly, onSelect: () => openTextClipDraft('text') },
            { id: 'caption-clip', label: t`在播放头添加字幕`, disabled: readOnly, onSelect: () => openTextClipDraft('caption') },
          ]}
        />
        {captions.length === 0 ? null : <span className="flex h-7 items-center overflow-hidden rounded-sm border border-divider">
          <Tooltip content={t`上一个字幕`} side="bottom">
            <button
              type="button"
              className="grid size-7 place-items-center hover:bg-neutral-100 disabled:text-neutral-300"
              aria-label={t`上一个字幕`}
              disabled={adjacentCaptionClip(captions, playheadSeconds, -1) === null}
              onClick={() => navigateCaption(-1)}
            ><ChevronLeft className="size-3.5" aria-hidden="true" /></button>
          </Tooltip>
          <Tooltip content={t`下一个字幕`} side="bottom">
            <button
              type="button"
              className="grid size-7 place-items-center border-l border-divider hover:bg-neutral-100 disabled:text-neutral-300"
              aria-label={t`下一个字幕`}
              disabled={adjacentCaptionClip(captions, playheadSeconds, 1) === null}
              onClick={() => navigateCaption(1)}
            ><ChevronRight className="size-3.5" aria-hidden="true" /></button>
          </Tooltip>
          <Tooltip content={nativeShell.available ? t`导出 SRT 字幕` : t`需要桌面应用才能导出 SRT`} side="bottom">
            <button
              type="button"
              className="grid size-7 place-items-center border-l border-divider hover:bg-neutral-100 disabled:text-neutral-300"
              aria-label={t`导出 SRT 字幕`}
              disabled={captions.length === 0 || !nativeShell.available}
              onClick={exportCaptions}
            ><Download className="size-3.5" aria-hidden="true" /></button>
          </Tooltip>
        </span>}
        <OverflowMenu
          label={t`剪辑操作`}
          triggerLabel={<><Scissors className="size-3.5" aria-hidden="true" /><Trans>剪辑</Trans></>}
          align="start"
          triggerClassName="h-7 rounded-sm border border-divider px-2 text-xs"
          items={[
            { id: 'add-edit', label: t`在播放头添加剪辑点`, disabled: !canAddEdit, onSelect: addEdit },
            { id: 'video-transition', label: t`应用默认视频转场`, disabled: readOnly || defaultTransitionUpdates('video', 'at_playhead').length === 0, onSelect: () => applyDefaultTransition('video') },
            { id: 'audio-transition', label: t`应用默认音频转场`, disabled: readOnly || defaultTransitionUpdates('audio', 'at_playhead').length === 0, onSelect: () => applyDefaultTransition('audio') },
            { id: 'selection-transitions', label: t`向所选切口应用默认转场`, disabled: readOnly || selectedClipIds.length < 2, onSelect: applyDefaultTransitionsToSelection },
            { id: 'lift', label: t`提升入出点范围`, disabled: !canLiftRange, onSelect: liftRange },
            { id: 'extract', label: t`提取入出点范围`, disabled: !canExtractRange, onSelect: extractRange },
            { id: 'ripple-start', label: t`波纹裁切片段起点到播放头`, disabled: !canRippleTrimToPlayhead, onSelect: () => rippleTrimToPlayhead('start') },
            { id: 'ripple-end', label: t`波纹裁切播放头到片段终点`, disabled: !canRippleTrimToPlayhead, onSelect: () => rippleTrimToPlayhead('end') },
            { id: 'match-frame', label: t`匹配播放头源帧`, disabled: matchFrameClip === null, onSelect: matchFrame },
            { id: 'toggle-enabled', label: selectedClips.some((clip) => !clip.placement.enabled) ? t`启用所选片段` : t`禁用所选片段`, disabled: !canToggleClipEnabled, onSelect: toggleSelectedClipEnabled },
            { id: 'group', label: t`组合所选片段`, disabled: !canGroup, onSelect: groupSelectedClips },
            { id: 'ungroup', label: t`取消组合所选片段`, disabled: !canUngroup, onSelect: ungroupSelectedClips },
            {
              id: 'create-nested-sequence',
              label: t`从所选片段创建嵌套序列…`,
              disabled: !canCreateNestedSequence,
              onSelect: () => globalThis.setTimeout(
                () => setNestedSequenceName(t`嵌套序列 ${document.tracks.filter((track) => track.clips.some((clip) => clip.material.kind === 'sequence')).length + 1}`),
                0,
              ),
            },
            {
              id: 'refresh-nested-sequence',
              label: nestedSequencePending ? t`正在刷新嵌套序列…` : t`刷新所选嵌套序列`,
              disabled: readOnly || nestedSequencePending || selectedNestedClip === null || selectedNestedMedia?.status === 'rendering',
              onSelect: () => selectedNestedClip === null ? undefined : onRefreshNestedSequence?.(selectedNestedClip.id),
            },
            { id: 'extend-edit', label: t`延伸所选剪辑点到播放头`, disabled: readOnly || selectedEditPoint === null, onSelect: extendSelectedEditToPlayhead },
            { id: 'copy', label: t`复制所选片段`, disabled: !canCopy, onSelect: copySelected },
            { id: 'duplicate', label: t`在播放头复制所选片段`, disabled: !canDuplicate, onSelect: duplicateSelected },
            { id: 'copy-transition', label: t`复制所选转场`, disabled: !canCopyTransition, onSelect: copySelectedTransition },
            { id: 'cut', label: t`剪切所选片段`, disabled: !canCopy || !canDelete, onSelect: cutSelected },
            { id: 'paste', label: t`在播放头粘贴覆盖`, disabled: !canPaste, onSelect: () => pasteClipboard('overwrite') },
            { id: 'paste-insert', label: t`在播放头插入粘贴`, disabled: !canPaste, onSelect: () => pasteClipboard('insert') },
            { id: 'paste-transition', label: t`粘贴转场到所选剪辑点`, disabled: !canPasteTransition, onSelect: pasteSelectedTransition },
            { id: 'paste-attributes', label: t`选择性粘贴属性`, disabled: !canPasteAttributes, onSelect: () => setPasteAttributesOpen(true) },
            { id: 'delete', label: t`删除所选片段并闭合间隙`, disabled: !canDelete, onSelect: deleteSelected },
            { id: 'close-gap', label: t`波纹删除所选间隙`, disabled: !canCloseSelectedGap, onSelect: closeSelectedGap },
            { id: 'close-all-gaps', label: t`关闭目标轨全部间隙`, disabled: !canCloseAllGaps, onSelect: closeAllTargetGaps },
            { id: 'undo', label: t`撤销上一次剪辑`, disabled: !canUndo || readOnly, onSelect: onUndo },
            { id: 'redo', label: t`重做上一次剪辑`, disabled: !canRedo || readOnly, onSelect: onRedo },
          ]}
        />
        <OverflowMenu
          label={t`标记操作`}
          triggerLabel={<><Bookmark className="size-3.5" aria-hidden="true" /><Trans>标记</Trans></>}
          align="start"
          triggerClassName="h-7 rounded-sm border border-divider px-2 text-xs"
          items={[
            { id: 'go-in', label: t`跳转到入点`, disabled: rangeInSeconds === null, onSelect: () => rangeInSeconds === null ? undefined : onSeek(rangeInSeconds) },
            { id: 'go-out', label: t`跳转到出点`, disabled: rangeOutSeconds === null, onSelect: () => rangeOutSeconds === null ? undefined : onSeek(rangeOutSeconds) },
            { id: 'clear-in', label: t`清除入点`, disabled: rangeInSeconds === null, onSelect: () => onRangeChange(null, rangeOutSeconds) },
            { id: 'clear-out', label: t`清除出点`, disabled: rangeOutSeconds === null, onSelect: () => onRangeChange(rangeInSeconds, null) },
            { id: 'clear-range', label: t`清除入出点`, disabled: rangeInSeconds === null && rangeOutSeconds === null, onSelect: () => onRangeChange(null, null) },
            { id: 'add', label: t`在播放头添加标记`, disabled: readOnly, onSelect: addMarker },
            { id: 'previous', label: t`上一个标记`, disabled: adjacentMarker(document.markers, playheadSeconds, -1, document.fps) === null, onSelect: () => navigateMarker(-1) },
            { id: 'next', label: t`下一个标记`, disabled: adjacentMarker(document.markers, playheadSeconds, 1, document.fps) === null, onSelect: () => navigateMarker(1) },
            { id: 'edit', label: t`编辑所选标记`, disabled: selectedMarker === null, onSelect: editSelectedMarker },
            { id: 'delete', label: t`删除所选标记`, disabled: readOnly || selectedMarker === null, onSelect: deleteSelectedMarker },
            { id: 'clear', label: t`清除全部标记`, disabled: readOnly || document.markers.length === 0, onSelect: clearMarkers },
            {
              id: 'ripple-sequence-markers',
              label: `${document.settings.ripple_sequence_markers ? '✓ ' : ''}${t`波纹移动序列标记`}`,
              disabled: readOnly,
              onSelect: () => onReplaceSettings({
                ...document.settings,
                ripple_sequence_markers: !document.settings.ripple_sequence_markers,
              }),
            },
          ]}
        />
        <OverflowMenu
          label={t`时间轴显示设置`}
          triggerLabel={<><Eye className="size-3.5" aria-hidden="true" /><Trans>显示</Trans></>}
          align="start"
          triggerClassName="h-7 rounded-sm border border-divider px-2 text-xs"
          items={[
            ...([
              ['head', t`视频缩略图：仅片头`],
              ['head_tail', t`视频缩略图：片头和片尾`],
              ['frames', t`视频缩略图：连续帧`],
              ['none', t`视频缩略图：不显示`],
            ] as const).map(([mode, label]) => ({
              id: `thumbnail-${mode}`,
              label: `${displaySettings.thumbnailMode === mode ? '✓ ' : ''}${label}`,
              onSelect: () => setDisplaySettings((current) => ({ ...current, thumbnailMode: mode })),
            })),
            ...([
            ['names', t`片段名称`],
            ['waveforms', t`音频波形`],
            ['keyframes', t`关键帧`],
            ['repeatedFrames', t`重复帧标记`],
            ['throughEdits', t`Through Edit 标记`],
            ] as const).map(([key, label]) => ({
            id: key,
            label: `${displaySettings[key] ? '✓ ' : ''}${label}`,
            onSelect: () => toggleDisplaySetting(key),
            })),
            {
              id: 'smooth-scroll',
              label: `${smoothScrollEnabled ? '✓ ' : ''}${t`播放头居中连续滚动`}`,
              onSelect: () => setSmoothScrollEnabled((enabled) => !enabled),
            },
            {
              id: 'render-preview',
              label: renderPreviewPending ? t`正在渲染预览…` : t`渲染入点到出点`,
              disabled: readOnly
                || renderPreviewPending
                || previewRangeStart === null
                || previewRangeEnd === null
                || previewRangeEnd <= previewRangeStart,
              onSelect: () => previewRangeStart === null || previewRangeEnd === null
                ? undefined
                : onRenderPreview?.(previewRangeStart, previewRangeEnd),
            },
            {
              id: 'clear-render-previews',
              label: t`删除预览文件`,
              disabled: readOnly || renderPreviewPending || renderPreviews.length === 0,
              onSelect: () => onClearRenderPreviews?.(),
            },
          ]}
        />
        <span className="sr-only">
          <Trans>目标：</Trans>{targetedTracks.map((track) => track.name).join('、') || '—'}
        </span>
        <span className="flex items-center overflow-hidden rounded-sm border border-divider">
          <button type="button" className="grid size-7 place-items-center hover:bg-neutral-100" aria-label={t`上一个目标轨编辑点`} onClick={() => navigateEditPoint(-1)}><ChevronUp className="size-3.5" aria-hidden="true" /></button>
          <button type="button" className="grid size-7 place-items-center border-l border-divider hover:bg-neutral-100" aria-label={t`下一个目标轨编辑点`} onClick={() => navigateEditPoint(1)}><ChevronDown className="size-3.5" aria-hidden="true" /></button>
        </span>
        <button
          type="button"
          className={cn(
            'grid size-7 place-items-center rounded-sm border border-divider hover:bg-neutral-100',
            linkedSelectionEnabled && 'border-accent-300 bg-accent-100 text-accent-text',
          )}
          aria-label={t`切换链接选择`}
          aria-pressed={linkedSelectionEnabled}
          onClick={onToggleLinkedSelection}
        >
          <Link2 className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          className={cn(
            'grid size-7 place-items-center rounded-sm border border-divider hover:bg-neutral-100',
            snapEnabled && 'border-accent-300 bg-accent-100 text-accent-text',
          )}
          aria-label={t`切换时间轴吸附`}
          aria-pressed={snapEnabled}
          onClick={() => {
            setSnapEnabled((enabled) => !enabled);
            setSnapGuideTime(null);
          }}
        >
          <Magnet className="size-3.5" aria-hidden="true" />
        </button>
        {!canChangeLinks && sharedLinkGroupId === null ? null : <button
          type="button"
          className="h-7 rounded-sm border border-divider px-2 text-2xs hover:bg-neutral-100 disabled:text-neutral-300"
          aria-label={sharedLinkGroupId === null ? t`链接所选片段` : t`取消链接所选片段`}
          disabled={!canChangeLinks}
          onClick={toggleSelectedClipLinks}
        >
          {sharedLinkGroupId === null ? <Trans>链接片段</Trans> : <Trans>取消链接</Trans>}
        </button>}
        <span className="flex items-center overflow-hidden rounded-sm border border-divider text-2xs">
          <button type="button" className="h-7 px-2 font-mono hover:bg-neutral-100" aria-label={t`在播放头标记入点`} onClick={() => onRangeChange(editPlayheadSeconds, rangeOutSeconds)}>I</button>
          <button type="button" className="h-7 border-l border-divider px-2 font-mono hover:bg-neutral-100" aria-label={t`在播放头标记出点`} onClick={() => onRangeChange(rangeInSeconds, editPlayheadSeconds)}>O</button>
          {rangeStart === null || rangeEnd === null ? null : (
            <span className="border-l border-divider px-2 font-mono text-accent-text">{formatMillisecondTimecode(rangeStart)}–{formatMillisecondTimecode(rangeEnd)}</span>
          )}
          {rangeInSeconds === null && rangeOutSeconds === null ? null : (
            <button type="button" className="h-7 border-l border-divider px-2 hover:bg-neutral-100" aria-label={t`清除入出点`} onClick={() => onRangeChange(null, null)}>×</button>
          )}
        </span>
        <Tooltip content={loopPlaybackEnabled ? t`关闭循环播放` : t`循环播放：有完整入出点时循环范围，否则循环整个序列`} side="bottom">
          <button
            type="button"
            className={cn(
              'grid size-7 place-items-center rounded-sm border border-divider hover:bg-neutral-100',
              loopPlaybackEnabled && 'border-accent-300 bg-accent-100 text-accent-text',
            )}
            aria-label={t`切换循环播放`}
            aria-pressed={loopPlaybackEnabled}
            onClick={onToggleLoopPlayback}
          >
            <Repeat2 className="size-3.5" aria-hidden="true" />
          </button>
        </Tooltip>
        {reviewChangeCount === 0 ? null : (
          <>
            <span className="text-xs text-neutral-500"><Trans>{reviewChangeCount} 处修改</Trans></span>
            <span className="flex items-center overflow-hidden rounded-sm border border-divider">
              <button type="button" className="grid size-7 place-items-center hover:bg-neutral-100" aria-label={t`上一个修改`} onClick={() => selectAdjacentChange(-1)}><ChevronLeft className="size-3.5" aria-hidden="true" /></button>
              <button type="button" className="grid size-7 place-items-center border-l border-divider hover:bg-neutral-100" aria-label={t`下一个修改`} onClick={() => selectAdjacentChange(1)}><ChevronRight className="size-3.5" aria-hidden="true" /></button>
            </span>
            <select
              aria-label={t`修改筛选`}
              className="h-7 rounded-sm border border-divider bg-bg px-2 text-2xs"
              value={changeFilter}
              onChange={(event) => setChangeFilter(event.currentTarget.value as 'all' | 'selected')}
            >
              <option value="all"><Trans>全部修改</Trans></option>
              <option value="selected" disabled={selectedChange === null}><Trans>所选修改</Trans></option>
            </select>
          </>
        )}
      </header>

      <TimelineToolStrip
        editTool={editTool}
        canRippleTool={!readOnly && document.tracks.some((track) => !track.locked && track.clips.length > 0)}
        canSlipTool={!readOnly && document.tracks.some((track) => !track.locked && track.clips.some((clip) => canSlipTimelineClip(clip, document.fps)))}
        canRollTool={!readOnly && document.tracks.some((track) => !track.locked && rollingEditPoints(track.clips, document.fps).length > 0)}
        canRateTool={!readOnly && document.tracks.some((track) => !track.locked && track.clips.some(canRateStretchTimelineClip))}
        canSlideTool={!readOnly && document.tracks.some((track) => !track.locked && slideEditTriples(track.clips, document.fps).length > 0)}
        onChangeTool={(tool) => {
          if (trimModeEdit !== null) exitTrimMode();
          if (tool === 'slip') onShuttle(0);
          if (tool === 'rolling') onShuttle(0);
          if (tool === 'rate') onShuttle(0);
          if (tool === 'slide') onShuttle(0);
          setEditTool(tool);
          onPreviewClips([]);
          setRollingPreviewTime(null);
          setRatePreviewDuration(null);
          setSlidePreviewTime(null);
          onPreviewRollingEdit(null);
          onPreviewSlideEdit(null);
        }}
      />

      <div className="grid h-8 flex-none grid-cols-[var(--w-track-head)_minmax(0,1fr)] border-b border-divider font-mono text-2xs text-neutral-500">
        <span />
        <div
          aria-label={t`时间轴标尺`}
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
            {renderPreviewSegments.map((segment) => (
              <span
                key={segment.id}
                className={cn(
                  'pointer-events-none absolute bottom-0 h-1 min-w-px',
                  segment.state === 'ready' && 'bg-ok',
                  segment.state === 'rendering' && 'bg-warn',
                  (segment.state === 'stale' || segment.state === 'failed') && 'bg-fail',
                )}
                style={{
                  left: timeToPx(scale, segment.start),
                  width: Math.max(1, timeToPx(scale, segment.end - segment.start)),
                }}
                title={`${segment.state} · ${formatMillisecondTimecode(segment.start)}–${formatMillisecondTimecode(segment.end)}`}
                data-render-preview-state={segment.state}
              />
            ))}
          </div>
        </div>
      </div>

      {reviewChangeCount === 0 ? null : (
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
      )}

      <div
        ref={viewportRef}
        className={cn(
          'timeline-viewport min-h-0 flex-1 overscroll-contain overflow-y-auto',
          contentWidth <= viewportWidth + 0.5 ? 'overflow-x-hidden' : 'overflow-x-auto',
        )}
        role="region"
        aria-label={t`时间轴内容`}
        onScroll={(event) => {
          timelineScrollLeftRef.current = event.currentTarget.scrollLeft;
          setScrollLeft(event.currentTarget.scrollLeft);
        }}
        onPointerDown={(event) => {
          if (event.button === 0 && event.target === event.currentTarget) {
            event.preventDefault();
            seekFromPointer(event);
          }
        }}
      >
        <div
          className={cn('relative grid min-h-full', editTool === 'hand' && 'cursor-grab active:cursor-grabbing', editTool === 'zoom' && 'cursor-zoom-in')}
          role="rowgroup"
          aria-label={t`时间轴轨道网格`}
          style={{ minWidth: `calc(var(--w-track-head) + ${contentWidth}px)`, gridTemplateRows: rowTemplate }}
          onPointerDownCapture={(event) => {
            if (event.button !== 0) return;
            const viewport = viewportRef.current;
            if (editTool === 'hand' && viewport !== null) {
              event.preventDefault();
              event.stopPropagation();
              handGesture.current = {
                pointerId: event.pointerId,
                clientX: event.clientX,
                clientY: event.clientY,
                scrollLeft: viewport.scrollLeft,
                scrollTop: viewport.scrollTop,
              };
              try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* Synthetic/non-primary pointer; window events still continue. */ }
            } else if (editTool === 'zoom' && viewport !== null) {
              event.preventDefault();
              event.stopPropagation();
              const bounds = viewport.getBoundingClientRect();
              const trackHead = Number.parseFloat(getComputedStyle(viewport).getPropertyValue('--w-track-head')) || 0;
              changeZoomMultiplier(effectiveZoomMultiplier * (event.altKey ? 0.5 : 2), event.clientX - bounds.left - trackHead);
            }
          }}
          onPointerMoveCapture={(event) => {
            const hand = handGesture.current;
            if (hand === null || hand.pointerId !== event.pointerId) return;
            event.preventDefault();
            event.stopPropagation();
            setTimelineScroll(hand.scrollLeft - (event.clientX - hand.clientX), hand.scrollTop - (event.clientY - hand.clientY));
          }}
          onPointerUpCapture={(event) => {
            if (handGesture.current?.pointerId !== event.pointerId) return;
            event.preventDefault();
            event.stopPropagation();
            handGesture.current = null;
            try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* See capture note above. */ }
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || !(event.target instanceof Element)) return;
            const viewport = viewportRef.current;
            if (event.target.closest('button,[role="separator"]')) return;
            const position = marqueeContentPosition(event.clientX, event.clientY);
            if (position === null || viewport === null) return;
            const trackHead = Number.parseFloat(getComputedStyle(viewport).getPropertyValue('--w-track-head')) || 0;
            if (position.x < trackHead) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            marqueeGesture.current = {
              pointerId: event.pointerId,
              startClientX: event.clientX,
              startClientY: event.clientY,
              startContentX: position.x,
              startContentY: position.y,
              additive: event.ctrlKey || event.metaKey,
              initialSelection: selectedClipIds,
              active: false,
              lastClientX: event.clientX,
              lastClientY: event.clientY,
            };
          }}
          onPointerMove={(event) => {
            const hand = handGesture.current;
            if (hand !== null && hand.pointerId === event.pointerId) {
              event.preventDefault();
              setTimelineScroll(
                hand.scrollLeft - (event.clientX - hand.clientX),
                hand.scrollTop - (event.clientY - hand.clientY),
              );
              return;
            }
            updateMarqueeSelection(event);
          }}
          onPointerUp={(event) => {
            if (handGesture.current?.pointerId === event.pointerId) {
              handGesture.current = null;
              event.currentTarget.releasePointerCapture?.(event.pointerId);
              return;
            }
            const gesture = marqueeGesture.current;
            if (gesture === null || gesture.pointerId !== event.pointerId) return;
            event.preventDefault();
            if (!gesture.active) {
              if (!gesture.additive) onSelectClips([]);
              seekFromPointer(event);
            }
            finishMarqueeSelection();
            event.currentTarget.releasePointerCapture?.(event.pointerId);
          }}
          onPointerCancel={() => {
            handGesture.current = null;
            const gesture = marqueeGesture.current;
            if (gesture !== null) onSelectClips(gesture.initialSelection);
            finishMarqueeSelection();
          }}
        >
          {renderedTracks.map((track) => (
            <TimelineTrackRow
              key={track.id}
              track={track}
              scale={scale}
              contentWidth={contentWidth}
              thumbnailWindowStartPx={thumbnailWindowStartPx}
              thumbnailWindowEndPx={thumbnailWindowEndPx}
              selectedClipId={selectedClipId}
              selectedClipIds={selectedClipIdSet}
              selectedTransition={selectedTransition}
              selectedGap={selectedGap}
              displaySettings={displaySettings}
              selectedEditPoint={selectedEditPoint}
              deliveryStateByClipId={deliveryStateByClipId}
              sourceMarkersByAssetId={sourceMarkersByAssetId}
              outOfSyncFramesByClipId={outOfSyncFramesByClipId}
              editTool={editTool}
              fps={document.fps}
              readOnly={readOnly}
              onSelectClip={onSelectClip}
              onSelectTransition={setSelectedTransition}
              onSelectGap={(gap) => {
                setSelectedTransition(null);
                onSelectClips([]);
                setSelectedGap({ trackId: track.track.id, ...gap });
              }}
              onSelectEditPoint={(clipId, edge) => {
                setSelectedEditPoint({ clipId, edge });
                onSelectClip(clipId, false, false);
              }}
              onPromoteClip={onPromoteClip}
              onInspectClip={(clipId) => {
                const candidate = track.clips.find((clip) => clip.id === clipId);
                if (candidate?.material.kind === 'sequence') {
                  onOpenNestedSequence?.(candidate.material.project_id);
                } else {
                  onInspectClip(clipId);
                }
              }}
              onRestoreClipSync={restoreClipSync}
              onSeek={onSeek}
              onRazor={(time, allTracks, followLinkedClips) => addEditAt({
                time,
                allTracks,
                followLinkedClips,
                explicitTrackId: allTracks ? null : track.track.id,
                snap: true,
              })}
              onTrackSelect={(time, direction, allTracks) => onSelectClips(timelineTrackSelection({
                tracks: document.tracks,
                trackId: track.track.id,
                timelineTime: time,
                direction,
                allTracks,
              }))}
              onReplaceClip={onReplaceClip}
              onReplaceTrack={onReplaceTrack}
              onReplaceTrackClips={onReplaceTrackClips}
              onRemoveTrack={onRemoveTrack}
              storyTrackId={document.story_track_id}
              changeByClipId={changeByClipId}
              ghostChanges={ghostChanges}
              snapPoints={activeSnapPoints}
              snapThresholdSeconds={10 / scale.pixelsPerSecond}
              onSnapChange={setSnapGuideTime}
              nonStoryTrackIds={nonStoryTrackIds}
              onReorderTrack={reorderTrack}
              targetTrackIds={targetTrackIdSet}
              syncLocked={syncLockedTrackIdSet.has(track.track.id)}
              crossTrackTargeted={crossTrackTargetId === track.track.id}
              timelineTimeSeconds={playheadSeconds}
              onTargetTrack={onTargetTrack}
              onToggleSyncLock={onToggleSyncLock}
              onCrossTrackPreview={(candidateTrackId) => previewCrossTrackTarget(track.track.id, candidateTrackId)}
              onMoveCrossTrack={(targetTrackId, clipId, start) => moveSelectionAcrossTrack(track.track.id, targetTrackId, clipId, start)}
              height={collapsedTrackRows.has(track.id)
                ? MIN_TRACK_HEIGHT
                : trackHeights[track.id] ?? defaultTrackHeight(track)}
              collapsed={collapsedTrackRows.has(track.id)}
              onHeightChange={(height) => updateTrackHeight(track.id, height)}
              onToggleCollapse={() => toggleTrackCollapse(track.id)}
              scrollLeftRef={timelineScrollLeftRef}
              onDragAutoScroll={updateDragAutoScroll}
              selectedTrackGroups={editableSelectedTrackGroups}
              onReplaceTrackClipGroups={onReplaceTrackClipGroups}
              onPreviewClips={onPreviewClips}
              onPreviewRollingEdit={(preview) => {
                setRollingPreviewTime(preview?.editTime ?? null);
                onPreviewRollingEdit(preview);
              }}
              onPreviewSlideEdit={(preview) => {
                setSlidePreviewTime(preview?.startTime ?? null);
                onPreviewSlideEdit(preview);
              }}
              onStopTransport={() => onShuttle(0)}
              onPreviewDuration={(clips) => setRatePreviewDuration(clips === null
                ? null
                : timelineDurationWithTrack(document, track.track.id, clips))}
              mediaDropPreview={mediaDropPreview?.trackId === track.track.id ? mediaDropPreview : null}
              selectedTrimModeEditKeys={selectedTrimModeEditKeys}
              trimModeActive={trimModeEdit !== null}
              onToggleTrimModeEdit={(leftClipId, rightClipId, editTime) => toggleTrimModeEdit({
                trackId: track.track.id,
                leftClipId,
                rightClipId,
                editTime,
              })}
              onMediaDragOver={(event) => previewMediaDrop(event, track)}
              onMediaDragLeave={(event) => {
                if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
                if (mediaDropPreview?.trackId === track.track.id) setMediaDropPreview(null);
                setSnapGuideTime(null);
              }}
              onMediaDrop={(event) => commitMediaDrop(event, track)}
            />
          ))}
          <TimelineMarkerRow
            markers={document.markers}
            selectedMarkerId={selectedMarkerId}
            scale={scale}
            contentWidth={contentWidth}
            ticks={ticks}
            durationSeconds={document.duration_seconds}
            fps={document.fps}
            readOnly={readOnly}
            snapPoints={activeSnapPoints}
            snapThresholdSeconds={10 / scale.pixelsPerSecond}
            onSnapChange={setSnapGuideTime}
            onSeek={onSeek}
            onSelectMarker={(marker) => setSelectedMarkerId(marker.id)}
            onEditMarker={(marker) => {
              setSelectedMarkerId(marker.id);
              setMarkerDraft({ ...marker });
            }}
            onMoveMarker={(markerId, time) => onReplaceMarkers(document.markers.map((marker) => (
              marker.id === markerId ? { ...marker, time } : marker
            )))}
          />
          <TimelineEventRow
            clips={clips}
            scale={scale}
            contentWidth={contentWidth}
            ticks={ticks}
            onSelectClip={onSelectClip}
            onSeek={onSeek}
          />
          {marqueeBounds === null ? null : (
            <span
              className="pointer-events-none absolute z-50 border border-accent-500 bg-accent-100/45"
              style={marqueeBounds}
              aria-label={t`框选范围`}
            />
          )}
        </div>
      </div>

      <Dialog
        open={nestedSequenceName !== null}
        title={<Trans>创建嵌套序列</Trans>}
        confirmLabel={<Trans>创建并打开</Trans>}
        confirmDisabled={nestedSequenceName === null || nestedSequenceName.trim() === '' || !canCreateNestedSequence}
        onConfirm={() => {
          if (nestedSequenceName === null || !canCreateNestedSequence) return;
          const name = nestedSequenceName.trim();
          setNestedSequenceName(null);
          onCreateNestedSequence?.(selectedClipIds, name);
        }}
        onClose={() => setNestedSequenceName(null)}
      >
        <label className="flex flex-col gap-1 text-xs">
          <Trans>序列名称</Trans>
          <input
            autoFocus
            className="border border-divider bg-bg px-2 py-1.5"
            maxLength={200}
            value={nestedSequenceName ?? ''}
            onChange={(event) => setNestedSequenceName(event.currentTarget.value)}
          />
        </label>
        <p className="mt-2 text-2xs leading-4 text-neutral-500"><Trans>所选连续 Story 片段会移动到新的源序列；父时间轴用一个可双击打开的嵌套片段替换它们。</Trans></p>
      </Dialog>

      <Dialog
        open={pasteAttributesOpen}
        title={<Trans>选择性粘贴属性</Trans>}
        confirmLabel={<Trans>粘贴属性</Trans>}
        confirmDisabled={!canPasteAttributes || !Object.values(pasteAttributeSelection).some(Boolean)}
        onConfirm={applyPasteAttributes}
        onClose={() => setPasteAttributesOpen(false)}
      >
        <p className="mb-2 text-xs text-neutral-600"><Trans>源：</Trans>{pasteAttributeSource?.name ?? '—'} · <Trans>目标片段：</Trans>{editableSelectedTrackGroups.reduce((count, group) => count + group.clips.length, 0)}</p>
        <div className="grid grid-cols-2 gap-2">
          {([
            ['transform', t`变换`],
            ['effects', t`效果`],
            ['keyframes', t`关键帧`],
            ['transitions', t`转场`],
            ['audio', t`音量与声像`],
          ] as const).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 rounded-sm border border-divider px-2 py-1.5 text-xs">
              <input
                type="checkbox"
                checked={pasteAttributeSelection[key]}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setPasteAttributeSelection((current) => ({ ...current, [key]: checked }));
                }}
              />
              {label}
            </label>
          ))}
        </div>
      </Dialog>

      <footer className="flex h-10 flex-none items-center gap-4 border-t border-divider px-2 text-2xs text-neutral-600">
        <span><Trans>序列时长：</Trans><strong className="font-mono font-medium text-text">{formatMillisecondTimecode(displayedDuration)}</strong></span>
        {changeProjection.previousDuration !== null && changeProjection.previousDuration > 0 && hasTimelineDelta(changeProjection.currentDuration - changeProjection.previousDuration) ? (
          <span className="text-neutral-500"><Trans>原</Trans> <span className="font-mono">{formatMillisecondTimecode(changeProjection.previousDuration)}</span></span>
        ) : null}
        <span className="flex items-center gap-1.5"><span className="size-2 bg-accent-400" /><Trans>已录制 {recordedCount}</Trans></span>
        <span className="flex items-center gap-1.5"><span className="size-2 bg-neutral-200" /><Trans>未录制 {plannedCount}</Trans></span>
        <TimelineTimecodeControl
          seconds={playheadSeconds}
          durationSeconds={document.duration_seconds}
          fps={document.fps}
          mode={timeDisplayMode}
          onModeChange={setTimeDisplayMode}
          onSeek={onSeek}
        />
        <TimelineZoomNavigator
          multiplier={effectiveZoomMultiplier}
          maximumMultiplier={maximumZoomMultiplier}
          pixelsPerSecond={scale.pixelsPerSecond}
          pixelsPerFrame={scale.pixelsPerSecond / document.fps}
          viewportWidth={viewportWidth}
          contentWidth={contentWidth}
          scrollLeft={scrollLeft}
          onZoom={changeZoomMultiplier}
          onScroll={setTimelineScroll}
        />
      </footer>

      <div
        className="absolute bottom-10 top-[var(--h-panel-head)] z-20 w-px bg-accent-600"
        style={{ left: `calc(var(--w-track-head) + ${timeToPx(scale, rollingPreviewTime ?? slidePreviewTime ?? playheadSeconds) - scrollLeft}px)` }}
      >
        <span className="absolute left-1/2 top-1 -translate-x-1/2 whitespace-nowrap rounded-sm bg-accent-600 px-1.5 py-0.5 font-mono text-2xs text-bg">
          {formatMillisecondTimecode(rollingPreviewTime ?? slidePreviewTime ?? playheadSeconds)}
        </span>
        <button
          type="button"
          role="slider"
          aria-label={t`时间轴播放头`}
          aria-valuemin={0}
          aria-valuemax={document.duration_seconds}
          aria-valuenow={rollingPreviewTime ?? slidePreviewTime ?? playheadSeconds}
          aria-valuetext={formatMillisecondTimecode(rollingPreviewTime ?? slidePreviewTime ?? playheadSeconds)}
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
              navigateEditPoint(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey);
              return;
            }
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const direction = event.key === 'ArrowRight' ? 1 : -1;
            const step = (event.shiftKey ? 5 : 1) / document.fps;
            onSeek(Math.min(document.duration_seconds, Math.max(0, playheadSeconds + direction * step)));
          }}
        />
      </div>
      {snapGuideTime === null ? null : (
        <span
          className="pointer-events-none absolute bottom-10 top-[var(--h-panel-head)] z-30 w-0.5 bg-accent-400/80"
          style={{ left: `calc(var(--w-track-head) + ${timeToPx(scale, snapGuideTime) - scrollLeft}px)` }}
          aria-label={t`吸附到 ${formatMillisecondTimecode(snapGuideTime)}`}
        />
      )}
      {rangeStart === null || rangeEnd === null || rangeEnd <= rangeStart ? null : (
        <span
          className="pointer-events-none absolute bottom-10 top-[var(--h-panel-head)] z-10 border-x border-accent-400 bg-accent-100/35"
          style={{
            left: `calc(var(--w-track-head) + ${timeToPx(scale, rangeStart) - scrollLeft}px)`,
            width: timeToPx(scale, rangeEnd - rangeStart),
          }}
          aria-label={t`入出点范围 ${formatMillisecondTimecode(rangeStart)} 到 ${formatMillisecondTimecode(rangeEnd)}`}
        />
      )}
      <Drawer
        open={textDraft !== null}
        title={textDraft?.kind === 'caption' ? <Trans>添加字幕</Trans> : <Trans>添加文字</Trans>}
        description={textDraft === null ? undefined : formatMillisecondTimecode(textDraft.start)}
        width="standard"
        onClose={() => setTextDraft(null)}
        footer={textDraft === null ? undefined : (
          <>
            <Button size="sm" variant="secondary" onClick={() => setTextDraft(null)}><Trans>取消</Trans></Button>
            <Button
              size="sm"
              variant="primary"
              disabled={textDraft.content.trim() === '' || textDraft.duration < 1 / document.fps}
              onClick={insertTextClip}
            >
              {textDraft.kind === 'caption' ? <Trans>添加字幕</Trans> : <Trans>添加文字</Trans>}
            </Button>
          </>
        )}
      >
        {textDraft === null ? <span /> : (
          <div className="space-y-3">
            <label className="flex flex-col gap-1 text-xs">
              {textDraft.kind === 'caption' ? <Trans>字幕内容</Trans> : <Trans>文字内容</Trans>}
              <textarea
                autoFocus
                rows={4}
                maxLength={1_000}
                className="resize-y border border-divider bg-bg px-2 py-1.5"
                value={textDraft.content}
                onChange={(event) => setTextDraft({ ...textDraft, content: event.currentTarget.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <Trans>持续时间（秒）</Trans>
              <input
                type="number"
                min={1 / document.fps}
                max={textDraft.maximumDuration}
                step={1 / document.fps}
                className="border border-divider bg-bg px-2 py-1.5 font-mono"
                value={textDraft.duration}
                onChange={(event) => setTextDraft({ ...textDraft, duration: Number(event.currentTarget.value) })}
              />
            </label>
            <p className="text-2xs leading-4 text-neutral-500">
              {textDraft.kind === 'caption'
                ? <Trans>字幕会显示在独立字幕轨中，可前后导航、编辑样式并导出为 SRT。</Trans>
                : <Trans>创建后双击时间轴中的文字片段，可调整字体、颜色、位置和关键帧。</Trans>}
            </p>
          </div>
        )}
      </Drawer>
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
                setSelectedMarkerId(null);
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
                  ? normalizeEditorMarker(markerDraft, document.duration_seconds, document.fps)
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
          <MarkerEditorFields marker={markerDraft} durationSeconds={document.duration_seconds} fps={document.fps} onChange={setMarkerDraft} />
        )}
      </Drawer>
    </ReviewPanel>
    </div>
  );
}

function timelineClipMaterialState(
  clip: TimelineClip,
  deliveryState: TimelineClipMaterializationState | undefined,
): 'planned' | 'recorded' | 'stale' {
  if (deliveryState === 'stale') return 'stale';
  if (deliveryState === 'unbound' || deliveryState === 'unrecorded') return 'planned';
  return resolveTimelineMaterial(clip.material, clip.placement).state;
}

function TimelineTimecodeControl({ seconds, durationSeconds, fps, mode, onModeChange, onSeek }: {
  readonly seconds: number;
  readonly durationSeconds: number;
  readonly fps: number;
  readonly mode: TimelineTimeDisplayMode;
  readonly onModeChange: (mode: TimelineTimeDisplayMode) => void;
  readonly onSeek: (seconds: number) => void;
}) {
  const formatted = formatTimelinePosition(seconds, fps, mode);
  const [draft, setDraft] = useState(formatted);
  const [editing, setEditing] = useState(false);
  const cancelCommitRef = useRef(false);
  const gesture = useRef<{ readonly pointerId: number; readonly clientX: number; readonly seconds: number } | null>(null);
  useEffect(() => {
    if (!editing) setDraft(formatted);
  }, [editing, formatted]);
  const commit = () => {
    if (cancelCommitRef.current) {
      cancelCommitRef.current = false;
      setEditing(false);
      setDraft(formatted);
      return;
    }
    const parsed = parseTimelinePosition(draft, fps, mode);
    setEditing(false);
    if (parsed === null) setDraft(formatted);
    else onSeek(Math.min(durationSeconds, Math.max(0, parsed)));
  };
  return (
    <span className="flex h-7 items-center overflow-hidden rounded-sm border border-divider bg-bg">
      <Tooltip content={mode === 'timecode' ? t`切换为总帧计数` : t`切换为 HH:MM:SS:FF 时间码`} side="top">
        <button
          type="button"
          className="h-full border-r border-divider px-1.5 font-mono text-2xs hover:bg-neutral-100"
          aria-label={t`切换时间显示模式`}
          onClick={() => onModeChange(mode === 'timecode' ? 'frames' : 'timecode')}
        >{mode === 'timecode' ? 'TC' : 'F'}</button>
      </Tooltip>
      <input
        className="h-full w-24 bg-transparent px-2 text-center font-mono text-2xs text-text outline-none focus:bg-accent-100"
        aria-label={mode === 'timecode' ? t`播放头时间码` : t`播放头帧计数`}
        inputMode="numeric"
        value={draft}
        onFocus={(event) => {
          cancelCommitRef.current = false;
          setEditing(true);
          event.currentTarget.select();
        }}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          }
          else if (event.key === 'Escape') {
            cancelCommitRef.current = true;
            event.currentTarget.blur();
          }
        }}
      />
      <Tooltip content={t`水平拖动 scrub；方向键 1 帧，Shift 5 帧`} side="top">
        <button
          type="button"
          role="slider"
          className="grid h-full w-7 touch-none place-items-center border-l border-divider hover:bg-neutral-100"
          aria-label={t`拖动播放头时间码`}
          aria-valuemin={0}
          aria-valuemax={durationSeconds}
          aria-valuenow={seconds}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            gesture.current = { pointerId: event.pointerId, clientX: event.clientX, seconds };
          }}
          onPointerMove={(event) => {
            const active = gesture.current;
            if (active === null || active.pointerId !== event.pointerId) return;
            event.preventDefault();
            const pixelsPerFrame = event.shiftKey ? 12 : 4;
            const frameDelta = Math.round((event.clientX - active.clientX) / pixelsPerFrame);
            onSeek(Math.min(durationSeconds, Math.max(0, active.seconds + frameDelta / fps)));
          }}
          onPointerUp={(event) => {
            if (gesture.current?.pointerId !== event.pointerId) return;
            gesture.current = null;
            event.currentTarget.releasePointerCapture?.(event.pointerId);
          }}
          onPointerCancel={() => { gesture.current = null; }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const direction = event.key === 'ArrowRight' ? 1 : -1;
            onSeek(seconds + direction * (event.shiftKey ? 5 : 1) / fps);
          }}
        >
          <MoveHorizontal className="size-3" aria-hidden="true" />
        </button>
      </Tooltip>
    </span>
  );
}

function TimelineZoomNavigator({
  multiplier,
  maximumMultiplier,
  pixelsPerSecond,
  pixelsPerFrame,
  viewportWidth,
  contentWidth,
  scrollLeft,
  onZoom,
  onScroll,
}: {
  readonly multiplier: number;
  readonly maximumMultiplier: number;
  readonly pixelsPerSecond: number;
  readonly pixelsPerFrame: number;
  readonly viewportWidth: number;
  readonly contentWidth: number;
  readonly scrollLeft: number;
  readonly onZoom: (multiplier: number, anchorPx?: number) => void;
  readonly onScroll: (scrollLeft: number) => void;
}) {
  const laneRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    readonly pointerId: number;
    readonly mode: 'pan' | 'start' | 'end';
    readonly clientX: number;
    readonly scrollLeft: number;
    readonly multiplier: number;
    readonly thumbWidth: number;
    readonly laneWidth: number;
  } | null>(null);
  const maximumScroll = Math.max(0, contentWidth - viewportWidth);
  const visibleFraction = Math.min(1, viewportWidth / Math.max(1, contentWidth));
  const leftPercent = maximumScroll <= 0 ? 0 : scrollLeft / contentWidth * 100;
  const widthPercent = visibleFraction * 100;
  const beginGesture = (event: ReactPointerEvent, mode: 'pan' | 'start' | 'end') => {
    if (event.button !== 0) return;
    const lane = laneRef.current;
    if (lane === null) return;
    event.preventDefault();
    event.stopPropagation();
    lane.setPointerCapture?.(event.pointerId);
    const laneWidth = Math.max(1, lane.getBoundingClientRect().width);
    gesture.current = {
      pointerId: event.pointerId,
      mode,
      clientX: event.clientX,
      scrollLeft,
      multiplier,
      thumbWidth: Math.max(10, visibleFraction * laneWidth),
      laneWidth,
    };
  };
  const updateGesture = (event: ReactPointerEvent) => {
    const active = gesture.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    const delta = event.clientX - active.clientX;
    if (active.mode === 'pan') {
      const travel = Math.max(1, active.laneWidth - active.thumbWidth);
      onScroll(active.scrollLeft + delta / travel * maximumScroll);
      return;
    }
    const requestedWidth = Math.min(
      active.laneWidth,
      Math.max(10, active.thumbWidth + (active.mode === 'start' ? -delta : delta)),
    );
    const requestedMultiplier = active.multiplier * active.thumbWidth / requestedWidth;
    onZoom(requestedMultiplier);
  };
  const finishGesture = (event: ReactPointerEvent) => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    gesture.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  return (
    <span className="ml-auto flex min-w-56 max-w-[720px] flex-1 items-center gap-1.5 text-neutral-500">
      <button
        type="button"
        className="grid size-[var(--h-ctl-sm)] place-items-center rounded-sm hover:bg-neutral-100"
        aria-label={t`缩小时间轴`}
        onClick={() => onZoom(multiplier / 1.25)}
      >
        <ZoomOut className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
      </button>
      <input
        type="range"
        aria-label={t`时间轴缩放`}
        aria-valuetext={t`${pixelsPerSecond.toFixed(1)} 像素/秒，${pixelsPerFrame.toFixed(2)} 像素/帧`}
        min={0}
        max={Math.log2(maximumMultiplier)}
        step="any"
        value={Math.log2(multiplier)}
        className="timeline-zoom w-14"
        data-timeline-pixels-per-second={pixelsPerSecond}
        data-timeline-pixels-per-frame={pixelsPerFrame}
        onChange={(event) => onZoom(2 ** Number(event.currentTarget.value))}
      />
      <button
        type="button"
        className="grid size-[var(--h-ctl-sm)] place-items-center rounded-sm hover:bg-neutral-100"
        aria-label={t`放大时间轴`}
        onClick={() => onZoom(multiplier * 1.25)}
      >
        <ZoomIn className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
      </button>
      <div
        ref={laneRef}
        data-timeline-zoom-navigator="true"
        role="scrollbar"
        tabIndex={0}
        aria-label={t`时间轴可视范围`}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={maximumScroll}
        aria-valuenow={Math.min(maximumScroll, scrollLeft)}
        className="relative h-3 min-w-28 flex-1 rounded-sm border border-divider bg-neutral-100 outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
        onPointerDown={(event) => {
          if (event.target !== event.currentTarget || event.button !== 0) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const pointer = event.clientX - bounds.left;
          const thumbBounds = event.currentTarget.firstElementChild?.getBoundingClientRect();
          const thumbStart = (thumbBounds?.left ?? bounds.left) - bounds.left;
          const thumbEnd = (thumbBounds?.right ?? bounds.left) - bounds.left;
          onScroll(scrollLeft + (pointer < thumbStart ? -viewportWidth : pointer > thumbEnd ? viewportWidth : 0));
        }}
        onPointerMove={updateGesture}
        onPointerUp={finishGesture}
        onPointerCancel={finishGesture}
        onDoubleClick={() => onZoom(1)}
        onKeyDown={(event) => {
          if (event.key === 'Home') {
            event.preventDefault();
            onScroll(0);
          } else if (event.key === 'End') {
            event.preventDefault();
            onScroll(maximumScroll);
          } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            onScroll(scrollLeft + (event.key === 'ArrowLeft' ? -1 : 1) * viewportWidth * (event.shiftKey ? 1 : 0.1));
          }
        }}
      >
        <span
          className="absolute inset-y-0 min-w-2.5 cursor-grab rounded-sm border border-accent-500 bg-accent-200 active:cursor-grabbing"
          style={{
            left: `min(${leftPercent}%, calc(100% - 10px))`,
            width: `max(${widthPercent}%, 10px)`,
          }}
          onPointerDown={(event) => beginGesture(event, 'pan')}
        >
          <span
            role="separator"
            aria-label={t`调整时间轴可视范围起点`}
            className="absolute inset-y-0 -left-px w-1.5 cursor-ew-resize border-l border-accent-700"
            onPointerDown={(event) => beginGesture(event, 'start')}
          />
          <span
            role="separator"
            aria-label={t`调整时间轴可视范围终点`}
            className="absolute inset-y-0 -right-px w-1.5 cursor-ew-resize border-r border-accent-700"
            onPointerDown={(event) => beginGesture(event, 'end')}
          />
        </span>
      </div>
      <button type="button" className="h-[var(--h-ctl-sm)] rounded-sm border border-divider px-2 text-2xs hover:bg-neutral-100" onClick={() => onZoom(1)}><Trans>适应</Trans></button>
    </span>
  );
}

function buildRenderedTracks(document: EditingDocument): RenderedTrack[] {
  return timelineTrackLayout(document).map((row) => ({
    ...row,
    label: row.derivedAudio ? t`${row.track.name} 音频` : row.track.name,
    ariaLabel: row.derivedAudio ? t`${row.track.name} 音频` : row.track.name,
    clips: row.track.clips,
    controls: row.kind,
    icon: row.kind === 'audio'
      ? <Volume2 className="size-4" />
      : row.kind === 'caption'
        ? <Captions className="size-4" />
        : row.kind === 'text'
          ? <Type className="size-4" />
          : <Camera className="size-4" />,
  }));
}

function timelineDurationWithTrack(
  document: EditingDocument,
  trackId: string,
  replacementClips: readonly TimelineClip[],
): number {
  return document.tracks.flatMap((track) => track.id === trackId ? replacementClips : track.clips)
    .filter((clip) => clip.placement.enabled)
    .reduce((duration, clip) => Math.max(duration, clip.placement.start + clip.placement.duration), 0);
}

function timelineClipsEqual(
  current: readonly TimelineClip[],
  replacement: readonly TimelineClip[],
): boolean {
  return current.length === replacement.length
    && current.every((clip, index) => JSON.stringify(clip) === JSON.stringify(replacement[index]));
}

function timelineClipboardFromSelection(
  groups: readonly { readonly track: TimelineTrack; readonly clips: readonly TimelineClip[] }[],
): TimelineClipboard | null {
  const clips = groups.flatMap((group) => group.clips);
  if (clips.length === 0) return null;
  const originTime = Math.min(...clips.map((clip) => clip.placement.start));
  return {
    originTime,
    duration: Math.max(...clips.map((clip) => clip.placement.start + clip.placement.duration)) - originTime,
    groups: groups.map(({ track, clips: selected }) => ({
      trackId: track.id,
      trackKind: track.kind,
      clips: selected,
    })),
  };
}

const TimelineTrackRow = memo(function TimelineTrackRow({ track, scale, contentWidth, thumbnailWindowStartPx, thumbnailWindowEndPx, selectedClipId, selectedClipIds, selectedTransition, selectedGap, displaySettings, selectedEditPoint, deliveryStateByClipId, sourceMarkersByAssetId, outOfSyncFramesByClipId, editTool, fps, readOnly, onSelectClip, onSelectTransition, onSelectGap, onSelectEditPoint, onPromoteClip, onInspectClip, onRestoreClipSync, onSeek, onRazor, onTrackSelect, onReplaceClip, onReplaceTrack, onReplaceTrackClips, onRemoveTrack, storyTrackId, changeByClipId, ghostChanges, snapPoints, snapThresholdSeconds, onSnapChange, nonStoryTrackIds, onReorderTrack, targetTrackIds, syncLocked, crossTrackTargeted, timelineTimeSeconds, onTargetTrack, onToggleSyncLock, onCrossTrackPreview, onMoveCrossTrack, height, collapsed, onHeightChange, onToggleCollapse, scrollLeftRef, onDragAutoScroll, selectedTrackGroups, onReplaceTrackClipGroups, onPreviewClips, onPreviewRollingEdit, onPreviewSlideEdit, onStopTransport, onPreviewDuration, mediaDropPreview, selectedTrimModeEditKeys, trimModeActive, onToggleTrimModeEdit, onMediaDragOver, onMediaDragLeave, onMediaDrop }: {
  readonly track: RenderedTrack;
  readonly scale: TimeScale;
  readonly contentWidth: number;
  readonly thumbnailWindowStartPx: number;
  readonly thumbnailWindowEndPx: number;
  readonly selectedClipId: string | null;
  readonly selectedClipIds: ReadonlySet<string>;
  readonly selectedTransition: SelectedTimelineTransition | null;
  readonly selectedGap: SelectedTimelineGap | null;
  readonly displaySettings: TimelineDisplaySettings;
  readonly selectedEditPoint: { readonly clipId: string; readonly edge: 'start' | 'end' } | null;
  readonly deliveryStateByClipId: ReadonlyMap<string, TimelineClipMaterializationState>;
  readonly sourceMarkersByAssetId: ReadonlyMap<string, readonly EditorMarker[]>;
  readonly outOfSyncFramesByClipId: ReadonlyMap<string, number>;
  readonly editTool: TimelineEditTool;
  readonly fps: number;
  readonly readOnly: boolean;
  readonly onSelectClip: (clipId: string, additive?: boolean, range?: boolean) => void;
  readonly onSelectTransition: (transition: SelectedTimelineTransition | null) => void;
  readonly onSelectGap: (gap: TimelineGap) => void;
  readonly onSelectEditPoint: (clipId: string, edge: 'start' | 'end') => void;
  readonly onPromoteClip: (clipId: string) => void;
  readonly onInspectClip: (clipId: string) => void;
  readonly onRestoreClipSync: (clipId: string) => void;
  readonly onSeek: (seconds: number) => void;
  readonly onRazor: (time: number, allTracks: boolean, followLinkedClips: boolean) => void;
  readonly onTrackSelect: (time: number, direction: 'forward' | 'backward', allTracks: boolean) => void;
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
  readonly targetTrackIds: ReadonlySet<string>;
  readonly syncLocked: boolean;
  readonly crossTrackTargeted: boolean;
  readonly timelineTimeSeconds: number;
  readonly onTargetTrack: (trackId: string, kind: TimelineTrack['kind']) => void;
  readonly onToggleSyncLock: (trackId: string, kind: TimelineTrack['kind'], allOfKind: boolean) => void;
  readonly onCrossTrackPreview: (candidateTrackId: string | null) => string | null;
  readonly onMoveCrossTrack: (targetTrackId: string, clipId: string, start: number) => boolean;
  readonly height: number;
  readonly collapsed: boolean;
  readonly onHeightChange: (height: number) => void;
  readonly onToggleCollapse: () => void;
  readonly scrollLeftRef: React.RefObject<number>;
  readonly onDragAutoScroll: (clientX: number | null, onScroll?: (scrollLeft: number) => void) => void;
  readonly selectedTrackGroups: readonly { readonly track: TimelineTrack; readonly clips: readonly TimelineClip[] }[];
  readonly onReplaceTrackClipGroups: (groups: readonly { readonly trackId: string; readonly clips: readonly TimelineClip[] }[]) => void;
  readonly onPreviewClips: (clips: readonly TimelineClip[]) => void;
  readonly onPreviewRollingEdit: (preview: TimelineRollingPreview | null) => void;
  readonly onPreviewSlideEdit: (preview: TimelineSlidePreview | null) => void;
  readonly onStopTransport: () => void;
  readonly onPreviewDuration: (clips: readonly TimelineClip[] | null) => void;
  readonly mediaDropPreview: (ProjectMediaDragPayload & {
    readonly timeSeconds: number;
    readonly mode: 'insert' | 'overwrite';
  }) | null;
  readonly selectedTrimModeEditKeys: ReadonlySet<string>;
  readonly trimModeActive: boolean;
  readonly onToggleTrimModeEdit: (leftClipId: string, rightClipId: string, editTime: number) => void;
  readonly onMediaDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  readonly onMediaDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
  readonly onMediaDrop: (event: React.DragEvent<HTMLDivElement>) => void;
}) {
  const nonStoryIndex = nonStoryTrackIds.indexOf(track.track.id);
  const resizeGesture = useRef<{ readonly pointerId: number; readonly clientY: number; readonly height: number } | null>(null);
  const [rollingDrafts, setRollingDrafts] = useState<ReadonlyMap<string, TimelineClip>>(new Map());
  const [rippleDrafts, setRippleDrafts] = useState<ReadonlyMap<string, TimelineClip>>(new Map());
  const [rateDrafts, setRateDrafts] = useState<ReadonlyMap<string, TimelineClip>>(new Map());
  const [slideDrafts, setSlideDrafts] = useState<ReadonlyMap<string, TimelineClip>>(new Map());
  const [automationProperty, setAutomationProperty] = useState<TrackAudioProperty>('volume');
  const commitTrackClips = (clips: readonly TimelineClip[]): boolean => {
    if (timelineClipsEqual(track.track.clips, clips)) return false;
    onReplaceTrackClips(track.track.id, clips);
    return true;
  };
  const commitTrackClipGroups = (
    groups: readonly { readonly trackId: string; readonly clips: readonly TimelineClip[] }[],
  ): boolean => {
    const changed = groups.filter((group) => {
      const current = selectedTrackGroups.find((candidate) => candidate.track.id === group.trackId)?.track.clips;
      return current === undefined || !timelineClipsEqual(current, group.clips);
    });
    if (changed.length === 0) return false;
    onReplaceTrackClipGroups(changed);
    return true;
  };
  const editPoints = useMemo(() => rollingEditPoints(track.track.clips, fps), [fps, track.track.clips]);
  const slidePoints = useMemo(() => slideEditTriples(track.track.clips, fps), [fps, track.track.clips]);
  const repeatedClipIds = useMemo(() => repeatedFrameClipIds(track.track.clips), [track.track.clips]);
  const throughEditCuts = useMemo(() => timelineThroughEditCuts(track.track.clips, fps), [fps, track.track.clips]);
  useEffect(() => {
    if (editTool !== 'ripple' && rippleDrafts.size > 0) setRippleDrafts(new Map());
  }, [editTool, rippleDrafts.size]);
  useEffect(() => {
    if (editTool !== 'rolling' && rollingDrafts.size > 0) setRollingDrafts(new Map());
  }, [editTool, rollingDrafts.size]);
  useEffect(() => {
    if (editTool !== 'rate' && rateDrafts.size > 0) setRateDrafts(new Map());
  }, [editTool, rateDrafts.size]);
  useEffect(() => {
    if (editTool !== 'slide' && slideDrafts.size > 0) setSlideDrafts(new Map());
  }, [editTool, slideDrafts.size]);
  const previewSlip = (clip: TimelineClip, requestedSourceDelta: number) => {
    const selected = selectedClipIds.has(clip.id)
      ? selectedTrackGroups.flatMap((group) => group.clips)
      : [clip];
    const delta = constrainClipGroupSlipDelta(selected, requestedSourceDelta, fps);
    const previews = selected.map((candidate) => slipTimelineClip(candidate, delta, fps));
    onPreviewClips(previews);
    return previews.find((candidate) => candidate.id === clip.id) ?? clip;
  };
  const previewRolling = (edit: NonNullable<ReturnType<typeof rollTimelineEdit>>) => {
    setRollingDrafts(new Map([[edit.left.id, edit.left], [edit.right.id, edit.right]]));
    onPreviewClips([edit.left, edit.right]);
    onPreviewRollingEdit({ leftClipId: edit.left.id, rightClipId: edit.right.id, editTime: edit.editTime });
  };
  const previewRateStretch = (clip: TimelineClip, edge: 'start' | 'end', timelineTime: number) => {
    const replacement = rateStretchTimelineClip(clip, edge, timelineTime, fps);
    const clips = track.track.id === storyTrackId
      ? trimRippleClip(track.track.clips, replacement)
      : track.track.clips.map((candidate) => candidate.id === replacement.id ? replacement : candidate);
    setRateDrafts(new Map(clips.map((candidate) => [candidate.id, candidate])));
    onPreviewClips(track.track.id === storyTrackId ? clips : [replacement]);
    onPreviewDuration(clips);
    return replacement;
  };
  const previewRipple = (clip: TimelineClip, edge: 'start' | 'end', timelineTime: number) => {
    const replacement = trimTimelineClip(clip, edge, timelineTime, fps, clipMediaDuration(clip));
    const clips = track.track.id === storyTrackId
      ? trimRippleClip(track.track.clips, replacement)
      : rippleTrimTrackClip(track.track.clips, replacement, edge);
    setRippleDrafts(new Map(clips.map((candidate) => [candidate.id, candidate])));
    onPreviewClips(clips);
    onPreviewDuration(clips);
    return replacement;
  };
  const clearRipplePreview = () => {
    setRippleDrafts(new Map());
    onPreviewClips([]);
    onPreviewDuration(null);
  };
  const clearRatePreview = () => {
    setRateDrafts(new Map());
    onPreviewClips([]);
    onPreviewDuration(null);
  };
  const previewSlide = (clip: TimelineClip, requestedStart: number) => {
    const point = slidePoints.find((candidate) => candidate.clip.id === clip.id);
    if (point === undefined) return clip;
    const edit = slideTimelineClip(point.previous, point.clip, point.next, requestedStart, fps);
    if (edit === null) return clip;
    const drafts = new Map([
      [edit.previous.id, edit.previous],
      [edit.clip.id, edit.clip],
      [edit.next.id, edit.next],
    ]);
    setSlideDrafts(drafts);
    onPreviewClips([edit.previous, edit.clip, edit.next]);
    onPreviewSlideEdit({
      previousClipId: edit.previous.id,
      clipId: edit.clip.id,
      nextClipId: edit.next.id,
      startTime: edit.clip.placement.start,
    });
    return edit.clip;
  };
  const clearSlidePreview = () => {
    setSlideDrafts(new Map());
    onPreviewClips([]);
    onPreviewSlideEdit(null);
  };
  const clearRollingPreview = () => {
    setRollingDrafts(new Map());
    onPreviewClips([]);
    onPreviewRollingEdit(null);
  };
  const commitRolling = (edit: NonNullable<ReturnType<typeof rollTimelineEdit>>) => {
    onSeek(edit.editTime);
    clearRollingPreview();
    if (Math.abs(edit.delta) <= 1e-9) return;
    commitTrackClips(track.track.clips.map((clip) => {
      if (clip.id === edit.left.id) return edit.left;
      if (clip.id === edit.right.id) return edit.right;
      return clip;
    }));
  };
  return (
    <div
      className={cn(
        'relative grid min-h-0 grid-cols-[var(--w-track-head)_minmax(0,1fr)] border-b border-divider',
        crossTrackTargeted && 'bg-accent-100 ring-2 ring-inset ring-accent-500',
      )}
      role="row"
      aria-label={track.ariaLabel}
      data-timeline-track-id={track.track.id}
      data-timeline-track-kind={track.track.kind}
      data-track-output-enabled={!track.track.hidden}
      onDragOver={onMediaDragOver}
      onDragLeave={onMediaDragLeave}
      onDrop={onMediaDrop}
    >
      <TimelineTrackHead
        icon={track.icon}
        targetLabel={track.targetLabel}
        label={track.label}
        controls={track.controls}
        track={track.track}
        readOnly={readOnly}
        onReplaceTrack={onReplaceTrack}
        removable={track.track.id !== storyTrackId && !track.derivedAudio}
        renamable={!track.derivedAudio}
        onRemoveTrack={onRemoveTrack}
        canMoveUp={!track.derivedAudio && nonStoryIndex > 0}
        canMoveDown={!track.derivedAudio && nonStoryIndex >= 0 && nonStoryIndex < nonStoryTrackIds.length - 1}
        onMoveTrack={onReorderTrack}
        targeted={targetTrackIds.has(track.track.id)}
        onTargetTrack={onTargetTrack}
        syncLocked={syncLocked}
        syncLockVisible={!track.derivedAudio}
        onToggleSyncLock={onToggleSyncLock}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        timelineTimeSeconds={timelineTimeSeconds}
        fps={fps}
        automationProperty={automationProperty}
        showAutomationControls={height >= 80}
        onAutomationPropertyChange={setAutomationProperty}
      />
      <div className={cn('relative min-h-0 overflow-hidden', track.track.hidden && 'opacity-45')} style={{ width: contentWidth }}>
        {mediaDropPreview === null ? null : (
          <div
            className="pointer-events-none absolute inset-y-1 z-30 min-w-2 border-2 border-dashed border-accent-500 bg-accent-100/80"
            style={{
              left: timeToPx(scale, mediaDropPreview.timeSeconds),
              width: Math.max(8, timeToPx(scale, mediaDropPreview.durationSeconds)),
            }}
            aria-label={t`素材落点 ${track.label}`}
          >
            <span className="absolute left-1 top-1 whitespace-nowrap rounded-sm bg-accent-600 px-1 py-0.5 text-2xs text-bg">
              {mediaDropPreview.mode === 'insert' ? t`插入` : t`覆盖`} · {mediaDropPreview.kind === 'audio' ? t`音频` : t`视频`} · {formatMillisecondTimecode(mediaDropPreview.durationSeconds)}
            </span>
          </div>
        )}
        {track.track.id === storyTrackId ? (
          <TimelineChangeGhosts
            changes={ghostChanges}
            scale={scale}
            audio={track.kind === 'audio'}
          />
        ) : null}
        {track.track.id === storyTrackId ? null : timelineGaps(track.track.clips).map((gap) => {
          const active = selectedGap?.trackId === track.track.id
            && Math.abs(selectedGap.start - gap.start) <= 1e-6
            && Math.abs(selectedGap.end - gap.end) <= 1e-6;
          return <button
            key={`gap:${gap.start}:${gap.end}`}
            type="button"
            className={cn(
              'absolute inset-y-1 z-10 min-w-1 border border-dashed border-neutral-300 bg-neutral-100/45 text-2xs text-neutral-500 outline-none hover:border-accent-400 hover:bg-accent-100/50 focus-visible:ring-2 focus-visible:ring-accent-500',
              active && 'border-accent-600 bg-accent-100 ring-2 ring-inset ring-accent-600',
            )}
            style={{ left: timeToPx(scale, gap.start), width: Math.max(2, timeToPx(scale, gap.duration)) }}
            aria-label={t`间隙 ${track.label} ${formatMillisecondTimecode(gap.start)} 到 ${formatMillisecondTimecode(gap.end)}`}
            aria-pressed={active}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onSelectGap(gap);
            }}
          >{timeToPx(scale, gap.duration) >= 56 ? <Trans>间隙</Trans> : null}</button>;
        })}
        {displaySettings.throughEdits ? throughEditCuts.map((cut) => (
          <span
            key={`through:${cut}`}
            className="pointer-events-none absolute inset-y-1 z-50 w-2 -translate-x-1/2 border-x border-warn bg-warn-surface/75"
            style={{ left: timeToPx(scale, cut) }}
            aria-label={t`Through Edit ${formatMillisecondTimecode(cut)}`}
            role="img"
          />
        )) : null}
        {track.clips.map((clip) => (
          <TimelineClipCell
            key={`${track.id}:${clip.id}`}
            clip={rippleDrafts.get(clip.id) ?? rollingDrafts.get(clip.id) ?? rateDrafts.get(clip.id) ?? slideDrafts.get(clip.id) ?? clip}
            kind={track.kind}
            derivedAudio={track.derivedAudio}
            selected={selectedClipIds.has(clip.id)}
            primary={selectedClipId === clip.id}
            selectedTransition={selectedTransition?.trackId === track.track.id && selectedTransition.clipId === clip.id
              ? selectedTransition
              : null}
            selectedEditPoint={selectedEditPoint?.clipId === clip.id ? selectedEditPoint.edge : null}
            displaySettings={displaySettings}
            repeatedFrames={displaySettings.repeatedFrames && repeatedClipIds.has(clip.id)}
            deliveryState={deliveryStateByClipId.get(clip.id)}
            sourceMarkers={clip.material.kind === 'planned' || clip.material.kind === 'sequence'
              ? []
              : sourceMarkersByAssetId.get(clip.material.asset_id) ?? []}
            outOfSyncFrames={outOfSyncFramesByClipId.get(clip.id) ?? 0}
            editTool={editTool}
            scale={scale}
            fps={fps}
            readOnly={readOnly || track.track.locked || track.derivedAudio}
            gainReadOnly={readOnly || track.track.locked}
            trackHeight={height}
            thumbnailWindowStartPx={thumbnailWindowStartPx}
            thumbnailWindowEndPx={thumbnailWindowEndPx}
            localTime={clipLocalTimeAtTimeline(clip, timelineTimeSeconds, fps)}
            change={changeByClipId.get(clip.id) ?? null}
            onSelect={(additive, range) => {
              onSelectTransition(null);
              onSelectClip(clip.id, additive, range);
            }}
            onSelectTransition={(channel, edge) => {
              onSelectClip(clip.id, false, false);
              onSelectTransition({ trackId: track.track.id, clipId: clip.id, channel, edge });
            }}
            onSelectEditPoint={(edge) => onSelectEditPoint(clip.id, edge)}
            onCrossTrackPreview={onCrossTrackPreview}
            onMoveCrossTrack={(targetTrackId, start) => onMoveCrossTrack(targetTrackId, clip.id, start)}
            onPromote={() => onPromoteClip(clip.id)}
            onInspect={() => onInspectClip(clip.id)}
            onRestoreSync={() => onRestoreClipSync(clip.id)}
            onSeek={onSeek}
            razorEnabled={!readOnly && !track.track.locked}
            onRazor={onRazor}
            onTrackSelect={onTrackSelect}
            snapPoints={snapPoints}
            snapThresholdSeconds={snapThresholdSeconds}
            onSnapChange={onSnapChange}
            scrollLeftRef={scrollLeftRef}
            onDragAutoScroll={onDragAutoScroll}
            onPreviewSlip={(requestedSourceDelta) => previewSlip(clip, requestedSourceDelta)}
            storyTrack={track.track.id === storyTrackId}
            canSlide={slidePoints.some((point) => point.clip.id === clip.id)}
            onPreviewRateStretch={(edge, timelineTime) => previewRateStretch(clip, edge, timelineTime)}
            onPreviewRipple={(edge, timelineTime) => previewRipple(clip, edge, timelineTime)}
            onPreviewSlide={(timelineTime) => previewSlide(clip, timelineTime)}
            onPreviewTransition={(replacement) => onPreviewClips([replacement])}
            onStopTransport={onStopTransport}
            onClearPreview={() => {
              clearRipplePreview();
              clearRatePreview();
              onPreviewRollingEdit(null);
              clearSlidePreview();
            }}
            onReplace={(replacement, mode): boolean => {
              if (mode === 'slip') {
                const original = track.track.clips.find((candidate) => candidate.id === replacement.id);
                if (original === undefined) return false;
                const selected = selectedClipIds.has(replacement.id)
                  ? selectedTrackGroups.flatMap((group) => group.clips)
                  : [original];
                const delta = constrainClipGroupSlipDelta(
                  selected,
                  replacement.placement.source_in - original.placement.source_in,
                  fps,
                );
                if (Math.abs(delta) <= 1e-9) return false;
                if (selected.length === 1) {
                  onReplaceClip(slipTimelineClip(original, delta, fps));
                  return true;
                }
                return commitTrackClipGroups(selectedTrackGroups.map((group) => {
                  const ids = new Set(group.clips.map((candidate) => candidate.id));
                  return {
                    trackId: group.track.id,
                    clips: group.track.clips.map((candidate) => ids.has(candidate.id)
                      ? slipTimelineClip(candidate, delta, fps)
                      : candidate),
                  };
                }));
              }
              if (mode === 'slide') {
                const point = slidePoints.find((candidate) => candidate.clip.id === replacement.id);
                if (point === undefined) return false;
                const edit = slideTimelineClip(point.previous, point.clip, point.next, replacement.placement.start, fps);
                if (edit === null || Math.abs(edit.delta) <= 1e-9) return false;
                onSeek(edit.clip.placement.start);
                return commitTrackClips(track.track.clips.map((candidate) => {
                  if (candidate.id === edit.previous.id) return edit.previous;
                  if (candidate.id === edit.clip.id) return edit.clip;
                  if (candidate.id === edit.next.id) return edit.next;
                  return candidate;
                }));
              }
              if (mode === 'rate_start' || mode === 'rate_end' || mode === 'speed_remap') {
                if (track.track.id === storyTrackId) {
                  return commitTrackClips(trimRippleClip(track.track.clips, replacement));
                }
                onReplaceClip(replacement);
                return true;
              }
              if (mode === 'ripple_start' || mode === 'ripple_end') {
                const edge = mode === 'ripple_start' ? 'start' : 'end';
                return commitTrackClips(track.track.id === storyTrackId
                  ? trimRippleClip(track.track.clips, replacement)
                  : rippleTrimTrackClip(track.track.clips, replacement, edge));
              }
              if ((mode === 'start' || mode === 'end')
                && selectedClipIds.has(replacement.id)
                && selectedTrackGroups.reduce((total, group) => total + group.clips.length, 0) > 1) {
                const original = track.track.clips.find((candidate) => candidate.id === replacement.id);
                if (original === undefined) return false;
                const requestedDelta = mode === 'start'
                  ? replacement.placement.start - original.placement.start
                  : replacement.placement.duration - original.placement.duration;
                const allSelected = selectedTrackGroups.flatMap((group) => group.clips);
                const delta = constrainClipGroupTrimDelta(allSelected, mode, requestedDelta, fps);
                return commitTrackClipGroups(selectedTrackGroups.map((group) => {
                  const ids = new Set(group.clips.map((candidate) => candidate.id));
                  return {
                    trackId: group.track.id,
                    clips: group.track.id === storyTrackId
                      ? trimRippleClipGroup(group.track.clips, ids, mode, delta, fps)
                      : trimFreeClipGroup(group.track.clips, ids, mode, delta, fps),
                  };
                }));
              }
              if (mode === 'move'
                && selectedClipIds.has(replacement.id)
                && selectedTrackGroups.length > 1) {
                const original = track.track.clips.find((candidate) => candidate.id === replacement.id);
                if (original === undefined) return false;
                const requestedDelta = replacement.placement.start - original.placement.start;
                const minimumSelectedStart = Math.min(...selectedTrackGroups.flatMap((group) => group.clips.map((candidate) => candidate.placement.start)));
                const delta = Math.max(requestedDelta, -minimumSelectedStart);
                return commitTrackClipGroups(selectedTrackGroups.map((group) => {
                  const ids = new Set(group.clips.map((candidate) => candidate.id));
                  const anchor = group.clips[0]!;
                  return {
                    trackId: group.track.id,
                    clips: group.track.id === storyTrackId
                      ? moveRippleClipGroup(group.track.clips, ids, anchor.id, anchor.placement.start + delta)
                      : moveFreeClipGroup(group.track.clips, ids, anchor.id, anchor.placement.start + delta, fps),
                  };
                }));
              }
              if (mode === 'volume') {
                onReplaceClip(replacement);
                return true;
              }
              if (mode === 'transition') {
                onReplaceClip(replacement);
                return true;
              }
              const selectedOnTrack = new Set(track.track.clips
                .filter((candidate) => selectedClipIds.has(candidate.id))
                .map((candidate) => candidate.id));
              if (mode === 'move' && selectedOnTrack.has(replacement.id) && selectedOnTrack.size > 1) {
                return commitTrackClips(
                  track.track.id === storyTrackId
                    ? moveRippleClipGroup(track.track.clips, selectedOnTrack, replacement.id, replacement.placement.start)
                    : moveFreeClipGroup(track.track.clips, selectedOnTrack, replacement.id, replacement.placement.start, fps),
                );
              }
              if (track.track.id !== storyTrackId) {
                onReplaceClip(replacement);
                return true;
              }
              const clips = mode === 'move'
                ? moveRippleClip(track.track.clips, replacement.id, replacement.placement.start)
                : trimRippleClip(track.track.clips, replacement);
              return commitTrackClips(clips);
            }}
          />
        ))}
        {track.controls !== 'audio' || collapsed || !displaySettings.keyframes ? null : (
          <TimelineTrackAutomation
            track={track.track}
            property={automationProperty}
            scale={scale}
            contentWidth={contentWidth}
            height={height}
            fps={fps}
            readOnly={readOnly || track.track.locked}
            onReplaceTrack={onReplaceTrack}
          />
        )}
        {editTool !== 'rolling' || track.derivedAudio ? null : editPoints.map((point) => (
          <TimelineRollingHandle
            key={`${point.left.id}:${point.right.id}`}
            left={point.left}
            right={point.right}
            scale={scale}
            fps={fps}
            readOnly={readOnly || track.track.locked}
            selected={selectedTrimModeEditKeys.has(`${track.track.id}:${point.left.id}:${point.right.id}`)}
            selectionEnabled={trimModeActive}
            snapPoints={snapPoints}
            snapThresholdSeconds={snapThresholdSeconds}
            scrollLeftRef={scrollLeftRef}
            onDragAutoScroll={onDragAutoScroll}
            onSnapChange={onSnapChange}
            onBegin={(editTime) => {
              onStopTransport();
              onSeek(editTime);
            }}
            onPreview={previewRolling}
            onCancel={clearRollingPreview}
            onCommit={commitRolling}
            onToggleSelection={() => onToggleTrimModeEdit(
              point.left.id,
              point.right.id,
              point.left.placement.start + point.left.placement.duration,
            )}
          />
        ))}
      </div>
      <span
        role="separator"
        aria-label={t`调整轨道高度 ${track.label}`}
        aria-orientation="horizontal"
        aria-valuemin={MIN_TRACK_HEIGHT}
        aria-valuemax={MAX_TRACK_HEIGHT}
        aria-valuenow={height}
        className="absolute inset-x-0 -bottom-0.5 z-40 h-1 cursor-row-resize touch-none bg-transparent hover:bg-accent-300"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          resizeGesture.current = { pointerId: event.pointerId, clientY: event.clientY, height };
        }}
        onPointerMove={(event) => {
          const gesture = resizeGesture.current;
          if (gesture === null || gesture.pointerId !== event.pointerId) return;
          event.preventDefault();
          event.stopPropagation();
          onHeightChange(gesture.height + event.clientY - gesture.clientY);
        }}
        onPointerUp={(event) => {
          if (resizeGesture.current?.pointerId !== event.pointerId) return;
          event.preventDefault();
          event.stopPropagation();
          resizeGesture.current = null;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
      />
    </div>
  );
}, (previous, next) => previous.track === next.track
  && previous.scale.pixelsPerSecond === next.scale.pixelsPerSecond
  && previous.contentWidth === next.contentWidth
  && previous.selectedClipId === next.selectedClipId
  && previous.selectedClipIds === next.selectedClipIds
  && previous.selectedTransition === next.selectedTransition
  && previous.selectedGap === next.selectedGap
  && previous.displaySettings === next.displaySettings
  && previous.outOfSyncFramesByClipId === next.outOfSyncFramesByClipId
  && previous.selectedEditPoint === next.selectedEditPoint
  && previous.editTool === next.editTool
  && previous.fps === next.fps
  && previous.readOnly === next.readOnly
  && previous.storyTrackId === next.storyTrackId
  && previous.changeByClipId === next.changeByClipId
  && previous.ghostChanges === next.ghostChanges
  && previous.snapPoints === next.snapPoints
  && previous.snapThresholdSeconds === next.snapThresholdSeconds
  && previous.nonStoryTrackIds === next.nonStoryTrackIds
  && previous.targetTrackIds === next.targetTrackIds
  && previous.syncLocked === next.syncLocked
  && previous.crossTrackTargeted === next.crossTrackTargeted
  && previous.height === next.height
  && previous.collapsed === next.collapsed
  && previous.mediaDropPreview === next.mediaDropPreview
  && previous.selectedTrimModeEditKeys === next.selectedTrimModeEditKeys
  && previous.trimModeActive === next.trimModeActive);

interface RollingEditPoint {
  readonly left: TimelineClip;
  readonly right: TimelineClip;
}

function rollingEditPoints(clips: readonly TimelineClip[], fps: number): RollingEditPoint[] {
  const ordered = [...clips].sort((left, right) => left.placement.start - right.placement.start);
  const points: RollingEditPoint[] = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const left = ordered[index]!;
    const right = ordered[index + 1]!;
    if (canRollTimelineEdit(left, right, fps)) points.push({ left, right });
  }
  return points;
}

interface SlideEditTriple {
  readonly previous: TimelineClip;
  readonly clip: TimelineClip;
  readonly next: TimelineClip;
}

function slideEditTriples(clips: readonly TimelineClip[], fps: number): SlideEditTriple[] {
  const ordered = [...clips].sort((left, right) => left.placement.start - right.placement.start);
  const triples: SlideEditTriple[] = [];
  for (let index = 1; index < ordered.length - 1; index += 1) {
    const previous = ordered[index - 1]!;
    const clip = ordered[index]!;
    const next = ordered[index + 1]!;
    if (canSlideTimelineClip(previous, clip, next, fps)) triples.push({ previous, clip, next });
  }
  return triples;
}

function TimelineRollingHandle({ left, right, scale, fps, readOnly, selected, selectionEnabled, snapPoints, snapThresholdSeconds, scrollLeftRef, onDragAutoScroll, onSnapChange, onBegin, onPreview, onCancel, onCommit, onToggleSelection }: {
  readonly left: TimelineClip;
  readonly right: TimelineClip;
  readonly scale: TimeScale;
  readonly fps: number;
  readonly readOnly: boolean;
  readonly selected: boolean;
  readonly selectionEnabled: boolean;
  readonly snapPoints: readonly { readonly time: number; readonly clipId: string | null }[];
  readonly snapThresholdSeconds: number;
  readonly scrollLeftRef: React.RefObject<number>;
  readonly onDragAutoScroll: (clientX: number | null, onScroll?: (scrollLeft: number) => void) => void;
  readonly onSnapChange: (time: number | null) => void;
  readonly onBegin: (editTime: number) => void;
  readonly onPreview: (edit: NonNullable<ReturnType<typeof rollTimelineEdit>>) => void;
  readonly onCancel: () => void;
  readonly onCommit: (edit: NonNullable<ReturnType<typeof rollTimelineEdit>>) => void;
  readonly onToggleSelection: () => void;
}) {
  const boundary = left.placement.start + left.placement.duration;
  const [draft, setDraft] = useState<NonNullable<ReturnType<typeof rollTimelineEdit>> | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const gesture = useRef<{
    readonly pointerId: number;
    readonly clientX: number;
    readonly scrollLeft: number;
    lastClientX: number;
    shiftKey: boolean;
    moved: boolean;
  } | null>(null);
  const windowMouseUpRef = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    if (windowMouseUpRef.current !== null) window.removeEventListener('mouseup', windowMouseUpRef.current);
  }, []);
  const update = (active: NonNullable<typeof gesture.current>, clientX: number, scrollLeft: number, shiftKey: boolean) => {
    const delta = pxToTime(scale, clientX - active.clientX + scrollLeft - active.scrollLeft);
    const rawEditTime = boundary + delta;
    const snap = shiftKey
      ? { anchorTime: rawEditTime, snapTime: null }
      : resolveTimelineSnap(
          rawEditTime,
          [0],
          snapPoints
            .filter((point) => point.clipId !== left.id && point.clipId !== right.id)
            .map((point) => point.time),
          snapThresholdSeconds,
        );
    const next = rollTimelineEdit(left, right, snap.anchorTime, fps);
    if (next === null) return;
    onSnapChange(snap.snapTime);
    draftRef.current = next;
    setDraft(next);
    onPreview(next);
    if (Math.abs(clientX - active.clientX + scrollLeft - active.scrollLeft) > 5) active.moved = true;
  };
  const finishCore = () => {
    const active = gesture.current;
    if (active === null) return;
    gesture.current = null;
    if (windowMouseUpRef.current !== null) {
      window.removeEventListener('mouseup', windowMouseUpRef.current);
      windowMouseUpRef.current = null;
    }
    onDragAutoScroll(null);
    onSnapChange(null);
    const result = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (active.moved && result !== null) onCommit(result);
    else onCancel();
  };
  const visualEditTime = draft?.editTime ?? boundary;
  return (
    <span
      role="separator"
      tabIndex={readOnly ? -1 : 0}
      aria-label={t`滚动编辑 ${left.name} / ${right.name}`}
      aria-orientation="vertical"
      aria-valuenow={visualEditTime}
      aria-valuetext={formatMillisecondTimecode(visualEditTime)}
      className={cn(
        'absolute inset-y-0 z-[60] w-3 -translate-x-1/2 touch-none select-none outline-none',
        readOnly ? 'cursor-not-allowed' : 'cursor-col-resize focus-visible:ring-2 focus-visible:ring-accent-500',
        selected && 'bg-accent-200/70 ring-2 ring-inset ring-accent-600',
      )}
      style={{ left: timeToPx(scale, visualEditTime) }}
      data-rolling-left-clip-id={left.id}
      data-rolling-right-clip-id={right.id}
      data-rolling-edit-time={visualEditTime}
      aria-current={selected ? 'true' : undefined}
      onPointerDown={(event) => {
        if (readOnly || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        if (selectionEnabled && (event.ctrlKey || event.metaKey || event.shiftKey)) {
          onToggleSelection();
          return;
        }
        event.currentTarget.setPointerCapture?.(event.pointerId);
        onBegin(boundary);
        const initial = rollTimelineEdit(left, right, boundary, fps);
        draftRef.current = initial;
        setDraft(initial);
        if (initial !== null) onPreview(initial);
        gesture.current = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          scrollLeft: scrollLeftRef.current ?? 0,
          lastClientX: event.clientX,
          shiftKey: event.shiftKey,
          moved: false,
        };
        onDragAutoScroll(event.clientX, (nextScrollLeft) => {
          const active = gesture.current;
          if (active !== null) update(active, active.lastClientX, nextScrollLeft, active.shiftKey);
        });
        const finishFromWindow = () => finishCore();
        windowMouseUpRef.current = finishFromWindow;
        window.addEventListener('mouseup', finishFromWindow, { once: true });
      }}
      onPointerMove={(event) => {
        const active = gesture.current;
        if (active === null || active.pointerId !== event.pointerId) return;
        event.preventDefault();
        active.lastClientX = event.clientX;
        active.shiftKey = event.shiftKey;
        onDragAutoScroll(event.clientX);
        update(active, event.clientX, scrollLeftRef.current ?? 0, event.shiftKey);
      }}
      onPointerUp={(event) => {
        if (gesture.current?.pointerId !== event.pointerId) return;
        event.preventDefault();
        finishCore();
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }}
      onPointerCancel={() => {
        gesture.current = null;
        if (windowMouseUpRef.current !== null) window.removeEventListener('mouseup', windowMouseUpRef.current);
        windowMouseUpRef.current = null;
        draftRef.current = null;
        setDraft(null);
        onDragAutoScroll(null);
        onSnapChange(null);
        onCancel();
      }}
      onKeyDown={(event) => {
        if (readOnly || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
        event.preventDefault();
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        const next = rollTimelineEdit(left, right, boundary + direction * (event.shiftKey ? 1 : 1 / fps), fps);
        if (next === null || Math.abs(next.delta) <= 1e-9) return;
        onBegin(boundary);
        onPreview(next);
        onCommit(next);
      }}
    >
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-accent-600" />
      <span className="pointer-events-none absolute left-0 top-1/2 h-7 w-1 -translate-y-1/2 rounded-l-sm border border-r-0 border-accent-600 bg-accent-100" />
      <span className="pointer-events-none absolute right-0 top-1/2 h-7 w-1 -translate-y-1/2 rounded-r-sm border border-l-0 border-accent-600 bg-accent-100" />
      {draft === null ? null : (
        <span className="pointer-events-none absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap rounded-sm bg-neutral-950 px-2 py-1 font-mono text-2xs text-bg" aria-label={t`滚动编辑预览 ${formatSignedTimelineDelta(draft.delta)}`}>
          {formatSignedTimelineDelta(draft.delta)} · {formatMillisecondTimecode(draft.left.placement.source_out)} | {formatMillisecondTimecode(draft.right.placement.source_in)}
        </span>
      )}
    </span>
  );
}

const TimelineClipCell = memo(function TimelineClipCell({ clip, kind, derivedAudio, selected, primary, selectedTransition, selectedEditPoint, displaySettings, repeatedFrames, deliveryState, sourceMarkers, outOfSyncFrames, editTool, storyTrack, canSlide, scale, fps, readOnly, razorEnabled, gainReadOnly, trackHeight, thumbnailWindowStartPx, thumbnailWindowEndPx, localTime, change, onSelect, onSelectTransition, onSelectEditPoint, onCrossTrackPreview, onMoveCrossTrack, onPromote, onInspect, onRestoreSync, onSeek, onRazor, onTrackSelect, onReplace, snapPoints, snapThresholdSeconds, onSnapChange, scrollLeftRef, onDragAutoScroll, onPreviewSlip, onPreviewRipple, onPreviewRateStretch, onPreviewSlide, onPreviewTransition, onStopTransport, onClearPreview }: {
  readonly clip: TimelineClip;
  readonly kind: RenderedTrack['kind'];
  readonly derivedAudio: boolean;
  readonly selected: boolean;
  readonly primary: boolean;
  readonly selectedTransition: SelectedTimelineTransition | null;
  readonly selectedEditPoint: 'start' | 'end' | null;
  readonly displaySettings: TimelineDisplaySettings;
  readonly repeatedFrames: boolean;
  readonly deliveryState?: TimelineClipMaterializationState | undefined;
  readonly sourceMarkers: readonly EditorMarker[];
  readonly outOfSyncFrames: number;
  readonly editTool: TimelineEditTool;
  readonly storyTrack: boolean;
  readonly canSlide: boolean;
  readonly scale: TimeScale;
  readonly fps: number;
  readonly readOnly: boolean;
  readonly razorEnabled: boolean;
  readonly gainReadOnly: boolean;
  readonly trackHeight: number;
  readonly thumbnailWindowStartPx: number;
  readonly thumbnailWindowEndPx: number;
  readonly localTime: number;
  readonly change: TimelineClipChange | null;
  readonly onSelect: (additive: boolean, range: boolean) => void;
  readonly onSelectTransition: (channel: 'video' | 'audio', edge: 'in' | 'out') => void;
  readonly onSelectEditPoint: (edge: 'start' | 'end') => void;
  readonly onCrossTrackPreview: (candidateTrackId: string | null) => string | null;
  readonly onMoveCrossTrack: (targetTrackId: string, start: number) => boolean;
  readonly onPromote: () => void;
  readonly onInspect: () => void;
  readonly onRestoreSync: () => void;
  readonly onSeek: (seconds: number) => void;
  readonly onRazor: (time: number, allTracks: boolean, followLinkedClips: boolean) => void;
  readonly onTrackSelect: (time: number, direction: 'forward' | 'backward', allTracks: boolean) => void;
  readonly onReplace: (clip: TimelineClip, mode: 'move' | 'start' | 'end' | 'ripple_start' | 'ripple_end' | 'slip' | 'slide' | 'rate_start' | 'rate_end' | 'volume' | 'transition' | 'speed_remap') => boolean;
  readonly snapPoints: readonly { readonly time: number; readonly clipId: string | null }[];
  readonly snapThresholdSeconds: number;
  readonly onSnapChange: (time: number | null) => void;
  readonly scrollLeftRef: React.RefObject<number>;
  readonly onDragAutoScroll: (clientX: number | null, onScroll?: (scrollLeft: number) => void) => void;
  readonly onPreviewSlip: (requestedSourceDelta: number) => TimelineClip;
  readonly onPreviewRipple: (edge: 'start' | 'end', timelineTime: number) => TimelineClip;
  readonly onPreviewRateStretch: (edge: 'start' | 'end', timelineTime: number) => TimelineClip;
  readonly onPreviewSlide: (timelineTime: number) => TimelineClip;
  readonly onPreviewTransition: (clip: TimelineClip) => void;
  readonly onStopTransport: () => void;
  readonly onClearPreview: () => void;
}) {
  const shell = useNativeShell();
  const resolvedMaterial = resolveTimelineMaterial(clip.material, clip.placement);
  const material = {
    ...resolvedMaterial,
    state: timelineClipMaterialState(clip, deliveryState),
  };
  const enabledEffectCount = clip.effects.filter((effect) => effect.enabled).length;
  const keyframeGroups = useMemo(() => {
    const groups = new Map<number, number>();
    for (const keyframe of clip.keyframes) groups.set(keyframe.time, (groups.get(keyframe.time) ?? 0) + 1);
    return [...groups.entries()].sort((left, right) => left[0] - right[0]);
  }, [clip.keyframes]);
  const clipMarkers = sourceMarkers.flatMap((marker) => {
    const markerEnd = marker.time + marker.duration;
    if (markerEnd < clip.placement.source_in - 1e-6 || marker.time > clip.placement.source_out + 1e-6) return [];
    const start = clipLocalTimeAtSourceTime(clip, Math.max(marker.time, clip.placement.source_in));
    const end = clipLocalTimeAtSourceTime(clip, Math.min(markerEnd, clip.placement.source_out));
    return [{ marker, start: Math.min(start, end), duration: Math.abs(end - start) }];
  });
  const [visualClip, setVisualClip] = useState(clip);
  const visualClipRef = useRef(visualClip);
  visualClipRef.current = visualClip;
  const windowMouseUpRef = useRef<(() => void) | null>(null);
  const lastGestureWasDragRef = useRef(false);
  const gesture = useRef<{
    readonly pointerId: number;
    readonly clientX: number;
    readonly scrollLeft: number;
    readonly mode: 'move' | 'start' | 'end' | 'ripple_start' | 'ripple_end' | 'slip' | 'slide' | 'rate_start' | 'rate_end';
    readonly clip: TimelineClip;
    lastClientX: number;
    shiftKey: boolean;
    moved: boolean;
    targetTrackId: string | null;
  } | null>(null);
  useEffect(() => {
    setVisualClip(clip);
    visualClipRef.current = clip;
  }, [clip]);
  useEffect(() => () => {
    if (windowMouseUpRef.current !== null) window.removeEventListener('mouseup', windowMouseUpRef.current);
  }, []);
  if (derivedAudio) {
    return (
      <div
        className={cn(
          'absolute inset-y-0 border-r border-divider',
          change?.kind === 'added' && 'border-ok-border bg-ok-surface',
          change?.kind === 'modified' && 'border-accent-400 bg-accent-100',
        )}
        style={{
          left: timeToPx(scale, clip.placement.start),
          width: Math.max(2, timeToPx(scale, clip.placement.duration)),
        }}
      >
        {displaySettings.waveforms ? <TimelineClipWaveform clip={clip} change={change} /> : null}
        <TimelineGainControl
          clip={clip}
          trackHeight={trackHeight}
          readOnly={gainReadOnly}
          selected={selected}
          localTime={localTime}
          fps={fps}
          onReplace={(replacement) => onReplace(replacement, 'volume')}
        />
        <TimelineTransitionControls
          clip={clip}
          channel="audio"
          scale={scale}
          fps={fps}
          readOnly={gainReadOnly}
          selected={selected}
          selectedEdge={selectedTransition?.channel === 'audio' ? selectedTransition.edge : null}
          onSelect={() => onSelect(false, false)}
          onSelectTransition={(edge) => onSelectTransition('audio', edge)}
          onInspect={onInspect}
          onPreview={onPreviewTransition}
          onClearPreview={onClearPreview}
          onStopTransport={onStopTransport}
          scrollLeftRef={scrollLeftRef}
          onDragAutoScroll={onDragAutoScroll}
          onReplace={(replacement) => onReplace(replacement, 'transition')}
        />
        {change === null ? null : <TimelineClipChangeOverlay change={change} clip={clip} scale={scale} compact />}
      </div>
    );
  }
  const visualLeft = timeToPx(scale, visualClip.placement.start);
  const visualWidth = Math.max(2, timeToPx(scale, visualClip.placement.duration));
  const canSlip = kind !== 'text' && kind !== 'caption' && canSlipTimelineClip(clip, fps);
  const canRateStretch = kind !== 'text' && kind !== 'caption' && canRateStretchTimelineClip(clip);
  const gestureBaseClip = gesture.current?.clip ?? clip;
  const slipDelta = visualClip.placement.source_in - gestureBaseClip.placement.source_in;
  const slideDelta = visualClip.placement.start - gestureBaseClip.placement.start;
  const rateStretching = Math.abs(visualClip.placement.speed - gestureBaseClip.placement.speed) > 1e-9;
  const updateVisualGesture = (
    active: NonNullable<typeof gesture.current>,
    clientX: number,
    currentScrollLeft: number,
    shiftKey: boolean,
  ) => {
    const deltaSeconds = pxToTime(
      scale,
      clientX - active.clientX + currentScrollLeft - active.scrollLeft,
    );
    if (active.mode === 'slip') {
      onSnapChange(null);
      const next = onPreviewSlip(-deltaSeconds);
      visualClipRef.current = next;
      setVisualClip(next);
      if (Math.abs(clientX - active.clientX + currentScrollLeft - active.scrollLeft) > 5) active.moved = true;
      return;
    }
    if (active.mode === 'slide') {
      const rawStart = active.clip.placement.start + deltaSeconds;
      const snap = shiftKey
        ? { anchorTime: rawStart, snapTime: null }
        : resolveTimelineSnap(
            rawStart,
            [0, active.clip.placement.duration],
            snapPoints.filter((point) => point.clipId !== active.clip.id).map((point) => point.time),
            snapThresholdSeconds,
          );
      const next = onPreviewSlide(snap.anchorTime);
      onSnapChange(snap.snapTime);
      visualClipRef.current = next;
      setVisualClip(next);
      if (Math.abs(clientX - active.clientX + currentScrollLeft - active.scrollLeft) > 5) active.moved = true;
      return;
    }
    if (active.mode === 'rate_start' || active.mode === 'rate_end') {
      const rawAnchor = active.mode === 'rate_end'
        ? active.clip.placement.start + active.clip.placement.duration + deltaSeconds
        : active.clip.placement.start + deltaSeconds;
      const snap = shiftKey
        ? { anchorTime: rawAnchor, snapTime: null }
        : resolveTimelineSnap(
            rawAnchor,
            [0],
            snapPoints.filter((point) => point.clipId !== active.clip.id).map((point) => point.time),
            snapThresholdSeconds,
          );
      const next = onPreviewRateStretch(active.mode === 'rate_end' ? 'end' : 'start', snap.anchorTime);
      onSnapChange(snap.snapTime);
      visualClipRef.current = next;
      setVisualClip(next);
      if (Math.abs(clientX - active.clientX + currentScrollLeft - active.scrollLeft) > 5) active.moved = true;
      return;
    }
    if (active.mode === 'ripple_start' || active.mode === 'ripple_end') {
      const edge = active.mode === 'ripple_start' ? 'start' : 'end';
      const rawAnchor = edge === 'end'
        ? active.clip.placement.start + active.clip.placement.duration + deltaSeconds
        : active.clip.placement.start + deltaSeconds;
      const snap = shiftKey
        ? { anchorTime: rawAnchor, snapTime: null }
        : resolveTimelineSnap(
            rawAnchor,
            [0],
            snapPoints.filter((point) => point.clipId !== active.clip.id).map((point) => point.time),
            snapThresholdSeconds,
          );
      const next = onPreviewRipple(edge, snap.anchorTime);
      onSnapChange(snap.snapTime);
      visualClipRef.current = next;
      setVisualClip(next);
      if (Math.abs(clientX - active.clientX + currentScrollLeft - active.scrollLeft) > 5) active.moved = true;
      return;
    }
    const rawAnchor = active.mode === 'end'
      ? active.clip.placement.start + active.clip.placement.duration + deltaSeconds
      : active.clip.placement.start + deltaSeconds;
    const snap = shiftKey
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
    visualClipRef.current = next;
    setVisualClip(next);
    if (Math.abs(clientX - active.clientX + currentScrollLeft - active.scrollLeft) > 5) active.moved = true;
  };
  const finishGestureCore = () => {
    const active = gesture.current;
    if (active === null) return;
    gesture.current = null;
    if (windowMouseUpRef.current !== null) {
      window.removeEventListener('mouseup', windowMouseUpRef.current);
      windowMouseUpRef.current = null;
    }
    onDragAutoScroll(null);
    onCrossTrackPreview(null);
    onSnapChange(null);
    if (active.mode === 'slip' || active.mode === 'slide' || active.mode === 'rate_start' || active.mode === 'rate_end' || active.mode === 'ripple_start' || active.mode === 'ripple_end') onClearPreview();
    const replacement = visualClipRef.current;
    lastGestureWasDragRef.current = active.moved;
    if (active.mode === 'move'
      && active.targetTrackId !== null
      && onMoveCrossTrack(active.targetTrackId, replacement.placement.start)) return;
    if (JSON.stringify(replacement.placement) !== JSON.stringify(active.clip.placement)
      && onReplace(replacement, active.mode)) {
      return;
    }
    visualClipRef.current = active.clip;
    setVisualClip(active.clip);
  };
  const beginGesture = (event: React.PointerEvent<HTMLElement>, mode: 'move' | 'start' | 'end' | 'ripple_start' | 'ripple_end' | 'slip' | 'slide' | 'rate_start' | 'rate_end') => {
    if (readOnly
      || event.button !== 0
      || (mode === 'slip' && !canSlip)
      || (mode === 'slide' && !canSlide)
      || ((mode === 'rate_start' || mode === 'rate_end') && !canRateStretch)) return;
    event.preventDefault();
    event.stopPropagation();
    const additive = event.ctrlKey || event.metaKey;
    const range = event.shiftKey;
    if (!selected || additive || range) onSelect(additive, range);
    if (additive || range) return;
    if (mode === 'slip' || mode === 'slide' || mode === 'rate_start' || mode === 'rate_end') {
      onStopTransport();
      onSeek(clip.placement.start + Math.min(
        clip.placement.duration - 1 / fps,
        Math.max(0, localTime),
      ));
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    gesture.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      scrollLeft: scrollLeftRef.current ?? 0,
      mode,
      clip,
      lastClientX: event.clientX,
      shiftKey: event.shiftKey,
      moved: false,
      targetTrackId: null,
    };
    lastGestureWasDragRef.current = false;
    onDragAutoScroll(event.clientX, (nextScrollLeft) => {
      const active = gesture.current;
      if (active !== null) updateVisualGesture(active, active.lastClientX, nextScrollLeft, active.shiftKey);
    });
    const finishFromWindow = () => finishGestureCore();
    windowMouseUpRef.current = finishFromWindow;
    window.addEventListener('mouseup', finishFromWindow, { once: true });
  };
  const updateGesture = (event: React.PointerEvent<HTMLElement>) => {
    const active = gesture.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    active.lastClientX = event.clientX;
    active.shiftKey = event.shiftKey;
    if (active.mode === 'move') {
      const target = globalThis.document.elementFromPoint?.(event.clientX, event.clientY)
        ?.closest<HTMLElement>('[data-timeline-track-id]')
        ?.dataset.timelineTrackId ?? null;
      active.targetTrackId = onCrossTrackPreview(target);
      if (active.targetTrackId !== null) active.moved = true;
    }
    onDragAutoScroll(event.clientX);
    updateVisualGesture(active, event.clientX, scrollLeftRef.current ?? 0, event.shiftKey);
  };
  const finishGesture = (event: React.PointerEvent<HTMLElement>) => {
    const active = gesture.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    finishGestureCore();
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  return (
    <button
      type="button"
      className={cn(
        'absolute inset-y-0.5 touch-none select-none overflow-hidden border border-divider bg-neutral-100 text-left outline-none',
        kind === 'video' && material.streamAssetId !== null && 'border-accent-300 bg-accent-100',
        !clip.placement.enabled && 'opacity-55',
        change?.kind === 'added' && 'border-ok-border bg-ok-surface',
        change?.kind === 'modified' && 'border-accent-400 bg-accent-100',
        selected && 'ring-1 ring-inset ring-accent-600',
        editTool === 'track_forward' && 'cursor-e-resize',
        editTool === 'track_backward' && 'cursor-w-resize',
        editTool === 'razor' && razorEnabled && 'cursor-crosshair',
        editTool === 'razor' && !razorEnabled && 'cursor-not-allowed',
        editTool === 'ripple' && 'cursor-ew-resize',
        editTool === 'slip' && canSlip && 'cursor-ew-resize',
        editTool === 'slip' && !canSlip && 'cursor-not-allowed',
        editTool === 'slide' && canSlide && 'cursor-ew-resize',
        editTool === 'slide' && !canSlide && 'cursor-not-allowed',
      )}
      style={{ left: visualLeft, width: visualWidth }}
      aria-disabled={editTool === 'razor'
        ? !razorEnabled
        : editTool === 'track_forward' || editTool === 'track_backward' ? false : readOnly}
      onClick={(event) => {
        if (editTool === 'razor' || editTool === 'track_forward' || editTool === 'track_backward') return;
        if (event.detail === 0) onSelect(event.ctrlKey || event.metaKey, event.shiftKey);
        else if (selected && !lastGestureWasDragRef.current) onPromote();
      }}
      onDoubleClick={(event) => {
        if (editTool === 'razor' || editTool === 'track_forward' || editTool === 'track_backward') {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onInspect();
      }}
      onPointerDown={(event) => {
        if (editTool === 'track_forward' || editTool === 'track_backward') {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          const fraction = Math.min(1, Math.max(0, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
          lastGestureWasDragRef.current = true;
          onTrackSelect(
            clip.placement.start + clip.placement.duration * fraction,
            editTool === 'track_forward' ? 'forward' : 'backward',
            event.shiftKey,
          );
          return;
        }
        if (editTool === 'razor') {
          if (!razorEnabled || event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          const fraction = Math.min(1, Math.max(0, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
          lastGestureWasDragRef.current = true;
          onStopTransport();
          onRazor(
            clip.placement.start + clip.placement.duration * fraction,
            event.shiftKey,
            !event.altKey,
          );
          return;
        }
        if (editTool === 'ripple') {
          if (readOnly || event.button !== 0) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const leftDistance = Math.abs(event.clientX - bounds.left);
          const rightDistance = Math.abs(bounds.right - event.clientX);
          if (Math.min(leftDistance, rightDistance) > 12) {
            onSelect(event.ctrlKey || event.metaKey, event.shiftKey);
            return;
          }
          beginGesture(event, leftDistance <= rightDistance ? 'ripple_start' : 'ripple_end');
          return;
        }
        if (editTool === 'rolling' || editTool === 'rate') {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          onSelect(event.ctrlKey || event.metaKey, event.shiftKey);
          return;
        }
        beginGesture(event, editTool === 'slip' ? 'slip' : editTool === 'slide' ? 'slide' : 'move');
      }}
      onPointerMove={updateGesture}
      onPointerUp={finishGesture}
      onPointerCancel={() => {
        gesture.current = null;
        if (windowMouseUpRef.current !== null) window.removeEventListener('mouseup', windowMouseUpRef.current);
        windowMouseUpRef.current = null;
        visualClipRef.current = clip;
        setVisualClip(clip);
        onSnapChange(null);
        onCrossTrackPreview(null);
        onDragAutoScroll(null);
        onClearPreview();
      }}
      onKeyDown={(event) => {
        if (readOnly || editTool === 'razor' || editTool === 'track_forward' || editTool === 'track_backward') return;
        const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        const frames = event.shiftKey ? 5 : 1;
        if (direction !== 0 && event.altKey && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          event.stopPropagation();
          if (!canSlip) return;
          const replacement = onPreviewSlip(direction * frames / fps);
          onClearPreview();
          onReplace(replacement, 'slip');
          return;
        }
        if (direction !== 0 && event.altKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          event.stopPropagation();
          onReplace(
            moveTimelineClip(clip, clip.placement.start + direction * frames / fps, fps),
            'move',
          );
          return;
        }
        if ((event.key === ',' || event.key === '.') && event.altKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          event.stopPropagation();
          if (!canSlide) return;
          const slideDirection = event.key === '.' ? 1 : -1;
          const replacement = onPreviewSlide(clip.placement.start + slideDirection * frames / fps);
          onClearPreview();
          onReplace(replacement, 'slide');
        }
      }}
      aria-label={`${clip.name} ${clip.placement.duration.toFixed(1)}s · ${clip.text !== null ? t`已生成` : material.state === 'recorded' ? t`已录制` : material.state === 'stale' ? t`需要重录` : t`未录制`}`}
      data-timeline-clip-id={clip.id}
      data-source-in={visualClip.placement.source_in}
      data-source-out={visualClip.placement.source_out}
      data-clip-speed={visualClip.placement.speed}
    >
      {kind === 'audio' ? (
        <>
          {displaySettings.waveforms ? <TimelineClipWaveform clip={clip} change={change} /> : null}
          <TimelineGainControl
            clip={clip}
            trackHeight={trackHeight}
            readOnly={gainReadOnly}
            selected={selected}
            localTime={localTime}
            fps={fps}
            onReplace={(replacement) => onReplace(replacement, 'volume')}
          />
          <TimelineTransitionControls
            clip={clip}
            channel="audio"
            scale={scale}
            fps={fps}
            readOnly={gainReadOnly}
            selected={selected}
            selectedEdge={selectedTransition?.channel === 'audio' ? selectedTransition.edge : null}
            onSelect={() => onSelect(false, false)}
            onSelectTransition={(edge) => onSelectTransition('audio', edge)}
            onInspect={onInspect}
            onPreview={onPreviewTransition}
            onClearPreview={onClearPreview}
            onStopTransport={onStopTransport}
            scrollLeftRef={scrollLeftRef}
            onDragAutoScroll={onDragAutoScroll}
            onReplace={(replacement) => onReplace(replacement, 'transition')}
          />
        </>
      ) : kind === 'text' || kind === 'caption' ? (
        <span className={cn(
          'grid size-full place-items-center truncate px-2 text-2xs',
          kind === 'caption' && 'border-y-2 border-accent-400 bg-accent-100 font-medium text-accent-text',
        )}>{clip.name}</span>
      ) : clip.material.kind === 'sequence' ? (
        <span className="grid size-full place-items-center bg-accent-100 px-2 text-2xs font-medium text-accent-text"><Trans>嵌套序列</Trans> · {clip.name}</span>
      ) : material.streamAssetId === null ? (
        <span className="grid size-full place-items-center text-2xs text-neutral-500"><Trans>待录制</Trans></span>
      ) : (
        <>
          {displaySettings.thumbnailMode === 'none' ? null : <TimelineFilmstrip
            clip={visualClip}
            assetId={material.streamAssetId}
            clipLeftPx={visualLeft}
            clipWidthPx={visualWidth}
            trackHeightPx={trackHeight}
            viewportStartPx={thumbnailWindowStartPx}
            viewportEndPx={thumbnailWindowEndPx}
            fps={fps}
            mediaSrc={shell.mediaSrc}
            mode={displaySettings.thumbnailMode}
          />}
          <Clapperboard className="absolute left-1 top-1 size-3 rounded-sm border border-neutral-700 bg-neutral-900/75 p-px text-bg" aria-hidden="true" />
          {clip.link_group_id === null ? null : <Link2 className="absolute right-1 top-1 size-3 rounded-sm border border-neutral-700 bg-neutral-900/75 p-px text-bg" aria-hidden="true" />}
        </>
      )}
      {outOfSyncFrames === 0 ? null : (
        <span
          role="button"
          tabIndex={readOnly ? -1 : 0}
          className="absolute right-1 top-1 z-50 rounded-sm border border-fail-border bg-fail-surface px-1 font-mono text-2xs font-semibold text-fail-text outline-none focus-visible:ring-2 focus-visible:ring-fail-border"
          aria-label={t`恢复同步 ${clip.name} ${outOfSyncFrames > 0 ? '+' : ''}${outOfSyncFrames} 帧`}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!readOnly) onRestoreSync();
          }}
          onKeyDown={(event) => {
            if (readOnly || (event.key !== 'Enter' && event.key !== ' ')) return;
            event.preventDefault();
            event.stopPropagation();
            onRestoreSync();
          }}
        >
          {outOfSyncFrames > 0 ? '+' : ''}{outOfSyncFrames}f
        </span>
      )}
      {change === null ? null : <TimelineClipChangeOverlay change={change} clip={visualClip} scale={scale} />}
      {kind === 'video' ? (
        <TimelineTransitionControls
          clip={clip}
          channel="video"
          scale={scale}
          fps={fps}
          readOnly={readOnly}
          selected={selected}
          selectedEdge={selectedTransition?.channel === 'video' ? selectedTransition.edge : null}
          onSelect={() => onSelect(false, false)}
          onSelectTransition={(edge) => onSelectTransition('video', edge)}
          onInspect={onInspect}
          onPreview={onPreviewTransition}
          onClearPreview={onClearPreview}
          onStopTransport={onStopTransport}
          scrollLeftRef={scrollLeftRef}
          onDragAutoScroll={onDragAutoScroll}
          onReplace={(replacement) => onReplace(replacement, 'transition')}
        />
      ) : null}
      {kind === 'video' && enabledEffectCount > 0 ? (
        <span className="pointer-events-none absolute bottom-4 right-1 z-30 rounded-sm border border-accent-500 bg-bg/90 px-1 font-mono text-2xs text-accent-text" aria-label={t`已启用 ${enabledEffectCount} 个效果`}>fx{enabledEffectCount}</span>
      ) : null}
      {Math.abs(slipDelta) <= 1e-9 ? null : (
        <span className="pointer-events-none absolute inset-x-1 top-1 z-50 grid grid-cols-[1fr_auto_1fr] items-center gap-1 rounded-sm bg-neutral-950/90 px-1.5 py-1 font-mono text-2xs text-bg" aria-label={t`滑移 ${formatSignedTimelineDelta(slipDelta)}`}>
          <span className="truncate">In {formatMillisecondTimecode(visualClip.placement.source_in)}</span>
          <strong className="text-accent-200">{formatSignedTimelineDelta(slipDelta)}</strong>
          <span className="truncate text-right">Out {formatMillisecondTimecode(visualClip.placement.source_out)}</span>
        </span>
      )}
      {!rateStretching ? null : (
        <span className="pointer-events-none absolute inset-x-1 top-1 z-50 rounded-sm bg-neutral-950/90 px-1.5 py-1 text-center font-mono text-2xs text-bg" aria-label={t`比率伸缩 ${(visualClip.placement.speed * 100).toFixed(1)}%`}>
          {(visualClip.placement.speed * 100).toFixed(1)}% · {formatMillisecondTimecode(visualClip.placement.duration)}
        </span>
      )}
      {Math.abs(slideDelta) <= 1e-9 ? null : (
        <span className="pointer-events-none absolute inset-x-1 top-1 z-50 rounded-sm bg-neutral-950/90 px-1.5 py-1 text-center font-mono text-2xs text-bg" aria-label={t`滑动 ${formatSignedTimelineDelta(slideDelta)}`}>
          {formatSignedTimelineDelta(slideDelta)} · {formatMillisecondTimecode(visualClip.placement.start)}
        </span>
      )}
      <TimelineSpeedBand
        clip={visualClip}
        scale={scale}
        fps={fps}
        interactive={selected && primary && !readOnly}
        onCommit={(replacement) => onReplace(replacement, 'speed_remap')}
      />
      {displaySettings.keyframes ? keyframeGroups.map(([time, count]) => (
        <span
          key={`keyframe:${time}`}
          role="button"
          tabIndex={0}
          className="absolute bottom-4 z-40 size-2 -translate-x-1/2 rotate-45 border border-accent-700 bg-accent-100 outline-none focus-visible:ring-1 focus-visible:ring-accent-500"
          style={{ left: timeToPx(scale, time) }}
          aria-label={t`关键帧 ${formatMillisecondTimecode(time)} ${count} 个属性`}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onSeek(clip.placement.start + time);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            onSeek(clip.placement.start + time);
          }}
        />
      )) : null}
      {clipMarkers.map(({ marker, start, duration }) => (
        <span
          key={`source-marker:${marker.id}`}
          role="button"
          tabIndex={0}
          className="absolute top-0 z-40 h-2 min-w-0 border border-neutral-950/60 outline-none focus-visible:ring-1 focus-visible:ring-accent-500"
          style={{
            left: timeToPx(scale, start),
            width: duration > 0 ? Math.max(2, timeToPx(scale, duration)) : 2,
            backgroundColor: marker.color,
          }}
          aria-label={t`片段标记 ${marker.label} ${formatMillisecondTimecode(marker.time)}`}
          title={[
            marker.label,
            formatMillisecondTimecode(marker.time),
            ...(marker.duration > 0 ? [t`持续 ${formatMillisecondTimecode(marker.duration)}`] : []),
            ...(marker.comment.trim() === '' ? [] : [marker.comment.trim()]),
          ].join(' · ')}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onSeek(clip.placement.start + start);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            onSeek(clip.placement.start + start);
          }}
        />
      ))}
      {repeatedFrames ? <span className="pointer-events-none absolute inset-x-0 top-0 z-40 h-1 bg-[repeating-linear-gradient(90deg,var(--color-warn)_0_4px,transparent_4px_8px)]" role="img" aria-label={t`重复帧 ${clip.name}`} /> : null}
      {displaySettings.names ? <span className={cn(
        'absolute inset-x-0 bottom-0 h-[18px] truncate border-t px-1 py-px text-2xs',
        kind === 'video'
          ? 'border-accent-300 bg-accent-200/95 text-accent-text'
          : 'border-divider bg-neutral-100/90 text-neutral-700',
      )}>{clip.name}</span> : null}
      {primary && !readOnly && editTool === 'selection' ? (
        <>
          <span
            role="separator"
            tabIndex={0}
            aria-label={t`裁切片段起点`}
            className={cn(
              'absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize border-l-2 border-accent-500 bg-accent-100/20 outline-none focus-visible:ring-2 focus-visible:ring-accent-600',
              selectedEditPoint === 'start' && 'bg-accent-200/70 ring-2 ring-inset ring-accent-600',
            )}
            onFocus={() => onSelectEditPoint('start')}
            onPointerDown={(event) => beginGesture(event, 'start')}
            onPointerMove={updateGesture}
            onPointerUp={finishGesture}
          />
          <span
            role="separator"
            tabIndex={0}
            aria-label={t`裁切片段终点`}
            className={cn(
              'absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize border-r-2 border-accent-500 bg-accent-100/20 outline-none focus-visible:ring-2 focus-visible:ring-accent-600',
              selectedEditPoint === 'end' && 'bg-accent-200/70 ring-2 ring-inset ring-accent-600',
            )}
            onFocus={() => onSelectEditPoint('end')}
            onPointerDown={(event) => beginGesture(event, 'end')}
            onPointerMove={updateGesture}
            onPointerUp={finishGesture}
          />
        </>
      ) : null}
      {editTool === 'rate' && !readOnly && canRateStretch ? (
        <>
          {storyTrack ? null : (
            <span
              role="separator"
              tabIndex={0}
              aria-label={t`从起点比率伸缩 ${clip.name}`}
              className="absolute inset-y-0 left-0 z-50 w-2 cursor-ew-resize border-l-2 border-warn-border bg-warn-surface/30 outline-none focus-visible:ring-2 focus-visible:ring-warn-border"
              onPointerDown={(event) => beginGesture(event, 'rate_start')}
              onPointerMove={updateGesture}
              onPointerUp={finishGesture}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const direction = event.key === 'ArrowRight' ? 1 : -1;
                const replacement = onPreviewRateStretch('start', clip.placement.start + direction * (event.shiftKey ? 1 : 1 / fps));
                onClearPreview();
                onReplace(replacement, 'rate_start');
              }}
            />
          )}
          <span
            role="separator"
            tabIndex={0}
            aria-label={t`从终点比率伸缩 ${clip.name}`}
            className="absolute inset-y-0 right-0 z-50 w-2 cursor-ew-resize border-r-2 border-warn-border bg-warn-surface/30 outline-none focus-visible:ring-2 focus-visible:ring-warn-border"
            onPointerDown={(event) => beginGesture(event, 'rate_end')}
            onPointerMove={updateGesture}
            onPointerUp={finishGesture}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              const direction = event.key === 'ArrowRight' ? 1 : -1;
              const replacement = onPreviewRateStretch('end', clip.placement.start + clip.placement.duration + direction * (event.shiftKey ? 1 : 1 / fps));
              onClearPreview();
              onReplace(replacement, 'rate_end');
            }}
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
  && previous.selectedTransition === next.selectedTransition
  && previous.displaySettings === next.displaySettings
  && previous.repeatedFrames === next.repeatedFrames
  && previous.selectedEditPoint === next.selectedEditPoint
  && previous.deliveryState === next.deliveryState
  && previous.sourceMarkers === next.sourceMarkers
  && previous.outOfSyncFrames === next.outOfSyncFrames
  && previous.editTool === next.editTool
  && previous.storyTrack === next.storyTrack
  && previous.canSlide === next.canSlide
  && previous.scale.pixelsPerSecond === next.scale.pixelsPerSecond
  && previous.fps === next.fps
  && previous.readOnly === next.readOnly
  && previous.gainReadOnly === next.gainReadOnly
  && previous.trackHeight === next.trackHeight
  && previous.thumbnailWindowStartPx === next.thumbnailWindowStartPx
  && previous.thumbnailWindowEndPx === next.thumbnailWindowEndPx
  && previous.localTime === next.localTime
  && previous.change === next.change
  && previous.snapPoints === next.snapPoints
  && previous.snapThresholdSeconds === next.snapThresholdSeconds);

function TimelineSpeedBand({ clip, scale, fps, interactive, onCommit }: {
  readonly clip: TimelineClip;
  readonly scale: TimeScale;
  readonly fps: number;
  readonly interactive: boolean;
  readonly onCommit: (clip: TimelineClip) => void;
}) {
  const bandRef = useRef<HTMLSpanElement>(null);
  const [draft, setDraft] = useState<{ readonly clip: TimelineClip; readonly segmentId: string } | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const gesture = useRef<{
    readonly pointerId: number;
    readonly clientY: number;
    readonly clip: TimelineClip;
    readonly segmentId: string;
    readonly speed: number;
  } | null>(null);
  useEffect(() => {
    setDraft(null);
    draftRef.current = null;
    gesture.current = null;
  }, [clip]);
  if (clip.speed_segments.length === 0) return null;
  const displayed = draft?.clip ?? clip;
  const finish = (event: ReactPointerEvent<HTMLElement>, commit: boolean) => {
    const active = gesture.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    gesture.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const replacement = draftRef.current?.clip ?? active.clip;
    setDraft(null);
    draftRef.current = null;
    if (commit && (replacement.placement.duration !== active.clip.placement.duration
      || replacement.speed_segments.some((segment, index) => segment.speed !== active.clip.speed_segments[index]?.speed))) {
      onCommit(replacement);
    }
  };
  return (
    <span
      ref={bandRef}
      role="group"
      className={cn(
        'absolute inset-x-0 bottom-4 top-1 z-40 overflow-hidden bg-neutral-950/25',
        interactive ? 'pointer-events-auto bg-neutral-950/40' : 'pointer-events-none',
      )}
      aria-label={t`时间重映射 ${displayed.speed_segments.length} 个区间`}
    >
      {displayed.speed_segments.map((segment, index) => {
        const speedLineTop = Math.min(100, Math.max(0, (4 - Math.log2(segment.speed)) / 8 * 100));
        return (
          <span
            key={segment.id}
            className={cn(
              'absolute inset-y-0 overflow-hidden border-r border-bg/70',
              interactive && 'cursor-ns-resize',
            )}
            style={{
              left: timeToPx(scale, segment.start),
              width: timeToPx(scale, segment.end - segment.start),
            }}
            aria-label={t`区间 ${index + 1} ${(segment.speed * 100).toFixed(1)}%`}
            onPointerDown={(event) => {
              if (!interactive || event.button !== 0) return;
              event.preventDefault();
              event.stopPropagation();
              if (event.ctrlKey || event.metaKey) {
                const bounds = bandRef.current?.getBoundingClientRect();
                if (bounds === undefined) return;
                const localTime = pxToTime(scale, event.clientX - bounds.left);
                const replacement = splitClipSpeedSegment(
                  clip,
                  localTime,
                  globalThis.crypto.randomUUID(),
                  fps,
                );
                if (replacement !== clip) onCommit(replacement);
                return;
              }
              event.currentTarget.setPointerCapture?.(event.pointerId);
              gesture.current = {
                pointerId: event.pointerId,
                clientY: event.clientY,
                clip,
                segmentId: segment.id,
                speed: segment.speed,
              };
            }}
            onPointerMove={(event) => {
              const active = gesture.current;
              if (active === null || active.pointerId !== event.pointerId) return;
              event.preventDefault();
              event.stopPropagation();
              const requestedSpeed = active.speed * (2 ** ((active.clientY - event.clientY) / 60));
              const replacement = setClipSpeedSegmentSpeed(active.clip, active.segmentId, requestedSpeed, fps);
              const nextDraft = { clip: replacement, segmentId: active.segmentId };
              draftRef.current = nextDraft;
              setDraft(nextDraft);
            }}
            onPointerUp={(event) => finish(event, true)}
            onPointerCancel={(event) => finish(event, false)}
          >
            <span className="absolute inset-x-0 h-px bg-bg shadow-sm" style={{ top: `${speedLineTop}%` }} />
            <span className="absolute left-1 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-sm bg-neutral-950/75 px-1 font-mono text-2xs text-bg">
              {(segment.speed * 100).toFixed(0)}%
            </span>
            {index === 0 ? null : <span className="absolute inset-y-0 left-0 w-px bg-accent-300" />}
          </span>
        );
      })}
      {draft === null ? null : (
        <span className="pointer-events-none absolute right-1 top-1 z-10 rounded-sm bg-neutral-950 px-1.5 py-0.5 font-mono text-2xs text-bg">
          {((draft.clip.speed_segments.find((segment) => segment.id === draft.segmentId)?.speed ?? 1) * 100).toFixed(1)}%
        </span>
      )}
    </span>
  );
}

function TimelineGainControl({ clip, trackHeight, readOnly, selected, localTime, fps, onReplace }: {
  readonly clip: TimelineClip;
  readonly trackHeight: number;
  readonly readOnly: boolean;
  readonly selected: boolean;
  readonly localTime: number;
  readonly fps: number;
  readonly onReplace: (clip: TimelineClip) => void;
}) {
  const persistedVolume = evaluateClipKeyframeProperty(clip, 'volume', localTime, clip.placement.volume);
  const [visualVolume, setVisualVolume] = useState(persistedVolume);
  const [active, setActive] = useState(false);
  const visualVolumeRef = useRef(visualVolume);
  visualVolumeRef.current = visualVolume;
  const gesture = useRef<{
    readonly pointerId: number;
    readonly clientY: number;
    readonly volume: number;
  } | null>(null);
  useEffect(() => {
    setVisualVolume(persistedVolume);
    visualVolumeRef.current = persistedVolume;
  }, [persistedVolume]);
  const commit = (volume: number) => {
    if (Math.abs(volume - persistedVolume) <= 1e-6) return;
    onReplace(setClipVolumeAtTime(clip, localTime, volume, fps, globalThis.crypto.randomUUID()));
  };
  const db = linearGainToDb(visualVolume);
  return (
    <span
      role="slider"
      tabIndex={readOnly ? -1 : 0}
      aria-label={t`调整片段增益 ${clip.name}`}
      aria-disabled={readOnly}
      aria-valuemin={MIN_CLIP_GAIN_DB}
      aria-valuemax={MAX_CLIP_GAIN_DB}
      aria-valuenow={db}
      aria-valuetext={formatGainDb(db)}
      className={cn(
        'absolute inset-x-0 z-30 h-3 -translate-y-1/2 touch-none cursor-ns-resize outline-none focus-visible:ring-1 focus-visible:ring-accent-500',
        readOnly && 'pointer-events-none',
      )}
      style={{ top: `${gainToTrackPercent(visualVolume)}%` }}
      onPointerDown={(event) => {
        if (readOnly || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        gesture.current = { pointerId: event.pointerId, clientY: event.clientY, volume: persistedVolume };
        setActive(true);
      }}
      onPointerMove={(event) => {
        const current = gesture.current;
        if (current === null || current.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        setVisualVolume(adjustLinearGainByTrackDelta(
          current.volume,
          event.clientY - current.clientY,
          Math.max(MIN_TRACK_HEIGHT, trackHeight),
        ));
      }}
      onPointerUp={(event) => {
        if (gesture.current?.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        gesture.current = null;
        setActive(false);
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        commit(visualVolumeRef.current);
      }}
      onPointerCancel={() => {
        gesture.current = null;
        setActive(false);
        setVisualVolume(persistedVolume);
      }}
      onKeyDown={(event) => {
        if (readOnly || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
        event.preventDefault();
        event.stopPropagation();
        const direction = event.key === 'ArrowUp' ? 1 : -1;
        const volume = dbToLinearGain(db + direction * (event.shiftKey ? 3 : 1));
        setVisualVolume(volume);
        commit(volume);
      }}
    >
      <span className={cn('absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-accent-500/80', selected && 'bg-accent-600')} aria-hidden="true" />
      <span className={cn('absolute left-1/2 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent-600 bg-bg', !selected && !active && 'opacity-60')} aria-hidden="true" />
      {active ? <span className="absolute left-1/2 bottom-full mb-1 -translate-x-1/2 whitespace-nowrap rounded-sm bg-neutral-900 px-1.5 py-0.5 font-mono text-2xs text-bg">{formatGainDb(db)}</span> : null}
    </span>
  );
}

function formatGainDb(db: number): string {
  if (db <= MIN_CLIP_GAIN_DB + 1e-6) return '−∞ dB';
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

function TimelineTransitionControls({ clip, channel, scale, fps, readOnly, selected, selectedEdge, onSelect, onSelectTransition, onInspect, onPreview, onClearPreview, onStopTransport, scrollLeftRef, onDragAutoScroll, onReplace }: {
  readonly clip: TimelineClip;
  readonly channel: 'video' | 'audio';
  readonly scale: TimeScale;
  readonly fps: number;
  readonly readOnly: boolean;
  readonly selected: boolean;
  readonly selectedEdge: 'in' | 'out' | null;
  readonly onSelect: () => void;
  readonly onSelectTransition: (edge: 'in' | 'out') => void;
  readonly onInspect: () => void;
  readonly onPreview: (clip: TimelineClip) => void;
  readonly onClearPreview: () => void;
  readonly onStopTransport: () => void;
  readonly scrollLeftRef: React.RefObject<number>;
  readonly onDragAutoScroll: (clientX: number | null, onScroll?: (scrollLeft: number) => void) => void;
  readonly onReplace: (clip: TimelineClip) => void;
}) {
  return (
    <>
      {(['in', 'out'] as const).map((edge) => (
        <TimelineTransitionItem
          key={`${channel}:${edge}`}
          clip={clip}
          channel={channel}
          edge={edge}
          scale={scale}
          fps={fps}
          readOnly={readOnly}
          selected={selected}
          transitionSelected={selectedEdge === edge}
          onSelect={onSelect}
          onSelectTransition={() => onSelectTransition(edge)}
          onInspect={onInspect}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
          onStopTransport={onStopTransport}
          scrollLeftRef={scrollLeftRef}
          onDragAutoScroll={onDragAutoScroll}
          onReplace={onReplace}
        />
      ))}
    </>
  );
}

function TimelineTransitionItem({ clip, channel, edge, scale, fps, readOnly, selected, transitionSelected, onSelect, onSelectTransition, onInspect, onPreview, onClearPreview, onStopTransport, scrollLeftRef, onDragAutoScroll, onReplace }: {
  readonly clip: TimelineClip;
  readonly channel: 'video' | 'audio';
  readonly edge: 'in' | 'out';
  readonly scale: TimeScale;
  readonly fps: number;
  readonly readOnly: boolean;
  readonly selected: boolean;
  readonly transitionSelected: boolean;
  readonly onSelect: () => void;
  readonly onSelectTransition: () => void;
  readonly onInspect: () => void;
  readonly onPreview: (clip: TimelineClip) => void;
  readonly onClearPreview: () => void;
  readonly onStopTransport: () => void;
  readonly scrollLeftRef: React.RefObject<number>;
  readonly onDragAutoScroll: (clientX: number | null, onScroll?: (scrollLeft: number) => void) => void;
  readonly onReplace: (clip: TimelineClip) => void;
}) {
  const persistedTransition = timelineTransition(clip, channel, edge);
  const persistedDuration = persistedTransition?.duration_seconds ?? 0;
  const [visualDuration, setVisualDuration] = useState(persistedDuration);
  const [active, setActive] = useState(false);
  const visualDurationRef = useRef(visualDuration);
  visualDurationRef.current = visualDuration;
  const draftClipRef = useRef(clip);
  const gesture = useRef<{
    readonly pointerId: number;
    readonly clientX: number;
    readonly scrollLeft: number;
    readonly duration: number;
    lastClientX: number;
  } | null>(null);
  useEffect(() => {
    setVisualDuration(persistedDuration);
    visualDurationRef.current = persistedDuration;
    draftClipRef.current = clip;
  }, [persistedDuration]);
  const update = (clientX: number, currentScrollLeft: number) => {
    const current = gesture.current;
    if (current === null) return;
    current.lastClientX = clientX;
    const delta = pxToTime(
      scale,
      clientX - current.clientX + currentScrollLeft - current.scrollLeft,
    ) * (edge === 'in' ? 1 : -1);
    const replacement = setTimelineTransitionDuration(clip, channel, edge, current.duration + delta, fps);
    const duration = timelineTransition(replacement, channel, edge)?.duration_seconds ?? 0;
    draftClipRef.current = replacement;
    visualDurationRef.current = duration;
    setVisualDuration(duration);
    onPreview(replacement);
  };
  const finish = () => {
    const current = gesture.current;
    if (current === null) return;
    gesture.current = null;
    setActive(false);
    onDragAutoScroll(null);
    onClearPreview();
    if (JSON.stringify(draftClipRef.current.transitions) !== JSON.stringify(clip.transitions)) {
      onReplace(draftClipRef.current);
    }
  };
  const visible = persistedTransition !== null || active || (selected && !readOnly);
  if (!visible) return null;
  const width = persistedTransition === null && !active
    ? 7
    : Math.max(7, timeToPx(scale, visualDuration));
  const label = channel === 'video'
    ? edge === 'in' ? t`视频入场转场` : t`视频出场转场`
    : edge === 'in' ? t`音频入场转场` : t`音频出场转场`;
  const kind = timelineTransition(draftClipRef.current, channel, edge)?.kind ?? null;
  return (
    <span
      role="slider"
      tabIndex={readOnly ? -1 : 0}
      aria-label={`${label} ${clip.name}`}
      aria-disabled={readOnly}
      aria-valuemin={0}
      aria-valuemax={5}
      aria-valuenow={visualDuration}
      aria-valuetext={kind === null ? t`未应用` : `${kind} ${visualDuration.toFixed(3)}s`}
      data-timeline-transition={`${channel}:${edge}`}
      data-transition-duration={visualDuration}
      className={cn(
        'absolute top-0 z-40 touch-none overflow-hidden border border-accent-500 bg-accent-100/85 text-2xs text-accent-text outline-none focus-visible:ring-2 focus-visible:ring-accent-600',
        channel === 'video' ? 'h-6' : 'h-4',
        edge === 'in' ? 'left-0 rounded-r-sm' : 'right-0 rounded-l-sm',
        kind === null && 'border-dashed bg-transparent',
        !selected && !active && 'opacity-75',
        transitionSelected && 'ring-2 ring-inset ring-accent-700',
        readOnly ? 'pointer-events-none' : 'cursor-ew-resize',
      )}
      style={{
        width,
        ...(kind === null ? {} : {
          backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 5px, color-mix(in srgb, var(--color-accent-500) 20%, transparent) 5px 7px)',
        }),
      }}
      onFocus={() => {
        onSelect();
        onSelectTransition();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onSelect();
        onSelectTransition();
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onInspect();
      }}
      onPointerDown={(event) => {
        if (readOnly || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        onSelect();
        onSelectTransition();
        onStopTransport();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        gesture.current = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          scrollLeft: scrollLeftRef.current ?? 0,
          duration: persistedDuration,
          lastClientX: event.clientX,
        };
        draftClipRef.current = clip;
        setActive(true);
        onDragAutoScroll(event.clientX, (nextScrollLeft) => {
          const current = gesture.current;
          if (current !== null) update(current.lastClientX, nextScrollLeft);
        });
      }}
      onPointerMove={(event) => {
        if (gesture.current?.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        onDragAutoScroll(event.clientX);
        update(event.clientX, scrollLeftRef.current ?? 0);
      }}
      onPointerUp={(event) => {
        if (gesture.current?.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        finish();
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }}
      onPointerCancel={() => {
        gesture.current = null;
        setActive(false);
        draftClipRef.current = clip;
        visualDurationRef.current = persistedDuration;
        setVisualDuration(persistedDuration);
        onDragAutoScroll(null);
        onClearPreview();
      }}
      onKeyDown={(event) => {
        if (readOnly) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          onInspect();
          return;
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
          if (persistedTransition === null) return;
          event.preventDefault();
          event.stopPropagation();
          onReplace(setTimelineTransitionDuration(clip, channel, edge, 0, fps));
          return;
        }
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        event.stopPropagation();
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        const step = event.shiftKey ? 0.25 : 1 / fps;
        const requested = visualDuration + direction * step;
        const replacement = setTimelineTransitionDuration(
          clip,
          channel,
          edge,
          direction > 0 && visualDuration < 0.05 ? 0.05 : requested,
          fps,
        );
        onReplace(replacement);
      }}
    >
      {kind === null || width < 72 ? null : (
        <span className="pointer-events-none block overflow-hidden text-ellipsis whitespace-nowrap px-1 leading-[22px]">
          {kind} · {visualDuration.toFixed(2)}s
        </span>
      )}
      {active ? <span className="pointer-events-none absolute inset-x-0 grid h-full place-items-center bg-neutral-900/80 font-mono text-2xs text-bg">{visualDuration.toFixed(2)}s</span> : null}
    </span>
  );
}

function formatSignedTimelineDelta(seconds: number): string {
  return `${seconds >= 0 ? '+' : '−'}${formatMillisecondTimecode(Math.abs(seconds))}`;
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
  readonly scale: TimeScale;
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
        <Trans>修改注释</Trans>
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
                aria-label={t`查看修改 ${change.number}`}
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
  readonly scale: TimeScale;
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
  readonly scale: TimeScale;
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
  readonly scale: TimeScale;
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
      aria-label={t`时间轴修改 ${change.number}`}
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
        <span className="text-2xs text-ok"><Trans>已应用到时间线</Trans></span>
        <button type="button" className="ml-auto h-6 rounded-sm border border-divider px-2 text-2xs hover:bg-neutral-100 disabled:text-neutral-300" disabled={!canUndo} onClick={onUndo}><Trans>撤销这组修改</Trans></button>
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
        'pointer-events-none !h-full !min-h-0 !rounded-none !border-0 bg-accent-100 [&_.blueprint]:border-0 [&_svg_path:first-child]:fill-accent-400 [&_svg_path:nth-child(2)]:stroke-accent-600',
        change?.kind === 'added' && 'bg-ok-surface [&_svg_path:first-child]:fill-ok-border [&_svg_path:nth-child(2)]:stroke-ok',
      )}
    />
  );
}

function TimelineTrackAudioControls({ track, timelineTimeSeconds, fps, property, readOnly, onPropertyChange, onReplaceTrack }: {
  readonly track: TimelineTrack;
  readonly timelineTimeSeconds: number;
  readonly fps: number;
  readonly property: TrackAudioProperty;
  readonly readOnly: boolean;
  readonly onPropertyChange: (property: TrackAudioProperty) => void;
  readonly onReplaceTrack: (track: TimelineTrack) => void;
}) {
  const value = evaluateTrackAudioProperty(track, property, timelineTimeSeconds);
  const current = trackAudioKeyframeAtTime(track, property, timelineTimeSeconds, fps);
  const step = property === 'volume' ? 0.05 : 0.05;
  const label = property === 'volume' ? formatGainDb(linearGainToDb(value)) : formatPan(value);
  const adjust = (direction: -1 | 1) => onReplaceTrack(setTrackAudioAtTime(
    track,
    property,
    timelineTimeSeconds,
    value + direction * step,
    fps,
    globalThis.crypto.randomUUID(),
  ));
  return (
    <span className="absolute bottom-1 left-10 right-2 flex h-5 items-center gap-1 font-normal text-neutral-500">
      <Tooltip content={property === 'volume' ? t`显示 Pan 轨道自动化` : t`显示 Volume 轨道自动化`} side="top">
        <button
          type="button"
          className="grid size-5 place-items-center rounded-sm border border-divider font-mono text-2xs hover:bg-neutral-100"
          aria-label={t`切换轨道自动化属性，当前 ${property === 'volume' ? 'Volume' : 'Pan'}`}
          onClick={() => onPropertyChange(property === 'volume' ? 'pan' : 'volume')}
        >{property === 'volume' ? 'V' : 'P'}</button>
      </Tooltip>
      <Tooltip content={property === 'volume' ? t`降低轨道音量` : t`向左调整声像`} side="top">
        <button type="button" className="grid size-5 place-items-center rounded-sm hover:bg-neutral-100" disabled={readOnly} onClick={() => adjust(-1)}>−</button>
      </Tooltip>
      <span className="w-9 whitespace-nowrap text-center font-mono text-2xs text-text" aria-label={t`当前轨道自动化值 ${label}`}>{property === 'volume' ? linearGainToDb(value).toFixed(1) : label}</span>
      <Tooltip content={property === 'volume' ? t`提高轨道音量` : t`向右调整声像`} side="top">
        <button type="button" className="grid size-5 place-items-center rounded-sm hover:bg-neutral-100" disabled={readOnly} onClick={() => adjust(1)}>+</button>
      </Tooltip>
      <Tooltip content={current === null ? t`在播放头添加轨道关键帧` : t`删除播放头的轨道关键帧`} side="top">
        <button
          type="button"
          className={cn('grid size-5 place-items-center rounded-sm hover:bg-neutral-100', current !== null && 'text-accent-text')}
          aria-label={current === null ? t`添加轨道关键帧` : t`删除轨道关键帧`}
          disabled={readOnly}
          onClick={() => onReplaceTrack(current === null
            ? upsertTrackAudioKeyframe(track, property, timelineTimeSeconds, value, fps, globalThis.crypto.randomUUID())
            : removeTrackAudioKeyframe(track, property, timelineTimeSeconds, fps))}
        >
          <Diamond className="size-3" fill={current === null ? 'none' : 'currentColor'} aria-hidden="true" />
        </button>
      </Tooltip>
    </span>
  );
}

function TimelineTrackAutomation({ track, property, scale, contentWidth, height, fps, readOnly, onReplaceTrack }: {
  readonly track: TimelineTrack;
  readonly property: TrackAudioProperty;
  readonly scale: TimeScale;
  readonly contentWidth: number;
  readonly height: number;
  readonly fps: number;
  readonly readOnly: boolean;
  readonly onReplaceTrack: (track: TimelineTrack) => void;
}) {
  const [draft, setDraft] = useState<{ readonly id: string; readonly time: number; readonly value: number } | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const gesture = useRef<{ readonly pointerId: number; readonly id: string } | null>(null);
  const endTime = pxToTime(scale, contentWidth);
  const keyframes = track.keyframes
    .filter((keyframe) => keyframe.property === property)
    .map((keyframe) => keyframe.id === draft?.id ? { ...keyframe, time: draft.time, value: draft.value } : keyframe)
    .sort((left, right) => left.time - right.time);
  const yForValue = (value: number) => (property === 'volume'
    ? gainToTrackPercent(value)
    : (1 - Math.min(1, Math.max(-1, value))) * 50) / 100 * Math.max(1, height - 8) + 4;
  const points = [
    { time: 0, value: evaluateTrackAudioProperty(track, property, 0) },
    ...keyframes,
    { time: endTime, value: evaluateTrackAudioProperty(track, property, endTime) },
  ];
  const updateDraft = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = gesture.current;
    const lane = event.currentTarget.parentElement;
    if (active === null || active.pointerId !== event.pointerId || lane === null) return;
    const bounds = lane.getBoundingClientRect();
    const time = snapTimeToFrame(pxToTime(scale, Math.min(contentWidth, Math.max(0, event.clientX - bounds.left))), fps);
    const ratio = Math.min(1, Math.max(0, (event.clientY - bounds.top - 4) / Math.max(1, height - 8)));
    const value = property === 'volume'
      ? dbToLinearGain(MAX_CLIP_GAIN_DB + ratio * (MIN_CLIP_GAIN_DB - MAX_CLIP_GAIN_DB))
      : 1 - ratio * 2;
    setDraft({ id: active.id, time, value });
  };
  const commit = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = gesture.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    gesture.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const replacement = draftRef.current;
    setDraft(null);
    if (replacement !== null) onReplaceTrack(moveTrackAudioKeyframe(track, replacement.id, replacement.time, replacement.value, fps));
  };
  return (
    <div className="pointer-events-none absolute inset-0 z-40" data-track-automation-property={property}>
      <svg className="absolute inset-0 size-full overflow-visible" aria-hidden="true">
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          className="text-accent-600"
          points={points.map((point) => `${timeToPx(scale, point.time)},${yForValue(point.value)}`).join(' ')}
        />
      </svg>
      {keyframes.map((keyframe) => (
        <button
          key={keyframe.id}
          type="button"
          className="pointer-events-auto absolute size-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border border-accent-700 bg-bg hover:bg-accent-100 disabled:pointer-events-none"
          style={{ left: timeToPx(scale, keyframe.time), top: yForValue(keyframe.value) }}
          aria-label={t`${property === 'volume' ? 'Volume' : 'Pan'} 轨道关键帧 ${formatMillisecondTimecode(keyframe.time)}`}
          disabled={readOnly}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            gesture.current = { pointerId: event.pointerId, id: keyframe.id };
            setDraft({ id: keyframe.id, time: keyframe.time, value: keyframe.value });
          }}
          onPointerMove={updateDraft}
          onPointerUp={commit}
          onPointerCancel={() => { gesture.current = null; setDraft(null); }}
          onKeyDown={(event) => {
            if (event.key !== 'Delete' && event.key !== 'Backspace') return;
            event.preventDefault();
            onReplaceTrack({ ...track, keyframes: track.keyframes.filter((candidate) => candidate.id !== keyframe.id) });
          }}
        />
      ))}
    </div>
  );
}

function formatPan(value: number): string {
  if (Math.abs(value) < 0.005) return 'C';
  return `${value < 0 ? 'L' : 'R'}${Math.round(Math.abs(value) * 100)}`;
}

function TimelineTrackHead({ icon, targetLabel = '', label, controls, track, readOnly = true, removable = false, renamable = false, canMoveUp = false, canMoveDown = false, targeted = false, syncLocked = false, syncLockVisible = true, collapsed = false, showAutomationControls = false, timelineTimeSeconds = 0, fps = 60, automationProperty = 'volume', onReplaceTrack, onRemoveTrack, onMoveTrack, onTargetTrack, onToggleSyncLock, onToggleCollapse, onAutomationPropertyChange }: {
  readonly icon: React.ReactNode;
  readonly targetLabel?: string | undefined;
  readonly label: string;
  readonly controls: RenderedTrack['controls'];
  readonly track?: TimelineTrack | undefined;
  readonly readOnly?: boolean | undefined;
  readonly removable?: boolean | undefined;
  readonly renamable?: boolean | undefined;
  readonly canMoveUp?: boolean | undefined;
  readonly canMoveDown?: boolean | undefined;
  readonly targeted?: boolean | undefined;
  readonly syncLocked?: boolean | undefined;
  readonly syncLockVisible?: boolean | undefined;
  readonly collapsed?: boolean | undefined;
  readonly showAutomationControls?: boolean | undefined;
  readonly timelineTimeSeconds?: number | undefined;
  readonly fps?: number | undefined;
  readonly automationProperty?: TrackAudioProperty | undefined;
  readonly onReplaceTrack?: ((track: TimelineTrack) => void) | undefined;
  readonly onRemoveTrack?: ((trackId: string) => void) | undefined;
  readonly onMoveTrack?: ((trackId: string, direction: -1 | 1) => void) | undefined;
  readonly onTargetTrack?: ((trackId: string, kind: TimelineTrack['kind']) => void) | undefined;
  readonly onToggleSyncLock?: ((trackId: string, kind: TimelineTrack['kind'], allOfKind: boolean) => void) | undefined;
  readonly onToggleCollapse?: (() => void) | undefined;
  readonly onAutomationPropertyChange?: ((property: TrackAudioProperty) => void) | undefined;
}) {
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const cancelRenameRef = useRef(false);
  const commitRename = () => {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      setNameDraft(null);
      return;
    }
    const name = nameDraft?.trim() ?? '';
    setNameDraft(null);
    if (track !== undefined && name !== '' && name !== track.name) onReplaceTrack?.({ ...track, name });
  };
  return (
    <div className={cn(
      'sticky left-0 z-30 flex min-w-0 gap-1 border-r border-divider bg-bg pl-10 pr-2 text-xs font-medium',
      controls === 'audio' && !collapsed && showAutomationControls ? 'items-start pb-7 pt-1' : 'items-center py-1',
    )}>
      {track === undefined ? null : (
        <button
          type="button"
          className="grid size-5 flex-none place-items-center rounded-sm text-neutral-500 hover:bg-neutral-100"
          aria-label={collapsed ? t`展开轨道 ${label}` : t`折叠轨道 ${label}`}
          aria-expanded={!collapsed}
          onClick={onToggleCollapse}
        >
          {collapsed ? <ChevronRight className="size-3" aria-hidden="true" /> : <ChevronDown className="size-3" aria-hidden="true" />}
        </button>
      )}
      {controls === 'none' ? (
        <span className="flex-none text-neutral-600">{icon}</span>
      ) : (
        <button
          type="button"
          className={cn(
            'grid h-[var(--h-ctl-sm)] w-7 flex-none place-items-center rounded-sm border font-mono text-2xs font-semibold disabled:text-neutral-300',
            targeted ? 'border-accent-600 bg-accent-600 text-bg' : 'border-divider bg-bg text-neutral-500 hover:bg-neutral-100',
          )}
          aria-label={t`设为目标轨道 ${label}`}
          aria-pressed={targeted}
          disabled={track?.locked === true}
          onClick={() => track === undefined ? undefined : onTargetTrack?.(
            track.id,
            controls === 'video'
              ? 'video'
              : controls === 'audio'
                ? 'audio'
                : controls === 'caption'
                  ? 'caption'
                  : 'text',
          )}
        >
          {targetLabel}
        </button>
      )}
      {nameDraft !== null ? (
        <input
          autoFocus
          className="h-6 min-w-0 flex-1 border border-accent-400 bg-bg px-1 text-xs outline-none"
          aria-label={t`轨道名称`}
          value={nameDraft}
          onChange={(event) => setNameDraft(event.currentTarget.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            else if (event.key === 'Escape') {
              cancelRenameRef.current = true;
              event.currentTarget.blur();
            }
          }}
        />
      ) : renamable && track !== undefined ? (
        <Tooltip content={readOnly || track.locked ? t`轨道当前只读` : t`双击、Enter 或 F2 重命名轨道`} side="top">
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left outline-none focus-visible:ring-1 focus-visible:ring-accent-500"
            aria-label={t`重命名轨道 ${track.name}`}
            disabled={readOnly || track.locked}
            onDoubleClick={() => setNameDraft(track.name)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== 'F2') return;
              event.preventDefault();
              setNameDraft(track.name);
            }}
          >{label}</button>
        </Tooltip>
      ) : <span className="min-w-0 flex-1 truncate">{label}</span>}
      {track === undefined ? null : (
        <span className="flex flex-none items-center text-neutral-500">
          {controls === 'none' || !syncLockVisible ? null : (
            <Tooltip
              content={t`同步锁定：Story 插入、波纹删除、提取和波纹裁切时一起移动；Shift 点击切换同类轨道`}
              side="top"
            >
              <button
                type="button"
                className={cn(
                  'grid size-5 place-items-center rounded-sm hover:bg-neutral-100',
                  syncLocked && 'text-accent-text',
                )}
                aria-label={t`切换同步锁定 ${label}`}
                aria-pressed={syncLocked}
                onClick={(event) => onToggleSyncLock?.(track.id, track.kind, event.shiftKey)}
              >
                <Link2 className="size-3" aria-hidden="true" />
              </button>
            </Tooltip>
          )}
          {controls === 'none' ? null : (
            <button
              type="button"
              className={cn(
                'grid size-5 place-items-center rounded-sm hover:bg-neutral-100',
                (controls === 'audio' ? track.muted : track.hidden) && 'text-fail-text',
              )}
              aria-label={controls === 'audio' ? t`切换轨道静音` : t`切换视频轨道显示`}
              aria-pressed={controls === 'audio' ? track.muted : !track.hidden}
              disabled={readOnly}
              onClick={() => onReplaceTrack?.(controls === 'audio'
                ? { ...track, muted: !track.muted }
                : { ...track, hidden: !track.hidden })}
            >
              {controls === 'audio' ? <Volume2 className="size-3" aria-hidden="true" /> : <Eye className="size-3" aria-hidden="true" />}
            </button>
          )}
          {controls !== 'audio' ? null : (
            <Tooltip content={track.solo ? t`关闭 Solo` : t`Solo：只监听所有已 Solo 的音频轨`} side="top">
              <button
                type="button"
                className={cn('grid size-5 place-items-center rounded-sm font-mono text-2xs hover:bg-neutral-100', track.solo && 'bg-accent-100 text-accent-text')}
                aria-label={t`切换 Solo ${track.name}`}
                aria-pressed={track.solo}
                disabled={readOnly}
                onClick={() => onReplaceTrack?.({ ...track, solo: !track.solo })}
              >S</button>
            </Tooltip>
          )}
          <button
            type="button"
            className={cn('grid size-5 place-items-center rounded-sm hover:bg-neutral-100 disabled:text-neutral-300', track.locked && 'text-accent-text')}
            aria-label={t`切换轨道锁定`}
            aria-pressed={track.locked}
            disabled={readOnly}
            onClick={() => onReplaceTrack?.({ ...track, locked: !track.locked })}
          >
            <LockKeyhole className="size-3" aria-hidden="true" />
          </button>
          {removable ? (
            <OverflowMenu
              label={t`轨道操作 ${track.name}`}
              triggerLabel={<Ellipsis className="size-3" aria-hidden="true" />}
              align="start"
              triggerClassName="h-5 gap-0.5 rounded-sm px-1 text-neutral-500 hover:bg-neutral-100"
              items={[
                { id: 'move-up', label: t`上移轨道`, disabled: readOnly || track.locked || !canMoveUp, onSelect: () => onMoveTrack?.(track.id, -1) },
                { id: 'move-down', label: t`下移轨道`, disabled: readOnly || track.locked || !canMoveDown, onSelect: () => onMoveTrack?.(track.id, 1) },
                { id: 'delete', label: t`删除轨道`, disabled: readOnly || track.locked, onSelect: () => onRemoveTrack?.(track.id) },
              ]}
            />
          ) : null}
        </span>
      )}
      {track === undefined || controls !== 'audio' || collapsed || !showAutomationControls ? null : (
        <TimelineTrackAudioControls
          track={track}
          timelineTimeSeconds={timelineTimeSeconds}
          fps={fps}
          property={automationProperty}
          readOnly={readOnly || track.locked}
          onPropertyChange={(property) => onAutomationPropertyChange?.(property)}
          onReplaceTrack={(replacement) => onReplaceTrack?.(replacement)}
        />
      )}
    </div>
  );
}

const TimelineMarkerRow = memo(function TimelineMarkerRow({ markers, selectedMarkerId, scale, contentWidth, ticks, durationSeconds, fps, readOnly, snapPoints, snapThresholdSeconds, onSnapChange, onSeek, onSelectMarker, onEditMarker, onMoveMarker }: {
  readonly markers: readonly EditorMarker[];
  readonly selectedMarkerId: string | null;
  readonly scale: TimeScale;
  readonly contentWidth: number;
  readonly ticks: ReturnType<typeof rulerTicks>;
  readonly durationSeconds: number;
  readonly fps: number;
  readonly readOnly: boolean;
  readonly snapPoints: readonly { readonly time: number; readonly clipId: string | null }[];
  readonly snapThresholdSeconds: number;
  readonly onSnapChange: (time: number | null) => void;
  readonly onSeek: (seconds: number) => void;
  readonly onSelectMarker: (marker: EditorMarker) => void;
  readonly onEditMarker: (marker: EditorMarker) => void;
  readonly onMoveMarker: (markerId: string, time: number) => void;
}) {
  const ordered = useMemo(
    () => [...markers].sort((left, right) => left.time - right.time),
    [markers],
  );
  return (
    <div className="grid min-h-0 grid-cols-[var(--w-track-head)_minmax(0,1fr)] border-b border-divider" role="row" aria-label={t`标记`}>
      <TimelineTrackHead icon={<Bookmark className="size-4" />} label={t`标记`} controls="none" />
      <div className="relative min-h-0 overflow-hidden" style={{ width: contentWidth }}>
        <TimelineGrid ticks={ticks} />
        {ordered.map((marker, index) => (
          <TimelineMarkerItem
            key={marker.id}
            marker={marker}
            selected={marker.id === selectedMarkerId}
            nextMarkerTime={ordered[index + 1]?.time ?? null}
            scale={scale}
            contentWidth={contentWidth}
            durationSeconds={durationSeconds}
            fps={fps}
            readOnly={readOnly}
            snapPoints={snapPoints}
            snapThresholdSeconds={snapThresholdSeconds}
            onSnapChange={onSnapChange}
            onSeek={onSeek}
            onSelect={onSelectMarker}
            onEdit={onEditMarker}
            onMove={onMoveMarker}
          />
        ))}
      </div>
    </div>
  );
}, (previous, next) => previous.markers === next.markers
  && previous.selectedMarkerId === next.selectedMarkerId
  && previous.scale.pixelsPerSecond === next.scale.pixelsPerSecond
  && previous.contentWidth === next.contentWidth
  && previous.durationSeconds === next.durationSeconds
  && previous.fps === next.fps
  && previous.readOnly === next.readOnly
  && previous.snapPoints === next.snapPoints
  && previous.snapThresholdSeconds === next.snapThresholdSeconds
  && previous.onSnapChange === next.onSnapChange
  && previous.onSeek === next.onSeek
  && previous.onSelectMarker === next.onSelectMarker
  && previous.onEditMarker === next.onEditMarker
  && previous.onMoveMarker === next.onMoveMarker);

function TimelineMarkerItem({ marker, selected, nextMarkerTime, scale, contentWidth, durationSeconds, fps, readOnly, snapPoints, snapThresholdSeconds, onSnapChange, onSeek, onSelect, onEdit, onMove }: {
  readonly marker: EditorMarker;
  readonly selected: boolean;
  readonly nextMarkerTime: number | null;
  readonly scale: TimeScale;
  readonly contentWidth: number;
  readonly durationSeconds: number;
  readonly fps: number;
  readonly readOnly: boolean;
  readonly snapPoints: readonly { readonly time: number; readonly clipId: string | null }[];
  readonly snapThresholdSeconds: number;
  readonly onSnapChange: (time: number | null) => void;
  readonly onSeek: (seconds: number) => void;
  readonly onSelect: (marker: EditorMarker) => void;
  readonly onEdit: (marker: EditorMarker) => void;
  readonly onMove: (markerId: string, time: number) => void;
}) {
  const [visualTime, setVisualTime] = useState(marker.time);
  const ignoreClickRef = useRef(false);
  const gesture = useRef<{
    readonly pointerId: number;
    readonly clientX: number;
    readonly time: number;
    moved: boolean;
  } | null>(null);
  useEffect(() => {
    if (gesture.current !== null) return;
    setVisualTime(marker.time);
  }, [marker.time]);
  const timeFromClientX = (clientX: number, active: NonNullable<typeof gesture.current>, shiftKey: boolean) => {
    const frameTime = snapTimeToFrame(
      Math.min(
        Math.max(0, durationSeconds - marker.duration),
        Math.max(0, active.time + pxToTime(scale, clientX - active.clientX)),
      ),
      fps,
    );
    if (shiftKey || snapPoints.length === 0) {
      onSnapChange(null);
      return frameTime;
    }
    const snap = resolveTimelineSnap(
      frameTime,
      [0],
      snapPoints
        .filter((point) => point.clipId !== null || Math.abs(point.time - marker.time) > 0.5 / fps)
        .map((point) => point.time),
      snapThresholdSeconds,
    );
    onSnapChange(snap.snapTime);
    return snap.anchorTime;
  };
  const left = timeToPx(scale, visualTime);
  const available = nextMarkerTime === null
    ? contentWidth - left
    : timeToPx(scale, nextMarkerTime - visualTime);
  const width = marker.duration > 0
    ? Math.max(6, Math.min(contentWidth - left, timeToPx(scale, marker.duration)))
    : Math.max(6, Math.min(160, available - 3));
  const markerTitle = [
    `${markerKindLabel(marker.kind)} · ${marker.label}`,
    formatMillisecondTimecode(visualTime),
    ...(marker.duration > 0 ? [t`持续 ${formatMillisecondTimecode(marker.duration)}`] : []),
    ...(marker.comment.trim() === '' ? [] : [marker.comment.trim()]),
  ].join(' · ');
  return (
    <button
      type="button"
      className={cn(
        'absolute inset-y-1 z-10 flex touch-none select-none items-center gap-1.5 overflow-hidden text-left text-2xs text-neutral-700 outline-none hover:bg-neutral-100 focus-visible:ring-1 focus-visible:ring-accent-500',
        selected && 'bg-accent-100 ring-1 ring-inset ring-accent-500',
        readOnly ? 'cursor-pointer' : 'cursor-ew-resize',
      )}
      style={{ left, width }}
      aria-label={t`标记 ${marker.label} ${formatMillisecondTimecode(visualTime)}`}
      title={markerTitle}
      onClick={() => {
        if (ignoreClickRef.current) {
          ignoreClickRef.current = false;
          return;
        }
        onSelect(marker);
        onSeek(marker.time);
      }}
      onDoubleClick={() => {
        onSelect(marker);
        if (!readOnly) onEdit(marker);
      }}
      onPointerDown={(event) => {
        if (readOnly || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        gesture.current = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          time: marker.time,
          moved: false,
        };
      }}
      onPointerMove={(event) => {
        const active = gesture.current;
        if (active === null || active.pointerId !== event.pointerId) return;
        event.preventDefault();
        if (Math.abs(event.clientX - active.clientX) >= 2) active.moved = true;
        const next = timeFromClientX(event.clientX, active, event.shiftKey);
        setVisualTime(next);
      }}
      onPointerUp={(event) => {
        const active = gesture.current;
        if (active === null || active.pointerId !== event.pointerId) return;
        event.preventDefault();
        const next = timeFromClientX(event.clientX, active, event.shiftKey);
        setVisualTime(next);
        gesture.current = null;
        onSnapChange(null);
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        ignoreClickRef.current = active.moved;
        if (active.moved) globalThis.setTimeout(() => { ignoreClickRef.current = false; }, 0);
        onSelect(marker);
        if (active.moved && Math.abs(next - marker.time) > 0.5 / fps) onMove(marker.id, next);
        else onSeek(marker.time);
      }}
      onPointerCancel={(event) => {
        gesture.current = null;
        onSnapChange(null);
        setVisualTime(marker.time);
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(marker);
          onSeek(marker.time);
          return;
        }
        if (readOnly || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
        event.preventDefault();
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        const step = event.shiftKey ? 1 : 1 / fps;
        onMove(marker.id, snapTimeToFrame(
          Math.min(
            Math.max(0, durationSeconds - marker.duration),
            Math.max(0, marker.time + direction * step),
          ),
          fps,
        ));
      }}
    >
      <span className="h-full w-1.5 flex-none" style={{ backgroundColor: marker.color }} aria-hidden="true" />
      <span className="min-w-0 truncate">{marker.label}</span>
    </button>
  );
}

function markerKindLabel(kind: EditorMarker['kind']): string {
  if (kind === 'chapter') return t`章节`;
  if (kind === 'segmentation') return t`分段`;
  return t`评论`;
}

const TimelineEventRow = memo(function TimelineEventRow({ clips, scale, contentWidth, ticks, onSelectClip, onSeek }: {
  readonly clips: readonly TimelineClip[];
  readonly scale: TimeScale;
  readonly contentWidth: number;
  readonly ticks: ReturnType<typeof rulerTicks>;
  readonly onSelectClip: (clipId: string) => void;
  readonly onSeek: (seconds: number) => void;
}) {
  return (
    <div className="grid min-h-0 grid-cols-[var(--w-track-head)_minmax(0,1fr)] border-b border-divider" role="row" aria-label={t`事件`}>
      <TimelineTrackHead icon={<Star className="size-4" />} label={t`事件`} controls="none" />
      <div className="relative min-h-0 overflow-hidden" style={{ width: contentWidth }}>
        <TimelineGrid ticks={ticks} />
        {clips.map((clip) => (
          <button
            key={`event:${clip.id}`}
            type="button"
            className="absolute inset-y-1 flex items-center gap-1.5 overflow-hidden px-0.5 text-left text-2xs text-neutral-700 outline-none hover:bg-neutral-100 focus-visible:ring-1 focus-visible:ring-accent-500"
            style={{
              left: timeToPx(scale, clip.placement.start),
              width: Math.max(3, timeToPx(scale, clip.placement.duration) - 3),
            }}
            aria-label={t`事件 ${clip.name} ${formatMillisecondTimecode(clip.placement.start)}`}
            title={`${clip.name} · ${formatMillisecondTimecode(clip.placement.start)}`}
            onClick={() => {
              onSelectClip(clip.id);
              onSeek(clip.placement.start);
            }}
          >
            <span className="h-3 w-1.5 flex-none bg-ok" aria-hidden="true" />
            <span className="min-w-0 truncate">{clip.name.split(' · ')[0]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}, (previous, next) => previous.clips === next.clips
  && previous.scale.pixelsPerSecond === next.scale.pixelsPerSecond
  && previous.contentWidth === next.contentWidth
  && previous.onSelectClip === next.onSelectClip
  && previous.onSeek === next.onSeek);

function TimelineGrid({ ticks }: { readonly ticks: ReturnType<typeof rulerTicks> }) {
  return <>{ticks.filter((tick) => tick.major).map((tick) => <span key={`grid:${tick.time}`} className="pointer-events-none absolute inset-y-0 border-l border-divider" style={{ left: tick.px }} aria-hidden="true" />)}</>;
}
