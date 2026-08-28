import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  Send,
  Square,
  Undo2,
  Wrench,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
import { mediaAssetStreamPath } from '../data/mediaAssets';
import { useNativeShell } from '../data/nativeShell';
import {
  useAgentChatStream,
  useAgentSession,
  useAppendAgentSessionEntry,
  useCreateAgentSession,
} from '../data/sessions';
import { Empty, Skeleton } from '../design/data';
import { Alert, Dialog } from '../design/feedback';
import { Page, Toolbar } from '../design/layout';
import { Badge, Button, NativeSelect, Seg, cn } from '../design/primitives';
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
  TrackKind,
} from '../shared/desktop/dto';
import { RouteLink } from './RouteLink';

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
  const revert = useRevertProjectChangeGroup(canonicalId ?? '');
  const startRecording = useStartProjectRecording();
  const exportProject = useExportProject();
  const [lens, setLens] = useState<EditingLens>('quick');
  const [agentOpen, setAgentOpen] = useState(true);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const agentSessionId = searchParams.get('session');
  const [confirmRecording, setConfirmRecording] = useState(false);
  const [confirmExport, setConfirmExport] = useState(false);
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
  const visibleTracks = lens === 'quick'
    ? current.document.tracks.filter((track) => track.id === current.document.story_track_id)
    : current.document.tracks;
  const selected = findClip(current, selectedClipId);
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
      toolbar={
        <Toolbar title={current.name} meta={<Trans>r{current.revision} · 统一时间轴</Trans>}>
          <Seg
            name="editing-lens"
            size="sm"
            value={lens}
            aria-label={t`剪辑视图`}
            options={[
              { value: 'quick', label: <Trans>快速剪辑</Trans> },
              { value: 'multitrack', label: <Trans>多轨精剪</Trans> },
            ]}
            onChange={setLens}
          />
          <Button variant={agentOpen ? 'primary' : 'secondary'} size="sm" onClick={() => setAgentOpen((value) => !value)}>
            <Bot className="size-4" aria-hidden="true" />
            <Trans>Agent</Trans>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={readOnly || startRecording.isPending}
            onClick={() => setConfirmRecording(true)}
          >
            <Trans>录制缺失片段</Trans>
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={readOnly || exportProject.isPending}
            onClick={() => setConfirmExport(true)}
          >
            <Trans>导出成片</Trans>
          </Button>
        </Toolbar>
      }
    >
      <div className={cn('grid min-h-0 flex-1', agentOpen ? 'grid-cols-[minmax(0,1fr)_320px]' : 'grid-cols-1')}>
        <div className="grid min-h-0 grid-rows-[minmax(220px,42%)_minmax(0,1fr)] overflow-hidden">
          <PreviewSplit project={current} selected={selected?.clip ?? null} />
          <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_300px]">
            <Timeline
              project={current}
              tracks={visibleTracks}
              selectedClipId={selectedClipId}
              lens={lens}
              readOnly={readOnly}
              onSelect={setSelectedClipId}
              onMove={(track, clip, index) => mutate(
                `移动 ${clip.name}`,
                { kind: 'track', track_id: track.id },
                [{ op: 'move_clip', clip_id: clip.id, to_track_id: track.id, index }],
              )}
              onAddTrack={(kind) => {
                mutate(
                  `添加 ${kind} 轨道`,
                  { kind: 'project' },
                  [{
                    op: 'insert_track',
                    index: current.document.tracks.length,
                    track: {
                      id: '00000000-0000-0000-0000-000000000000',
                      name: trackName(kind),
                      kind,
                      order: current.document.tracks.length,
                      muted: false,
                      locked: false,
                      hidden: false,
                      clips: [],
                    },
                  }],
                );
              }}
            />
            <ClipInspector
              selected={selected}
              readOnly={readOnly}
              onReplace={(clip) => mutate(
                `修改 ${clip.name}`,
                { kind: 'track', track_id: selected?.track.id ?? current.document.story_track_id },
                [{ op: 'replace_clip', clip_id: clip.id, clip }],
              )}
            />
          </div>
        </div>
        {agentOpen ? (
          <AgentPanel
            project={current}
            lens={lens}
            selectedClipId={selectedClipId}
            session={agentSession.data ?? null}
            chat={agentChat}
            creatingSession={createAgentSession.isPending}
            onSend={sendToAgent}
            changeGroups={groups.data ?? []}
            reverting={revert.isPending}
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
              setLens('multitrack');
              setSelectedClipId((value) => value ?? current.document.tracks.flatMap((track) => track.clips)[0]?.id ?? null);
            }}
            onUndo={(changeGroupId) => revert.mutate({
              changeGroupId,
              expectedRevision: current.revision,
            })}
          />
        ) : null}
      </div>
      {apply.error === null && revert.error === null && startRecording.error === null && exportProject.error === null ? null : (
        <Alert className="m-4" variant="danger" action={{ label: <Trans>关闭</Trans>, onAction: () => { apply.reset(); revert.reset(); startRecording.reset(); exportProject.reset(); } }}>
          <Trans>操作没有完成。检查当前 revision、录制环境和 Delivery Gate 后重试。</Trans>
        </Alert>
      )}
      <Dialog
        open={confirmRecording}
        title={<Trans>开始录制这份作品的缺失片段？</Trans>}
        confirmLabel={startRecording.isPending ? <Trans>正在启动</Trans> : <Trans>确认并启动</Trans>}
        confirmDisabled={startRecording.isPending}
        onClose={() => setConfirmRecording(false)}
        onConfirm={() => {
          startRecording.mutate(
            { projectId: current.id },
            { onSuccess: () => setConfirmRecording(false) },
          );
        }}
      >
        <Trans>将启动受管的离线 CS2/HLAE 录制并写出媒体文件。只录制未录制或已过期的 Capture Intent；已完成的 Take 不会重复录制。</Trans>
      </Dialog>
      <Dialog
        open={confirmExport}
        title={<Trans>导出这份作品的最终成片？</Trans>}
        confirmLabel={exportProject.isPending ? <Trans>正在启动</Trans> : <Trans>确认并导出</Trans>}
        confirmDisabled={exportProject.isPending}
        onClose={() => setConfirmExport(false)}
        onConfirm={() => {
          exportProject.mutate(
            { projectId: current.id },
            { onSuccess: () => setConfirmExport(false) },
          );
        }}
      >
        <Trans>最终导出会写出 MP4。Delivery Gate 会拒绝任何仍未录制、媒体已过期或超出源素材范围的启用片段。</Trans>
      </Dialog>
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
    <section className="min-h-0 border-b border-divider bg-surface" aria-label={t`预览分栏`}>
      <div
        ref={splitRef}
        className="grid h-full min-h-0"
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
    <section className="flex min-h-0 flex-col bg-neutral-900 text-neutral-100" aria-label={t`视频预览`}>
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
  return (
    <section className="flex min-h-0 flex-col bg-neutral-900 text-neutral-100" aria-label={t`战术示意`}>
      <header className="flex h-[var(--h-panel-head)] flex-none items-center border-b border-neutral-800 px-4 text-xs font-semibold">
        <Trans>战术示意</Trans>
        <span className="ml-auto font-mono font-normal text-neutral-400">
          {intent === null ? <Trans>等待片段</Trans> : <Trans>tick {intent.start_tick}–{intent.end_tick}</Trans>}
        </span>
      </header>
      <div className="relative grid min-h-0 flex-1 place-items-center overflow-hidden p-4">
        <svg viewBox="0 0 480 280" className="h-full max-h-72 w-full" role="img" aria-label={t`当前片段的战术路径示意`}>
          <path d="M34 44h126v48h52v-30h102v42h132v78h-92v62H238v-38H122v42H34v-86h58v-58H34z" className="fill-neutral-800 stroke-neutral-500" strokeWidth="3" />
          <path d="M160 44v64h78v98M314 104v78h40M92 162h146" fill="none" className="stroke-neutral-600" strokeWidth="10" strokeLinecap="square" />
          <path d="M75 202C142 194 142 132 205 136S286 190 354 146" fill="none" className="stroke-team-a" strokeWidth="4" strokeDasharray="10 8" />
          <path d="M394 89C350 110 332 134 302 161S244 199 205 204" fill="none" className="stroke-team-b" strokeWidth="4" strokeDasharray="10 8" />
          <circle cx="75" cy="202" r="11" className="fill-team-a stroke-bg" strokeWidth="3" />
          <circle cx="205" cy="136" r="11" className="fill-team-a stroke-bg" strokeWidth="3" />
          <circle cx="354" cy="146" r="11" className="fill-team-a stroke-bg" strokeWidth="3" />
          <circle cx="394" cy="89" r="11" className="fill-team-b stroke-bg" strokeWidth="3" />
          <circle cx="302" cy="161" r="11" className="fill-team-b stroke-bg" strokeWidth="3" />
          <path d="M226 187l7 14 16 2-12 11 3 16-14-8-15 8 3-16-12-11 17-2z" className="fill-fail stroke-bg" strokeWidth="2" />
        </svg>
        <div className="pointer-events-none absolute self-end pb-3 text-center text-xs text-neutral-400">
          {selected === null ? <Trans>选择片段后显示路径与事件</Trans> : intent === null ? <Trans>这段素材没有 Capture Intent</Trans> : intent.player_id}
        </div>
      </div>
    </section>
  );
}

function Timeline({
  project,
  tracks,
  selectedClipId,
  lens,
  readOnly,
  onSelect,
  onMove,
  onAddTrack,
}: {
  readonly project: Project;
  readonly tracks: readonly TimelineTrack[];
  readonly selectedClipId: string | null;
  readonly lens: EditingLens;
  readonly readOnly: boolean;
  readonly onSelect: (clipId: string) => void;
  readonly onMove: (track: TimelineTrack, clip: TimelineClip, index: number) => void;
  readonly onAddTrack: (kind: TrackKind) => void;
}) {
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
        {lens === 'multitrack' ? (
          <NativeSelect aria-label={t`添加轨道`} value="" disabled={readOnly} onChange={(event) => {
            const value = event.currentTarget.value as TrackKind | '';
            if (value !== '') onAddTrack(value);
          }}>
            <option value=""><Trans>＋ 添加轨道</Trans></option>
            <option value="video"><Trans>视频</Trans></option>
            <option value="audio"><Trans>音频</Trans></option>
            <option value="text"><Trans>文字</Trans></option>
            <option value="overlay"><Trans>叠加</Trans></option>
          </NativeSelect>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-auto bg-surface-chrome p-3">
        <div className="flex min-w-max flex-col gap-2">
          {tracks.map((track) => (
            <div key={track.id} className="grid grid-cols-[140px_minmax(680px,1fr)] border border-divider bg-bg">
              <div className="border-r border-divider p-3">
                <p className="font-medium">{track.name}</p>
                <p className="mt-1 text-xs text-neutral-600">{track.kind}</p>
              </div>
              <ol className="flex min-h-20 list-none items-stretch gap-1 p-2">
                {track.clips.length === 0 ? (
                  <li className="flex min-w-48 items-center justify-center border border-dashed border-divider text-xs text-neutral-500">
                    <Trans>空轨道</Trans>
                  </li>
                ) : track.clips.map((clip, index) => (
                  <li
                    key={clip.id}
                    className={cn(
                      'group relative flex min-w-40 max-w-64 flex-col border p-2',
                      clip.material.kind === 'planned'
                        ? 'border-warn-border bg-warn-surface'
                        : 'border-ok-border bg-ok-surface',
                    )}
                  >
                    <button
                      type="button"
                      className={cn('min-h-12 text-left', selectedClipId === clip.id && 'text-accent-text')}
                      onClick={() => onSelect(clip.id)}
                    >
                      <span className="block truncate text-sm">{clip.name}</span>
                      <span className="mt-1 flex items-center gap-1.5 font-mono text-2xs text-neutral-600">
                        <span className={cn('size-1.5', clip.material.kind === 'planned' ? 'bg-warn' : 'bg-ok')} aria-hidden="true" />
                        {clip.placement.duration.toFixed(1)}s · {materialLabel(clip)}
                      </span>
                    </button>
                    <div className="mt-auto flex justify-end gap-1 pt-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                      <Button size="sm" variant="ghost" aria-label={t`向左移动`} disabled={readOnly || index === 0} onClick={() => onMove(track, clip, index - 1)}><ChevronLeft className="size-3" /></Button>
                      <Button size="sm" variant="ghost" aria-label={t`向右移动`} disabled={readOnly || index + 1 === track.clips.length} onClick={() => onMove(track, clip, index + 1)}><ChevronRight className="size-3" /></Button>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </div>
    </section>
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
    <aside className="min-h-0 overflow-y-auto border-l border-divider p-4" aria-label={t`片段属性`}>
      <h2 className="font-heading text-sm"><Trans>片段属性</Trans></h2>
      <label className="mt-4 flex flex-col gap-1 text-xs">
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
    </aside>
  );
}

function AgentPanel({
  project,
  lens,
  selectedClipId,
  session,
  chat,
  creatingSession,
  onSend,
  changeGroups,
  reverting,
  readOnly,
  confirming,
  onConfirmRecording,
  onConfirmExport,
  onRejectConfirmation,
  onAcceptDelivery,
  onReturnDelivery,
  onDirectEdit,
  onUndo,
}: {
  readonly project: Project;
  readonly lens: EditingLens;
  readonly selectedClipId: string | null;
  readonly session: import('../shared/desktop/dto').AgentSession | null;
  readonly chat: ReturnType<typeof useAgentChatStream>;
  readonly creatingSession: boolean;
  readonly onSend: (message: string) => Promise<void>;
  readonly changeGroups: readonly ProjectChangeGroup[];
  readonly reverting: boolean;
  readonly readOnly: boolean;
  readonly confirming: boolean;
  readonly onConfirmRecording: (clipIds: string[]) => Promise<void>;
  readonly onConfirmExport: () => Promise<void>;
  readonly onRejectConfirmation: () => Promise<void>;
  readonly onAcceptDelivery: () => Promise<void>;
  readonly onReturnDelivery: () => Promise<void>;
  readonly onDirectEdit: () => void;
  readonly onUndo: (changeGroupId: string) => void;
}) {
  const [message, setMessage] = useState('');
  const entries = session?.entries ?? [];
  const pendingConfirmationEntryId = pendingConfirmationEntry(entries);
  const items: ConversationItem[] = [
    ...entries.map((entry) => ({ kind: 'entry' as const, at: entry.at, entry })),
    ...changeGroups.map((group) => ({ kind: 'change' as const, at: group.created_at, group })),
  ].sort((left, right) => left.at.localeCompare(right.at));
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
  return (
    <aside className="flex min-h-0 flex-col border-l border-divider bg-surface" aria-label={t`Agent 面板`}>
      <header className="border-b border-divider px-4 py-3">
        <h2 className="font-heading text-sm"><Trans>Agent</Trans></h2>
        <p className="mt-1 text-xs text-neutral-600"><Trans>操作当前 Project · r{project.revision}</Trans></p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <ol className="relative ml-2 flex list-none flex-col gap-4 border-l border-divider py-1 pl-5">
            {session === null || entries.length === 0 ? (
              <ConversationShell actor="Agent" tone="agent">
                <Bot className="mb-2 size-5" aria-hidden="true" />
                <p className="text-sm text-neutral-600"><Trans>让 Agent 直接修改左侧同一条时间轴；整条重排会作为一个可撤销修改提交。</Trans></p>
              </ConversationShell>
            ) : null}
            {items.map((item) => item.kind === 'entry' ? (
              <ConversationEntry
                key={`entry:${item.entry.id}`}
                entry={item.entry}
                confirmationActive={item.entry.id === pendingConfirmationEntryId}
                confirming={confirming}
                onConfirmRecording={onConfirmRecording}
                onConfirmExport={onConfirmExport}
                onRejectConfirmation={onRejectConfirmation}
              />
            ) : (
              <ConversationChange
                key={`change:${item.group.id}`}
                group={item.group}
                readOnly={readOnly}
                reverting={reverting}
                onUndo={onUndo}
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
        {chat.error === null ? null : <p className="mt-2 text-xs text-fail-text">{chat.error}</p>}
      </div>
      <footer className="border-t border-divider p-3">
        <p className="mb-2 text-2xs text-neutral-500">{lens} · {selectedClipId ?? t`未选择片段`}</p>
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

type ConversationItem =
  | { readonly kind: 'entry'; readonly at: string; readonly entry: AgentSessionEntry }
  | { readonly kind: 'change'; readonly at: string; readonly group: ProjectChangeGroup };

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

function ConversationChange({
  group,
  readOnly,
  reverting,
  onUndo,
}: {
  readonly group: ProjectChangeGroup;
  readonly readOnly: boolean;
  readonly reverting: boolean;
  readonly onUndo: (changeGroupId: string) => void;
}) {
  const actor = group.author.kind === 'agent'
    ? t`Agent · 时间线`
    : group.author.kind === 'human'
      ? t`你 · 时间线`
      : t`系统 · 时间线`;
  return (
    <ConversationShell actor={actor} at={group.created_at} tone="change">
      <p className="text-sm">{group.summary}</p>
      <div className="mt-2 flex items-center gap-2 text-xs text-neutral-600">
        <CheckCircle2 className="size-3.5 text-ok" aria-hidden="true" />
        <span><Trans>r{group.from_revision} → r{group.to_revision}</Trans></span>
        <Button className="ml-auto" size="sm" variant="ghost" disabled={readOnly || reverting} onClick={() => onUndo(group.id)}>
          <Undo2 className="size-3" aria-hidden="true" /><Trans>撤销</Trans>
        </Button>
      </div>
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
  readonly tone: 'agent' | 'human' | 'tool' | 'status' | 'delivery' | 'change' | 'error';
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

function trackName(kind: TrackKind) {
  switch (kind) {
    case 'video': return 'Video';
    case 'audio': return 'Audio';
    case 'text': return 'Text';
    case 'overlay': return 'Overlay';
  }
}
