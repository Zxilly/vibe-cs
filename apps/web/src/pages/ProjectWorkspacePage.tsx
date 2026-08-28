import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  Bell,
  Bookmark,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Eye,
  LayoutList,
  LockKeyhole,
  LoaderCircle,
  Send,
  Settings2,
  Sparkles,
  Square,
  Star,
  Volume2,
  Wrench,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import {
  useApplyProjectPatch,
  useCreateProject,
  useExportProject,
  useProject,
  useProjectChangeGroups,
  useProjectEditLease,
  useStartProjectRecording,
} from '../data/projects';
import { useDemo } from '../data/demos';
import { useMapRadarOverview, useMatchReplay } from '../data/match';
import { mediaAssetStreamPath, useAssetWaveform, useRecordedClipWaveform } from '../data/mediaAssets';
import { useNativeShell } from '../data/nativeShell';
import {
  useAgentChatStream,
  useAgentSession,
  useAppendAgentSessionEntry,
  useCreateAgentSession,
} from '../data/sessions';
import { Empty, Skeleton } from '../design/data';
import { Alert, Drawer } from '../design/feedback';
import { Page, Toolbar } from '../design/layout';
import { Button, cn } from '../design/primitives';
import '../design/workbenchReview.css';
import { MapCanvas, PathLayer } from '../domain/map';
import { Waveform } from '../domain/media';
import type {
  Project,
  ProjectChangeGroup,
  ProjectEditOperation,
  ProjectPatchScope,
  AgentSessionEntry,
  AgentToolCall,
  JsonValue,
  TimelineClip,
  TimelineTrack,
} from '../shared/desktop/dto';
import { RouteLink } from './RouteLink';
import { PlayerLayer } from './match/views/ReplayCanvas';
import { buildPlayerTracks, frameIndexAtTick, playerMarkers, sliceReplay } from './match/views/replayModel';

type EditingLens = 'quick' | 'multitrack';

export function ProjectWorkspacePage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const create = useCreateProject();
  const canonicalId = projectId === 'new' ? null : projectId;
  const project = useProject(canonicalId);
  const groups = useProjectChangeGroups(canonicalId);
  const lease = useProjectEditLease(canonicalId);
  const apply = useApplyProjectPatch();
  const startRecording = useStartProjectRecording();
  const exportProject = useExportProject();
  const lens: EditingLens = 'multitrack';
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const agentSessionId = searchParams.get('session');
  const agentSession = useAgentSession(agentSessionId);
  const createAgentSession = useCreateAgentSession();
  const appendAgentEntry = useAppendAgentSessionEntry();
  const agentChat = useAgentChatStream({
    sessionId: agentSessionId,
    history: agentSession.data?.entries ?? [],
  });

  useEffect(() => {
    if (projectId !== 'new' || create.isPending || create.data !== undefined) return;
    create.mutate(
      { name: '新作品', width: 1920, height: 1080, fps: 60 },
      { onSuccess: (created) => void navigate(`/projects/${encodeURIComponent(created.id)}`, { replace: true }) },
    );
  }, [create, navigate, projectId]);

  useEffect(() => {
    if (selectedClipId !== null) return;
    const firstClip = project.data?.document.tracks
      .find((track) => track.id === project.data?.document.story_track_id)
      ?.clips[0];
    if (firstClip !== undefined) setSelectedClipId(firstClip.id);
  }, [project.data, selectedClipId]);

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
  const visibleTracks = current.document.tracks;
  const selected = findClip(current, selectedClipId);
  const latestAgentGroup = (groups.data ?? []).find((group) => group.author.kind === 'agent') ?? null;
  const allClips = current.document.tracks.flatMap((track) => track.clips);
  const mutate = (summary: string, scope: ProjectPatchScope, operations: ProjectEditOperation[]) => {
    if (readOnly) return;
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
      scroll={false}
      toolbar={(
        <header data-tauri-drag-region className="flex h-[56px] flex-none items-center gap-2 border-b border-divider bg-bg px-5 pr-32">
          <button type="button" data-window-no-drag className="flex items-center gap-2 text-sm font-medium text-neutral-700 hover:text-text" onClick={() => void navigate('/projects')}>
            <ChevronLeft className="size-4" strokeWidth={1.6} aria-hidden="true" />
            <Trans>作品</Trans>
          </button>
          <ChevronRight className="size-3.5 text-neutral-400" strokeWidth={1.5} aria-hidden="true" />
          <h1 className="min-w-0 truncate text-sm font-semibold">NiKo 3 分钟集锦</h1>
          <ChevronRight className="size-3.5 text-neutral-400" strokeWidth={1.5} aria-hidden="true" />
          <span className="whitespace-nowrap text-sm font-semibold"><Trans>变更 #{current.revision}</Trans></span>
          <span className="ml-4 border border-accent-200 bg-accent-100 px-2 py-1 text-xs font-medium text-accent-text">
            <Trans>Agent 修改待审阅</Trans>
          </span>
          <span className="ml-2 whitespace-nowrap text-xs text-neutral-500"><Trans>创建于 2 小时前</Trans></span>
          <span className="text-neutral-300">·</span>
          <span className="whitespace-nowrap text-xs text-neutral-500"><Trans>共 {latestAgentGroup?.operations.length ?? 0} 处变更</Trans></span>
          <span className="ml-1 flex items-center gap-1 whitespace-nowrap text-xs text-ok"><CheckCircle2 className="size-3.5" strokeWidth={1.6} aria-hidden="true" /><Trans>检查通过</Trans></span>
          <span className="ml-auto flex items-center gap-5 text-neutral-600" data-window-no-drag>
            <Bell className="size-4" strokeWidth={1.5} aria-hidden="true" />
            <CircleHelp className="size-4" strokeWidth={1.5} aria-hidden="true" />
            <span className="h-5 border-l border-divider" aria-hidden="true" />
            <span className="review-circle grid size-7 place-items-center bg-neutral-200 text-xs font-medium">A</span>
          </span>
        </header>
      )}
      className="project-review-workbench"
    >
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(390px,26%)] overflow-hidden bg-neutral-100">
        <div
          className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] gap-[8px] overflow-hidden pb-[8px] pl-[14px] pr-[8px] pt-[12px]"
          style={{ gridTemplateRows: 'minmax(320px, 46.2%) 182px minmax(250px, 1fr)' }}
        >
          <PreviewSplit project={current} selected={selected?.clip ?? null} />
          <ChangeSummary project={current} group={latestAgentGroup} />
          <Timeline
            project={current}
            tracks={visibleTracks}
            selectedClipId={selectedClipId}
            onSelect={setSelectedClipId}
            onInspect={(clipId) => {
              setSelectedClipId(clipId);
              setInspectorOpen(true);
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
            confirming={appendAgentEntry.isPending || startRecording.isPending || exportProject.isPending}
            onConfirmRecording={async (clipIds) => {
              await appendHumanDecision(t`允许 Agent 请求的录制操作。`);
              startRecording.mutate({ projectId: current.id, clipIds });
            }}
            onConfirmExport={async () => {
              await appendHumanDecision(t`允许 Agent 请求的导出操作。`);
              exportProject.mutate({ projectId: current.id });
            }}
            onRejectConfirmation={() => appendHumanDecision(t`拒绝这次操作请求。`)}
            onAcceptDelivery={() => appendHumanDecision(t`接受交付。`)}
            onReturnDelivery={() => sendToAgent(t`退回修改，请继续调整这份作品。`)}
            onDirectEdit={() => {
              void appendHumanDecision(t`我将直接修改这份作品。`);
              const clipId = selectedClipId ?? allClips[0]?.id ?? null;
              setSelectedClipId(clipId);
              setInspectorOpen(clipId !== null);
            }}
          />
      </div>
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
          onReplace={(clip) => {
            mutate(
              `修改 ${clip.name}`,
              { kind: 'track', track_id: selected?.track.id ?? current.document.story_track_id },
              [{ op: 'replace_clip', clip_id: clip.id, clip }],
            );
            setInspectorOpen(false);
          }}
        />
      </Drawer>
      {apply.error === null && startRecording.error === null && exportProject.error === null ? null : (
        <Alert className="m-4" variant="danger" action={{ label: <Trans>关闭</Trans>, onAction: () => { apply.reset(); startRecording.reset(); exportProject.reset(); } }}>
          <Trans>操作没有完成。检查当前 revision、录制环境和 Delivery Gate 后重试。</Trans>
        </Alert>
      )}
    </Page>
  );
}

function PreviewSplit({ project, selected }: { readonly project: Project; readonly selected: TimelineClip | null }) {
  const [videoPercent, setVideoPercent] = useState(51);
  const splitRef = useRef<HTMLDivElement>(null);

  const resize = (clientX: number) => {
    const bounds = splitRef.current?.getBoundingClientRect();
    if (bounds === undefined || bounds.width === 0) return;
    const percent = ((clientX - bounds.left) / bounds.width) * 100;
    setVideoPercent(Math.min(72, Math.max(28, percent)));
  };

  return (
    <section className="review-panel min-h-0 min-w-0 overflow-hidden border border-accent-400 bg-bg shadow-[0_0_0_2px_var(--color-accent-100)]" aria-label={t`预览分栏`}>
      <div
        ref={splitRef}
        className="grid h-full min-h-0 min-w-0 max-w-full"
        style={{ gridTemplateColumns: `${videoPercent}% 4px minmax(0, 1fr)` }}
      >
        <ProgramMonitor project={project} selected={selected} />
        <div
          role="separator"
          aria-label={t`调整视频与战术图宽度`}
          aria-orientation="vertical"
          aria-valuemin={28}
          aria-valuemax={72}
          aria-valuenow={Math.round(videoPercent)}
          tabIndex={0}
          className="group relative z-10 cursor-col-resize bg-neutral-200 outline-none focus-visible:bg-accent-100"
          onDoubleClick={() => setVideoPercent(52)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') setVideoPercent((value) => Math.max(28, value - 2));
            if (event.key === 'ArrowRight') setVideoPercent((value) => Math.min(72, value + 2));
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture?.(event.pointerId);
            resize(event.clientX);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture?.(event.pointerId)) resize(event.clientX);
          }}
        >
          <span className="review-circle absolute left-1/2 top-1/2 grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center border border-neutral-400 bg-bg text-neutral-700 shadow-sm group-hover:border-accent-500 group-hover:text-accent-text">
            <span className="text-sm leading-none">↔</span>
          </span>
        </div>
        <TacticalPreview selected={selected} />
      </div>
    </section>
  );
}

function ProgramMonitor({ project, selected }: { readonly project: Project; readonly selected: TimelineClip | null }) {
  const shell = useNativeShell();
  const assetId = selected?.material.kind === 'take' || selected?.material.kind === 'asset'
    ? selected.material.asset_id
    : null;
  const videoSrc = assetId === null ? null : shell.mediaSrc(mediaAssetStreamPath(assetId));
  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-divider bg-bg" aria-label={t`视频预览`}>
      <header className="flex h-[32px] flex-none items-center border-b border-divider bg-bg px-4 text-xs font-semibold text-text">
        <Trans>视频预览</Trans>
      </header>
      {videoSrc === null ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-neutral-900 p-5 text-center text-neutral-100">
          <h2 className="font-heading text-2xl">{selected?.name ?? project.name}</h2>
          <p className="mt-2 text-sm text-neutral-400">
            {selected === null ? <Trans>从时间轴选择一个片段</Trans> : materialLabel(selected)}
          </p>
        </div>
      ) : (
        <video
          className="min-h-0 w-full flex-1 bg-neutral-900 object-cover"
          src={videoSrc}
          controls
          preload="metadata"
          aria-label={t`${selected?.name ?? project.name} 视频预览`}
        />
      )}
    </section>
  );
}

function TacticalPreview({ selected }: { readonly selected: TimelineClip | null }) {
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
  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-bg" aria-label={t`战术示意`}>
      <header className="flex h-[32px] flex-none items-center border-b border-divider bg-bg px-4 text-xs font-semibold text-text">
        <Trans>战术示意</Trans>
      </header>
      {selected === null || intent === null || mapName === null ? (
        <div className="grid min-h-0 flex-1 place-items-center px-5 text-center text-sm text-neutral-400">
          {selected === null ? <Trans>选择片段后显示路径与事件</Trans> : <Trans>这段素材没有可用的地图上下文</Trans>}
        </div>
      ) : demo.isPending || radar.isPending || replay.isPending ? (
        <div className="min-h-0 flex-1 animate-pulse bg-neutral-800" role="status" aria-label={t`正在读取战术图`} />
      ) : radarSrc === null ? (
        <div className="grid min-h-0 flex-1 place-items-center px-5 text-center text-sm text-neutral-400">
          <Trans>这张地图的雷达图暂时不可用</Trans>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden bg-accent-900">
          <MapCanvas
            mapName={mapName}
            overviewTransform={radar.data?.transform}
            label={t`${selected.name} 战术示意`}
            status={replaySlice === null ? 'empty' : 'ready'}
            className="h-full min-h-0 bg-accent-900 [&>div]:p-0 [&_.blueprint]:h-full [&_.blueprint]:max-w-none [&_.blueprint]:scale-[1.18] [&_.blueprint]:bg-accent-900 [&_figcaption]:hidden"
            basemap={<img src={radarSrc} alt="" className="size-full object-contain brightness-110 contrast-110" />}
          >
            {(projection) => (
              <>
                <PathLayer projection={projection} paths={tracks} selectedPlayerId={intent.player_id} />
                <PlayerLayer projection={projection} markers={markers} selectedPlayerId={intent.player_id} />
              </>
            )}
          </MapCanvas>
          <ul className="absolute right-4 top-1/2 -translate-y-1/2 space-y-2 border border-neutral-500 bg-accent-900/95 px-3 py-2 text-2xs text-neutral-100 shadow-md">
            <li className="flex items-center gap-2"><span className="review-circle size-3 border-2 border-bg bg-accent-500" /><span>CT</span></li>
            <li className="flex items-center gap-2"><span className="review-circle size-3 border-2 border-bg bg-warn" /><span>T</span></li>
            <li className="flex items-center gap-2"><span className="size-3 bg-fail" /><Trans>炸弹点</Trans></li>
            <li className="flex items-center gap-2"><Star className="size-3.5 text-warn" fill="currentColor" aria-hidden="true" /><Trans>事件</Trans></li>
          </ul>
          <div className="absolute inset-x-0 bottom-0 flex h-8 items-center border-t border-neutral-600 bg-accent-900/95 px-3 text-xs text-neutral-100">
            <span><Trans>回合: 15</Trans></span><span className="ml-4"><Trans>时间: 01:08</Trans></span>
          </div>
        </div>
      )}
    </section>
  );
}

function ChangeSummary({ project, group }: { readonly project: Project; readonly group: ProjectChangeGroup | null }) {
  const story = project.document.tracks.find((track) => track.id === project.document.story_track_id);
  const currentClips = story?.clips ?? [];
  const previousClips = previousStoryClips(group, project.document.story_track_id) ?? currentClips;
  const previousIds = new Set(previousClips.map((clip) => clip.id));
  const currentIds = new Set(currentClips.map((clip) => clip.id));
  const removed = new Set(previousClips.filter((clip) => !currentIds.has(clip.id)).map((clip) => clip.id));
  const added = new Set(currentClips.filter((clip) => !previousIds.has(clip.id)).map((clip) => clip.id));
  return (
    <section className="review-panel flex min-h-0 flex-col overflow-hidden border border-divider bg-bg" aria-label={t`变更摘要`}>
      <header className="flex h-11 flex-none items-center gap-3 border-b border-divider px-4 text-xs">
        <ChevronRight className="size-3.5 rotate-90 text-neutral-500" strokeWidth={1.6} aria-hidden="true" />
        <h2 className="text-sm font-semibold"><Trans>变更摘要</Trans></h2>
        <span className="text-neutral-400"><Trans>共 {Math.max(group?.operations.length ?? 0, added.size + removed.size)} 处变更</Trans></span>
        <span className="text-neutral-300">·</span>
        <span className="min-w-0 truncate text-neutral-500">{group?.summary ?? t`当前没有 Agent 时间线变更`}</span>
        <span className="ml-auto flex items-center gap-3 text-2xs text-neutral-500">
          <span className="flex items-center gap-1"><span className="size-2 bg-ok" /><Trans>新增或调整</Trans></span>
          <span className="flex items-center gap-1"><span className="size-2 bg-fail" /><Trans>原版本</Trans></span>
        </span>
      </header>
      <div className="grid min-h-0 flex-1 grid-rows-[24px_1fr_1fr] text-xs">
        <div className="grid grid-cols-[96px_repeat(7,minmax(0,1fr))] border-b border-divider font-mono text-2xs text-neutral-500">
          <span />
          {[0, 30, 60, 90, 120, 150, 180].map((seconds) => <span key={seconds} className="px-1 py-1 text-center">{formatTimelinePoint(seconds)}</span>)}
        </div>
        <ReviewStrip label={t`当前版本`} clips={previousClips} changed={removed} tone="before" />
        <ReviewStrip label={t`Agent 提案`} clips={currentClips} changed={added} tone="after" />
      </div>
    </section>
  );
}

function ReviewStrip({
  label,
  clips,
  changed,
  tone,
}: {
  readonly label: string;
  readonly clips: readonly TimelineClip[];
  readonly changed: ReadonlySet<string>;
  readonly tone: 'before' | 'after';
}) {
  return (
    <div className="grid min-h-0 grid-cols-[96px_minmax(0,1fr)] border-b border-divider last:border-b-0">
      <div className="flex items-center px-4 font-semibold">{label}</div>
      <ol className="flex min-w-0 list-none items-stretch overflow-hidden p-0.5">
        {clips.map((clip) => {
          const isChanged = changed.has(clip.id);
          return (
            <li
              key={`${tone}:${clip.id}`}
              className={cn(
                'mx-px flex min-w-20 flex-1 items-center border border-divider bg-neutral-100 px-2 text-2xs',
                isChanged && tone === 'after' && 'border-ok-border bg-ok-surface text-ok',
                isChanged && tone === 'before' && 'border-fail-border bg-fail-surface text-fail-text',
              )}
            >
              <span className="truncate">{clip.name}</span>
              <span className="ml-auto pl-2 text-neutral-500">{clip.placement.duration.toFixed(0)}s</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function previousStoryClips(group: ProjectChangeGroup | null, storyTrackId: string): readonly TimelineClip[] | null {
  if (group === null) return null;
  for (const operation of group.inverse_operations) {
    if (operation.op === 'replace_track_clips' && operation.track_id === storyTrackId) return operation.clips;
    if (operation.op === 'replace_track' && operation.track_id === storyTrackId) return operation.track.clips;
  }
  return null;
}

function Timeline({
  project,
  tracks,
  selectedClipId,
  onSelect,
  onInspect,
}: {
  readonly project: Project;
  readonly tracks: readonly TimelineTrack[];
  readonly selectedClipId: string | null;
  readonly onSelect: (clipId: string) => void;
  readonly onInspect: (clipId: string) => void;
}) {
  const shell = useNativeShell();
  const story = tracks.find((track) => track.id === project.document.story_track_id) ?? tracks[0];
  const clips = story?.clips ?? [];
  const recordedCount = clips.filter((clip) => clip.material.kind !== 'planned').length;
  const plannedCount = clips.length - recordedCount;
  return (
    <section className="review-panel flex min-h-0 flex-col overflow-hidden border border-divider bg-bg" aria-label={t`时间轴`}>
      <span className="sr-only">{tracks.map((track) => <span key={track.id}>{track.name}</span>)}</span>
      <header className="flex h-11 flex-none items-center gap-3 border-b border-divider px-4">
        <h2 className="text-sm font-semibold"><Trans>时间轴（编辑预览）</Trans></h2>
        <span className="ml-auto flex items-center gap-2 text-neutral-500">
          <ZoomOut className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
          <span className="review-circle h-1 w-12 bg-neutral-200"><span className="review-circle block h-1 w-7 bg-accent-500" /></span>
          <ZoomIn className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
          <button type="button" className="ml-1 flex h-6 items-center gap-1 border border-divider px-2 text-2xs"><Trans>适应</Trans><ChevronRight className="size-3 rotate-90" aria-hidden="true" /></button>
        </span>
      </header>
      <div className="grid h-7 flex-none grid-cols-[190px_minmax(900px,1fr)] border-b border-divider font-mono text-2xs text-neutral-500">
        <span />
        <div className="grid grid-cols-7">
          {[0, 30, 60, 90, 120, 150, 180].map((seconds) => <span key={seconds} className="border-l border-divider px-1 py-1 text-center">{formatTimelinePoint(seconds)}</span>)}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="min-w-[calc(var(--w-overlay)+var(--w-split))]">
          <div className="grid h-[62px] grid-cols-[190px_minmax(900px,1fr)] border-b border-divider">
            <TimelineTrackLabel icon={<Camera className="size-4" />} label={t`视频轨道 1`} />
            <ol className="flex list-none items-stretch p-1">
              {clips.map((clip) => (
                <li key={clip.id} className="min-w-0 flex-none" style={{ width: clipWidth(clip, project.document.duration_seconds) }}>
                  <button
                    type="button"
                    className={cn(
                      'relative flex h-full w-full min-w-0 flex-col overflow-hidden border border-divider bg-neutral-100 text-left outline-none',
                      selectedClipId === clip.id && 'border-accent-500 ring-1 ring-inset ring-accent-500',
                    )}
                    onClick={() => onSelect(clip.id)}
                    onDoubleClick={() => onInspect(clip.id)}
                    aria-label={`${clip.name} ${clip.placement.duration.toFixed(1)}s · ${materialLabel(clip)}`}
                  >
                    <span className="sr-only">{clip.placement.duration.toFixed(1)}s · {materialLabel(clip)}</span>
                    {clip.material.kind === 'planned' ? (
                      <span className="grid flex-1 place-items-center bg-neutral-100 text-2xs text-neutral-500"><Trans>待录制</Trans></span>
                    ) : (
                      <video
                        className="pointer-events-none min-h-0 flex-1 bg-neutral-900 object-cover"
                        src={shell.mediaSrc(mediaAssetStreamPath(clip.material.asset_id)) ?? undefined}
                        preload="metadata"
                        muted
                        tabIndex={-1}
                        aria-hidden="true"
                      />
                    )}
                    <span className="absolute inset-x-0 bottom-0 truncate bg-neutral-900/75 px-1 py-0.5 text-2xs text-bg">{clip.name}</span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
          <div className="grid h-[42px] grid-cols-[190px_minmax(900px,1fr)] border-b border-divider">
            <TimelineTrackLabel icon={<Volume2 className="size-4" />} label={t`音频轨道 1`} />
            <ol className="flex list-none items-stretch p-1">
              {clips.map((clip) => (
                <li key={`audio:${clip.id}`} className="min-w-0 flex-none border-r border-divider" style={{ width: clipWidth(clip, project.document.duration_seconds) }}>
                  <ClipWaveform clip={clip} />
                </li>
              ))}
            </ol>
          </div>
          <TimelineMetaRow icon={<Bookmark className="size-4" />} label={t`标记`} clips={clips} kind="status" totalDuration={project.document.duration_seconds} />
          <TimelineMetaRow icon={<Star className="size-4" />} label={t`事件`} clips={clips} kind="event" totalDuration={project.document.duration_seconds} />
        </div>
      </div>
      <footer className="flex h-10 flex-none items-center gap-5 border-t border-divider px-2 text-2xs text-neutral-600">
        <span><Trans>提案时长：</Trans><strong className="font-mono font-medium text-text">{formatTimelineDuration(project.document.duration_seconds)}</strong></span>
        <span className="flex items-center gap-1.5"><span className="size-2 bg-accent-400" /><Trans>已录制 {recordedCount}</Trans></span>
        <span className="flex items-center gap-1.5"><span className="size-2 bg-neutral-200" /><Trans>未录制 {plannedCount}</Trans></span>
        <span className="ml-auto flex items-center gap-2">
          <button type="button" className="flex h-7 items-center gap-1.5 border border-divider px-2"><LayoutList className="size-3.5" aria-hidden="true" /><Trans>阻塞显示</Trans></button>
          <button type="button" className="grid size-7 place-items-center border border-divider" aria-label={t`时间轴设置`}><Settings2 className="size-3.5" aria-hidden="true" /></button>
        </span>
      </footer>
    </section>
  );
}

function TimelineMetaRow({
  icon,
  label,
  clips,
  kind,
  totalDuration,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly clips: readonly TimelineClip[];
  readonly kind: 'status' | 'event';
  readonly totalDuration: number;
}) {
  return (
    <div className="grid h-[34px] grid-cols-[190px_minmax(900px,1fr)] border-b border-divider bg-bg">
      <TimelineTrackLabel icon={icon} label={label} compact />
      <ol className="flex list-none items-stretch p-0">
        {clips.map((clip) => {
          const recorded = clip.material.kind !== 'planned';
          const event = clip.name.split(' · ')[0] ?? clip.name;
          return (
            <li
              key={`${kind}:${clip.id}`}
              className="flex min-w-0 flex-none items-center border-r border-divider px-2 text-2xs"
              style={{ width: clipWidth(clip, totalDuration) }}
            >
              <span className={cn('mr-1.5 h-3 w-1.5 flex-none', kind === 'event' ? 'bg-ok' : recorded ? 'bg-accent-400' : 'bg-neutral-200')} aria-hidden="true" />
              <span className="truncate text-neutral-700">{kind === 'event' ? event : materialLabel(clip)}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function TimelineTrackLabel({ icon, label, compact = false }: { readonly icon: React.ReactNode; readonly label: string; readonly compact?: boolean }) {
  return (
    <div className={cn('flex items-center gap-3 border-r border-divider px-3 text-xs font-medium', compact && 'text-2xs')}>
      <span className="text-neutral-600">{icon}</span>
      <span>{label}</span>
      <span className="ml-auto flex items-center gap-2 text-neutral-500">
        {compact ? null : <><Eye className="size-3.5" aria-hidden="true" /><LockKeyhole className="size-3.5" aria-hidden="true" /></>}
      </span>
    </div>
  );
}

function ClipWaveform({ clip }: { readonly clip: TimelineClip }) {
  const assetId = clip.material.kind === 'asset' ? clip.material.asset_id : null;
  const takeId = clip.material.kind === 'take' ? clip.material.take_id : null;
  const waveform = useAssetWaveform(assetId, 64);
  const recordedWaveform = useRecordedClipWaveform(takeId, 64);
  const peaks = takeId === null ? waveform.data?.waveform : recordedWaveform.data?.waveform;
  const pending = takeId === null ? waveform.isPending : recordedWaveform.isPending;
  if (clip.material.kind === 'planned') return <div className="h-full bg-neutral-100" />;
  if (!pending && (peaks?.length ?? 0) === 0) {
    return <div className="grid h-full place-items-center bg-accent-100 text-2xs text-neutral-500"><Trans>波形不可用</Trans></div>;
  }
  return (
    <Waveform
      peaks={peaks ?? []}
      durationSeconds={clip.placement.duration}
      loading={pending}
      className="!h-full !min-h-0 !border-0 bg-accent-100 [&_.blueprint]:border-0"
    />
  );
}

function clipWidth(clip: TimelineClip, totalDuration: number): string {
  return `${Math.max(7, clip.placement.duration / Math.max(totalDuration, 1) * 100)}%`;
}

function formatTimelineDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(rounded / 60)).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}.000`;
}

function ClipInspector({
  selected,
  readOnly,
  onReplace,
}: {
  readonly selected: { readonly track: TimelineTrack; readonly clip: TimelineClip } | null;
  readonly readOnly: boolean;
  readonly onReplace: (clip: TimelineClip) => void;
}) {
  const [draft, setDraft] = useState<TimelineClip | null>(selected?.clip ?? null);
  useEffect(() => setDraft(selected?.clip ?? null), [selected?.clip]);
  if (draft === null) {
    return <aside className="flex items-center justify-center border-l border-divider p-5 text-sm text-neutral-600"><Trans>选择片段后编辑</Trans></aside>;
  }
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
      <label className="mt-3 flex items-center gap-2 text-xs">
        <input type="checkbox" disabled={readOnly} checked={draft.placement.enabled} onChange={(event) => setDraft({ ...draft, placement: { ...draft.placement, enabled: event.currentTarget.checked } })} />
        <Trans>启用片段</Trans>
      </label>
      <Button className="mt-5 w-full" variant="primary" disabled={readOnly} onClick={() => onReplace(draft)}><Trans>保存修改</Trans></Button>
    </div>
  );
}

function formatTimelinePoint(seconds: number): string {
  const value = Math.max(0, Math.round(seconds));
  return `${Math.floor(value / 60).toString().padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`;
}

function AgentPanel({
  session,
  chat,
  creatingSession,
  onSend,
  changeGroups,
  readOnly,
  confirming,
  onConfirmRecording,
  onConfirmExport,
  onRejectConfirmation,
  onAcceptDelivery,
  onReturnDelivery,
  onDirectEdit,
}: {
  readonly session: import('../shared/desktop/dto').AgentSession | null;
  readonly chat: ReturnType<typeof useAgentChatStream>;
  readonly creatingSession: boolean;
  readonly onSend: (message: string) => Promise<void>;
  readonly changeGroups: readonly ProjectChangeGroup[];
  readonly readOnly: boolean;
  readonly confirming: boolean;
  readonly onConfirmRecording: (clipIds: string[]) => Promise<void>;
  readonly onConfirmExport: () => Promise<void>;
  readonly onRejectConfirmation: () => Promise<void>;
  readonly onAcceptDelivery: () => Promise<void>;
  readonly onReturnDelivery: () => Promise<void>;
  readonly onDirectEdit: () => void;
}) {
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
    if (next === '' || chat.streaming || creatingSession || readOnly) return;
    setMessage('');
    void onSend(next);
  };
  useEffect(() => {
    conversationEnd.current?.scrollIntoView({ block: 'end' });
  }, [session?.id, entries.length, chat.draft, chat.activity?.length]);
  return (
    <aside className="flex min-h-0 flex-col border-l border-divider bg-bg" aria-label={t`Agent 面板`}>
      <header className="flex h-[42px] flex-none items-center gap-2 border-b border-divider px-5">
        <span className="review-circle grid size-6 place-items-center bg-accent-100 text-accent-text"><Sparkles className="size-3.5" aria-hidden="true" /></span>
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
                <p className="line-clamp-5 whitespace-pre-wrap text-xs leading-5">{chat.draft}</p>
              </ConversationShell>
            )}
            {chat.activity?.map((call, index) => (
              <ConversationShell key={`live-tool:${index}:${call.name}`} actor={t`Agent · 工具`} tone="tool">
                <ToolCallCard call={call} running />
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
            className="review-field h-10 min-w-0 flex-1 border border-divider bg-neutral-50 px-3 text-xs outline-none focus:border-accent-400"
            value={message}
            disabled={chat.streaming || creatingSession || readOnly}
            placeholder={t`例如：重新规划成 3 分钟 NiKo 集锦`}
            onChange={(event) => setMessage(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
          />
          {chat.streaming ? (
            <Button variant="secondary" aria-label={t`停止 Agent`} onClick={chat.cancel}><Square className="size-4" aria-hidden="true" /></Button>
          ) : (
            <Button aria-label={t`发送给 Agent`} disabled={message.trim() === '' || creatingSession || readOnly} onClick={submit}><Send className="size-4" aria-hidden="true" /></Button>
          )}
        </div>
      </footer>
    </aside>
  );
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
      {entry.content.trim() === '' ? null : <p className="line-clamp-3 whitespace-pre-wrap text-xs leading-5">{entry.content}</p>}
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
        'review-circle absolute -left-[25px] top-1.5 size-2 ring-4 ring-bg',
        tone === 'human' ? 'bg-neutral-500' : tone === 'error' ? 'bg-fail-text' : 'bg-accent-600',
      )} />
      <div className={cn(
        'min-w-0',
        tone === 'human' && 'review-field bg-neutral-50 px-3 py-2',
        tone === 'status' && 'review-field border border-accent-200 bg-accent-100 px-3 py-2',
        tone === 'delivery' && 'review-field border border-ok-border bg-ok-surface px-3 py-3',
        tone === 'error' && 'review-field border border-fail-border bg-fail-surface px-3 py-2',
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
  running = false,
  confirmationActive = false,
  confirming = false,
  onConfirmRecording,
  onConfirmExport,
  onRejectConfirmation,
}: {
  readonly call: AgentToolCall;
  readonly running?: boolean | undefined;
  readonly confirmationActive?: boolean | undefined;
  readonly confirming?: boolean | undefined;
  readonly onConfirmRecording?: ((clipIds: string[]) => Promise<void>) | undefined;
  readonly onConfirmExport?: (() => Promise<void>) | undefined;
  readonly onRejectConfirmation?: (() => Promise<void>) | undefined;
}) {
  const confirmation = confirmationOf(call);
  return (
    <article className={cn('review-card mt-2 border p-3 text-xs shadow-sm', confirmation === null ? 'border-divider bg-bg' : 'border-warn-border bg-warn-surface')}>
      <div className="flex items-center gap-2">
        {running ? <LoaderCircle className="size-4 animate-spin text-accent-text" aria-hidden="true" /> : confirmation === null ? <Wrench className="size-4 text-neutral-500" aria-hidden="true" /> : <CircleAlert className="size-4 text-warn-text" aria-hidden="true" />}
        <span className="font-medium">{toolLabel(call.name)}</span>
        <span className={cn('ml-auto', running ? 'text-accent-text' : confirmation === null ? 'text-ok' : 'text-warn-text')}>
          {running ? <Trans>执行中</Trans> : confirmation === null ? <Trans>已完成</Trans> : confirmationActive ? <Trans>等待你确认</Trans> : <Trans>已处理</Trans>}
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

function materialLabel(clip: TimelineClip) {
  switch (clip.material.kind) {
    case 'planned': return t`未录制`;
    case 'take': return t`已录制`;
    case 'asset': return t`已录制`;
  }
}
