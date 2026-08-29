import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  Bell,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Download,
  Diamond,
  FolderOpen,
  LoaderCircle,
  Send,
  Sparkles,
  Square,
  Star,
  Video,
  Wrench,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import {
  useApplyProjectPatch,
  useCreateProject,
  useExportProject,
  useProject,
  useProjectChangeGroups,
  useProjectEditLease,
  useRevertProjectChangeGroup,
  useStartProjectRecording,
} from '../data/projects';
import { useDemo } from '../data/demos';
import { useAgentStatus } from '../data/config';
import { useTask } from '../data/tasks';
import { useMapRadarOverview, useMatchReplay } from '../data/match';
import { useNativeShell } from '../data/nativeShell';
import { useImportMediaAsset, useMediaAssets } from '../data/mediaAssets';
import {
  useAgentChatStream,
  useAgentSession,
  useAppendAgentSessionEntry,
  useCreateAgentSession,
} from '../data/sessions';
import { Empty, Skeleton } from '../design/data';
import { Alert, Dialog, Drawer } from '../design/feedback';
import { Page, Toolbar } from '../design/layout';
import { Button, cn } from '../design/primitives';
import { ReviewPanel } from '../design/review';
import {
  clipKeyframeAtTime,
  clipLocalTimeAtTimeline,
  evaluateClipKeyframeProperty,
  insertRippleClipAtTime,
  overwriteStoryClipAtTime,
  ProjectTimeline,
  snapTimeToFrame,
  timelineClipFromMediaAsset,
  TimelineProgramMonitor,
  trimRippleClip,
  removeClipKeyframe,
  upsertClipKeyframe,
} from '../domain/editing';
import { MapCanvas, PathLayer, type MapProjection } from '../domain/map';
import type {
  Project,
  ProjectChangeGroup,
  ProjectEditOperation,
  ProjectPatchScope,
  RadarTransformResponse,
  AgentSessionEntry,
  AgentToolCall,
  EditorKeyframeProperty,
  JsonValue,
  MediaAsset,
  TimelineClip,
  TimelineTrack,
} from '../shared/desktop/dto';
import type { ActivityItem } from '../shared/desktop/viewModels';
import { RouteLink } from './RouteLink';
import { PlayerLayer } from './match/views/ReplayCanvas';
import { buildPlayerTracks, frameIndexAtTick, playerMarkers, sliceReplay, type PlayerMarker } from './match/views/replayModel';

type EditingLens = 'quick' | 'multitrack';

interface TacticalScene {
  readonly clipId: string;
  readonly mapName: string;
  readonly radarSrc: string;
  readonly transform: RadarTransformResponse | null | undefined;
  readonly label: string;
  readonly selectedPlayerId: string;
  readonly status: 'ready' | 'empty';
  readonly tracks: ReturnType<typeof buildPlayerTracks>['paths'];
  readonly markers: readonly PlayerMarker[];
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
  const groups = useProjectChangeGroups(canonicalId);
  const lease = useProjectEditLease(canonicalId);
  const mediaAssets = useMediaAssets(canonicalId, { enabled: canonicalId !== null });
  const importMedia = useImportMediaAsset();
  const nativeShell = useNativeShell();
  const apply = useApplyProjectPatch();
  const revertChange = useRevertProjectChangeGroup(canonicalId ?? '');
  const startRecording = useStartProjectRecording();
  const exportProject = useExportProject();
  const lens: EditingLens = 'multitrack';
  const [selectedClipIds, setSelectedClipIds] = useState<readonly string[]>([]);
  const selectedClipId = selectedClipIds[selectedClipIds.length - 1] ?? null;
  const initializedSelectionProjectId = useRef<string | null>(null);
  const [targetTrackId, setTargetTrackId] = useState<string | null>(null);
  const [linkedSelectionEnabled, setLinkedSelectionEnabled] = useState(true);
  const [timelineTimeSeconds, setTimelineTimeSeconds] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [externalConfirm, setExternalConfirm] = useState<'recording' | 'export' | null>(null);
  const agentSessionId = searchParams.get('session');
  const agentSession = useAgentSession(agentSessionId);
  const createAgentSession = useCreateAgentSession();
  const appendAgentEntry = useAppendAgentSessionEntry();
  const agentChat = useAgentChatStream({
    sessionId: agentSessionId,
    history: agentSession.data?.entries ?? [],
  });
  const agentStatus = useAgentStatus();
  const recordingTask = useTask('recording', startRecording.data?.job_id ?? null, { pollWhileActiveMs: 1_000 });
  const exportTask = useTask('export', exportProject.data?.job_id ?? null, { pollWhileActiveMs: 1_000 });
  const reportedExecutionIds = useRef(new Set<string>());

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
      ? t`${next.kind === 'recording' ? '录制' : '导出'}任务已完成。请读取最新 Project Head，检查结果并继续当前交付。`
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
      { name: '新作品', width: 1920, height: 1080, fps: 60 },
      { onSuccess: (created) => void navigate(`/projects/${encodeURIComponent(created.id)}`, { replace: true }) },
    );
  }, [create, navigate, projectId]);

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
          : linkedSelectionEnabled ? expandLinkedClipIds(loaded, [firstClip.id]) : [firstClip.id];
      }
      const next = currentSelection.filter((clipId) => allIds.has(clipId));
      return next.length === currentSelection.length ? currentSelection : next;
    });
  }, [linkedSelectionEnabled, project.data]);

  useEffect(() => {
    if (!linkedSelectionEnabled || project.data === undefined) return;
    setSelectedClipIds((currentSelection) => expandLinkedClipIds(project.data!, currentSelection));
  }, [linkedSelectionEnabled, project.data]);

  useEffect(() => {
    const document = project.data?.document;
    if (document === undefined) return;
    if (targetTrackId !== null && document.tracks.some((track) => track.id === targetTrackId)) return;
    setTargetTrackId(document.story_track_id);
  }, [project.data?.document, targetTrackId]);

  useEffect(() => {
    const duration = project.data?.document.duration_seconds;
    if (duration === undefined) return;
    setTimelineTimeSeconds((time) => Math.min(duration, Math.max(0, time)));
  }, [project.data?.document.duration_seconds]);

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
  const readOnly = lease.data !== null && lease.data !== undefined;
  const selected = findClip(current, selectedClipId);
  const transportTimeSeconds = Math.min(
    current.document.duration_seconds,
    Math.max(0, timelineTimeSeconds),
  );
  const transportClip = current.document.tracks
    .find((track) => track.id === current.document.story_track_id)
    ?.clips.find((clip) => transportTimeSeconds >= clip.placement.start
      && transportTimeSeconds < clip.placement.start + clip.placement.duration) ?? null;
  const latestAgentGroup = (groups.data ?? []).find((group) => group.author.kind === 'agent') ?? null;
  const revertedChangeGroupIds = new Set(
    (groups.data ?? []).flatMap((group) => group.reverts_change_group_id === null ? [] : [group.reverts_change_group_id]),
  );
  const latestUndoableGroup = (groups.data ?? []).find((group) =>
    group.status === 'completed'
    && group.operations.length > 0
    && group.author.kind !== 'system'
    && group.reverts_change_group_id === null
    && !revertedChangeGroupIds.has(group.id));
  const allClips = current.document.tracks.flatMap((track) => track.clips);
  const storyTrack = current.document.tracks.find((track) => track.id === current.document.story_track_id) ?? null;
  const plannedClipIds = storyTrack?.clips
    .filter((clip) => clip.material.kind === 'planned')
    .map((clip) => clip.id) ?? [];
  const mutate = (summary: string, scope: ProjectPatchScope, operations: ProjectEditOperation[]) => {
    if (readOnly || apply.isPending) return;
    apply.mutate({
      project_id: current.id,
      base_revision: current.revision,
      scope,
      author: { kind: 'human' },
      reverts_change_group_id: null,
      summary,
      operations,
    });
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
          return linkedSelectionEnabled ? expandLinkedClipIds(current, [clipId]) : [clipId];
        }
        const anchorIndex = track.clips.findIndex((clip) => clip.id === anchorId);
        const targetIndex = track.clips.findIndex((clip) => clip.id === clipId);
        const from = Math.min(anchorIndex, targetIndex);
        const to = Math.max(anchorIndex, targetIndex);
        const rangeIds = track.clips.slice(from, to + 1).map((clip) => clip.id);
        return linkedSelectionEnabled ? expandLinkedClipIds(current, rangeIds) : rangeIds;
      }
      const group = linkedSelectionEnabled ? expandLinkedClipIds(current, [clipId]) : [clipId];
      if (!additive) return group;
      return group.every((groupId) => currentSelection.includes(groupId))
        ? currentSelection.filter((selectedId) => !group.includes(selectedId))
        : [...new Set([...currentSelection, ...group])];
    });
  };
  const selectTimelineClips = (clipIds: readonly string[]) => {
    setSelectedClipIds(linkedSelectionEnabled ? expandLinkedClipIds(current, clipIds) : clipIds);
  };
  const addMediaAsset = (asset: MediaAsset, mode: 'insert' | 'overwrite') => {
    if (storyTrack === null || asset.duration_seconds === null || asset.duration_seconds <= 0) return;
    const insertedClipId = globalThis.crypto.randomUUID();
    const inserted = timelineClipFromMediaAsset(asset, insertedClipId);
    const editTimeSeconds = snapTimeToFrame(transportTimeSeconds, current.document.fps);
    const clips = mode === 'insert'
      ? insertRippleClipAtTime(
        storyTrack.clips,
        inserted,
        editTimeSeconds,
        globalThis.crypto.randomUUID(),
      )
      : overwriteStoryClipAtTime(
        storyTrack.clips,
        inserted,
        editTimeSeconds,
        globalThis.crypto.randomUUID(),
      );
    mutate(
      `${mode === 'insert' ? '插入' : '覆盖'}素材 ${asset.name}`,
      { kind: 'track', track_id: storyTrack.id },
      [{ op: 'replace_track_clips', track_id: storyTrack.id, clips }],
    );
    setSelectedClipIds([insertedClipId]);
  };
  const importProjectMedia = async () => {
    if (!nativeShell.available) return;
    const paths = await nativeShell.chooseFiles({ title: t`导入项目素材` });
    await Promise.all(paths.map((path) => importMedia.mutateAsync({ path, projectId: current.id })));
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
  const appendHumanDecision = async (content: string) => {
    if (agentSessionId === null) return;
    await appendAgentEntry.mutateAsync({
      sessionId: agentSessionId,
      draft: { kind: 'user', content },
    });
  };

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
          <h1 className="min-w-0 truncate text-sm font-semibold">NiKo 3 分钟集锦</h1>
          <ChevronRight className="size-3.5 text-neutral-400" strokeWidth={1.5} aria-hidden="true" />
          <span className="whitespace-nowrap text-sm font-semibold"><Trans>变更 #{current.revision}</Trans></span>
          <span className="ml-8 border border-accent-200 bg-accent-100 px-2 py-1 text-xs font-medium text-accent-text">
            <Trans>Agent 修改待审阅</Trans>
          </span>
          <span className="ml-2 whitespace-nowrap text-xs text-neutral-500"><Trans>创建于 2 小时前</Trans></span>
          <span className="text-neutral-300">·</span>
          <span className="whitespace-nowrap text-xs text-neutral-500"><Trans>共 {latestAgentGroup?.operations.length ?? 0} 处变更</Trans></span>
          <span className="ml-1 flex items-center gap-1 whitespace-nowrap text-xs text-ok"><CheckCircle2 className="size-3.5" strokeWidth={1.6} aria-hidden="true" /><Trans>检查通过</Trans></span>
          <button
            type="button"
            data-window-no-drag
            className="ml-3 flex h-[var(--h-ctl-sm)] items-center gap-1.5 rounded-sm border border-divider px-2 text-xs hover:bg-neutral-100"
            onClick={() => setMediaOpen(true)}
          >
            <FolderOpen className="size-3.5" aria-hidden="true" />
            <Trans>项目素材</Trans>
          </button>
          <button
            type="button"
            data-window-no-drag
            className="flex h-[var(--h-ctl-sm)] items-center gap-1.5 rounded-sm border border-divider px-2 text-xs hover:bg-neutral-100 disabled:text-neutral-300"
            disabled={readOnly || plannedClipIds.length === 0 || startRecording.isPending}
            onClick={() => setExternalConfirm('recording')}
          >
            <Video className="size-3.5" aria-hidden="true" />
            <Trans>录制缺失片段</Trans>
          </button>
          <button
            type="button"
            data-window-no-drag
            className="flex h-[var(--h-ctl-sm)] items-center gap-1.5 rounded-sm border border-accent bg-accent px-2 text-xs text-bg hover:bg-accent-700 disabled:border-divider disabled:bg-neutral-200 disabled:text-neutral-400"
            disabled={readOnly || plannedClipIds.length > 0 || exportProject.isPending}
            onClick={() => setExternalConfirm('export')}
          >
            <Download className="size-3.5" aria-hidden="true" />
            <Trans>导出成片</Trans>
          </button>
          <span className="ml-auto flex items-center gap-5 text-neutral-600" data-window-no-drag>
            <Bell className="size-4" strokeWidth={1.5} aria-hidden="true" />
            <CircleHelp className="size-4" strokeWidth={1.5} aria-hidden="true" />
            <span className="h-5 border-l border-divider" aria-hidden="true" />
            <span className="grid size-7 place-items-center rounded-full bg-neutral-200 text-xs font-medium">A</span>
          </span>
        </header>
      )}
    >
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_420px] overflow-hidden bg-neutral-100">
        <div
          className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] gap-[8px] overflow-hidden pl-[14px] pr-[8px] pt-[12px]"
          style={{ gridTemplateRows: 'minmax(320px,47%) minmax(360px,1fr)' }}
        >
          <PreviewSplit
            project={current}
            transportClip={transportClip}
            timelineTimeSeconds={transportTimeSeconds}
            playing={playing}
            playbackRate={playbackRate}
            onTogglePlayback={togglePlayback}
            onShuttle={shuttlePlayback}
            onStepFrame={stepTimelineFrame}
            onTimelineTimeChange={seekTimeline}
            onPlaybackEnd={() => setPlaying(false)}
          />
          <ProjectTimeline
            document={current.document}
            selectedClipId={selectedClipId}
            selectedClipIds={selectedClipIds}
            targetTrackId={targetTrackId ?? current.document.story_track_id}
            linkedSelectionEnabled={linkedSelectionEnabled}
            timelineTimeSeconds={transportTimeSeconds}
            transportPlaying={playing}
            reviewGroup={latestAgentGroup}
            readOnly={readOnly || apply.isPending || revertChange.isPending}
            onSelectClip={selectTimelineClip}
            onSelectClips={selectTimelineClips}
            onTargetTrack={setTargetTrackId}
            onToggleLinkedSelection={() => setLinkedSelectionEnabled((value) => !value)}
            onInspectClip={(clipId) => {
              setSelectedClipIds([clipId]);
              setInspectorOpen(true);
            }}
            onSeek={(seconds) => {
              setPlaying(false);
              seekTimeline(seconds);
            }}
            onTogglePlayback={togglePlayback}
            onShuttle={shuttlePlayback}
            onReplaceClip={(clip) => mutate(
              `调整 ${clip.name}`,
              { kind: 'time_range', start: clip.placement.start, end: clip.placement.start + clip.placement.duration },
              [{ op: 'replace_clip', clip_id: clip.id, clip }],
            )}
            onReplaceTrack={(track) => mutate(
              `修改轨道 ${track.name}`,
              { kind: 'track', track_id: track.id },
              [{ op: 'replace_track', track_id: track.id, track }],
            )}
            onReplaceTrackClips={(trackId, clips) => mutate(
              `调整轨道片段`,
              { kind: 'track', track_id: trackId },
              [{ op: 'replace_track_clips', track_id: trackId, clips: [...clips] }],
            )}
            onReplaceTrackClipGroups={(updates) => mutate(
              updates.length === 1 ? `调整轨道片段` : `调整 ${updates.length} 条轨道的片段`,
              updates.length === 1
                ? { kind: 'track', track_id: updates[0]!.trackId }
                : { kind: 'project' },
              updates.map((update) => ({ op: 'replace_track_clips', track_id: update.trackId, clips: [...update.clips] })),
            )}
            onReplaceClips={(clips) => mutate(
              clips.every((clip) => clip.link_group_id === null) ? `取消链接片段` : `链接片段`,
              { kind: 'project' },
              clips.map((clip) => ({ op: 'replace_clip', clip_id: clip.id, clip })),
            )}
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
            canUndo={latestUndoableGroup !== undefined}
            onUndo={() => {
              if (latestUndoableGroup === undefined || readOnly) return;
              revertChange.mutate({
                changeGroupId: latestUndoableGroup.id,
                expectedRevision: current.revision,
              });
            }}
          />
        </div>
        <AgentPanel
            session={agentSession.data ?? null}
            chat={agentChat}
            creatingSession={createAgentSession.isPending}
            onSend={sendToAgent}
            changeGroups={groups.data ?? []}
            readOnly={readOnly}
            agentReady={agentStatus.data?.configured === true}
            agentStatusPending={agentStatus.isPending}
            externalExecutions={[recordingTask.data, exportTask.data].filter((item): item is ActivityItem => item !== undefined)}
            onOpenAgentSettings={() => void navigate('/settings?section=ai&item=model')}
            confirming={appendAgentEntry.isPending || startRecording.isPending || exportProject.isPending}
            onConfirmRecording={async (clipIds) => {
              await appendHumanDecision(t`允许 Agent 请求的录制操作。`);
              await startRecording.mutateAsync({ projectId: current.id, clipIds });
            }}
            onConfirmExport={async () => {
              await appendHumanDecision(t`允许 Agent 请求的导出操作。`);
              await exportProject.mutateAsync({ projectId: current.id });
            }}
            onRejectConfirmation={() => sendToAgent(t`拒绝这次外部执行请求。请保留当前时间线并说明还能交付什么。`)}
            onAcceptDelivery={() => appendHumanDecision(t`接受交付。`)}
            onReturnDelivery={() => sendToAgent(t`退回修改，请继续调整这份作品。`)}
            onDirectEdit={() => {
              void appendHumanDecision(t`我将直接修改这份作品。`);
              const clipId = selectedClipId ?? allClips[0]?.id ?? null;
              setSelectedClipIds(clipId === null ? [] : [clipId]);
              setInspectorOpen(clipId !== null);
            }}
          />
      </div>
      <Drawer
        open={mediaOpen}
        title={<Trans>项目素材</Trans>}
        description={<Trans>{mediaAssets.data?.items.length ?? 0} 个素材</Trans>}
        width="standard"
        onClose={() => setMediaOpen(false)}
        footer={(
          <Button size="sm" variant="secondary" disabled={!nativeShell.available || importMedia.isPending} onClick={() => void importProjectMedia()}>
            <Trans>导入文件</Trans>
          </Button>
        )}
      >
        {mediaAssets.isPending ? <Skeleton className="h-24" /> : mediaAssets.data?.items.length ? (
          <ul className="list-none divide-y divide-divider">
            {mediaAssets.data.items.map((asset) => (
              <li key={asset.id} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{asset.name}</span>
                  <span className="block text-2xs text-neutral-500">{asset.kind} · {asset.duration_seconds === null ? t`时长未知` : `${asset.duration_seconds.toFixed(3)}s`}</span>
                </span>
                <span className="flex flex-none items-center gap-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={readOnly || apply.isPending || asset.duration_seconds === null || asset.duration_seconds <= 0}
                    aria-label={t`在播放头插入 ${asset.name}`}
                    onClick={() => addMediaAsset(asset, 'insert')}
                  >
                    <Trans>插入</Trans>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={readOnly || apply.isPending || asset.duration_seconds === null || asset.duration_seconds <= 0}
                    aria-label={t`在播放头覆盖 ${asset.name}`}
                    onClick={() => addMediaAsset(asset, 'overwrite')}
                  >
                    <Trans>覆盖</Trans>
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty
            title={<Trans>项目还没有素材</Trans>}
            description={<Trans>导入视频或音频后，可直接加入播放头所在位置。</Trans>}
            actions={<Button size="sm" variant="secondary" disabled={!nativeShell.available || importMedia.isPending} onClick={() => void importProjectMedia()}><Trans>导入文件</Trans></Button>}
          />
        )}
      </Drawer>
      <Dialog
        open={externalConfirm === 'recording'}
        title={<Trans>录制缺失片段</Trans>}
        confirmLabel={<Trans>开始录制</Trans>}
        confirmDisabled={plannedClipIds.length === 0 || startRecording.isPending}
        onConfirm={() => {
          setExternalConfirm(null);
          startRecording.mutate({ projectId: current.id, clipIds: plannedClipIds });
        }}
        onClose={() => setExternalConfirm(null)}
      >
        <p><Trans>将启动 CS2/HLAE，录制 {plannedClipIds.length} 个尚未物化的时间线片段。</Trans></p>
      </Dialog>
      <Dialog
        open={externalConfirm === 'export'}
        title={<Trans>导出成片</Trans>}
        confirmLabel={<Trans>开始导出</Trans>}
        confirmDisabled={plannedClipIds.length > 0 || exportProject.isPending}
        onConfirm={() => {
          setExternalConfirm(null);
          exportProject.mutate({ projectId: current.id });
        }}
        onClose={() => setExternalConfirm(null)}
      >
        <p><Trans>按当前 Project Head 和统一时间线导出最终 MP4。</Trans></p>
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
          readOnly={readOnly}
          timelineTimeSeconds={transportTimeSeconds}
          fps={current.document.fps}
          onReplace={(clip) => {
            const track = selected?.track ?? null;
            if (track?.id === current.document.story_track_id) {
              mutate(
                `修改 ${clip.name}`,
                { kind: 'track', track_id: track.id },
                [{ op: 'replace_track_clips', track_id: track.id, clips: trimRippleClip(track.clips, clip) }],
              );
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
      {apply.error === null && revertChange.error === null && startRecording.error === null && exportProject.error === null && importMedia.error === null ? null : (
        <Alert className="m-4" variant="danger" action={{ label: <Trans>关闭</Trans>, onAction: () => { apply.reset(); revertChange.reset(); startRecording.reset(); exportProject.reset(); importMedia.reset(); } }}>
          <Trans>操作没有完成。检查当前 revision、录制环境和 Delivery Gate 后重试。</Trans>
        </Alert>
      )}
    </Page>
  );
}

function PreviewSplit({
  project,
  transportClip,
  timelineTimeSeconds,
  playing,
  playbackRate,
  onTogglePlayback,
  onShuttle,
  onStepFrame,
  onTimelineTimeChange,
  onPlaybackEnd,
}: {
  readonly project: Project;
  readonly transportClip: TimelineClip | null;
  readonly timelineTimeSeconds: number;
  readonly playing: boolean;
  readonly playbackRate: number;
  readonly onTogglePlayback: () => void;
  readonly onShuttle: (direction: -1 | 0 | 1) => void;
  readonly onStepFrame: (direction: -1 | 1) => void;
  readonly onTimelineTimeChange: (seconds: number) => void;
  readonly onPlaybackEnd: () => void;
}) {
  return (
    <ReviewPanel emphasis="focus" className="min-h-0 min-w-0" aria-label={t`预览分栏`}>
      <div
        className="grid h-full min-h-0 min-w-0 max-w-full"
        style={{ gridTemplateColumns: 'minmax(0, 1fr) 1px minmax(0, 1fr)' }}
      >
        <TimelineProgramMonitor
          project={project}
          timelineTimeSeconds={timelineTimeSeconds}
          playing={playing}
          playbackRate={playbackRate}
          onTogglePlayback={onTogglePlayback}
          onShuttle={onShuttle}
          onStepFrame={onStepFrame}
          onTimelineTimeChange={onTimelineTimeChange}
          onPlaybackEnd={onPlaybackEnd}
        />
        <div className="bg-divider" aria-hidden="true" />
        <TacticalPreview selected={transportClip} />
      </div>
    </ReviewPanel>
  );
}

const TacticalPreview = memo(function TacticalPreview({ selected }: { readonly selected: TimelineClip | null }) {
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
  const frameIndex = replaySlice === null
    ? -1
    : frameIndexAtTick(replaySlice.frames, replaySlice.endTick);
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
      || demo.isPending
      || radar.isPending
      || replay.isPending
    ) return null;
    return {
      clipId: selected.id,
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
    };
  }, [demo.isPending, intent, mapName, markers, radar.data?.transform, radar.isPending, radarSrc, replay.isPending, replaySlice, selected, tracks]);
  const [displayed, setDisplayed] = useState<TacticalScene | null>(null);
  const [mountedRadarSources, setMountedRadarSources] = useState<readonly string[]>([]);
  const mountedRadarSourcesRef = useRef(new Set<string>());
  const pendingRadarScenesRef = useRef(new Map<string, TacticalScene>());
  const selectedClipIdRef = useRef(selected?.id ?? null);
  selectedClipIdRef.current = selected?.id ?? null;

  useEffect(() => {
    if (selected === null || intent === null) {
      setDisplayed(null);
      return undefined;
    }
    if (mapName === null) return undefined;
    if (candidate === null) return undefined;
    let cancelled = false;
    void preloadRadarImage(candidate.radarSrc)
      .catch(() => undefined)
      .then(() => {
        if (cancelled) return;
        pendingRadarScenesRef.current.set(candidate.radarSrc, candidate);
        if (mountedRadarSourcesRef.current.has(candidate.radarSrc)) {
          if (selectedClipIdRef.current === candidate.clipId) setDisplayed(candidate);
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
      <header className="flex h-[var(--h-ctl-md)] flex-none items-center border-b border-divider bg-bg px-4 text-xs font-semibold text-text">
        <Trans>战术示意</Trans>
      </header>
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
                const scene = pendingRadarScenesRef.current.get(src);
                if (scene !== undefined && selectedClipIdRef.current === scene.clipId) setDisplayed(scene);
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
              {displayed.clipId === selected.id ? null : (
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
                <span><Trans>回合: 15</Trans></span><span className="ml-4"><Trans>时间: 01:08</Trans></span>
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
  onReplace,
}: {
  readonly selected: { readonly track: TimelineTrack; readonly clip: TimelineClip } | null;
  readonly readOnly: boolean;
  readonly timelineTimeSeconds: number;
  readonly fps: number;
  readonly onReplace: (clip: TimelineClip) => void;
}) {
  const [draft, setDraft] = useState<TimelineClip | null>(selected?.clip ?? null);
  useEffect(() => setDraft(selected?.clip ?? null), [selected?.clip]);
  if (draft === null) {
    return <aside className="flex items-center justify-center border-l border-divider p-5 text-sm text-neutral-600"><Trans>选择片段后编辑</Trans></aside>;
  }
  const localTime = clipLocalTimeAtTimeline(draft, timelineTimeSeconds, fps);
  const visualProperties: Array<{
    readonly property: Exclude<EditorKeyframeProperty, 'volume'>;
    readonly label: string;
    readonly step: number;
    readonly min?: number;
    readonly max?: number;
  }> = selected?.track.kind === 'audio'
    ? []
    : selected?.track.kind === 'text'
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
  return (
    <div className="min-h-0" aria-label={t`片段属性`}>
      <label className="flex flex-col gap-1 text-xs">
        <Trans>名称</Trans>
        <input disabled={readOnly} className="border border-divider px-2 py-1.5" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} />
      </label>
      {(['duration', 'source_in', 'source_out', 'speed', 'volume'] as const).map((field) => (
        <label key={field} className="mt-3 flex flex-col gap-1 text-xs">
          {field}
          <input
            type="number"
            step="0.1"
            className="border border-divider px-2 py-1.5 font-mono"
            disabled={readOnly}
            value={draft.placement[field]}
            onChange={(event) => setDraft({
              ...draft,
              placement: { ...draft.placement, [field]: Number(event.currentTarget.value) },
            })}
          />
        </label>
      ))}
      {visualProperties.length === 0 ? null : (
        <section className="mt-4 border-t border-divider pt-3" aria-label={t`变换与关键帧`}>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-xs font-semibold"><Trans>变换</Trans></h3>
            <span className="ml-auto font-mono text-2xs text-neutral-500"><Trans>片段内</Trans> {localTime.toFixed(3)}s</span>
          </div>
          {visualProperties.map(({ property, label, step, min, max }) => {
            const propertyKeyframes = draft.keyframes.filter((keyframe) => keyframe.property === property);
            const current = clipKeyframeAtTime(draft, property, localTime, fps);
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
                  disabled={readOnly}
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
                  disabled={readOnly}
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
        </section>
      )}
      {(['transition_in', 'transition_out'] as const).map((field) => (
        <label key={field} className="mt-3 flex flex-col gap-1 text-xs">
          {field === 'transition_in' ? <Trans>入场转场</Trans> : <Trans>出场转场</Trans>}
          <select
            className="border border-divider bg-bg px-2 py-1.5"
            disabled={readOnly}
            value={draft[field] ?? ''}
            onChange={(event) => setDraft({ ...draft, [field]: event.currentTarget.value === '' ? null : event.currentTarget.value })}
          >
            <option value=""><Trans>无</Trans></option>
            <option value="fade"><Trans>淡化</Trans></option>
            <option value="dip"><Trans>黑场</Trans></option>
            <option value="flash"><Trans>闪白</Trans></option>
            <option value="zoom"><Trans>缩放</Trans></option>
            <option value="wipe"><Trans>擦除</Trans></option>
            <option value="slide"><Trans>滑动</Trans></option>
            <option value="blur"><Trans>模糊</Trans></option>
            <option value="glitch"><Trans>故障</Trans></option>
            <option value="spin"><Trans>旋转</Trans></option>
          </select>
        </label>
      ))}
      <label className="mt-3 flex items-center gap-2 text-xs">
        <input type="checkbox" disabled={readOnly} checked={draft.placement.enabled} onChange={(event) => setDraft({ ...draft, placement: { ...draft.placement, enabled: event.currentTarget.checked } })} />
        <Trans>启用片段</Trans>
      </label>
      <Button className="mt-5 w-full" variant="primary" disabled={readOnly} onClick={() => onReplace(draft)}><Trans>保存修改</Trans></Button>
    </div>
  );
}

interface AgentPanelProps {
  readonly session: import('../shared/desktop/dto').AgentSession | null;
  readonly chat: ReturnType<typeof useAgentChatStream>;
  readonly creatingSession: boolean;
  readonly onSend: (message: string) => Promise<void>;
  readonly changeGroups: readonly ProjectChangeGroup[];
  readonly readOnly: boolean;
  readonly agentReady: boolean;
  readonly agentStatusPending: boolean;
  readonly externalExecutions: readonly ActivityItem[];
  readonly onOpenAgentSettings: () => void;
  readonly confirming: boolean;
  readonly onConfirmRecording: (clipIds: string[]) => Promise<void>;
  readonly onConfirmExport: () => Promise<void>;
  readonly onRejectConfirmation: () => Promise<void>;
  readonly onAcceptDelivery: () => Promise<void>;
  readonly onReturnDelivery: () => Promise<void>;
  readonly onDirectEdit: () => void;
}

const AgentPanel = memo(function AgentPanel({
  session,
  chat,
  creatingSession,
  onSend,
  changeGroups,
  readOnly,
  agentReady,
  agentStatusPending,
  externalExecutions,
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
  const conversationEnd = useRef<HTMLDivElement>(null);
  const entries = session?.entries ?? [];
  const pendingConfirmationEntryId = pendingConfirmationEntry(entries);
  const latestUserAt = [...entries].reverse().find((entry) => entry.kind === 'user')?.at ?? null;
  const hasDelivery = !chat.streaming
    && pendingConfirmationEntryId === null
    && session !== null
    && latestUserAt !== null
    && changeGroups.some((group) => group.author.kind === 'agent'
      && group.author.session_id === session.id
      && group.created_at >= latestUserAt)
    && [...entries].reverse().some((entry) => entry.kind === 'assistant' && entry.status === 'completed');
  const submit = () => {
    const next = message.trim();
    if (next === '' || chat.streaming || creatingSession || readOnly || !agentReady) return;
    setMessage('');
    void onSend(next);
  };
  useEffect(() => {
    conversationEnd.current?.scrollIntoView({ block: 'end' });
  }, [session?.id, entries.length, chat.draft, chat.activity?.length]);
  return (
    <aside className="flex min-h-0 flex-col border-l border-divider bg-bg" aria-label={t`Agent 面板`}>
      <header className="flex h-[42px] flex-none items-center gap-2 border-b border-divider px-5">
        <span className="grid size-6 place-items-center rounded-full bg-accent-100 text-accent-text"><Sparkles className="size-3.5" aria-hidden="true" /></span>
        <h2 className="text-base font-semibold"><Trans>Agent</Trans></h2>
      </header>
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
                confirmationActive={entry.id === pendingConfirmationEntryId}
                confirming={confirming}
                onConfirmRecording={onConfirmRecording}
                onConfirmExport={onConfirmExport}
                onRejectConfirmation={onRejectConfirmation}
              />
            ))}
            {chat.draft === '' ? null : (
              <ConversationShell actor="Agent" tone="agent">
                <AgentMarkdown>{chat.draft}</AgentMarkdown>
              </ConversationShell>
            )}
            {chat.activity?.map((call, index) => (
              <ConversationShell key={`live-tool:${index}:${call.name}`} actor={t`Agent · 工具`} tone="tool">
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
                  <Button size="sm" variant="primary" disabled={confirming} onClick={() => void onAcceptDelivery()}><Trans>接受交付</Trans></Button>
                  <Button size="sm" variant="secondary" disabled={confirming} onClick={() => void onReturnDelivery()}><Trans>退回修改</Trans></Button>
                  <Button size="sm" variant="secondary" disabled={readOnly || confirming} onClick={onDirectEdit}><Trans>直接修改</Trans></Button>
                </div>
              </ConversationShell>
            ) : null}
          </ol>
        <div ref={conversationEnd} />
        {chat.error === null ? null : <p className="mt-2 text-xs text-fail-text">{chat.error}</p>}
      </div>
      <footer className="border-t border-divider p-3">
        <div className="flex gap-2">
          <input
            className="h-10 min-w-0 flex-1 rounded-sm border border-divider bg-neutral-50 px-3 text-xs outline-none focus:border-accent-400"
            value={message}
            disabled={chat.streaming || creatingSession || readOnly || !agentReady}
            placeholder={agentReady ? t`例如：重新规划成 3 分钟 NiKo 集锦` : t`先配置 Agent 模型`}
            onChange={(event) => setMessage(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
          />
          {chat.streaming ? (
            <Button variant="secondary" aria-label={t`停止 Agent`} onClick={chat.cancel}><Square className="size-4" aria-hidden="true" /></Button>
          ) : (
            <Button aria-label={t`发送给 Agent`} disabled={message.trim() === '' || creatingSession || readOnly || !agentReady} onClick={submit}><Send className="size-4" aria-hidden="true" /></Button>
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
  return previous.session === next.session
    && previous.chat.streaming === next.chat.streaming
    && previous.chat.draft === next.chat.draft
    && previous.chat.error === next.chat.error
    && previousActivity === nextActivity
    && previous.creatingSession === next.creatingSession
    && previous.changeGroups === next.changeGroups
    && previous.readOnly === next.readOnly
    && previous.agentReady === next.agentReady
    && previous.agentStatusPending === next.agentStatusPending
    && previous.confirming === next.confirming
    && sameExecutions;
}

function ConversationEntry({
  entry,
  confirmationActive,
  confirming,
  onConfirmRecording,
  onConfirmExport,
  onRejectConfirmation,
}: {
  readonly entry: AgentSessionEntry;
  readonly confirmationActive: boolean;
  readonly confirming: boolean;
  readonly onConfirmRecording: (clipIds: string[]) => Promise<void>;
  readonly onConfirmExport: () => Promise<void>;
  readonly onRejectConfirmation: () => Promise<void>;
}) {
  if (entry.kind === 'user') {
    return (
      <ConversationShell actor={t`你`} at={entry.at} tone="human">
        <p className="whitespace-pre-wrap text-xs leading-5">{entry.content}</p>
      </ConversationShell>
    );
  }
  return (
    <ConversationShell actor="Agent" at={entry.at} tone={entry.status === 'failed' ? 'error' : 'agent'}>
      {entry.content.trim() === '' ? null : <AgentMarkdown>{entry.content}</AgentMarkdown>}
      {entry.tool_calls.map((call, index) => (
        <ToolCallCard
          key={`${entry.id}:tool:${index}:${call.name}`}
          call={call}
          confirmationActive={confirmationActive}
          confirming={confirming}
          onConfirmRecording={onConfirmRecording}
          onConfirmExport={onConfirmExport}
          onRejectConfirmation={onRejectConfirmation}
        />
      ))}
      {entry.status === 'failed' && entry.error !== null ? <p className="mt-2 text-xs text-fail-text">{entry.error}</p> : null}
    </ConversationShell>
  );
}

function AgentMarkdown({ children }: { readonly children: string }) {
  return (
    <ReactMarkdown
      components={{
        p: ({ children: content }) => <p className="mb-2 whitespace-pre-wrap text-xs leading-5 last:mb-0">{content}</p>,
        ul: ({ children: content }) => <ul className="mb-2 list-disc space-y-1 pl-4 text-xs leading-5 last:mb-0">{content}</ul>,
        ol: ({ children: content }) => <ol className="mb-2 list-decimal space-y-1 pl-4 text-xs leading-5 last:mb-0">{content}</ol>,
        strong: ({ children: content }) => <strong className="font-semibold text-text">{content}</strong>,
        code: ({ children: content }) => <code className="rounded-sm bg-neutral-100 px-1 font-mono text-2xs">{content}</code>,
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
  confirmationActive = false,
  confirming = false,
  onConfirmRecording,
  onConfirmExport,
  onRejectConfirmation,
}: {
  readonly call: AgentToolCall;
  readonly confirmationActive?: boolean | undefined;
  readonly confirming?: boolean | undefined;
  readonly onConfirmRecording?: ((clipIds: string[]) => Promise<void>) | undefined;
  readonly onConfirmExport?: (() => Promise<void>) | undefined;
  readonly onRejectConfirmation?: (() => Promise<void>) | undefined;
}) {
  const confirmation = confirmationOf(call);
  return (
    <article className={cn('mt-2 rounded-md border p-3 text-xs shadow-sm', confirmation === null ? 'border-divider bg-bg' : 'border-warn-border bg-warn-surface')}>
      <div className="flex items-center gap-2">
        {confirmation === null ? <Wrench className="size-4 text-neutral-500" aria-hidden="true" /> : <CircleAlert className="size-4 text-warn-text" aria-hidden="true" />}
        <span className="font-medium">{toolLabel(call.name)}</span>
        <span className={cn('ml-auto', confirmation === null ? 'text-ok' : 'text-warn-text')}>
          {confirmation === null ? <Trans>已完成</Trans> : confirmationActive ? <Trans>等待你确认</Trans> : <Trans>已处理</Trans>}
        </span>
      </div>
      <p className="mt-1 text-2xs leading-4 text-neutral-600">{toolSummary(call)}</p>
      <details className="mt-2">
        <summary className="cursor-pointer select-none text-2xs text-neutral-500"><Trans>查看工具输入与输出</Trans></summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap border border-divider bg-bg p-2 font-mono text-2xs">{JSON.stringify({ input: call.input, output: call.output }, null, 2)}</pre>
      </details>
      {confirmation === null || !confirmationActive ? null : (
        <div className="mt-3 border-t border-warn-border pt-3">
          <p className="font-medium"><Trans>需要你的确认</Trans></p>
          <p className="mt-1 text-neutral-600">
            {confirmation.action === 'recording'
              ? <Trans>Agent 已准备好缺失片段的录制请求；确认后才会启动 CS2/HLAE。</Trans>
              : <Trans>Agent 已准备好最终导出请求；确认后才会写出 MP4。</Trans>}
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={confirming}
              onClick={() => void (confirmation.action === 'recording'
                ? onConfirmRecording?.(confirmation.clipIds)
                : onConfirmExport?.())}
            >
              {confirmation.action === 'recording' ? <Trans>允许录制</Trans> : <Trans>允许导出</Trans>}
            </Button>
            <Button size="sm" variant="secondary" disabled={confirming} onClick={() => void onRejectConfirmation?.()}><Trans>拒绝</Trans></Button>
          </div>
        </div>
      )}
    </article>
  );
}

function pendingConfirmationEntry(entries: readonly AgentSessionEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind === 'user') return null;
    if (entry.tool_calls.some((call) => confirmationOf(call) !== null)) return entry.id;
  }
  return null;
}

function confirmationOf(call: AgentToolCall): { readonly action: 'recording' | 'export'; readonly clipIds: string[] } | null {
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

function toolLabel(name: string): string {
  switch (name) {
    case 'read_workspace': return t`读取作品`;
    case 'read_demo_evidence': return t`分析 Demo`;
    case 'read_cinematic_context': return t`读取镜头上下文`;
    case 'apply_project_patch': return t`修改时间线`;
    case 'replace_story_timeline': return t`重排时间线`;
    case 'request_project_recording': return t`请求录制片段`;
    case 'request_project_export': return t`请求导出`;
    default: return name;
  }
}

function toolSummary(call: AgentToolCall): string {
  const confirmation = confirmationOf(call);
  if (confirmation?.action === 'recording') return t`录制不会自动开始，正在等待人类决定。`;
  if (confirmation?.action === 'export') return t`导出不会自动开始，正在等待人类决定。`;
  switch (call.name) {
    case 'read_workspace': return t`已读取当前 Project Head 与 revision。`;
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

function findClip(project: Project, clipId: string | null) {
  if (clipId === null) return null;
  for (const track of project.document.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip !== undefined) return { track, clip };
  }
  return null;
}

function expandLinkedClipIds(project: Project, clipIds: readonly string[]): readonly string[] {
  const selected = new Set(clipIds);
  const groups = new Set(project.document.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => selected.has(clip.id) && clip.link_group_id !== null)
    .map((clip) => clip.link_group_id!));
  if (groups.size === 0) return [...selected];
  for (const clip of project.document.tracks.flatMap((track) => track.clips)) {
    if (clip.link_group_id !== null && groups.has(clip.link_group_id)) selected.add(clip.id);
  }
  return [...selected];
}
