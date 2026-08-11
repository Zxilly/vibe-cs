import { currentLocale, msg, msgf } from '../../shared/i18n';
import {
  ArrowLeft,
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Download,
  Film,
  Flag,
  FolderOpen,
  History,
  Image,
  Layers3,
  LayoutTemplate,
  Link2,
  Lock,
  Magnet,
  Maximize2,
  MousePointer2,
  Music2,
  Pause,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  Save,
  Scissors,
  Search,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  SplitSquareHorizontal,
  Copy,
  Mic,
  Trash2,
  Type,
  Undo2,
  Upload,
  Video,
  Volume2,
  WandSparkles,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { ApiError, api, apiMediaUrl, readableError } from '../../shared/api/client';
import type { EditorPreset, EditorPresetDocument, EditorProjectDeletionResult, EditorProjectSnapshot, EditorTransitionName, ExportJobRecord, EditorAudioSeparation, EditorPackageExport, EditorPackageImport, EditorProject, MediaAsset, RecordedClip, TimelineClipDto, TimelineTrackDto } from '../../shared/api/dto';
import { chooseLocalFile, isDesktopShell } from '../../shared/desktop/dialog';
import { useAsyncAction } from '../../shared/hooks/useAsyncAction';
import { useI18n } from '../../shared/i18n';
import { Badge, Button, EmptyState, Field, IconButton, Notice, Spinner, TextInput } from '../../shared/ui';
import {
  MAX_EDITOR_TIMELINE_SECONDS,
  boundedTimelineValue,
  createOperationGate,
  decideProjectTransition,
  formatTimelineTime,
  presetCompatibilityReason,
  projectEditFingerprint,
  snapTimelineTime,
} from './projectState';
import {
  EDITOR_TRANSITIONS,
  activeTimelineClips,
  duplicateTimelineClip,
  editorTransitionPreviewStyle,
  hasSeparatedAudioChild,
  isEditorTemplate,
  mapKillAxisEvents,
} from './advancedEditing';
import { synchronizeMediaPreview } from './previewSync';
import { EditorTimeline } from './EditorTimeline';
import { EditorWaveform } from './EditorWaveform';
import { interpolateTimelineProperty, type TimelineClip, type TimelineKeyframeProperty, type TimelineOperationResult, type TimelineTrack, useTimelineStore } from './timelineStore';

type InspectorTab = 'clip' | 'color' | 'audio' | 'preset';
type ProjectOperation = 'saving' | 'exporting' | 'creating' | 'duplicating' | 'restoring' | 'reloading' | 'packaging' | 'importing' | 'deleting' | 'preset' | 'separating_audio';
type AutoSaveState =
  | { status: 'idle' | 'saved'; message: string | null }
  | { status: 'saving'; message: string }
  | { status: 'error' | 'conflict'; message: string };
type MediaBinItem = {
  id: string;
  name: string;
  detail: string;
  duration: number;
  kind: 'video' | 'audio' | 'image';
  streamUrl: string | null;
  asset: MediaAsset | null;
};

type ColorAdjust = {
  brightness: number;
  contrast: number;
  saturation: number;
};

type PreviewAutomation = Record<TimelineKeyframeProperty, number>;

const defaultColorAdjust: ColorAdjust = { brightness: 0, contrast: 1, saturation: 1 };

const presetTransition = (value: string | null | undefined): EditorTransitionName | null =>
  value && value !== 'none' && EDITOR_TRANSITIONS.includes(value as typeof EDITOR_TRANSITIONS[number])
    ? value as EditorTransitionName
    : null;

const readColorAdjust = (clip: TimelineClip | null): ColorAdjust => {
  const effect = clip?.effects?.find((item) => item.enabled && item.kind === 'color_adjust');
  if (!effect || typeof effect.parameters !== 'object' || effect.parameters === null) return defaultColorAdjust;
  const parameters = effect.parameters as Partial<ColorAdjust>;
  return {
    brightness: typeof parameters.brightness === 'number' ? parameters.brightness : 0,
    contrast: typeof parameters.contrast === 'number' ? parameters.contrast : 1,
    saturation: typeof parameters.saturation === 'number' ? parameters.saturation : 1,
  };
};

const presetDocumentFromClip = (clip: TimelineClip): EditorPresetDocument => {
  const blur = clip.effects?.find((effect) => effect.enabled && effect.kind === 'blur');
  const blurParameters = typeof blur?.parameters === 'object' && blur.parameters !== null
    ? blur.parameters as { radius?: unknown }
    : null;
  const radius = typeof blurParameters?.radius === 'number' ? blurParameters.radius : null;
  return {
    schema_version: 1,
    transform: clip.transform ?? { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    volume: clip.volume,
    color_adjust: readColorAdjust(clip),
    grayscale: Boolean(clip.effects?.some((effect) => effect.enabled && effect.kind === 'grayscale')),
    blur_radius: radius,
    transition_in: presetTransition(clip.transitionIn),
    transition_out: presetTransition(clip.transitionOut),
  };
};

const sourceOffsetAt = (clip: TimelineClip, localTime: number): number => {
  const segments = clip.speedSegments ?? [];
  if (segments.length === 0) return localTime * clip.speed;
  return segments.reduce((offset, segment) => offset
    + Math.max(0, Math.min(localTime, segment.end) - segment.start) * segment.speed, 0);
};

const localTimeAtSource = (clip: TimelineClip, sourceTime: number): number => {
  const sourceOffset = Math.max(0, sourceTime - clip.sourceIn);
  const segments = clip.speedSegments ?? [];
  if (segments.length === 0) return Math.min(clip.duration, sourceOffset / clip.speed);
  let consumedSource = 0;
  for (const segment of segments) {
    const sourceDuration = (segment.end - segment.start) * segment.speed;
    if (sourceOffset <= consumedSource + sourceDuration) {
      return Math.min(clip.duration, segment.start + (sourceOffset - consumedSource) / segment.speed);
    }
    consumedSource += sourceDuration;
  }
  return clip.duration;
};

const speedAt = (clip: TimelineClip, localTime: number): number =>
  clip.speedSegments?.find((segment) => localTime >= segment.start && localTime < segment.end)?.speed
  ?? clip.speed;

const automationAt = (clip: TimelineClip, localTime: number): PreviewAutomation => ({
  x: interpolateTimelineProperty(clip, 'x', localTime),
  y: interpolateTimelineProperty(clip, 'y', localTime),
  scale_x: interpolateTimelineProperty(clip, 'scale_x', localTime),
  scale_y: interpolateTimelineProperty(clip, 'scale_y', localTime),
  rotation: interpolateTimelineProperty(clip, 'rotation', localTime),
  opacity: interpolateTimelineProperty(clip, 'opacity', localTime),
  volume: interpolateTimelineProperty(clip, 'volume', localTime),
});

const ProgramPreview = memo(function ProgramPreview({
  projectName,
  clip,
  media,
  localTime,
  automation,
  playing,
}: {
  projectName: string;
  clip: TimelineClip | null;
  media: MediaBinItem | null;
  localTime: number;
  automation: PreviewAutomation | null;
  playing: boolean;
}) {
  const mediaElement = useRef<HTMLMediaElement | null>(null);

  const syncMedia = useCallback((element: HTMLMediaElement) => {
    if (!clip || !automation) return;
    synchronizeMediaPreview(
      element,
      clip.sourceIn + sourceOffsetAt(clip, localTime),
      automation.volume,
      speedAt(clip, localTime),
      playing,
    );
  }, [automation, clip, localTime, playing]);

  useEffect(() => {
    const element = mediaElement.current;
    if (element) syncMedia(element);
  }, [syncMedia]);

  const transitionDuration = Math.min(
    clip?.duration ? clip.duration / 2 : 0.35,
    typeof (clip?.metadata as { transition_duration?: unknown } | undefined)?.transition_duration === 'number'
      ? (clip?.metadata as { transition_duration: number }).transition_duration
      : 0.35,
  );
  const transitionStyle = clip && transitionDuration > 0 && localTime < transitionDuration
    ? editorTransitionPreviewStyle(clip.transitionIn, true, localTime / transitionDuration)
    : clip && transitionDuration > 0 && localTime > clip.duration - transitionDuration
      ? editorTransitionPreviewStyle(
        clip.transitionOut,
        false,
        (localTime - (clip.duration - transitionDuration)) / transitionDuration,
      )
      : {};
  const automationStyle = automation ? {
    opacity: Math.max(0, Math.min(1, automation.opacity)),
    transform: `translate(${automation.x}px, ${automation.y}px) rotate(${automation.rotation}deg) scale(${automation.scale_x}, ${automation.scale_y})`,
  } : undefined;
  const visualStyle = {
    ...automationStyle,
    ...transitionStyle,
    opacity: (automationStyle?.opacity ?? 1) * ((transitionStyle.opacity as number | undefined) ?? 1),
    transform: `${automationStyle?.transform ?? ''} ${transitionStyle.transform ?? ''}`.trim() || undefined,
  };

  if (clip?.text) {
    return (
      <div className="program-monitor__text-preview" style={visualStyle}>
        <span style={{
          color: clip.text.color,
          background: clip.text.background ?? 'transparent',
          fontFamily: clip.text.font_family,
          fontSize: `${Math.max(12, Math.min(96, clip.text.font_size / 2))}px`,
          textAlign: clip.text.align as 'left' | 'center' | 'right',
        }}>{clip.text.content}</span>
      </div>
    );
  }

  if (media?.streamUrl) {
    const src = apiMediaUrl(media.streamUrl);
    if (media.kind === 'image') {
      return <img key={media.id} src={src} alt={media.name} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', ...visualStyle }} />;
    }
    if (media.kind === 'audio') {
      return <audio key={media.id} ref={(element) => { mediaElement.current = element; }} src={src} controls preload="metadata" onLoadedMetadata={(event) => syncMedia(event.currentTarget)} />;
    }
    return <video key={media.id} ref={(element) => { mediaElement.current = element; }} src={src} style={visualStyle} controls playsInline preload="metadata" onLoadedMetadata={(event) => syncMedia(event.currentTarget)} />;
  }

  return <><div className="monitor-grid" /><div className="monitor-title"><span>VIBE CS</span><strong>{clip?.name ?? projectName}</strong><small>TIMELINE PROGRAM</small></div><div className="monitor-hud"><span className="monitor-reticle"><i /><i /></span><span>{clip ? 'TIMELINE CLIP' : 'NO ACTIVE CLIP'}</span></div></>;
});

const TimelineAudioPreview = memo(function TimelineAudioPreview({
  clip,
  media,
  localTime,
  volume,
  playing,
}: {
  clip: TimelineClip;
  media: MediaBinItem | null;
  localTime: number;
  volume: number;
  playing: boolean;
}) {
  const mediaElement = useRef<HTMLAudioElement | null>(null);
  const syncMedia = useCallback((element: HTMLAudioElement) => {
    synchronizeMediaPreview(
      element,
      clip.sourceIn + sourceOffsetAt(clip, localTime),
      volume,
      speedAt(clip, localTime),
      playing,
    );
  }, [clip, localTime, playing, volume]);
  useEffect(() => {
    const element = mediaElement.current;
    if (element) syncMedia(element);
  }, [syncMedia]);
  if (!media?.streamUrl) return null;
  return <audio ref={mediaElement} src={apiMediaUrl(media.streamUrl)} preload="metadata" onLoadedMetadata={(event) => syncMedia(event.currentTarget)} />;
});

const makeId = (): string => crypto.randomUUID();

const blankProject = (): EditorProject => ({
  id: '',
  name: msg("m0753"),
  width: 1920,
  height: 1080,
  fps: 60,
  duration_seconds: 0,
  tracks: [],
  markers: [],
  settings: {},
  revision: 0,
  created_at: '',
  updated_at: '',
});

const emptyProjectTracks = (): TimelineTrack[] => [
  { id: makeId(), name: msg("m0168"), kind: 'video', muted: false, locked: false, clips: [] },
  { id: makeId(), name: msg("m1297"), kind: 'audio', muted: false, locked: false, clips: [] },
  { id: makeId(), name: msg("m0383"), kind: 'overlay', muted: false, locked: false, clips: [] },
];

const projectTracks = (project: EditorProject): TimelineTrack[] =>
  project.tracks.length > 0 ? toStoreTracks(project.tracks) : emptyProjectTracks();

const toStoreTracks = (tracks: TimelineTrackDto[]): TimelineTrack[] => tracks.map((track) => ({
  id: track.id,
  name: track.name,
  kind: track.kind,
  muted: track.muted,
  locked: track.locked,
  hidden: track.hidden,
  clips: track.clips.map((clip) => ({
    id: clip.id,
    assetId: clip.asset_id,
    name: clip.name,
    start: clip.start,
    duration: clip.duration,
    sourceIn: clip.source_in,
    sourceOut: clip.source_out,
    speed: clip.speed,
    volume: clip.volume,
    color: track.kind === 'audio' ? '#34d399' : track.kind === 'overlay' || track.kind === 'text' ? '#a78bfa' : '#f59e0b',
    transform: clip.transform,
    effects: clip.effects,
    transitionIn: clip.transition_in,
    transitionOut: clip.transition_out,
    text: clip.text,
    metadata: clip.metadata,
    groupId: clip.group_id,
    linkGroupId: clip.link_group_id,
    keyframes: clip.keyframes,
    speedSegments: clip.speed_segments,
  })),
}));

const toWireClip = (clip: TimelineClip): TimelineClipDto => ({
  id: clip.id,
  asset_id: clip.assetId,
  name: clip.name,
  start: clip.start,
  duration: clip.duration,
  source_in: clip.sourceIn,
  source_out: clip.sourceOut,
  speed: clip.speed,
  volume: clip.volume,
  transform: clip.transform ?? { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
  effects: clip.effects ?? [],
  transition_in: clip.transitionIn ?? null,
  transition_out: clip.transitionOut ?? null,
  text: clip.text ?? null,
  metadata: clip.metadata ?? {},
  group_id: clip.groupId ?? null,
  link_group_id: clip.linkGroupId ?? null,
  keyframes: clip.keyframes ?? [],
  speed_segments: clip.speedSegments ?? [],
});

const toWireTracks = (tracks: TimelineTrack[]): TimelineTrackDto[] => tracks.map((track, index) => ({
  id: track.id,
  name: track.name,
  kind: track.kind,
  order: index,
  muted: track.muted,
  locked: track.locked,
  hidden: track.hidden ?? false,
  clips: track.clips.map(toWireClip),
}));

export function EditorPage() {
  const [searchParams] = useSearchParams();
  const requestedProjectId = searchParams.get('project');
  const { t } = useI18n();
  const tracks = useTimelineStore((state) => state.tracks);
  const markers = useTimelineStore((state) => state.markers);
  const selectedClipId = useTimelineStore((state) => state.selectedClipId);
  const selectedClipIds = useTimelineStore((state) => state.selectedClipIds);
  const playhead = useTimelineStore((state) => state.playhead);
  const duration = useTimelineStore((state) => state.duration);
  const zoom = useTimelineStore((state) => state.zoom);
  const snapping = useTimelineStore((state) => state.snapping);
  const ripple = useTimelineStore((state) => state.ripple);
  const past = useTimelineStore((state) => state.past);
  const future = useTimelineStore((state) => state.future);
  const selectClip = useTimelineStore((state) => state.selectClip);
  const setPlayhead = useTimelineStore((state) => state.setPlayhead);
  const setProjectDuration = useTimelineStore((state) => state.setProjectDuration);
  const addTimelineMarker = useTimelineStore((state) => state.addMarker);
  const removeTimelineMarker = useTimelineStore((state) => state.removeMarker);
  const setZoom = useTimelineStore((state) => state.setZoom);
  const toggleSnapping = useTimelineStore((state) => state.toggleSnapping);
  const toggleRipple = useTimelineStore((state) => state.toggleRipple);
  const toggleTrackLock = useTimelineStore((state) => state.toggleTrackLock);
  const addClip = useTimelineStore((state) => state.addClip);
  const moveClip = useTimelineStore((state) => state.moveClip);
  const updateClip = useTimelineStore((state) => state.updateClip);
  const splitClip = useTimelineStore((state) => state.splitClip);
  const removeClip = useTimelineStore((state) => state.removeClip);
  const slipClip = useTimelineStore((state) => state.slipClip);
  const groupSelected = useTimelineStore((state) => state.groupSelected);
  const ungroupSelected = useTimelineStore((state) => state.ungroupSelected);
  const linkSelected = useTimelineStore((state) => state.linkSelected);
  const unlinkSelected = useTimelineStore((state) => state.unlinkSelected);
  const upsertKeyframe = useTimelineStore((state) => state.upsertKeyframe);
  const removeKeyframe = useTimelineStore((state) => state.removeKeyframe);
  const setSpeedSegments = useTimelineStore((state) => state.setSpeedSegments);
  const undo = useTimelineStore((state) => state.undo);
  const redo = useTimelineStore((state) => state.redo);
  const reset = useTimelineStore((state) => state.reset);
  const [projects, setProjects] = useState<EditorProject[]>([]);
  const [media, setMedia] = useState<RecordedClip[]>([]);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [presets, setPresets] = useState<EditorPreset[]>([]);
  const [activeProject, setActiveProject] = useState<EditorProject>(() => blankProject());
  const [source, setSource] = useState<'loading' | 'service' | 'unavailable'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [projectListOpen, setProjectListOpen] = useState(false);
  const [snapshotListOpen, setSnapshotListOpen] = useState(false);
  const [markerListOpen, setMarkerListOpen] = useState(false);
  const [presetName, setPresetName] = useState(msg("m0969"));
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [timelineNotice, setTimelineNotice] = useState<string | null>(null);
  const [keyframeProperty, setKeyframeProperty] = useState<TimelineKeyframeProperty>('opacity');
  const [snapshots, setSnapshots] = useState<EditorProjectSnapshot[]>([]);
  const [mediaQuery, setMediaQuery] = useState('');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('clip');
  const [playing, setPlaying] = useState(false);
  const [savedRevision, setSavedRevision] = useState(activeProject.revision);
  const [savedFingerprint, setSavedFingerprint] = useState(() =>
    projectEditFingerprint(activeProject.name, [], markers, activeProject.settings, activeProject.duration_seconds),
  );
  const [autoSaveState, setAutoSaveState] = useState<AutoSaveState>({ status: 'idle', message: null });
  const [autoSaveRetry, setAutoSaveRetry] = useState(0);
  const autoSaveInFlight = useRef(false);
  const projectSession = useRef(0);
  const [projectOperation, setProjectOperation] = useState<ProjectOperation | null>(null);
  const [operationGate] = useState(() => createOperationGate<ProjectOperation>());
  const [exportJobId, setExportJobId] = useState<string | null>(null);
  const [exportJob, setExportJob] = useState<ExportJobRecord | null>(null);
  const [exportPollError, setExportPollError] = useState<string | null>(null);
  const [waveforms, setWaveforms] = useState<Record<string, number[]>>({});
  const waveformRequests = useRef(new Set<string>());
  const [exportScope, setExportScope] = useState<'full' | 'range'>('full');
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(activeProject.duration_seconds);
  const fileInput = useRef<HTMLInputElement>(null);
  const replacementInput = useRef<HTMLInputElement>(null);
  const packageInput = useRef<HTMLInputElement>(null);
  const fontInput = useRef<HTMLInputElement>(null);
  const replacementAssetId = useRef<string | null>(null);
  const keyframeValueInput = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const recorderStream = useRef<MediaStream | null>(null);
  const recorderChunks = useRef<Blob[]>([]);
  const recorderBytes = useRef(0);
  const recorderLimitTimer = useRef<number | null>(null);
  const [recordingVoice, setRecordingVoice] = useState(false);
  const saveAction = useAsyncAction<EditorProject>();
  const createAction = useAsyncAction<EditorProject>();
  const duplicateAction = useAsyncAction<EditorProject>();
  const exportAction = useAsyncAction<{ job_id: string; status: 'queued' | 'running' }>();
  const cancelExportAction = useAsyncAction<ExportJobRecord>();
  const snapshotAction = useAsyncAction<{ items: EditorProjectSnapshot[] }>();
  const restoreAction = useAsyncAction<EditorProject>();
  const uploadAction = useAsyncAction<{ items: MediaAsset[] }>();
  const relinkAction = useAsyncAction<MediaAsset>();
  const proxyAction = useAsyncAction<MediaAsset>();
  const extractAudioAction = useAsyncAction<EditorAudioSeparation>();
  const packageExportAction = useAsyncAction<EditorPackageExport>();
  const packageImportAction = useAsyncAction<EditorPackageImport>();
  const presetMutationAction = useAsyncAction<EditorPreset>();
  const presetApplyAction = useAsyncAction<EditorProject>();
  const presetDeleteAction = useAsyncAction<void>();
  const projectDeleteAction = useAsyncAction<EditorProjectDeletionResult>();
  const mounted = useRef(true);
  const reloadController = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      reloadController.current?.abort();
      if (recorderLimitTimer.current !== null) window.clearTimeout(recorderLimitTimer.current);
      if (recorder.current) {
        recorder.current.ondataavailable = null;
        recorder.current.onstop = null;
        recorder.current.onerror = null;
        if (recorder.current.state === 'recording') recorder.current.stop();
      }
      recorderStream.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api.listEditorProjects(controller.signal),
      api.listRecordedClips(controller.signal),
      api.listMediaAssets(undefined, controller.signal),
      api.listEditorPresets(controller.signal).catch(() => ({ items: [] as EditorPreset[] })),
    ])
      .then(([response, recordedClips, mediaAssets, editorPresets]) => {
        if (controller.signal.aborted) return;
        setProjects(response.items);
        setMedia(recordedClips.items);
        setAssets(mediaAssets.items);
        setPresets(editorPresets.items);
        setSelectedPresetId(editorPresets.items[0]?.id ?? null);
        const first = response.items.find((project) => project.id === requestedProjectId) ?? response.items[0];
        if (first) {
          const loadedTracks = projectTracks(first);
          setActiveProject(first);
          reset(loadedTracks, first.duration_seconds, first.markers);
          setSavedRevision(first.revision);
          setSavedFingerprint(projectEditFingerprint(first.name, toWireTracks(loadedTracks), first.markers, first.settings, first.duration_seconds));
        } else {
          const empty = blankProject();
          setActiveProject(empty);
          setSavedRevision(0);
          setSavedFingerprint(projectEditFingerprint(empty.name, [], [], empty.settings, 0));
          reset([], 0, []);
        }
        setSource('service');
        setError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const empty = blankProject();
        setProjects([]);
        setMedia([]);
        setAssets([]);
        setPresets([]);
        setActiveProject(empty);
        setSavedRevision(0);
        setSavedFingerprint(projectEditFingerprint(empty.name, [], [], empty.settings, 0));
        reset([], 0, []);
        setSource('unavailable');
        setError(readableError(cause));
      });
    return () => controller.abort();
  }, [requestedProjectId, reset]);

  useEffect(() => {
    if (!playing) return undefined;
    const timer = window.setInterval(() => {
      const state = useTimelineStore.getState();
      if (state.playhead >= state.duration) {
        setPlaying(false);
        state.setPlayhead(0);
      } else {
        state.setPlayhead(state.playhead + 0.05);
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, [playing]);

  useEffect(() => {
    if (!exportJobId) return undefined;
    let disposed = false;
    let timer: number | undefined;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const next = await api.getExportJob(exportJobId, controller.signal);
        if (disposed) return;
        setExportJob(next);
        setExportPollError(null);
        if (['completed', 'failed', 'cancelled'].includes(next.job.status)) {
          setExportJobId(null);
          return;
        }
        timer = window.setTimeout(() => void refresh(), 750);
      } catch (cause) {
        if (disposed) return;
        setExportPollError(readableError(cause));
        timer = window.setTimeout(() => void refresh(), 2_000);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [exportJobId]);

  useEffect(() => {
    let disposed = false;
    const assetIds = new Set(assets.map((asset) => asset.id));
    const recordedIds = new Set(media.map((clip) => clip.id));
    const ids = [...new Set(
      tracks
        .filter((track) => track.kind === 'audio' && !track.muted && !track.hidden)
        .flatMap((track) => track.clips.map((clip) => clip.assetId))
        .filter((id): id is string => id !== null),
    )].filter((id) => !waveformRequests.current.has(id));
    if (ids.length === 0) return undefined;
    ids.forEach((id) => waveformRequests.current.add(id));
    void Promise.all(ids.map(async (id) => {
      try {
        if (assetIds.has(id)) return [id, (await api.getAssetWaveform(id, 120)).waveform] as const;
        if (recordedIds.has(id)) return [id, (await api.getRecordedClipWaveform(id, 120)).waveform] as const;
        return null;
      } catch {
        waveformRequests.current.delete(id);
        return null;
      }
    })).then((results) => {
      if (disposed) return;
      setWaveforms((current) => {
        const next = { ...current };
        results.forEach((result) => {
          if (result) next[result[0]] = result[1];
        });
        return next;
      });
    });
    return () => {
      disposed = true;
    };
  }, [assets, media, tracks]);

  const selectedClip = tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId) ?? null;
  const selectedTrack = selectedClip ? tracks.find((track) => track.clips.some((clip) => clip.id === selectedClip.id)) ?? null : null;
  const selectedTransform = selectedClip?.transform ?? { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 };
  const selectedColor = readColorAdjust(selectedClip);
  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId) ?? null;
  useEffect(() => {
    setPresetName(selectedPreset?.name ?? msg("m0969"));
  }, [selectedPreset?.id, selectedPreset?.name]);
  const selectedLocalTime = selectedClip
    ? Math.max(0, Math.min(selectedClip.duration, playhead - selectedClip.start))
    : 0;
  const sourceDurations = useMemo(() => Object.fromEntries([
    ...media.map((clip) => [clip.id, clip.duration_seconds] as const),
    ...assets.flatMap((asset) => asset.duration_seconds ? [[asset.id, asset.duration_seconds] as const] : []),
  ]), [assets, media]);
  const previewAutomation = useMemo(
    () => selectedClip ? automationAt(selectedClip, selectedLocalTime) : null,
    [selectedClip, selectedLocalTime],
  );
  const keyframeProperties = useMemo<TimelineKeyframeProperty[]>(() => {
    if (selectedTrack?.kind === 'audio') return ['volume'];
    if (selectedClip?.text) return ['x', 'y', 'opacity'];
    return ['x', 'y', 'scale_x', 'scale_y', 'rotation', 'opacity', 'volume'];
  }, [selectedClip?.text, selectedTrack?.kind]);
  const activeKeyframeProperty = keyframeProperties.includes(keyframeProperty)
    ? keyframeProperty
    : keyframeProperties[0] ?? 'opacity';
  const reportTimelineResult = useCallback((result: TimelineOperationResult, success?: string) => {
    setTimelineNotice(result.ok ? success ?? null : result.reason);
    return result.ok;
  }, []);
  const updateSelectedTransform = (patch: Partial<NonNullable<TimelineClip['transform']>>) => {
    if (!selectedClip) return;
    updateClip(selectedClip.id, { transform: { ...selectedTransform, ...patch } });
  };
  const updateSelectedColor = (patch: Partial<ColorAdjust>) => {
    if (!selectedClip) return;
    const parameters = { ...selectedColor, ...patch };
    const effects = [
      ...(selectedClip.effects ?? []).filter((effect) => effect.kind !== 'color_adjust'),
      { id: 'color-adjust', kind: 'color_adjust', enabled: true, parameters },
    ];
    updateClip(selectedClip.id, { effects });
  };
  const wireTracks = useMemo(() => toWireTracks(tracks), [tracks]);
  const currentFingerprint = useMemo(
    () => projectEditFingerprint(activeProject.name, wireTracks, markers, activeProject.settings, duration),
    [activeProject.name, activeProject.settings, duration, markers, wireTracks],
  );
  const hasUnsavedChanges = currentFingerprint !== savedFingerprint;
  const isPreview = activeProject.id.length === 0;
  const editorLocked = projectOperation !== null || source === 'loading';
  const activeProjectId = useRef(activeProject.id);
  activeProjectId.current = activeProject.id;

  useEffect(() => {
    if (
      source !== 'service'
      || isPreview
      || !hasUnsavedChanges
      || projectOperation !== null
      || autoSaveState.status === 'saving'
      || autoSaveState.status === 'error'
      || autoSaveState.status === 'conflict'
    ) return undefined;
    const projectId = activeProject.id;
    const session = projectSession.current;
    const fingerprint = currentFingerprint;
    const payload: EditorProject = {
      ...activeProject,
      revision: savedRevision,
      duration_seconds: duration,
      tracks: wireTracks,
      markers,
      updated_at: new Date().toISOString(),
    };
    const timer = window.setTimeout(() => {
      if (autoSaveInFlight.current) return;
      autoSaveInFlight.current = true;
      setAutoSaveState({ status: 'saving', message: msg("m0862") });
      void api.saveEditorProject(payload)
        .then((saved) => {
          if (!mounted.current) return;
          setProjects((items) => items.map((project) => project.id === saved.id ? saved : project));
          if (activeProjectId.current !== projectId || projectSession.current !== session) return;
          setSavedRevision(saved.revision);
          setSavedFingerprint(fingerprint);
          setActiveProject((current) => current.id === saved.id ? {
            ...current,
            duration_seconds: saved.duration_seconds,
            revision: saved.revision,
            created_at: saved.created_at,
            updated_at: saved.updated_at,
          } : current);
          setAutoSaveState({ status: 'saved', message: msgf("m0534", [saved.revision]) });
        })
        .catch((cause: unknown) => {
          if (!mounted.current) return;
          if (activeProjectId.current !== projectId || projectSession.current !== session) return;
          const conflict = cause instanceof ApiError && cause.code === 'revision_conflict';
          setAutoSaveState({
            status: conflict ? 'conflict' : 'error',
            message: conflict
              ? msg("m1094")
              : msgf("m1093", [readableError(cause)]),
          });
        })
        .finally(() => {
          autoSaveInFlight.current = false;
          if (mounted.current) setAutoSaveRetry((value) => value + 1);
        });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [
    activeProject,
    autoSaveRetry,
    autoSaveState.status,
    currentFingerprint,
    duration,
    hasUnsavedChanges,
    isPreview,
    projectOperation,
    savedRevision,
    source,
    markers,
    wireTracks,
  ]);
  const mediaItems = useMemo<MediaBinItem[]>(() => [
    ...media.map((clip) => ({
      id: clip.id,
      name: clip.title,
      detail: clip.player_name,
      duration: clip.duration_seconds,
      kind: 'video' as const,
      streamUrl: clip.stream_url,
      asset: null,
    })),
    ...assets.filter((asset) => !asset.kind.startsWith('font') && !asset.kind.includes('truetype') && !asset.kind.includes('opentype')).map((asset) => ({
      id: asset.id,
      name: asset.name,
      detail: asset.kind,
      duration: asset.duration_seconds && asset.duration_seconds > 0 ? asset.duration_seconds : 5,
      kind: asset.kind.startsWith('audio') ? 'audio' as const : asset.kind.startsWith('image') ? 'image' as const : 'video' as const,
      streamUrl: asset.proxy_status.status === 'ready'
        ? `/api/v1/media/assets/${encodeURIComponent(asset.id)}/proxy/stream`
        : `/api/v1/media/assets/${encodeURIComponent(asset.id)}/stream`,
      asset,
    })),
  ], [assets, media]);
  const filteredMedia = useMemo(() => {
    const query = mediaQuery.trim().toLocaleLowerCase();
    return mediaItems.filter((item) => !query || `${item.name} ${item.detail}`.toLocaleLowerCase().includes(query));
  }, [mediaItems, mediaQuery]);
  const selectedMedia = selectedClip?.assetId ? mediaItems.find((item) => item.id === selectedClip.assetId) ?? null : null;
  const selectedClipHasSeparatedAudio = selectedClip
    ? hasSeparatedAudioChild(tracks, selectedClip.id)
    : false;
  const timelinePreviewLayers = useMemo(() => activeTimelineClips(tracks, playhead).map((layer) => ({
    ...layer,
    automation: automationAt(layer.clip, layer.localTime),
    media: layer.clip.assetId ? mediaItems.find((item) => item.id === layer.clip.assetId) ?? null : null,
  })), [mediaItems, playhead, tracks]);
  const visualPreviewLayers = timelinePreviewLayers.filter((layer) => layer.trackKind !== 'audio');
  const audioPreviewLayers = timelinePreviewLayers.filter((layer) => layer.trackKind === 'audio');
  const selectedSourceDuration = selectedClip?.assetId
    ? sourceDurations[selectedClip.assetId]
    : undefined;
  const timelineContentEnd = useMemo(() => Math.max(
    0,
    ...tracks.flatMap((track) => track.clips.map((clip) => clip.start + clip.duration)),
  ), [tracks]);
  const selectedPresetCompatibility = presetCompatibilityReason(
    selectedTrack?.kind ?? null,
    selectedClip?.text !== null && selectedClip?.text !== undefined,
    selectedClip?.volume ?? null,
    selectedPreset?.document ?? null,
  );
  const killAxisEvents = useMemo(
    () => tracks.flatMap((track) => track.clips.flatMap(mapKillAxisEvents)),
    [tracks],
  );
  const templates = useMemo(() => projects.filter(isEditorTemplate), [projects]);

  const beginProjectOperation = (operation: ProjectOperation): boolean => {
    if (!operationGate.tryStart(operation)) return false;
    setProjectOperation(operation);
    return true;
  };

  const finishProjectOperation = (operation: ProjectOperation) => {
    if (operationGate.finish(operation)) setProjectOperation(null);
  };

  const activateProject = (project: EditorProject, nextTracks: TimelineTrack[]) => {
    projectSession.current += 1;
    setPlaying(false);
    setActiveProject(project);
    setSavedRevision(project.revision);
    setSavedFingerprint(projectEditFingerprint(project.name, toWireTracks(nextTracks), project.markers, project.settings, project.duration_seconds));
    setAutoSaveState({ status: 'idle', message: null });
    setExportScope('full');
    setRangeStart(0);
    setRangeEnd(project.duration_seconds);
    reset(nextTracks, project.duration_seconds, project.markers);
    setProjectListOpen(false);
    setSnapshotListOpen(false);
    setMarkerListOpen(false);
  };

  const confirmDiscardIfNeeded = (targetProjectId: string | null, action: string): 'stay' | 'cancel' | 'proceed' => {
    const decision = decideProjectTransition(
      activeProject.id,
      targetProjectId,
      currentFingerprint,
      savedFingerprint,
    );
    if (decision === 'stay') return 'stay';
    if (decision === 'confirm' && !window.confirm(msgf("m0570", [action]))) {
      return 'cancel';
    }
    return 'proceed';
  };

  const openProject = (project: EditorProject) => {
    if (operationGate.current() !== null) return;
    const decision = confirmDiscardIfNeeded(project.id, msgf("m0276", [project.name]));
    if (decision === 'stay') {
      setProjectListOpen(false);
      return;
    }
    if (decision === 'cancel') return;
    activateProject(project, projectTracks(project));
  };

  const newProject = async () => {
    if (source !== 'service' || !beginProjectOperation('creating')) return;
    try {
      if (confirmDiscardIfNeeded(null, msg("m0696")) !== 'proceed') return;
      const created = await createAction.run(
        () => api.createEditorProject({ name: msg("m0753"), width: 1920, height: 1080, fps: 60 }),
        msg("m0694"),
      );
      if (!created) return;
      setProjects((items) => [created, ...items]);
      activateProject(created, projectTracks(created));
    } finally {
      finishProjectOperation('creating');
    }
  };

  const projectPayload = (): EditorProject => ({
    ...activeProject,
    revision: savedRevision,
    duration_seconds: duration,
    tracks: wireTracks,
    markers,
    updated_at: new Date().toISOString(),
  });

  const persistCurrentProject = async (successMessage: string): Promise<EditorProject | null> => {
    if (isPreview || autoSaveInFlight.current) return null;
    const result = await saveAction.run(() => api.saveEditorProject(projectPayload()), successMessage);
    if (result) {
      setProjects((items) => items.map((project) => project.id === result.id ? result : project));
      activateProject(result, toStoreTracks(result.tracks));
    }
    return result;
  };

  const saveProject = async () => {
    if (isPreview || autoSaveInFlight.current || !beginProjectOperation('saving')) return;
    try {
      setAutoSaveState({ status: 'idle', message: null });
      await persistCurrentProject(msg("m0477"));
    } finally {
      finishProjectOperation('saving');
    }
  };

  const duplicateProject = async (asTemplate: boolean) => {
    if (isPreview || autoSaveInFlight.current || !beginProjectOperation('duplicating')) return;
    try {
      const saved = hasUnsavedChanges
        ? await persistCurrentProject(msg("m0565"))
        : activeProject;
      if (!saved) return;
      const suffix = asTemplate ? msg("m0836") : msg("m0298");
      const duplicate = await duplicateAction.run(
        () => api.duplicateEditorProject(saved.id, `${saved.name} ${suffix}`, asTemplate),
        asTemplate ? msg("m0347") : msg("m0475"),
      );
      if (!duplicate) return;
      setProjects((items) => [duplicate, ...items]);
      if (!asTemplate) activateProject(duplicate, toStoreTracks(duplicate.tracks));
    } finally {
      finishProjectOperation('duplicating');
    }
  };

  const createFromTemplate = async (template: EditorProject) => {
    if (editorLocked || !beginProjectOperation('duplicating')) return;
    try {
      if (confirmDiscardIfNeeded(template.id, msg("m0190")) === 'cancel') return;
      const created = await duplicateAction.run(
        () => api.duplicateEditorProject(template.id, msgf("m0105", [template.name]), false),
        msg("m0486"),
      );
      if (!created) return;
      setProjects((items) => [created, ...items]);
      activateProject(created, toStoreTracks(created.tracks));
    } finally {
      finishProjectOperation('duplicating');
    }
  };

  const duplicateSelectedClip = () => {
    if (!selectedClip || !selectedTrack || selectedTrack.locked) return;
    const duplicate = duplicateTimelineClip(
      selectedClip,
      Math.min(MAX_EDITOR_TIMELINE_SECONDS - selectedClip.duration, selectedClip.start + selectedClip.duration + 0.1),
    );
    reportTimelineResult(
      addClip(selectedTrack.id, duplicate, ripple),
      ripple ? msg("m0954") : msg("m0953"),
    );
  };

  const importVoiceRecording = async (blob: Blob) => {
    const extension = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';
    const file = new File([blob], `voice-${new Date().toISOString().replaceAll(':', '-')}.${extension}`, {
      type: blob.type || 'audio/webm',
    });
    await importFiles([file]);
  };

  const toggleVoiceRecording = async () => {
    if (recordingVoice) {
      recorder.current?.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setTimelineNotice(msg("m0580"));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const preferred = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
        .find((type) => MediaRecorder.isTypeSupported(type));
      const next = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      recorderStream.current = stream;
      recorderChunks.current = [];
      recorderBytes.current = 0;
      next.ondataavailable = (event) => {
        if (event.data.size <= 0) return;
        recorderBytes.current += event.data.size;
        if (recorderBytes.current > 256 * 1024 * 1024) {
          setTimelineNotice(msg("m1259"));
          next.stop();
          return;
        }
        recorderChunks.current.push(event.data);
      };
      next.onstop = () => {
        if (recorderLimitTimer.current !== null) window.clearTimeout(recorderLimitTimer.current);
        recorderLimitTimer.current = null;
        const blob = new Blob(recorderChunks.current, { type: next.mimeType });
        recorderChunks.current = [];
        recorderBytes.current = 0;
        recorderStream.current?.getTracks().forEach((track) => track.stop());
        recorderStream.current = null;
        recorder.current = null;
        setRecordingVoice(false);
        if (blob.size > 0) void importVoiceRecording(blob);
      };
      next.onerror = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecordingVoice(false);
        setTimelineNotice(msg("m1328"));
      };
      recorder.current = next;
      next.start(1_000);
      recorderLimitTimer.current = window.setTimeout(() => {
        if (next.state === 'recording') {
          setTimelineNotice(msg("m1260"));
          next.stop();
        }
      }, 30 * 60_000);
      setRecordingVoice(true);
      setTimelineNotice(msg("m0849"));
    } catch (cause) {
      setTimelineNotice(msgf("m0706", [readableError(cause)]));
    }
  };

  const importCustomFont = async (file: File | undefined) => {
    if (!file || !selectedClip?.text) return;
    if (!/\.(ttf|otf)$/i.test(file.name) || file.size > 20 * 1024 * 1024) {
      setTimelineNotice(msg("m0436"));
      return;
    }
    const result = await uploadAction.run(
      () => api.uploadMediaAssets([file], activeProject.id),
      msg("m1098"),
    );
    const asset = result?.items[0];
    if (!asset) return;
    setAssets((current) => [asset, ...current]);
    const family = `VibeCSCustom-${asset.id}`;
    try {
      const face = new FontFace(family, `url(${apiMediaUrl(`/api/v1/media/assets/${encodeURIComponent(asset.id)}/stream`)})`);
      await face.load();
      document.fonts.add(face);
    } catch {
      setTimelineNotice(msg("m0435"));
    }
    updateClip(selectedClip.id, {
      text: { ...selectedClip.text, font_family: family, font_asset_id: asset.id },
    });
  };

  const extractSelectedAudio = async () => {
    const asset = selectedMedia?.asset;
    if (!selectedClip || !asset || !asset.kind.startsWith('video') || !asset.has_audio
      || isPreview || autoSaveInFlight.current || !beginProjectOperation('separating_audio')) return;
    const clipId = selectedClip.id;
    try {
      const saved = hasUnsavedChanges
        ? await persistCurrentProject(msg("m0566"))
        : activeProject;
      if (!saved) return;
      const separated = await extractAudioAction.run(
        () => api.separateEditorAudio(saved.id, clipId, saved.revision, true),
        msg("m1298"),
      );
      if (!separated) return;
      setAssets((items) => [separated.asset, ...items]);
      setProjects((items) => items.map((project) =>
        project.id === separated.project.id ? separated.project : project));
      activateProject(separated.project, toStoreTracks(separated.project.tracks));
    } finally {
      finishProjectOperation('separating_audio');
    }
  };

  const appendMedia = (index: number) => {
    const item = filteredMedia[index];
    const targetKind = item?.kind === 'audio' ? 'audio' : item?.kind === 'image' ? 'overlay' : 'video';
    const targetTrack = tracks.find((track) => track.kind === targetKind);
    if (!item || !targetTrack) return;
    const result = addClip(targetTrack.id, {
      id: isPreview ? `preview-clip-${Date.now()}` : makeId(),
      assetId: item.id,
      name: item.name,
      start: duration,
      duration: item.duration,
      sourceIn: 0,
      sourceOut: item.duration,
      speed: 1,
      volume: 1,
      color: ['#f59e0b', '#fb7185', '#60a5fa'][index % 3] ?? '#f59e0b',
      transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
      effects: [],
      transitionIn: null,
      transitionOut: null,
    }, ripple);
    reportTimelineResult(result, ripple ? msg("m0519") : undefined);
  };

  const appendText = () => {
    const targetTrack = tracks.find((track) => track.kind === 'text' || track.kind === 'overlay');
    if (!targetTrack) return;
    const result = addClip(targetTrack.id, {
      id: isPreview ? `preview-text-${Date.now()}` : makeId(),
      assetId: null,
      name: msg("m0820"),
      start: playhead,
      duration: 3,
      sourceIn: 0,
      sourceOut: 3,
      speed: 1,
      volume: 0,
      color: '#a78bfa',
      transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
      effects: [],
      transitionIn: null,
      transitionOut: null,
      text: {
        content: msg("m1183"),
        font_family: 'Arial',
        font_size: 72,
        color: '#FFFFFF',
        background: '#000000',
        align: 'center',
      },
      metadata: {},
    }, ripple);
    reportTimelineResult(result, ripple ? msg("m0518") : undefined);
  };

  const snapTime = (candidate: number, movingClipId?: string): number => {
    if (!snapping) return Math.max(0, candidate);
    return snapTimelineTime(
      candidate,
      wireTracks,
      markers,
      playhead,
      8 / Math.max(1, 12 * zoom),
      movingClipId,
    ).time;
  };

  const addMarker = () => {
    const marker = {
      id: makeId(),
      time: Math.min(duration, Math.max(0, playhead)),
      label: msgf("m0816", [markers.length + 1]),
      color: ['#F59E0B', '#60A5FA', '#A78BFA', '#34D399'][markers.length % 4] ?? '#F59E0B',
    };
    if (reportTimelineResult(addTimelineMarker(marker), msg("m0818"))) setMarkerListOpen(true);
  };

  const removeMarker = (id: string) => {
    reportTimelineResult(removeTimelineMarker(id), msg("m0817"));
  };

  const resizeTimelineClip = (
    clipId: string,
    candidateStart: number,
    candidateEnd: number,
    direction: 'left' | 'right',
  ) => {
    const location = useTimelineStore.getState().tracks.flatMap((track) =>
      track.clips.map((clip) => ({ track, clip }))).find(({ clip }) => clip.id === clipId);
    if (!location || location.track.locked || location.clip.groupId || location.clip.linkGroupId) return;
    const { clip } = location;
    if ((clip.speedSegments?.length ?? 0) > 0) return;

    if (direction === 'left') {
      const minimumStart = Math.max(0, clip.start - clip.sourceIn / clip.speed);
      const start = Math.min(clip.start + clip.duration - 0.1, Math.max(minimumStart, snapTime(candidateStart, clip.id)));
      const durationSeconds = Math.max(0.1, candidateEnd - start);
      const sourceIn = Math.max(0, clip.sourceIn + (start - clip.start) * clip.speed);
      reportTimelineResult(updateClip(clip.id, {
        start,
        duration: durationSeconds,
        sourceIn,
        sourceOut: sourceIn + durationSeconds * clip.speed,
        keyframes: (clip.keyframes ?? []).filter((keyframe) => keyframe.time <= durationSeconds),
      }));
      return;
    }

    const end = Math.max(clip.start + 0.1, snapTime(candidateEnd, clip.id));
    const durationSeconds = end - clip.start;
    reportTimelineResult(updateClip(clip.id, {
      duration: durationSeconds,
      sourceOut: clip.sourceIn + durationSeconds * clip.speed,
      keyframes: (clip.keyframes ?? []).filter((keyframe) => keyframe.time <= durationSeconds),
    }));
  };

  const importFiles = async (files: File[]) => {
    if (isPreview || files.length === 0) return;
    const result = await uploadAction.run(
      () => api.uploadMediaAssets(files, activeProject.id),
      msgf("m0099", [files.length]),
    );
    if (result) setAssets((current) => [...result.items, ...current]);
  };

  const replaceAssetInState = (replacement: MediaAsset) => {
    setAssets((items) => items.map((asset) => asset.id === replacement.id ? replacement : asset));
  };

  const relinkAsset = async (asset: MediaAsset) => {
    if (isDesktopShell()) {
      const path = await chooseLocalFile({
        title: msgf("m1265", [asset.name]),
        filters: [{ name: msg("m0434"), extensions: ['mp4', 'mov', 'mkv', 'webm', 'wav', 'mp3', 'flac', 'png', 'jpg', 'jpeg', 'webp'] }],
      });
      if (!path) return;
      const result = await relinkAction.run(
        () => api.relinkMediaAsset(asset.id, path),
        msgf("m0124", [asset.name]),
      );
      if (result) replaceAssetInState(result);
      return;
    }
    replacementAssetId.current = asset.id;
    replacementInput.current?.click();
  };

  const replaceAssetFile = async (file: File | undefined) => {
    const assetId = replacementAssetId.current;
    replacementAssetId.current = null;
    if (!assetId || !file) return;
    const result = await relinkAction.run(
      () => api.replaceMediaAsset(assetId, file),
      msg("m0911"),
    );
    if (result) replaceAssetInState(result);
  };

  const generateProxy = async (asset: MediaAsset) => {
    setAssets((items) => items.map((item) => item.id === asset.id ? {
      ...item,
      proxy_status: { status: 'generating', started_at: new Date().toISOString() },
    } : item));
    const result = await proxyAction.run(
      () => api.generateMediaProxy(asset.id),
      msgf("m0126", [asset.name]),
    );
    if (result) {
      replaceAssetInState(result);
      return;
    }
    try {
      replaceAssetInState(await api.getMediaAsset(asset.id));
    } catch {
      setAssets((items) => items.map((item) => item.id === asset.id ? asset : item));
    }
  };

  const exportPackage = async () => {
    if (isPreview || autoSaveInFlight.current || !beginProjectOperation('packaging')) return;
    try {
      const saved = hasUnsavedChanges
        ? await persistCurrentProject(msg("m0568"))
        : activeProject;
      if (!saved) return;
      const result = await packageExportAction.run(
        () => api.exportEditorPackage(saved.id),
        msg("m0207"),
      );
      if (!result?.download_url) return;
      const link = document.createElement('a');
      link.href = apiMediaUrl(result.download_url);
      link.download = result.name;
      link.click();
    } finally {
      finishProjectOperation('packaging');
    }
  };

  const performPackageImport = async (load: () => Promise<EditorPackageImport>) => {
    if (!beginProjectOperation('importing')) return;
    try {
      if (confirmDiscardIfNeeded(null, msg("m0455")) !== 'proceed') return;
      const result = await packageImportAction.run(load, msg("m0208"));
      if (!result) return;
      setProjects((items) => [result.project, ...items]);
      setAssets((items) => [...result.assets, ...items]);
      activateProject(result.project, toStoreTracks(result.project.tracks));
    } finally {
      finishProjectOperation('importing');
    }
  };

  const choosePackageImport = async () => {
    if (isDesktopShell()) {
      const path = await chooseLocalFile({
        title: msg("m0454"),
        filters: [{ name: msg("m0206"), extensions: ['vcep'] }],
      });
      if (path) await performPackageImport(() => api.importEditorPackagePath(path));
      return;
    }
    packageInput.current?.click();
  };

  const reloadServerProject = async () => {
    if (!window.confirm(msg("m1178"))) return;
    if (!beginProjectOperation('reloading')) return;
    reloadController.current?.abort();
    const controller = new AbortController();
    reloadController.current = controller;
    const projectId = activeProject.id;
    const session = projectSession.current;
    try {
      const project = await api.getEditorProject(projectId, controller.signal);
      if (controller.signal.aborted
        || !mounted.current
        || activeProjectId.current !== projectId
        || projectSession.current !== session) return;
      setProjects((items) => items.map((item) => item.id === project.id ? project : item));
      activateProject(project, projectTracks(project));
    } catch (cause) {
      if (controller.signal.aborted
        || !mounted.current
        || activeProjectId.current !== projectId
        || projectSession.current !== session) return;
      setAutoSaveState({ status: 'error', message: msgf("m1176", [readableError(cause)]) });
    } finally {
      if (reloadController.current === controller) reloadController.current = null;
      finishProjectOperation('reloading');
    }
  };

  const createPresetFromSelection = async () => {
    if (!selectedClip || presetMutationAction.state.status === 'loading') return;
    const result = await presetMutationAction.run(
      () => api.createEditorPreset(presetName, presetDocumentFromClip(selectedClip)),
      msg("m0498"),
    );
    if (!result) return;
    setPresets((items) => [result, ...items]);
    setSelectedPresetId(result.id);
  };

  const updatePresetFromSelection = async () => {
    if (!selectedClip || !selectedPreset || presetMutationAction.state.status === 'loading') return;
    const result = await presetMutationAction.run(
      () => api.updateEditorPreset({
        ...selectedPreset,
        name: presetName,
        document: presetDocumentFromClip(selectedClip),
      }),
      msg("m1316"),
    );
    if (!result) return;
    setPresets((items) => items.map((preset) => preset.id === result.id ? result : preset));
  };

  const deleteSelectedPreset = async () => {
    if (!selectedPreset || presetDeleteAction.state.status === 'loading') return;
    if (!window.confirm(msgf("m0292", [selectedPreset.name]))) return;
    const result = await presetDeleteAction.run(
      () => api.deleteEditorPreset(selectedPreset.id, selectedPreset.revision),
      msg("m1314"),
    );
    if (result === null) return;
    const remaining = presets.filter((preset) => preset.id !== selectedPreset.id);
    setPresets(remaining);
    setSelectedPresetId(remaining[0]?.id ?? null);
  };

  const applySelectedPreset = async () => {
    if (!selectedClip || !selectedPreset || isPreview || autoSaveInFlight.current
      || !beginProjectOperation('preset')) return;
    try {
      if (selectedPresetCompatibility) {
        setTimelineNotice(selectedPresetCompatibility);
        return;
      }
      const saved = hasUnsavedChanges
        ? await persistCurrentProject(msg("m0567"))
        : activeProject;
      if (!saved) return;
      const result = await presetApplyAction.run(
        () => api.applyEditorPreset(
          saved.id,
          selectedClip.id,
          selectedPreset.id,
          saved.revision,
          selectedPreset.revision,
        ),
        msg("m1315"),
      );
      if (!result) return;
      setProjects((items) => items.map((project) => project.id === result.id ? result : project));
      activateProject(result, toStoreTracks(result.tracks));
    } finally {
      finishProjectOperation('preset');
    }
  };

  const deleteSelectedProjects = async () => {
    if (isPreview || autoSaveInFlight.current || !beginProjectOperation('deleting')) return;
    try {
      const ids = selectedProjectIds.length > 0 ? selectedProjectIds : [activeProject.id];
      const candidates = projects.filter((project) => ids.includes(project.id) && !project.id.startsWith('preview-'));
      const remaining = projects.filter((project) => !candidates.some((candidate) => candidate.id === project.id));
      if (candidates.length === 0) return;
      if (remaining.length === 0) {
        setTimelineNotice(msg("m0999"));
        return;
      }
      if (!window.confirm(msgf("m0286", [candidates.length]))) return;
      const result = await projectDeleteAction.run(
        () => api.deleteEditorProjects(candidates.map((project) => ({
          id: project.id,
          expected_revision: project.revision,
        }))),
        msg("m0484"),
      );
      if (!result) return;
      setProjects(remaining);
      setAssets((items) => items.filter((asset) => !result.deleted_asset_ids.includes(asset.id)));
      setSelectedProjectIds([]);
      if (result.deleted_project_ids.includes(activeProject.id)) {
        const next = remaining[0];
        if (next) activateProject(next, projectTracks(next));
      }
      if (result.failed_files.length > 0) {
        setTimelineNotice(msgf("m0098", [result.failed_files.length]));
      }
    } finally {
      finishProjectOperation('deleting');
    }
  };

  const slipSelected = (delta: number) => {
    if (!selectedClip) return;
    reportTimelineResult(
      slipClip(selectedClip.id, delta, sourceDurations),
      msgf("m0531", [Math.abs(delta).toFixed(2)]),
    );
  };

  const writeKeyframe = () => {
    if (!selectedClip || !previewAutomation) return;
    const value = Number(keyframeValueInput.current?.value ?? previewAutomation[activeKeyframeProperty]);
    reportTimelineResult(
      upsertKeyframe(
        selectedClip.id,
        activeKeyframeProperty,
        selectedLocalTime,
        value,
      ),
      msgf("m0505", [selectedLocalTime.toFixed(2)]),
    );
  };

  const createTwoSegmentRamp = () => {
    if (!selectedClip || selectedClip.text) return;
    if (selectedMedia?.kind === 'image') {
      setTimelineNotice(msg("m1294"));
      return;
    }
    const middle = selectedClip.duration / 2;
    reportTimelineResult(setSpeedSegments(selectedClip.id, [
      { start: 0, end: middle, speed: 0.75 },
      { start: middle, end: selectedClip.duration, speed: 1.25 },
    ], selectedClip.assetId ? sourceDurations[selectedClip.assetId] : undefined), msg("m0497"));
  };

  const updateSpeedSegment = (segmentId: string, speed: number) => {
    if (!selectedClip) return;
    if (selectedMedia?.kind === 'image') {
      setTimelineNotice(msg("m1293"));
      return;
    }
    const safeSpeed = boundedTimelineValue(speed, 1, 0.05, 16);
    const segments = (selectedClip.speedSegments ?? []).map((segment) =>
      segment.id === segmentId ? { ...segment, speed: safeSpeed } : segment);
    reportTimelineResult(setSpeedSegments(
      selectedClip.id,
      segments,
      selectedClip.assetId ? sourceDurations[selectedClip.assetId] : undefined,
    ));
  };

  const clearSpeedRamp = () => {
    if (!selectedClip) return;
    reportTimelineResult(setSpeedSegments(
      selectedClip.id,
      [],
      selectedClip.assetId ? sourceDurations[selectedClip.assetId] : undefined,
    ), msg("m0530"));
  };

  const updateSelectedStart = (value: number) => {
    if (!selectedClip || !selectedTrack) return;
    const maximum = Math.max(0, MAX_EDITOR_TIMELINE_SECONDS - selectedClip.duration);
    const candidate = boundedTimelineValue(value, selectedClip.start, 0, maximum);
    const snapped = boundedTimelineValue(
      snapTime(candidate, selectedClip.id),
      selectedClip.start,
      0,
      maximum,
    );
    reportTimelineResult(
      moveClip(selectedClip.id, selectedTrack.id, snapped, ripple),
      ripple ? msg("m0512") : msg("m0961"),
    );
  };

  const updateSelectedDuration = (value: number) => {
    if (!selectedClip) return;
    const timelineMaximum = MAX_EDITOR_TIMELINE_SECONDS - selectedClip.start;
    const sourceMaximum = selectedSourceDuration === undefined
      ? timelineMaximum
      : (selectedSourceDuration - selectedClip.sourceIn) / selectedClip.speed;
    const maximum = Math.min(timelineMaximum, sourceMaximum);
    if (!Number.isFinite(maximum) || maximum < 0.1) {
      setTimelineNotice(msg("m0581"));
      return;
    }
    const durationSeconds = boundedTimelineValue(value, selectedClip.duration, 0.1, maximum);
    reportTimelineResult(updateClip(selectedClip.id, {
      duration: durationSeconds,
      sourceOut: selectedClip.sourceIn + durationSeconds * selectedClip.speed,
    }));
  };

  const updateSelectedSourceIn = (value: number) => {
    if (!selectedClip) return;
    const sourceLimit = selectedSourceDuration ?? selectedClip.sourceOut;
    const requiredSource = selectedClip.duration * selectedClip.speed;
    const maximum = Math.max(0, sourceLimit - requiredSource);
    const sourceIn = boundedTimelineValue(value, selectedClip.sourceIn, 0, maximum);
    reportTimelineResult(updateClip(selectedClip.id, {
      sourceIn,
      sourceOut: sourceIn + requiredSource,
    }));
  };

  const updateSelectedSourceOut = (value: number) => {
    if (!selectedClip) return;
    const minimum = selectedClip.sourceIn + 0.05;
    const timelineMaximum = selectedClip.sourceIn
      + (MAX_EDITOR_TIMELINE_SECONDS - selectedClip.start) * selectedClip.speed;
    const sourceMaximum = selectedSourceDuration ?? timelineMaximum;
    const maximum = Math.min(timelineMaximum, sourceMaximum);
    if (maximum < minimum) {
      setTimelineNotice(msg("m0582"));
      return;
    }
    const sourceOut = boundedTimelineValue(value, selectedClip.sourceOut, minimum, maximum);
    reportTimelineResult(updateClip(selectedClip.id, {
      sourceOut,
      duration: (sourceOut - selectedClip.sourceIn) / selectedClip.speed,
    }));
  };

  const updateSelectedBaseSpeed = (value: number) => {
    if (!selectedClip) return;
    const speed = boundedTimelineValue(value, selectedClip.speed, 0.05, 16);
    const sourceOut = selectedClip.sourceIn + selectedClip.duration * speed;
    if (selectedSourceDuration !== undefined && sourceOut > selectedSourceDuration + 0.000_001) {
      setTimelineNotice(msg("m1126"));
      return;
    }
    reportTimelineResult(updateClip(selectedClip.id, { speed, sourceOut }));
  };

  const updateProjectDurationFromInput = (value: number) => {
    const next = boundedTimelineValue(
      value,
      duration,
      timelineContentEnd,
      MAX_EDITOR_TIMELINE_SECONDS,
    );
    const markerCount = markers.length;
    const result = setProjectDuration(next);
    const removedMarkers = markerCount - useTimelineStore.getState().markers.length;
    reportTimelineResult(result, removedMarkers > 0
      ? msgf("m0481", [next.toFixed(2), removedMarkers])
      : msgf("m0480", [next.toFixed(2)]));
  };

  const startExport = async () => {
    if (isPreview || autoSaveInFlight.current || exportJobId !== null || !beginProjectOperation('exporting')) return;
    try {
      if (exportScope === 'range' && (rangeStart < 0 || rangeEnd <= rangeStart || rangeEnd > duration)) {
        setExportPollError(msg("m0461"));
        return;
      }
      const saved = await persistCurrentProject(msg("m0569"));
      if (!saved) return;
      const result = await exportAction.run(
        () => api.exportEditorProject(saved.id, {
          encoder: 'auto',
          quality: 80,
          ...(exportScope === 'range' ? {
            range_start_seconds: rangeStart,
            range_end_seconds: rangeEnd,
          } : {}),
        }),
        msg("m0459"),
      );
      if (result) {
        setExportJob(null);
        setExportPollError(null);
        setExportJobId(result.job_id);
      }
    } finally {
      finishProjectOperation('exporting');
    }
  };

  const cancelExport = async () => {
    if (!exportJobId) return;
    const result = await cancelExportAction.run(
      () => api.cancelExportJob(exportJobId),
      msg("m0538"),
    );
    if (result) setExportJob(result);
  };

  const openSnapshots = async () => {
    if (isPreview) return;
    if (snapshotListOpen) {
      setSnapshotListOpen(false);
      return;
    }
    setProjectListOpen(false);
    const result = await snapshotAction.run(
      () => api.listEditorSnapshots(activeProject.id),
    );
    if (result) {
      setSnapshots(result.items);
      setSnapshotListOpen(true);
    }
  };

  const restoreSnapshot = async (snapshotId: string) => {
    if (!beginProjectOperation('restoring')) return;
    try {
      if (confirmDiscardIfNeeded(null, msg("m0623")) !== 'proceed') return;
      const restored = await restoreAction.run(
        () => api.restoreEditorSnapshot(activeProject.id, snapshotId),
        msg("m0316"),
      );
      if (!restored) return;
      setProjects((items) => items.map((project) => project.id === restored.id ? restored : project));
      activateProject(restored, toStoreTracks(restored.tracks));
    } finally {
      finishProjectOperation('restoring');
    }
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (editorLocked || target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')) return;
      const state = useTimelineStore.getState();
      const primary = event.ctrlKey || event.metaKey;
      const key = event.key.toLocaleLowerCase();
      if (primary && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) state.redo(); else state.undo();
        return;
      }
      if (primary && key === 'y') {
        event.preventDefault();
        state.redo();
        return;
      }
      if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && state.selectedClipId) {
        event.preventDefault();
        reportTimelineResult(state.slipClip(
          state.selectedClipId,
          event.key === 'ArrowLeft' ? -0.1 : 0.1,
          sourceDurations,
        ), msg("m0545"));
        return;
      }
      if (primary || event.altKey) return;
      if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedClipId) {
        event.preventDefault();
        reportTimelineResult(state.removeClip(state.selectedClipId, state.ripple), state.ripple ? msg("m0958") : msg("m0957"));
      } else if (key === 'r') {
        event.preventDefault();
        state.toggleRipple();
      } else if (key === 'g') {
        event.preventDefault();
        reportTimelineResult(event.shiftKey ? state.ungroupSelected() : state.groupSelected(), event.shiftKey ? msg("m0535") : msg("m0515"));
      } else if (key === 'l') {
        event.preventDefault();
        reportTimelineResult(event.shiftKey ? state.unlinkSelected() : state.linkSelected(), event.shiftKey ? msg("m0536") : msg("m0547"));
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [editorLocked, reportTimelineResult, sourceDurations]);

  return (
    <div className="editor-shell">
      <header className="editor-header">
        <div className="editor-project-switcher">
          <Link className="back-button" to="/studio" aria-label={t('studio.back')}><ArrowLeft size={15} /><span>{t('production.editing')}</span></Link>
          <button type="button" className="back-button project-menu-button" onClick={() => { setSnapshotListOpen(false); setProjectListOpen((value) => !value); }} aria-expanded={projectListOpen}><Film size={15} /><span>{t('editor.projects')}</span></button>
          <div><input value={activeProject.name} disabled={editorLocked} onChange={(event) => setActiveProject((project) => ({ ...project, name: event.target.value }))} aria-label={msg("m0476")} /><span>{autoSaveState.status === 'saving' ? msg("m1092") : hasUnsavedChanges ? msg("m1064") : msgf("m0217", [savedRevision])}</span></div>
          <IconButton label={msg("m0815")} disabled={isPreview || editorLocked || snapshotAction.state.status === 'loading'} onClick={() => void openSnapshots()}>{snapshotAction.state.status === 'loading' ? <Spinner /> : <History size={15} />}</IconButton>
          {projectListOpen ? (
            <div className="project-popover">
              <header><strong>{t('editor.editingProjects')}</strong><Button size="sm" variant="primary" disabled={source !== 'service' || editorLocked} onClick={() => void newProject()}>{projectOperation === 'creating' ? <Spinner /> : <Plus size={13} />}{t('editor.new')}</Button></header>
              {projects.map((project) => {
                const selectable = true;
                return (
                  <div className={`project-popover__row${project.id === activeProject.id ? ' is-active' : ''}`} key={project.id}>
                    <input
                      type="checkbox"
                      aria-label={msgf("m1229", [project.name])}
                      disabled={!selectable || editorLocked}
                      checked={selectedProjectIds.includes(project.id)}
                      onChange={(event) => setSelectedProjectIds((ids) => event.target.checked
                        ? [...new Set([...ids, project.id])]
                        : ids.filter((id) => id !== project.id))}
                    />
                    <button type="button" disabled={editorLocked} onClick={() => openProject(project)}>
                      <span className="project-thumb"><Film size={17} /></span>
                      <span><strong>{project.name}{isEditorTemplate(project) ? msg("m0009") : ''}</strong><small>{project.width}×{project.height} · {project.duration_seconds.toFixed(1)}s</small></span>
                      {project.id === activeProject.id ? <Check size={14} /> : <ChevronRight size={14} />}
                    </button>
                    {isEditorTemplate(project) ? <IconButton label={msgf("m0189", [project.name])} disabled={editorLocked} onClick={() => void createFromTemplate(project)}><Copy size={13} /></IconButton> : null}
                  </div>
                );
              })}
              <footer>
                <small>{msg("m0422")}</small>
                <Button size="sm" variant="danger" disabled={editorLocked || selectedProjectIds.length === 0} onClick={() => void deleteSelectedProjects()}>
                  {projectOperation === 'deleting' ? <Spinner /> : <Trash2 size={13} />}{msg("m0289")}
                </Button>
              </footer>
            </div>
          ) : null}
          {snapshotListOpen ? <div className="project-popover project-history-popover"><header><strong>{msg("m0315")}</strong><Badge tone="neutral">{snapshots.length}</Badge></header>{snapshots.length > 0 ? snapshots.map((snapshot) => <button type="button" key={snapshot.id} disabled={editorLocked} onClick={() => void restoreSnapshot(snapshot.id)}><span className="project-thumb"><History size={16} /></span><span><strong>{msg("m0216")} {snapshot.revision} · {snapshot.name}</strong><small>{new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'short', timeStyle: 'short' }).format(new Date(snapshot.created_at))}</small></span><ChevronRight size={14} /></button>) : <div className="project-history-empty">{msg("m0211")}</div>}</div> : null}
        </div>
        <div className="editor-header__center"><Badge tone="neutral">{activeProject.width} × {activeProject.height}</Badge><Badge tone="neutral">{activeProject.fps} FPS</Badge><Badge tone={source === 'service' ? 'success' : 'warning'}>{source === 'service' ? t('editor.serviceConnected') : source === 'loading' ? t('common.loading') : t('common.unavailable')}</Badge></div>
        <div className="editor-header__actions"><Button size="sm" disabled={source !== 'service' || editorLocked} onClick={() => void choosePackageImport()}>{projectOperation === 'importing' ? <Spinner /> : <FolderOpen size={14} />}{t('editor.importPackage')}</Button><Button size="sm" disabled={isPreview || editorLocked} onClick={() => void duplicateProject(false)}><Copy size={14} />{t('editor.duplicateProject')}</Button><Button size="sm" disabled={isPreview || editorLocked} title={msgf("m0521", [templates.length])} onClick={() => void duplicateProject(true)}><LayoutTemplate size={14} />{t('editor.saveTemplate')}</Button><Button size="sm" disabled={isPreview || editorLocked || autoSaveInFlight.current} onClick={() => void exportPackage()}>{projectOperation === 'packaging' ? <Spinner /> : <Archive size={14} />}{t('editor.projectPackage')}</Button><Button size="sm" disabled={isPreview || editorLocked || autoSaveInFlight.current || !hasUnsavedChanges} onClick={() => void saveProject()}>{projectOperation === 'saving' ? <Spinner /> : <Save size={14} />}{projectOperation === 'saving' ? msg("m0210") : t('common.save')}</Button><Button size="sm" variant="primary" disabled={isPreview || editorLocked || autoSaveInFlight.current || exportJobId !== null} onClick={() => void startExport()}>{projectOperation === 'exporting' ? <Spinner /> : <Download size={14} />}{exportJobId ? msg("m0457") : projectOperation === 'exporting' ? msg("m0212") : t('editor.export')}</Button></div>
      </header>

      <div className="editor-status-stack">
        {source !== 'service' ? <Notice className="editor-notice" tone={source === 'loading' ? 'info' : 'warning'}>{source === 'loading' ? t('common.loading') : error ?? t('common.unavailable')}</Notice> : null}
        {autoSaveState.message ? <Notice className="editor-notice" tone={autoSaveState.status === 'error' || autoSaveState.status === 'conflict' ? 'danger' : autoSaveState.status === 'saving' ? 'info' : 'success'}>{autoSaveState.message}{autoSaveState.status === 'error' ? <Button size="sm" onClick={() => { setAutoSaveState({ status: 'idle', message: null }); setAutoSaveRetry((value) => value + 1); }}><RefreshCw size={12} />{msg("m1268")}</Button> : null}{autoSaveState.status === 'conflict' ? <Button size="sm" variant="danger" disabled={projectOperation === 'reloading'} onClick={() => void reloadServerProject()}>{projectOperation === 'reloading' ? <Spinner /> : <RefreshCw size={12} />}{projectOperation === 'reloading' ? msg("m1175") : msg("m1177")}</Button> : null}</Notice> : null}
        {saveAction.state.message ? <Notice className="editor-notice" tone={saveAction.state.status === 'error' ? 'danger' : 'success'}>{saveAction.state.message}</Notice> : null}
        {createAction.state.message ? <Notice className="editor-notice" tone={createAction.state.status === 'error' ? 'danger' : 'success'}>{createAction.state.message}</Notice> : null}
        {duplicateAction.state.message ? <Notice className="editor-notice" tone={duplicateAction.state.status === 'error' ? 'danger' : 'success'}>{duplicateAction.state.message}</Notice> : null}
        {uploadAction.state.message ? <Notice className="editor-notice" tone={uploadAction.state.status === 'error' ? 'danger' : 'success'}>{uploadAction.state.message}</Notice> : null}
        {exportAction.state.message ? <Notice className="editor-notice" tone={exportAction.state.status === 'error' ? 'danger' : 'success'}>{exportAction.state.message}</Notice> : null}
        {cancelExportAction.state.message ? <Notice className="editor-notice" tone={cancelExportAction.state.status === 'error' ? 'danger' : 'success'}>{cancelExportAction.state.message}</Notice> : null}
        {snapshotAction.state.message ? <Notice className="editor-notice" tone={snapshotAction.state.status === 'error' ? 'danger' : 'success'}>{snapshotAction.state.message}</Notice> : null}
        {restoreAction.state.message ? <Notice className="editor-notice" tone={restoreAction.state.status === 'error' ? 'danger' : 'success'}>{restoreAction.state.message}</Notice> : null}
        {relinkAction.state.message ? <Notice className="editor-notice" tone={relinkAction.state.status === 'error' ? 'danger' : 'success'}>{relinkAction.state.message}</Notice> : null}
        {proxyAction.state.message ? <Notice className="editor-notice" tone={proxyAction.state.status === 'error' ? 'danger' : 'success'}>{proxyAction.state.message}</Notice> : null}
        {extractAudioAction.state.message ? <Notice className="editor-notice" tone={extractAudioAction.state.status === 'error' ? 'danger' : 'success'}>{extractAudioAction.state.message}</Notice> : null}
        {packageExportAction.state.message ? <Notice className="editor-notice" tone={packageExportAction.state.status === 'error' ? 'danger' : 'success'}>{packageExportAction.state.message}</Notice> : null}
        {packageImportAction.state.message ? <Notice className="editor-notice" tone={packageImportAction.state.status === 'error' ? 'danger' : 'success'}>{packageImportAction.state.message}</Notice> : null}
        {presetMutationAction.state.message ? <Notice className="editor-notice" tone={presetMutationAction.state.status === 'error' ? 'danger' : 'success'}>{presetMutationAction.state.message}</Notice> : null}
        {presetApplyAction.state.message ? <Notice className="editor-notice" tone={presetApplyAction.state.status === 'error' ? 'danger' : 'success'}>{presetApplyAction.state.message}</Notice> : null}
        {presetDeleteAction.state.message ? <Notice className="editor-notice" tone={presetDeleteAction.state.status === 'error' ? 'danger' : 'success'}>{presetDeleteAction.state.message}</Notice> : null}
        {projectDeleteAction.state.message ? <Notice className="editor-notice" tone={projectDeleteAction.state.status === 'error' ? 'danger' : 'success'}>{projectDeleteAction.state.message}</Notice> : null}
        {timelineNotice ? <Notice className="editor-notice" tone="info"><span aria-live="polite">{timelineNotice}</span><IconButton label={msg("m0246")} onClick={() => setTimelineNotice(null)}><Trash2 size={11} /></IconButton></Notice> : null}
        {exportPollError ? <Notice className="editor-notice" tone="warning">{exportPollError}{msg("m1335")}</Notice> : null}
        {exportJob ? <div className="editor-export-progress" aria-live="polite"><span>{exportJob.job.status}</span><div><i style={{ width: `${Math.max(0, Math.min(100, exportJob.job.progress * 100))}%` }} /></div><strong>{Math.round(exportJob.job.progress * 100)}%</strong><small>{exportJob.job.error ?? (exportJob.job.output_path || msg("m0794"))}</small>{exportJobId ? <Button size="sm" variant="danger" disabled={cancelExportAction.state.status === 'loading'} onClick={() => void cancelExport()}>{cancelExportAction.state.status === 'loading' ? <Spinner /> : <Pause size={12} />}{msg("m0325")}</Button> : null}</div> : null}
      </div>

      <div className="editor-top" inert={editorLocked ? true : undefined} aria-busy={editorLocked}>
        <aside className="media-bin editor-panel">
          <input ref={fileInput} className="visually-hidden" type="file" multiple accept="video/*,audio/*,image/*" onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void importFiles(files); }} />
          <input ref={replacementInput} className="visually-hidden" type="file" accept="video/*,audio/*,image/*" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void replaceAssetFile(file); }} />
          <input ref={packageInput} className="visually-hidden" type="file" accept=".vcep,application/zip" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void performPackageImport(() => api.uploadEditorPackage(file)); }} />
          <input ref={fontInput} className="visually-hidden" type="file" accept=".ttf,.otf,font/ttf,font/otf" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void importCustomFont(file); }} />
          <header className="editor-panel__header"><div><Layers3 size={15} /><strong>{t('editor.media')}</strong></div><IconButton label={t('common.import')} disabled={isPreview || uploadAction.state.status === 'loading'} onClick={() => fileInput.current?.click()}>{uploadAction.state.status === 'loading' ? <Spinner /> : <Upload size={14} />}</IconButton></header>
          <div className="media-tabs"><button type="button" className="is-active" aria-pressed="true">{t('editor.assets')}</button><button type="button" onClick={appendText}>{t('editor.addText')}</button><button type="button" disabled title={msg("m1235")}>{msg("m0680")}</button></div>
          <div className="material-search"><Search size={14} /><input value={mediaQuery} onChange={(event) => setMediaQuery(event.target.value)} placeholder={t('editor.searchMedia')} /></div>
          <div className="media-actions"><Button size="sm" disabled={isPreview || uploadAction.state.status === 'loading'} onClick={() => fileInput.current?.click()}><Upload size={13} />{t('common.import')}</Button><Button size="sm" variant={recordingVoice ? 'danger' : 'secondary'} disabled={isPreview || uploadAction.state.status === 'loading'} onClick={() => void toggleVoiceRecording()}><Mic size={13} />{recordingVoice ? t('editor.stopVoice') : t('editor.recordVoice')}</Button><Button size="sm" onClick={() => setMediaQuery('')}><Link2 size={13} />{t('editor.allMedia')}</Button></div>
          <div className="media-grid">
            {filteredMedia.map((item, index) => <article key={item.id}><button type="button" className={`media-grid__thumb material-thumb--${['amber', 'rose', 'blue', 'violet'][index % 4]}`} onDoubleClick={() => appendMedia(index)}>{item.kind === 'audio' ? <Music2 size={18} /> : item.kind === 'image' ? <Image size={18} /> : <Video size={18} />}<span>{item.duration.toFixed(1)}s</span></button><strong>{item.name}</strong><small>{item.asset ? item.asset.proxy_status.status === 'ready' ? msg("m0193") : item.asset.proxy_status.status === 'generating' ? msg("m0858") : item.asset.proxy_status.status === 'failed' ? msg("m0192") : item.detail : item.detail}</small><div className="media-grid__item-actions"><IconButton label={msg("m0921")} onClick={() => appendMedia(index)}><Plus size={12} /></IconButton>{item.asset ? <IconButton label={msgf("m1265", [item.name])} disabled={item.asset.proxy_status.status === 'generating' || relinkAction.state.status === 'loading'} onClick={() => void relinkAsset(item.asset!)}><Link2 size={12} /></IconButton> : null}{item.asset && item.kind === 'video' ? <IconButton label={msgf("m0090", [item.asset.proxy_status.status === 'failed' ? msg("m1268") : msg("m1341"), item.name])} disabled={item.asset.proxy_status.status === 'generating' || proxyAction.state.status === 'loading'} onClick={() => void generateProxy(item.asset!)}><RefreshCw size={12} /></IconButton> : null}</div></article>)}
          </div>
        </aside>

        <section className="preview-panel editor-panel">
          <header className="editor-panel__header"><div><MousePointer2 size={15} /><strong>{t('editor.programMonitor')}</strong></div><div><Badge tone="neutral">{visualPreviewLayers.length} {msg("m0471")}</Badge><IconButton label={msg("m0228")} disabled><Maximize2 size={14} /></IconButton></div></header>
          <div className="program-monitor">
            <div className="program-monitor__frame">
              {visualPreviewLayers.length > 0 ? visualPreviewLayers.map((layer) => (
                <ProgramPreview
                  key={layer.clip.id}
                  projectName={activeProject.name}
                  clip={layer.clip}
                  media={layer.media}
                  localTime={layer.localTime}
                  automation={layer.automation}
                  playing={playing}
                />
              )) : (
                <ProgramPreview projectName={activeProject.name} clip={null} media={null} localTime={0} automation={null} playing={false} />
              )}
              {audioPreviewLayers.map((layer) => (
                <TimelineAudioPreview
                  key={layer.clip.id}
                  clip={layer.clip}
                  media={layer.media}
                  localTime={layer.localTime}
                  volume={layer.automation.volume}
                  playing={playing}
                />
              ))}
            </div>
          </div>
          <div className="preview-transport"><span>{formatTimelineTime(playhead, activeProject.fps)}</span><div><IconButton label={msg("m0133")} onClick={() => setPlayhead(playhead - 1 / activeProject.fps)}><SkipBack size={14} /></IconButton><IconButton className="transport-play" label={playing ? msg("m0730") : msg("m0674")} onClick={() => setPlaying((value) => !value)}>{playing ? <Pause size={16} /> : <Play size={16} fill="currentColor" />}</IconButton><IconButton label={msg("m0139")} onClick={() => setPlayhead(playhead + 1 / activeProject.fps)}><SkipForward size={14} /></IconButton></div><span>{formatTimelineTime(duration, activeProject.fps)}</span></div>
        </section>

        <aside className="property-panel editor-panel">
          <header className="editor-panel__header"><div><SlidersHorizontal size={15} /><strong>{t('editor.properties')}</strong></div><Badge tone="neutral">{selectedClip ? msg("m0952") : msg("m0474")}</Badge></header>
          {selectedClip ? (
            <>
              <div className="property-tabs">
                {(['clip', 'color', 'audio', 'preset'] as const).map((value) => <button type="button" key={value} className={inspectorTab === value ? 'is-active' : undefined} onClick={() => setInspectorTab(value)}>{value === 'clip' ? msg("m0952") : value === 'color' ? msg("m1155") : value === 'audio' ? msg("m1300") : msg("m1313")}</button>)}
              </div>
              <div className="property-scroll">
                {inspectorTab === 'clip' ? (
                  <>
                    <Field label={msg("m0359")}><TextInput value={selectedClip.name} onChange={(event) => updateClip(selectedClip.id, { name: event.target.value })} /></Field>
                    {selectedTrack ? <Field label={msg("m1172")}><select value={selectedTrack.id} onChange={(event) => reportTimelineResult(moveClip(selectedClip.id, event.target.value, selectedClip.start, ripple), msg("m0962"))}>{tracks.filter((track) => track.kind === selectedTrack.kind).map((track) => <option key={track.id} value={track.id} disabled={track.locked}>{track.name}{track.locked ? msg("m1333") : ''}</option>)}</select></Field> : null}
                    {!selectedClip.text ? <div className="field-row"><Button size="sm" disabled={selectedTrack?.locked} onClick={() => slipSelected(-0.1)}>{msg("m0940")}</Button><Button size="sm" disabled={selectedTrack?.locked} onClick={() => slipSelected(0.1)}>{msg("m0939")}</Button></div> : null}
                    {selectedClip.text ? <PropertyGroup icon={<Type size={14} />} title={msg("m0690")}><Field label={msg("m0249")}><TextInput value={selectedClip.text.content} maxLength={1_000} onChange={(event) => updateClip(selectedClip.id, { text: { ...selectedClip.text!, content: event.target.value } })} /></Field><div className="field-row"><Field label={msg("m0437")}><TextInput type="number" min="6" max="512" value={selectedClip.text.font_size} onChange={(event) => updateClip(selectedClip.id, { text: { ...selectedClip.text!, font_size: Number(event.target.value) } })} /></Field><Field label={msg("m0453")}><select value={selectedClip.text.align} onChange={(event) => updateClip(selectedClip.id, { text: { ...selectedClip.text!, align: event.target.value } })}><option value="left">{msg("m0485")}</option><option value="center">{msg("m0472")}</option><option value="right">{msg("m0352")}</option></select></Field></div><div className="field-row"><Field label={msg("m0692")}><input type="color" value={selectedClip.text.color.slice(0, 7)} onChange={(event) => updateClip(selectedClip.id, { text: { ...selectedClip.text!, color: event.target.value.toUpperCase() } })} /></Field><Field label={msg("m1091")}><input type="color" value={(selectedClip.text.background ?? '#000000').slice(0, 7)} onChange={(event) => updateClip(selectedClip.id, { text: { ...selectedClip.text!, background: event.target.value.toUpperCase() } })} /></Field></div><Button size="sm" disabled={isPreview || uploadAction.state.status === 'loading'} onClick={() => fontInput.current?.click()}><Type size={12} />{selectedClip.text.font_asset_id ? t('editor.replaceFont') : t('editor.importFont')}</Button></PropertyGroup> : null}
                    <div className="field-row">
                      <Field label={msg("m0557")}><div className="number-control"><input type="number" value={selectedClip.start.toFixed(2)} min="0" max={Math.max(0, MAX_EDITOR_TIMELINE_SECONDS - selectedClip.duration)} step="0.1" onChange={(event) => updateSelectedStart(Number(event.target.value))} /><span>s</span></div></Field>
                      <Field label={msg("m0715")}><div className="number-control"><input type="number" disabled={(selectedClip.speedSegments?.length ?? 0) > 0} title={(selectedClip.speedSegments?.length ?? 0) > 0 ? msg("m0273") : undefined} value={selectedClip.duration.toFixed(2)} min="0.1" max={Math.max(0.1, MAX_EDITOR_TIMELINE_SECONDS - selectedClip.start)} step="0.1" onChange={(event) => updateSelectedDuration(Number(event.target.value))} /><span>s</span></div></Field>
                    </div>
                    {!selectedClip.text ? <div className="field-row"><Field label={msg("m0936")}><div className="number-control"><input type="number" disabled={(selectedClip.speedSegments?.length ?? 0) > 0} min="0" max={Math.max(0, (selectedSourceDuration ?? selectedClip.sourceOut) - selectedClip.duration * selectedClip.speed)} value={selectedClip.sourceIn.toFixed(2)} step="0.05" onChange={(event) => updateSelectedSourceIn(Number(event.target.value))} /><span>s</span></div></Field><Field label={msg("m0937")}><div className="number-control"><input type="number" disabled={(selectedClip.speedSegments?.length ?? 0) > 0} min={selectedClip.sourceIn + 0.05} max={selectedSourceDuration} value={selectedClip.sourceOut.toFixed(2)} step="0.05" onChange={(event) => updateSelectedSourceOut(Number(event.target.value))} /><span>s</span></div></Field></div> : null}
                    <PropertyGroup icon={<Maximize2 size={14} />} title={msg("m0336")}>
                      <div className="field-row"><Field label="X"><TextInput type="number" value={selectedTransform.x} onChange={(event) => updateSelectedTransform({ x: Number(event.target.value) })} /></Field><Field label="Y"><TextInput type="number" value={selectedTransform.y} onChange={(event) => updateSelectedTransform({ y: Number(event.target.value) })} /></Field></div>
                      {!selectedClip.text ? <><Field label={msg("m0702")}><TextInput type="number" value={selectedTransform.rotation} onChange={(event) => updateSelectedTransform({ rotation: Number(event.target.value) })} /></Field><Field label={msg("m1087")}><input type="range" min="25" max="200" value={Math.round(selectedTransform.scale_x * 100)} onChange={(event) => { const scale = Number(event.target.value) / 100; updateSelectedTransform({ scale_x: scale, scale_y: scale }); }} /></Field></> : null}
                      <Field label={msg("m0152")}><input type="range" min="0" max="100" value={Math.round(selectedTransform.opacity * 100)} onChange={(event) => updateSelectedTransform({ opacity: Number(event.target.value) / 100 })} /></Field>
                    </PropertyGroup>
                    {!selectedClip.text ? (
                      <PropertyGroup icon={<WandSparkles size={14} />} title={msg("m1246")}>
                        <Field label={msg("m0677")}>
                          <select disabled={(selectedClip.speedSegments?.length ?? 0) > 0} value={selectedClip.speed} onChange={(event) => updateSelectedBaseSpeed(Number(event.target.value))}>
                            <option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1">1.0×</option><option value="1.5">1.5×</option><option value="2">2.0×</option>
                          </select>
                        </Field>
                        <div className="speed-ramp-actions">
                          <Button size="sm" disabled={(selectedClip.speedSegments?.length ?? 0) > 0 || selectedMedia?.kind === 'image'} title={selectedMedia?.kind === 'image' ? msg("m1292") : undefined} onClick={createTwoSegmentRamp}>{msg("m0282")}</Button>
                          <Button size="sm" disabled={(selectedClip.speedSegments?.length ?? 0) === 0} onClick={clearSpeedRamp}>{msg("m0931")}</Button>
                        </div>
                        {(selectedClip.speedSegments ?? []).map((segment, index) => (
                          <Field key={segment.id} label={msgf("m0271", [index + 1, segment.start.toFixed(2), segment.end.toFixed(2)])}>
                            <div className="number-control"><input type="number" disabled={selectedMedia?.kind === 'image'} min="0.05" max="16" step="0.05" value={segment.speed} onChange={(event) => updateSpeedSegment(segment.id, Number(event.target.value))} /><span>×</span></div>
                          </Field>
                        ))}
                        {selectedMedia?.kind === 'image' ? <Notice tone="warning">{msg("m1295")}</Notice> : (selectedClip.speedSegments?.length ?? 0) > 0 ? <Notice tone="info">{msg("m0272")}</Notice> : null}
                        <div className="field-row"><Field label={msg("m1205")}><select value={selectedClip.transitionIn ?? 'none'} onChange={(event) => updateClip(selectedClip.id, { transitionIn: event.target.value === 'none' ? null : event.target.value })}>{EDITOR_TRANSITIONS.map((transition) => <option key={transition} value={transition}>{transition === 'none' ? msg("m0703") : transition}</option>)}</select></Field><Field label={msg("m1043")}><select value={selectedClip.transitionOut ?? 'none'} onChange={(event) => updateClip(selectedClip.id, { transitionOut: event.target.value === 'none' ? null : event.target.value })}>{EDITOR_TRANSITIONS.map((transition) => <option key={transition} value={transition}>{transition === 'none' ? msg("m0703") : transition}</option>)}</select></Field></div>
                      </PropertyGroup>
                    ) : null}
                    <PropertyGroup icon={<Flag size={14} />} title={msg("m1073")}>
                      <Field label={msg("m0473")}><select value={activeKeyframeProperty} onChange={(event) => setKeyframeProperty(event.target.value as TimelineKeyframeProperty)}>{keyframeProperties.map((property) => <option key={property} value={property}>{property}</option>)}</select></Field>
                      <div className="keyframe-write-row">
                        <input
                          key={`${selectedClip.id}-${activeKeyframeProperty}-${selectedLocalTime.toFixed(3)}-${previewAutomation?.[activeKeyframeProperty] ?? 0}`}
                          ref={keyframeValueInput}
                          type="number"
                          step="0.01"
                          defaultValue={previewAutomation?.[activeKeyframeProperty] ?? 0}
                          aria-label={msg("m0240")}
                          className="text-input"
                        />
                        <Button size="sm" onClick={writeKeyframe}>{msg("m0384")} {selectedLocalTime.toFixed(2)}{msg("m0088")}</Button>
                      </div>
                      <div className="keyframe-list">
                        {(selectedClip.keyframes ?? []).filter((keyframe) => keyframe.property === activeKeyframeProperty).map((keyframe) => (
                          <div key={keyframe.id}><button type="button" onClick={() => setPlayhead(selectedClip.start + keyframe.time)}>{keyframe.time.toFixed(2)}s · {keyframe.value.toFixed(2)}</button><IconButton label={msgf("m0287", [keyframe.time.toFixed(2)])} onClick={() => reportTimelineResult(removeKeyframe(selectedClip.id, keyframe.id), msg("m0243"))}><Trash2 size={11} /></IconButton></div>
                        ))}
                      </div>
                      <small>{selectedClip.keyframes?.length ?? 0} {msg("m0014")}</small>
                      {(selectedClip.keyframes ?? []).some((keyframe) => keyframe.property === 'rotation') && (selectedClip.keyframes ?? []).some((keyframe) => keyframe.property === 'scale_x' || keyframe.property === 'scale_y') ? <Notice tone="warning">{msg("m0307")}</Notice> : null}
                    </PropertyGroup>
                  </>
                ) : null}
                {inspectorTab === 'color' ? selectedTrack?.kind === 'audio' || selectedClip.text ? <Notice tone="info">{msg("m1156")}</Notice> : <PropertyGroup icon={<SlidersHorizontal size={14} />} title={msg("m0407")}><Field label={msgf("m0179", [selectedColor.brightness.toFixed(2)])}><input type="range" min="-100" max="100" value={Math.round(selectedColor.brightness * 100)} onChange={(event) => updateSelectedColor({ brightness: Number(event.target.value) / 100 })} /></Field><Field label={msgf("m0452", [selectedColor.contrast.toFixed(2)])}><input type="range" min="0" max="300" value={Math.round(selectedColor.contrast * 100)} onChange={(event) => updateSelectedColor({ contrast: Number(event.target.value) / 100 })} /></Field><Field label={msgf("m1321", [selectedColor.saturation.toFixed(2)])}><input type="range" min="0" max="300" value={Math.round(selectedColor.saturation * 100)} onChange={(event) => updateSelectedColor({ saturation: Number(event.target.value) / 100 })} /></Field><Button size="sm" onClick={() => updateSelectedColor(defaultColorAdjust)}>{msg("m1267")}</Button></PropertyGroup> : null}
                {inspectorTab === 'audio' ? <PropertyGroup icon={<Volume2 size={14} />} title={msg("m1299")}><Field label={msgf("m0968", [Math.round(selectedClip.volume * 100)])}><input type="range" min="0" max="200" value={Math.round(selectedClip.volume * 100)} onChange={(event) => updateClip(selectedClip.id, { volume: Number(event.target.value) / 100 })} /></Field>{selectedClip.assetId && waveforms[selectedClip.assetId] && selectedMedia?.streamUrl ? <div className="inspector-waveform"><EditorWaveform url={apiMediaUrl(selectedMedia.streamUrl)} peaks={waveforms[selectedClip.assetId] ?? []} duration={selectedMedia.duration} currentTime={selectedClip.sourceIn + sourceOffsetAt(selectedClip, selectedLocalTime)} onSeek={(sourceTime) => setPlayhead(selectedClip.start + localTimeAtSource(selectedClip, sourceTime))} /></div> : <Notice tone="info">{msg("m0362")}</Notice>}{selectedMedia?.asset?.kind.startsWith('video') && selectedMedia.asset.has_audio ? <><Button size="sm" disabled={extractAudioAction.state.status === 'loading' || selectedClipHasSeparatedAudio} title={selectedClipHasSeparatedAudio ? msg("m1124") : undefined} onClick={() => void extractSelectedAudio()}>{extractAudioAction.state.status === 'loading' ? <Spinner /> : <Music2 size={12} />}{selectedClipHasSeparatedAudio ? msg("m0496") : t('editor.detachAudio')}</Button>{selectedClipHasSeparatedAudio ? <Notice tone="info">{msg("m0977")}</Notice> : null}</> : null}</PropertyGroup> : null}
                {inspectorTab === 'preset' ? (
                  <PropertyGroup icon={<Archive size={14} />} title={msg("m0970")}>
                    <Field label={msg("m1313")}><select value={selectedPresetId ?? ''} onChange={(event) => { const next = presets.find((preset) => preset.id === event.target.value); setSelectedPresetId(next?.id ?? null); if (next) setPresetName(next.name); }}><option value="">{msg("m1242")}</option>{presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name} · r{preset.revision}</option>)}</select></Field>
                    <Field label={msg("m0359")}><TextInput maxLength={100} value={presetName} onChange={(event) => setPresetName(event.target.value)} /></Field>
                    <Notice tone="info">{msg("m0338")}</Notice>
                    {selectedPresetCompatibility ? <Notice tone="warning">{selectedPresetCompatibility}</Notice> : null}
                    <div className="preset-actions">
                      <Button size="sm" disabled={source !== 'service' || presetMutationAction.state.status === 'loading' || presetName.trim().length === 0} onClick={() => void createPresetFromSelection()}>{presetMutationAction.state.status === 'loading' ? <Spinner /> : <Plus size={12} />}{msg("m0695")}</Button>
                      <Button size="sm" disabled={!selectedPreset || presetMutationAction.state.status === 'loading'} onClick={() => void updatePresetFromSelection()}>{msg("m0732")}{selectedPreset?.revision ?? '—'}</Button>
                      <Button size="sm" variant="primary" disabled={!selectedPreset || isPreview || editorLocked || selectedPresetCompatibility !== null} title={selectedPresetCompatibility ?? undefined} onClick={() => void applySelectedPreset()}>{msg("m0318")}</Button>
                      <Button size="sm" variant="danger" disabled={!selectedPreset || presetDeleteAction.state.status === 'loading'} onClick={() => void deleteSelectedPreset()}><Trash2 size={12} />{msg("m0284")}</Button>
                    </div>
                  </PropertyGroup>
                ) : null}
              </div>
            </>
          ) : <div className="property-scroll"><EmptyState icon={<MousePointer2 size={22} />} title={msg("m0770")} description={msg("m0389")} /><PropertyGroup icon={<Clock3 size={14} />} title={msg("m0483")}><Field label={msg("m0478")}><div className="number-control"><input type="number" min={timelineContentEnd} max={MAX_EDITOR_TIMELINE_SECONDS} step="0.1" value={duration.toFixed(2)} onChange={(event) => updateProjectDurationFromInput(Number(event.target.value))} /><span>s</span></div></Field><Notice tone="info">{msg("m0479")}</Notice></PropertyGroup></div>}
        </aside>
      </div>

      <section className="timeline-panel editor-panel" inert={editorLocked ? true : undefined} aria-busy={editorLocked} aria-describedby="timeline-shortcuts">
        <p className="visually-hidden" id="timeline-shortcuts">{msg("m0719")}</p>
        <header className="timeline-toolbar">
          <div className="timeline-tools">
            <IconButton label={msg("m0673")} disabled={past.length === 0} onClick={undo}><Undo2 size={14} /></IconButton>
            <IconButton label={msg("m1261")} disabled={future.length === 0} onClick={redo}><Redo2 size={14} /></IconButton>
            <span />
            <IconButton label={msg("m1231")} className="is-active" aria-pressed="true"><MousePointer2 size={14} /></IconButton>
            <IconButton label={msg("m0387")} disabled={!selectedClip || selectedTrack?.locked} onClick={() => selectedClip && reportTimelineResult(splitClip(selectedClip.id, playhead), msg("m0960"))}><Scissors size={14} /></IconButton>
            <IconButton label={msg("m0414")} disabled={!selectedClip || selectedTrack?.locked} onClick={duplicateSelectedClip}><Copy size={14} /></IconButton>
            <IconButton label={msgf("m0291", [ripple ? msg("m1342") : ''])} disabled={!selectedClip || selectedTrack?.locked} onClick={() => selectedClip && reportTimelineResult(removeClip(selectedClip.id, ripple), ripple ? msg("m0959") : msg("m0957"))}><SplitSquareHorizontal size={14} /></IconButton>
            <Button size="sm" disabled={selectedClipIds.length < 2} onClick={() => reportTimelineResult(groupSelected(), msg("m0515"))}>{t('editor.group')}</Button>
            <Button size="sm" disabled={selectedClipIds.length === 0} onClick={() => reportTimelineResult(ungroupSelected(), msg("m0535"))}>{t('editor.ungroup')}</Button>
            <Button size="sm" disabled={selectedClipIds.length < 2} onClick={() => reportTimelineResult(linkSelected(), msg("m0547"))}>{t('editor.link')}</Button>
            <Button size="sm" disabled={selectedClipIds.length === 0} onClick={() => reportTimelineResult(unlinkSelected(), msg("m0536"))}>{t('editor.unlink')}</Button>
            <span />
            <IconButton label={msg("m0366")} className={snapping ? 'is-active' : undefined} aria-pressed={snapping} onClick={toggleSnapping}><Magnet size={14} /></IconButton>
            <Button size="sm" className={ripple ? 'is-active' : undefined} aria-pressed={ripple} onClick={toggleRipple}>{t('editor.ripple')} {ripple ? 'ON' : 'OFF'}</Button>
            <IconButton label={msg("m0388")} disabled={duration <= 0} onClick={addMarker}><Flag size={14} /></IconButton>
            <Button size="sm" onClick={() => setMarkerListOpen((value) => !value)} aria-expanded={markerListOpen}>{t('editor.markers')} {markers.length}</Button>
          </div>
          <div className="timeline-timecode"><strong>{formatTimelineTime(playhead, activeProject.fps)}</strong><span>/ {formatTimelineTime(duration, activeProject.fps)}</span></div>
          <div className="timeline-zoom"><select value={exportScope} aria-label={t('editor.exportRange')} onChange={(event) => { const scope = event.target.value as 'full' | 'range'; setExportScope(scope); if (scope === 'range') { setRangeStart(playhead); setRangeEnd(Math.min(duration, Math.max(playhead + 1, rangeEnd))); } }}><option value="full">{t('editor.exportFull')}</option><option value="range">{t('editor.exportRange')}</option></select>{exportScope === 'range' ? <><input className="range-time-input" type="number" min="0" max={rangeEnd} step="0.1" value={rangeStart} aria-label={msg("m0462")} onChange={(event) => setRangeStart(boundedTimelineValue(Number(event.target.value), rangeStart, 0, Math.max(0, Math.min(duration, rangeEnd))))} /><span>–</span><input className="range-time-input" type="number" min={rangeStart} max={duration} step="0.1" value={rangeEnd} aria-label={msg("m0460")} onChange={(event) => setRangeEnd(boundedTimelineValue(Number(event.target.value), rangeEnd, rangeStart, duration))} /></> : null}<ZoomOut size={13} /><input type="range" min="0.5" max="3" step="0.1" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} aria-label={msg("m0721")} /><ZoomIn size={13} /></div>
        </header>
        {markerListOpen ? <div className="timeline-marker-popover"><header><strong>{msg("m0720")}</strong><Badge tone="neutral">{markers.length}</Badge></header>{markers.length > 0 ? markers.map((marker) => <div key={marker.id}><button type="button" onClick={() => { setPlayhead(marker.time); setMarkerListOpen(false); }}><i style={{ background: marker.color }} /><span><strong>{marker.label}</strong><small>{formatTimelineTime(marker.time, activeProject.fps)}</small></span></button><IconButton label={msgf("m0285", [marker.label])} onClick={() => removeMarker(marker.id)}><Trash2 size={12} /></IconButton></div>) : <p>{msg("m1047")}</p>}</div> : null}
        <div className="timeline-scroll timeline-scroll--editor-library">
          <div className="timeline-track-headers" style={{ gridTemplateRows: `32px 30px repeat(${tracks.length}, 54px)` }}>
            <div className="timeline-ruler-corner">TRACKS</div>
            <div className="timeline-events-header"><span className="track-kind"><Flag size={13} /></span><span><strong>{msg("m0720")}</strong><small>{markers.length + killAxisEvents.length} events</small></span></div>
            {tracks.map((track) => <div key={track.id}><span className={`track-kind track-kind--${track.kind}`}>{track.kind === 'video' ? <Video size={13} /> : track.kind === 'audio' ? <Music2 size={13} /> : track.kind === 'text' ? <Type size={13} /> : <Image size={13} />}</span><span><strong>{track.name}</strong><small>{track.clips.length} clips</small></span><IconButton label={msgf("m0089", [track.locked ? msg("m1343") : msg("m1344"), track.name])} className={track.locked ? 'is-active' : undefined} aria-pressed={track.locked} onClick={() => toggleTrackLock(track.id)}><Lock size={12} /></IconButton></div>)}
          </div>
          <EditorTimeline
            tracks={tracks}
            markers={markers}
            killEvents={killAxisEvents}
            selectedClipIds={selectedClipIds}
            playhead={playhead}
            duration={duration}
            zoom={zoom}
            snapping={snapping}
            disabled={editorLocked}
            waveforms={waveforms}
            onSeek={(time) => setPlayhead(snapTime(time))}
            onSelectClip={selectClip}
            onMoveClip={(clipId, trackId, start) => {
              reportTimelineResult(moveClip(clipId, trackId, snapTime(start, clipId), ripple), ripple ? msg("m0512") : undefined);
            }}
            onResizeClip={resizeTimelineClip}
          />
        </div>
      </section>
    </div>
  );
}

function PropertyGroup({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return <section className="property-group"><button type="button" onClick={() => setOpen((value) => !value)}><span>{icon}<strong>{title}</strong></span><ChevronDown size={13} className={open ? 'is-open' : undefined} /></button>{open ? <div>{children}</div> : null}</section>;
}
