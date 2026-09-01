import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleX,
  Download,
  Diamond,
  LoaderCircle,
  PanelsTopLeft,
  Plus,
  Send,
  Sparkles,
  Square,
  Star,
  Trash2,
  Video,
} from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import {
  useApplyProjectPatch,
  useCreateProject,
  useExportProject,
  useProject,
  useProjectChangeGroups,
  useProjectDeliveryGate,
  useProjectEditLease,
  useRevertProjectChangeGroup,
  useStartProjectRecording,
} from '../data/projects';
import { useDemo } from '../data/demos';
import { useAgentStatus } from '../data/config';
import { dataErrorMessage } from '../data/errors';
import { useCancelTask, useTask } from '../data/tasks';
import { useMapRadarOverview, useMatchReplay } from '../data/match';
import { useNativeShell } from '../data/nativeShell';
import {
  useDeleteMediaAsset,
  useImportMediaAsset,
  useMediaAssets,
  useRelinkMediaAsset,
} from '../data/mediaAssets';
import {
  useAgentChatStream,
  useAgentSession,
  useAppendAgentSessionEntry,
  useCreateAgentSession,
  type AgentToolActivity,
} from '../data/sessions';
import { Empty, Skeleton } from '../design/data';
import { Alert, Dialog, Drawer } from '../design/feedback';
import { Page, Toolbar } from '../design/layout';
import { Button, cn } from '../design/primitives';
import { formatMillisecondTimecode } from '../design/timeline/timeScale';
import {
  canAnimateTransformProperty,
  clipDemoTickAtTimelineTime,
  clipKeyframeAtTime,
  clipLocalTimeAtTimeline,
  clipSourceTimeAtLocalTime,
  disableClipTimeRemapping,
  enableClipTimeRemapping,
  evaluateClipKeyframeProperty,
  expandSyncLockedStoryRippleUpdates,
  createEditorEffect,
  EDITOR_EFFECT_SCHEMAS,
  editorEffectParameter,
  planSourceMediaEdit,
  replaceTimelineClipSource,
  resolveSourceMediaFit,
  projectMediaAssetKind,
  mediaAssetEditDuration,
  ProjectMediaPanel,
  projectHistoryCommands,
  ProjectTimeline,
  ProjectWorkspaceDock,
  readTimelineWorkspaceSession,
  resetProjectWorkspaceLayout,
  MAX_TIMELINE_CLIP_SPEED,
  MIN_TIMELINE_CLIP_SPEED,
  rateStretchTimelineClip,
  removeClipSpeedBoundary,
  snapTimeToFrame,
  TimelineProgramMonitor,
  type TimelineRollingPreview,
  type TimelineSlidePreview,
  type TimelineCrossTrackMovePlan,
  type ProjectSourcePatch,
  type ProjectSourcePatchTargets,
  type ProjectSourceRange,
  type SourceMediaFitMode,
  trimRippleClip,
  removeClipKeyframe,
  isSupportedEditorEffectKind,
  moveEditorEffect,
  setEditorEffectParameter,
  setClipPanAtTime,
  setClipVolumeAtTime,
  setClipSpeedSegmentSpeed,
  splitClipSpeedSegment,
  upsertClipKeyframe,
  writeTimelineWorkspaceSession,
  type SupportedEditorEffectKind,
} from '../domain/editing';
import { MapCanvas, PathLayer, type MapProjection } from '../domain/map';
import type {
  Project,
  ProjectChangeGroup,
  ProjectEditOperation,
  ProjectPatchResult,
  ProjectPatchScope,
  RadarTransformResponse,
  AgentSession,
  AgentSessionEntry,
  AgentToolCall,
  AgentToolDecisionKind,
  EditorKeyframeProperty,
  EditorKeyframeInterpolation,
  EditorTransitionKind,
  JsonValue,
  MediaAsset,
  TimelineClip,
  TimelineTrack,
} from '../shared/desktop/dto';
import type { ActivityItem } from '../shared/desktop/viewModels';
import { deliveryDecisionChangeGroupId, deliveryDecisionToolCallId } from '../shared/desktop/deliveryReview';
import { RouteLink } from './RouteLink';
import { PlayerLayer } from './match/views/ReplayCanvas';
import { buildPlayerTracks, clampTick, frameIndexAtTick, playerMarkers, sliceReplay, type PlayerMarker } from './match/views/replayModel';

type EditingLens = 'quick' | 'multitrack';
interface ProjectExportDraft {
  readonly encoder: 'auto' | 'libopenh264';
  readonly quality: number;
  readonly sourceRange: 'sequence' | 'in_out';
}
type ExternalConfirmation =
  | { readonly kind: 'recording'; readonly clipIds: readonly string[] }
  | { readonly kind: 'export'; readonly draft: ProjectExportDraft };

interface TacticalScene {
  readonly sceneKey: string;
  readonly mapName: string;
  readonly radarSrc: string;
  readonly transform: RadarTransformResponse | null | undefined;
  readonly label: string;
  readonly selectedPlayerId: string;
  readonly status: 'ready' | 'empty';
  readonly tracks: ReturnType<typeof buildPlayerTracks>['paths'];
  readonly markers: readonly PlayerMarker[];
  readonly tick: number;
}

const radarImageReadiness = new Map<string, Promise<void>>();
const StableMapCanvas = memo(MapCanvas);
const TRANSPARENT_MAP_BASEMAP = <span className="block size-full" aria-hidden="true" />;

function preloadRadarImage(src: string): Promise<void> {
  const existing = radarImageReadiness.get(src);
  if (existing !== undefined) return existing;
  const pending = new Promise<void>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (typeof image.decode !== 'function') {
        resolve();
        return;
      }
      void image.decode().then(resolve, resolve);
    };
    image.onerror = () => reject(new Error('radar image failed to preload'));
    image.src = src;
  });
  radarImageReadiness.set(src, pending);
  return pending;
}

export function ProjectWorkspacePage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const create = useCreateProject();
  const canonicalId = projectId === 'new' ? null : projectId;
  const project = useProject(canonicalId);
  const deliveryGate = useProjectDeliveryGate(canonicalId);
  const deliveryStateByClipId = useMemo(() => {
    const gate = deliveryGate.data;
    return new Map(
      gate !== undefined && gate.revision === project.data?.revision
        ? gate.blockers.map((blocker) => [blocker.clip_id, blocker.state] as const)
        : [],
    );
  }, [deliveryGate.data, project.data?.revision]);
  const allClips = useMemo(
    () => project.data?.document.tracks.flatMap((track) => track.clips) ?? [],
    [project.data?.document.tracks],
  );
  const clipById = useMemo(() => new Map(allClips.map((clip) => [clip.id, clip])), [allClips]);
  const groups = useProjectChangeGroups(canonicalId);
  const lease = useProjectEditLease(canonicalId);
  const mediaAssets = useMediaAssets(canonicalId, { enabled: canonicalId !== null });
  const importMedia = useImportMediaAsset();
  const relinkMedia = useRelinkMediaAsset();
  const deleteMedia = useDeleteMediaAsset();
  const nativeShell = useNativeShell();
  const apply = useApplyProjectPatch();
  const revertChange = useRevertProjectChangeGroup(canonicalId ?? '');
  const startRecording = useStartProjectRecording();
  const exportProject = useExportProject();
  const cancelTask = useCancelTask();
  const lens: EditingLens = 'multitrack';
  const [selectedClipIds, setSelectedClipIds] = useState<readonly string[]>([]);
  const selectedClipId = selectedClipIds[selectedClipIds.length - 1] ?? null;
  const initializedSelectionProjectId = useRef<string | null>(null);
  const initializedTargetProjectId = useRef<string | null>(null);
  const initializedSyncLockProjectId = useRef<string | null>(null);
  const knownSyncLockTrackIds = useRef<ReadonlySet<string>>(new Set());
  const [targetTrackId, setTargetTrackId] = useState<string | null>(null);
  const [targetTrackIds, setTargetTrackIds] = useState<ReadonlySet<string>>(() => new Set());
  const targetTrackIdList = useMemo(() => [...targetTrackIds], [targetTrackIds]);
  const [syncLockedTrackIds, setSyncLockedTrackIds] = useState<ReadonlySet<string>>(() => new Set());
  const syncLockedTrackIdList = useMemo(() => [...syncLockedTrackIds], [syncLockedTrackIds]);
  const [mediaTargetTrackIds, setMediaTargetTrackIds] = useState<Readonly<{
    readonly video: string | null;
    readonly audio: string | null;
  }>>({ video: null, audio: null });
  const [linkedSelectionEnabled, setLinkedSelectionEnabled] = useState(true);
  const [timelineTimeSeconds, setTimelineTimeSeconds] = useState(0);
  const [rangeInSeconds, setRangeInSeconds] = useState<number | null>(null);
  const [rangeOutSeconds, setRangeOutSeconds] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [loopPlaybackEnabled, setLoopPlaybackEnabled] = useState(false);
  const [timelineSessionReadyProjectId, setTimelineSessionReadyProjectId] = useState<string | null>(null);
  const [timelinePreviewClips, setTimelinePreviewClips] = useState<readonly TimelineClip[]>([]);
  const [timelineRollingPreview, setTimelineRollingPreview] = useState<TimelineRollingPreview | null>(null);
  const [timelineSlidePreview, setTimelineSlidePreview] = useState<TimelineSlidePreview | null>(null);
  const [trimPlaybackRange, setTrimPlaybackRange] = useState<{ readonly start: number; readonly end: number } | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [workspaceLayoutEpoch, setWorkspaceLayoutEpoch] = useState(0);
  const [mediaPanelEpoch, setMediaPanelEpoch] = useState(0);
  const [matchedSourceFrame, setMatchedSourceFrame] = useState<{ readonly clipId: string; readonly sourceTime: number } | null>(null);
  const [externalConfirm, setExternalConfirm] = useState<ExternalConfirmation | null>(null);
  const [pendingFitEdit, setPendingFitEdit] = useState<{
    readonly asset: MediaAsset;
    readonly mode: 'insert' | 'overwrite';
    readonly sourceRange: ProjectSourceRange;
    readonly sourcePatch: ProjectSourcePatch;
  } | null>(null);
  const [sourceFitMode, setSourceFitMode] = useState<SourceMediaFitMode>('fit_to_fill');
  const agentSessionId = searchParams.get('session');
  const agentSession = useAgentSession(agentSessionId);
  const createAgentSession = useCreateAgentSession();
  const appendAgentEntry = useAppendAgentSessionEntry();
  const agentChat = useAgentChatStream({
    sessionId: agentSessionId,
  });
  const agentStatus = useAgentStatus();
  const recordingTask = useTask('recording', startRecording.data?.job_id ?? null, { pollWhileActiveMs: 1_000 });
  const exportTask = useTask('export', exportProject.data?.job_id ?? null, { pollWhileActiveMs: 1_000 });
  const reportedExecutionIds = useRef(new Set<string>());
  const refreshedRecordingJobs = useRef(new Set<string>());

  useEffect(() => {
    const task = recordingTask.data;
    if (task === undefined
      || task.job_id === null
      || !['completed', 'failed', 'cancelled'].includes(task.status)
      || refreshedRecordingJobs.current.has(task.job_id)) {
      return;
    }
    refreshedRecordingJobs.current.add(task.job_id);
    void Promise.all([project.refetch(), mediaAssets.refetch()]);
  }, [mediaAssets.refetch, project.refetch, recordingTask.data]);

  useEffect(() => {
    const projectId = project.data?.id;
    if (projectId === undefined || agentSessionId === null || agentChat.streaming) return;
    const terminal = [recordingTask.data, exportTask.data].filter(
      (item): item is ActivityItem => item !== undefined
        && (item.status === 'completed' || item.status === 'failed' || item.status === 'cancelled')
        && !reportedExecutionIds.current.has(item.id),
    );
    const next = terminal[0];
    if (next === undefined) return;
    reportedExecutionIds.current.add(next.id);
    const outcome = next.status === 'completed'
      ? t`${next.kind === 'recording' ? '录制' : '导出'}任务已完成。请读取最新 Project Head，并调用 read_project_delivery 检查权威交付状态后继续当前交付。`
      : t`${next.kind === 'recording' ? '录制' : '导出'}任务${next.status === 'cancelled' ? '已取消' : '失败'}：${next.error ?? '未提供错误详情'}。请说明影响和下一步。`;
    void agentChat.send({
      sessionId: agentSessionId,
      projectId,
      mode: 'hlae',
      autoMode: true,
      message: outcome,
      workspaceContext: { projectId, lens: 'multitrack', selectedClipId },
    }).catch(() => reportedExecutionIds.current.delete(next.id));
  }, [agentChat, agentSessionId, exportTask.data, project.data?.id, recordingTask.data, selectedClipId]);

  useEffect(() => {
    if (projectId !== 'new' || create.isPending || create.data !== undefined) return;
    create.mutate(
      { name: '新作品', width: 1920, height: 1080, fps: 60, source_demo_ids: [] },
      { onSuccess: (created) => void navigate(`/projects/${encodeURIComponent(created.id)}`, { replace: true }) },
    );
  }, [create, navigate, projectId]);

  useLayoutEffect(() => {
    const loaded = project.data;
    if (loaded === undefined || timelineSessionReadyProjectId === loaded.id) return;
    const session = readTimelineWorkspaceSession(loaded.id, globalThis.localStorage);
    if (session !== null) {
      const allClipIds = new Set(loaded.document.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
      const editableTrackIds = new Set(loaded.document.tracks.filter((track) => !track.locked).map((track) => track.id));
      const allTrackIds = new Set(loaded.document.tracks.map((track) => track.id));
      const targets = session.targetTrackIds.filter((trackId) => editableTrackIds.has(trackId));
      const targetTracks = targets.map((trackId) => loaded.document.tracks.find((track) => track.id === trackId)!);
      setLinkedSelectionEnabled(session.linkedSelectionEnabled);
      setSelectedClipIds(session.selectedClipIds.filter((clipId) => allClipIds.has(clipId)));
      setTargetTrackIds(new Set(targets));
      setTargetTrackId(targets.at(-1) ?? null);
      const reversedTargetTracks = [...targetTracks].reverse();
      setMediaTargetTrackIds({
        video: reversedTargetTracks.find((track) => track.kind === 'video')?.id ?? null,
        audio: reversedTargetTracks.find((track) => track.kind === 'audio')?.id ?? null,
      });
      setSyncLockedTrackIds(new Set(session.syncLockedTrackIds.filter((trackId) => allTrackIds.has(trackId))));
      setTimelineTimeSeconds(Math.min(loaded.document.duration_seconds, session.timelineTimeSeconds));
      setRangeInSeconds(session.rangeInSeconds === null ? null : Math.min(loaded.document.duration_seconds, session.rangeInSeconds));
      setRangeOutSeconds(session.rangeOutSeconds === null ? null : Math.min(loaded.document.duration_seconds, session.rangeOutSeconds));
      setLoopPlaybackEnabled(session.loopPlaybackEnabled);
      initializedSelectionProjectId.current = loaded.id;
      initializedTargetProjectId.current = loaded.id;
      initializedSyncLockProjectId.current = loaded.id;
      knownSyncLockTrackIds.current = allTrackIds;
    }
    setTimelineSessionReadyProjectId(loaded.id);
  }, [project.data, timelineSessionReadyProjectId]);

  useEffect(() => {
    const loaded = project.data;
    if (loaded === undefined || timelineSessionReadyProjectId !== loaded.id) return undefined;
    const timer = globalThis.setTimeout(() => writeTimelineWorkspaceSession(
      loaded.id,
      globalThis.localStorage,
      {
        selectedClipIds,
        targetTrackIds: [...targetTrackIds],
        syncLockedTrackIds: [...syncLockedTrackIds],
        linkedSelectionEnabled,
        timelineTimeSeconds,
        rangeInSeconds,
        rangeOutSeconds,
        loopPlaybackEnabled,
      },
    ), 250);
    return () => globalThis.clearTimeout(timer);
  }, [
    linkedSelectionEnabled,
    loopPlaybackEnabled,
    project.data,
    rangeInSeconds,
    rangeOutSeconds,
    selectedClipIds,
    syncLockedTrackIds,
    targetTrackIds,
    timelineSessionReadyProjectId,
    timelineTimeSeconds,
  ]);

  useEffect(() => {
    const loaded = project.data;
    if (loaded === undefined) return;
    const allIds = new Set(loaded.document.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
    const firstClip = loaded.document.tracks
      .find((track) => track.id === loaded.document.story_track_id)
      ?.clips[0];
    setSelectedClipIds((currentSelection) => {
      if (initializedSelectionProjectId.current !== loaded.id) {
        initializedSelectionProjectId.current = loaded.id;
        return firstClip === undefined
          ? []
          : expandClipSelection(loaded, [firstClip.id], linkedSelectionEnabled);
      }
      const next = currentSelection.filter((clipId) => allIds.has(clipId));
      return next.length === currentSelection.length ? currentSelection : next;
    });
  }, [linkedSelectionEnabled, project.data]);

  useEffect(() => {
    if (!linkedSelectionEnabled || project.data === undefined) return;
    setSelectedClipIds((currentSelection) => expandClipSelection(project.data!, currentSelection, true));
  }, [linkedSelectionEnabled, project.data]);

  useEffect(() => {
    const loaded = project.data;
    if (loaded === undefined) return;
    if (initializedTargetProjectId.current !== loaded.id) {
      initializedTargetProjectId.current = loaded.id;
      const story = loaded.document.tracks.find((track) => track.id === loaded.document.story_track_id);
      const audio = loaded.document.tracks.find((track) => track.kind === 'audio' && !track.locked);
      setTargetTrackId(story?.locked === false ? story.id : null);
      setTargetTrackIds(new Set(story?.locked === false ? [story.id] : []));
      setMediaTargetTrackIds({
        video: story?.locked === false ? story.id : null,
        audio: audio?.id ?? null,
      });
      return;
    }
    if (targetTrackId === null) return;
    const target = loaded.document.tracks.find((track) => track.id === targetTrackId);
    if (target === undefined || target.locked) setTargetTrackId(null);
    setTargetTrackIds((currentTargets) => {
      const next = new Set([...currentTargets].filter((trackId) => (
        loaded.document.tracks.some((track) => track.id === trackId && !track.locked)
      )));
      return next.size === currentTargets.size && [...next].every((trackId) => currentTargets.has(trackId))
        ? currentTargets
        : next;
    });
    setMediaTargetTrackIds((targets) => {
      const video = loaded.document.tracks.find((track) => track.id === targets.video && track.kind === 'video' && !track.locked)
        ?? loaded.document.tracks.find((track) => track.id === loaded.document.story_track_id && !track.locked)
        ?? null;
      const audio = loaded.document.tracks.find((track) => track.id === targets.audio && track.kind === 'audio' && !track.locked)
        ?? loaded.document.tracks.find((track) => track.kind === 'audio' && !track.locked)
        ?? null;
      if (video?.id === targets.video && audio?.id === targets.audio) return targets;
      return { video: video?.id ?? null, audio: audio?.id ?? null };
    });
  }, [project.data, targetTrackId]);

  useLayoutEffect(() => {
    const loaded = project.data;
    if (loaded === undefined) return;
    const trackIds = new Set(loaded.document.tracks.map((track) => track.id));
    if (initializedSyncLockProjectId.current !== loaded.id) {
      initializedSyncLockProjectId.current = loaded.id;
      knownSyncLockTrackIds.current = trackIds;
      setSyncLockedTrackIds(trackIds);
      return;
    }
    const previousTrackIds = knownSyncLockTrackIds.current;
    knownSyncLockTrackIds.current = trackIds;
    setSyncLockedTrackIds((currentIds) => {
      const next = new Set([...currentIds].filter((trackId) => trackIds.has(trackId)));
      for (const trackId of trackIds) {
        if (!previousTrackIds.has(trackId)) next.add(trackId);
      }
      return next.size === currentIds.size && [...next].every((trackId) => currentIds.has(trackId))
        ? currentIds
        : next;
    });
  }, [project.data]);

  useEffect(() => {
    const duration = project.data?.document.duration_seconds;
    if (duration === undefined) return;
    setTimelineTimeSeconds((time) => Math.min(duration, Math.max(0, time)));
  }, [project.data?.document.duration_seconds]);

  useEffect(() => {
    setTimelinePreviewClips([]);
    if (trimPlaybackRange === null) setTimelineRollingPreview(null);
    setTimelineSlidePreview(null);
  }, [project.data?.revision, trimPlaybackRange]);

  if (projectId === 'new' || project.isPending) {
    return (
      <Page toolbar={<Toolbar title={<Trans>作品工作区</Trans>} />}>
        <div className="flex flex-col gap-4 p-7" role="status" aria-busy="true">
          <Skeleton className="h-12" />
          <Skeleton className="h-80" />
        </div>
      </Page>
    );
  }
  if (project.error !== null || project.data === undefined) {
    return (
      <Page toolbar={<Toolbar title={<Trans>作品工作区</Trans>} meta={projectId} />}>
        <div className="p-7">
          <Empty
            title={<Trans>找不到这份作品</Trans>}
            description={<Trans>统一 Project Head 不存在。</Trans>}
            actions={<RouteLink to="/projects"><Trans>返回作品列表</Trans></RouteLink>}
          />
        </div>
      </Page>
    );
  }

  const current = project.data;
  const previewProject = projectWithPreviewClips(current, timelinePreviewClips);
  const readOnly = agentChat.streaming || (lease.data !== null && lease.data !== undefined);
  const selected = findClip(current, selectedClipId);
  const transportTimeSeconds = Math.min(
    current.document.duration_seconds,
    Math.max(0, timelineTimeSeconds),
  );
  const exportRangeStart = rangeInSeconds === null || rangeOutSeconds === null
    ? null
    : Math.min(rangeInSeconds, rangeOutSeconds);
  const exportRangeEnd = rangeInSeconds === null || rangeOutSeconds === null
    ? null
    : Math.max(rangeInSeconds, rangeOutSeconds);
  const hasExportRange = exportRangeStart !== null
    && exportRangeEnd !== null
    && exportRangeEnd - exportRangeStart >= 1 / current.document.fps;
  const pendingFitResolution = pendingFitEdit === null || exportRangeStart === null || exportRangeEnd === null
    ? null
    : resolveSourceMediaFit({
        sourceRange: pendingFitEdit.sourceRange,
        sequenceRange: { start: exportRangeStart, end: exportRangeEnd },
        mediaDuration: mediaAssetEditDuration(pendingFitEdit.asset) ?? 0,
        mode: sourceFitMode,
      });
  const loopPlaybackRange = !loopPlaybackEnabled
    ? null
    : hasExportRange
      ? { start: exportRangeStart, end: exportRangeEnd }
      : { start: 0, end: current.document.duration_seconds };
  const activePlaybackRange = trimPlaybackRange ?? loopPlaybackRange;
  const transportClip = previewProject.document.tracks
    .find((track) => track.id === previewProject.document.story_track_id)
    ?.clips.find((clip) => transportTimeSeconds >= clip.placement.start
      && transportTimeSeconds < clip.placement.start + clip.placement.duration) ?? null;
  const latestAgentChangeGroup = (groups.data ?? []).find((group) => group.author.kind === 'agent') ?? null;
  const pendingAgentReviewGroup = pendingDeliveryGroup(groups.data ?? [], agentSession.data ?? null);
  const historyCommands = projectHistoryCommands(groups.data ?? []);
  const currentDeliveryGate = deliveryGate.data?.revision === current.revision ? deliveryGate.data : null;
  const deliveryGatePending = deliveryGate.isPending || (deliveryGate.error === null && currentDeliveryGate === null);
  const deliveryBlockers = currentDeliveryGate?.blockers ?? [];
  const recordableClipIds = deliveryBlockers.flatMap((blocker) => {
    if (blocker.state !== 'unrecorded' && blocker.state !== 'stale') return [];
    const clip = clipById.get(blocker.clip_id);
    return clip?.capture_intent === null || clip?.capture_intent === undefined ? [] : [blocker.clip_id];
  });
  const mutate = (
    summary: string,
    scope: ProjectPatchScope,
    operations: ProjectEditOperation[],
    onSuccess?: (result: ProjectPatchResult) => void,
  ) => {
    if (readOnly || apply.isPending) return;
    apply.mutate({
      project_id: current.id,
      base_revision: current.revision,
      scope,
      author: { kind: 'human' },
      reverts_change_group_id: null,
      summary,
      operations,
    }, onSuccess === undefined ? undefined : { onSuccess });
  };
  const expandTrackClipUpdates = (
    updates: readonly { readonly trackId: string; readonly clips: readonly TimelineClip[] }[],
  ) => expandSyncLockedStoryRippleUpdates({
    tracks: current.document.tracks,
    storyTrackId: current.document.story_track_id,
    updates,
    syncLockedTrackIds,
    fps: current.document.fps,
  });
  const mutateTrackClipUpdates = (
    updates: readonly { readonly trackId: string; readonly clips: readonly TimelineClip[] }[],
  ) => {
    const expanded = expandTrackClipUpdates(updates);
    mutate(
      expanded.length === 1 ? `调整轨道片段` : `调整 ${expanded.length} 条轨道的片段`,
      expanded.length === 1
        ? { kind: 'track', track_id: expanded[0]!.trackId }
        : { kind: 'project' },
      expanded.map((update) => ({ op: 'replace_track_clips', track_id: update.trackId, clips: [...update.clips] })),
    );
  };
  const seekTimeline = (seconds: number) => {
    setTimelineTimeSeconds(Math.min(
      current.document.duration_seconds,
      Math.max(0, seconds),
    ));
  };
  const togglePlayback = () => {
    setPlaybackRate((rate) => rate === 0 ? 1 : rate);
    setPlaying((value) => !value);
  };
  const shuttlePlayback = (direction: -1 | 0 | 1) => {
    if (direction === 0) {
      setPlaying(false);
      return;
    }
    setPlaybackRate((rate) => {
      if (!playing || Math.sign(rate) !== direction) return direction;
      return direction * Math.min(4, Math.max(1, Math.abs(rate) * 2));
    });
    setPlaying(true);
  };
  const stepTimelineFrame = (direction: -1 | 1) => {
    setPlaying(false);
    seekTimeline(transportTimeSeconds + direction / current.document.fps);
  };
  const selectTimelineClip = (clipId: string, additive = false, range = false) => {
    setSelectedClipIds((currentSelection) => {
      if (range) {
        const anchorId = currentSelection[currentSelection.length - 1];
        const track = current.document.tracks.find((candidate) => candidate.clips.some((clip) => clip.id === clipId)
          && candidate.clips.some((clip) => clip.id === anchorId));
        if (track === undefined || anchorId === undefined) {
          return expandClipSelection(current, [clipId], linkedSelectionEnabled);
        }
        const anchorIndex = track.clips.findIndex((clip) => clip.id === anchorId);
        const targetIndex = track.clips.findIndex((clip) => clip.id === clipId);
        const from = Math.min(anchorIndex, targetIndex);
        const to = Math.max(anchorIndex, targetIndex);
        const rangeIds = track.clips.slice(from, to + 1).map((clip) => clip.id);
        return expandClipSelection(current, rangeIds, linkedSelectionEnabled);
      }
      const group = expandClipSelection(current, [clipId], linkedSelectionEnabled);
      if (!additive) return group;
      return group.every((groupId) => currentSelection.includes(groupId))
        ? currentSelection.filter((selectedId) => !group.includes(selectedId))
        : [...new Set([...currentSelection, ...group])];
    });
  };
  const selectTimelineClips = (clipIds: readonly string[]) => {
    setSelectedClipIds(expandClipSelection(current, clipIds, linkedSelectionEnabled));
  };
  const promoteTimelineClip = (clipId: string) => {
    setSelectedClipIds((currentSelection) => currentSelection.includes(clipId)
      ? [...currentSelection.filter((selectedId) => selectedId !== clipId), clipId]
      : currentSelection);
  };
  const replaceTimelineClip = (clip: TimelineClip) => {
    const track = current.document.tracks.find((candidate) => candidate.clips.some((item) => item.id === clip.id));
    const currentClip = track?.clips.find((item) => item.id === clip.id);
    if (track?.locked !== false || currentClip === undefined || sameTimelineClip(currentClip, clip)) return;
    mutate(
      `调整 ${clip.name}`,
      { kind: 'time_range', start: clip.placement.start, end: clip.placement.start + clip.placement.duration },
      [{ op: 'replace_clip', clip_id: clip.id, clip }],
    );
  };
  const mediaTargetTrack = (asset: MediaAsset, preferredTrackId = targetTrackId): TimelineTrack | null => {
    const desiredKind = projectMediaAssetKind(asset);
    if (preferredTrackId === null) return null;
    const explicit = current.document.tracks.find((track) => track.id === preferredTrackId) ?? null;
    return explicit?.kind === desiredKind ? explicit : null;
  };
  const sourcePatchTrackPlan = (asset: MediaAsset, sourcePatch: ProjectSourcePatch) => {
    const videoTrack = sourcePatch.video
      ? current.document.tracks.find((track) => track.id === mediaTargetTrackIds.video && track.kind === 'video' && !track.locked) ?? null
      : null;
    const embeddedAudio = sourcePatch.audio
      && sourcePatch.video
      && asset.has_audio
      && videoTrack?.id === current.document.story_track_id;
    const audioTrack = sourcePatch.audio && !embeddedAudio
      ? current.document.tracks.find((track) => track.id === mediaTargetTrackIds.audio && track.kind === 'audio' && !track.locked)
        ?? current.document.tracks.find((track) => track.kind === 'audio' && !track.locked)
        ?? null
      : null;
    return { videoTrack, audioTrack, embeddedAudio };
  };
  const sourcePatchTargets = (asset: MediaAsset, sourcePatch: ProjectSourcePatch): ProjectSourcePatchTargets => {
    const plan = sourcePatchTrackPlan(asset, sourcePatch);
    return {
      video: sourcePatch.video ? plan.videoTrack?.name ?? null : null,
      audio: sourcePatch.audio
        ? plan.embeddedAudio
          ? t`Story（内嵌音频）`
          : plan.audioTrack?.name ?? t`新建音频轨道`
        : null,
    };
  };
  const canApplySourcePatch = (asset: MediaAsset, sourcePatch: ProjectSourcePatch) => {
    if (!sourcePatch.video && !sourcePatch.audio) return false;
    if (sourcePatch.video && (projectMediaAssetKind(asset) !== 'video' || sourcePatchTrackPlan(asset, sourcePatch).videoTrack === null)) return false;
    return !sourcePatch.audio || asset.has_audio;
  };
  const addMediaAsset = (
    asset: MediaAsset,
    mode: 'insert' | 'overwrite',
    placement?: { readonly trackId: string; readonly timeSeconds: number },
    sourceRange?: ProjectSourceRange,
    sourcePatch: ProjectSourcePatch = {
      video: projectMediaAssetKind(asset) === 'video',
      audio: projectMediaAssetKind(asset) === 'audio',
    },
    fitMode?: SourceMediaFitMode,
  ) => {
    const mediaDuration = mediaAssetEditDuration(asset);
    if (mediaDuration === null) return;
    const sequenceRange = hasExportRange ? { start: exportRangeStart, end: exportRangeEnd } : null;
    const sourceDuration = sourceRange === undefined ? null : sourceRange.sourceOut - sourceRange.sourceIn;
    if (placement === undefined
      && sourceRange !== undefined
      && sequenceRange !== null
      && fitMode === undefined
      && sourceDuration !== null
      && Math.abs(sourceDuration - (sequenceRange.end - sequenceRange.start)) > 0.5 / current.document.fps) {
      setPendingFitEdit({ asset, mode, sourceRange, sourcePatch });
      setSourceFitMode('fit_to_fill');
      return;
    }
    const fit = placement === undefined && sourceRange !== undefined && sequenceRange !== null
      ? resolveSourceMediaFit({ sourceRange, sequenceRange, mediaDuration, mode: fitMode ?? 'fit_to_fill' })
      : null;
    if (placement === undefined && sourceRange !== undefined && sequenceRange !== null && fit === null) return;
    const editTimeSeconds = snapTimeToFrame(
      fit?.editTimeSeconds ?? placement?.timeSeconds ?? transportTimeSeconds,
      current.document.fps,
    );
    const effectiveSourceRange = fit?.sourceRange ?? sourceRange;
    const directTarget = placement === undefined ? null : mediaTargetTrack(asset, placement.trackId);
    const effectivePatch = placement === undefined ? sourcePatch : {
      video: directTarget?.kind === 'video',
      audio: directTarget?.kind === 'audio'
        || (directTarget?.kind === 'video' && asset.has_audio),
    };
    if (placement === undefined && !canApplySourcePatch(asset, effectivePatch)) return;
    const patchPlan = sourcePatchTrackPlan(asset, effectivePatch);
    const directAudioPlan = sourcePatchTrackPlan(asset, { video: false, audio: effectivePatch.audio });
    const plan = placement === undefined ? patchPlan : {
      videoTrack: directTarget?.kind === 'video' ? directTarget : null,
      audioTrack: directTarget?.kind === 'audio' ? directTarget : directAudioPlan.audioTrack,
      embeddedAudio: directTarget?.id === current.document.story_track_id && effectivePatch.audio,
    };
    const editPlan = planSourceMediaEdit({
      document: current.document,
      asset,
      sourcePatch: effectivePatch,
      tracks: plan,
      mode,
      editTimeSeconds,
      sourceRange: effectiveSourceRange,
      ...(fit === null ? {} : { timelineDurationSeconds: fit.timelineDurationSeconds, speed: fit.speed }),
      newAudioTrackName: t`音频轨道 ${current.document.tracks.filter((candidate) => candidate.kind === 'audio').length + 1}`,
      createId: () => globalThis.crypto.randomUUID(),
    });
    if (editPlan === null) return;
    const directTrackUpdates = editPlan.operations.flatMap((operation) => operation.op === 'replace_track_clips'
      ? [{ trackId: operation.track_id, clips: operation.clips }]
      : []);
    const expandedTrackUpdates = expandTrackClipUpdates(directTrackUpdates);
    const operations = [
      ...editPlan.operations.filter((operation) => operation.op !== 'replace_track_clips'),
      ...expandedTrackUpdates.map((update): ProjectEditOperation => ({
        op: 'replace_track_clips',
        track_id: update.trackId,
        clips: [...update.clips],
      })),
    ];
    const singleTrackId = operations.length === 1 && operations[0]?.op === 'replace_track_clips'
      ? operations[0].track_id
      : null;
    mutate(
      `${mode === 'insert' ? '插入' : '覆盖'}素材 ${asset.name}`,
      singleTrackId === null ? { kind: 'project' } : { kind: 'track', track_id: singleTrackId },
      operations,
      editPlan.insertedAudioTrackIndex === null ? undefined : ({ project: updated }) => {
        const insertedTrack = updated.document.tracks[editPlan.insertedAudioTrackIndex!];
        const insertedClip = insertedTrack?.clips.find((clip) => (
          clip.material.kind === 'asset'
          && clip.material.asset_id === asset.id
          && Math.abs(clip.placement.start - editTimeSeconds) <= 1 / current.document.fps
        ));
        if (insertedTrack === undefined || insertedClip === undefined) return;
        setMediaTargetTrackIds((targets) => ({ ...targets, audio: insertedTrack.id }));
        setSelectedClipIds([insertedClip.id]);
      },
    );
    if (editPlan.selectedAudioTrackId !== null) {
      setMediaTargetTrackIds((targets) => ({ ...targets, audio: editPlan.selectedAudioTrackId }));
    }
    setSelectedClipIds(editPlan.insertedClipIds);
  };
  const replacementClipForAsset = (asset: MediaAsset, sourceRange: ProjectSourceRange) => selected === null
    ? null
    : replaceTimelineClipSource({
        clip: selected.clip,
        track: selected.track,
        asset,
        sourceRange,
      });
  const replaceSelectedClipSource = (asset: MediaAsset, sourceRange: ProjectSourceRange) => {
    const replacement = replacementClipForAsset(asset, sourceRange);
    if (replacement === null) return;
    mutate(
      `用 ${asset.name} 替换片段 ${selected?.clip.name ?? replacement.name}`,
      {
        kind: 'time_range',
        start: replacement.placement.start,
        end: replacement.placement.start + replacement.placement.duration,
      },
      [{ op: 'replace_clip', clip_id: replacement.id, clip: replacement }],
    );
    setSelectedClipIds([replacement.id]);
  };
  const importProjectMedia = async () => {
    if (!nativeShell.available) return;
    const paths = await nativeShell.chooseFiles({ title: t`导入项目素材` });
    await Promise.all(paths.map((path) => importMedia.mutateAsync({ path, projectId: current.id })));
  };
  const relinkProjectMedia = async (asset: MediaAsset) => {
    if (!nativeShell.available) return;
    const [path] = await nativeShell.chooseFiles({ title: t`重新定位 ${asset.name}` });
    if (path === undefined) return;
    await relinkMedia.mutateAsync({ id: asset.id, path });
    setMediaPanelEpoch((epoch) => epoch + 1);
  };
  const sendToAgent = async (message: string) => {
    let sessionId = agentSessionId;
    if (sessionId === null) {
      const session = await createAgentSession.mutateAsync(`Agent · ${current.name}`);
      sessionId = session.id;
      setSearchParams({ session: session.id }, { replace: true });
    }
    await agentChat.send({
      sessionId,
      projectId: current.id,
      mode: 'hlae',
      autoMode: true,
      message,
      workspaceContext: { projectId: current.id, lens, selectedClipId },
    });
  };
  const appendToolDecision = async (
    toolCallId: string,
    decision: AgentToolDecisionKind,
    content: string,
  ) => {
    if (agentSessionId === null) return;
    await appendAgentEntry.mutateAsync({
      sessionId: agentSessionId,
      draft: { kind: 'tool_decision', tool_call_id: toolCallId, decision, content },
    });
  };
  const mutationError = [
    deliveryGate.error,
    apply.error,
    revertChange.error,
    startRecording.error,
    exportProject.error,
    cancelTask.error,
    importMedia.error,
    relinkMedia.error,
    deleteMedia.error,
  ].find((error) => error !== null) ?? null;
  const mutationErrorDetail = dataErrorMessage(mutationError);
  const projectPanel = (
    <ProjectMediaPanel
      key={mediaPanelEpoch}
      docked
      assets={mediaAssets.data?.items ?? []}
      timelineTracks={current.document.tracks}
      deliveryStateByClipId={deliveryStateByClipId}
      projectFps={current.document.fps}
      selectedTimelineClipId={selectedClipId}
      matchedSourceFrame={matchedSourceFrame}
      pending={mediaAssets.isPending}
      readOnly={readOnly}
      busy={apply.isPending || relinkMedia.isPending || deleteMedia.isPending}
      canEditAsset={canApplySourcePatch}
      sourcePatchTargets={sourcePatchTargets}
      importAvailable={nativeShell.available}
      relinkAvailable={nativeShell.available}
      importing={importMedia.isPending}
      onSelectTimelineClip={(clipId, startSeconds) => {
        setPlaying(false);
        setSelectedClipIds([clipId]);
        seekTimeline(startSeconds);
      }}
      onRequestRecording={(clipId) => setExternalConfirm({ kind: 'recording', clipIds: [clipId] })}
      onImport={() => void importProjectMedia()}
      onInsert={(asset, sourceRange, sourcePatch) => addMediaAsset(asset, 'insert', undefined, sourceRange, sourcePatch)}
      onOverwrite={(asset, sourceRange, sourcePatch) => addMediaAsset(asset, 'overwrite', undefined, sourceRange, sourcePatch)}
      canReplace={(asset, sourceRange) => replacementClipForAsset(asset, sourceRange) !== null}
      onReplace={replaceSelectedClipSource}
      onRelink={(asset) => void relinkProjectMedia(asset)}
      onDelete={(asset) => deleteMedia.mutate(asset.id)}
    />
  );
  const programPanel = (
    <TimelineProgramMonitor
      showHeader={false}
      project={previewProject}
      deliveryStateByClipId={deliveryStateByClipId}
      timelineTimeSeconds={transportTimeSeconds}
      selectedClipId={selectedClipId}
      readOnly={readOnly || apply.isPending || selected?.track.locked === true}
      playing={playing}
      playbackRate={playbackRate}
      rollingPreview={timelineRollingPreview}
      slidePreview={timelineSlidePreview}
      playbackRange={activePlaybackRange}
      onTogglePlayback={togglePlayback}
      onShuttle={shuttlePlayback}
      onStepFrame={stepTimelineFrame}
      onTimelineTimeChange={seekTimeline}
      onPlaybackEnd={() => setPlaying(false)}
      onReplaceClip={replaceTimelineClip}
    />
  );
  const tacticalPanel = (
    <TacticalPreview
      selected={transportClip}
      timelineTimeSeconds={transportTimeSeconds}
      fps={current.document.fps}
      showHeader={false}
    />
  );
  const timelinePanel = (
    <ProjectTimeline
      docked
      projectId={current.id}
      document={current.document}
      deliveryStateByClipId={deliveryStateByClipId}
      selectedClipId={selectedClipId}
      selectedClipIds={selectedClipIds}
      targetTrackId={targetTrackId}
      targetTrackIds={targetTrackIdList}
      syncLockedTrackIds={syncLockedTrackIdList}
      linkedSelectionEnabled={linkedSelectionEnabled}
      timelineTimeSeconds={transportTimeSeconds}
      rangeInSeconds={rangeInSeconds}
      rangeOutSeconds={rangeOutSeconds}
      transportPlaying={playing}
      loopPlaybackEnabled={loopPlaybackEnabled}
      reviewGroup={latestAgentChangeGroup}
      readOnly={readOnly || apply.isPending || revertChange.isPending}
      onSelectClip={selectTimelineClip}
      onSelectClips={selectTimelineClips}
      onPromoteClip={promoteTimelineClip}
      onTargetTrack={(trackId, kind) => {
        const enable = !targetTrackIds.has(trackId);
        setTargetTrackIds((currentTargets) => {
          const next = new Set(currentTargets);
          if (enable) next.add(trackId);
          else next.delete(trackId);
          return next;
        });
        setTargetTrackId((currentTarget) => enable
          ? trackId
          : currentTarget === trackId ? [...targetTrackIds].filter((id) => id !== trackId).at(-1) ?? null : currentTarget);
        if (enable && (kind === 'video' || kind === 'audio')) {
          setMediaTargetTrackIds((targets) => ({
            ...targets,
            [kind]: trackId,
          }));
        }
      }}
      onToggleSyncLock={(trackId, kind, allOfKind) => {
        setSyncLockedTrackIds((currentIds) => {
          const enable = !currentIds.has(trackId);
          const affected = allOfKind
            ? current.document.tracks.filter((track) => track.kind === kind).map((track) => track.id)
            : [trackId];
          const next = new Set(currentIds);
          for (const affectedId of affected) {
            if (enable) next.add(affectedId);
            else next.delete(affectedId);
          }
          return next;
        });
      }}
      onToggleLinkedSelection={() => setLinkedSelectionEnabled((value) => !value)}
      onInspectClip={(clipId) => {
        setSelectedClipIds([clipId]);
        setInspectorOpen(true);
      }}
      onMatchFrame={(clipId, sourceTime) => {
        setPlaying(false);
        setSelectedClipIds([clipId]);
        setMatchedSourceFrame({ clipId, sourceTime });
      }}
      onSeek={(seconds) => {
        setPlaying(false);
        seekTimeline(seconds);
      }}
      onRangeChange={(rangeIn, rangeOut) => {
        setRangeInSeconds(rangeIn);
        setRangeOutSeconds(rangeOut);
      }}
      onTogglePlayback={togglePlayback}
      onToggleLoopPlayback={() => setLoopPlaybackEnabled((enabled) => !enabled)}
      onShuttle={shuttlePlayback}
      onReplaceClip={replaceTimelineClip}
      onReplaceTrack={(track) => mutate(
        `修改轨道 ${track.name}`,
        { kind: 'track', track_id: track.id },
        [{ op: 'replace_track', track_id: track.id, track }],
      )}
      onReplaceTrackClips={(trackId, clips) => mutateTrackClipUpdates([{ trackId, clips }])}
      onReplaceTrackClipGroups={mutateTrackClipUpdates}
      onApplyCrossTrackMove={(plan: TimelineCrossTrackMovePlan) => {
        const expanded = expandTrackClipUpdates(plan.updates);
        mutate(
          `跨轨移动片段`,
          { kind: 'project' },
          [
            ...(plan.insertedTrack === null ? [] : [{
              op: 'insert_track' as const,
              index: plan.insertedTrack.index,
              track: plan.insertedTrack.track,
            }]),
            ...expanded.map((update) => ({
              op: 'replace_track_clips' as const,
              track_id: update.trackId,
              clips: [...update.clips],
            })),
          ],
        );
      }}
      onReplaceClips={(clips, intent) => mutate(
        intent === 'group'
          ? clips.every((clip) => clip.group_id === null) ? `取消组合片段` : `组合片段`
          : clips.every((clip) => clip.link_group_id === null) ? `取消链接片段` : `链接片段`,
        { kind: 'project' },
        clips.map((clip) => ({ op: 'replace_clip', clip_id: clip.id, clip })),
      )}
      onPreviewClips={setTimelinePreviewClips}
      onPreviewRollingEdit={setTimelineRollingPreview}
      onPreviewSlideEdit={setTimelineSlidePreview}
      onTrimPlaybackRangeChange={setTrimPlaybackRange}
      onInsertTrack={(track, index) => mutate(
        `添加轨道 ${track.name}`,
        { kind: 'project' },
        [{ op: 'insert_track', index, track }],
      )}
      onRemoveTrack={(trackId) => mutate(
        `删除轨道`,
        { kind: 'track', track_id: trackId },
        [{ op: 'remove_track', track_id: trackId }],
      )}
      onReorderTracks={(trackIds) => mutate(
        `重排轨道`,
        { kind: 'project' },
        [{ op: 'reorder_tracks', track_ids: [...trackIds] }],
      )}
      onReplaceMarkers={(markers) => mutate(
        `更新标记`,
        { kind: 'project' },
        [{ op: 'replace_markers', markers: [...markers] }],
      )}
      onDropMediaAsset={({ assetId, trackId, timeSeconds, mode }) => {
        const asset = mediaAssets.data?.items.find((candidate) => candidate.id === assetId);
        const track = current.document.tracks.find((candidate) => candidate.id === trackId);
        if (asset === undefined || track === undefined || track.locked || track.kind !== projectMediaAssetKind(asset)) return;
        addMediaAsset(asset, mode, { trackId, timeSeconds });
      }}
      canUndo={historyCommands.undo !== null}
      onUndo={() => {
        if (historyCommands.undo === null || readOnly) return;
        revertChange.mutate({
          changeGroupId: historyCommands.undo.id,
          expectedRevision: current.revision,
        });
      }}
      canRedo={historyCommands.redo !== null}
      onRedo={() => {
        if (historyCommands.redo === null || readOnly) return;
        revertChange.mutate({
          changeGroupId: historyCommands.redo.id,
          expectedRevision: current.revision,
        });
      }}
    />
  );
  const agentPanel = (
    <AgentPanel
      showHeader={false}
      session={agentSession.data ?? null}
      chat={agentChat}
      creatingSession={createAgentSession.isPending}
      onSend={sendToAgent}
      changeGroups={groups.data ?? []}
      readOnly={readOnly}
      agentReady={agentStatus.data?.configured === true}
      agentStatusPending={agentStatus.isPending}
      deliveryReady={currentDeliveryGate?.ready === true}
      deliveryGatePending={deliveryGatePending}
      externalExecutions={[recordingTask.data, exportTask.data].filter((item): item is ActivityItem => item !== undefined)}
      executionActionPending={cancelTask.isPending}
      onCancelExecution={(execution) => {
        if (execution.job_id === null || !execution.available_actions.includes('cancel')) return;
        cancelTask.mutate({ kind: execution.kind, jobId: execution.job_id });
      }}
      onOpenOutputs={() => void navigate('/delivery?view=outputs')}
      onOpenAgentSettings={() => void navigate('/settings?section=ai&item=model')}
      confirming={appendAgentEntry.isPending || startRecording.isPending || exportProject.isPending}
      onConfirmRecording={async (toolCallId, clipIds) => {
        await appendToolDecision(toolCallId, 'approved', t`允许 Agent 请求的录制操作。`);
        await startRecording.mutateAsync({ projectId: current.id, clipIds });
      }}
      onConfirmExport={async (toolCallId) => {
        if (deliveryGatePending || currentDeliveryGate?.ready !== true) return;
        await appendToolDecision(toolCallId, 'approved', t`允许 Agent 请求的导出操作。`);
        await exportProject.mutateAsync({ projectId: current.id });
      }}
      onRejectConfirmation={async (toolCallId) => {
        await appendToolDecision(toolCallId, 'rejected', t`拒绝这次外部执行请求。`);
      }}
      onAcceptDelivery={(groupId) => appendToolDecision(
        deliveryDecisionToolCallId(groupId),
        'approved',
        t`已接受这组 Agent 变更。`,
      )}
      onReturnDelivery={async (groupId, feedback) => {
        await appendToolDecision(
          deliveryDecisionToolCallId(groupId),
          'rejected',
          t`已退回这组 Agent 变更。修改意见：${feedback}`,
        );
        await sendToAgent(t`退回修改意见：${feedback}`);
      }}
      onDirectEdit={(groupId) => {
        void appendToolDecision(
          deliveryDecisionToolCallId(groupId),
          'rejected',
          t`人类已接管并直接修改这组 Agent 变更。`,
        );
        const clipId = selectedClipId ?? allClips[0]?.id ?? null;
        setSelectedClipIds(clipId === null ? [] : [clipId]);
        setInspectorOpen(clipId !== null);
      }}
    />
  );
  const dockPanels = {
    project: projectPanel,
    program: programPanel,
    tactical: tacticalPanel,
    timeline: timelinePanel,
    agent: agentPanel,
  } as const;

  return (
    <Page
      className="review-workbench"
      scroll={false}
      toolbar={(
        <header data-tauri-drag-region className="flex h-[56px] flex-none items-center gap-2 border-b border-divider bg-bg px-5 pr-32">
          <button type="button" data-window-no-drag className="mr-3 flex items-center gap-4 text-sm font-medium text-neutral-700 hover:text-text" onClick={() => void navigate('/projects')}>
            <ChevronLeft className="size-4" strokeWidth={1.6} aria-hidden="true" />
            <Trans>作品</Trans>
          </button>
          <ChevronRight className="size-3.5 text-neutral-400" strokeWidth={1.5} aria-hidden="true" />
          <h1 className="min-w-0 truncate text-sm font-semibold">{current.name}</h1>
          <ChevronRight className="size-3.5 text-neutral-400" strokeWidth={1.5} aria-hidden="true" />
          <span className="whitespace-nowrap text-sm font-semibold"><Trans>变更 #{current.revision}</Trans></span>
          {pendingAgentReviewGroup === null ? null : (
            <>
              <span className="ml-8 border border-accent-200 bg-accent-100 px-2 py-1 text-xs font-medium text-accent-text">
                <Trans>Agent 修改待审阅</Trans>
              </span>
              <span className="whitespace-nowrap text-xs text-neutral-500"><Trans>共 {pendingAgentReviewGroup.operations.length} 处变更</Trans></span>
            </>
          )}
          {deliveryGatePending ? (
            <span className="ml-1 flex items-center gap-1 whitespace-nowrap text-xs text-neutral-500"><LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.6} aria-hidden="true" /><Trans>检查交付状态</Trans></span>
          ) : currentDeliveryGate?.ready === true ? (
            <span className="ml-1 flex items-center gap-1 whitespace-nowrap text-xs text-ok"><CheckCircle2 className="size-3.5" strokeWidth={1.6} aria-hidden="true" /><Trans>检查通过</Trans></span>
          ) : (
            <span className="ml-1 flex items-center gap-1 whitespace-nowrap text-xs text-warn-text"><CircleAlert className="size-3.5" strokeWidth={1.6} aria-hidden="true" /><Trans>{deliveryBlockers.length} 个素材未就绪</Trans></span>
          )}
          <button
            type="button"
            data-window-no-drag
            className="ml-3 grid size-[var(--h-ctl-sm)] place-items-center rounded-sm border border-divider text-neutral-600 hover:bg-neutral-100 hover:text-text"
            aria-label={t`重置工作区布局`}
            title={t`重置工作区布局`}
            onClick={() => {
              resetProjectWorkspaceLayout(current.id, globalThis.localStorage);
              setWorkspaceLayoutEpoch((epoch) => epoch + 1);
            }}
          >
            <PanelsTopLeft className="size-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            data-window-no-drag
            className="flex h-[var(--h-ctl-sm)] items-center gap-1.5 rounded-sm border border-divider px-2 text-xs hover:bg-neutral-100 disabled:text-neutral-300"
            disabled={readOnly || deliveryGatePending || recordableClipIds.length === 0 || startRecording.isPending}
            onClick={() => setExternalConfirm({ kind: 'recording', clipIds: recordableClipIds })}
          >
            <Video className="size-3.5" aria-hidden="true" />
            <Trans>录制缺失片段</Trans>
          </button>
          <button
            type="button"
            data-window-no-drag
            className="flex h-[var(--h-ctl-sm)] items-center gap-1.5 rounded-sm border border-accent bg-accent px-2 text-xs text-bg hover:bg-accent-700 disabled:border-divider disabled:bg-neutral-200 disabled:text-neutral-400"
            disabled={readOnly || deliveryGatePending || currentDeliveryGate?.ready !== true || exportProject.isPending}
            onClick={() => setExternalConfirm({
              kind: 'export',
              draft: { encoder: 'auto', quality: 80, sourceRange: hasExportRange ? 'in_out' : 'sequence' },
            })}
          >
            <Download className="size-3.5" aria-hidden="true" />
            <Trans>导出成片</Trans>
          </button>
        </header>
      )}
    >
      <ProjectWorkspaceDock
        key={`${current.id}:${workspaceLayoutEpoch}`}
        projectId={current.id}
        panels={dockPanels}
        labels={{
          project: t`项目素材`,
          program: t`视频预览`,
          tactical: t`战术示意`,
          timeline: t`时间轴（变更审阅）`,
          agent: t`Agent`,
        }}
      />
      <Dialog
        open={pendingFitEdit !== null}
        title={<Trans>Fit Clip：范围时长不同</Trans>}
        confirmLabel={<Trans>应用四点编辑</Trans>}
        confirmDisabled={pendingFitResolution === null}
        onConfirm={() => {
          if (pendingFitEdit === null || pendingFitResolution === null) return;
          const edit = pendingFitEdit;
          setPendingFitEdit(null);
          addMediaAsset(edit.asset, edit.mode, undefined, edit.sourceRange, edit.sourcePatch, sourceFitMode);
        }}
        onClose={() => setPendingFitEdit(null)}
      >
        <p className="mb-3"><Trans>Source In/Out 与 Timeline In/Out 时长不同。选择如何满足四点编辑。</Trans></p>
        <div className="space-y-2">
          {([
            ['fit_to_fill', t`更改片段速度（Fit to Fill）`],
            ['trim_head', t`裁切片段头部（左侧）`],
            ['trim_tail', t`裁切片段尾部（右侧）`],
            ['ignore_sequence_in', t`忽略 Timeline 入点`],
            ['ignore_sequence_out', t`忽略 Timeline 出点`],
          ] as const).map(([mode, label]) => {
            const available = pendingFitEdit !== null && exportRangeStart !== null && exportRangeEnd !== null
              && resolveSourceMediaFit({
                sourceRange: pendingFitEdit.sourceRange,
                sequenceRange: { start: exportRangeStart, end: exportRangeEnd },
                mediaDuration: mediaAssetEditDuration(pendingFitEdit.asset) ?? 0,
                mode,
              }) !== null;
            return <label key={mode} className="flex items-center gap-2 rounded-sm border border-divider px-3 py-2 text-xs">
              <input type="radio" name="source-fit-mode" value={mode} checked={sourceFitMode === mode} disabled={!available} onChange={() => setSourceFitMode(mode)} />
              <span>{label}</span>
            </label>;
          })}
        </div>
      </Dialog>
      <Dialog
        open={externalConfirm?.kind === 'recording'}
        title={<Trans>录制缺失片段</Trans>}
        confirmLabel={<Trans>开始录制</Trans>}
        confirmDisabled={deliveryGatePending
          || externalConfirm?.kind !== 'recording'
          || externalConfirm.clipIds.length === 0
          || externalConfirm.clipIds.some((clipId) => !recordableClipIds.includes(clipId))
          || startRecording.isPending}
        onConfirm={() => {
          if (externalConfirm?.kind !== 'recording') return;
          if (deliveryGatePending || externalConfirm.clipIds.some((clipId) => !recordableClipIds.includes(clipId))) return;
          const clipIds = [...externalConfirm.clipIds];
          setExternalConfirm(null);
          startRecording.mutate({ projectId: current.id, clipIds });
        }}
        onClose={() => setExternalConfirm(null)}
      >
        <p><Trans>将启动 CS2/HLAE，录制 {externalConfirm?.kind === 'recording' ? externalConfirm.clipIds.length : 0} 个尚未物化的时间线片段。</Trans></p>
      </Dialog>
      <Dialog
        open={externalConfirm?.kind === 'export'}
        title={<Trans>导出设置</Trans>}
        confirmLabel={<Trans>开始导出</Trans>}
        confirmDisabled={deliveryGatePending
          || currentDeliveryGate?.ready !== true
          || externalConfirm?.kind !== 'export'
          || (externalConfirm.draft.sourceRange === 'in_out' && !hasExportRange)
          || exportProject.isPending}
        onConfirm={() => {
          if (deliveryGatePending || currentDeliveryGate?.ready !== true || externalConfirm?.kind !== 'export') return;
          const draft = externalConfirm.draft;
          if (draft.sourceRange === 'in_out' && !hasExportRange) return;
          setExternalConfirm(null);
          exportProject.mutate({
            projectId: current.id,
            encoder: draft.encoder,
            quality: draft.quality,
            ...(draft.sourceRange === 'in_out' && exportRangeStart !== null && exportRangeEnd !== null
              ? { rangeStartSeconds: exportRangeStart, rangeEndSeconds: exportRangeEnd }
              : {}),
          });
        }}
        onClose={() => setExternalConfirm(null)}
      >
        {externalConfirm?.kind !== 'export' ? <span /> : (
          <div className="space-y-4 text-xs">
            <section className="grid grid-cols-[112px_minmax(0,1fr)] gap-x-3 gap-y-2 border-b border-divider pb-4">
              <span className="text-neutral-500"><Trans>格式</Trans></span>
              <strong className="font-medium">H.264 · MP4</strong>
              <span className="text-neutral-500"><Trans>序列</Trans></span>
              <span className="font-mono">{current.document.width}×{current.document.height} · {current.document.fps} fps</span>
            </section>
            <label className="grid grid-cols-[112px_minmax(0,1fr)] items-center gap-3">
              <Trans>编码性能</Trans>
              <select
                className="h-8 border border-divider bg-bg px-2"
                aria-label={t`编码性能`}
                value={externalConfirm.draft.encoder}
                onChange={(event) => setExternalConfirm({
                  kind: 'export',
                  draft: { ...externalConfirm.draft, encoder: event.currentTarget.value as ProjectExportDraft['encoder'] },
                })}
              >
                <option value="auto"><Trans>自动（硬件优先，软件回退）</Trans></option>
                <option value="libopenh264"><Trans>软件编码</Trans></option>
              </select>
            </label>
            <label className="grid grid-cols-[112px_minmax(0,1fr)_44px] items-center gap-3">
              <Trans>质量</Trans>
              <input
                type="range"
                min={1}
                max={100}
                step={1}
                aria-label={t`导出质量`}
                value={externalConfirm.draft.quality}
                onChange={(event) => setExternalConfirm({
                  kind: 'export',
                  draft: { ...externalConfirm.draft, quality: event.currentTarget.valueAsNumber },
                })}
              />
              <span className="text-right font-mono">{externalConfirm.draft.quality}</span>
            </label>
            <label className="grid grid-cols-[112px_minmax(0,1fr)] items-center gap-3">
              <Trans>源范围</Trans>
              <select
                className="h-8 border border-divider bg-bg px-2"
                aria-label={t`导出源范围`}
                value={externalConfirm.draft.sourceRange}
                onChange={(event) => setExternalConfirm({
                  kind: 'export',
                  draft: { ...externalConfirm.draft, sourceRange: event.currentTarget.value as ProjectExportDraft['sourceRange'] },
                })}
              >
                <option value="sequence"><Trans>完整序列</Trans> · {formatMillisecondTimecode(current.document.duration_seconds)}</option>
                <option value="in_out" disabled={!hasExportRange}>
                  <Trans>序列入点到出点</Trans>{!hasExportRange || exportRangeStart === null || exportRangeEnd === null
                    ? ''
                    : ` · ${formatMillisecondTimecode(exportRangeStart)}–${formatMillisecondTimecode(exportRangeEnd)}`}
                </option>
              </select>
            </label>
            <p className="text-2xs leading-4 text-neutral-500"><Trans>输出将作为受管 MP4 成品写入交付区；任务开始后可在 Agent 流中取消或打开输出。</Trans></p>
          </div>
        )}
      </Dialog>
      <Drawer
        open={inspectorOpen && selected !== null}
        title={<Trans>片段属性</Trans>}
        {...(selected === null ? {} : { description: selected.clip.name })}
        width="standard"
        onClose={() => setInspectorOpen(false)}
      >
        <ClipInspector
          selected={selected}
          readOnly={readOnly || selected?.track.locked === true}
          timelineTimeSeconds={transportTimeSeconds}
          fps={current.document.fps}
          onSeek={seekTimeline}
          onReplace={(clip) => {
            const track = selected?.track ?? null;
            const currentClip = track?.clips.find((candidate) => candidate.id === clip.id);
            if (track === null || track.locked || currentClip === undefined || sameTimelineClip(currentClip, clip)) return;
            if (track.id === current.document.story_track_id) {
              mutateTrackClipUpdates([{ trackId: track.id, clips: trimRippleClip(track.clips, clip) }]);
            } else {
              mutate(
                `修改 ${clip.name}`,
                { kind: 'track', track_id: track?.id ?? current.document.story_track_id },
                [{ op: 'replace_clip', clip_id: clip.id, clip }],
              );
            }
            setInspectorOpen(false);
          }}
        />
      </Drawer>
      {mutationError === null ? null : (
        <Alert
          className="m-4"
          variant="danger"
          detail={mutationErrorDetail ?? <Trans>检查当前 revision、录制环境和 Delivery Gate 后重试。</Trans>}
          action={{ label: <Trans>关闭</Trans>, onAction: () => { apply.reset(); revertChange.reset(); startRecording.reset(); exportProject.reset(); cancelTask.reset(); importMedia.reset(); relinkMedia.reset(); deleteMedia.reset(); } }}
        >
          <Trans>操作没有完成</Trans>
        </Alert>
      )}
    </Page>
  );
}

const TacticalPreview = memo(function TacticalPreview({ selected, timelineTimeSeconds, fps, showHeader = true }: {
  readonly selected: TimelineClip | null;
  readonly timelineTimeSeconds: number;
  readonly fps: number;
  readonly showHeader?: boolean;
}) {
  const intent = selected?.capture_intent ?? null;
  const demo = useDemo(intent?.demo_id ?? null);
  const mapName = demo.data?.map_name ?? null;
  const radar = useMapRadarOverview(mapName);
  const replay = useMatchReplay(intent?.demo_id ?? null, { enabled: intent !== null });
  const shell = useNativeShell();
  const radarSrc = radar.data?.image_url === null || radar.data?.image_url === undefined
    ? null
    : shell.mediaSrc(radar.data.image_url);
  const bounds = useMemo(
    () => intent === null ? null : { startTick: intent.start_tick, endTick: intent.end_tick },
    [intent],
  );
  const replaySlice = useMemo(() => sliceReplay(replay.data, bounds), [bounds, replay.data]);
  const localTime = selected === null ? 0 : clipLocalTimeAtTimeline(selected, timelineTimeSeconds, fps);
  const sourceTimeSeconds = selected === null ? 0 : clipSourceTimeAtLocalTime(selected, localTime);
  const transportDemoTick = selected === null || replaySlice === null
    ? null
    : clipDemoTickAtTimelineTime(selected, timelineTimeSeconds, replaySlice.tickRate);
  const currentTick = replaySlice === null || transportDemoTick === null
    ? null
    : clampTick(transportDemoTick, replaySlice);
  const frameIndex = replaySlice === null
    ? -1
    : frameIndexAtTick(replaySlice.frames, currentTick ?? replaySlice.startTick);
  const presentedReplayTick = replaySlice === null
    ? null
    : replaySlice.frames[frameIndex]?.tick ?? replaySlice.startTick;
  const tracks = useMemo(
    () => replaySlice === null ? [] : buildPlayerTracks(replaySlice.frames, frameIndex).paths,
    [frameIndex, replaySlice],
  );
  const markers = useMemo(
    () => replaySlice === null || frameIndex < 0 ? [] : playerMarkers(replaySlice.frames[frameIndex] ?? null),
    [frameIndex, replaySlice],
  );
  const candidate = useMemo<TacticalScene | null>(() => {
    if (
      selected === null
      || intent === null
      || mapName === null
      || radarSrc === null
      || presentedReplayTick === null
      || demo.isPending
      || radar.isPending
      || replay.isPending
    ) return null;
    return {
      sceneKey: `${selected.id}:${presentedReplayTick}`,
      mapName,
      radarSrc,
      transform: radar.data?.transform,
      label: t`${selected.name} 战术示意`,
      selectedPlayerId: intent.player_id,
      // A decoded radar remains useful even when this clip has no replay path;
      // empty overlays must not tear down the basemap while scrubbing.
      status: 'ready',
      tracks,
      markers,
      tick: presentedReplayTick,
    };
  }, [demo.isPending, intent, mapName, markers, presentedReplayTick, radar.data?.transform, radar.isPending, radarSrc, replay.isPending, selected, tracks]);
  const [displayed, setDisplayed] = useState<TacticalScene | null>(null);
  const [mountedRadarSources, setMountedRadarSources] = useState<readonly string[]>([]);
  const mountedRadarSourcesRef = useRef(new Set<string>());
  const readyRadarSourcesRef = useRef(new Set<string>());
  const pendingRadarScenesRef = useRef(new Map<string, TacticalScene>());
  const selectedSceneKeyRef = useRef(candidate?.sceneKey ?? null);
  selectedSceneKeyRef.current = candidate?.sceneKey ?? null;

  useLayoutEffect(() => {
    if (
      candidate !== null
      && readyRadarSourcesRef.current.has(candidate.radarSrc)
      && displayed?.sceneKey !== candidate.sceneKey
    ) setDisplayed(candidate);
  }, [candidate, displayed?.sceneKey]);

  useEffect(() => {
    if (selected === null || intent === null) {
      setDisplayed(null);
      return undefined;
    }
    if (mapName === null) return undefined;
    if (candidate === null) return undefined;
    if (mountedRadarSourcesRef.current.has(candidate.radarSrc)) {
      pendingRadarScenesRef.current.set(candidate.radarSrc, candidate);
      return undefined;
    }
    let cancelled = false;
    void preloadRadarImage(candidate.radarSrc)
      .catch(() => undefined)
      .then(() => {
        if (cancelled) return;
        pendingRadarScenesRef.current.set(candidate.radarSrc, candidate);
        if (mountedRadarSourcesRef.current.has(candidate.radarSrc)) {
          if (selectedSceneKeyRef.current === candidate.sceneKey) setDisplayed(candidate);
          return;
        }
        mountedRadarSourcesRef.current.add(candidate.radarSrc);
        setMountedRadarSources((current) => [...current, candidate.radarSrc]);
      });
    return () => {
      cancelled = true;
    };
  }, [candidate, intent, mapName, selected]);
  const renderTacticalLayers = useCallback((projection: MapProjection) => displayed === null ? null : (
    <>
      <PathLayer projection={projection} paths={displayed.tracks} selectedPlayerId={displayed.selectedPlayerId} />
      <PlayerLayer projection={projection} markers={displayed.markers} selectedPlayerId={displayed.selectedPlayerId} />
    </>
  ), [displayed]);

  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-bg" aria-label={t`战术示意`}>
      {showHeader ? <header className="flex h-[var(--h-ctl-md)] flex-none items-center border-b border-divider bg-bg px-4 text-xs font-semibold text-text">
        <Trans>战术示意</Trans>
      </header> : null}
      {selected === null || intent === null ? (
        <div className="grid min-h-0 flex-1 place-items-center px-5 text-center text-sm text-neutral-400">
          {selected === null ? <Trans>选择片段后显示路径与事件</Trans> : <Trans>这段素材没有可用的地图上下文</Trans>}
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden bg-accent-900">
          {mountedRadarSources.map((src) => (
            <img
              key={src}
              src={src}
              alt=""
              className="pointer-events-none absolute inset-0 z-0 size-full object-contain brightness-110 contrast-110 transition-opacity duration-75"
              style={{ opacity: displayed?.radarSrc === src ? 1 : 0 }}
              onLoad={() => {
                readyRadarSourcesRef.current.add(src);
                const scene = pendingRadarScenesRef.current.get(src);
                if (scene !== undefined && selectedSceneKeyRef.current === scene.sceneKey) setDisplayed(scene);
              }}
            />
          ))}
          {displayed === null ? (
            <div className="absolute inset-0 z-10 animate-pulse bg-neutral-800" role="status" aria-label={t`正在读取战术图`} />
          ) : (
            <>
              <StableMapCanvas
                mapName={displayed.mapName}
                overviewTransform={displayed.transform}
                label={displayed.label}
                status={displayed.status}
                className="relative z-10 h-full min-h-0 bg-transparent [&>div]:p-0 [&_.blueprint]:aspect-square [&_.blueprint]:h-full [&_.blueprint]:w-auto [&_.blueprint]:max-h-full [&_.blueprint]:max-w-full [&_.blueprint]:bg-transparent [&_figcaption]:hidden"
                basemap={TRANSPARENT_MAP_BASEMAP}
              >
                {renderTacticalLayers}
              </StableMapCanvas>
              {displayed.sceneKey === candidate?.sceneKey ? null : (
                <span className="pointer-events-none absolute left-3 top-3 z-20 flex items-center gap-1.5 rounded-sm bg-accent-900/85 px-2 py-1 text-2xs text-neutral-100">
                  <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
                  <Trans>正在更新战术图</Trans>
                </span>
              )}
              <ul className="absolute right-4 top-1/2 z-20 -translate-y-1/2 space-y-2 border border-neutral-500 bg-accent-900/95 px-3 py-2 text-2xs text-neutral-100 shadow-md">
                <li className="flex items-center gap-2"><span className="size-3 rounded-full border-2 border-bg bg-accent-500" /><span>CT</span></li>
                <li className="flex items-center gap-2"><span className="size-3 rounded-full border-2 border-bg bg-warn" /><span>T</span></li>
                <li className="flex items-center gap-2"><span className="size-3 bg-fail" /><Trans>炸弹点</Trans></li>
                <li className="flex items-center gap-2"><Star className="size-3.5 text-warn" fill="currentColor" aria-hidden="true" /><Trans>事件</Trans></li>
              </ul>
              <div className="absolute inset-x-0 bottom-0 z-20 flex h-8 items-center border-t border-divider bg-bg/95 px-3 text-xs text-text backdrop-blur-sm">
                <span><Trans>Demo tick: {currentTick ?? displayed.tick}</Trans></span>
                <span className="ml-4 font-mono"><Trans>素材时间: {sourceTimeSeconds.toFixed(3)}s</Trans></span>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
});

function ClipInspector({
  selected,
  readOnly,
  timelineTimeSeconds,
  fps,
  onSeek,
  onReplace,
}: {
  readonly selected: { readonly track: TimelineTrack; readonly clip: TimelineClip } | null;
  readonly readOnly: boolean;
  readonly timelineTimeSeconds: number;
  readonly fps: number;
  readonly onSeek: (seconds: number) => void;
  readonly onReplace: (clip: TimelineClip) => void;
}) {
  const [draft, setDraft] = useState<TimelineClip | null>(selected?.clip ?? null);
  const [effectKind, setEffectKind] = useState<SupportedEditorEffectKind>('color_adjust');
  useEffect(() => setDraft(selected?.clip ?? null), [selected?.clip]);
  if (draft === null) {
    return <aside className="flex items-center justify-center border-l border-divider p-5 text-sm text-neutral-600"><Trans>选择片段后编辑</Trans></aside>;
  }
  const localTime = clipLocalTimeAtTimeline(draft, timelineTimeSeconds, fps);
  const keyframeTimes = [...new Set(draft.keyframes.map((keyframe) => keyframe.time))].sort((left, right) => left - right);
  const currentFrameKeyframes = draft.keyframes.filter((keyframe) => Math.abs(keyframe.time - localTime) <= 0.5 / fps);
  const previousKeyframeTime = [...keyframeTimes].reverse().find((time) => time < localTime - 0.5 / fps);
  const nextKeyframeTime = keyframeTimes.find((time) => time > localTime + 0.5 / fps);
  const visualProperties: Array<{
    readonly property: Exclude<EditorKeyframeProperty, 'volume' | 'pan'>;
    readonly label: string;
    readonly step: number;
    readonly min?: number;
    readonly max?: number;
  }> = selected?.track.kind === 'audio'
    ? []
    : draft.text !== null
      ? [
        { property: 'x', label: t`位置 X`, step: 1 },
        { property: 'y', label: t`位置 Y`, step: 1 },
        { property: 'opacity', label: t`透明度`, step: 0.01, min: 0, max: 1 },
      ]
      : [
        { property: 'x', label: t`位置 X`, step: 1 },
        { property: 'y', label: t`位置 Y`, step: 1 },
        { property: 'scale_x', label: t`水平缩放`, step: 0.01, min: 0.01, max: 10 },
        { property: 'scale_y', label: t`垂直缩放`, step: 0.01, min: 0.01, max: 10 },
        { property: 'rotation', label: t`旋转`, step: 1 },
        { property: 'opacity', label: t`透明度`, step: 0.01, min: 0, max: 1 },
      ];
  const hasUnsupportedEnabledEffect = draft.effects.some((effect) => effect.enabled && !isSupportedEditorEffectKind(effect.kind));
  const draftChanged = selected !== null
    && draft.id === selected.clip.id
    && !sameTimelineClip(draft, selected.clip);
  const textStyle = draft.text;
  const mediaKind = typeof draft.metadata === 'object' && draft.metadata !== null && !Array.isArray(draft.metadata)
    && typeof draft.metadata.media_kind === 'string'
    ? draft.metadata.media_kind.toLowerCase()
    : '';
  const canTimeRemap = draft.text === null && selected?.track.kind !== 'text' && !mediaKind.startsWith('image');
  const speedBoundaryAtPlayhead = draft.speed_segments.some((segment) => (
    Math.abs(segment.start - localTime) <= 0.5 / fps || Math.abs(segment.end - localTime) <= 0.5 / fps
  ));
  return (
    <div className="min-h-0" aria-label={t`片段属性`}>
      <label className="flex flex-col gap-1 text-xs">
        <Trans>名称</Trans>
        <input disabled={readOnly} className="border border-divider px-2 py-1.5" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} />
      </label>
      {(['duration', 'source_in', 'source_out', 'speed'] as const).map((field) => (
        <label key={field} className="mt-3 flex flex-col gap-1 text-xs">
          {field}
          <input
            type="number"
            step="0.1"
            className="border border-divider px-2 py-1.5 font-mono"
            disabled={readOnly
              || draft.speed_segments.length > 0
              || (draft.placement.frame_hold_source_time !== null && field !== 'duration')}
            value={field === 'speed' && draft.placement.reverse ? -draft.placement.speed : draft.placement[field]}
            onChange={(event) => setDraft(updateClipTimingField(draft, field, Number(event.currentTarget.value), fps))}
          />
        </label>
      ))}
      {draft.text !== null || selected?.track.kind === 'text' ? null : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.placement.reverse}
              disabled={readOnly || draft.speed_segments.length > 0 || draft.placement.frame_hold_source_time !== null}
              onChange={(event) => setDraft({ ...draft, placement: { ...draft.placement, reverse: event.currentTarget.checked } })}
            />
            <Trans>反向播放</Trans>
          </label>
          <Button
            size="sm"
            variant={draft.placement.frame_hold_source_time === null ? 'secondary' : 'primary'}
            disabled={readOnly || draft.speed_segments.length > 0 || selected?.track.kind === 'audio'}
            onClick={() => setDraft({
              ...draft,
              placement: {
                ...draft.placement,
                reverse: false,
                frame_hold_source_time: draft.placement.frame_hold_source_time === null
                  ? clipSourceTimeAtLocalTime(draft, localTime)
                  : null,
              },
            })}
          >
            {draft.placement.frame_hold_source_time === null ? <Trans>定格当前帧</Trans> : <Trans>取消定格</Trans>}
          </Button>
        </div>
      )}
      {!canTimeRemap ? null : (
        <section className="mt-4 border-t border-divider pt-3" aria-label={t`时间重映射`}>
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold"><Trans>时间重映射</Trans></h3>
            {draft.speed_segments.length === 0 ? (
              <Button
                className="ml-auto"
                size="sm"
                variant="secondary"
                disabled={readOnly || draft.placement.reverse || draft.placement.frame_hold_source_time !== null}
                onClick={() => setDraft(enableClipTimeRemapping(draft, globalThis.crypto.randomUUID()))}
              >
                <Trans>启用</Trans>
              </Button>
            ) : (
              <Button
                className="ml-auto"
                size="sm"
                variant="ghost"
                disabled={readOnly}
                onClick={() => setDraft(disableClipTimeRemapping(draft))}
              >
                <Trans>恢复恒定速度</Trans>
              </Button>
            )}
          </div>
          {draft.speed_segments.length === 0 ? (
            <p className="mt-2 text-2xs leading-4 text-neutral-500"><Trans>启用后可在播放头添加速度关键帧，并分别调整片段各区间的速度。</Trans></p>
          ) : (
            <>
              <Button
                className="mt-2 w-full"
                size="sm"
                variant="secondary"
                disabled={readOnly
                  || localTime <= 0.5 / fps
                  || localTime >= draft.placement.duration - 0.5 / fps
                  || speedBoundaryAtPlayhead}
                onClick={() => setDraft(splitClipSpeedSegment(
                  draft,
                  localTime,
                  globalThis.crypto.randomUUID(),
                  fps,
                ))}
              >
                <Plus className="size-3.5" aria-hidden="true" />
                <Trans>在播放头添加速度关键帧</Trans>
              </Button>
              <ol className="mt-2 list-none space-y-1.5">
                {draft.speed_segments.map((segment, index) => (
                  <li
                    key={segment.id}
                    className="grid grid-cols-[minmax(0,1fr)_90px_28px] items-center gap-2 border border-divider bg-neutral-50 px-2 py-1.5"
                    data-speed-segment-id={segment.id}
                  >
                    <span className="min-w-0 truncate font-mono text-2xs text-neutral-600">
                      {segment.start.toFixed(3)}–{segment.end.toFixed(3)}s
                    </span>
                    <label className="flex min-w-0 items-center gap-1 text-2xs">
                      <span className="sr-only"><Trans>区间速度</Trans></span>
                      <input
                        type="number"
                        min={MIN_TIMELINE_CLIP_SPEED * 100}
                        max={MAX_TIMELINE_CLIP_SPEED * 100}
                        step={1}
                        className="min-w-0 flex-1 border border-divider bg-bg px-1.5 py-1 text-right font-mono"
                        aria-label={t`区间 ${index + 1} 速度百分比`}
                        disabled={readOnly}
                        value={Number((segment.speed * 100).toFixed(3))}
                        onChange={(event) => setDraft(setClipSpeedSegmentSpeed(
                          draft,
                          segment.id,
                          event.currentTarget.valueAsNumber / 100,
                          fps,
                        ))}
                      />
                      <span>%</span>
                    </label>
                    <button
                      type="button"
                      className="grid size-7 place-items-center rounded-sm text-fail-text hover:bg-fail-surface disabled:text-neutral-300"
                      aria-label={t`删除区间 ${index + 1} 前的速度关键帧`}
                      disabled={readOnly || index === 0}
                      onClick={() => setDraft(removeClipSpeedBoundary(draft, segment.id))}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-2xs leading-4 text-neutral-500"><Trans>调整区间速度会改变该区间和片段时长，但保持源 In/Out 不变；Story 后续片段将在保存时波纹移动。</Trans></p>
            </>
          )}
        </section>
      )}
      {draft.capture_intent === null ? null : (
        <section className="mt-4 border-t border-divider pt-3" aria-label={t`录制范围`}>
          <h3 className="text-xs font-semibold"><Trans>录制范围</Trans></h3>
          <label className="mt-2 flex flex-col gap-1 text-xs">
            <Trans>录制视角</Trans>
            <select
              className="border border-divider bg-bg px-2 py-1.5"
              disabled={readOnly}
              value={draft.capture_intent.camera_style}
              aria-label={t`录制视角`}
              onChange={(event) => setDraft(updateCaptureIntent(draft, {
                camera_style: event.currentTarget.value as NonNullable<TimelineClip['capture_intent']>['camera_style'],
              }))}
            >
              <option value="pov"><Trans>第一人称</Trans></option>
              <option value="static"><Trans>固定机位</Trans></option>
              <option value="tracking"><Trans>跟随</Trans></option>
              <option value="dolly"><Trans>推轨</Trans></option>
              <option value="orbit"><Trans>环绕</Trans></option>
              <option value="crane"><Trans>升降</Trans></option>
              <option value="flyby"><Trans>掠过</Trans></option>
            </select>
          </label>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <CaptureIntentNumberField label={t`开始 tick`} value={draft.capture_intent.start_tick} step={1} readOnly={readOnly} onChange={(value) => setDraft(updateCaptureIntent(draft, { start_tick: Math.max(0, Math.trunc(value)) }))} />
            <CaptureIntentNumberField label={t`结束 tick`} value={draft.capture_intent.end_tick} step={1} readOnly={readOnly} onChange={(value) => setDraft(updateCaptureIntent(draft, { end_tick: Math.max(0, Math.trunc(value)) }))} />
            <CaptureIntentNumberField label={t`前留白（秒）`} value={draft.capture_intent.pre_roll_seconds} step={0.1} readOnly={readOnly} onChange={(value) => setDraft(updateCaptureIntent(draft, { pre_roll_seconds: Math.max(0, value) }))} />
            <CaptureIntentNumberField label={t`后留白（秒）`} value={draft.capture_intent.post_roll_seconds} step={0.1} readOnly={readOnly} onChange={(value) => setDraft(updateCaptureIntent(draft, { post_roll_seconds: Math.max(0, value) }))} />
          </div>
          <span className="mt-1 block text-2xs text-neutral-500"><Trans>非第一人称视角需要片段范围内至少四个空间采样点；回合边界镜头应在回合结束前停止。</Trans></span>
          {draft.material.kind === 'planned' ? null : (
            <Button
              className="mt-2 w-full"
              size="sm"
              variant="secondary"
              disabled={readOnly}
              onClick={() => onReplace({ ...draft, material: { kind: 'planned' } })}
            >
              <Trans>重新录制（保留旧文件）</Trans>
            </Button>
          )}
        </section>
      )}
      {textStyle === null ? null : (
        <section className="mt-4 border-t border-divider pt-3" aria-label={t`文字样式`}>
          <h3 className="text-xs font-semibold"><Trans>文字样式</Trans></h3>
          <label className="mt-2 flex flex-col gap-1 text-xs">
            <Trans>文字内容</Trans>
            <textarea
              rows={4}
              maxLength={1_000}
              className="resize-y border border-divider bg-bg px-2 py-1.5"
              disabled={readOnly}
              value={textStyle.content}
              onChange={(event) => setDraft({ ...draft, text: { ...textStyle, content: event.currentTarget.value } })}
            />
          </label>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs">
              <Trans>字体</Trans>
              <input
                className="border border-divider bg-bg px-2 py-1.5"
                disabled={readOnly}
                value={textStyle.font_family}
                onChange={(event) => setDraft({ ...draft, text: { ...textStyle, font_family: event.currentTarget.value } })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <Trans>字号</Trans>
              <input
                type="number"
                min={6}
                max={512}
                step={1}
                className="border border-divider bg-bg px-2 py-1.5 font-mono"
                disabled={readOnly}
                value={textStyle.font_size}
                onChange={(event) => setDraft({ ...draft, text: { ...textStyle, font_size: Number(event.currentTarget.value) } })}
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Trans>文字颜色</Trans>
              <input
                type="color"
                disabled={readOnly}
                value={htmlColorInputValue(textStyle.color, 'white')}
                onChange={(event) => setDraft({ ...draft, text: { ...textStyle, color: event.currentTarget.value.toUpperCase() } })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <Trans>对齐</Trans>
              <select
                className="border border-divider bg-bg px-2 py-1.5"
                disabled={readOnly}
                value={textStyle.align}
                onChange={(event) => setDraft({ ...draft, text: { ...textStyle, align: event.currentTarget.value } })}
              >
                <option value="left"><Trans>左对齐</Trans></option>
                <option value="center"><Trans>居中</Trans></option>
                <option value="right"><Trans>右对齐</Trans></option>
              </select>
            </label>
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              disabled={readOnly}
              checked={textStyle.background !== null}
              onChange={(event) => setDraft({
                ...draft,
                text: { ...textStyle, background: event.currentTarget.checked ? 'black' : null },
              })}
            />
            <Trans>启用文字背景</Trans>
          </label>
          {textStyle.background === null ? null : (
            <label className="mt-2 flex items-center gap-2 text-xs">
              <Trans>背景颜色</Trans>
              <input
                type="color"
                disabled={readOnly}
                value={htmlColorInputValue(textStyle.background, 'black')}
                onChange={(event) => setDraft({ ...draft, text: { ...textStyle, background: event.currentTarget.value.toUpperCase() } })}
              />
            </label>
          )}
        </section>
      )}
      {draft.text !== null || selected?.track.kind === 'text' ? null : (() => {
        const audioProperties = [
          { property: 'volume' as const, label: t`音量`, min: 0, max: 4, step: 0.01, fallback: draft.placement.volume },
          { property: 'pan' as const, label: t`声像`, min: -1, max: 1, step: 0.01, fallback: draft.placement.pan },
        ];
        return (
          <section className="mt-4 border-t border-divider pt-3" aria-label={t`音频自动化`}>
            {audioProperties.map(({ property, label, min, max, step, fallback }) => {
              const propertyKeyframes = draft.keyframes.filter((keyframe) => keyframe.property === property);
              const current = clipKeyframeAtTime(draft, property, localTime, fps);
              const value = evaluateClipKeyframeProperty(draft, property, localTime, fallback);
              return <div key={property} className="mt-2 grid grid-cols-[minmax(0,1fr)_88px_28px] items-center gap-2 text-xs">
                <span>{label}{propertyKeyframes.length === 0 ? null : <span className="ml-1 text-2xs text-neutral-500">{propertyKeyframes.length}</span>}</span>
                <input
                  type="number"
                  min={min}
                  max={max}
                  step={step}
                  className="min-w-0 border border-divider px-2 py-1.5 font-mono"
                  disabled={readOnly}
                  value={value}
                  aria-label={label}
                  onChange={(event) => setDraft(property === 'volume'
                    ? setClipVolumeAtTime(draft, localTime, Number(event.currentTarget.value), fps, globalThis.crypto.randomUUID())
                    : setClipPanAtTime(draft, localTime, Number(event.currentTarget.value), fps, globalThis.crypto.randomUUID()))}
                />
                <button
                  type="button"
                  className={cn(
                    'grid size-7 place-items-center rounded-sm border border-divider hover:bg-neutral-100 disabled:text-neutral-300',
                    current !== null && 'border-accent-300 bg-accent-100 text-accent-text',
                  )}
                  disabled={readOnly}
                  aria-label={current === null ? t`在播放头添加 ${label} 关键帧` : t`删除播放头的 ${label} 关键帧`}
                  onClick={() => setDraft(current === null
                    ? upsertClipKeyframe(draft, property, localTime, value, globalThis.crypto.randomUUID(), fps)
                    : removeClipKeyframe(draft, property, localTime, fps))}
                >
                  <Diamond className="size-3" fill={current === null ? 'none' : 'currentColor'} aria-hidden="true" />
                </button>
              </div>;
            })}
          </section>
        );
      })()}
      {currentFrameKeyframes.length === 0 ? null : (
        <section className="mt-4 border-t border-divider pt-3" aria-label={t`关键帧插值`}>
          <h3 className="mb-2 text-xs font-semibold"><Trans>关键帧插值</Trans></h3>
          {currentFrameKeyframes.map((keyframe) => (
            <div key={keyframe.id} className="mt-2 grid grid-cols-[minmax(0,1fr)_110px] gap-2 text-xs">
              <span className="truncate font-mono text-2xs">{keyframe.property}</span>
              <select
                className="border border-divider bg-bg px-2 py-1"
                aria-label={t`${keyframe.property} 插值`}
                disabled={readOnly}
                value={keyframe.interpolation}
                onChange={(event) => {
                  const interpolation = event.currentTarget.value as EditorKeyframeInterpolation;
                  setDraft({ ...draft, keyframes: draft.keyframes.map((candidate) => candidate.id === keyframe.id
                    ? { ...candidate, interpolation }
                    : candidate) });
                }}
              >
                <option value="hold"><Trans>保持</Trans></option>
                <option value="linear"><Trans>线性</Trans></option>
                <option value="bezier">Bezier</option>
                <option value="ease_in">Ease In</option>
                <option value="ease_out">Ease Out</option>
                <option value="ease_in_out">Ease In/Out</option>
              </select>
              {keyframe.interpolation !== 'bezier' ? null : (
                <div className="col-span-2 grid grid-cols-2 gap-2">
                  {([
                    ['in_tangent', t`入切线`],
                    ['out_tangent', t`出切线`],
                  ] as const).map(([field, label]) => (
                    <label key={field} className="flex items-center gap-2">
                      <span className="flex-1">{label}</span>
                      <input
                        type="number"
                        step={0.1}
                        className="w-20 border border-divider bg-bg px-2 py-1 font-mono"
                        aria-label={t`${keyframe.property} ${label}`}
                        disabled={readOnly}
                        value={keyframe[field]}
                        onChange={(event) => {
                          const value = Number(event.currentTarget.value);
                          setDraft({ ...draft, keyframes: draft.keyframes.map((candidate) => candidate.id === keyframe.id
                            ? { ...candidate, [field]: value }
                            : candidate) });
                        }}
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </section>
      )}
      {visualProperties.length === 0 ? null : (
        <section className="mt-4 border-t border-divider pt-3" aria-label={t`变换与关键帧`}>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-xs font-semibold"><Trans>变换</Trans></h3>
            <span className="flex items-center overflow-hidden rounded-sm border border-divider">
              <button
                type="button"
                className="grid size-6 place-items-center hover:bg-neutral-100 disabled:text-neutral-300"
                aria-label={t`上一个关键帧`}
                disabled={previousKeyframeTime === undefined}
                onClick={() => previousKeyframeTime === undefined ? undefined : onSeek(draft.placement.start + previousKeyframeTime)}
              ><ChevronLeft className="size-3" aria-hidden="true" /></button>
              <button
                type="button"
                className="grid size-6 place-items-center border-l border-divider hover:bg-neutral-100 disabled:text-neutral-300"
                aria-label={t`下一个关键帧`}
                disabled={nextKeyframeTime === undefined}
                onClick={() => nextKeyframeTime === undefined ? undefined : onSeek(draft.placement.start + nextKeyframeTime)}
              ><ChevronRight className="size-3" aria-hidden="true" /></button>
            </span>
            <span className="ml-auto font-mono text-2xs text-neutral-500"><Trans>片段内</Trans> {localTime.toFixed(3)}s</span>
          </div>
          {visualProperties.map(({ property, label, step, min, max }) => {
            const propertyKeyframes = draft.keyframes.filter((keyframe) => keyframe.property === property);
            const current = clipKeyframeAtTime(draft, property, localTime, fps);
            const animationAllowed = canAnimateTransformProperty(draft, property);
            const fallback = draft.transform[property];
            const value = evaluateClipKeyframeProperty(draft, property, localTime, fallback);
            return (
              <div key={property} className="mt-2 grid grid-cols-[minmax(0,1fr)_88px_28px] items-center gap-2 text-xs">
                <span className="truncate">{label}{propertyKeyframes.length === 0 ? null : <span className="ml-1 text-2xs text-neutral-500">{propertyKeyframes.length}</span>}</span>
                <input
                  type="number"
                  step={step}
                  {...(min === undefined ? {} : { min })}
                  {...(max === undefined ? {} : { max })}
                  className="min-w-0 border border-divider px-2 py-1.5 font-mono"
                  disabled={readOnly || (!animationAllowed && (property === 'rotation' || propertyKeyframes.length > 0))}
                  value={value}
                  onChange={(event) => {
                    const nextValue = Number(event.currentTarget.value);
                    if (propertyKeyframes.length === 0) {
                      setDraft({ ...draft, transform: { ...draft.transform, [property]: nextValue } });
                    } else {
                      setDraft(upsertClipKeyframe(draft, property, localTime, nextValue, globalThis.crypto.randomUUID(), fps));
                    }
                  }}
                  aria-label={label}
                />
                <button
                  type="button"
                  className={cn(
                    'grid size-7 place-items-center rounded-sm border border-divider hover:bg-neutral-100 disabled:text-neutral-300',
                    current !== null && 'border-accent-300 bg-accent-100 text-accent-text',
                  )}
                  disabled={readOnly || (current === null && !animationAllowed)}
                  aria-label={current === null ? t`在播放头添加 ${label} 关键帧` : t`删除播放头的 ${label} 关键帧`}
                  onClick={() => setDraft(current === null
                    ? upsertClipKeyframe(draft, property, localTime, value, globalThis.crypto.randomUUID(), fps)
                    : removeClipKeyframe(draft, property, localTime, fps))}
                >
                  <Diamond className="size-3" fill={current === null ? 'none' : 'currentColor'} aria-hidden="true" />
                </button>
              </div>
            );
          })}
          {draft.keyframes.some((keyframe) => ['scale_x', 'scale_y', 'rotation'].includes(keyframe.property))
            ? <p className="mt-2 text-2xs text-neutral-500"><Trans>动画缩放与旋转不能同时启用；这是导出渲染器的组合约束。</Trans></p>
            : null}
        </section>
      )}
      {draft.text === null && (selected?.track.kind === 'video' || selected?.track.kind === 'overlay') ? (
        <section className="mt-4 border-t border-divider pt-3" aria-label={t`效果`}>
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold"><Trans>效果</Trans> <span className="text-2xs text-neutral-500">{draft.effects.length}</span></h3>
            <select
              className="ml-auto h-7 min-w-0 border border-divider bg-bg px-2 text-2xs"
              aria-label={t`添加效果类型`}
              disabled={readOnly}
              value={effectKind}
              onChange={(event) => setEffectKind(event.currentTarget.value as SupportedEditorEffectKind)}
            >
              <option value="color_adjust"><Trans>颜色调整</Trans></option>
              <option value="grayscale"><Trans>黑白</Trans></option>
              <option value="blur"><Trans>模糊</Trans></option>
            </select>
            <button
              type="button"
              className="grid size-7 place-items-center rounded-sm border border-divider hover:bg-neutral-100 disabled:text-neutral-300"
              aria-label={t`添加效果`}
              disabled={readOnly}
              onClick={() => setDraft({ ...draft, effects: [...draft.effects, createEditorEffect(effectKind, globalThis.crypto.randomUUID())] })}
            ><Plus className="size-3.5" aria-hidden="true" /></button>
          </div>
          <ol className="mt-2 list-none space-y-2">
            {draft.effects.map((effect, index) => {
              const supportedKind = isSupportedEditorEffectKind(effect.kind) ? effect.kind : null;
              const schema = supportedKind === null ? [] : EDITOR_EFFECT_SCHEMAS[supportedKind];
              return (
                <li key={effect.id} className="border border-divider bg-neutral-100/50 p-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      aria-label={t`启用效果 ${effectLabel(effect.kind)}`}
                      disabled={readOnly}
                      checked={effect.enabled}
                      onChange={(event) => setDraft({
                        ...draft,
                        effects: draft.effects.map((candidate) => candidate.id === effect.id
                          ? { ...candidate, enabled: event.currentTarget.checked }
                          : candidate),
                      })}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{effectLabel(effect.kind)}</span>
                    <button type="button" className="grid size-6 place-items-center hover:bg-neutral-200 disabled:text-neutral-300" aria-label={t`上移效果 ${effectLabel(effect.kind)}`} disabled={readOnly || index === 0} onClick={() => setDraft({ ...draft, effects: moveEditorEffect(draft.effects, effect.id, -1) })}><ChevronUp className="size-3" aria-hidden="true" /></button>
                    <button type="button" className="grid size-6 place-items-center hover:bg-neutral-200 disabled:text-neutral-300" aria-label={t`下移效果 ${effectLabel(effect.kind)}`} disabled={readOnly || index === draft.effects.length - 1} onClick={() => setDraft({ ...draft, effects: moveEditorEffect(draft.effects, effect.id, 1) })}><ChevronDown className="size-3" aria-hidden="true" /></button>
                    <button type="button" className="grid size-6 place-items-center text-fail-text hover:bg-fail-surface disabled:text-neutral-300" aria-label={t`删除效果 ${effectLabel(effect.kind)}`} disabled={readOnly} onClick={() => setDraft({ ...draft, effects: draft.effects.filter((candidate) => candidate.id !== effect.id) })}><Trash2 className="size-3" aria-hidden="true" /></button>
                  </div>
                  {supportedKind === null ? <p className="mt-1 text-2xs text-fail-text"><Trans>该效果不受当前渲染器支持，请禁用或删除。</Trans></p> : null}
                  {schema.map((parameter) => (
                    <label key={parameter.key} className="mt-2 grid grid-cols-[minmax(0,1fr)_88px] items-center gap-2 text-2xs">
                      <span>{effectParameterLabel(parameter.key)}</span>
                      <input
                        type="number"
                        min={parameter.minimum}
                        max={parameter.maximum}
                        step={parameter.step}
                        className="min-w-0 border border-divider bg-bg px-2 py-1 font-mono"
                        aria-label={`${effectLabel(effect.kind)} ${effectParameterLabel(parameter.key)}`}
                        disabled={readOnly || !effect.enabled}
                        value={editorEffectParameter(effect, parameter)}
                        onChange={(event) => setDraft({
                          ...draft,
                          effects: draft.effects.map((candidate) => candidate.id === effect.id
                            ? setEditorEffectParameter(candidate, parameter, Number(event.currentTarget.value))
                            : candidate),
                        })}
                      />
                    </label>
                  ))}
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
      {draft.text !== null ? null : ([
        { field: 'video_in', label: t`视频入场转场`, channel: 'video', edge: 'in' },
        { field: 'video_out', label: t`视频出场转场`, channel: 'video', edge: 'out' },
        { field: 'audio_in', label: t`音频入场转场`, channel: 'audio', edge: 'in' },
        { field: 'audio_out', label: t`音频出场转场`, channel: 'audio', edge: 'out' },
      ] as const)
        .filter((item) => selected?.track.kind !== 'audio' || item.channel === 'audio')
        .map((item) => {
          const transition = draft.transitions[item.field];
          const otherField = `${item.channel}_${item.edge === 'in' ? 'out' : 'in'}` as keyof TimelineClip['transitions'];
          const otherDuration = draft.transitions[otherField]?.duration_seconds ?? 0;
          const maximumDuration = Math.max(0, Math.min(5, draft.placement.duration - otherDuration - 1 / fps));
          const setTransitionKind = (kind: EditorTransitionKind | null) => setDraft({
            ...draft,
            transitions: {
              ...draft.transitions,
              [item.field]: kind === null ? null : {
                kind,
                duration_seconds: snapTimeToFrame(Math.min(maximumDuration, transition?.duration_seconds ?? 1), fps),
              },
            },
          });
          return (
            <section key={item.field} className="mt-3 border-t border-divider pt-3" aria-label={item.label}>
              <label className="flex flex-col gap-1 text-xs">
                {item.label}
                <select
                  className="border border-divider bg-bg px-2 py-1.5"
                  disabled={readOnly || maximumDuration < 0.05}
                  value={transition?.kind ?? ''}
                  onChange={(event) => setTransitionKind(event.currentTarget.value === '' ? null : event.currentTarget.value as EditorTransitionKind)}
                >
                  <option value=""><Trans>无</Trans></option>
                  {item.channel === 'audio' ? (
                    <>
                      <option value="constant_power"><Trans>恒定功率</Trans></option>
                      <option value="fade"><Trans>线性淡化</Trans></option>
                    </>
                  ) : (
                    <>
                      <option value="fade"><Trans>淡化</Trans></option>
                      <option value="dip"><Trans>黑场</Trans></option>
                      <option value="flash"><Trans>闪白</Trans></option>
                      <option value="zoom"><Trans>缩放</Trans></option>
                      <option value="wipe"><Trans>擦除</Trans></option>
                      <option value="slide"><Trans>滑动</Trans></option>
                      <option value="blur"><Trans>模糊</Trans></option>
                      <option value="glitch"><Trans>故障</Trans></option>
                      <option value="spin"><Trans>旋转</Trans></option>
                    </>
                  )}
                </select>
              </label>
              {transition === null ? null : (
                <label className="mt-2 flex flex-col gap-1 text-xs">
                  <Trans>持续时间（秒）</Trans>
                  <input
                    type="number"
                    min={0.05}
                    max={maximumDuration}
                    step={1 / fps}
                    className="border border-divider bg-bg px-2 py-1.5 font-mono"
                    aria-label={`${item.label} ${t`持续时间`}`}
                    disabled={readOnly}
                    value={transition.duration_seconds}
                    onChange={(event) => setDraft({
                      ...draft,
                      transitions: {
                        ...draft.transitions,
                        [item.field]: {
                          ...transition,
                          duration_seconds: snapTimeToFrame(Math.min(maximumDuration, Math.max(0.05, event.currentTarget.valueAsNumber)), fps),
                        },
                      },
                    })}
                  />
                </label>
              )}
            </section>
          );
        })}
      <label className="mt-3 flex items-center gap-2 text-xs">
        <input type="checkbox" disabled={readOnly} checked={draft.placement.enabled} onChange={(event) => setDraft({ ...draft, placement: { ...draft.placement, enabled: event.currentTarget.checked } })} />
        <Trans>启用片段</Trans>
      </label>
      <Button className="mt-5 w-full" variant="primary" disabled={readOnly || hasUnsupportedEnabledEffect || !draftChanged} onClick={() => onReplace(draft)}><Trans>保存修改</Trans></Button>
    </div>
  );
}

function sameTimelineClip(left: TimelineClip, right: TimelineClip): boolean {
  // TimelineClip is a generated JSON document: array order is semantic and
  // object keys keep their schema order through every editor update.
  return JSON.stringify(left) === JSON.stringify(right);
}

function updateCaptureIntent(
  clip: TimelineClip,
  update: Partial<NonNullable<TimelineClip['capture_intent']>>,
): TimelineClip {
  if (clip.capture_intent === null) return clip;
  return { ...clip, capture_intent: { ...clip.capture_intent, ...update } };
}

function htmlColorInputValue(color: string, fallback: 'white' | 'black'): string {
  if (/^#[0-9A-F]{6}$/iu.test(color)) return color.toUpperCase();
  const named = color.trim().toLowerCase();
  const digit = (named === 'white' || (named !== 'black' && fallback === 'white')) ? 'F' : '0';
  return `#${digit.repeat(6)}`;
}

function CaptureIntentNumberField({
  label,
  value,
  step,
  readOnly,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly step: number;
  readonly readOnly: boolean;
  readonly onChange: (value: number) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-2xs">
      {label}
      <input
        type="number"
        min={0}
        step={step}
        className="min-w-0 border border-divider bg-bg px-2 py-1.5 font-mono"
        disabled={readOnly}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}

function updateClipTimingField(
  clip: TimelineClip,
  field: 'duration' | 'source_in' | 'source_out' | 'speed',
  value: number,
  fps: number,
): TimelineClip {
  if (!Number.isFinite(value) || clip.speed_segments.length > 0) return clip;
  const placement = clip.placement;
  if (placement.frame_hold_source_time !== null) {
    if (field !== 'duration') return clip;
    return {
      ...clip,
      placement: { ...placement, duration: Math.max(1 / Math.max(1, fps), value) },
    };
  }
  if (field === 'duration') {
    return rateStretchTimelineClip(clip, 'end', placement.start + value, fps);
  }
  if (field === 'speed') {
    const speed = Math.min(MAX_TIMELINE_CLIP_SPEED, Math.max(MIN_TIMELINE_CLIP_SPEED, Math.abs(value)));
    const sourceDuration = placement.source_out - placement.source_in;
    const stretched = rateStretchTimelineClip(clip, 'end', placement.start + sourceDuration / speed, fps);
    return { ...stretched, placement: { ...stretched.placement, reverse: value < 0 } };
  }
  const frame = 1 / Math.max(1, fps);
  if (field === 'source_in') {
    const sourceIn = Math.min(
      placement.source_out - placement.speed * frame,
      Math.max(0, value),
    );
    if (placement.reverse) {
      return {
        ...clip,
        placement: {
          ...placement,
          duration: (placement.source_out - sourceIn) / placement.speed,
          source_in: sourceIn,
        },
      };
    }
    const timelineDelta = (sourceIn - placement.source_in) / placement.speed;
    return {
      ...clip,
      placement: {
        ...placement,
        start: placement.start + timelineDelta,
        duration: (placement.source_out - sourceIn) / placement.speed,
        source_in: sourceIn,
      },
    };
  }
  const mediaDuration = clip.material.kind === 'planned'
    ? Number.POSITIVE_INFINITY
    : clip.material.media_duration_seconds;
  const sourceOut = Math.min(
    mediaDuration,
    Math.max(placement.source_in + placement.speed * frame, value),
  );
  if (placement.reverse) {
    const fixedEnd = placement.start + placement.duration;
    const duration = (sourceOut - placement.source_in) / placement.speed;
    return {
      ...clip,
      placement: {
        ...placement,
        start: fixedEnd - duration,
        duration,
        source_out: sourceOut,
      },
    };
  }
  return {
    ...clip,
    placement: {
      ...placement,
      duration: (sourceOut - placement.source_in) / placement.speed,
      source_out: sourceOut,
    },
  };
}

function effectLabel(kind: string): string {
  switch (kind) {
    case 'color_adjust': return t`颜色调整`;
    case 'grayscale': return t`黑白`;
    case 'blur': return t`模糊`;
    default: return kind;
  }
}

function effectParameterLabel(key: string): string {
  switch (key) {
    case 'brightness': return t`亮度`;
    case 'contrast': return t`对比度`;
    case 'saturation': return t`饱和度`;
    case 'radius': return t`半径`;
    default: return key;
  }
}

interface AgentPanelProps {
  readonly showHeader?: boolean;
  readonly session: import('../shared/desktop/dto').AgentSession | null;
  readonly chat: ReturnType<typeof useAgentChatStream>;
  readonly creatingSession: boolean;
  readonly onSend: (message: string) => Promise<void>;
  readonly changeGroups: readonly ProjectChangeGroup[];
  readonly readOnly: boolean;
  readonly agentReady: boolean;
  readonly agentStatusPending: boolean;
  readonly deliveryReady: boolean;
  readonly deliveryGatePending: boolean;
  readonly externalExecutions: readonly ActivityItem[];
  readonly executionActionPending: boolean;
  readonly onCancelExecution: (execution: ActivityItem) => void;
  readonly onOpenOutputs: () => void;
  readonly onOpenAgentSettings: () => void;
  readonly confirming: boolean;
  readonly onConfirmRecording: (toolCallId: string, clipIds: string[]) => Promise<void>;
  readonly onConfirmExport: (toolCallId: string) => Promise<void>;
  readonly onRejectConfirmation: (toolCallId: string) => Promise<void>;
  readonly onAcceptDelivery: (changeGroupId: string) => Promise<void>;
  readonly onReturnDelivery: (changeGroupId: string, feedback: string) => Promise<void>;
  readonly onDirectEdit: (changeGroupId: string) => void;
}

const AgentPanel = memo(function AgentPanel({
  showHeader = true,
  session,
  chat,
  creatingSession,
  onSend,
  changeGroups,
  readOnly,
  agentReady,
  agentStatusPending,
  deliveryReady,
  deliveryGatePending,
  externalExecutions,
  executionActionPending,
  onCancelExecution,
  onOpenOutputs,
  onOpenAgentSettings,
  confirming,
  onConfirmRecording,
  onConfirmExport,
  onRejectConfirmation,
  onAcceptDelivery,
  onReturnDelivery,
  onDirectEdit,
}: AgentPanelProps) {
  const [message, setMessage] = useState('');
  const [returningChangeGroupId, setReturningChangeGroupId] = useState<string | null>(null);
  const conversationEnd = useRef<HTMLDivElement>(null);
  const messageInput = useRef<HTMLInputElement>(null);
  const entries = session?.entries ?? [];
  const pendingConfirmationToolCallId = pendingConfirmationToolCall(entries);
  const toolDecisions = new Map<string, ToolDecisionEntry>();
  for (const entry of entries) {
    if (entry.kind === 'tool_decision') toolDecisions.set(entry.tool_call_id, entry);
  }
  const reviewGroup = pendingDeliveryGroup(changeGroups, session);
  const hasDelivery = !chat.streaming
    && pendingConfirmationToolCallId === null
    && reviewGroup !== null
    && [...entries].reverse().some((entry) => entry.kind === 'assistant' && entry.status === 'completed');
  const submit = () => {
    const next = message.trim();
    if (next === '' || chat.streaming || creatingSession || readOnly || !agentReady) return;
    setMessage('');
    const changeGroupId = returningChangeGroupId;
    setReturningChangeGroupId(null);
    if (changeGroupId === null) void onSend(next);
    else void onReturnDelivery(changeGroupId, next);
  };
  useEffect(() => {
    if (returningChangeGroupId !== null && reviewGroup?.id !== returningChangeGroupId) {
      setReturningChangeGroupId(null);
    }
  }, [returningChangeGroupId, reviewGroup?.id]);
  useEffect(() => {
    conversationEnd.current?.scrollIntoView({ block: 'end' });
  }, [session?.id, entries.length, chat.draft, chat.activity?.length]);
  return (
    <aside className="flex min-h-0 flex-col border-l border-divider bg-bg" aria-label={t`Agent 面板`}>
      {showHeader ? <header className="flex h-[42px] flex-none items-center gap-2 border-b border-divider px-5">
        <span className="grid size-6 place-items-center rounded-full bg-accent-100 text-accent-text"><Sparkles className="size-3.5" aria-hidden="true" /></span>
        <h2 className="text-base font-semibold"><Trans>Agent</Trans></h2>
      </header> : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        <ol className="relative ml-1 flex list-none flex-col gap-3 border-l border-accent-200 py-1 pl-5">
            {session === null || entries.length === 0 ? (
              <ConversationShell actor="Agent" tone="agent">
                <Sparkles className="mb-2 size-5 text-accent-text" aria-hidden="true" />
                <p className="text-xs leading-5 text-neutral-600"><Trans>让我分析当前 Demo，并直接在左侧时间轴上准备一份可审阅的修改。</Trans></p>
              </ConversationShell>
            ) : null}
            {!agentStatusPending && !agentReady ? (
              <ConversationShell actor={t`系统`} tone="error">
                <div className="flex items-center gap-2 text-xs font-medium text-fail-text">
                  <CircleAlert className="size-4" aria-hidden="true" />
                  <Trans>Agent 尚未配置模型</Trans>
                </div>
                <p className="mt-1 text-xs leading-5 text-neutral-600"><Trans>配置提供方、模型、API 地址和密钥后即可在这里继续。</Trans></p>
                <Button className="mt-2" size="sm" variant="secondary" onClick={onOpenAgentSettings}><Trans>打开模型设置</Trans></Button>
              </ConversationShell>
            ) : null}
            {entries.map((entry) => (
              <ConversationEntry
                key={`entry:${entry.id}`}
                entry={entry}
                pendingConfirmationToolCallId={pendingConfirmationToolCallId}
                confirming={confirming}
                deliveryReady={deliveryReady}
                deliveryGatePending={deliveryGatePending}
                onConfirmRecording={onConfirmRecording}
                onConfirmExport={onConfirmExport}
                onRejectConfirmation={onRejectConfirmation}
                toolDecisions={toolDecisions}
              />
            ))}
            {chat.draft === '' ? null : (
              <ConversationShell actor="Agent" tone="agent">
                <AgentMarkdown>{chat.draft}</AgentMarkdown>
              </ConversationShell>
            )}
            {chat.activity?.map((call) => (
              <ConversationShell key={`live-tool:${call.id}`} actor={t`Agent · 工具`} tone="tool">
                <ToolCallCard call={call} />
              </ConversationShell>
            ))}
            {externalExecutions.map((execution) => (
              <ConversationShell key={`execution:${execution.id}`} actor={t`外部执行`} tone={execution.status === 'failed' ? 'error' : 'status'}>
                <div className="flex items-center gap-2 text-xs font-medium">
                  {execution.status === 'completed'
                    ? <CheckCircle2 className="size-4 text-ok" aria-hidden="true" />
                    : execution.status === 'failed'
                      ? <CircleAlert className="size-4 text-fail-text" aria-hidden="true" />
                      : <LoaderCircle className="size-4 animate-spin text-accent-text" aria-hidden="true" />}
                  <span>{execution.kind === 'recording' ? <Trans>录制片段</Trans> : <Trans>导出成片</Trans>}</span>
                  <span className="ml-auto text-2xs text-neutral-500">{execution.progress_percent ?? 0}%</span>
                </div>
                <p className="mt-1 text-2xs text-neutral-600">
                  {execution.status === 'completed'
                    ? <Trans>已完成，Agent 将自动读取结果并继续。</Trans>
                    : execution.status === 'failed'
                      ? execution.error
                      : <Trans>任务由本地执行器处理，完成后会回到同一对话流。</Trans>}
                </p>
                <div className="mt-2 flex gap-2">
                  {execution.job_id === null || !execution.available_actions.includes('cancel') ? null : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={executionActionPending}
                      aria-label={execution.kind === 'export' ? t`取消导出任务` : t`取消录制任务`}
                      onClick={() => onCancelExecution(execution)}
                    >
                      <Trans>取消</Trans>
                    </Button>
                  )}
                  {!execution.available_actions.includes('open_outputs') ? null : (
                    <Button size="sm" variant="secondary" onClick={onOpenOutputs}><Trans>查看成品</Trans></Button>
                  )}
                </div>
              </ConversationShell>
            ))}
            {readOnly ? (
              <ConversationShell actor="Agent" tone="status">
                <div className="flex items-center gap-2 text-xs font-medium text-accent-text">
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  <Trans>Agent 操作中 · 人类只读</Trans>
                </div>
                <p className="mt-1 text-xs leading-5 text-neutral-600"><Trans>你可以检查预览和时间轴；Agent 释放编辑权后才能直接修改。</Trans></p>
              </ConversationShell>
            ) : null}
            {hasDelivery ? (
              <ConversationShell actor="Agent" tone="delivery">
                <p className="text-xs font-medium"><Trans>所有变更已完成，输出已准备好交付。</Trans></p>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <Button size="sm" variant="primary" disabled={confirming} onClick={() => {
                    setReturningChangeGroupId(null);
                    if (reviewGroup !== null) void onAcceptDelivery(reviewGroup.id);
                  }}><Trans>接受交付</Trans></Button>
                  <Button size="sm" variant="secondary" disabled={confirming} onClick={() => {
                    if (reviewGroup === null) return;
                    setReturningChangeGroupId(reviewGroup.id);
                    globalThis.setTimeout(() => messageInput.current?.focus(), 0);
                  }}><Trans>退回修改</Trans></Button>
                  <Button size="sm" variant="secondary" disabled={readOnly || confirming} onClick={() => {
                    setReturningChangeGroupId(null);
                    if (reviewGroup !== null) onDirectEdit(reviewGroup.id);
                  }}><Trans>直接修改</Trans></Button>
                </div>
              </ConversationShell>
            ) : null}
          </ol>
        <div ref={conversationEnd} />
        {chat.error === null ? null : <p className="mt-2 text-xs text-fail-text">{chat.error}</p>}
      </div>
      <footer className="border-t border-divider p-3">
        {returningChangeGroupId === null ? null : (
          <div className="mb-2 flex items-center gap-2 text-2xs text-neutral-600">
            <span><Trans>说明需要 Agent 修改什么</Trans></span>
            <Button className="ml-auto" size="sm" variant="ghost" onClick={() => {
              setReturningChangeGroupId(null);
              setMessage('');
            }}><Trans>取消退回</Trans></Button>
          </div>
        )}
        <div className="flex gap-2">
          <input
            ref={messageInput}
            className="h-10 min-w-0 flex-1 rounded-sm border border-divider bg-neutral-50 px-3 text-xs outline-none focus:border-accent-400"
            value={message}
            disabled={chat.streaming || creatingSession || readOnly || !agentReady}
            placeholder={!agentReady
              ? t`先配置 Agent 模型`
              : returningChangeGroupId === null
                ? t`例如：重新规划成 3 分钟 NiKo 集锦`
                : t`例如：删除第二个标记，并保持其他内容不变`}
            onChange={(event) => setMessage(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
          />
          {chat.streaming ? (
            <Button variant="secondary" aria-label={t`停止 Agent`} onClick={chat.cancel}><Square className="size-4" aria-hidden="true" /></Button>
          ) : (
            <Button aria-label={returningChangeGroupId === null ? t`发送给 Agent` : t`发送退回意见`} disabled={message.trim() === '' || creatingSession || readOnly || !agentReady} onClick={submit}><Send className="size-4" aria-hidden="true" /></Button>
          )}
        </div>
      </footer>
    </aside>
  );
}, areAgentPanelPropsEqual);

function areAgentPanelPropsEqual(previous: AgentPanelProps, next: AgentPanelProps): boolean {
  const previousActivity = previous.chat.activity ?? [];
  const nextActivity = next.chat.activity ?? [];
  const sameExecutions = previous.externalExecutions.length === next.externalExecutions.length
    && previous.externalExecutions.every((item, index) => item === next.externalExecutions[index]);
  return previous.showHeader === next.showHeader
    && previous.session === next.session
    && previous.chat.streaming === next.chat.streaming
    && previous.chat.draft === next.chat.draft
    && previous.chat.error === next.chat.error
    && previousActivity === nextActivity
    && previous.creatingSession === next.creatingSession
    && previous.changeGroups === next.changeGroups
    && previous.readOnly === next.readOnly
    && previous.agentReady === next.agentReady
    && previous.agentStatusPending === next.agentStatusPending
    && previous.deliveryReady === next.deliveryReady
    && previous.deliveryGatePending === next.deliveryGatePending
    && previous.confirming === next.confirming
    && previous.executionActionPending === next.executionActionPending
    && sameExecutions;
}

function ConversationEntry({
  entry,
  pendingConfirmationToolCallId,
  confirming,
  deliveryReady,
  deliveryGatePending,
  onConfirmRecording,
  onConfirmExport,
  onRejectConfirmation,
  toolDecisions,
}: {
  readonly entry: AgentSessionEntry;
  readonly pendingConfirmationToolCallId: string | null;
  readonly confirming: boolean;
  readonly deliveryReady: boolean;
  readonly deliveryGatePending: boolean;
  readonly onConfirmRecording: (toolCallId: string, clipIds: string[]) => Promise<void>;
  readonly onConfirmExport: (toolCallId: string) => Promise<void>;
  readonly onRejectConfirmation: (toolCallId: string) => Promise<void>;
  readonly toolDecisions: ReadonlyMap<string, ToolDecisionEntry>;
}) {
  if (entry.kind === 'user') {
    return (
      <ConversationShell actor={t`你`} at={entry.at} tone="human">
        <p className="whitespace-pre-wrap text-xs leading-5">{entry.content}</p>
      </ConversationShell>
    );
  }
  if (entry.kind === 'tool_decision') {
    const changeGroupId = deliveryDecisionChangeGroupId(entry);
    if (changeGroupId === null) return null;
    return (
      <ConversationShell actor={t`你 · 交付审阅`} at={entry.at} tone="human">
        <p className="text-xs font-medium">
          {entry.decision === 'approved' ? <Trans>已接受 Agent 变更</Trans> : <Trans>已要求 Agent 继续修改</Trans>}
        </p>
        <p className="mt-1 text-2xs leading-4 text-neutral-600">{entry.content}</p>
        <span className="mt-1 block font-mono text-2xs text-neutral-400">{changeGroupId}</span>
      </ConversationShell>
    );
  }
  return (
    <ConversationShell actor="Agent" at={entry.at} tone={entry.status === 'failed' ? 'error' : 'agent'}>
      {entry.content.trim() === '' ? null : <AgentMarkdown>{entry.content}</AgentMarkdown>}
      {entry.tool_calls.map((call) => (
        <ToolCallCard
          key={`${entry.id}:tool:${call.id}`}
          call={call}
          confirmationActive={call.id === pendingConfirmationToolCallId}
          confirming={confirming}
          deliveryReady={deliveryReady}
          deliveryGatePending={deliveryGatePending}
          onConfirmRecording={onConfirmRecording}
          onConfirmExport={onConfirmExport}
          onRejectConfirmation={onRejectConfirmation}
          decision={toolDecisions.get(call.id) ?? null}
        />
      ))}
      {entry.status === 'failed' && entry.error !== null ? <p className="mt-2 text-xs text-fail-text">{entry.error}</p> : null}
    </ConversationShell>
  );
}

function AgentMarkdown({ children }: { readonly children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children: content }) => <p className="mb-2 whitespace-pre-wrap text-xs leading-5 last:mb-0">{content}</p>,
        ul: ({ children: content }) => <ul className="mb-2 list-disc space-y-1 pl-4 text-xs leading-5 last:mb-0">{content}</ul>,
        ol: ({ children: content }) => <ol className="mb-2 list-decimal space-y-1 pl-4 text-xs leading-5 last:mb-0">{content}</ol>,
        strong: ({ children: content }) => <strong className="font-semibold text-text">{content}</strong>,
        code: ({ children: content }) => <code className="rounded-sm bg-neutral-100 px-1 font-mono text-2xs">{content}</code>,
        table: ({ children: content }) => <div className="mb-2 overflow-x-auto last:mb-0"><table className="w-full border-collapse text-left text-xs leading-5">{content}</table></div>,
        th: ({ children: content }) => <th className="border border-divider bg-neutral-50 px-2 py-1.5 font-semibold text-text">{content}</th>,
        td: ({ children: content }) => <td className="border border-divider px-2 py-1.5 align-top text-neutral-700">{content}</td>,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}


function ConversationShell({
  actor,
  at,
  tone,
  children,
}: {
  readonly actor: string;
  readonly at?: string | undefined;
  readonly tone: 'agent' | 'human' | 'tool' | 'status' | 'delivery' | 'error';
  readonly children: React.ReactNode;
}) {
  return (
    <li className="relative">
      <span className={cn(
        'absolute -left-[25px] top-1.5 size-2 rounded-full ring-4 ring-bg',
        tone === 'human' ? 'bg-neutral-500' : tone === 'error' ? 'bg-fail-text' : 'bg-accent-600',
      )} />
      <div className={cn(
        'min-w-0',
        tone === 'human' && 'rounded-sm bg-neutral-50 px-3 py-2',
        tone === 'status' && 'rounded-sm border border-accent-200 bg-accent-100 px-3 py-2',
        tone === 'delivery' && 'rounded-sm border border-ok-border bg-ok-surface px-3 py-3',
        tone === 'error' && 'rounded-sm border border-fail-border bg-fail-surface px-3 py-2',
      )}>
        <header className="mb-1.5 flex items-center gap-2 text-2xs text-neutral-400">
          <span className="text-xs font-semibold text-neutral-700">{actor}</span>
          {at === undefined ? null : <time className="ml-auto" dateTime={at}>{conversationTime(at)}</time>}
        </header>
        {children}
      </div>
    </li>
  );
}

function ToolCallCard({
  call,
  decision = null,
  confirmationActive = false,
  confirming = false,
  deliveryReady = false,
  deliveryGatePending = false,
  onConfirmRecording,
  onConfirmExport,
  onRejectConfirmation,
}: {
  readonly call: AgentToolCall | AgentToolActivity;
  readonly decision?: ToolDecisionEntry | null | undefined;
  readonly confirmationActive?: boolean | undefined;
  readonly confirming?: boolean | undefined;
  readonly deliveryReady?: boolean | undefined;
  readonly deliveryGatePending?: boolean | undefined;
  readonly onConfirmRecording?: ((toolCallId: string, clipIds: string[]) => Promise<void>) | undefined;
  readonly onConfirmExport?: ((toolCallId: string) => Promise<void>) | undefined;
  readonly onRejectConfirmation?: ((toolCallId: string) => Promise<void>) | undefined;
}) {
  const confirmation = confirmationOf(call);
  const running = call.status === 'running';
  const failed = call.status === 'failed';
  const awaitingDecision = confirmation !== null && decision === null;
  const rejected = decision?.decision === 'rejected';
  const approved = decision?.decision === 'approved';
  const exportBlocked = awaitingDecision
    && confirmation?.action === 'export'
    && (deliveryGatePending || !deliveryReady);
  return (
    <article className={cn(
      'mt-2 rounded-md border p-3 text-xs shadow-sm',
      awaitingDecision ? 'border-warn-border bg-warn-surface' : failed ? 'border-fail-border bg-fail-surface' : running ? 'border-accent-200 bg-accent-100' : 'border-divider bg-bg',
    )} data-tool-call-id={call.id} data-tool-call-status={decision?.decision ?? call.status} data-tool-call-decision={decision?.decision}>
      <div className="flex items-center gap-2">
        {rejected
          ? <CircleX className="size-4 text-neutral-500" aria-hidden="true" />
          : awaitingDecision
          ? <CircleAlert className="size-4 text-warn-text" aria-hidden="true" />
          : failed
            ? <CircleAlert className="size-4 text-fail-text" aria-hidden="true" />
            : running
              ? <LoaderCircle className="size-4 animate-spin text-accent-text" aria-hidden="true" />
              : <CheckCircle2 className="size-4 text-ok" aria-hidden="true" />}
        <span className="font-medium">{toolLabel(call)}</span>
        <span className={cn('ml-auto', awaitingDecision ? 'text-warn-text' : rejected ? 'text-neutral-500' : failed ? 'text-fail-text' : running ? 'text-accent-text' : 'text-ok')}>
          {rejected ? <Trans>已拒绝</Trans>
            : approved ? <Trans>已允许</Trans>
            : awaitingDecision
              ? confirmationActive ? <Trans>等待你确认</Trans> : <Trans>等待确认</Trans>
            : failed ? <Trans>执行失败</Trans> : running ? <Trans>执行中</Trans> : <Trans>已完成</Trans>}
        </span>
      </div>
      <p className="mt-1 text-2xs leading-4 text-neutral-600">{decision?.content ?? toolSummary(call)}</p>
      <details className="mt-2">
        <summary className="cursor-pointer select-none text-2xs text-neutral-500"><Trans>查看工具输入与输出</Trans></summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap border border-divider bg-bg p-2 font-mono text-2xs">{JSON.stringify({ input: call.input, output: call.output, decision }, null, 2)}</pre>
      </details>
      {!awaitingDecision || !confirmationActive ? null : (
        <div className="mt-3 border-t border-warn-border pt-3">
          <p className="font-medium"><Trans>需要你的确认</Trans></p>
          <p className="mt-1 text-neutral-600">
            {confirmation.action === 'recording'
              ? <Trans>Agent 已准备好缺失片段的录制请求；确认后才会启动 CS2/HLAE。</Trans>
              : <Trans>Agent 已准备好最终导出请求；确认后才会写出 MP4。</Trans>}
          </p>
          {!exportBlocked ? null : (
            <p className="mt-2 border border-warn-border bg-bg px-2 py-1.5 text-2xs text-warn-text">
              {deliveryGatePending
                ? <Trans>正在检查当前 Project revision 的交付状态。</Trans>
                : <Trans>时间线仍有未就绪素材；先录制、重录或重新链接后才能允许导出。</Trans>}
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={confirming || exportBlocked}
              onClick={() => void (confirmation.action === 'recording'
                ? onConfirmRecording?.(call.id, confirmation.clipIds)
                : onConfirmExport?.(call.id))}
            >
              {confirmation.action === 'recording' ? <Trans>允许录制</Trans> : <Trans>允许导出</Trans>}
            </Button>
            <Button size="sm" variant="secondary" disabled={confirming} onClick={() => void onRejectConfirmation?.(call.id)}><Trans>拒绝</Trans></Button>
          </div>
        </div>
      )}
    </article>
  );
}

type ToolDecisionEntry = Extract<AgentSessionEntry, { readonly kind: 'tool_decision' }>;

function pendingDeliveryGroup(
  changeGroups: readonly ProjectChangeGroup[],
  session: AgentSession | null,
): ProjectChangeGroup | null {
  if (session === null) return null;
  const latestUserAt = [...session.entries].reverse().find((entry) => entry.kind === 'user')?.at ?? null;
  if (latestUserAt === null) return null;
  const decidedGroupIds = new Set(session.entries.flatMap((entry) => {
    const groupId = deliveryDecisionChangeGroupId(entry);
    return groupId === null ? [] : [groupId];
  }));
  return changeGroups.find((group) => (
    group.author.kind === 'agent'
      && group.author.session_id === session.id
      && group.created_at >= latestUserAt
      && !decidedGroupIds.has(group.id)
  )) ?? null;
}

function pendingConfirmationToolCall(entries: readonly AgentSessionEntry[]): string | null {
  const decided = new Set(entries.flatMap((entry) => entry.kind === 'tool_decision' ? [entry.tool_call_id] : []));
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== 'assistant') continue;
    const call = [...entry.tool_calls].reverse().find((candidate) =>
      confirmationOf(candidate) !== null && !decided.has(candidate.id));
    if (call !== undefined) return call.id;
  }
  return null;
}

function confirmationOf(call: AgentToolCall | AgentToolActivity): { readonly action: 'recording' | 'export'; readonly clipIds: string[] } | null {
  if (call.status !== 'awaiting_confirmation' || call.output === null) return null;
  const output = jsonObject(call.output);
  if (output?.status !== 'requires_human_confirmation') return null;
  const action = output.action;
  if (action !== 'recording' && action !== 'export') return null;
  const input = jsonObject(call.input);
  const rawIds = input?.clipIds;
  const clipIds = Array.isArray(rawIds) ? rawIds.filter((value): value is string => typeof value === 'string') : [];
  return { action, clipIds };
}

function jsonObject(value: JsonValue): Record<string, JsonValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function toolLabel(call: AgentToolCall | AgentToolActivity): string {
  switch (call.name) {
    case 'read_workspace': return jsonObject(call.input)?.detail === 'timeline'
      ? t`读取时间线详情`
      : t`读取作品摘要`;
    case 'read_demo_evidence': return t`分析 Demo`;
    case 'read_cinematic_context': return t`读取镜头上下文`;
    case 'apply_project_patch': return t`修改时间线`;
    case 'replace_story_timeline': return t`重排时间线`;
    case 'request_project_recording': return t`请求录制片段`;
    case 'request_project_export': return t`请求导出`;
    default: return call.name;
  }
}

function toolSummary(call: AgentToolCall | AgentToolActivity): string {
  const confirmation = confirmationOf(call);
  if (confirmation?.action === 'recording') return t`录制不会自动开始，正在等待人类决定。`;
  if (confirmation?.action === 'export') return t`导出不会自动开始，正在等待人类决定。`;
  if (call.status === 'failed') {
    const error = jsonObject(call.output)?.error;
    return typeof error === 'string' && error.trim() !== ''
      ? error.trim().slice(0, 500)
      : t`工具调用失败，没有修改 Project。`;
  }
  if (call.status === 'running') {
    switch (call.name) {
      case 'read_workspace': return jsonObject(call.input)?.detail === 'timeline'
        ? t`正在按目标身份读取可编辑时间线字段…`
        : t`正在读取当前 Project revision 与素材概况…`;
      case 'read_demo_evidence': return t`正在读取经过验证的 Demo 事件…`;
      case 'read_cinematic_context': return t`正在读取镜头路径与战术上下文…`;
      case 'apply_project_patch': return t`正在校验并提交增量修改…`;
      case 'replace_story_timeline': return t`正在校验整条 Story Track…`;
      default: return t`正在执行结构化工具调用…`;
    }
  }
  switch (call.name) {
    case 'read_workspace': return jsonObject(call.input)?.detail === 'timeline'
      ? t`已读取目标轨道或片段的可编辑时间线字段。`
      : t`已读取当前 Project revision、轨道和素材概况。`;
    case 'read_demo_evidence': return t`已读取经过验证的 Demo 事件。`;
    case 'read_cinematic_context': return t`已读取镜头路径与战术上下文。`;
    case 'apply_project_patch': return t`增量修改已提交到统一时间线。`;
    case 'replace_story_timeline': return t`整条 Story Track 已原子替换。`;
    default: return t`工具返回了结构化结果。`;
  }
}

function conversationTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function projectWithPreviewClips(project: Project, clips: readonly TimelineClip[]): Project {
  if (clips.length === 0) return project;
  const previews = new Map(clips.map((clip) => [clip.id, clip]));
  const tracks = project.document.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => previews.get(clip.id) ?? clip),
  }));
  return {
    ...project,
    document: {
      ...project.document,
      duration_seconds: tracks.flatMap((track) => track.clips)
        .filter((clip) => clip.placement.enabled)
        .reduce((duration, clip) => Math.max(duration, clip.placement.start + clip.placement.duration), 0),
      tracks,
    },
  };
}

function findClip(project: Project, clipId: string | null) {
  if (clipId === null) return null;
  for (const track of project.document.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip !== undefined) return { track, clip };
  }
  return null;
}

function expandClipSelection(project: Project, clipIds: readonly string[], includeLinks: boolean): readonly string[] {
  const selected = new Set(clipIds);
  const anchor = clipIds[clipIds.length - 1];
  const clips = project.document.tracks.flatMap((track) => track.clips);
  let changed = true;
  while (changed) {
    changed = false;
    const groups = new Set(clips.filter((clip) => selected.has(clip.id) && clip.group_id !== null).map((clip) => clip.group_id!));
    const links = includeLinks
      ? new Set(clips.filter((clip) => selected.has(clip.id) && clip.link_group_id !== null).map((clip) => clip.link_group_id!))
      : new Set<string>();
    for (const clip of clips) {
      if (selected.has(clip.id)) continue;
      if ((clip.group_id !== null && groups.has(clip.group_id))
        || (clip.link_group_id !== null && links.has(clip.link_group_id))) {
        selected.add(clip.id);
        changed = true;
      }
    }
  }
  const expanded = [...selected];
  return anchor === undefined
    ? expanded
    : [...expanded.filter((clipId) => clipId !== anchor), anchor];
}
