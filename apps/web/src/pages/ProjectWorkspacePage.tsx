import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  CheckCircle2,
  ChevronLeft,
  CircleAlert,
  LoaderCircle,
  Send,
  Sparkles,
  Square,
  Wrench,
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
import { mediaAssetStreamPath } from '../data/mediaAssets';
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
import { Badge, Button, cn } from '../design/primitives';
import { MapCanvas, PathLayer } from '../domain/map';
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
  const recordedCount = allClips.filter((clip) => clip.material.kind !== 'planned').length;
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
        <header className="flex h-12 flex-none items-center gap-3 border-b border-divider px-4">
          <button type="button" className="flex items-center gap-1.5 text-sm text-neutral-700 hover:text-text" onClick={() => void navigate('/projects')}>
            <ChevronLeft className="size-4" aria-hidden="true" />
            <Trans>作品</Trans>
          </button>
          <span className="h-5 border-l border-divider" aria-hidden="true" />
          <h1 className="min-w-0 truncate font-heading text-lg">{current.name}</h1>
          <span className="font-mono text-xs text-neutral-500"><Trans>变更 r{current.revision}</Trans></span>
          <Badge variant="accent" size="sm">
            {agentChat.streaming || readOnly ? <Trans>Agent 操作中</Trans> : agentSession.data?.entries.length ? <Trans>Agent 已交付</Trans> : <Trans>等待 Agent</Trans>}
          </Badge>
          <span className="ml-auto text-xs text-neutral-600"><Trans>{recordedCount}/{allClips.length} 已录制</Trans></span>
          <span className="flex items-center gap-1 text-xs text-ok"><CheckCircle2 className="size-3.5" aria-hidden="true" /><Trans>结构检查通过</Trans></span>
        </header>
      )}
    >
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(360px,24vw)] overflow-hidden">
        <div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(260px,46%)_150px_minmax(190px,1fr)] overflow-hidden">
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
            project={current}
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
  const [videoPercent, setVideoPercent] = useState(52);
  const splitRef = useRef<HTMLDivElement>(null);

  const resize = (clientX: number) => {
    const bounds = splitRef.current?.getBoundingClientRect();
    if (bounds === undefined || bounds.width === 0) return;
    const percent = ((clientX - bounds.left) / bounds.width) * 100;
    setVideoPercent(Math.min(72, Math.max(28, percent)));
  };

  return (
    <section className="min-h-0 min-w-0 overflow-hidden border-b border-divider bg-surface" aria-label={t`预览分栏`}>
      <div
        ref={splitRef}
        className="grid h-full min-h-0 min-w-0 max-w-full"
        style={{ gridTemplateColumns: `${videoPercent}% 10px minmax(0, 1fr)` }}
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
          className="group relative z-10 cursor-col-resize border-x border-divider bg-surface-chrome outline-none focus-visible:bg-accent-100"
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
          <span className="absolute left-1/2 top-1/2 h-9 w-1 -translate-x-1/2 -translate-y-1/2 bg-neutral-400 group-hover:bg-accent-600" />
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
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-neutral-900 text-neutral-100" aria-label={t`视频预览`}>
      <header className="flex h-[var(--h-panel-head)] flex-none items-center border-b border-neutral-800 px-4 text-xs font-semibold">
        <Trans>视频预览</Trans>
        <span className="ml-auto font-mono font-normal text-neutral-400">{project.document.width}×{project.document.height} · {project.document.fps} fps</span>
      </header>
      {videoSrc === null ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-5 text-center">
          <h2 className="font-heading text-2xl">{selected?.name ?? project.name}</h2>
          <p className="mt-2 text-sm text-neutral-400">
            {selected === null ? <Trans>从时间轴选择一个片段</Trans> : materialLabel(selected)}
          </p>
        </div>
      ) : (
        <video
          className="min-h-0 flex-1 bg-neutral-900 object-contain"
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
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-neutral-900 text-neutral-100" aria-label={t`战术示意`}>
      <header className="flex h-[var(--h-panel-head)] flex-none items-center border-b border-neutral-800 px-4 text-xs font-semibold">
        <Trans>战术示意</Trans>
        <span className="ml-auto font-mono font-normal text-neutral-400">
          {intent === null ? <Trans>等待片段</Trans> : <Trans>tick {intent.start_tick}–{intent.end_tick}</Trans>}
        </span>
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
        <MapCanvas
          mapName={mapName}
          overviewTransform={radar.data?.transform}
          label={t`${selected.name} 战术示意`}
          status={replaySlice === null ? 'empty' : 'ready'}
          className="min-h-0 flex-1 bg-neutral-900 [&>div]:p-2 [&_.blueprint]:bg-neutral-900 [&_figcaption]:hidden"
          basemap={<img src={radarSrc} alt="" className="size-full object-contain brightness-150 contrast-125" />}
          legend={[
            { id: 'players', label: t`选手位置`, glyph: 'outline', tone: 'team-b' },
            { id: 'path', label: t`移动路线`, glyph: 'line', tone: 'accent' },
          ]}
        >
          {(projection) => (
            <>
              <PathLayer projection={projection} paths={tracks} selectedPlayerId={intent.player_id} />
              <PlayerLayer projection={projection} markers={markers} selectedPlayerId={intent.player_id} />
            </>
          )}
        </MapCanvas>
      )}
    </section>
  );
}

function ChangeSummary({ project, group }: { readonly project: Project; readonly group: ProjectChangeGroup | null }) {
  const story = project.document.tracks.find((track) => track.id === project.document.story_track_id);
  const currentClips = story?.clips ?? [];
  const previousClips = previousStoryClips(group, project.document.story_track_id) ?? currentClips;
  const changed = changedClipIds(group, currentClips);
  return (
    <section className="flex min-h-0 flex-col border-b border-divider bg-bg" aria-label={t`变更摘要`}>
      <header className="flex h-9 flex-none items-center gap-3 border-b border-divider px-4 text-xs">
        <h2 className="font-heading text-sm"><Trans>变更摘要</Trans></h2>
        <span className="text-neutral-500">{group?.summary ?? t`当前没有 Agent 时间线变更`}</span>
        <span className="ml-auto flex items-center gap-3 text-2xs text-neutral-500">
          <span className="flex items-center gap-1"><span className="size-2 bg-ok" /><Trans>新增或调整</Trans></span>
          <span className="flex items-center gap-1"><span className="size-2 bg-fail" /><Trans>原版本</Trans></span>
        </span>
      </header>
      <div className="grid min-h-0 flex-1 grid-rows-2 text-xs">
        <ReviewStrip label={t`当前版本`} clips={previousClips} changed={changed} tone="before" />
        <ReviewStrip label={t`Agent 提案`} clips={currentClips} changed={changed} tone="after" />
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
      <div className="flex items-center px-4 font-medium">{label}</div>
      <ol className="flex min-w-0 list-none overflow-hidden p-0">
        {clips.map((clip) => {
          const isChanged = changed.has(clip.id);
          return (
            <li
              key={`${tone}:${clip.id}`}
              className={cn(
                'flex min-w-20 flex-1 items-center border-l border-divider px-2 font-mono text-2xs',
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

function changedClipIds(group: ProjectChangeGroup | null, currentClips: readonly TimelineClip[]): ReadonlySet<string> {
  if (group === null) return new Set();
  const ids = new Set<string>();
  for (const operation of group.operations) {
    if (operation.op === 'replace_track_clips' || operation.op === 'replace_track') {
      for (const clip of currentClips) ids.add(clip.id);
    } else if (operation.op === 'insert_clip') {
      ids.add(operation.clip.id);
    } else if (operation.op === 'remove_clip' || operation.op === 'replace_clip' || operation.op === 'move_clip') {
      ids.add(operation.clip_id);
    }
  }
  return ids;
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
  const clips = tracks.flatMap((track) => track.clips);
  const recordedCount = clips.filter((clip) => clip.material.kind !== 'planned').length;
  const plannedCount = clips.length - recordedCount;
  return (
    <section className="flex min-h-0 flex-col" aria-label={t`时间轴`}>
      <header className="flex h-[var(--h-panel-head)] flex-none items-center gap-2 border-b border-divider px-4">
        <h2 className="font-heading text-sm"><Trans>时间轴</Trans></h2>
        <Badge variant="neutral"><Trans>{tracks.length} 条轨道</Trans></Badge>
        <span className="flex items-center gap-1 text-2xs text-neutral-600">
          <span className="size-2 bg-ok" aria-hidden="true" />
          <Trans>已录制 {recordedCount}</Trans>
        </span>
        <span className="flex items-center gap-1 text-2xs text-neutral-600">
          <span className="size-2 bg-warn" aria-hidden="true" />
          <Trans>未录制 {plannedCount}</Trans>
        </span>
        <span className="ml-auto font-mono text-xs text-neutral-600"><Trans>r{project.revision}</Trans></span>
      </header>
      <div className="grid h-7 flex-none grid-cols-5 border-b border-divider pl-[120px] font-mono text-2xs text-neutral-500">
        {[0, 25, 50, 75, 100].map((percent) => <span key={percent} className="border-l border-divider px-1">{formatTimelinePoint(project.document.duration_seconds * percent / 100)}</span>)}
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-surface-chrome">
        <div className="flex min-w-max flex-col">
          {tracks.map((track) => (
            <div key={track.id} className="grid min-h-20 grid-cols-[120px_minmax(760px,1fr)] border-b border-divider bg-bg">
              <div className="border-r border-divider px-3 py-2">
                <p className="font-medium">{track.name}</p>
                <p className="mt-1 text-xs text-neutral-600">{track.kind}</p>
              </div>
              <ol className="flex min-h-20 list-none items-stretch p-1.5">
                {track.clips.length === 0 ? (
                  <li className="flex min-w-48 items-center justify-center border border-dashed border-divider text-xs text-neutral-500">
                    <Trans>空轨道</Trans>
                  </li>
                ) : track.clips.map((clip) => (
                  <li
                    key={clip.id}
                    className={cn(
                      'relative flex min-w-28 flex-col border p-2',
                      clip.material.kind === 'planned'
                        ? 'border-warn-border bg-warn-surface'
                        : 'border-ok-border bg-ok-surface',
                    )}
                    style={{ flexBasis: `${Math.max(8, clip.placement.duration / Math.max(project.document.duration_seconds, 1) * 100)}%` }}
                  >
                    <button
                      type="button"
                      className={cn('min-h-12 text-left outline-none', selectedClipId === clip.id && 'text-accent-text ring-1 ring-inset ring-accent')}
                      onClick={() => onSelect(clip.id)}
                      onDoubleClick={() => onInspect(clip.id)}
                      aria-label={`${clip.name} ${clip.placement.duration.toFixed(1)}s · ${materialLabel(clip)}`}
                    >
                      {clip.material.kind === 'planned' ? null : (
                        <video
                          className="pointer-events-none mb-1.5 h-9 w-full bg-neutral-900 object-cover"
                          src={shell.mediaSrc(mediaAssetStreamPath(clip.material.asset_id)) ?? undefined}
                          preload="metadata"
                          muted
                          tabIndex={-1}
                          aria-hidden="true"
                        />
                      )}
                      <span className="block truncate text-sm">{clip.name}</span>
                      <span className="mt-1 flex items-center gap-1.5 font-mono text-2xs text-neutral-600">
                        <span className={cn('size-1.5', clip.material.kind === 'planned' ? 'bg-warn' : 'bg-ok')} aria-hidden="true" />
                        {clip.placement.duration.toFixed(1)}s · {materialLabel(clip)}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          ))}
          <TimelineMetaRow label={t`录制状态`} clips={clips} kind="status" totalDuration={project.document.duration_seconds} />
          <TimelineMetaRow label={t`事件`} clips={clips} kind="event" totalDuration={project.document.duration_seconds} />
        </div>
      </div>
    </section>
  );
}

function TimelineMetaRow({
  label,
  clips,
  kind,
  totalDuration,
}: {
  readonly label: string;
  readonly clips: readonly TimelineClip[];
  readonly kind: 'status' | 'event';
  readonly totalDuration: number;
}) {
  return (
    <div className="grid min-h-12 grid-cols-[120px_minmax(760px,1fr)] border-b border-divider bg-bg">
      <div className="border-r border-divider px-3 py-2 text-xs font-medium">{label}</div>
      <ol className="flex list-none items-stretch p-1.5">
        {clips.map((clip) => {
          const recorded = clip.material.kind !== 'planned';
          const event = clip.name.split(' · ')[0] ?? clip.name;
          return (
            <li
              key={`${kind}:${clip.id}`}
              className="flex min-w-28 items-center border-l border-divider px-2 text-2xs"
              style={{ flexBasis: `${Math.max(8, clip.placement.duration / Math.max(totalDuration, 1) * 100)}%` }}
            >
              <span className={cn('mr-1.5 size-2 flex-none', kind === 'event' ? 'bg-accent' : recorded ? 'bg-ok' : 'bg-warn')} aria-hidden="true" />
              <span className="truncate text-neutral-700">{kind === 'event' ? event : materialLabel(clip)}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
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
  project,
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
  readonly project: Project;
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
  }, [session?.id]);
  return (
    <aside className="flex min-h-0 flex-col border-l border-divider bg-surface" aria-label={t`Agent 面板`}>
      <header className="flex h-[var(--h-panel-head)] flex-none items-center gap-2 border-b border-divider px-4">
        <Sparkles className="size-4 text-accent-text" aria-hidden="true" />
        <h2 className="font-heading text-sm"><Trans>Agent</Trans></h2>
        <span className="ml-auto font-mono text-2xs text-neutral-500"><Trans>Project r{project.revision}</Trans></span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <ol className="relative ml-2 flex list-none flex-col gap-4 border-l border-divider py-1 pl-5">
            {session === null || entries.length === 0 ? (
              <ConversationShell actor="Agent" tone="agent">
                <Sparkles className="mb-2 size-5 text-accent-text" aria-hidden="true" />
                <p className="text-sm text-neutral-600"><Trans>让 Agent 直接修改左侧同一条时间轴；整条重排会作为一个可撤销修改提交。</Trans></p>
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
                <p className="whitespace-pre-wrap text-sm leading-5">{chat.draft}</p>
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
                <p className="mt-1 text-xs text-neutral-600"><Trans>你可以检查预览和时间轴；Agent 释放编辑权后才能直接修改。</Trans></p>
              </ConversationShell>
            ) : null}
            {hasDelivery ? (
              <ConversationShell actor="Agent" tone="delivery">
                <p className="text-sm font-medium"><Trans>这轮修改已经交付，请验收当前时间轴。</Trans></p>
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
            className="min-w-0 flex-1 border border-divider px-2 text-sm"
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
        <p className="whitespace-pre-wrap text-sm leading-5">{entry.content}</p>
      </ConversationShell>
    );
  }
  return (
    <ConversationShell actor="Agent" at={entry.at} tone={entry.status === 'failed' ? 'error' : 'agent'}>
      {entry.content.trim() === '' ? null : <p className="whitespace-pre-wrap text-sm leading-5">{entry.content}</p>}
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
        'absolute -left-[25px] top-1.5 size-2 ring-4 ring-surface',
        tone === 'human' ? 'bg-neutral-500' : tone === 'error' ? 'bg-fail-text' : 'bg-accent-600',
      )} />
      <div className={cn(
        'border p-3',
        tone === 'human' && 'border-accent-300 bg-accent-100',
        tone === 'status' && 'border-accent-300 bg-accent-100',
        tone === 'delivery' && 'border-ok-border bg-ok-surface',
        tone === 'error' && 'border-fail-border bg-fail-surface',
        tone !== 'human' && tone !== 'status' && tone !== 'delivery' && tone !== 'error' && 'border-divider bg-bg',
      )}>
        <header className="mb-2 flex items-center gap-2 text-2xs text-neutral-500">
          <span className="font-semibold text-neutral-700">{actor}</span>
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
    <article className={cn('mt-2 border p-2.5 text-xs', confirmation === null ? 'border-divider bg-surface' : 'border-warn-border bg-warn-surface')}>
      <div className="flex items-center gap-2">
        {running ? <LoaderCircle className="size-4 animate-spin text-accent-text" aria-hidden="true" /> : confirmation === null ? <Wrench className="size-4 text-neutral-500" aria-hidden="true" /> : <CircleAlert className="size-4 text-warn-text" aria-hidden="true" />}
        <span className="font-medium">{toolLabel(call.name)}</span>
        <span className={cn('ml-auto', running ? 'text-accent-text' : confirmation === null ? 'text-ok' : 'text-warn-text')}>
          {running ? <Trans>执行中</Trans> : confirmation === null ? <Trans>已完成</Trans> : confirmationActive ? <Trans>等待你确认</Trans> : <Trans>已处理</Trans>}
        </span>
      </div>
      <p className="mt-1 text-neutral-600">{toolSummary(call)}</p>
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
