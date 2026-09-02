import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentSession, AgentSessionEntryDraft, AgentTurnUpdate, ExportJobRecord, MediaAsset, Project, ProjectChangeGroup, ProjectDeliveryGate, ProjectEditLease, ProjectPatch, ProjectPatchResult, TimelineClip, TimelineTrack } from '../shared/desktop/dto';
import { unavailableNativeShell, type NativeShell } from '../data/nativeShell';
import { renderPage } from './delivery/test/renderPage';
import { ProjectWorkspacePage } from './ProjectWorkspacePage';

vi.mock('flexlayout-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('flexlayout-react')>();
  const React = await import('react');
  const panelIds = ['project-panel', 'program-panel', 'tactical-panel', 'timeline-panel', 'agent-panel', 'mixer-panel'];
  return {
    ...actual,
    Layout: ({ model, factory, onRenderTab }: React.ComponentProps<typeof actual.Layout>) => React.createElement(
      'div',
      { className: 'flexlayout__layout', 'data-testid': 'flexlayout-test-host' },
      panelIds.map((id) => {
        const node = model.getNodeById(id) as import('flexlayout-react').TabNode;
        const values = { content: node.getName() } as import('flexlayout-react').ITabRenderValues;
        onRenderTab?.(node, values);
        return React.createElement(
          'section',
          { key: id },
          React.createElement('button', { role: 'tab' }, values.content),
          factory(node),
        );
      }),
    ),
  };
});

afterEach(() => {
  if (Object.prototype.hasOwnProperty.call(document, 'elementFromPoint')) {
    Reflect.deleteProperty(document, 'elementFromPoint');
  }
});

const STORY_ID = '00000000-0000-4000-8000-000000000010';
const CLIP_A = '00000000-0000-4000-8000-000000000011';
const CLIP_B = '00000000-0000-4000-8000-000000000012';
const CLIP_C = '00000000-0000-4000-8000-000000000019';
beforeEach(() => {
  globalThis.localStorage.clear();
});

function clip(id: string, name: string): TimelineClip {
  return {
    id,
    name,
    capture_intent: null,
    material: { kind: 'planned' },
    placement: { start: 0, duration: 5, source_in: 0, source_out: 5, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    effects: [],
    transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null },
    text: null,
    metadata: {},
    group_id: null,
    link_group_id: null,
    keyframes: [],
    speed_segments: [],
  };
}

function mediaDragTransfer(): DataTransfer {
  const values = new Map<string, string>();
  return {
    effectAllowed: 'none',
    dropEffect: 'none',
    get types() { return [...values.keys()]; },
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    clearData: (format?: string) => {
      if (format === undefined) values.clear();
      else values.delete(format);
    },
    getData: (format: string) => values.get(format) ?? '',
    setData: (format: string, data: string) => { values.set(format, data); },
    setDragImage: () => undefined,
  };
}

function deliveryGateFor(project: Project): ProjectDeliveryGate {
  const blockers: ProjectDeliveryGate['blockers'] = [];
  for (const clip of project.document.tracks.flatMap((track) => track.clips)) {
    if (!clip.placement.enabled || clip.text !== null) continue;
    if (clip.material.kind === 'planned') {
      blockers.push({ clip_id: clip.id, state: clip.capture_intent === null ? 'unbound' : 'unrecorded' });
      continue;
    }
    if (clip.placement.source_out > clip.material.media_duration_seconds + 0.001) {
      blockers.push({ clip_id: clip.id, state: 'stale' });
    }
  }
  return { project_id: project.id, revision: project.revision, ready: blockers.length === 0, blockers };
}

function mediaDragEvent(
  type: 'dragstart' | 'dragover' | 'drop',
  dataTransfer: DataTransfer,
  options: { readonly clientX?: number; readonly ctrlKey?: boolean } = {},
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: options.clientX ?? 0,
    ctrlKey: options.ctrlKey ?? false,
  });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  return event;
}

function openTimelineCommands(): void {
  fireEvent.pointerDown(screen.getByRole('button', { name: '剪辑操作' }), { button: 0, ctrlKey: false });
}

function runTimelineCommand(name: string): void {
  openTimelineCommands();
  fireEvent.click(screen.getByRole('menuitem', { name }));
}

function openMarkerCommands(): void {
  fireEvent.pointerDown(screen.getByRole('button', { name: '标记操作' }), { button: 0, ctrlKey: false });
}

function runMarkerCommand(name: string): void {
  openMarkerCommands();
  fireEvent.click(screen.getByRole('menuitem', { name }));
}

function openAddCommands(): void {
  fireEvent.pointerDown(screen.getByRole('button', { name: '添加到时间轴' }), { button: 0, ctrlKey: false });
}

function runAddCommand(name: string): void {
  openAddCommands();
  fireEvent.click(screen.getByRole('menuitem', { name }));
}

function openDisplayCommands(): void {
  fireEvent.pointerDown(screen.getByRole('button', { name: '时间轴显示设置' }), { button: 0, ctrlKey: false });
}

function runTrackCommand(trackName: string, name: string): void {
  fireEvent.pointerDown(screen.getByRole('button', { name: `轨道操作 ${trackName}` }), { button: 0, ctrlKey: false });
  fireEvent.click(screen.getByRole('menuitem', { name }));
}

function stepTimelineFrames(playhead: HTMLElement, frames: number): void {
  const key = frames >= 0 ? 'ArrowRight' : 'ArrowLeft';
  let remaining = Math.abs(frames);
  while (remaining >= 5) {
    fireEvent.keyDown(playhead, { key, shiftKey: true });
    remaining -= 5;
  }
  while (remaining > 0) {
    fireEvent.keyDown(playhead, { key });
    remaining -= 1;
  }
}

function stepTimelineSeconds(playhead: HTMLElement, seconds: number, fps = 60): void {
  stepTimelineFrames(playhead, Math.round(seconds * fps));
}

const PROJECT: Project = {
  id: '00000000-0000-4000-8000-000000000001',
  name: '统一作品',
  revision: 1,
  document: {
    width: 1920,
    height: 1080,
    fps: 60,
    duration_seconds: 60,
    story_track_id: STORY_ID,
    tracks: [
      {
        id: STORY_ID,
        name: 'Story',
        kind: 'video',
        order: 0,
        muted: false,
        solo: false,
        volume: 1,
        pan: 0,
        keyframes: [],
        locked: false,
        hidden: false,
        clips: [
          clip(CLIP_A, 'A'),
          {
            ...clip(CLIP_B, 'B'),
            material: { kind: 'asset', asset_id: 'asset-b', media_duration_seconds: 5 },
            placement: { start: 5, duration: 5, source_in: 0, source_out: 5, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
          },
        ],
      },
      { id: '00000000-0000-4000-8000-000000000013', name: 'Music', kind: 'audio', order: 1, muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false, clips: [] },
    ],
    markers: [],
    settings: { source_demo_ids: [], ripple_sequence_markers: false, use_media_proxies: false },
  },
  created_at: '2026-08-28T00:00:00Z',
  updated_at: '2026-08-28T00:00:00Z',
};

const RECORDED_PROJECT: Project = {
  ...PROJECT,
  document: {
    ...PROJECT.document,
    duration_seconds: 10,
    tracks: PROJECT.document.tracks.map((track) => track.id !== STORY_ID ? track : {
      ...track,
      clips: [
        { ...clip(CLIP_A, 'A'), material: { kind: 'asset', asset_id: 'asset-a', media_duration_seconds: 5 } },
        {
          ...clip(CLIP_B, 'B'),
          material: { kind: 'asset', asset_id: 'asset-b', media_duration_seconds: 6 },
          placement: { start: 5, duration: 5, source_in: 1, source_out: 6, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
        },
      ],
    }),
  },
};

const RECORDABLE_PROJECT: Project = {
  ...PROJECT,
  document: {
    ...PROJECT.document,
    tracks: PROJECT.document.tracks.map((track) => track.id !== STORY_ID ? track : {
      ...track,
      clips: track.clips.map((candidate) => candidate.id !== CLIP_A ? candidate : {
        ...candidate,
        capture_intent: {
          demo_id: '00000000-0000-4000-8000-000000000200',
          highlight_id: null,
          player_id: 'player-a',
          start_tick: 100,
          end_tick: 200,
          pre_roll_seconds: 1,
          post_roll_seconds: 1,
          victim_pov: false,
          camera_style: 'pov',
          presentation: null,
        },
      }),
    }),
  },
};

const LINKED_AUDIO_CLIP_ID = '00000000-0000-4000-8000-000000000090';
const LINK_GROUP_ID = '00000000-0000-4000-8000-000000000091';

function linkedProject(): Project {
  const audioClip: TimelineClip = {
    ...clip(LINKED_AUDIO_CLIP_ID, 'Bed'),
    material: { kind: 'asset', asset_id: 'asset-audio', media_duration_seconds: 30 },
    placement: { start: 12, duration: 5, source_in: 0, source_out: 5, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
    link_group_id: LINK_GROUP_ID,
  };
  return {
    ...PROJECT,
    document: {
      ...PROJECT.document,
      tracks: PROJECT.document.tracks.map((track) => track.id === STORY_ID
        ? { ...track, clips: track.clips.map((candidate) => candidate.id === CLIP_A ? { ...candidate, link_group_id: LINK_GROUP_ID } : candidate) }
        : track.kind === 'audio' ? { ...track, clips: [audioClip] } : track),
    },
  };
}

function groupedProject(): Project {
  return {
    ...PROJECT,
    document: {
      ...PROJECT.document,
      tracks: PROJECT.document.tracks.map((track) => track.id === STORY_ID
        ? { ...track, clips: track.clips.map((clip) => ({ ...clip, group_id: '00000000-0000-4000-8000-000000000170' })) }
        : track),
    },
  };
}

function outOfSyncProject(): Project {
  const video: TimelineTrack = {
    id: '00000000-0000-4000-8000-000000000171', name: 'Detached video', kind: 'video', order: 2,
    muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false,
    clips: [{
      ...clip('00000000-0000-4000-8000-000000000172', 'Detached video'),
      placement: { start: 2 + 2 / 60, duration: 2, source_in: 0, source_out: 2, speed: 1, reverse: false, frame_hold_source_time: null, volume: 0, pan: 0, enabled: true },
      metadata: { sync_reference_group_id: 'detached', sync_reference_start: 2 },
      link_group_id: null,
    }],
  };
  const audioClip: TimelineClip = {
    ...clip('00000000-0000-4000-8000-000000000173', 'Detached audio'),
    placement: { start: 2, duration: 2, source_in: 0, source_out: 2, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
    metadata: { sync_reference_group_id: 'detached', sync_reference_start: 2 },
    link_group_id: null,
  };
  return {
    ...PROJECT,
    document: {
      ...PROJECT.document,
      tracks: [...PROJECT.document.tracks.map((track) => track.kind === 'audio' ? { ...track, clips: [audioClip] } : track), video],
    },
  };
}

function targetedRangeProject(): Project {
  const audioClip: TimelineClip = {
    ...clip('00000000-0000-4000-8000-000000000092', 'Range audio'),
    material: { kind: 'asset', asset_id: 'asset-range-audio', media_duration_seconds: 10 },
    placement: { start: 0, duration: 10, source_in: 0, source_out: 10, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
  };
  return {
    ...PROJECT,
    document: {
      ...PROJECT.document,
      tracks: PROJECT.document.tracks.map((track) => track.kind === 'audio'
        ? { ...track, clips: [audioClip] }
        : track),
    },
  };
}

function razorLinkedProject(): Project {
  const linkGroupId = '00000000-0000-4000-8000-000000000093';
  const audioClip: TimelineClip = {
    ...clip('00000000-0000-4000-8000-000000000094', 'A audio'),
    material: { kind: 'asset', asset_id: 'asset-a', media_duration_seconds: 5 },
    placement: { start: 0, duration: 5, source_in: 0, source_out: 5, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
    link_group_id: linkGroupId,
  };
  return {
    ...PROJECT,
    document: {
      ...PROJECT.document,
      tracks: PROJECT.document.tracks.map((track) => track.id === STORY_ID
        ? {
            ...track,
            clips: track.clips.map((candidate) => candidate.id === CLIP_A
              ? { ...candidate, link_group_id: linkGroupId }
              : candidate),
          }
        : track.kind === 'audio' ? { ...track, clips: [audioClip] } : track),
    },
  };
}

function navigationProject(): Project {
  const overlay: TimelineTrack = {
    id: '00000000-0000-4000-8000-000000000095',
    name: 'B-Roll',
    kind: 'video',
    order: 2,
    muted: false,
    solo: false,
    volume: 1,
    pan: 0,
    keyframes: [],
    locked: false,
    hidden: false,
    clips: [{
      ...clip('00000000-0000-4000-8000-000000000096', 'Overlay'),
      placement: { start: 2, duration: 6, source_in: 0, source_out: 6, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
    }],
  };
  return {
    ...PROJECT,
    document: { ...PROJECT.document, tracks: [...PROJECT.document.tracks, overlay] },
  };
}

function syncLockProject(): Project {
  const overlay: TimelineTrack = {
    id: '00000000-0000-4000-8000-000000000097',
    name: 'B-Roll',
    kind: 'video',
    order: 2,
    muted: false,
    solo: false,
    volume: 1,
    pan: 0,
    keyframes: [],
    locked: false,
    hidden: false,
    clips: [{
      ...clip('00000000-0000-4000-8000-000000000098', 'Overlay'),
      placement: { start: 6, duration: 2, source_in: 0, source_out: 2, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
    }],
  };
  return {
    ...PROJECT,
    document: { ...PROJECT.document, tracks: [...PROJECT.document.tracks, overlay] },
  };
}

function crossTrackProject(): Project {
  const source: TimelineTrack = {
    id: '00000000-0000-4000-8000-000000000160', name: 'Source V2', kind: 'video', order: 2,
    muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false,
    clips: [{
      ...clip('00000000-0000-4000-8000-000000000161', 'Move me'),
      placement: { start: 2, duration: 2, source_in: 0, source_out: 2, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
    }],
  };
  const target: TimelineTrack = {
    id: '00000000-0000-4000-8000-000000000162', name: 'Target V3', kind: 'video', order: 3,
    muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false,
    clips: [{
      ...clip('00000000-0000-4000-8000-000000000163', 'Covered'),
      placement: { start: 0, duration: 10, source_in: 0, source_out: 10, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
    }],
  };
  return {
    ...PROJECT,
    document: { ...PROJECT.document, tracks: [...PROJECT.document.tracks, source, target] },
  };
}

function slideProject(): Project {
  const recorded = (id: string, name: string, start: number, duration: number, sourceIn: number): TimelineClip => ({
    ...clip(id, name),
    material: { kind: 'asset', asset_id: `asset-${name.toLowerCase()}`, media_duration_seconds: 10 },
    placement: {
      ...clip(id, name).placement,
      start,
      duration,
      source_in: sourceIn,
      source_out: sourceIn + duration,
    },
  });
  return {
    ...PROJECT,
    document: {
      ...PROJECT.document,
      duration_seconds: 10,
      tracks: PROJECT.document.tracks.map((track) => track.id === STORY_ID
        ? {
            ...track,
            clips: [
              recorded(CLIP_A, 'A', 0, 4, 0),
              recorded(CLIP_B, 'B', 4, 2, 1),
              recorded(CLIP_C, 'C', 6, 4, 2),
            ],
          }
        : track),
    },
  };
}

function renderWorkspace({
  applyProjectPatch = vi.fn(),
  revertProjectChangeGroup = vi.fn(),
  session = null,
  lease = null,
  groups = [],
  assets = [],
  agentConfigured = true,
  project = PROJECT,
  deliveryGate = deliveryGateFor(project),
  getProject,
  getActivity,
  listMediaAssets,
  createProjectRecordingPlan,
  executeRecordingPlan,
  exportProject,
  cancelExportJob,
  relinkMediaAsset,
  deleteMediaAsset,
  replaceMediaAssetMarkers,
  generateMediaProxy,
  cleanupMediaProxies,
  listProjectRenderPreviews,
  renderProjectPreview,
  clearProjectRenderPreviews,
  listProjects,
  listNestedSequenceMedia,
  createNestedSequence,
  refreshNestedSequence,
  createMulticam,
  switchMulticamAngle,
  streamAgentChat,
  appendAgentSessionEntry,
  updateAgentTurn,
  cancelAgentChat,
  shell,
}: {
  readonly applyProjectPatch?: ReturnType<typeof vi.fn>;
  readonly revertProjectChangeGroup?: ReturnType<typeof vi.fn>;
  readonly session?: AgentSession | null;
  readonly lease?: ProjectEditLease | null;
  readonly groups?: readonly ProjectChangeGroup[];
  readonly assets?: readonly MediaAsset[];
  readonly agentConfigured?: boolean;
  readonly project?: Project;
  readonly deliveryGate?: ProjectDeliveryGate;
  readonly getProject?: ((projectId: string) => Promise<Project>) | undefined;
  readonly getActivity?: ReturnType<typeof vi.fn> | undefined;
  readonly listMediaAssets?: ReturnType<typeof vi.fn> | undefined;
  readonly createProjectRecordingPlan?: ReturnType<typeof vi.fn> | undefined;
  readonly executeRecordingPlan?: ReturnType<typeof vi.fn> | undefined;
  readonly exportProject?: ReturnType<typeof vi.fn> | undefined;
  readonly cancelExportJob?: ReturnType<typeof vi.fn> | undefined;
  readonly relinkMediaAsset?: ReturnType<typeof vi.fn> | undefined;
  readonly deleteMediaAsset?: ReturnType<typeof vi.fn> | undefined;
  readonly replaceMediaAssetMarkers?: ReturnType<typeof vi.fn> | undefined;
  readonly generateMediaProxy?: ReturnType<typeof vi.fn> | undefined;
  readonly cleanupMediaProxies?: ReturnType<typeof vi.fn> | undefined;
  readonly listProjectRenderPreviews?: ReturnType<typeof vi.fn> | undefined;
  readonly renderProjectPreview?: ReturnType<typeof vi.fn> | undefined;
  readonly clearProjectRenderPreviews?: ReturnType<typeof vi.fn> | undefined;
  readonly listProjects?: ReturnType<typeof vi.fn> | undefined;
  readonly listNestedSequenceMedia?: ReturnType<typeof vi.fn> | undefined;
  readonly createNestedSequence?: ReturnType<typeof vi.fn> | undefined;
  readonly refreshNestedSequence?: ReturnType<typeof vi.fn> | undefined;
  readonly createMulticam?: ReturnType<typeof vi.fn> | undefined;
  readonly switchMulticamAngle?: ReturnType<typeof vi.fn> | undefined;
  readonly streamAgentChat?: ReturnType<typeof vi.fn> | undefined;
  readonly appendAgentSessionEntry?: ReturnType<typeof vi.fn> | undefined;
  readonly updateAgentTurn?: ReturnType<typeof vi.fn> | undefined;
  readonly cancelAgentChat?: ReturnType<typeof vi.fn> | undefined;
  readonly shell?: NativeShell | undefined;
} = {}) {
  return renderPage({
    element: <ProjectWorkspacePage />,
    client: {
      listProjects: listProjects ?? (() => Promise.resolve([project])),
      getProject: getProject ?? (() => Promise.resolve(project)),
      getProjectDeliveryGate: () => Promise.resolve(deliveryGate),
      ...(getActivity === undefined ? {} : { getActivity }),
      ...(createProjectRecordingPlan === undefined ? {} : { createProjectRecordingPlan }),
      ...(executeRecordingPlan === undefined ? {} : { executeRecordingPlan }),
      ...(exportProject === undefined ? {} : { exportProject }),
      ...(cancelExportJob === undefined ? {} : { cancelExportJob }),
      listProjectChangeGroups: () => Promise.resolve(groups),
      listMediaAssets: listMediaAssets ?? (() => Promise.resolve({ items: assets })),
      ...(relinkMediaAsset === undefined ? {} : { relinkMediaAsset }),
      ...(deleteMediaAsset === undefined ? {} : { deleteMediaAsset }),
      ...(replaceMediaAssetMarkers === undefined ? {} : { replaceMediaAssetMarkers }),
      ...(generateMediaProxy === undefined ? {} : { generateMediaProxy }),
      ...(cleanupMediaProxies === undefined ? {} : { cleanupMediaProxies }),
      listProjectRenderPreviews: listProjectRenderPreviews ?? (() => Promise.resolve([])),
      ...(renderProjectPreview === undefined ? {} : { renderProjectPreview }),
      ...(clearProjectRenderPreviews === undefined ? {} : { clearProjectRenderPreviews }),
      listNestedSequenceMedia: listNestedSequenceMedia ?? (() => Promise.resolve([])),
      ...(createNestedSequence === undefined ? {} : { createNestedSequence }),
      ...(refreshNestedSequence === undefined ? {} : { refreshNestedSequence }),
      ...(createMulticam === undefined ? {} : { createMulticam }),
      ...(switchMulticamAngle === undefined ? {} : { switchMulticamAngle }),
      ...(streamAgentChat === undefined ? {} : { streamAgentChat }),
      ...(appendAgentSessionEntry === undefined ? {} : { appendAgentSessionEntry }),
      ...(updateAgentTurn === undefined ? {} : { updateAgentTurn }),
      ...(cancelAgentChat === undefined ? {} : { cancelAgentChat }),
      getProjectEditLease: () => Promise.resolve(lease),
      agentStatus: () => Promise.resolve({ runtimeAvailable: true, configured: agentConfigured, provider: agentConfigured ? 'test' : '', model: agentConfigured ? 'test' : '', streaming: true }),
      ...(session === null ? {} : { getAgentSession: () => Promise.resolve(session) }),
      applyProjectPatch,
      revertProjectChangeGroup,
    },
    route: `/projects/${project.id}${session === null ? '' : `?session=${session.id}`}`,
    pattern: '/projects/:projectId',
    shell,
  });
}

describe('unified project workspace', () => {
  it('hosts Project, monitors, Timeline and Agent in one dockable workspace', async () => {
    renderWorkspace();

    expect(await screen.findByRole('heading', { name: '统一作品' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'NiKo 3 分钟集锦' })).toBeNull();
    expect(screen.queryByText('创建于 2 小时前')).toBeNull();
    expect(screen.getByText('1 个素材未就绪')).toBeTruthy();
    expect(screen.queryByText('Agent 修改待审阅')).toBeNull();
    expect(await screen.findByRole('region', { name: '视频预览' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '战术示意' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '时间轴' })).toBeTruthy();
    expect(screen.getByLabelText('Agent 面板')).toBeTruthy();
    expect(screen.getByRole('tab', { name: '项目素材' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '视频预览' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '战术示意' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '时间轴（修改审阅）' })).toBeTruthy();
    expect(screen.queryByText('修改注释')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Agent' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '音轨混音器' })).toBeTruthy();
    expect(document.querySelector('[data-dock-panel="project"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重置工作区布局' })).toBeTruthy();
  });

  it('exports the canonical timeline as an OTIO document through the native save seam', async () => {
    const saveBytes = vi.fn<NativeShell['saveBytes']>(() => Promise.resolve('C:\\Temp\\timeline.otio'));
    renderWorkspace({ shell: { ...unavailableNativeShell, available: true, saveBytes } });

    fireEvent.pointerDown(await screen.findByRole('button', { name: '项目互换' }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole('menuitem', { name: '导出 OpenTimelineIO…' }));

    await waitFor(() => expect(saveBytes).toHaveBeenCalledTimes(1));
    const options = saveBytes.mock.calls[0]![0];
    expect(options.defaultFileName).toBe('统一作品.otio');
    const document = JSON.parse(new TextDecoder().decode(options.bytes));
    expect(document).toMatchObject({ OTIO_SCHEMA: 'Timeline.1', name: '统一作品' });
    expect(document.tracks.children[0].metadata.vibe_cs.track_kind).toBe('video');
  });

  it('imports an OTIO document as one canonical Project patch', async () => {
    const imported = {
      OTIO_SCHEMA: 'Timeline.1',
      name: 'Imported',
      metadata: {},
      global_start_time: null,
      tracks: {
        OTIO_SCHEMA: 'Stack.1', name: 'tracks', source_range: null, effects: [], markers: [], metadata: {}, enabled: true,
        children: [{
          OTIO_SCHEMA: 'Track.1', name: 'Imported Story', kind: 'Video', source_range: null, effects: [], markers: [], metadata: {}, enabled: true,
          children: [{
            OTIO_SCHEMA: 'Clip.2', name: 'Imported Clip', enabled: true, effects: [], markers: [], metadata: {},
            source_range: {
              OTIO_SCHEMA: 'TimeRange.1',
              start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 60, rate: 60 },
              duration: { OTIO_SCHEMA: 'RationalTime.1', value: 120, rate: 60 },
            },
            media_reference: { OTIO_SCHEMA: 'MissingReference.1', name: 'Imported Clip', metadata: {} },
          }],
        }],
      },
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({
      applyProjectPatch,
      shell: {
        ...unavailableNativeShell,
        available: true,
        chooseFile: () => Promise.resolve('C:\\Temp\\import.otio'),
        readBytes: () => Promise.resolve(new TextEncoder().encode(JSON.stringify(imported))),
      },
    });

    fireEvent.pointerDown(await screen.findByRole('button', { name: '项目互换' }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole('menuitem', { name: '导入 OTIO / XML / EDL…' }));
    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      project_id: PROJECT.id,
      base_revision: PROJECT.revision,
      scope: { kind: 'project' },
      operations: [
        expect.objectContaining({
          op: 'replace_track',
          track_id: STORY_ID,
          track: expect.objectContaining({ name: 'Imported Story', kind: 'video', clips: [expect.objectContaining({
            name: 'Imported Clip',
            material: { kind: 'planned' },
            placement: expect.objectContaining({ start: 0, duration: 2, source_in: 1, source_out: 3 }),
          })] }),
        }),
        { op: 'remove_track', track_id: '00000000-0000-4000-8000-000000000013' },
        { op: 'replace_markers', markers: [] },
      ],
    })));
  });

  it('writes Track Mixer automation through one canonical track replacement', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    const mixer = await screen.findByRole('region', { name: '音轨混音器' });
    const story = within(mixer).getByLabelText('混音轨 Story');
    const volume = within(story).getByRole('slider', { name: '轨道音量 Story' }) as HTMLInputElement;
    expect(volume.disabled).toBe(true);
    fireEvent.change(within(story).getByRole('combobox', { name: '自动化模式 Story' }), { target: { value: 'touch' } });
    fireEvent.change(volume, { target: { value: '2' } });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_track',
        track_id: STORY_ID,
        track: expect.objectContaining({
          id: STORY_ID,
          keyframes: [expect.objectContaining({ time: 0, property: 'volume', value: 2 })],
        }),
      }],
    })));
    expect(applyProjectPatch).toHaveBeenCalledTimes(1);
  });

  it('shows recorded and unrecorded state on the unified timeline', async () => {
    renderWorkspace();

    expect(await screen.findByText('已录制 1')).toBeTruthy();
    expect(screen.getByText('未录制 1')).toBeTruthy();
    expect(screen.getByRole('button', { name: /B 5\.0s · 已录制/u })).toBeTruthy();
    expect(screen.getByRole('button', { name: /A 5\.0s · 未录制/u })).toBeTruthy();
  });

  it('projects a recorded file that cannot cover source-out as needing another recording', async () => {
    const project: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        tracks: PROJECT.document.tracks.map((track) => track.id !== STORY_ID ? track : {
          ...track,
          clips: track.clips.map((clip) => clip.id !== CLIP_B ? clip : {
            ...clip,
            material: { kind: 'asset', asset_id: 'asset-b', media_duration_seconds: 4.97 },
          }),
        }),
      },
    };
    renderWorkspace({
      project,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    expect(await screen.findByRole('button', { name: /B 5\.0s · 需要重录/u })).toBeTruthy();
    expect(screen.getByText('2 个素材未就绪')).toBeTruthy();
    expect((screen.getByRole('button', { name: '导出成片' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '录制缺失片段' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '事件 B 00:05.000' }));
    expect(await screen.findByText('素材未就绪 · 当前显示可用帧')).toBeTruthy();
    const panel = screen.getByRole('region', { name: '项目素材' });
    expect(within(panel).getByRole('button', { name: '从 Demo 创建剪辑' })).toBeTruthy();
    expect(within(panel).getByRole('option', { name: '选择素材 B' }).textContent).toContain('需要重录');
    expect(panel.textContent).toContain('待录 2 · 已录 0');
  });

  it('shows the recording preflight reason instead of a generic workspace failure', async () => {
    const createProjectRecordingPlan = vi.fn(() => Promise.reject(new Error(
      'external dependency is unavailable: this shot needs at least four spatial replay samples for camera movement',
    )));
    renderWorkspace({ project: RECORDABLE_PROJECT, createProjectRecordingPlan });

    fireEvent.click(await screen.findByRole('button', { name: '录制缺失片段' }));
    fireEvent.click(screen.getByRole('button', { name: '开始录制' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('操作没有完成');
    expect(alert.textContent).toContain('this shot needs at least four spatial replay samples for camera movement');
  });

  it('refreshes the Project Head and media library when a recording reaches a terminal state', async () => {
    const getProject = vi.fn(() => Promise.resolve(RECORDABLE_PROJECT));
    const listMediaAssets = vi.fn(() => Promise.resolve({ items: [] }));
    const createProjectRecordingPlan = vi.fn(() => Promise.resolve({ plan_id: 'plan-a' }));
    const executeRecordingPlan = vi.fn(() => Promise.resolve({ job_id: 'job-a', status: 'running' }));
    const getActivity = vi.fn(() => Promise.resolve({
      id: 'recording:job-a',
      kind: 'recording',
      subtype: null,
      job_id: 'job-a',
      context_id: PROJECT.id,
      subject: 'NiKo 3 分钟集锦',
      status: 'failed',
      stage: null,
      progress_percent: 80,
      completed_units: 8,
      total_units: 11,
      unit: 'stages',
      error: 'observer drifted',
      failure: null,
      created_at: PROJECT.created_at,
      updated_at: PROJECT.updated_at,
      available_actions: [],
    }));
    renderWorkspace({
      project: RECORDABLE_PROJECT,
      getProject,
      getActivity,
      listMediaAssets,
      createProjectRecordingPlan,
      executeRecordingPlan,
    });

    fireEvent.click(await screen.findByRole('button', { name: '录制缺失片段' }));
    fireEvent.click(screen.getByRole('button', { name: '开始录制' }));

    await waitFor(() => expect(getActivity).toHaveBeenCalled());
    await waitFor(() => expect(getProject.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(listMediaAssets.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('offers the backend export actions in the Agent execution card', async () => {
    const jobId = '00000000-0000-4000-8000-000000000100';
    const exportProject = vi.fn(() => Promise.resolve({ job_id: jobId, status: 'running' }));
    const cancelExportJob = vi.fn(() => Promise.resolve({
      kind: 'project',
      job: {
        id: jobId,
        project_id: PROJECT.id,
        status: 'cancelling',
        progress: 0.25,
        output_path: 'C:\\exports\\project.mp4',
        error: null,
        error_code: null,
        created_at: PROJECT.created_at,
        updated_at: PROJECT.updated_at,
      },
    }));
    const getActivity = vi.fn(() => Promise.resolve({
      id: `export:${jobId}`,
      kind: 'export',
      subtype: 'project',
      job_id: jobId,
      context_id: PROJECT.id,
      subject: 'C:\\exports\\project.mp4',
      status: 'running',
      stage: null,
      progress_percent: 25,
      completed_units: null,
      total_units: null,
      unit: null,
      error: null,
      failure: null,
      created_at: PROJECT.created_at,
      updated_at: PROJECT.updated_at,
      available_actions: ['cancel', 'open_outputs'],
    }));
    renderWorkspace({ project: RECORDED_PROJECT, exportProject, cancelExportJob, getActivity });

    fireEvent.click(await screen.findByRole('button', { name: '导出成片' }));
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await waitFor(() => expect(exportProject).toHaveBeenCalledWith(PROJECT.id, {
      expected_revision: RECORDED_PROJECT.revision,
      encoder: 'auto',
      quality: 80,
    }));

    expect(await screen.findByRole('button', { name: '取消导出任务' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看成品' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消导出任务' }));
    await waitFor(() => expect(cancelExportJob).toHaveBeenCalledWith(jobId));
  });

  it('exports the shared Timeline In/Out range with explicit encoder and quality settings', async () => {
    const jobId = '00000000-0000-4000-8000-000000000101';
    const exportProject = vi.fn(() => Promise.resolve({ job_id: jobId, status: 'running' }));
    const getActivity = vi.fn(() => Promise.resolve({
      id: `export:${jobId}`, kind: 'export', subtype: 'project', job_id: jobId,
      context_id: PROJECT.id, subject: 'C:\\exports\\range.mp4', status: 'running', stage: null,
      progress_percent: 0, completed_units: null, total_units: null, unit: null,
      error: null, failure: null, created_at: PROJECT.created_at, updated_at: PROJECT.updated_at,
      available_actions: ['cancel'],
    }));
    renderWorkspace({ project: RECORDED_PROJECT, exportProject, getActivity });

    const playhead = await screen.findByRole('slider', { name: '时间轴播放头' });
    stepTimelineSeconds(playhead, 2);
    fireEvent.click(screen.getByRole('button', { name: '在播放头标记入点' }));
    stepTimelineSeconds(playhead, 4);
    fireEvent.click(screen.getByRole('button', { name: '在播放头标记出点' }));

    fireEvent.click(screen.getByRole('button', { name: '导出成片' }));
    expect((screen.getByRole('combobox', { name: '导出源范围' }) as HTMLSelectElement).value).toBe('in_out');
    fireEvent.change(screen.getByRole('combobox', { name: '编码性能' }), { target: { value: 'libopenh264' } });
    fireEvent.change(screen.getByRole('slider', { name: '导出质量' }), { target: { value: '65' } });
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));

    await waitFor(() => expect(exportProject).toHaveBeenCalledWith(PROJECT.id, {
      expected_revision: RECORDED_PROJECT.revision,
      encoder: 'libopenh264',
      quality: 65,
      range_start_seconds: 2,
      range_end_seconds: 6,
    }));
  }, 20_000);

  it('navigates, clears and loops the shared Timeline In/Out range', async () => {
    renderWorkspace({ project: RECORDED_PROJECT });
    const timeline = await screen.findByRole('region', { name: '时间轴' });
    const playhead = screen.getByRole('slider', { name: '时间轴播放头' });
    const monitor = screen.getByRole('region', { name: '视频预览' });

    stepTimelineSeconds(playhead, 2);
    fireEvent.keyDown(timeline, { key: 'i' });
    stepTimelineSeconds(playhead, 2);
    fireEvent.keyDown(timeline, { key: 'o' });
    stepTimelineSeconds(playhead, 1);
    fireEvent.keyDown(timeline, { key: 'I', shiftKey: true });
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBe(2);
    fireEvent.keyDown(timeline, { key: 'O', shiftKey: true });
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBe(4);

    fireEvent.click(screen.getByRole('button', { name: '切换循环播放' }));
    expect(screen.getByRole('button', { name: '切换循环播放' }).getAttribute('aria-pressed')).toBe('true');
    expect(monitor.getAttribute('data-monitor-playback-range')).toBe('2:4');

    fireEvent.keyDown(timeline, { key: 'O', ctrlKey: true, shiftKey: true });
    expect(monitor.getAttribute('data-monitor-playback-range')).toBe('0:10');
    fireEvent.keyDown(timeline, { key: 'o' });
    fireEvent.keyDown(timeline, { key: 'i', altKey: true });
    fireEvent.keyDown(timeline, { key: 'X', ctrlKey: true, shiftKey: true });
    expect(screen.queryByRole('button', { name: '清除入出点' })).toBeNull();

    fireEvent.pointerDown(screen.getByRole('button', { name: '标记操作' }), { button: 0, ctrlKey: false });
    expect(screen.getByRole('menuitem', { name: '跳转到入点' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('menuitem', { name: '跳转到出点' }).getAttribute('aria-disabled')).toBe('true');
  }, 20_000);

  it('renders a non-equal Agent replacement inline on the canonical timeline', async () => {
    const previousClips = PROJECT.document.tracks[0]!.clips;
    const replacement = {
      ...previousClips[0]!,
      name: 'A Hold 重构',
      placement: { ...previousClips[0]!.placement, duration: 7, source_out: 7 },
    };
    const currentClips = [
      replacement,
      { ...previousClips[1]!, placement: { ...previousClips[1]!.placement, start: 7 } },
    ];
    const project: Project = {
      ...PROJECT,
      revision: 2,
      document: {
        ...PROJECT.document,
        duration_seconds: 12,
        tracks: PROJECT.document.tracks.map((track) => track.id === STORY_ID ? { ...track, clips: currentClips } : track),
      },
    };
    const group: ProjectChangeGroup = {
      id: '00000000-0000-4000-8000-000000000070',
      project_id: PROJECT.id,
      from_revision: 1,
      to_revision: 2,
      author: { kind: 'agent', session_id: 'session', turn_id: 'turn' },
      status: 'completed',
      summary: '替换片段并波纹调整',
      reverts_change_group_id: null,
      operations: [{ op: 'replace_track_clips', track_id: STORY_ID, clips: currentClips }],
      inverse_operations: [{ op: 'replace_track_clips', track_id: STORY_ID, clips: previousClips }],
      created_at: PROJECT.updated_at,
      completed_at: PROJECT.updated_at,
    };

    renderWorkspace({ project, groups: [group] });

    expect(await screen.findByRole('tab', { name: '时间轴（修改审阅）' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: '修改摘要' })).toBeNull();
    expect(screen.getByText('1 处修改')).toBeTruthy();
    expect(screen.getByText('修改注释')).toBeTruthy();
    expect(screen.getByLabelText('时间轴修改 1').textContent).toContain('5.000s');
    expect(screen.getByLabelText('时间轴修改 1').textContent).toContain('7.000s');
    expect(screen.getByLabelText('时间轴修改 1').textContent).toContain('波纹 +2.000s');
    expect(screen.getByLabelText('后续片段移动 +2.000s')).toBeTruthy();
    expect(screen.getByText('00:12.000')).toBeTruthy();
    expect(screen.getByText('00:10.000')).toBeTruthy();
  });

  it('seeks by dragging the timeline playhead', async () => {
    renderWorkspace({
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const playhead = await screen.findByRole('slider', { name: '时间轴播放头' });
    const clipA = screen.getByRole('button', { name: /A 5\.0s · 未录制/u });
    const timeline = screen.getByRole('region', { name: '时间轴内容' });
    timeline.style.setProperty('--w-track-head', '0px');
    vi.spyOn(timeline, 'getBoundingClientRect').mockReturnValue({
      x: 190,
      y: 0,
      top: 0,
      right: 910,
      bottom: 300,
      left: 190,
      width: 720,
      height: 300,
      toJSON: () => ({}),
    });

    expect(clipA.className).toContain('ring-accent');
    expect(fireEvent.pointerDown(playhead, { clientX: 199, pointerId: 7, button: 0 })).toBe(false);
    fireEvent.pointerMove(playhead, { clientX: 199.2, pointerId: 7 });
    fireEvent.pointerUp(playhead, { clientX: 199.2, pointerId: 7 });

    await waitFor(() => expect(Number(screen.getByRole('slider', { name: '时间轴播放头' }).getAttribute('aria-valuenow'))).toBeGreaterThan(5));
    expect(screen.getByRole('button', { name: /A 5\.0s · 未录制/u }).className).toContain('ring-accent');
    expect(screen.getByRole('button', { name: /B 5\.0s · 已录制/u }).className).not.toContain('ring-accent');
    expect(screen.getByLabelText('B 视频预览')).toBeTruthy();
    expect(screen.getByRole('region', { name: '时间轴' }).classList.contains('select-none')).toBe(true);
  });

  it('snaps the playhead to clip edges while Shift-dragging like Premiere', async () => {
    renderWorkspace();

    const viewport = await screen.findByRole('region', { name: '时间轴内容' });
    viewport.style.setProperty('--w-track-head', '0px');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 1_000,
      bottom: 300,
      left: 0,
      width: 1_000,
      height: 300,
      toJSON: () => ({}),
    });
    const playhead = screen.getByRole('slider', { name: '时间轴播放头' });
    const zoom = screen.getByRole('slider', { name: '时间轴缩放' });
    const pixelsPerSecond = Number(zoom.dataset.timelinePixelsPerSecond);
    expect(pixelsPerSecond).toBeGreaterThan(0);
    const nearFiveSeconds = 4.9;

    fireEvent.pointerDown(playhead, {
      pointerId: 8,
      button: 0,
      clientX: nearFiveSeconds * pixelsPerSecond,
      shiftKey: true,
    });
    fireEvent.pointerUp(playhead, {
      pointerId: 8,
      button: 0,
      clientX: nearFiveSeconds * pixelsPerSecond,
      shiftKey: true,
    });

    expect(Number(screen.getByRole('slider', { name: '时间轴播放头' }).getAttribute('aria-valuenow'))).toBe(5);
  });

  it('uses unmodified arrows on a focused Story clip for playhead navigation without moving the clip', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    const clipButton = await screen.findByRole('button', { name: /A 5\.0s · 未录制/u });
    fireEvent.keyDown(clipButton, { key: 'ArrowRight' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(applyProjectPatch).not.toHaveBeenCalled();
  });

  it('edits an independent audio-track clip while keeping Story audio derived', async () => {
    const audioClipId = '00000000-0000-4000-8000-000000000015';
    const audioClip: TimelineClip = {
      ...clip(audioClipId, 'Bed'),
      material: { kind: 'asset', asset_id: 'asset-audio', media_duration_seconds: 30 },
      placement: { start: 12, duration: 5, source_in: 0, source_out: 5, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
    };
    const project: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        tracks: PROJECT.document.tracks.map((track) => track.kind === 'audio'
          ? { ...track, clips: [audioClip] }
          : track),
      },
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project, applyProjectPatch });

    const audioButton = await screen.findByRole('button', { name: /Bed 5\.0s · 已录制/u });
    fireEvent.click(audioButton);
    fireEvent.keyDown(audioButton, { key: 'ArrowRight', altKey: true, shiftKey: true });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_clip',
        clip_id: audioClipId,
        clip: expect.objectContaining({ placement: expect.objectContaining({ start: expect.closeTo(12 + 5 / 60, 6) }) }),
      })],
    })));
    expect(screen.getAllByRole('button', { name: /A 5\.0s · 未录制/u })).toHaveLength(1);
  });

  it('edits Story clip gain directly from its derived audio rubber band', async () => {
    const keyboardPatch = vi.fn();
    const keyboardRender = renderWorkspace({ applyProjectPatch: keyboardPatch });

    const gain = await screen.findByRole('slider', { name: '调整片段增益 A' });
    expect(gain.getAttribute('aria-disabled')).toBe('false');
    expect(gain.getAttribute('aria-valuetext')).toBe('+0.0 dB');
    fireEvent.keyDown(gain, { key: 'ArrowUp' });
    await waitFor(() => expect(keyboardPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_clip',
        clip_id: CLIP_A,
        clip: expect.objectContaining({ placement: expect.objectContaining({ volume: expect.closeTo(1.122_018, 5) }) }),
      })],
    })));

    keyboardRender.unmount();
    const pointerPatch = vi.fn();
    renderWorkspace({ applyProjectPatch: pointerPatch });
    const pointerGain = await screen.findByRole('slider', { name: '调整片段增益 A' });
    fireEvent.pointerDown(pointerGain, { pointerId: 71, button: 0, clientY: 100 });
    fireEvent.pointerMove(pointerGain, { pointerId: 71, clientY: 94.65 });
    await waitFor(() => expect(pointerGain.getAttribute('aria-valuetext')).toBe('+6.0 dB'));
    fireEvent.pointerUp(pointerGain, { pointerId: 71, clientY: 94.65 });
    await waitFor(() => expect(pointerPatch).toHaveBeenCalledTimes(1));
    expect(pointerPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_clip',
        clip_id: CLIP_A,
        clip: expect.objectContaining({ placement: expect.objectContaining({ volume: expect.closeTo(2, 1) }) }),
      })],
    }));
  });

  it('edits the current Volume keyframe from the derived audio rubber band', async () => {
    const project: Project = {
      ...RECORDED_PROJECT,
      document: {
        ...RECORDED_PROJECT.document,
        tracks: RECORDED_PROJECT.document.tracks.map((track) => track.id !== STORY_ID ? track : {
          ...track,
          clips: track.clips.map((candidate) => candidate.id !== CLIP_A ? candidate : {
            ...candidate,
            keyframes: [
              { id: 'volume-0', time: 0, property: 'volume', value: 1, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0  },
              { id: 'volume-1', time: 1, property: 'volume', value: 2, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0  },
            ],
          }),
        }),
      },
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project, applyProjectPatch });
    stepTimelineSeconds(await screen.findByRole('slider', { name: '时间轴播放头' }), 1);

    const gain = await screen.findByRole('slider', { name: '调整片段增益 A' });
    expect(Number(gain.getAttribute('aria-valuenow'))).toBeCloseTo(20 * Math.log10(2));
    fireEvent.keyDown(gain, { key: 'ArrowDown' });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_clip',
        clip_id: CLIP_A,
        clip: expect.objectContaining({
          placement: expect.objectContaining({ volume: 1 }),
          keyframes: [
            expect.objectContaining({ id: 'volume-0', time: 0, value: 1 }),
            expect.objectContaining({ id: 'volume-1', time: 1, property: 'volume', value: expect.closeTo(1.782_502, 5), interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0  }),
          ],
        }),
      })],
    })));
  });

  it('edits renderer-backed audio transitions from Story derived audio blocks', async () => {
    const keyboardPatch = vi.fn();
    const keyboardRender = renderWorkspace({ applyProjectPatch: keyboardPatch });

    const fadeIn = await screen.findByRole('slider', { name: '音频入场转场 A' });
    const storyAudio = screen.getByRole('row', { name: 'Story 音频' });
    expect(storyAudio.querySelector('[role="img"]')?.classList.contains('pointer-events-none')).toBe(true);
    expect(fadeIn.parentElement?.classList.contains('z-10')).toBe(false);
    expect(fadeIn.getAttribute('aria-valuetext')).toBe('未应用');
    fireEvent.keyDown(fadeIn, { key: 'ArrowRight' });
    await waitFor(() => expect(keyboardPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_clip',
        clip_id: CLIP_A,
        clip: expect.objectContaining({ transitions: expect.objectContaining({ audio_in: { kind: 'constant_power', duration_seconds: 0.05 } }) }),
      })],
    })));

    keyboardRender.unmount();
    const pointerPatch = vi.fn();
    renderWorkspace({ applyProjectPatch: pointerPatch });
    const fadeOut = await screen.findByRole('slider', { name: '音频出场转场 A' });
    fireEvent.pointerDown(fadeOut, { pointerId: 72, button: 0, clientX: 400 });
    fireEvent.pointerMove(fadeOut, { pointerId: 72, clientX: 390 });
    await waitFor(() => expect(Number(fadeOut.getAttribute('aria-valuenow'))).toBeGreaterThan(0.5));
    fireEvent.pointerUp(fadeOut, { pointerId: 72, clientX: 390 });
    await waitFor(() => expect(pointerPatch).toHaveBeenCalledTimes(1));
    expect(pointerPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_clip',
        clip_id: CLIP_A,
        clip: expect.objectContaining({ transitions: expect.objectContaining({ audio_out: { kind: 'constant_power', duration_seconds: expect.any(Number) } }) }),
      })],
    }));
  });

  it('previews and commits one video transition duration patch per drag gesture', async () => {
    const project: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        tracks: PROJECT.document.tracks.map((track) => track.id !== STORY_ID ? track : {
          ...track,
          clips: track.clips.map((candidate) => candidate.id !== CLIP_A ? candidate : {
            ...candidate,
            transitions: {
              ...candidate.transitions,
              video_out: { kind: 'fade', duration_seconds: 0.5 },
            },
          }),
        }),
      },
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project, applyProjectPatch });

    const transition = await screen.findByRole('slider', { name: '视频出场转场 A' });
    const playhead = screen.getByRole('slider', { name: '时间轴播放头' });
    const playheadBeforeDrag = playhead.getAttribute('aria-valuenow');
    fireEvent.pointerDown(transition, { pointerId: 73, button: 0, clientX: 400 });
    fireEvent.pointerMove(transition, { pointerId: 73, clientX: 390 });
    expect(Number(transition.getAttribute('aria-valuenow'))).toBeGreaterThan(0.5);
    expect(playhead.getAttribute('aria-valuenow')).toBe(playheadBeforeDrag);
    expect(applyProjectPatch).not.toHaveBeenCalled();

    fireEvent.pointerUp(transition, { pointerId: 73, clientX: 390 });
    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledTimes(1));
    expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_clip',
        clip_id: CLIP_A,
        clip: expect.objectContaining({
          transitions: expect.objectContaining({
            video_out: { kind: 'fade', duration_seconds: expect.any(Number) },
          }),
        }),
      })],
    }));

    fireEvent.doubleClick(transition);
    expect(await screen.findByRole('dialog', { name: '片段属性' })).toBeTruthy();
  });

  it('aligns and copies a transition between canonical cut points', async () => {
    const clipC = { ...clip('00000000-0000-4000-8000-000000000190', 'C'), placement: { ...clip('00000000-0000-4000-8000-000000000190', 'C').placement, start: 10 } };
    const project: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        duration_seconds: 15,
        tracks: PROJECT.document.tracks.map((track) => track.id !== STORY_ID ? track : {
          ...track,
          clips: [
            { ...track.clips[0]!, transitions: { ...track.clips[0]!.transitions, video_out: { kind: 'fade', duration_seconds: 0.5 } } },
            { ...track.clips[1]!, transitions: { ...track.clips[1]!.transitions, video_in: { kind: 'fade', duration_seconds: 0.5 } } },
            clipC,
          ],
        }),
      },
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project, applyProjectPatch });
    const timeline = await screen.findByRole('region', { name: '时间轴' });

    fireEvent.click(screen.getByRole('slider', { name: '视频出场转场 A' }));
    expect(screen.getByRole('button', { name: '以剪辑点为中心' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '从剪辑点开始' }));
    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({ id: CLIP_A, transitions: expect.objectContaining({ video_out: null }) }),
          expect.objectContaining({ id: CLIP_B, transitions: expect.objectContaining({ video_in: { kind: 'fade', duration_seconds: 1 } }) }),
          expect.objectContaining({ id: clipC.id }),
        ],
      }],
    })));

    fireEvent.keyDown(timeline, { key: 'c', ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: /B 5\.0s · 已录制/u }));
    fireEvent.click(screen.getByRole('slider', { name: '视频出场转场 B' }));
    fireEvent.keyDown(timeline, { key: 'v', ctrlKey: true });
    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledTimes(2));
    expect(applyProjectPatch).toHaveBeenLastCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({ id: CLIP_A }),
          expect.objectContaining({ id: CLIP_B, transitions: expect.objectContaining({ video_out: { kind: 'fade', duration_seconds: 0.5 } }) }),
          expect.objectContaining({ id: clipC.id, transitions: expect.objectContaining({ video_in: { kind: 'fade', duration_seconds: 0.5 } }) }),
        ],
      }],
    }));
  });

  it('deletes a cross-track selection in one Project revision', async () => {
    const audioClipId = '00000000-0000-4000-8000-000000000016';
    const audioClip: TimelineClip = {
      ...clip(audioClipId, 'Bed'),
      material: { kind: 'asset', asset_id: 'asset-audio', media_duration_seconds: 30 },
      placement: { start: 12, duration: 5, source_in: 0, source_out: 5, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
    };
    const project: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        tracks: PROJECT.document.tracks.map((track) => track.kind === 'audio'
          ? { ...track, clips: [audioClip] }
          : track),
      },
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project, applyProjectPatch });

    const storyClip = await screen.findByRole('button', { name: /A 5\.0s · 未录制/u });
    const audioButton = screen.getByRole('button', { name: /Bed 5\.0s · 已录制/u });
    fireEvent.pointerDown(audioButton, { pointerId: 41, button: 0, ctrlKey: true, clientX: 400 });
    await waitFor(() => {
      expect(storyClip.className).toContain('ring-accent');
      expect(audioButton.className).toContain('ring-accent');
    });
    runTimelineCommand('删除所选片段并闭合间隙');

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'project' },
      operations: [
        {
          op: 'replace_track_clips',
          track_id: STORY_ID,
          clips: [expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 0 }) })],
        },
        {
          op: 'replace_track_clips',
          track_id: '00000000-0000-4000-8000-000000000013',
          clips: [],
        },
      ],
    })));
    expect(applyProjectPatch).toHaveBeenCalledTimes(1);
  });

  it('keeps an existing locked Story selection inspectable but disables every destructive Story command', async () => {
    const lockedProject: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        tracks: PROJECT.document.tracks.map((track) => track.id === STORY_ID
          ? { ...track, locked: true }
          : track),
      },
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: lockedProject, applyProjectPatch });

    const playhead = await screen.findByRole('slider', { name: '时间轴播放头' });
    stepTimelineSeconds(playhead, 1);
    openTimelineCommands();
    expect(screen.getByRole('menuitem', { name: '在播放头添加剪辑点' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('menuitem', { name: '删除所选片段并闭合间隙' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('menuitem', { name: '波纹裁切片段起点到播放头' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('menuitem', { name: '波纹裁切播放头到片段终点' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(screen.getByRole('menu', { name: '剪辑操作' }), { key: 'Escape' });
    expect((within(screen.getByRole('row', { name: 'Story' })).getByRole('button', { name: '切换轨道锁定' }) as HTMLButtonElement).disabled).toBe(false);

    const timeline = screen.getByRole('region', { name: '时间轴' });
    fireEvent.keyDown(timeline, { key: 's' });
    fireEvent.keyDown(timeline, { key: 'q' });
    fireEvent.keyDown(timeline, { key: 'w' });
    fireEvent.keyDown(timeline, { key: 'Delete' });
    expect(applyProjectPatch).not.toHaveBeenCalled();
  });

  it('deletes only unlocked clips from a mixed locked and unlocked selection', async () => {
    const audioClipId = '00000000-0000-4000-8000-000000000096';
    const audioClip: TimelineClip = {
      ...clip(audioClipId, 'Unlocked bed'),
      material: { kind: 'asset', asset_id: 'asset-audio', media_duration_seconds: 30 },
      placement: { start: 12, duration: 5, source_in: 0, source_out: 5, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
    };
    const project: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        tracks: PROJECT.document.tracks.map((track) => track.id === STORY_ID
          ? { ...track, locked: true }
          : track.kind === 'audio' ? { ...track, clips: [audioClip] } : track),
      },
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project, applyProjectPatch });

    fireEvent.pointerDown(await screen.findByRole('button', { name: /Unlocked bed 5\.0s · 已录制/u }), {
      pointerId: 97, button: 0, ctrlKey: true, clientX: 400,
    });
    runTimelineCommand('删除所选片段并闭合间隙');

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_track_clips',
        track_id: '00000000-0000-4000-8000-000000000013',
        clips: [],
      }],
    })));
    const operations = applyProjectPatch.mock.calls[0]?.[0]?.operations ?? [];
    expect(operations.some((operation: ProjectPatch['operations'][number]) => (
      operation.op === 'replace_track_clips' && operation.track_id === STORY_ID
    ))).toBe(false);
  });

  it('commits one clip replacement after a pointer drag and exposes trim handles on selection', async () => {
    const applyProjectPatch = vi.fn(() => Promise.resolve({
      project: { ...PROJECT, revision: 2 },
      change_group: {
        id: '00000000-0000-4000-8000-000000000021', project_id: PROJECT.id,
        from_revision: 1, to_revision: 2, author: { kind: 'human' as const }, status: 'completed' as const,
        summary: '调整 A', reverts_change_group_id: null, operations: [], inverse_operations: [],
        created_at: PROJECT.updated_at, completed_at: PROJECT.updated_at,
      },
    }));
    renderWorkspace({ applyProjectPatch });

    const clipButton = await screen.findByRole('button', { name: /A 5\.0s · 未录制/u });
    fireEvent.click(clipButton);
    expect(screen.getByRole('separator', { name: '裁切片段起点' })).toBeTruthy();
    expect(screen.getByRole('separator', { name: '裁切片段终点' })).toBeTruthy();

    fireEvent.pointerDown(clipButton, { clientX: 200, pointerId: 9, button: 0 });
    fireEvent.pointerMove(clipButton, { clientX: 320, pointerId: 9 });
    fireEvent.pointerUp(clipButton, { clientX: 320, pointerId: 9 });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledTimes(1));
    expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: expect.arrayContaining([
          expect.objectContaining({ id: CLIP_A }),
          expect.objectContaining({ id: CLIP_B }),
        ]),
      })],
    }));
  });

  it('extends a focused edit point to the playhead with E and preserves Sync Lock', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: syncLockProject(), applyProjectPatch });

    const playhead = await screen.findByRole('slider', { name: '时间轴播放头' });
    const endHandle = screen.getByRole('separator', { name: '裁切片段终点' });
    endHandle.focus();
    expect(endHandle.className).toContain('ring-accent');
    stepTimelineSeconds(playhead, 4);
    fireEvent.keyDown(endHandle, { key: 'e' });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [
        expect.objectContaining({
          op: 'replace_track_clips',
          track_id: STORY_ID,
          clips: [
            expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ duration: 4 }) }),
            expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 4 }) }),
          ],
        }),
        expect.objectContaining({
          op: 'replace_track_clips',
          track_id: '00000000-0000-4000-8000-000000000097',
          clips: [expect.objectContaining({ placement: expect.objectContaining({ start: 5 }) })],
        }),
      ],
    })));
  }, 15_000);

  it('auto-scrolls at the viewport edge and includes scroll delta in a trim gesture', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: RECORDED_PROJECT, applyProjectPatch });

    const viewport = await screen.findByRole('region', { name: '时间轴内容' });
    viewport.style.setProperty('--w-track-head', '200px');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 1_000, bottom: 400, left: 0, width: 1_000, height: 400, toJSON: () => ({}),
    });
    const timelineZoom = screen.getByRole('slider', { name: '时间轴缩放' }) as HTMLInputElement;
    fireEvent.change(timelineZoom, { target: { value: timelineZoom.max } });
    const startHandle = screen.getByRole('separator', { name: '裁切片段起点' });
    fireEvent.pointerDown(startHandle, { pointerId: 81, button: 0, clientX: 900 });
    fireEvent.pointerMove(startHandle, { pointerId: 81, clientX: 990 });
    await waitFor(() => expect(viewport.scrollLeft).toBeGreaterThan(0));
    fireEvent.pointerUp(startHandle, { pointerId: 81, clientX: 990 });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledTimes(1));
    const operation = applyProjectPatch.mock.calls[0]?.[0]?.operations[0];
    expect(operation).toMatchObject({ op: 'replace_track_clips', track_id: STORY_ID });
    if (operation?.op !== 'replace_track_clips') throw new Error('expected Story replacement');
    expect(operation.clips[0]?.placement.source_in).toBeGreaterThan(0);
    const stoppedAt = viewport.scrollLeft;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(viewport.scrollLeft).toBe(stoppedAt);
    clientWidth.mockRestore();
  });

  it('adds an edit to the targeted Story track at the global playhead', async () => {
    const applyProjectPatch = vi.fn(() => Promise.resolve({
      project: { ...PROJECT, revision: 2 },
      change_group: {
        id: '00000000-0000-4000-8000-000000000022', project_id: PROJECT.id,
        from_revision: 1, to_revision: 2, author: { kind: 'human' as const }, status: 'completed' as const,
        summary: '切分 A', reverts_change_group_id: null, operations: [], inverse_operations: [],
        created_at: PROJECT.updated_at, completed_at: PROJECT.updated_at,
      },
    }));
    renderWorkspace({ applyProjectPatch });

    const playhead = await screen.findByRole('slider', { name: '时间轴播放头' });
    stepTimelineSeconds(playhead, 1);
    runTimelineCommand('在播放头添加剪辑点');

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ duration: 1 }) }),
          expect.objectContaining({ placement: expect.objectContaining({ start: 1, duration: 4 }) }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 5 }) }),
        ],
      })],
    })));
  });

  it('focuses the Timeline after pointer interaction so Ctrl+K uses the visible Add Edit path', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    const playhead = await screen.findByRole('slider', { name: '时间轴播放头' });
    stepTimelineSeconds(playhead, 1);
    const timeline = screen.getByRole('region', { name: '时间轴' });
    fireEvent.pointerDown(timeline, { pointerId: 99, button: 0 });
    expect(document.activeElement).toBe(timeline);
    fireEvent.keyDown(document.activeElement!, { key: 'k', ctrlKey: true });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: expect.arrayContaining([
          expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ duration: 1 }) }),
          expect.objectContaining({ placement: expect.objectContaining({ start: 1, duration: 4 }) }),
        ]),
      })],
    })));
  });

  it('uses Adobe S for Timeline snapping without creating an edit', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    const snap = screen.getByRole('button', { name: '切换时间轴吸附' });
    expect(snap.getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(timeline, { key: 's' });
    expect(snap.getAttribute('aria-pressed')).toBe('false');
    fireEvent.keyDown(timeline, { key: 's' });
    expect(snap.getAttribute('aria-pressed')).toBe('true');
    expect(applyProjectPatch).not.toHaveBeenCalled();
  });

  it('uses Adobe Timeline arrows for one frame and Shift arrows for five frames', async () => {
    renderWorkspace();

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    const playhead = screen.getByRole('slider', { name: '时间轴播放头' });
    fireEvent.keyDown(timeline, { key: 'ArrowRight' });
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBeCloseTo(1 / 60);
    fireEvent.keyDown(timeline, { key: 'ArrowRight', shiftKey: true });
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBeCloseTo(6 / 60);
  });

  it('adds one edit across every targeted track with Ctrl+K', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: targetedRangeProject(), applyProjectPatch });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    fireEvent.click(screen.getByRole('button', { name: '设为目标轨道 Music' }));
    stepTimelineSeconds(screen.getByRole('slider', { name: '时间轴播放头' }), 1);
    fireEvent.keyDown(timeline, { key: 'k', ctrlKey: true });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'project' },
      operations: [
        expect.objectContaining({ op: 'replace_track_clips', track_id: STORY_ID, clips: expect.arrayContaining([
          expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ duration: 1 }) }),
          expect.objectContaining({ placement: expect.objectContaining({ start: 1, duration: 4 }) }),
        ]) }),
        expect.objectContaining({
          op: 'replace_track_clips',
          track_id: '00000000-0000-4000-8000-000000000013',
          clips: [
            expect.objectContaining({ placement: expect.objectContaining({ duration: 1 }) }),
            expect.objectContaining({ placement: expect.objectContaining({ start: 1, duration: 9 }) }),
          ],
        }),
      ],
    })));
  });

  it('adds edits to all unlocked tracks with Ctrl+Shift+K regardless of targeting', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: targetedRangeProject(), applyProjectPatch });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    stepTimelineSeconds(screen.getByRole('slider', { name: '时间轴播放头' }), 1);
    fireEvent.keyDown(timeline, { key: 'k', ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalled());
    expect(applyProjectPatch.mock.calls[0]?.[0].operations.map((operation: ProjectPatch['operations'][number]) => (
      operation.op === 'replace_track_clips' ? operation.track_id : null
    ))).toEqual([STORY_ID, '00000000-0000-4000-8000-000000000013']);
  });

  it('applies independent default video and audio transitions at a targeted cut', async () => {
    const videoPatch = vi.fn();
    const videoRender = renderWorkspace({ applyProjectPatch: videoPatch });
    const videoTimeline = await screen.findByRole('region', { name: '时间轴' });
    fireEvent.keyDown(screen.getByRole('slider', { name: '时间轴播放头' }), { key: 'ArrowDown' });
    fireEvent.keyDown(videoTimeline, { key: 'd', ctrlKey: true });
    await waitFor(() => expect(videoPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({ transitions: expect.objectContaining({ video_out: { kind: 'fade', duration_seconds: 0.5 }, audio_out: null }) }),
          expect.objectContaining({ transitions: expect.objectContaining({ video_in: { kind: 'fade', duration_seconds: 0.5 }, audio_in: null }) }),
        ],
      })],
    })));

    videoRender.unmount();
    const audioPatch = vi.fn();
    renderWorkspace({ applyProjectPatch: audioPatch });
    const audioTimeline = await screen.findByRole('region', { name: '时间轴' });
    fireEvent.keyDown(screen.getByRole('slider', { name: '时间轴播放头' }), { key: 'ArrowDown' });
    fireEvent.keyDown(audioTimeline, { key: 'd', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(audioPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({ transitions: expect.objectContaining({ audio_out: { kind: 'constant_power', duration_seconds: 0.5 }, video_out: null }) }),
          expect.objectContaining({ transitions: expect.objectContaining({ audio_in: { kind: 'constant_power', duration_seconds: 0.5 }, video_in: null }) }),
        ],
      })],
    })));
  });

  it('applies both default channels to every adjacent selected pair with Shift+D', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });
    const timeline = await screen.findByRole('region', { name: '时间轴' });
    fireEvent.pointerDown(screen.getByRole('button', { name: /B 5\.0s · 已录制/u }), {
      pointerId: 125, button: 0, shiftKey: true, clientX: 400,
    });
    fireEvent.keyDown(timeline, { key: 'D', shiftKey: true });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({ transitions: {
            video_in: null,
            video_out: { kind: 'fade', duration_seconds: 0.5 },
            audio_in: null,
            audio_out: { kind: 'constant_power', duration_seconds: 0.5 },
          } }),
          expect.objectContaining({ transitions: {
            video_in: { kind: 'fade', duration_seconds: 0.5 },
            video_out: null,
            audio_in: { kind: 'constant_power', duration_seconds: 0.5 },
            audio_out: null,
          } }),
        ],
      })],
    })));
  });

  it('uses the Razor tool to cut linked AV into independent left and right groups', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: razorLinkedProject(), applyProjectPatch });

    fireEvent.keyDown(await screen.findByRole('region', { name: '时间轴' }), { key: 'c' });
    expect(screen.getByRole('button', { name: '剃刀工具 (C)' }).getAttribute('aria-pressed')).toBe('true');
    const storyClip = screen.getByRole('button', { name: /A 5\.0s · 未录制/u });
    vi.spyOn(storyClip, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 500, bottom: 84, left: 0, width: 500, height: 84, toJSON: () => ({}),
    });
    expect(storyClip.className).toContain('cursor-crosshair');
    expect(storyClip.getAttribute('aria-disabled')).toBe('false');
    fireEvent.pointerDown(storyClip, { pointerId: 120, button: 0, clientX: 200 });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledTimes(1));
    const operations = applyProjectPatch.mock.calls[0]?.[0].operations as ProjectPatch['operations'];
    expect(operations).toHaveLength(2);
    const storyOperation = operations.find((operation) => operation.op === 'replace_track_clips' && operation.track_id === STORY_ID);
    const audioOperation = operations.find((operation) => operation.op === 'replace_track_clips' && operation.track_id === '00000000-0000-4000-8000-000000000013');
    if (storyOperation?.op !== 'replace_track_clips' || audioOperation?.op !== 'replace_track_clips') {
      throw new Error('expected linked Razor track replacements');
    }
    expect(storyOperation.clips[0]?.link_group_id).toBe('00000000-0000-4000-8000-000000000093');
    expect(audioOperation.clips[0]?.link_group_id).toBe('00000000-0000-4000-8000-000000000093');
    expect(storyOperation.clips[1]?.link_group_id).toBeTruthy();
    expect(audioOperation.clips[1]?.link_group_id).toBe(storyOperation.clips[1]?.link_group_id);
    expect(storyOperation.clips[1]?.link_group_id).not.toBe(storyOperation.clips[0]?.link_group_id);
    clientWidth.mockRestore();
  });

  it('Alt-Razor cuts only the clicked channel of a linked pair', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: razorLinkedProject(), applyProjectPatch });

    fireEvent.click(await screen.findByRole('button', { name: '剃刀工具 (C)' }));
    const storyClip = screen.getByRole('button', { name: /A 5\.0s · 未录制/u });
    vi.spyOn(storyClip, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 500, bottom: 84, left: 0, width: 500, height: 84, toJSON: () => ({}),
    });
    expect(storyClip.className).toContain('cursor-crosshair');
    expect(storyClip.getAttribute('aria-disabled')).toBe('false');
    fireEvent.pointerDown(storyClip, { pointerId: 121, button: 0, clientX: 300, altKey: true });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledTimes(1));
    expect(applyProjectPatch.mock.calls[0]?.[0].operations).toEqual([
      expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({ link_group_id: '00000000-0000-4000-8000-000000000093' }),
          expect.objectContaining({ link_group_id: null }),
          expect.objectContaining({ id: CLIP_B }),
        ],
      }),
    ]);
    clientWidth.mockRestore();
  });

  it('adds a canonical marker at the playhead', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    await screen.findByRole('button', { name: '剪辑操作' });
    runMarkerCommand('在播放头添加标记');

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_markers',
        markers: [expect.objectContaining({
          time: 0,
          duration: 0,
          label: '标记 1',
          color: '#2F6FED',
          kind: 'comment',
          comment: '',
        })],
      }],
    })));
  });

  it('edits and deletes an existing timeline marker', async () => {
    const marker = { id: '00000000-0000-4000-8000-000000000018', time: 8, duration: 0, label: 'ACE', color: '#2F6FED', kind: 'comment' as const, comment: '' };
    const project: Project = {
      ...PROJECT,
      document: { ...PROJECT.document, markers: [marker] },
    };
    const editPatch = vi.fn();
    const rendered = renderWorkspace({ project, applyProjectPatch: editPatch });

    const markerButton = await screen.findByRole('button', { name: '标记 ACE 00:08.000' });
    fireEvent.doubleClick(markerButton);
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: 'ACE revised' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: '时间' }), { target: { value: '7' } });
    fireEvent.change(screen.getByRole('combobox', { name: '类型' }), { target: { value: 'segmentation' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: '持续时间' }), { target: { value: '2' } });
    fireEvent.change(screen.getByRole('textbox', { name: '注释' }), { target: { value: 'Round-deciding retake' } });
    fireEvent.click(screen.getByRole('button', { name: '保存标记' }));

    await waitFor(() => expect(editPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_markers',
        markers: [{
          ...marker,
          time: 7,
          duration: 2,
          label: 'ACE revised',
          kind: 'segmentation',
          comment: 'Round-deciding retake',
        }],
      }],
    })));

    rendered.unmount();
    const deletePatch = vi.fn();
    renderWorkspace({ project, applyProjectPatch: deletePatch });
    fireEvent.doubleClick(await screen.findByRole('button', { name: '标记 ACE 00:08.000' }));
    fireEvent.click(screen.getByRole('button', { name: '删除标记' }));
    await waitFor(() => expect(deletePatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{ op: 'replace_markers', markers: [] }],
    })));
  });

  it('renders duration markers as ranges and exposes their typed comment on hover', async () => {
    const marker = {
      id: '00000000-0000-4000-8000-000000000108',
      time: 2,
      duration: 3,
      label: 'Retake window',
      color: '#10B981',
      kind: 'segmentation' as const,
      comment: 'Preserve the setup and payoff.',
    };
    renderWorkspace({ project: { ...PROJECT, document: { ...PROJECT.document, markers: [marker] } } });

    const range = await screen.findByRole('button', { name: '标记 Retake window 00:02.000' });
    expect(range.style.width).not.toBe('');
    expect(range.title).toContain('分段 · Retake window · 00:02.000 · 持续 00:03.000');
    expect(range.title).toContain('Preserve the setup and payoff.');
  });

  it('drags a sequence marker with one frame-snapped Human Edit', async () => {
    const marker = { id: '00000000-0000-4000-8000-000000000018', time: 8, duration: 0, label: 'ACE', color: '#2F6FED', kind: 'comment' as const, comment: '' };
    const project: Project = {
      ...PROJECT,
      document: { ...PROJECT.document, markers: [marker] },
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project, applyProjectPatch });

    const markerButton = await screen.findByRole('button', { name: '标记 ACE 00:08.000' });
    fireEvent.pointerDown(markerButton, { pointerId: 71, button: 0, clientX: 100 });
    fireEvent.pointerMove(markerButton, { pointerId: 71, clientX: 124 });
    fireEvent.pointerUp(markerButton, { pointerId: 71, clientX: 124 });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledTimes(1));
    const operation = applyProjectPatch.mock.calls[0]?.[0]?.operations[0];
    expect(operation).toMatchObject({ op: 'replace_markers' });
    if (operation?.op !== 'replace_markers') throw new Error('expected marker replacement');
    expect(operation.markers[0]?.time).toBeGreaterThan(marker.time);
    expect(operation.markers[0]?.time * project.document.fps).toBeCloseTo(
      Math.round((operation.markers[0]?.time ?? 0) * project.document.fps),
    );
  });

  it('toggles magnetic snapping for marker drags while preserving frame alignment', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const marker = { id: '00000000-0000-4000-8000-000000000101', time: 8, duration: 0, label: 'Snap probe', color: '#2F6FED', kind: 'comment' as const, comment: '' };
    const project: Project = {
      ...RECORDED_PROJECT,
      document: { ...RECORDED_PROJECT.document, markers: [marker] },
    };
    const snappedPatch = vi.fn();
    const snappedRender = renderWorkspace({ project, applyProjectPatch: snappedPatch });

    const toggle = await screen.findByRole('button', { name: '切换时间轴吸附' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    const snappedMarker = screen.getByRole('button', { name: '标记 Snap probe 00:08.000' });
    fireEvent.pointerDown(snappedMarker, { pointerId: 102, button: 0, clientX: 100 });
    fireEvent.pointerMove(snappedMarker, { pointerId: 102, clientX: 296 });
    fireEvent.pointerUp(snappedMarker, { pointerId: 102, clientX: 296 });
    await waitFor(() => expect(snappedPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_markers',
        markers: [expect.objectContaining({ id: marker.id, time: 10 })],
      }],
    })));

    snappedRender.unmount();
    const freePatch = vi.fn();
    renderWorkspace({ project, applyProjectPatch: freePatch });
    const freeToggle = await screen.findByRole('button', { name: '切换时间轴吸附' });
    fireEvent.click(freeToggle);
    expect(freeToggle.getAttribute('aria-pressed')).toBe('false');
    const freeMarker = screen.getByRole('button', { name: '标记 Snap probe 00:08.000' });
    fireEvent.pointerDown(freeMarker, { pointerId: 103, button: 0, clientX: 100 });
    fireEvent.pointerMove(freeMarker, { pointerId: 103, clientX: 296 });
    fireEvent.pointerUp(freeMarker, { pointerId: 103, clientX: 296 });
    await waitFor(() => expect(freePatch).toHaveBeenCalled());
    const operation = freePatch.mock.calls[0]?.[0]?.operations[0];
    expect(operation).toMatchObject({ op: 'replace_markers' });
    if (operation?.op !== 'replace_markers') throw new Error('expected marker replacement');
    expect(operation.markers[0]?.time).toBeCloseTo(598 / 60);
    clientWidth.mockRestore();
  });

  it('selects and navigates sequence markers, then clears the selected marker by shortcut', async () => {
    const markers = [
      { id: '00000000-0000-4000-8000-000000000101', time: 1, duration: 0, label: 'First', color: '#2F6FED', kind: 'comment' as const, comment: '' },
      { id: '00000000-0000-4000-8000-000000000102', time: 4, duration: 0, label: 'Second', color: '#F59E0B', kind: 'comment' as const, comment: '' },
    ];
    const project: Project = { ...PROJECT, document: { ...PROJECT.document, markers } };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project, applyProjectPatch });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    const first = screen.getByRole('button', { name: '标记 First 00:01.000' });
    fireEvent.click(first);
    expect(first.className).toContain('ring-accent');
    fireEvent.keyDown(timeline, { key: 'M', shiftKey: true });
    expect(Number(screen.getByRole('slider', { name: '时间轴播放头' }).getAttribute('aria-valuenow'))).toBe(4);
    expect(screen.getByRole('button', { name: '标记 Second 00:04.000' }).className).toContain('ring-accent');
    fireEvent.keyDown(timeline, { key: 'M', shiftKey: true, ctrlKey: true });
    expect(Number(screen.getByRole('slider', { name: '时间轴播放头' }).getAttribute('aria-valuenow'))).toBe(1);
    fireEvent.keyDown(timeline, { key: 'm', altKey: true });
    expect(applyProjectPatch).not.toHaveBeenCalled();
    fireEvent.keyDown(timeline, { key: 'm', altKey: true, ctrlKey: true });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{ op: 'replace_markers', markers: [markers[1]] }],
    })));
  });

  it('opens the existing marker editor instead of creating a duplicate at the same frame', async () => {
    const marker = { id: '00000000-0000-4000-8000-000000000103', time: 0, duration: 0, label: 'Existing', color: '#2F6FED', kind: 'comment' as const, comment: '' };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: { ...PROJECT, document: { ...PROJECT.document, markers: [marker] } }, applyProjectPatch });

    fireEvent.keyDown(await screen.findByRole('region', { name: '时间轴' }), { key: 'm' });
    expect(screen.getByDisplayValue('Existing')).toBeTruthy();
    expect(applyProjectPatch).not.toHaveBeenCalled();
  });

  it('clears all sequence markers through the explicit marker command', async () => {
    const marker = { id: '00000000-0000-4000-8000-000000000104', time: 2, duration: 0, label: 'Clear me', color: '#2F6FED', kind: 'comment' as const, comment: '' };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: { ...PROJECT, document: { ...PROJECT.document, markers: [marker] } }, applyProjectPatch });

    await screen.findByRole('button', { name: '标记操作' });
    runMarkerCommand('清除全部标记');
    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{ op: 'replace_markers', markers: [] }],
    })));
  });

  it('toggles Adobe-style sequence marker ripple behavior through the marker menu', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    await screen.findByRole('button', { name: '标记操作' });
    runMarkerCommand('波纹移动序列标记');
    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_settings',
        settings: { source_demo_ids: [], ripple_sequence_markers: true, use_media_proxies: false },
      }],
    })));
  });

  it('bounds event labels to their clip spans and uses them as timeline navigation', async () => {
    renderWorkspace();

    const event = await screen.findByRole('button', { name: '事件 B 00:05.000' });
    expect(event.style.width).not.toBe('');
    expect(event.className).toContain('overflow-hidden');
    fireEvent.click(event);

    expect(Number(screen.getByRole('slider', { name: '时间轴播放头' }).getAttribute('aria-valuenow'))).toBe(5);
  });

  it('lifts an In/Out range from every targeted track without closing the gap', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: targetedRangeProject(), applyProjectPatch });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    fireEvent.click(screen.getByRole('button', { name: '设为目标轨道 Music' }));
    expect(screen.getByText('目标：Story、Music')).toBeTruthy();
    fireEvent.keyDown(timeline, { key: 'i' });
    stepTimelineSeconds(screen.getByRole('slider', { name: '时间轴播放头' }), 1);
    fireEvent.keyDown(timeline, { key: 'o' });
    fireEvent.keyDown(timeline, { key: ';' });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'project' },
      operations: [
        {
          op: 'replace_track_clips',
          track_id: STORY_ID,
          clips: [
            expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ start: 1, duration: 4, source_in: 1 }) }),
            expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 5 }) }),
          ],
        },
        {
          op: 'replace_track_clips',
          track_id: '00000000-0000-4000-8000-000000000013',
          clips: [expect.objectContaining({ placement: expect.objectContaining({ start: 1, duration: 9, source_in: 1 }) })],
        },
      ],
    })));
    expect(screen.queryByLabelText('入出点范围 00:00.000 到 00:01.000')).toBeNull();
    openTimelineCommands();
    expect(screen.getByRole('menuitem', { name: '在播放头粘贴覆盖' }).getAttribute('aria-disabled')).not.toBe('true');
    expect(screen.getByRole('menuitem', { name: '在播放头插入粘贴' }).getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.keyDown(screen.getByRole('menu', { name: '剪辑操作' }), { key: 'Escape' });
  });

  it('extracts an In/Out range from every targeted track and preserves external gaps', async () => {
    const applyProjectPatch = vi.fn();
    const base = targetedRangeProject();
    const outside = {
      id: '00000000-0000-4000-8000-000000000111',
      time: 3,
      duration: 0,
      label: 'Outside',
      color: '#2F6FED',
      kind: 'comment' as const,
      comment: '',
    };
    renderWorkspace({
      project: {
        ...base,
        document: {
          ...base.document,
          markers: [
            { ...outside, id: '00000000-0000-4000-8000-000000000110', time: 0.5, label: 'Inside' },
            outside,
          ],
        },
      },
      applyProjectPatch,
    });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    fireEvent.click(screen.getByRole('button', { name: '设为目标轨道 Music' }));
    fireEvent.keyDown(timeline, { key: 'i' });
    stepTimelineSeconds(screen.getByRole('slider', { name: '时间轴播放头' }), 1);
    fireEvent.keyDown(timeline, { key: 'o' });
    expect(screen.getByLabelText('入出点范围 00:00.000 到 00:01.000')).toBeTruthy();
    fireEvent.keyDown(timeline, { key: "'" });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'project' },
      operations: [
        {
          op: 'replace_track_clips',
          track_id: STORY_ID,
          clips: [
            expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ start: 0, duration: 4, source_in: 1 }) }),
            expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 4 }) }),
          ],
        },
        {
          op: 'replace_track_clips',
          track_id: '00000000-0000-4000-8000-000000000013',
          clips: [expect.objectContaining({ placement: expect.objectContaining({ start: 0, duration: 9, source_in: 1 }) })],
        },
        { op: 'replace_markers', markers: [outside] },
      ],
    })));
    expect(screen.queryByLabelText('入出点范围 00:00.000 到 00:01.000')).toBeNull();
  });

  it('supports Premiere Q and W ripple trims through the shared Story edit path', async () => {
    const qPatch = vi.fn();
    const qRender = renderWorkspace({ applyProjectPatch: qPatch });
    const qTimeline = await screen.findByRole('region', { name: '时间轴' });
    stepTimelineSeconds(screen.getByRole('slider', { name: '时间轴播放头' }), 1);
    fireEvent.keyDown(qTimeline, { key: 'q' });
    await waitFor(() => expect(qPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        clips: [
          expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ start: 0, duration: 4, source_in: 1 }) }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 4 }) }),
        ],
      })],
    })));

    qRender.unmount();
    const wPatch = vi.fn();
    renderWorkspace({ applyProjectPatch: wPatch });
    const wTimeline = await screen.findByRole('region', { name: '时间轴' });
    stepTimelineSeconds(screen.getByRole('slider', { name: '时间轴播放头' }), 1);
    fireEvent.keyDown(wTimeline, { key: 'w' });
    await waitFor(() => expect(wPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        clips: [
          expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ start: 0, duration: 1, source_out: 1 }) }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 1 }) }),
        ],
      })],
    })));
  });

  it('deletes a Story clip and closes the gap', async () => {
    const applyProjectPatch = vi.fn(() => Promise.resolve({
      project: { ...PROJECT, revision: 2 },
      change_group: {
        id: '00000000-0000-4000-8000-000000000023', project_id: PROJECT.id,
        from_revision: 1, to_revision: 2, author: { kind: 'human' as const }, status: 'completed' as const,
        summary: '删除 B', reverts_change_group_id: null, operations: [], inverse_operations: [],
        created_at: PROJECT.updated_at, completed_at: PROJECT.updated_at,
      },
    }));
    renderWorkspace({ applyProjectPatch });

    fireEvent.click(await screen.findByRole('button', { name: /B 5\.0s · 已录制/u }));
    runTimelineCommand('删除所选片段并闭合间隙');

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ start: 0 }) })],
      }],
    })));
  });

  it('moves Sync-Locked free tracks in the same Story ripple patch', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: syncLockProject(), applyProjectPatch });

    const syncLock = await screen.findByRole('button', { name: '切换同步锁定 B-Roll' });
    await waitFor(() => expect(syncLock.getAttribute('aria-pressed')).toBe('true'));
    runTimelineCommand('删除所选片段并闭合间隙');

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'project' },
      operations: [
        expect.objectContaining({
          op: 'replace_track_clips',
          track_id: STORY_ID,
          clips: [expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 0 }) })],
        }),
        expect.objectContaining({
          op: 'replace_track_clips',
          track_id: '00000000-0000-4000-8000-000000000097',
          clips: [expect.objectContaining({ placement: expect.objectContaining({ start: 1 }) })],
        }),
      ],
    })));
  });

  it('leaves a free track fixed after its Sync Lock is disabled', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: syncLockProject(), applyProjectPatch });

    const syncLock = await screen.findByRole('button', { name: '切换同步锁定 B-Roll' });
    await waitFor(() => expect(syncLock.getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(syncLock);
    expect(syncLock.getAttribute('aria-pressed')).toBe('false');
    runTimelineCommand('删除所选片段并闭合间隙');

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'track', track_id: STORY_ID },
      operations: [expect.objectContaining({ op: 'replace_track_clips', track_id: STORY_ID })],
    })));
  });

  it('Shift-clicks Sync Lock across every track of the same type', async () => {
    renderWorkspace({ project: syncLockProject() });

    const storySync = await screen.findByRole('button', { name: '切换同步锁定 Story' });
    const overlaySync = screen.getByRole('button', { name: '切换同步锁定 B-Roll' });
    await waitFor(() => {
      expect(storySync.getAttribute('aria-pressed')).toBe('true');
      expect(overlaySync.getAttribute('aria-pressed')).toBe('true');
    });
    fireEvent.click(overlaySync, { shiftKey: true });
    expect(storySync.getAttribute('aria-pressed')).toBe('false');
    expect(overlaySync.getAttribute('aria-pressed')).toBe('false');
  });

  it('adds to the same-track selection without dragging and deletes the batch in one ripple edit', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    const clipA = await screen.findByRole('button', { name: /A 5\.0s · 未录制/u });
    const clipB = screen.getByRole('button', { name: /B 5\.0s · 已录制/u });
    fireEvent.pointerDown(clipB, { pointerId: 31, button: 0, ctrlKey: true, clientX: 400 });

    await waitFor(() => {
      expect(clipA.className).toContain('ring-accent');
      expect(clipB.className).toContain('ring-accent');
    });
    expect(clipB.hasPointerCapture(31)).toBe(false);

    runTimelineCommand('删除所选片段并闭合间隙');

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{ op: 'replace_track_clips', track_id: STORY_ID, clips: [] }],
    })));
    expect(applyProjectPatch).toHaveBeenCalledTimes(1);
  });

  it('copies the selection and pastes it at the playhead through one Story ripple edit', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    fireEvent.keyDown(timeline, { key: 'c', ctrlKey: true });
    stepTimelineSeconds(screen.getByRole('slider', { name: '时间轴播放头' }), 1);
    fireEvent.keyDown(timeline, { key: 'v', ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ start: 0, duration: 1 }) }),
          expect.objectContaining({ placement: expect.objectContaining({ start: 1, duration: 5 }) }),
          expect.objectContaining({ placement: expect.objectContaining({ start: 6, duration: 4 }) }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 10 }) }),
        ],
      })],
    })));
    expect(applyProjectPatch).toHaveBeenCalledTimes(1);
  });

  it('duplicates the selection at the playhead without changing the original', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });
    const timeline = await screen.findByRole('region', { name: '时间轴' });
    stepTimelineSeconds(screen.getByRole('slider', { name: '时间轴播放头' }), 5);
    fireEvent.keyDown(timeline, { key: '/', ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ start: 0, duration: 5 }) }),
          expect.objectContaining({ name: 'A', placement: expect.objectContaining({ start: 5, duration: 5 }) }),
        ],
      }],
    })));
    const clips = applyProjectPatch.mock.calls[0]?.[0].operations[0].clips as TimelineClip[];
    expect(clips[1]?.id).not.toBe(CLIP_A);
  });

  it('selectively pastes copied clip attributes without replacing the target edit', async () => {
    const project: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        tracks: PROJECT.document.tracks.map((track) => track.id !== STORY_ID ? track : {
          ...track,
          clips: track.clips.map((candidate) => candidate.id !== CLIP_A ? candidate : {
            ...candidate,
            transform: { ...candidate.transform, x: 50 },
            effects: [{ id: 'blur-source', kind: 'blur', enabled: true, parameters: { radius: 4 } }],
            keyframes: [{ id: 'opacity-source', time: 1, property: 'opacity', value: 0.5, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0  }],
          }),
        }),
      },
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project, applyProjectPatch });
    const timeline = await screen.findByRole('region', { name: '时间轴' });
    fireEvent.keyDown(timeline, { key: 'c', ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: /B 5\.0s · 已录制/u }));
    fireEvent.keyDown(timeline, { key: 'v', ctrlKey: true, altKey: true });
    const dialog = screen.getByRole('dialog', { name: '选择性粘贴属性' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '转场' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '粘贴属性' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: expect.arrayContaining([expect.objectContaining({
          id: CLIP_B,
          name: 'B',
          placement: expect.objectContaining({ start: 5, duration: 5 }),
          transform: expect.objectContaining({ x: 50 }),
          effects: [expect.objectContaining({ kind: 'blur', parameters: { radius: 4 } })],
          keyframes: [expect.objectContaining({ property: 'opacity', time: 1, value: 0.5 })],
        })]),
      })],
    })));
  });

  it('selects and closes one or every free-track gap', async () => {
    const bRollId = '00000000-0000-4000-8000-000000000210';
    const freeProject: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        tracks: [...PROJECT.document.tracks, {
          id: bRollId, name: 'B-Roll', kind: 'video', order: 2,
          muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false,
          clips: [
            { ...clip('00000000-0000-4000-8000-000000000211', 'X'), placement: { ...clip('00000000-0000-4000-8000-000000000211', 'X').placement, start: 2, duration: 2, source_out: 2 } },
            { ...clip('00000000-0000-4000-8000-000000000212', 'Y'), placement: { ...clip('00000000-0000-4000-8000-000000000212', 'Y').placement, start: 7, duration: 1, source_out: 1 } },
          ],
        }],
      },
    };
    const oneGapPatch = vi.fn();
    const first = renderWorkspace({ project: freeProject, applyProjectPatch: oneGapPatch });
    const timeline = await screen.findByRole('region', { name: '时间轴' });
    const gap = screen.getByRole('button', { name: '间隙 B-Roll 00:04.000 到 00:07.000' });
    fireEvent.click(gap);
    expect(gap.getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(timeline, { key: 'Delete' });
    await waitFor(() => expect(oneGapPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_track_clips', track_id: bRollId,
        clips: [
          expect.objectContaining({ name: 'X', placement: expect.objectContaining({ start: 2 }) }),
          expect.objectContaining({ name: 'Y', placement: expect.objectContaining({ start: 4 }) }),
        ],
      }],
    })));
    first.unmount();

    const allGapsPatch = vi.fn();
    renderWorkspace({ project: freeProject, applyProjectPatch: allGapsPatch });
    await screen.findByRole('button', { name: '设为目标轨道 B-Roll' });
    fireEvent.click(screen.getByRole('button', { name: '设为目标轨道 Story' }));
    fireEvent.click(screen.getByRole('button', { name: '设为目标轨道 B-Roll' }));
    openTimelineCommands();
    fireEvent.click(screen.getByRole('menuitem', { name: '关闭目标轨全部间隙' }));
    await waitFor(() => expect(allGapsPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_track_clips', track_id: bRollId,
        clips: [
          expect.objectContaining({ name: 'X', placement: expect.objectContaining({ start: 0 }) }),
          expect.objectContaining({ name: 'Y', placement: expect.objectContaining({ start: 2 }) }),
        ],
      }],
    })));
  });

  it('recovers Timeline selection, transport marks and clipboard after remount', async () => {
    const first = renderWorkspace();
    const timeline = await screen.findByRole('region', { name: '时间轴' });
    const clipB = screen.getByRole('button', { name: /B 5\.0s · 已录制/u });
    fireEvent.pointerDown(clipB, { pointerId: 311, button: 0, clientX: 500 });
    const playhead = screen.getByRole('slider', { name: '时间轴播放头' });
    stepTimelineSeconds(playhead, 3);
    fireEvent.keyDown(timeline, { key: 'i' });
    stepTimelineSeconds(playhead, 2);
    fireEvent.keyDown(timeline, { key: 'o' });
    fireEvent.click(screen.getByRole('button', { name: '切换循环播放' }));
    fireEvent.keyDown(timeline, { key: 'c', ctrlKey: true });

    await waitFor(() => {
      expect(globalThis.localStorage.getItem(`vibe-cs:timeline-session:${PROJECT.id}`)).not.toBeNull();
      expect(globalThis.localStorage.getItem(`vibe-cs:timeline-clipboard:${PROJECT.id}`)).not.toBeNull();
    }, { timeout: 2_000 });
    first.unmount();

    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });
    const restoredPlayhead = await screen.findByRole('slider', { name: '时间轴播放头' });
    await waitFor(() => expect(Number(restoredPlayhead.getAttribute('aria-valuenow'))).toBeCloseTo(5));
    expect(screen.getByRole('button', { name: /B 5\.0s · 已录制/u }).className).toContain('ring-accent');
    expect(screen.getByLabelText('入出点范围 00:03.000 到 00:05.000')).toBeTruthy();
    expect(screen.getByRole('button', { name: '切换循环播放' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.keyDown(screen.getByRole('region', { name: '时间轴' }), { key: 'v', ctrlKey: true });
    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({ op: 'replace_track_clips', track_id: STORY_ID })],
    })));
  }, 20_000);

  it('cuts the selected Story clip into the Timeline clipboard with Ctrl+X', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    fireEvent.keyDown(timeline, { key: 'x', ctrlKey: true });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 0 }) })],
      }],
    })));
    openTimelineCommands();
    expect(screen.getByRole('menuitem', { name: '在播放头粘贴覆盖' }).getAttribute('aria-disabled')).not.toBe('true');
  });

  it('pastes a single clipboard group to the explicitly targeted track', async () => {
    const bRollTrackId = '00000000-0000-4000-8000-000000000095';
    const project: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        tracks: [...PROJECT.document.tracks, {
          id: bRollTrackId,
          name: 'B-Roll',
          kind: 'video',
          order: 2,
          muted: false,
          solo: false,
          volume: 1,
          pan: 0,
          keyframes: [],
          locked: false,
          hidden: false,
          clips: [],
        }],
      },
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project, applyProjectPatch });

    await screen.findByRole('button', { name: '剪辑操作' });
    runTimelineCommand('复制所选片段');
    fireEvent.click(screen.getByRole('button', { name: '设为目标轨道 Story' }));
    const bRollTarget = screen.getByRole('button', { name: '设为目标轨道 B-Roll' });
    fireEvent.click(bRollTarget);
    expect(bRollTarget.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('目标：B-Roll')).toBeTruthy();
    runTimelineCommand('在播放头粘贴覆盖');

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_track_clips',
        track_id: bRollTrackId,
        clips: [expect.objectContaining({ name: 'A', placement: expect.objectContaining({ start: 0, duration: 5 }) })],
      }],
    })));
  });

  it('does not initialize Track Targeting onto a locked Story track', async () => {
    const lockedProject: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        tracks: PROJECT.document.tracks.map((track) => track.id === STORY_ID
          ? { ...track, locked: true }
          : track),
      },
    };
    renderWorkspace({ project: lockedProject });

    const storyTarget = await screen.findByRole('button', { name: '设为目标轨道 Story' }) as HTMLButtonElement;
    expect(storyTarget.disabled).toBe(true);
    expect(storyTarget.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('目标：—')).toBeTruthy();
  });

  it('toggles the current target track off instead of immediately restoring Story', async () => {
    renderWorkspace();

    const storyTarget = await screen.findByRole('button', { name: '设为目标轨道 Story' });
    expect(storyTarget.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(storyTarget);

    expect(storyTarget.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('目标：—')).toBeTruthy();
  });


  it('undoes the latest completed human Change Group', async () => {
    const revertProjectChangeGroup = vi.fn(() => Promise.resolve({
      project: { ...PROJECT, revision: 3 },
      change_group: {
        id: '00000000-0000-4000-8000-000000000025', project_id: PROJECT.id,
        from_revision: 2, to_revision: 3, author: { kind: 'human' as const }, status: 'completed' as const,
        summary: '撤销移动 A', reverts_change_group_id: '00000000-0000-4000-8000-000000000024',
        operations: [], inverse_operations: [], created_at: PROJECT.updated_at, completed_at: PROJECT.updated_at,
      },
    }));
    const group: ProjectChangeGroup = {
      id: '00000000-0000-4000-8000-000000000024',
      project_id: PROJECT.id,
      from_revision: 1,
      to_revision: 2,
      author: { kind: 'human' },
      status: 'completed',
      summary: '移动 A',
      reverts_change_group_id: null,
      operations: [{ op: 'replace_track_clips', track_id: STORY_ID, clips: PROJECT.document.tracks[0]!.clips }],
      inverse_operations: [],
      created_at: PROJECT.updated_at,
      completed_at: PROJECT.updated_at,
    };
    renderWorkspace({ groups: [group], revertProjectChangeGroup });

    await screen.findByRole('button', { name: '剪辑操作' });
    runTimelineCommand('撤销上一次剪辑');

    await waitFor(() => expect(revertProjectChangeGroup).toHaveBeenCalledWith(
      PROJECT.id,
      group.id,
      PROJECT.revision,
    ));
  });

  it('redoes the latest undone Change Group with Ctrl+Shift+Z', async () => {
    const original: ProjectChangeGroup = {
      id: '00000000-0000-4000-8000-000000000026',
      project_id: PROJECT.id,
      from_revision: 0,
      to_revision: 1,
      author: { kind: 'human' },
      status: 'completed',
      summary: '移动 A',
      reverts_change_group_id: null,
      operations: [{ op: 'replace_track_clips', track_id: STORY_ID, clips: PROJECT.document.tracks[0]!.clips }],
      inverse_operations: [],
      created_at: PROJECT.updated_at,
      completed_at: PROJECT.updated_at,
    };
    const undone: ProjectChangeGroup = {
      ...original,
      id: '00000000-0000-4000-8000-000000000027',
      from_revision: 1,
      to_revision: 2,
      summary: '撤销移动 A',
      reverts_change_group_id: original.id,
    };
    const revertProjectChangeGroup = vi.fn();
    renderWorkspace({ groups: [undone, original], revertProjectChangeGroup });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    fireEvent.keyDown(timeline, { key: 'z', ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(revertProjectChangeGroup).toHaveBeenCalledWith(
      PROJECT.id,
      undone.id,
      PROJECT.revision,
    ));
  });


  it('plays the recorded asset at the transport time through the desktop media bridge', async () => {
    renderWorkspace({
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    await screen.findByRole('button', { name: /B 5\.0s · 已录制/u });
    stepTimelineSeconds(screen.getByRole('slider', { name: '时间轴播放头' }), 5);
    const preview = await screen.findByLabelText('B 视频预览') as HTMLVideoElement;
    expect(preview.getAttribute('src')).toBe('vibe-cs-media://localhost/media/assets/asset-b/stream');
  });

  it('renders timeline filmstrips from static thumbnails instead of clip video decoders', async () => {
    renderWorkspace({
      project: RECORDED_PROJECT,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const timeline = await screen.findByRole('region', { name: '时间轴内容' });
    expect(timeline.querySelectorAll('[data-timeline-clip-id] video')).toHaveLength(0);
    const thumbnails = timeline.querySelectorAll<HTMLImageElement>('[data-timeline-clip-id] img');
    expect(thumbnails).toHaveLength(2);
    expect(thumbnails[0]?.getAttribute('src')).toContain('/media/assets/asset-a/thumbnail?time=0');
    expect(thumbnails[1]?.getAttribute('src')).toContain('/media/assets/asset-b/thumbnail?time=1');
  });

  it('uses a warm timeline-driven preview without native media transport', async () => {
    renderWorkspace({
      project: RECORDED_PROJECT,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const monitor = await screen.findByRole('region', { name: '视频预览' });
    const videos = monitor.querySelectorAll('video');
    expect(videos).toHaveLength(4);
    expect([...videos].every((video) => !video.controls)).toBe(true);
    expect([...videos].every((video) => video.classList.contains('object-contain') && !video.classList.contains('object-cover'))).toBe(true);
    const first = screen.getByLabelText('A 视频预览') as HTMLVideoElement;
    const play = vi.fn(() => Promise.resolve());
    const pause = vi.fn();
    Object.defineProperties(first, {
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_ENOUGH_DATA },
      play: { configurable: true, value: play },
      pause: { configurable: true, value: pause },
    });
    fireEvent.loadedData(first);
    fireEvent.click(screen.getByRole('button', { name: '播放时间轴' }));
    await waitFor(() => expect(play).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'K 暂停时间轴' }));

    stepTimelineSeconds(screen.getByRole('slider', { name: '时间轴播放头' }), 5);
    const target = await screen.findByLabelText('B 视频预览') as HTMLVideoElement;
    Object.defineProperty(target, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_ENOUGH_DATA });
    fireEvent.loadedData(target);
    await waitFor(() => {
      const active = monitor.querySelector<HTMLVideoElement>('[data-preview-active="true"]');
      expect(active?.getAttribute('src')).toBe('vibe-cs-media://localhost/media/assets/asset-b/stream');
      expect(active?.currentTime).toBe(1);
    });
  });

  it('lets forward Program playback drive Timeline without feedback seeks', async () => {
    renderWorkspace({
      project: RECORDED_PROJECT,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const preview = await screen.findByLabelText('A 视频预览') as HTMLVideoElement;
    let simulatedTime = 0;
    const seekWrites: number[] = [];
    const play = vi.fn(() => Promise.resolve());
    Object.defineProperties(preview, {
      currentTime: {
        configurable: true,
        get: () => {
          const current = simulatedTime;
          simulatedTime += 0.02;
          return current;
        },
        set: (value: number) => {
          seekWrites.push(value);
          simulatedTime = value;
        },
      },
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_ENOUGH_DATA },
      play: { configurable: true, value: play },
      pause: { configurable: true, value: vi.fn() },
    });
    fireEvent.loadedData(preview);
    seekWrites.length = 0;
    fireEvent.click(screen.getByRole('button', { name: '播放时间轴' }));
    await waitFor(() => expect(play).toHaveBeenCalled());

    simulatedTime = 1;
    fireEvent.timeUpdate(preview);
    await waitFor(() => expect(Number(
      screen.getByRole('slider', { name: '时间轴播放头' }).getAttribute('aria-valuenow'),
    )).toBe(1));
    expect(seekWrites).toEqual([]);
  });

  it('advances the Timeline from presented Program video frames', async () => {
    renderWorkspace({
      project: RECORDED_PROJECT,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const preview = await screen.findByLabelText('A 视频预览') as HTMLVideoElement;
    const requestVideoFrameCallback = vi.fn((_callback: VideoFrameRequestCallback) => (
      requestVideoFrameCallback.mock.calls.length
    ));
    const cancelVideoFrameCallback = vi.fn();
    Object.defineProperties(preview, {
      currentTime: { configurable: true, writable: true, value: 0 },
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_ENOUGH_DATA },
      requestVideoFrameCallback: { configurable: true, value: requestVideoFrameCallback },
      cancelVideoFrameCallback: { configurable: true, value: cancelVideoFrameCallback },
      play: { configurable: true, value: vi.fn(() => Promise.resolve()) },
      pause: { configurable: true, value: vi.fn() },
    });
    fireEvent.loadedData(preview);
    fireEvent.click(screen.getByRole('button', { name: '播放时间轴' }));
    await waitFor(() => expect(requestVideoFrameCallback).toHaveBeenCalledTimes(1));

    preview.currentTime = 1.25;
    const frameCallback = requestVideoFrameCallback.mock.calls[0]?.[0];
    if (frameCallback === undefined) throw new Error('expected a Program video frame callback');
    frameCallback(performance.now(), {} as VideoFrameCallbackMetadata);
    await waitFor(() => expect(Number(
      screen.getByRole('slider', { name: '时间轴播放头' }).getAttribute('aria-valuenow'),
    )).toBe(1.25));
    expect(requestVideoFrameCallback).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'K 暂停时间轴' }));
    expect(cancelVideoFrameCallback).toHaveBeenCalled();
  });

  it('plays an independent A track under the shared transport when Story has no video clock', async () => {
    const audioClip: TimelineClip = {
      ...clip('00000000-0000-4000-8000-000000000088', 'Audio only'),
      material: { kind: 'asset', asset_id: 'asset-audio-only', media_duration_seconds: 8 },
      placement: { start: 0, duration: 8, source_in: 0, source_out: 8, speed: 1, reverse: false, frame_hold_source_time: null, volume: 0.5, pan: 0, enabled: true },
    };
    const project: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        duration_seconds: 8,
        tracks: PROJECT.document.tracks.map((track) => track.id === STORY_ID
          ? { ...track, clips: [] }
          : { ...track, clips: [audioClip] }),
      },
    };
    renderWorkspace({
      project,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    await screen.findByRole('region', { name: '视频预览' });
    const audio = document.querySelector<HTMLAudioElement>('[data-timeline-audio-clip-id="00000000-0000-4000-8000-000000000088"]');
    expect(audio).not.toBeNull();
    const play = vi.fn(() => Promise.resolve());
    const pause = vi.fn();
    Object.defineProperties(audio!, {
      currentTime: { configurable: true, writable: true, value: 0 },
      play: { configurable: true, value: play },
      pause: { configurable: true, value: pause },
    });
    fireEvent.loadedData(audio!);
    expect(audio?.getAttribute('src')).toBe('vibe-cs-media://localhost/media/assets/asset-audio-only/stream');
    expect(audio?.dataset.timelineAudioActive).toBe('true');
    expect(audio?.dataset.timelineAudioMuted).toBe('false');
    expect(audio?.dataset.timelineAudioOutputVolume).toBe('0.5');

    fireEvent.click(screen.getByRole('button', { name: '播放时间轴' }));
    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'K 暂停时间轴' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'K 暂停时间轴' }));
  });

  it('rejects stale Program media time updates until the desired source frame is presented', async () => {
    renderWorkspace({
      project: RECORDED_PROJECT,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const preview = await screen.findByLabelText('A 视频预览') as HTMLVideoElement;
    Object.defineProperties(preview, {
      currentTime: { configurable: true, writable: true, value: 2 },
      seeking: { configurable: true, value: false },
    });
    fireEvent.timeUpdate(preview);
    expect(Number(screen.getByRole('slider', { name: '时间轴播放头' }).getAttribute('aria-valuenow'))).toBe(0);
  });

  it('keeps a paused frame-snapped playhead authoritative after Program seek completion', async () => {
    renderWorkspace({
      project: RECORDED_PROJECT,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const playhead = await screen.findByRole('slider', { name: '时间轴播放头' });
    stepTimelineSeconds(playhead, 1);
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBe(1);
    const preview = screen.getByLabelText('A 视频预览') as HTMLVideoElement;
    Object.defineProperties(preview, {
      currentTime: { configurable: true, writable: true, value: 1.000_001 },
      seeking: { configurable: true, value: false },
    });
    fireEvent.timeUpdate(preview);
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBe(1);
  });

  it('previews canonical static and animated transforms on the stable Program Monitor pool', async () => {
    const project: Project = {
      ...RECORDED_PROJECT,
      document: {
        ...RECORDED_PROJECT.document,
        tracks: RECORDED_PROJECT.document.tracks.map((track) => track.id !== STORY_ID ? track : {
          ...track,
          clips: track.clips.map((candidate) => candidate.id !== CLIP_A ? candidate : {
            ...candidate,
            transform: { ...candidate.transform, y: 54, scale_x: 1.2, scale_y: 0.8, rotation: 15, opacity: 0.5 },
            keyframes: [
              { id: 'x-0', time: 0, property: 'x', value: 96, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0  },
              { id: 'x-1', time: 1, property: 'x', value: 192, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0  },
            ],
          }),
        }),
      },
    };
    renderWorkspace({
      project,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const preview = await screen.findByLabelText('A 视频预览') as HTMLVideoElement;
    expect(preview.dataset.previewTransformX).toBe('96');
    expect(preview.dataset.previewTransformY).toBe('54');
    expect(preview.dataset.previewScaleX).toBe('1.2');
    expect(preview.dataset.previewScaleY).toBe('0.8');
    expect(preview.dataset.previewRotation).toBe('15');
    expect(preview.dataset.previewOpacity).toBe('0.5');
    expect(preview.style.transform).toContain('translate3d(5%');
    expect(preview.style.opacity).toBe('0.5');

    stepTimelineSeconds(screen.getByRole('slider', { name: '时间轴播放头' }), 1);
    await waitFor(() => expect((screen.getByLabelText('A 视频预览') as HTMLVideoElement).dataset.previewTransformX).toBe('192'));
    expect(screen.getByRole('region', { name: '视频预览' }).querySelectorAll('video')).toHaveLength(4);
  });

  it('previews canonical text tracks and omits unsupported text transitions', async () => {
    const textClipId = '00000000-0000-4000-8000-000000000099';
    const textClip: TimelineClip = {
      ...clip(textClipId, 'Title'),
      placement: { ...clip(textClipId, 'Title').placement, duration: 5, source_out: 5 },
      transform: { ...clip(textClipId, 'Title').transform, x: 96, y: 54, opacity: 0.5 },
      keyframes: [
        { id: 'title-x-0', time: 0, property: 'x', value: 96, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0  },
        { id: 'title-x-1', time: 1, property: 'x', value: 192, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0  },
      ],
      text: {
        content: 'NiKo',
        font_family: 'Arial',
        font_asset_id: null,
        font_size: 72,
        color: '#FFFFFF',
        background: '#000000',
        align: 'center',
      },
    };
    const project: Project = {
      ...RECORDED_PROJECT,
      document: {
        ...RECORDED_PROJECT.document,
        tracks: [...RECORDED_PROJECT.document.tracks, {
          id: '00000000-0000-4000-8000-000000000098',
          name: 'Titles',
          kind: 'text',
          order: RECORDED_PROJECT.document.tracks.length,
          muted: false,
          solo: false,
          volume: 1,
          pan: 0,
          keyframes: [],
          locked: false,
          hidden: false,
          clips: [textClip],
        }],
      },
    };
    renderWorkspace({
      project,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const overlay = await screen.findByText('NiKo', { selector: `[data-program-text-clip-id="${textClipId}"]` });
    expect(overlay.dataset.programTextX).toBe('96');
    expect(overlay.dataset.programTextY).toBe('54');
    expect(overlay.dataset.programTextOpacity).toBe('0.5');
    expect(overlay.style.left).toBe('55%');
    expect(overlay.style.top).toBe('55%');

    stepTimelineSeconds(screen.getByRole('slider', { name: '时间轴播放头' }), 1);
    await waitFor(() => expect(overlay.dataset.programTextX).toBe('192'));
    expect(overlay.style.left).toBe('60%');

    fireEvent.doubleClick(screen.getByRole('button', { name: /Title 5\.0s · 已生成/u }));
    expect(await screen.findByRole('dialog', { name: '片段属性' })).toBeTruthy();
    const textStyle = screen.getByRole('region', { name: '文字样式' });
    expect((within(textStyle).getByLabelText('文字内容') as HTMLTextAreaElement).value).toBe('NiKo');
    expect((within(textStyle).getByLabelText('字体') as HTMLInputElement).value).toBe('Arial');
    expect((within(textStyle).getByLabelText('字号') as HTMLInputElement).value).toBe('72');
    expect((within(textStyle).getByLabelText('对齐') as HTMLSelectElement).value).toBe('center');
    expect((within(textStyle).getByLabelText('启用文字背景') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByLabelText('入场转场')).toBeNull();
    expect(screen.queryByLabelText('出场转场')).toBeNull();
  });

  it('composites non-Story video tracks without giving them Transport authority', async () => {
    const overlayTrackId = '00000000-0000-4000-8000-000000000097';
    const overlayClipId = '00000000-0000-4000-8000-000000000096';
    const source = RECORDED_PROJECT.document.tracks.find((track) => track.id === STORY_ID)!.clips[1]!;
    const overlayClip: TimelineClip = {
      ...source,
      id: overlayClipId,
      name: 'Reaction overlay',
      placement: { ...source.placement, start: 0, duration: 5, source_in: 1, source_out: 6 },
      transform: { ...source.transform, x: 96, y: 54, scale_x: 0.5, scale_y: 0.5, opacity: 0.8 },
    };
    const project: Project = {
      ...RECORDED_PROJECT,
      document: {
        ...RECORDED_PROJECT.document,
        tracks: [...RECORDED_PROJECT.document.tracks, {
          id: overlayTrackId,
          name: 'Overlay',
          kind: 'overlay',
          order: RECORDED_PROJECT.document.tracks.length,
          muted: true,
          solo: false,
          volume: 1,
          pan: 0,
          keyframes: [],
          locked: false,
          hidden: false,
          clips: [overlayClip],
        }],
      },
    };
    renderWorkspace({
      project,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const monitor = await screen.findByRole('region', { name: '视频预览' });
    const layer = monitor.querySelector<HTMLElement>(`[data-preview-track-id="${overlayTrackId}"]`);
    expect(layer).not.toBeNull();
    const preview = layer?.querySelector('video') as HTMLVideoElement;
    const play = vi.fn(() => Promise.resolve());
    Object.defineProperties(preview, {
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_ENOUGH_DATA },
      play: { configurable: true, value: play },
      pause: { configurable: true, value: vi.fn() },
    });
    fireEvent.loadedData(preview);
    await waitFor(() => expect(preview.dataset.previewActive).toBe('true'));
    expect(preview.dataset.previewTransformX).toBe('96');
    expect(preview.dataset.previewScaleX).toBe('0.5');
    expect(preview.dataset.previewOpacity).toBe('0.8');
    expect(preview.muted).toBe(true);
    expect(layer?.style.zIndex).toBe(String(1 + project.document.tracks.length - 1));

    const basePreview = monitor.querySelector<HTMLVideoElement>('video[data-preview-track-id=""][data-preview-active="true"]');
    if (basePreview === null) throw new Error('expected the Story Program video');
    Object.defineProperties(basePreview, {
      play: { configurable: true, value: vi.fn(() => Promise.resolve()) },
      pause: { configurable: true, value: vi.fn() },
    });
    fireEvent.click(screen.getByRole('button', { name: '播放时间轴' }));
    await waitFor(() => expect(play).toHaveBeenCalled());
    preview.currentTime = 2;
    fireEvent.timeUpdate(preview);
    expect(Number(screen.getByRole('slider', { name: '时间轴播放头' }).getAttribute('aria-valuenow'))).not.toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'K 暂停时间轴' }));
  });

  it('previews still-image Story clips without creating a video clock', async () => {
    const imageClip: TimelineClip = {
      ...clip(CLIP_A, 'Title card'),
      material: { kind: 'asset', asset_id: 'asset-image', media_duration_seconds: 5 },
      placement: { ...clip(CLIP_A, 'Title card').placement, duration: 5, source_out: 5 },
      transform: { ...clip(CLIP_A, 'Title card').transform, x: 96, y: 54, opacity: 0.8 },
      metadata: { media_asset_id: 'asset-image', media_kind: 'image/png' },
    };
    const project: Project = {
      ...RECORDED_PROJECT,
      document: {
        ...RECORDED_PROJECT.document,
        duration_seconds: 5,
        tracks: RECORDED_PROJECT.document.tracks.map((track) => track.id === STORY_ID
          ? { ...track, clips: [imageClip] }
          : track),
      },
    };
    renderWorkspace({
      project,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const monitor = await screen.findByRole('region', { name: '视频预览' });
    const image = monitor.querySelector<HTMLImageElement>(`img[data-preview-image-clip-id="${CLIP_A}"]`);
    expect(image).not.toBeNull();
    expect(image?.getAttribute('src')).toBe('vibe-cs-media://localhost/media/assets/asset-image/stream');
    expect(image?.dataset.previewTransformX).toBe('96');
    expect(image?.dataset.previewOpacity).toBe('0.8');
    expect(monitor.dataset.monitorTargetClipId).toBe('');
    expect(monitor.querySelectorAll('video[data-preview-active="true"]')).toHaveLength(0);
  });

  it('previews Volume keyframes and the canonical fade envelope on Program audio', async () => {
    const project: Project = {
      ...RECORDED_PROJECT,
      document: {
        ...RECORDED_PROJECT.document,
        tracks: RECORDED_PROJECT.document.tracks.map((track) => track.id !== STORY_ID ? track : {
          ...track,
          clips: track.clips.map((candidate) => candidate.id !== CLIP_A ? candidate : {
            ...candidate,
            transitions: {
              ...candidate.transitions,
              audio_in: { kind: 'constant_power', duration_seconds: 1 },
            },
            keyframes: [
              { id: 'volume-0', time: 0, property: 'volume', value: 0.5, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0  },
              { id: 'volume-1', time: 1, property: 'volume', value: 1, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0  },
            ],
          }),
        }),
      },
    };
    renderWorkspace({
      project,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const preview = await screen.findByLabelText('A 视频预览') as HTMLVideoElement;
    await waitFor(() => expect(preview.dataset.previewCanonicalVolume).toBe('0.5'));
    expect(preview.dataset.previewFadeFactor).toBe('0');
    expect(preview.dataset.previewOutputVolume).toBe('0');
    expect(preview.volume).toBe(0);

    stepTimelineSeconds(screen.getByRole('slider', { name: '时间轴播放头' }), 1);
    await waitFor(() => expect((screen.getByLabelText('A 视频预览') as HTMLVideoElement).dataset.previewCanonicalVolume).toBe('1'));
    expect(preview.dataset.previewFadeFactor).toBe('1');
    expect(preview.dataset.previewOutputVolume).toBe('1');
    expect(preview.volume).toBe(1);
  });

  it('previews enabled renderer-backed effects in canonical order', async () => {
    const project: Project = {
      ...RECORDED_PROJECT,
      document: {
        ...RECORDED_PROJECT.document,
        tracks: RECORDED_PROJECT.document.tracks.map((track) => track.id !== STORY_ID ? track : {
          ...track,
          clips: track.clips.map((candidate) => candidate.id !== CLIP_A ? candidate : {
            ...candidate,
            effects: [
              { id: 'color', kind: 'color_adjust', enabled: true, parameters: { brightness: 0.2, contrast: 1.5, saturation: 0.8 } },
              { id: 'gray', kind: 'grayscale', enabled: true, parameters: {} },
              { id: 'blur', kind: 'blur', enabled: true, parameters: { radius: 4 } },
            ],
          }),
        }),
      },
    };
    renderWorkspace({
      project,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const preview = await screen.findByLabelText('A 视频预览') as HTMLVideoElement;
    expect(preview.dataset.previewEffects).toBe('color_adjust,grayscale,blur');
    expect(preview.style.filter).toContain('brightness(1.2) contrast(1.5) saturate(0.8) grayscale(1) blur(');
    expect(screen.getByLabelText('已启用 3 个效果')).toBeTruthy();
    expect(screen.getByRole('region', { name: '视频预览' }).querySelectorAll('video')).toHaveLength(4);
  });

  it('previews renderer-backed visual transition progress in Program', async () => {
    const project: Project = {
      ...RECORDED_PROJECT,
      document: {
        ...RECORDED_PROJECT.document,
        tracks: RECORDED_PROJECT.document.tracks.map((track) => track.id !== STORY_ID ? track : {
          ...track,
          clips: track.clips.map((candidate) => candidate.id !== CLIP_A ? candidate : {
            ...candidate,
            transitions: {
              ...candidate.transitions,
              video_in: { kind: 'zoom', duration_seconds: 2 },
            },
          }),
        }),
      },
    };
    renderWorkspace({
      project,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const preview = await screen.findByLabelText('A 视频预览') as HTMLVideoElement;
    expect(preview.dataset.previewTransition).toBe('zoom');
    expect(preview.dataset.previewTransitionProgress).toBe('0');
    expect(preview.style.transform).toContain('scale(1.18, 1.18)');

    stepTimelineSeconds(screen.getByRole('slider', { name: '时间轴播放头' }), 1);
    await waitFor(() => expect(preview.dataset.previewTransitionProgress).toBe('0.5'));
    expect(preview.style.transform).toContain('scale(1.09, 1.09)');
  });

  it('directly moves the selected Program clip and commits the latest transform once', async () => {
    const project: Project = {
      ...RECORDED_PROJECT,
      document: {
        ...RECORDED_PROJECT.document,
        tracks: RECORDED_PROJECT.document.tracks.map((track) => track.id !== STORY_ID ? track : {
          ...track,
          clips: track.clips.map((candidate) => candidate.id !== CLIP_A ? candidate : {
            ...candidate,
            transform: { ...candidate.transform, y: 54 },
            keyframes: [{ id: 'x-0', time: 0, property: 'x', value: 96, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0  }],
          }),
        }),
      },
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({
      project,
      applyProjectPatch,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const overlay = await screen.findByRole('button', { name: '在节目画布中移动 A' });
    vi.spyOn(overlay.parentElement!, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 960, bottom: 540, left: 0, width: 960, height: 540, toJSON: () => ({}),
    });
    fireEvent.pointerDown(overlay, { pointerId: 101, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(overlay, { pointerId: 101, clientX: 196, clientY: 154 });
    await waitFor(() => expect((screen.getByLabelText('A 视频预览') as HTMLVideoElement).dataset.previewTransformX).toBe('288'));
    expect(applyProjectPatch).not.toHaveBeenCalled();
    fireEvent.pointerUp(overlay, { pointerId: 101, clientX: 196, clientY: 154 });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledTimes(1));
    expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_clip',
        clip_id: CLIP_A,
        clip: expect.objectContaining({
          transform: expect.objectContaining({ x: 0, y: 162 }),
          keyframes: [expect.objectContaining({ id: 'x-0', time: 0, property: 'x', value: 288, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0  })],
        }),
      })],
    }));
  });

  it('scales and rotates the selected Program clip with dedicated handles', async () => {
    const scalePatch = vi.fn();
    const scaleRender = renderWorkspace({
      project: RECORDED_PROJECT,
      applyProjectPatch: scalePatch,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });
    const stage = await screen.findByLabelText('节目画布');
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 960, bottom: 540, left: 0, width: 960, height: 540, toJSON: () => ({}),
    });
    const scale = screen.getByRole('slider', { name: '缩放节目画面 A' });
    fireEvent.pointerDown(scale, { pointerId: 102, button: 0, clientX: 900, clientY: 500 });
    fireEvent.pointerMove(scale, { pointerId: 102, clientX: 942, clientY: 526 });
    await waitFor(() => expect(Number((screen.getByLabelText('A 视频预览') as HTMLVideoElement).dataset.previewScaleX)).toBeGreaterThan(1.09));
    expect(scalePatch).not.toHaveBeenCalled();
    fireEvent.pointerUp(scale, { pointerId: 102, clientX: 942, clientY: 526 });
    await waitFor(() => expect(scalePatch).toHaveBeenCalledTimes(1));

    scaleRender.unmount();
    const rotationPatch = vi.fn();
    renderWorkspace({
      project: RECORDED_PROJECT,
      applyProjectPatch: rotationPatch,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });
    const rotationStage = await screen.findByLabelText('节目画布');
    vi.spyOn(rotationStage, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 960, bottom: 540, left: 0, width: 960, height: 540, toJSON: () => ({}),
    });
    const rotation = screen.getByRole('slider', { name: '旋转节目画面 A' });
    fireEvent.pointerDown(rotation, { pointerId: 103, button: 0, clientX: 800, clientY: 270 });
    fireEvent.pointerMove(rotation, { pointerId: 103, clientX: 480, clientY: 500 });
    await waitFor(() => expect(Number((screen.getByLabelText('A 视频预览') as HTMLVideoElement).dataset.previewRotation)).toBeCloseTo(90));
    expect(rotationPatch).not.toHaveBeenCalled();
    fireEvent.pointerUp(rotation, { pointerId: 103, clientX: 480, clientY: 500 });
    await waitFor(() => expect(rotationPatch).toHaveBeenCalledTimes(1));
    expect(rotationPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_clip',
        clip: expect.objectContaining({ transform: expect.objectContaining({ rotation: expect.closeTo(90, 5) }) }),
      })],
    }));
  });

  it('keeps a locked selected clip visible in Program without direct-manipulation controls', async () => {
    const lockedProject: Project = {
      ...RECORDED_PROJECT,
      document: {
        ...RECORDED_PROJECT.document,
        tracks: RECORDED_PROJECT.document.tracks.map((track) => track.id === STORY_ID
          ? { ...track, locked: true }
          : track),
      },
    };
    renderWorkspace({
      project: lockedProject,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    expect(await screen.findByLabelText('A 视频预览')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '在节目画布中移动 A' })).toBeNull();
    expect(screen.queryByRole('slider', { name: '缩放节目画面 A' })).toBeNull();
    expect(screen.queryByRole('slider', { name: '旋转节目画面 A' })).toBeNull();
  });

  it('uses one J/K/L transport with frame and edit-point navigation', async () => {
    renderWorkspace({
      project: RECORDED_PROJECT,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const preview = await screen.findByLabelText('A 视频预览') as HTMLVideoElement;
    const play = vi.fn(() => Promise.resolve());
    const pause = vi.fn();
    Object.defineProperties(preview, {
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_ENOUGH_DATA },
      play: { configurable: true, value: play },
      pause: { configurable: true, value: pause },
    });
    fireEvent.loadedData(preview);

    const timeline = screen.getByRole('region', { name: '时间轴' });
    fireEvent.keyDown(timeline, { key: 'l' });
    fireEvent.keyDown(timeline, { key: 'l' });
    await waitFor(() => expect(screen.getByText('2.0x')).toBeTruthy());
    expect(preview.playbackRate).toBe(2);

    fireEvent.keyDown(timeline, { key: 'k' });
    expect(screen.getByText('0.0x')).toBeTruthy();

    const playhead = screen.getByRole('slider', { name: '时间轴播放头' });
    fireEvent.keyDown(playhead, { key: 'ArrowDown' });
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBe(5);
    fireEvent.keyDown(playhead, { key: 'ArrowDown' });
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBe(10);
    expect(screen.getByRole('button', { name: 'J 反向播放' })).toBeTruthy();
    fireEvent.keyDown(playhead, { key: 'ArrowUp' });
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBe(5);
    fireEvent.keyDown(playhead, { key: 'ArrowUp' });
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: '下一帧' }));
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBeCloseTo(1 / 60);
    fireEvent.click(screen.getByRole('button', { name: '上一帧' }));
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBe(0);

    stepTimelineSeconds(playhead, 1);
    fireEvent.keyDown(timeline, { key: 'j' });
    await waitFor(() => expect(screen.getByText('-1.0x')).toBeTruthy());
    fireEvent.keyDown(timeline, { key: 'k' });
  });

  it('pans and zooms with H/Z tools and exposes smooth-scroll mode', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    renderWorkspace({ project: RECORDED_PROJECT });
    const viewport = await screen.findByRole('region', { name: '时间轴内容' });
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 600 },
    });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 1_000, bottom: 300, left: 0, width: 1_000, height: 300, toJSON: () => ({}),
    });
    const zoom = screen.getByRole('slider', { name: '时间轴缩放' }) as HTMLInputElement;
    fireEvent.change(zoom, { target: { value: '2' } });
    const grid = screen.getByRole('rowgroup', { name: '时间轴轨道网格' });

    fireEvent.click(screen.getByRole('button', { name: '手形工具 (H)' }));
    viewport.scrollLeft = 100;
    fireEvent.pointerDown(grid, { pointerId: 501, button: 0, clientX: 600, clientY: 150 });
    fireEvent.pointerMove(grid, { pointerId: 501, clientX: 500, clientY: 120 });
    fireEvent.pointerUp(grid, { pointerId: 501, clientX: 500, clientY: 120 });
    expect(viewport.scrollLeft).toBeGreaterThan(100);

    fireEvent.click(screen.getByRole('button', { name: '缩放工具 (Z)' }));
    const before = Number(zoom.value);
    fireEvent.pointerDown(grid, { pointerId: 502, button: 0, clientX: 600, clientY: 150 });
    expect(Number(zoom.value)).toBeGreaterThan(before);

    openDisplayCommands();
    fireEvent.click(screen.getByRole('menuitem', { name: '播放头居中连续滚动' }));
    openDisplayCommands();
    expect(screen.getByRole('menuitem', { name: /播放头居中连续滚动/u }).textContent).toContain('✓');
    clientWidth.mockRestore();
  });

  it('edits, switches and scrubs the playhead timecode', async () => {
    renderWorkspace({ project: RECORDED_PROJECT });
    const playhead = await screen.findByRole('slider', { name: '时间轴播放头' });
    const timecode = screen.getByRole('textbox', { name: '播放头时间码' });
    fireEvent.focus(timecode);
    fireEvent.change(timecode, { target: { value: '00:00:04:30' } });
    fireEvent.keyDown(timecode, { key: 'Enter' });
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBe(4.5);

    fireEvent.click(screen.getByRole('button', { name: '切换时间显示模式' }));
    const frames = screen.getByRole('textbox', { name: '播放头帧计数' });
    expect((frames as HTMLInputElement).value).toBe('270');
    fireEvent.focus(frames);
    fireEvent.change(frames, { target: { value: '120' } });
    fireEvent.keyDown(frames, { key: 'Enter' });
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBe(2);

    const scrub = screen.getByRole('slider', { name: '拖动播放头时间码' });
    fireEvent.pointerDown(scrub, { pointerId: 401, button: 0, clientX: 100 });
    fireEvent.pointerMove(scrub, { pointerId: 401, clientX: 140 });
    fireEvent.pointerUp(scrub, { pointerId: 401, clientX: 140 });
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBeCloseTo(2 + 10 / 60);
  });

  it('navigates target-track edits by default and every track with Shift', async () => {
    renderWorkspace({ project: navigationProject() });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    const playhead = screen.getByRole('slider', { name: '时间轴播放头' });
    fireEvent.click(screen.getByRole('button', { name: '下一个目标轨编辑点' }));
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBe(5);
    fireEvent.click(screen.getByRole('button', { name: '上一个目标轨编辑点' }));
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBe(0);
    fireEvent.keyDown(playhead, { key: 'ArrowDown', shiftKey: true });
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBe(2);
    fireEvent.keyDown(timeline, { key: ';', shiftKey: true });
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBe(5);
    fireEvent.keyDown(timeline, { key: ';', shiftKey: true, ctrlKey: true });
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBe(0);
  });

  it('matches the highest targeted Timeline frame to its source clip with F', async () => {
    renderWorkspace({ project: RECORDED_PROJECT });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    const playhead = screen.getByRole('slider', { name: '时间轴播放头' });
    const clipB = screen.getByRole('button', { name: /B 5\.0s · 已录制/u });
    stepTimelineSeconds(playhead, 6);
    fireEvent.keyDown(timeline, { key: 'f' });

    await waitFor(() => expect(clipB.className).toContain('ring-accent'));
    expect((screen.getByRole('slider', { name: '源素材播放头' }) as HTMLInputElement).value).toBe('2');
  });

  it('lets Space activate a focused Timeline button without also toggling transport', async () => {
    renderWorkspace();

    const trackSelect = await screen.findByRole('button', { name: '向前选择轨道工具 (A)' });
    trackSelect.focus();
    fireEvent.keyDown(trackSelect, { key: ' ' });

    expect(screen.getByRole('button', { name: '播放时间轴' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'K 暂停时间轴' })).toBeNull();
  });

  it('explains enabled and unavailable Timeline tools on hover or keyboard focus', async () => {
    renderWorkspace();

    const selection = await screen.findByRole('button', { name: '选择工具 (V)' });
    fireEvent.focus(selection);
    expect((await screen.findByRole('tooltip')).textContent).toContain('选择、移动和裁切时间轴片段');
    fireEvent.blur(selection);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());

    const slip = screen.getByRole('button', { name: '滑移工具 (Y)' }) as HTMLButtonElement;
    expect(slip.disabled).toBe(true);
    expect(slip.parentElement?.getAttribute('tabindex')).toBe('0');
    fireEvent.focus(slip.parentElement as HTMLElement);
    expect((await screen.findByRole('tooltip')).textContent).toContain('没有可滑移的未锁定媒体片段');
  });

  it('reveals paused navigation and page-scrolls playback while track heads stay sticky', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    renderWorkspace({
      project: RECORDED_PROJECT,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    await screen.findByLabelText('A 视频预览');
    const viewport = screen.getByRole('region', { name: '时间轴内容' });
    viewport.style.setProperty('--w-track-head', '200px');
    const timelineZoom = screen.getByRole('slider', { name: '时间轴缩放' }) as HTMLInputElement;
    fireEvent.change(timelineZoom, { target: { value: timelineZoom.max } });
    const playhead = screen.getByRole('slider', { name: '时间轴播放头' });
    fireEvent.keyDown(playhead, { key: 'ArrowDown' });
    fireEvent.keyDown(playhead, { key: 'ArrowDown' });
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBe(10);
    await waitFor(() => expect(viewport.scrollLeft).toBeGreaterThan(0));

    viewport.scrollLeft = 0;
    fireEvent.scroll(viewport);
    expect(viewport.scrollLeft).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: '播放时间轴' }));
    await waitFor(() => expect(viewport.scrollLeft).toBeGreaterThan(0));
    expect((screen.getByRole('row', { name: 'Story' }).firstElementChild as HTMLElement).className).toContain('sticky');
    const pause = screen.queryByRole('button', { name: 'K 暂停时间轴' });
    if (pause !== null) fireEvent.click(pause);
    clientWidth.mockRestore();
  });

  it('keeps the visible playhead anchored while zooming the Timeline', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: RECORDED_PROJECT, applyProjectPatch });

    const viewport = await screen.findByRole('region', { name: '时间轴内容' });
    viewport.style.setProperty('--w-track-head', '200px');
    const playhead = screen.getByRole('slider', { name: '时间轴播放头' });
    fireEvent.keyDown(playhead, { key: 'ArrowDown' });
    expect(Number(playhead.getAttribute('aria-valuenow'))).toBe(5);
    expect(viewport.scrollLeft).toBe(0);

    const timelineZoom = screen.getByRole('slider', { name: '时间轴缩放' }) as HTMLInputElement;
    fireEvent.change(timelineZoom, { target: { value: timelineZoom.max } });
    await waitFor(() => expect(viewport.scrollLeft).toBeGreaterThan(0));
    expect(playhead.parentElement?.style.left).toBe('calc(var(--w-track-head) + 500px)');
    expect(applyProjectPatch).not.toHaveBeenCalled();
    clientWidth.mockRestore();
  });

  it('uses Premiere-style wheel navigation and zooms around the pointer time', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    renderWorkspace({ project: RECORDED_PROJECT });

    const viewport = await screen.findByRole('region', { name: '时间轴内容' });
    viewport.style.setProperty('--w-track-head', '200px');
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 700 },
    });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 1_000, bottom: 300, left: 0, width: 1_000, height: 300, toJSON: () => ({}),
    });
    const zoom = screen.getByRole('slider', { name: '时间轴缩放' }) as HTMLInputElement;
    const beforePixelsPerSecond = Number(zoom.dataset.timelinePixelsPerSecond);
    const anchorViewportPx = 400;
    const anchorTime = anchorViewportPx / beforePixelsPerSecond;

    fireEvent.wheel(viewport, { altKey: true, clientX: 600, deltaY: -120, deltaMode: WheelEvent.DOM_DELTA_PIXEL });

    await waitFor(() => expect(Number(zoom.dataset.timelinePixelsPerSecond)).toBeGreaterThan(beforePixelsPerSecond));
    const afterPixelsPerSecond = Number(zoom.dataset.timelinePixelsPerSecond);
    expect(anchorTime * afterPixelsPerSecond - viewport.scrollLeft).toBeCloseTo(anchorViewportPx, 4);

    const zoomedScrollLeft = viewport.scrollLeft;
    fireEvent.wheel(viewport, { deltaY: 120, deltaMode: WheelEvent.DOM_DELTA_PIXEL });
    expect(viewport.scrollLeft).toBeGreaterThan(zoomedScrollLeft);

    const horizontalPosition = viewport.scrollLeft;
    fireEvent.wheel(viewport, { ctrlKey: true, deltaY: 80, deltaMode: WheelEvent.DOM_DELTA_PIXEL });
    expect(viewport.scrollLeft).toBe(horizontalPosition);
    expect(viewport.scrollTop).toBe(80);
    clientWidth.mockRestore();
  });

  it('consumes Ctrl-wheel at the vertical boundary without falling through to horizontal scrolling', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    renderWorkspace({ project: RECORDED_PROJECT });

    const viewport = await screen.findByRole('region', { name: '时间轴内容' });
    viewport.style.setProperty('--w-track-head', '200px');
    let verticalPosition = 400;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 700 },
      scrollTop: {
        configurable: true,
        get: () => verticalPosition,
        set: (value: number) => { verticalPosition = Math.min(400, Math.max(0, value)); },
      },
    });
    const zoom = screen.getByRole('slider', { name: '时间轴缩放' }) as HTMLInputElement;
    fireEvent.change(zoom, { target: { value: zoom.max } });
    viewport.scrollLeft = 120;
    fireEvent.scroll(viewport);

    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: 80,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    });
    const dispatched = screen.getByLabelText('时间轴标尺').dispatchEvent(wheel);

    expect(dispatched).toBe(false);
    expect(wheel.defaultPrevented).toBe(true);
    expect(viewport.scrollTop).toBe(400);
    expect(viewport.scrollLeft).toBe(120);
    clientWidth.mockRestore();
  });

  it('uses the Windows horizontal wheel mode while hovering the Timeline ruler', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    renderWorkspace({ project: RECORDED_PROJECT });

    const viewport = await screen.findByRole('region', { name: '时间轴内容' });
    viewport.style.setProperty('--w-track-head', '200px');
    const zoom = screen.getByRole('slider', { name: '时间轴缩放' }) as HTMLInputElement;
    fireEvent.change(zoom, { target: { value: zoom.max } });
    const ruler = screen.getByLabelText('时间轴标尺');
    fireEvent.wheel(ruler, { deltaY: 120, deltaMode: WheelEvent.DOM_DELTA_PIXEL });

    expect(viewport.scrollLeft).toBe(120);
    clientWidth.mockRestore();
  });

  it('supports Premiere page navigation and fit shortcuts without editing the project', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: RECORDED_PROJECT, applyProjectPatch });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    const viewport = screen.getByRole('region', { name: '时间轴内容' });
    viewport.style.setProperty('--w-track-head', '200px');
    const zoom = screen.getByRole('slider', { name: '时间轴缩放' }) as HTMLInputElement;
    fireEvent.change(zoom, { target: { value: zoom.max } });
    await waitFor(() => expect(Number(zoom.value)).toBeCloseTo(Number(zoom.max)));

    fireEvent.keyDown(timeline, { key: 'PageDown' });
    expect(viewport.scrollLeft).toBe(800);
    fireEvent.keyDown(timeline, { key: 'PageUp' });
    expect(viewport.scrollLeft).toBe(0);
    fireEvent.keyDown(timeline, { key: '\\' });
    await waitFor(() => expect(Number(zoom.value)).toBe(0));
    expect(viewport.scrollLeft).toBe(0);
    expect(applyProjectPatch).not.toHaveBeenCalled();
    clientWidth.mockRestore();
  });

  it('pans and resizes the visible range from the Premiere-style zoom navigator', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    renderWorkspace({ project: RECORDED_PROJECT });

    const viewport = await screen.findByRole('region', { name: '时间轴内容' });
    viewport.style.setProperty('--w-track-head', '200px');
    const zoom = screen.getByRole('slider', { name: '时间轴缩放' }) as HTMLInputElement;
    fireEvent.change(zoom, { target: { value: zoom.max } });
    const navigator = screen.getByRole('scrollbar', { name: '时间轴可视范围' });
    vi.spyOn(navigator, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 112, bottom: 12, left: 0, width: 112, height: 12, toJSON: () => ({}),
    });
    const thumb = navigator.firstElementChild as HTMLElement;
    fireEvent.pointerDown(thumb, { pointerId: 91, button: 0, clientX: 10 });
    fireEvent.pointerMove(navigator, { pointerId: 91, clientX: 45 });
    expect(viewport.scrollLeft).toBeGreaterThan(0);
    fireEvent.pointerUp(navigator, { pointerId: 91, clientX: 45 });

    const beforeResize = Number(zoom.value);
    const endHandle = screen.getByRole('separator', { name: '调整时间轴可视范围终点' });
    fireEvent.pointerDown(endHandle, { pointerId: 92, button: 0, clientX: 45 });
    fireEvent.pointerMove(navigator, { pointerId: 92, clientX: 75 });
    await waitFor(() => expect(Number(zoom.value)).toBeLessThan(beforeResize));
    fireEvent.pointerUp(navigator, { pointerId: 92, clientX: 75 });

    const beforeWheel = Number(zoom.value);
    fireEvent.wheel(navigator, { deltaY: -120, deltaMode: WheelEvent.DOM_DELTA_PIXEL });
    await waitFor(() => expect(Number(zoom.value)).toBeGreaterThan(beforeWheel));
    clientWidth.mockRestore();
  });

  it('reaches the design-system frame-level zoom on a three-minute Timeline', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const applyProjectPatch = vi.fn();
    const longClip = {
      ...clip(CLIP_A, 'Long take'),
      placement: {
        ...clip(CLIP_A, 'Long take').placement,
        duration: 180,
        source_out: 180,
      },
    };
    const longProject: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        duration_seconds: 180,
        tracks: PROJECT.document.tracks.map((track) => track.id === STORY_ID
          ? { ...track, clips: [longClip] }
          : track),
      },
    };
    renderWorkspace({ project: longProject, applyProjectPatch });

    const zoom = await screen.findByRole('slider', { name: '时间轴缩放' }) as HTMLInputElement;
    expect(zoom.step).toBe('any');
    fireEvent.change(zoom, { target: { value: zoom.max } });
    const timelineClip = document.querySelector<HTMLElement>(`[data-timeline-clip-id="${CLIP_A}"]`);
    await waitFor(() => expect(Number.parseFloat(timelineClip?.style.width ?? '0')).toBeCloseTo(138_240));
    expect(zoom.getAttribute('aria-valuetext')).toContain('12.80');
    expect(applyProjectPatch).not.toHaveBeenCalled();
    clientWidth.mockRestore();
  });

  it('frame-snaps edits made from a continuous playback position', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({
      project: RECORDED_PROJECT,
      applyProjectPatch,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const preview = await screen.findByLabelText('A 视频预览') as HTMLVideoElement;
    Object.defineProperties(preview, {
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_ENOUGH_DATA },
      currentTime: { configurable: true, writable: true, value: 1.007 },
      play: { configurable: true, value: vi.fn(() => Promise.resolve()) },
      pause: { configurable: true, value: vi.fn() },
    });
    fireEvent.loadedData(preview);
    fireEvent.click(screen.getByRole('button', { name: '播放时间轴' }));
    preview.currentTime = 1.007;
    fireEvent.timeUpdate(preview);
    runMarkerCommand('在播放头添加标记');

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_markers',
        markers: [expect.objectContaining({ time: 1 })],
      }],
    })));
  });

  it('shows the whole editing document without mode-switch chrome', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    expect(await screen.findByRole('row', { name: 'Story' })).toBeTruthy();
    expect(screen.getByRole('row', { name: 'Music' })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: '快速剪辑' })).toBeNull();
    expect(screen.queryByRole('radio', { name: '多轨精剪' })).toBeNull();
    expect(screen.getByRole('button', { name: '录制缺失片段' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '导出成片' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Agent' })).toBeNull();
    expect(screen.queryByRole('button', { name: '阻塞显示' })).toBeNull();
    expect(screen.queryByRole('button', { name: '时间轴设置' })).toBeNull();
    expect(screen.queryByRole('button', { name: '网格视图' })).toBeNull();
    expect(screen.queryByRole('button', { name: '列表视图' })).toBeNull();
    const trackGrid = screen.getByRole('rowgroup', { name: '时间轴轨道网格' });
    expect(trackGrid.style.gridTemplateRows).toBe('84px 64px 64px 44px 44px');
    expect(screen.getByRole('region', { name: '时间轴内容' }).className).toContain('overflow-y-auto');
    expect(applyProjectPatch).not.toHaveBeenCalled();
  });

  it('collapses and pointer-resizes independent timeline rows', async () => {
    renderWorkspace();

    const grid = await screen.findByRole('rowgroup', { name: '时间轴轨道网格' });
    fireEvent.click(screen.getByRole('button', { name: '折叠轨道 Music' }));
    await waitFor(() => expect(grid.style.gridTemplateRows).toBe('84px 64px 32px 44px 44px'));
    fireEvent.click(screen.getByRole('button', { name: '展开轨道 Music' }));

    const resize = screen.getByRole('separator', { name: '调整轨道高度 Music' });
    fireEvent.pointerDown(resize, { pointerId: 51, button: 0, clientY: 100 });
    fireEvent.pointerMove(resize, { pointerId: 51, clientY: 140 });
    fireEvent.pointerUp(resize, { pointerId: 51, clientY: 140 });
    await waitFor(() => {
      expect(resize.getAttribute('aria-valuenow')).toBe('104');
      expect(grid.style.gridTemplateRows).toBe('84px 64px 104px 44px 44px');
    });
  });

  it('uses Shift range selection and target-track select-all without moving clips', async () => {
    renderWorkspace({ project: targetedRangeProject() });

    const clipA = await screen.findByRole('button', { name: /A 5\.0s · 未录制/u });
    const clipB = screen.getByRole('button', { name: /B 5\.0s · 已录制/u });
    fireEvent.pointerDown(clipB, { pointerId: 52, button: 0, shiftKey: true, clientX: 400 });
    await waitFor(() => {
      expect(clipA.className).toContain('ring-accent');
      expect(clipB.className).toContain('ring-accent');
    });
    expect(clipB.hasPointerCapture(52)).toBe(false);

    fireEvent.pointerDown(clipA, { pointerId: 53, button: 0, clientX: 200 });
    fireEvent.pointerUp(clipA, { pointerId: 53, clientX: 200 });
    fireEvent.click(screen.getByRole('button', { name: '设为目标轨道 Music' }));
    fireEvent.keyDown(screen.getByRole('region', { name: '时间轴' }), { key: 'a', ctrlKey: true });
    const audio = screen.getByRole('button', { name: /Range audio 10\.0s · 已录制/u });
    await waitFor(() => {
      expect(clipA.className).toContain('ring-accent');
      expect(clipB.className).toContain('ring-accent');
      expect(audio.className).toContain('ring-accent');
    });
  });

  it('clears the Timeline selection with the Premiere Ctrl+Shift+A shortcut', async () => {
    renderWorkspace();

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    const clipA = screen.getByRole('button', { name: /A 5\.0s · 未录制/u });
    expect(clipA.className).toContain('ring-accent');
    fireEvent.keyDown(timeline, { key: 'a', ctrlKey: true, shiftKey: true });
    expect(clipA.className).not.toContain('ring-accent');
  });

  it('toggles selected clip output with the Premiere Shift+E shortcut', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    fireEvent.keyDown(timeline, { key: 'e', shiftKey: true });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ enabled: false }) }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ enabled: true }) }),
        ],
      })],
    })));
  });

  it('uses Track Select Forward for one track and Shift-click for all tracks', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    renderWorkspace({ project: targetedRangeProject() });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    fireEvent.keyDown(timeline, { key: 'a' });
    expect(screen.getByRole('button', { name: '向前选择轨道工具 (A)' }).getAttribute('aria-pressed')).toBe('true');
    const clipA = screen.getByRole('button', { name: /A 5\.0s · 未录制/u });
    const clipB = screen.getByRole('button', { name: /B 5\.0s · 已录制/u });
    const audio = screen.getByRole('button', { name: /Range audio 10\.0s · 已录制/u });
    vi.spyOn(clipB, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 500, bottom: 84, left: 0, width: 500, height: 84, toJSON: () => ({}),
    });
    fireEvent.pointerDown(clipB, { pointerId: 122, button: 0, clientX: 200 });
    await waitFor(() => {
      expect(clipA.className).not.toContain('ring-accent');
      expect(clipB.className).toContain('ring-accent');
      expect(audio.className).not.toContain('ring-accent');
    });

    fireEvent.pointerDown(clipB, { pointerId: 123, button: 0, clientX: 200, shiftKey: true });
    await waitFor(() => {
      expect(clipB.className).toContain('ring-accent');
      expect(audio.className).toContain('ring-accent');
    });
    clientWidth.mockRestore();
  });

  it('uses Track Select Backward to select the clicked clip and earlier clips', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    renderWorkspace();

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    fireEvent.keyDown(timeline, { key: 'A', shiftKey: true });
    expect(screen.getByRole('button', { name: '向后选择轨道工具 (Shift+A)' }).getAttribute('aria-pressed')).toBe('true');
    const clipA = screen.getByRole('button', { name: /A 5\.0s · 未录制/u });
    const clipB = screen.getByRole('button', { name: /B 5\.0s · 已录制/u });
    vi.spyOn(clipB, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 500, bottom: 84, left: 0, width: 500, height: 84, toJSON: () => ({}),
    });
    fireEvent.pointerDown(clipB, { pointerId: 124, button: 0, clientX: 200 });
    await waitFor(() => {
      expect(clipA.className).toContain('ring-accent');
      expect(clipB.className).toContain('ring-accent');
    });
    clientWidth.mockRestore();
  });

  it('expands linked selection and atomically unlinks the selected clips', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: linkedProject(), applyProjectPatch });

    const story = await screen.findByRole('button', { name: /A 5\.0s · 未录制/u });
    const audio = screen.getByRole('button', { name: /Bed 5\.0s · 已录制/u });
    await waitFor(() => {
      expect(story.className).toContain('ring-accent');
      expect(audio.className).toContain('ring-accent');
    });
    fireEvent.pointerDown(audio, { pointerId: 94, button: 0, clientX: 300 });
    fireEvent.pointerUp(audio, { pointerId: 94, clientX: 300 });
    fireEvent.click(audio, { detail: 1 });
    expect(screen.getByRole('separator', { name: '裁切片段起点' }).closest('button')).toBe(audio);
    fireEvent.pointerDown(story, { pointerId: 95, button: 0, clientX: 200 });
    fireEvent.pointerUp(story, { pointerId: 95, clientX: 200 });
    fireEvent.click(story, { detail: 1 });
    expect(screen.getByRole('separator', { name: '裁切片段起点' }).closest('button')).toBe(story);
    expect(screen.getByRole('button', { name: '切换链接选择' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '取消链接所选片段' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'project' },
      operations: [
        expect.objectContaining({ op: 'replace_clip', clip_id: CLIP_A, clip: expect.objectContaining({ link_group_id: null }) }),
        expect.objectContaining({ op: 'replace_clip', clip_id: LINKED_AUDIO_CLIP_ID, clip: expect.objectContaining({ link_group_id: null }) }),
      ],
    })));
    expect(applyProjectPatch).toHaveBeenCalledTimes(1);
  });

  it('groups selected clips independently from Linked Selection', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    const clipB = screen.getByRole('button', { name: /B 5\.0s · 已录制/u });
    fireEvent.pointerDown(clipB, { pointerId: 208, button: 0, ctrlKey: true, clientX: 400 });
    fireEvent.keyDown(timeline, { key: 'g', ctrlKey: true });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalled());
    const operations = (applyProjectPatch.mock.calls[0]?.[0] as ProjectPatch).operations;
    expect(operations).toHaveLength(2);
    expect(operations.every((operation) => operation.op === 'replace_clip' && operation.clip.group_id !== null)).toBe(true);
    const groupIds = operations.flatMap((operation) => operation.op === 'replace_clip' ? [operation.clip.group_id] : []);
    expect(new Set(groupIds).size).toBe(1);
  });

  it('always expands Group selection and ungroups it with Ctrl+Shift+G', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: groupedProject(), applyProjectPatch });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    const clipA = screen.getByRole('button', { name: /A 5\.0s · 未录制/u });
    const clipB = screen.getByRole('button', { name: /B 5\.0s · 已录制/u });
    expect(clipA.className).toContain('ring-accent');
    expect(clipB.className).toContain('ring-accent');
    fireEvent.click(screen.getByRole('button', { name: '切换链接选择' }));
    fireEvent.click(clipA);
    expect(clipB.className).toContain('ring-accent');
    fireEvent.keyDown(timeline, { key: 'g', ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [
        expect.objectContaining({ op: 'replace_clip', clip: expect.objectContaining({ group_id: null }) }),
        expect.objectContaining({ op: 'replace_clip', clip: expect.objectContaining({ group_id: null }) }),
      ],
    })));
  });

  it('shows unlinked AV drift in frames and restores the selected side', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: outOfSyncProject(), applyProjectPatch });

    const restore = await screen.findByRole('button', { name: '恢复同步 Detached video +2 帧' });
    expect(screen.getByRole('button', { name: '恢复同步 Detached audio -2 帧' })).toBeTruthy();
    fireEvent.click(restore);

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_clip',
        clip_id: '00000000-0000-4000-8000-000000000172',
        clip: expect.objectContaining({ placement: expect.objectContaining({ start: 2 }) }),
      })],
    })));
  });

  it('moves a linked cross-track selection in one Project Patch', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: linkedProject(), applyProjectPatch });

    const story = await screen.findByRole('button', { name: /A 5\.0s · 未录制/u });
    await waitFor(() => expect(screen.getByRole('button', { name: /Bed 5\.0s · 已录制/u }).className).toContain('ring-accent'));
    fireEvent.pointerDown(story, { pointerId: 91, button: 0, clientX: 200 });
    fireEvent.pointerMove(story, { pointerId: 91, clientX: 600 });
    fireEvent.pointerUp(story, { pointerId: 91, clientX: 600 });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'project' },
      operations: [
        expect.objectContaining({
          op: 'replace_track_clips',
          track_id: STORY_ID,
          clips: [
            expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 0 }) }),
            expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ start: 5 }) }),
          ],
        }),
        expect.objectContaining({
          op: 'replace_track_clips',
          track_id: '00000000-0000-4000-8000-000000000013',
          clips: [expect.objectContaining({ id: LINKED_AUDIO_CLIP_ID, placement: expect.objectContaining({ start: expect.any(Number) }) })],
        }),
      ],
    })));
    expect(applyProjectPatch).toHaveBeenCalledTimes(1);
    const audioOperation = applyProjectPatch.mock.calls[0]?.[0]?.operations[1];
    if (audioOperation?.op !== 'replace_track_clips') throw new Error('expected linked audio replacement');
    expect(audioOperation.clips[0]?.placement.start).toBeGreaterThan(12);
    clientWidth.mockRestore();
  });

  it('moves a free video clip vertically to a compatible track with overwrite', async () => {
    const applyProjectPatch = vi.fn();
    const elementFromPoint = vi.fn<() => Element | null>();
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: elementFromPoint });
    renderWorkspace({ project: crossTrackProject(), applyProjectPatch });

    const moving = await screen.findByRole('button', { name: /Move me 2\.0s · 未录制/u });
    const viewport = screen.getByRole('region', { name: '时间轴内容' });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 1_000, bottom: 700, left: 0, width: 1_000, height: 700, toJSON: () => ({}),
    });
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 1_000 });
    fireEvent.click(moving);
    fireEvent.pointerDown(moving, { pointerId: 202, button: 0, clientX: 500, clientY: 300 });
    const targetRow = screen.getByRole('row', { name: 'Target V3' });
    elementFromPoint.mockReturnValue(targetRow);
    fireEvent.pointerMove(moving, { pointerId: 202, clientX: 500, clientY: 500, shiftKey: true });
    expect(targetRow.className).toContain('ring-accent');
    fireEvent.pointerUp(moving, { pointerId: 202, clientX: 500, clientY: 500, shiftKey: true });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'project' },
      operations: [
        { op: 'replace_track_clips', track_id: '00000000-0000-4000-8000-000000000160', clips: [] },
        expect.objectContaining({
          op: 'replace_track_clips',
          track_id: '00000000-0000-4000-8000-000000000162',
          clips: [
            expect.objectContaining({ id: '00000000-0000-4000-8000-000000000163', placement: expect.objectContaining({ start: 0, duration: 2 }) }),
            expect.objectContaining({ id: '00000000-0000-4000-8000-000000000161', placement: expect.objectContaining({ start: 2, duration: 2 }) }),
            expect.objectContaining({ placement: expect.objectContaining({ start: 4, duration: 6 }) }),
          ],
        }),
      ],
    })));
    Reflect.deleteProperty(document, 'elementFromPoint');
  });

  it('rejects a vertical move onto a locked track without committing', async () => {
    const applyProjectPatch = vi.fn();
    const project = crossTrackProject();
    const lockedProject: Project = {
      ...project,
      document: {
        ...project.document,
        tracks: project.document.tracks.map((track) => track.name === 'Target V3' ? { ...track, locked: true } : track),
      },
    };
    const elementFromPoint = vi.fn<() => Element | null>();
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: elementFromPoint });
    renderWorkspace({ project: lockedProject, applyProjectPatch });

    const moving = await screen.findByRole('button', { name: /Move me 2\.0s · 未录制/u });
    fireEvent.click(moving);
    fireEvent.pointerDown(moving, { pointerId: 203, button: 0, clientX: 500, clientY: 300 });
    const targetRow = screen.getByRole('row', { name: 'Target V3' });
    elementFromPoint.mockReturnValue(targetRow);
    fireEvent.pointerMove(moving, { pointerId: 203, clientX: 500, clientY: 500, shiftKey: true });
    expect(targetRow.className).not.toContain('ring-accent');
    fireEvent.pointerUp(moving, { pointerId: 203, clientX: 500, clientY: 500, shiftKey: true });
    expect(applyProjectPatch).not.toHaveBeenCalled();
  });

  it('splits Story video and derived audio when moving a compound clip to a free track', async () => {
    const applyProjectPatch = vi.fn();
    const elementFromPoint = vi.fn<() => Element | null>();
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: elementFromPoint });
    renderWorkspace({ project: crossTrackProject(), applyProjectPatch });

    const moving = await screen.findByRole('button', { name: /A 5\.0s · 未录制/u });
    fireEvent.pointerDown(moving, { pointerId: 204, button: 0, clientX: 500, clientY: 200 });
    const targetRow = screen.getByRole('row', { name: 'Target V3' });
    elementFromPoint.mockReturnValue(targetRow);
    fireEvent.pointerMove(moving, { pointerId: 204, clientX: 500, clientY: 500, shiftKey: true });
    expect(targetRow.className).toContain('ring-accent');
    fireEvent.pointerUp(moving, { pointerId: 204, clientX: 500, clientY: 500, shiftKey: true });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalled());
    const patch = applyProjectPatch.mock.calls[0]?.[0] as ProjectPatch;
    const story = patch.operations.find((operation) => operation.op === 'replace_track_clips' && operation.track_id === STORY_ID);
    const video = patch.operations.find((operation) => operation.op === 'replace_track_clips' && operation.track_id === '00000000-0000-4000-8000-000000000162');
    const audio = patch.operations.find((operation) => operation.op === 'replace_track_clips' && operation.track_id === '00000000-0000-4000-8000-000000000013');
    expect(story).toEqual(expect.objectContaining({ clips: [expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 0 }) })] }));
    const movedVideo = video?.op === 'replace_track_clips' ? video.clips.find((clip) => clip.id === CLIP_A) : null;
    const movedAudio = audio?.op === 'replace_track_clips' ? audio.clips.find((clip) => clip.link_group_id === movedVideo?.link_group_id) : null;
    expect(movedVideo).toEqual(expect.objectContaining({ placement: expect.objectContaining({ start: 0, volume: 0 }) }));
    expect(movedAudio).toEqual(expect.objectContaining({ placement: expect.objectContaining({ start: 0, volume: 1 }) }));
    expect(movedVideo?.link_group_id).toBeTruthy();
  });

  it('recombines linked free video and audio when moving into Story', async () => {
    const applyProjectPatch = vi.fn();
    const base = crossTrackProject();
    const linkedProject: Project = {
      ...base,
      document: {
        ...base.document,
        tracks: base.document.tracks.map((track) => {
          if (track.name === 'Source V2') return {
            ...track,
            clips: track.clips.map((clip) => ({ ...clip, link_group_id: 'cross-link', placement: { ...clip.placement, volume: 0 } })),
          };
          if (track.kind === 'audio') return {
            ...track,
            clips: [{
              ...clip('00000000-0000-4000-8000-000000000164', 'Move me audio'),
              link_group_id: 'cross-link',
              placement: { start: 2, duration: 2, source_in: 0, source_out: 2, speed: 1, reverse: false, frame_hold_source_time: null, volume: 0.8, pan: 0, enabled: true },
            }],
          };
          return track;
        }),
      },
    };
    const elementFromPoint = vi.fn<() => Element | null>();
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: elementFromPoint });
    renderWorkspace({ project: linkedProject, applyProjectPatch });

    const moving = await screen.findByRole('button', { name: /Move me 2\.0s · 未录制/u });
    fireEvent.click(moving);
    fireEvent.pointerDown(moving, { pointerId: 205, button: 0, clientX: 500, clientY: 400 });
    const storyRow = screen.getByRole('row', { name: 'Story' });
    elementFromPoint.mockReturnValue(storyRow);
    fireEvent.pointerMove(moving, { pointerId: 205, clientX: 500, clientY: 200, shiftKey: true });
    fireEvent.pointerUp(moving, { pointerId: 205, clientX: 500, clientY: 200, shiftKey: true });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalled());
    const patch = applyProjectPatch.mock.calls[0]?.[0] as ProjectPatch;
    const story = patch.operations.find((operation) => operation.op === 'replace_track_clips' && operation.track_id === STORY_ID);
    const source = patch.operations.find((operation) => operation.op === 'replace_track_clips' && operation.track_id === '00000000-0000-4000-8000-000000000160');
    const audio = patch.operations.find((operation) => operation.op === 'replace_track_clips' && operation.track_id === '00000000-0000-4000-8000-000000000013');
    expect(source).toEqual(expect.objectContaining({ clips: [] }));
    expect(audio).toEqual(expect.objectContaining({ clips: [] }));
    expect(story?.op === 'replace_track_clips' ? story.clips.find((clip) => clip.id === '00000000-0000-4000-8000-000000000161') : null).toEqual(expect.objectContaining({
      link_group_id: null,
      placement: expect.objectContaining({ start: 2, volume: 0.8 }),
    }));
  });

  it('keeps a locked linked track visible in selection but out of a cross-track move', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const project = linkedProject();
    const locked: Project = {
      ...project,
      document: {
        ...project.document,
        tracks: project.document.tracks.map((track) => track.kind === 'audio'
          ? { ...track, locked: true }
          : track),
      },
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: locked, applyProjectPatch });

    const story = await screen.findByRole('button', { name: /A 5\.0s · 未录制/u });
    const audio = screen.getByRole('button', { name: /Bed 5\.0s · 已录制/u });
    await waitFor(() => expect(audio.className).toContain('ring-accent'));
    fireEvent.pointerDown(story, { pointerId: 117, button: 0, clientX: 200 });
    fireEvent.pointerMove(story, { pointerId: 117, clientX: 600 });
    fireEvent.pointerUp(story, { pointerId: 117, clientX: 600 });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'track', track_id: STORY_ID },
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
      })],
    })));
    const operations = applyProjectPatch.mock.calls[0]?.[0]?.operations ?? [];
    expect(operations.some((operation: ProjectPatch['operations'][number]) => (
      operation.op === 'replace_track_clips'
      && operation.track_id === '00000000-0000-4000-8000-000000000013'
    ))).toBe(false);
    clientWidth.mockRestore();
  });

  it('rebuilds a new cross-track link group when pasting linked clips', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: linkedProject(), applyProjectPatch });

    await screen.findByRole('button', { name: '剪辑操作' });
    runTimelineCommand('复制所选片段');
    fireEvent.click(screen.getByRole('button', { name: '设为目标轨道 Music' }));
    runTimelineCommand('在播放头粘贴覆盖');

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledTimes(1));
    const operations = applyProjectPatch.mock.calls[0]?.[0]?.operations ?? [];
    const storyOperation = operations.find((operation: ProjectPatch['operations'][number]) => (
      operation.op === 'replace_track_clips' && operation.track_id === STORY_ID
    ));
    const audioOperation = operations.find((operation: ProjectPatch['operations'][number]) => (
      operation.op === 'replace_track_clips' && operation.track_id === '00000000-0000-4000-8000-000000000013'
    ));
    if (storyOperation?.op !== 'replace_track_clips' || audioOperation?.op !== 'replace_track_clips') {
      throw new Error('expected linked track replacements');
    }
    const storyCopy = storyOperation.clips.find((candidate: TimelineClip) => ![CLIP_A, CLIP_B].includes(candidate.id));
    const audioCopy = audioOperation.clips.find((candidate: TimelineClip) => candidate.id !== LINKED_AUDIO_CLIP_ID);
    expect(storyCopy?.link_group_id).not.toBeNull();
    expect(storyCopy?.link_group_id).not.toBe(LINK_GROUP_ID);
    expect(audioCopy?.link_group_id).toBe(storyCopy?.link_group_id);
    expect(storyCopy?.placement.start).toBe(0);
    expect(audioCopy?.placement.start).toBe(12);
  });

  it('trims linked clips across Story and free tracks with one constrained delta', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: linkedProject(), applyProjectPatch });

    await waitFor(() => expect(screen.getByRole('button', { name: /Bed 5\.0s · 已录制/u }).className).toContain('ring-accent'));
    const startHandle = screen.getByRole('separator', { name: '裁切片段起点' });
    fireEvent.pointerDown(startHandle, { pointerId: 93, button: 0, clientX: 200 });
    fireEvent.pointerMove(startHandle, { pointerId: 93, clientX: 250 });
    fireEvent.pointerUp(startHandle, { pointerId: 93, clientX: 250 });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledTimes(1));
    const operations = applyProjectPatch.mock.calls[0]?.[0]?.operations;
    expect(operations).toHaveLength(2);
    const storyOperation = operations?.[0];
    const audioOperation = operations?.[1];
    if (storyOperation?.op !== 'replace_track_clips' || audioOperation?.op !== 'replace_track_clips') {
      throw new Error('expected linked track replacements');
    }
    expect(storyOperation.track_id).toBe(STORY_ID);
    expect(storyOperation.clips[0]?.placement).toEqual(expect.objectContaining({ start: 0, source_in: expect.any(Number) }));
    expect(storyOperation.clips[0]?.placement.source_in).toBeGreaterThan(0);
    expect(storyOperation.clips[1]?.placement.start).toBeLessThan(5);
    expect(audioOperation.track_id).toBe('00000000-0000-4000-8000-000000000013');
    expect(audioOperation.clips[0]?.placement.start).toBeGreaterThan(12);
    expect(audioOperation.clips[0]?.placement.source_in).toBeGreaterThan(0);
    clientWidth.mockRestore();
  });

  it('previews a Slip edit without moving the clip and commits once on release', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const applyProjectPatch = vi.fn();
    renderWorkspace({
      project: RECORDED_PROJECT,
      applyProjectPatch,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const clipB = await screen.findByRole('button', { name: /B 5\.0s · 已录制/u });
    fireEvent.click(clipB);
    fireEvent.keyDown(screen.getByRole('slider', { name: '时间轴播放头' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('button', { name: '滑移工具 (Y)' }));
    expect(screen.getByRole('button', { name: '滑移工具 (Y)' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('separator', { name: '裁切片段起点' })).toBeNull();

    const preview = await screen.findByLabelText('B 视频预览') as HTMLVideoElement;
    expect(Number(preview.dataset.previewSourceTime)).toBeCloseTo(1);
    fireEvent.pointerDown(clipB, { pointerId: 111, button: 0, clientX: 400 });
    fireEvent.pointerMove(clipB, { pointerId: 111, clientX: 500 });

    await waitFor(() => {
      expect(Number(clipB.dataset.sourceIn)).toBeCloseTo(0);
      expect(Number(clipB.dataset.sourceOut)).toBeCloseTo(5);
      expect(Number(preview.dataset.previewSourceTime)).toBeCloseTo(0);
    });
    expect(clipB.style.left).toBe('500px');
    expect(clipB.style.width).toBe('500px');
    expect(applyProjectPatch).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: '视频预览' }).querySelectorAll('video')).toHaveLength(4);

    fireEvent.pointerUp(clipB, { pointerId: 111, clientX: 500 });
    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_clip',
        clip_id: CLIP_B,
        clip: expect.objectContaining({
          placement: expect.objectContaining({ start: 5, duration: 5, source_in: 0, source_out: 5 }),
        }),
      })],
    })));
    expect(applyProjectPatch).toHaveBeenCalledTimes(1);
    clientWidth.mockRestore();
  });

  it('slips a linked cross-track selection by one shared constrained delta', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const applyProjectPatch = vi.fn();
    const base = linkedProject();
    const project: Project = {
      ...base,
      document: {
        ...base.document,
        tracks: base.document.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((candidate) => candidate.id === CLIP_A
            ? {
                ...candidate,
                material: { kind: 'asset', asset_id: 'story-source', media_duration_seconds: 10 },
                placement: { ...candidate.placement, source_in: 1, source_out: 6 },
              }
            : candidate.id === LINKED_AUDIO_CLIP_ID
              ? { ...candidate, placement: { ...candidate.placement, source_in: 0.5, source_out: 5.5 } }
              : candidate),
        })),
      },
    };
    renderWorkspace({ project, applyProjectPatch });

    const story = await screen.findByRole('button', { name: /A 5\.0s · 已录制/u });
    await waitFor(() => expect(screen.getByRole('button', { name: /Bed 5\.0s · 已录制/u }).className).toContain('ring-accent'));
    fireEvent.keyDown(screen.getByRole('region', { name: '时间轴' }), { key: 'y' });
    fireEvent.pointerDown(story, { pointerId: 112, button: 0, clientX: 400 });
    fireEvent.pointerMove(story, { pointerId: 112, clientX: 700 });
    expect(applyProjectPatch).not.toHaveBeenCalled();
    fireEvent.pointerUp(story, { pointerId: 112, clientX: 700 });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledTimes(1));
    const operations = applyProjectPatch.mock.calls[0]?.[0]?.operations;
    expect(operations).toHaveLength(2);
    const storyOperation = operations?.find((operation: { track_id?: string }) => operation.track_id === STORY_ID);
    const audioOperation = operations?.find((operation: { track_id?: string }) => operation.track_id === '00000000-0000-4000-8000-000000000013');
    if (storyOperation?.op !== 'replace_track_clips' || audioOperation?.op !== 'replace_track_clips') {
      throw new Error('expected linked Slip track replacements');
    }
    expect(storyOperation.clips.find((candidate: TimelineClip) => candidate.id === CLIP_A)?.placement).toEqual(expect.objectContaining({
      start: 0,
      duration: 5,
      source_in: 0.5,
      source_out: 5.5,
    }));
    expect(audioOperation.clips[0]?.placement).toEqual(expect.objectContaining({
      start: 12,
      duration: 5,
      source_in: 0,
      source_out: 5,
    }));
    clientWidth.mockRestore();
  });

  it('previews and commits one atomic rolling edit at an adjacent cut', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const applyProjectPatch = vi.fn();
    renderWorkspace({
      project: RECORDED_PROJECT,
      applyProjectPatch,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    fireEvent.keyDown(timeline, { key: 'n' });
    expect(screen.getByRole('button', { name: '滚动编辑工具 (N)' }).getAttribute('aria-pressed')).toBe('true');
    const handle = screen.getByRole('separator', { name: '滚动编辑 A / B' });
    fireEvent.pointerDown(handle, { pointerId: 113, button: 0, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 113, clientX: 450 });

    const clipA = screen.getByRole('button', { name: /A 4\.5s · 已录制/u });
    const clipB = screen.getByRole('button', { name: /B 5\.5s · 已录制/u });
    expect(clipA.style.left).toBe('0px');
    expect(clipA.style.width).toBe('450px');
    expect(clipB.style.left).toBe('450px');
    expect(clipB.style.width).toBe('550px');
    expect(Number(clipA.dataset.sourceOut)).toBeCloseTo(4.5);
    expect(Number(clipB.dataset.sourceIn)).toBeCloseTo(0.5);
    expect(Number(screen.getByRole('slider', { name: '时间轴播放头' }).getAttribute('aria-valuenow'))).toBeCloseTo(4.5);
    expect(applyProjectPatch).not.toHaveBeenCalled();

    const monitor = screen.getByRole('region', { name: '视频预览' });
    expect(monitor.dataset.monitorMode).toBe('rolling');
    const targetVideos = [...monitor.querySelectorAll<HTMLVideoElement>('video[data-preview-target="true"]')];
    expect(targetVideos).toHaveLength(2);
    targetVideos.forEach((video) => {
      Object.defineProperty(video, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_ENOUGH_DATA });
      fireEvent.loadedData(video);
      video.currentTime = Number(video.dataset.previewSourceTime);
      fireEvent.seeked(video);
    });
    await waitFor(() => expect(targetVideos.map((video) => video.dataset.previewSide).sort()).toEqual(['left', 'right']));
    expect(targetVideos.map((video) => video.closest<HTMLElement>('[data-preview-slot]')?.dataset.previewSlot).sort()).toEqual(['left', 'right']);
    expect(targetVideos.every((video) => video.closest('[data-preview-slot]')?.className.includes('overflow-hidden'))).toBe(true);
    expect(monitor.querySelectorAll('video')).toHaveLength(4);

    fireEvent.pointerUp(handle, { pointerId: 113, clientX: 450 });
    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ start: 0, duration: 4.5, source_in: 0, source_out: 4.5 }) }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 4.5, duration: 5.5, source_in: 0.5, source_out: 6 }) }),
        ],
      })],
    })));
    expect(applyProjectPatch).toHaveBeenCalledTimes(1);
    expect(Number(screen.getByRole('slider', { name: '时间轴播放头' }).getAttribute('aria-valuenow'))).toBeCloseTo(4.5);
    clientWidth.mockRestore();
  });

  it('enters Trim Mode with Shift+T and rolls the selected cut by frames', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: RECORDED_PROJECT, applyProjectPatch });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    fireEvent.keyDown(timeline, { key: 'T', shiftKey: true });
    expect(screen.getByRole('status').textContent).toContain('修剪模式');
    expect(screen.getByRole('status').textContent).toContain('00:05.000');
    const monitor = screen.getByRole('region', { name: '视频预览' });
    expect(monitor.dataset.monitorMode).toBe('rolling');
    expect(monitor.dataset.monitorPlaybackRange).toBe('3.5:6.5');
    expect(monitor.dataset.monitorRollingLeftClipId).toBe(CLIP_A);
    expect(monitor.dataset.monitorRollingRightClipId).toBe(CLIP_B);

    fireEvent.keyDown(timeline, { key: ' ' });
    expect(monitor.dataset.monitorPlaying).toBe('true');
    fireEvent.keyDown(timeline, { key: 'k' });
    expect(monitor.dataset.monitorPlaying).toBe('false');

    fireEvent.keyDown(timeline, { key: 'ArrowLeft' });
    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ duration: 4 + 59 / 60 }) }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 4 + 59 / 60, duration: 5 + 1 / 60 }) }),
        ],
      })],
    })));
    fireEvent.keyDown(timeline, { key: 'Escape' });
    expect(screen.queryByText('修剪模式')).toBeNull();
  });

  it('selects adjacent Trim Mode edit points and adjusts them atomically', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: slideProject(), applyProjectPatch });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    fireEvent.keyDown(timeline, { key: 'T', shiftKey: true });
    const secondCut = screen.getByRole('separator', { name: '滚动编辑 B / C' });
    fireEvent.pointerDown(secondCut, { pointerId: 207, button: 0, clientX: 600, ctrlKey: true });
    expect(screen.getByRole('status').textContent).toContain('修剪模式 · 2');
    expect(secondCut.getAttribute('aria-current')).toBe('true');

    fireEvent.keyDown(timeline, { key: 'ArrowRight' });
    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ start: 0, duration: 4 + 1 / 60, source_out: 4 + 1 / 60 }) }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 4 + 1 / 60, duration: 2, source_in: 1 + 1 / 60, source_out: 3 + 1 / 60 }) }),
          expect.objectContaining({ id: CLIP_C, placement: expect.objectContaining({ start: 6 + 1 / 60, duration: 4 - 1 / 60, source_in: 2 + 1 / 60 }) }),
        ],
      })],
    })));
    expect(applyProjectPatch).toHaveBeenCalledTimes(1);
  });

  it('rate-stretches one Story clip with live ripple and one commit', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const applyProjectPatch = vi.fn();
    renderWorkspace({
      project: RECORDED_PROJECT,
      applyProjectPatch,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    fireEvent.keyDown(timeline, { key: 'r' });
    expect(screen.getByRole('button', { name: '比率伸缩工具 (R)' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('separator', { name: '从起点比率伸缩 A' })).toBeNull();
    const handle = screen.getByRole('separator', { name: '从终点比率伸缩 A' });
    fireEvent.pointerDown(handle, { pointerId: 114, button: 0, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 114, clientX: 400 });

    const clipA = screen.getByRole('button', { name: /A 4\.0s · 已录制/u });
    const clipB = screen.getByRole('button', { name: /B 5\.0s · 已录制/u });
    expect(clipA.style.width).toBe('400px');
    expect(clipA.dataset.sourceIn).toBe('0');
    expect(clipA.dataset.sourceOut).toBe('5');
    expect(Number(clipA.dataset.clipSpeed)).toBeCloseTo(1.25);
    expect(screen.getByLabelText('比率伸缩 125.0%')).toBeTruthy();
    expect(clipB.style.left).toBe('400px');
    expect(screen.getByText('00:09.000')).toBeTruthy();
    expect(Number((screen.getByLabelText('A 视频预览') as HTMLVideoElement).dataset.previewClipSpeed)).toBeCloseTo(1.25);
    const monitor = screen.getByRole('region', { name: '视频预览' });
    expect(Number(monitor.dataset.monitorDuration)).toBe(9);
    expect(monitor.querySelectorAll('video')).toHaveLength(4);
    expect(applyProjectPatch).not.toHaveBeenCalled();

    fireEvent.pointerUp(handle, { pointerId: 114, clientX: 400 });
    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ start: 0, duration: 4, source_in: 0, source_out: 5, speed: 1.25 }) }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 4, duration: 5 }) }),
        ],
      })],
    })));
    expect(applyProjectPatch).toHaveBeenCalledTimes(1);
    clientWidth.mockRestore();
  });

  it('uses Ripple Edit Tool B for live Story ripple and one Sync Lock commit', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const base = syncLockProject();
    const project: Project = {
      ...base,
      document: {
        ...base.document,
        duration_seconds: 10,
        markers: [{
          id: '00000000-0000-4000-8000-000000000109',
          time: 8,
          duration: 0,
          label: 'Downstream',
          color: '#2F6FED',
          kind: 'comment',
          comment: '',
        }],
        settings: { ...base.document.settings, ripple_sequence_markers: true },
      },
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project, applyProjectPatch });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    fireEvent.keyDown(timeline, { key: 'b' });
    expect(screen.getByRole('button', { name: '波纹编辑工具 (B)' }).getAttribute('aria-pressed')).toBe('true');
    const clipA = screen.getByRole('button', { name: /A 5\.0s · 未录制/u });
    vi.spyOn(clipA, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 500, bottom: 84, left: 0, width: 500, height: 84, toJSON: () => ({}),
    });
    fireEvent.pointerDown(clipA, { pointerId: 206, button: 0, clientX: 499 });
    fireEvent.pointerMove(clipA, { pointerId: 206, clientX: 399 });

    expect(screen.getByRole('button', { name: /B 5\.0s · 已录制/u }).style.left).toBe('400px');
    expect(applyProjectPatch).not.toHaveBeenCalled();
    fireEvent.pointerUp(clipA, { pointerId: 206, clientX: 399 });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [
        expect.objectContaining({
          op: 'replace_track_clips',
          track_id: STORY_ID,
          clips: [
            expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ duration: 4 }) }),
            expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 4 }) }),
          ],
        }),
        expect.objectContaining({
          op: 'replace_track_clips',
          track_id: '00000000-0000-4000-8000-000000000097',
          clips: [expect.objectContaining({ placement: expect.objectContaining({ start: 5 }) })],
        }),
        {
          op: 'replace_markers',
          markers: [expect.objectContaining({ id: '00000000-0000-4000-8000-000000000109', time: 7 })],
        },
      ],
    })));
    expect(applyProjectPatch).toHaveBeenCalledTimes(1);
    clientWidth.mockRestore();
  }, 15_000);

  it('keeps Inspector duration and speed on the same Rate Stretch operation', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: RECORDED_PROJECT, applyProjectPatch });

    fireEvent.doubleClick(await screen.findByRole('button', { name: /A 5\.0s · 已录制/u }));
    const duration = await screen.findByRole('spinbutton', { name: 'duration' });
    const speed = screen.getByRole('spinbutton', { name: 'speed' });
    fireEvent.change(duration, { target: { value: '2.5' } });
    expect(Number((speed as HTMLInputElement).value)).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        clips: [
          expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ duration: 2.5, source_in: 0, source_out: 5, speed: 2 }) }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 2.5 }) }),
        ],
      })],
    })));
  });

  it('authors reverse playback as signed speed while storing a positive speed magnitude', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: RECORDED_PROJECT, applyProjectPatch });

    fireEvent.doubleClick(await screen.findByRole('button', { name: /A 5\.0s · 已录制/u }));
    const speed = await screen.findByRole('spinbutton', { name: 'speed' });
    fireEvent.change(speed, { target: { value: '-2' } });
    expect((speed as HTMLInputElement).value).toBe('-2');
    expect((screen.getByRole('checkbox', { name: '反向播放' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        clips: [
          expect.objectContaining({
            id: CLIP_A,
            placement: expect.objectContaining({ duration: 2.5, speed: 2, reverse: true, frame_hold_source_time: null }),
          }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 2.5 }) }),
        ],
      })],
    })));
  });

  it('holds the source frame under the shared Timeline playhead', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: RECORDED_PROJECT, applyProjectPatch });

    const playhead = await screen.findByRole('slider', { name: '时间轴播放头' });
    stepTimelineSeconds(playhead, 2);
    fireEvent.doubleClick(screen.getByRole('button', { name: /A 5\.0s · 已录制/u }));
    fireEvent.click(await screen.findByRole('button', { name: '定格当前帧' }));
    expect((screen.getByRole('spinbutton', { name: 'source_in' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '启用' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        clips: [
          expect.objectContaining({
            id: CLIP_A,
            placement: expect.objectContaining({
              duration: 5,
              reverse: false,
              frame_hold_source_time: 2,
            }),
          }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 5 }) }),
        ],
      })],
    })));
  });

  it('authors Time Remapping sections and ripples Story once on save', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: RECORDED_PROJECT, applyProjectPatch });

    fireEvent.doubleClick(await screen.findByRole('button', { name: /A 5\.0s · 已录制/u }));
    fireEvent.click(await screen.findByRole('button', { name: '启用' }));
    const playhead = screen.getByRole('slider', { name: '时间轴播放头' });
    stepTimelineSeconds(playhead, 2);
    fireEvent.click(screen.getByRole('button', { name: '在播放头添加速度关键帧' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '区间 2 速度百分比' }), { target: { value: '200' } });

    expect((screen.getByRole('spinbutton', { name: 'duration' }) as HTMLInputElement).value).toBe('3.5');
    expect((screen.getByRole('spinbutton', { name: 'duration' }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({
            id: CLIP_A,
            placement: expect.objectContaining({ duration: 3.5, source_in: 0, source_out: 5, speed: 10 / 7 }),
            speed_segments: [
              expect.objectContaining({ start: 0, end: 2, speed: 1 }),
              expect.objectContaining({ start: 2, end: 3.5, speed: 2 }),
            ],
          }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 3.5 }) }),
        ],
      })],
    })));
    expect(applyProjectPatch).toHaveBeenCalledTimes(1);
  });

  it('drags the Premiere-style speed band and commits one Story ripple edit', async () => {
    const applyProjectPatch = vi.fn();
    const project: Project = {
      ...RECORDED_PROJECT,
      document: {
        ...RECORDED_PROJECT.document,
        tracks: RECORDED_PROJECT.document.tracks.map((track) => track.id !== STORY_ID ? track : {
          ...track,
          clips: track.clips.map((candidate) => candidate.id !== CLIP_A ? candidate : {
            ...candidate,
            speed_segments: [
              { id: 'speed-left', start: 0, end: 2, speed: 1 },
              { id: 'speed-right', start: 2, end: 5, speed: 1 },
            ],
          }),
        }),
      },
    };
    renderWorkspace({ project, applyProjectPatch });

    const clipA = await screen.findByRole('button', { name: /A 5\.0s · 已录制/u });
    fireEvent.click(clipA);
    const band = screen.getByRole('group', { name: '时间重映射 2 个区间' });
    const second = within(band).getByLabelText('区间 2 100.0%');
    fireEvent.pointerDown(second, { pointerId: 141, button: 0, clientY: 100 });
    fireEvent.pointerMove(second, { pointerId: 141, clientY: 40 });
    expect(within(band).getByText('200.0%')).toBeTruthy();
    expect(applyProjectPatch).not.toHaveBeenCalled();
    fireEvent.pointerUp(second, { pointerId: 141, clientY: 40 });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({
            id: CLIP_A,
            placement: expect.objectContaining({ duration: 3.5, source_out: 5 }),
            speed_segments: [
              expect.objectContaining({ start: 0, end: 2, speed: 1 }),
              expect.objectContaining({ start: 2, end: 3.5, speed: 2 }),
            ],
          }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 3.5 }) }),
        ],
      })],
    })));
    expect(applyProjectPatch).toHaveBeenCalledTimes(1);
  });

  it('keeps Inspector save disabled until the canonical clip draft actually differs', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: RECORDED_PROJECT, applyProjectPatch });

    fireEvent.doubleClick(await screen.findByRole('button', { name: /A 5\.0s · 已录制/u }));
    const name = await screen.findByLabelText('名称');
    const save = screen.getByRole('button', { name: '保存修改' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(name, { target: { value: 'A revised' } });
    expect(save.disabled).toBe(false);
    fireEvent.change(name, { target: { value: 'A' } });
    expect(save.disabled).toBe(true);
    expect(applyProjectPatch).not.toHaveBeenCalled();
  });

  it('opens a locked clip in Inspector as read-only through direct review', async () => {
    const lockedProject: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        tracks: PROJECT.document.tracks.map((track) => track.id === STORY_ID
          ? { ...track, locked: true }
          : track),
      },
    };
    const session: AgentSession = {
      id: '00000000-0000-4000-8000-000000000098',
      title: 'Agent · locked review',
      created_at: '2026-08-28T10:00:00Z',
      updated_at: '2026-08-28T10:02:00Z',
      entries: [
        { kind: 'user', id: 'locked-user', at: '2026-08-28T10:01:00Z', content: '审阅锁定片段' },
        {
          kind: 'assistant', id: 'locked-assistant', at: '2026-08-28T10:02:00Z', content: '已准备审阅。',
          tool_calls: [], status: 'completed', request_id: 'locked-request', retry_of: null, error: null, metadata: null,
        },
      ],
    };
    const group: ProjectChangeGroup = {
      id: '00000000-0000-4000-8000-000000000099',
      project_id: PROJECT.id,
      from_revision: 0,
      to_revision: 1,
      author: { kind: 'agent', session_id: session.id, turn_id: 'locked-request' },
      status: 'completed',
      summary: '准备锁定片段',
      reverts_change_group_id: null,
      operations: [],
      inverse_operations: [],
      created_at: '2026-08-28T10:01:30Z',
      completed_at: '2026-08-28T10:01:31Z',
    };
    const appendAgentSessionEntry = vi.fn(async (_sessionId: string, draft: AgentSessionEntryDraft) => {
      if (draft.kind !== 'tool_decision') throw new Error('expected direct-edit decision');
      return {
        kind: 'tool_decision' as const,
        id: 'direct-edit',
        at: '2026-08-28T10:03:00Z',
        tool_call_id: draft.tool_call_id,
        decision: draft.decision,
        content: draft.content,
      };
    });
    renderWorkspace({ project: lockedProject, session, groups: [group], appendAgentSessionEntry });

    fireEvent.click(await screen.findByRole('button', { name: '直接修改' }));
    await waitFor(() => expect(appendAgentSessionEntry).toHaveBeenCalledWith(session.id, expect.objectContaining({
      kind: 'tool_decision', tool_call_id: `delivery:${group.id}`, decision: 'rejected',
    })));
    const inspector = await screen.findByRole('dialog', { name: '片段属性' });
    expect((within(inspector).getByLabelText('名称') as HTMLInputElement).disabled).toBe(true);
    expect((within(inspector).getByRole('button', { name: '保存修改' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('edits a planned clip recording camera through the canonical Project Patch', async () => {
    const applyProjectPatch = vi.fn();
    const project: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        tracks: PROJECT.document.tracks.map((track) => track.id !== STORY_ID ? track : {
          ...track,
          clips: track.clips.map((candidate) => candidate.id !== CLIP_A ? candidate : {
            ...candidate,
            capture_intent: {
              demo_id: 'demo-a',
              highlight_id: 'highlight-a',
              player_id: 'player-a',
              start_tick: 100,
              end_tick: 200,
              pre_roll_seconds: 1,
              post_roll_seconds: 1,
              victim_pov: false,
              camera_style: 'dolly',
              presentation: null,
            },
          }),
        }),
      },
    };
    renderWorkspace({ project, applyProjectPatch });

    fireEvent.doubleClick(await screen.findByRole('button', { name: /A 5\.0s · 未录制/u }));
    fireEvent.change(await screen.findByRole('combobox', { name: '录制视角' }), { target: { value: 'pov' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: '结束 tick' }), { target: { value: '180' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: '前留白（秒）' }), { target: { value: '11.5' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: '后留白（秒）' }), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        clips: expect.arrayContaining([
          expect.objectContaining({
            id: CLIP_A,
            capture_intent: expect.objectContaining({
              camera_style: 'pov',
              end_tick: 180,
              pre_roll_seconds: 11.5,
              post_roll_seconds: 0,
            }),
          }),
        ]),
      })],
    })));
  });

  it('returns an attached clip to Planned through the Inspector without deleting its file', async () => {
    const applyProjectPatch = vi.fn();
    const project: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        tracks: PROJECT.document.tracks.map((track) => track.id !== STORY_ID ? track : {
          ...track,
          clips: track.clips.map((candidate) => candidate.id !== CLIP_B ? candidate : {
            ...candidate,
            capture_intent: {
              demo_id: 'demo-b',
              highlight_id: 'highlight-b',
              player_id: 'player-b',
              start_tick: 100,
              end_tick: 200,
              pre_roll_seconds: 1,
              post_roll_seconds: 1,
              victim_pov: false,
              camera_style: 'pov',
              presentation: null,
            },
          }),
        }),
      },
    };
    renderWorkspace({ project, applyProjectPatch });

    fireEvent.doubleClick(await screen.findByRole('button', { name: /B 5\.0s · 已录制/u }));
    fireEvent.click(await screen.findByRole('button', { name: '重新录制（保留旧文件）' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        clips: expect.arrayContaining([
          expect.objectContaining({ id: CLIP_B, material: { kind: 'planned' } }),
        ]),
      })],
    })));
  });

  it('slides a middle Story clip with four stable Trim Monitor frames and one commit', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const applyProjectPatch = vi.fn();
    renderWorkspace({
      project: slideProject(),
      applyProjectPatch,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    fireEvent.keyDown(timeline, { key: 'u' });
    expect(screen.getByRole('button', { name: '滑动工具 (U)' }).getAttribute('aria-pressed')).toBe('true');
    const monitor = screen.getByRole('region', { name: '视频预览' });
    for (const video of monitor.querySelectorAll<HTMLVideoElement>('video')) {
      Object.defineProperty(video, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_ENOUGH_DATA });
    }
    const middle = screen.getByRole('button', { name: /B 2\.0s · 已录制/u });
    fireEvent.pointerDown(middle, { pointerId: 115, button: 0, clientX: 500 });
    fireEvent.pointerMove(middle, { pointerId: 115, clientX: 550 });

    const previous = screen.getByRole('button', { name: /A 4\.5s · 已录制/u });
    const selected = screen.getByRole('button', { name: /B 2\.0s · 已录制/u });
    const next = screen.getByRole('button', { name: /C 3\.5s · 已录制/u });
    expect(previous.style.width).toBe('450px');
    expect(Number(previous.dataset.sourceOut)).toBeCloseTo(4.5);
    expect(selected.style.left).toBe('450px');
    expect(selected.style.width).toBe('200px');
    expect(selected.dataset.sourceIn).toBe('1');
    expect(selected.dataset.sourceOut).toBe('3');
    expect(next.style.left).toBe('650px');
    expect(next.style.width).toBe('350px');
    expect(Number(next.dataset.sourceIn)).toBeCloseTo(2.5);
    expect(screen.getByLabelText('滑动 +00:00.500')).toBeTruthy();
    expect(applyProjectPatch).not.toHaveBeenCalled();

    expect(monitor.dataset.monitorMode).toBe('slide');
    expect(Number(monitor.dataset.monitorPoolSize)).toBe(6);
    const targets = [...monitor.querySelectorAll<HTMLVideoElement>('video[data-preview-target="true"]')];
    expect(targets).toHaveLength(4);
    targets.forEach((video) => {
      Object.defineProperty(video, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_ENOUGH_DATA });
      fireEvent.loadedData(video);
      video.currentTime = Number(video.dataset.previewSourceTime);
      fireEvent.seeked(video);
    });
    await waitFor(() => expect(targets.map((video) => video.dataset.previewSide).sort()).toEqual([
      'slide-in',
      'slide-next',
      'slide-out',
      'slide-previous',
    ]));
    expect(monitor.querySelectorAll('video')).toHaveLength(6);
    expect(targets.map((video) => video.getAttribute('src'))).toEqual(expect.arrayContaining([
      'vibe-cs-media://localhost/media/assets/asset-a/stream',
      'vibe-cs-media://localhost/media/assets/asset-b/stream',
      'vibe-cs-media://localhost/media/assets/asset-c/stream',
    ]));

    fireEvent.pointerUp(middle, { pointerId: 115, clientX: 550 });
    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ start: 0, duration: 4.5, source_in: 0, source_out: 4.5 }) }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 4.5, duration: 2, source_in: 1, source_out: 3 }) }),
          expect.objectContaining({ id: CLIP_C, placement: expect.objectContaining({ start: 6.5, duration: 3.5, source_in: 2.5, source_out: 6 }) }),
        ],
      })],
    })));
    expect(applyProjectPatch).toHaveBeenCalledTimes(1);
    expect(Number(screen.getByRole('slider', { name: '时间轴播放头' }).getAttribute('aria-valuenow'))).toBeCloseTo(4.5);
    clientWidth.mockRestore();
  });

  it('drags selected Story clips as one ordered ripple group', async () => {
    const project: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        tracks: PROJECT.document.tracks.map((track) => track.id !== STORY_ID ? track : {
          ...track,
          clips: [
            track.clips[0]!,
            track.clips[1]!,
            { ...clip(CLIP_C, 'C'), placement: { ...clip(CLIP_C, 'C').placement, start: 10 } },
          ],
        }),
      },
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project, applyProjectPatch });

    const clipB = await screen.findByRole('button', { name: /B 5\.0s · 已录制/u });
    fireEvent.pointerDown(clipB, { pointerId: 61, button: 0, shiftKey: true, clientX: 300 });
    fireEvent.pointerDown(clipB, { pointerId: 62, button: 0, clientX: 300 });
    fireEvent.pointerMove(clipB, { pointerId: 62, clientX: 700 });
    fireEvent.pointerUp(clipB, { pointerId: 62, clientX: 700 });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({ id: CLIP_C, placement: expect.objectContaining({ start: 0 }) }),
          expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ start: 5 }) }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 10 }) }),
        ],
      })],
    })));
    expect(applyProjectPatch).toHaveBeenCalledTimes(1);
  });

  it('does not create a Change Group when a Story drag stays in the same insertion slot', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    const clipB = await screen.findByRole('button', { name: /B 5\.0s · 已录制/u });
    const originalLeft = clipB.style.left;
    fireEvent.pointerDown(clipB, { pointerId: 116, button: 0, clientX: 300 });
    fireEvent.pointerMove(clipB, { pointerId: 116, clientX: 310 });
    fireEvent.pointerUp(clipB, { pointerId: 116, clientX: 310 });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(applyProjectPatch).not.toHaveBeenCalled();
    expect(clipB.style.left).toBe(originalLeft);
    clientWidth.mockRestore();
  });

  it('marquee-selects intersecting clips after the drag threshold', async () => {
    renderWorkspace();

    const viewport = await screen.findByRole('region', { name: '时间轴内容' });
    const grid = screen.getByRole('rowgroup', { name: '时间轴轨道网格' });
    const clipA = screen.getByRole('button', { name: /A 5\.0s · 未录制/u });
    const clipB = screen.getByRole('button', { name: /B 5\.0s · 已录制/u });
    viewport.style.setProperty('--w-track-head', '0px');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 900, bottom: 400, left: 0, width: 900, height: 400, toJSON: () => ({}),
    });
    vi.spyOn(clipA, 'getBoundingClientRect').mockReturnValue({
      x: 150, y: 100, top: 100, right: 250, bottom: 180, left: 150, width: 100, height: 80, toJSON: () => ({}),
    });
    vi.spyOn(clipB, 'getBoundingClientRect').mockReturnValue({
      x: 300, y: 100, top: 100, right: 400, bottom: 180, left: 300, width: 100, height: 80, toJSON: () => ({}),
    });

    fireEvent.pointerDown(grid, { pointerId: 63, button: 0, clientX: 100, clientY: 80 });
    expect(screen.queryByLabelText('框选范围')).toBeNull();
    fireEvent.pointerMove(grid, { pointerId: 63, clientX: 420, clientY: 200 });
    expect(screen.getByLabelText('框选范围')).toBeTruthy();
    await waitFor(() => {
      expect(clipA.className).toContain('ring-accent');
      expect(clipB.className).toContain('ring-accent');
    });
    fireEvent.pointerUp(grid, { pointerId: 63, clientX: 420, clientY: 200 });
    expect(screen.queryByLabelText('框选范围')).toBeNull();
  });

  it('auto-scrolls marquee selection horizontally and vertically in content coordinates', async () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_000);
    renderWorkspace();

    const viewport = await screen.findByRole('region', { name: '时间轴内容' });
    const grid = screen.getByRole('rowgroup', { name: '时间轴轨道网格' });
    viewport.style.setProperty('--w-track-head', '200px');
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 600 },
    });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 1_000, bottom: 300, left: 0, width: 1_000, height: 300, toJSON: () => ({}),
    });
    const timelineZoom = screen.getByRole('slider', { name: '时间轴缩放' }) as HTMLInputElement;
    fireEvent.change(timelineZoom, { target: { value: timelineZoom.max } });
    fireEvent.pointerDown(grid, { pointerId: 64, button: 0, clientX: 500, clientY: 100 });
    fireEvent.pointerMove(grid, { pointerId: 64, clientX: 990, clientY: 295 });

    await waitFor(() => {
      expect(viewport.scrollLeft).toBeGreaterThan(0);
      expect(viewport.scrollTop).toBeGreaterThan(0);
    });
    const marquee = screen.getByLabelText('框选范围');
    expect(Number.parseFloat(marquee.style.width)).toBeGreaterThan(490);
    expect(Number.parseFloat(marquee.style.height)).toBeGreaterThan(195);
    fireEvent.pointerUp(grid, { pointerId: 64, clientX: 990, clientY: 295 });
    const stoppedAt = { left: viewport.scrollLeft, top: viewport.scrollTop };
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect({ left: viewport.scrollLeft, top: viewport.scrollTop }).toEqual(stoppedAt);
    clientWidth.mockRestore();
  });

  it('projects planned, recorded and imported media in the docked project panel', async () => {
    const asset: MediaAsset = {
      id: 'asset-new',
      project_id: PROJECT.id,
      path: 'D:\\media\\new.mp4',
      name: 'New angle',
      kind: 'video',
      duration_seconds: 6,
      width: 1920,
      height: 1080,
      file_size: 1_024,
      has_audio: true,
      proxy_path: null,
      proxy_status: { status: 'not_requested' },
      waveform: null,
      metadata_status: { status: 'ready' },
      markers: [],
      created_at: PROJECT.updated_at,
    };
    renderWorkspace({ project: RECORDABLE_PROJECT, assets: [asset] });

    const panel = await screen.findByRole('region', { name: '项目素材' });
    expect(within(panel).getByRole('option', { name: '选择素材 A' }).textContent).toContain('准备录制');
    expect(within(panel).getByRole('option', { name: '选择素材 B' }).textContent).toContain('已录制');
    expect(within(panel).getByRole('option', { name: '选择素材 New angle' }).textContent).toContain('导入');
    expect(within(panel).getByRole('region', { name: '准备录制' })).toBeTruthy();
    expect(within(panel).getByRole('region', { name: '已录制' })).toBeTruthy();
    expect(within(panel).getByRole('region', { name: '导入素材' })).toBeTruthy();

    fireEvent.change(within(panel).getByRole('combobox', { name: '筛选素材状态' }), { target: { value: 'planned' } });
    expect(within(panel).getByRole('option', { name: '选择素材 A' })).toBeTruthy();
    expect(within(panel).queryByRole('option', { name: '选择素材 B' })).toBeNull();
    expect(within(panel).queryByRole('option', { name: '选择素材 New angle' })).toBeNull();

    fireEvent.click(within(panel).getByRole('option', { name: '选择素材 A' }));
    fireEvent.click(within(panel).getByRole('button', { name: '录制片段 A' }));
    expect(screen.getByRole('dialog', { name: '录制缺失片段' }).textContent).toContain('录制 1 个还没有素材的片段');
  });

  it('edits one source-time Clip Marker and projects it onto every matching Timeline clip', async () => {
    const sourceMarker = {
      id: '00000000-0000-4000-8000-000000000120',
      time: 2,
      duration: 1,
      label: 'Source beat',
      color: '#F59E0B',
      kind: 'comment' as const,
      comment: 'Original source note',
    };
    const asset: MediaAsset = {
      id: 'asset-b',
      project_id: PROJECT.id,
      path: 'D:\\media\\source-b.mp4',
      name: 'Source B',
      kind: 'video',
      duration_seconds: 5,
      width: 1920,
      height: 1080,
      file_size: 1_024,
      has_audio: true,
      proxy_path: null,
      proxy_status: { status: 'not_requested' },
      waveform: null,
      metadata_status: { status: 'ready' },
      markers: [sourceMarker],
      created_at: PROJECT.updated_at,
    };
    const replaceMediaAssetMarkers = vi.fn((_id: string, markers: readonly typeof sourceMarker[]) => Promise.resolve({ ...asset, markers }));
    renderWorkspace({ assets: [asset], replaceMediaAssetMarkers });

    const panel = await screen.findByRole('region', { name: '项目素材' });
    fireEvent.click(within(panel).getByRole('option', { name: '选择素材 B' }));
    const sourceMarkerButton = within(panel).getByRole('button', { name: '片段标记 Source beat 00:02.000' });
    expect(sourceMarkerButton.title).toContain('Original source note');
    expect(screen.getAllByRole('button', { name: '片段标记 Source beat 00:02.000' })).toHaveLength(2);

    fireEvent.doubleClick(sourceMarkerButton);
    fireEvent.change(screen.getByRole('textbox', { name: '注释' }), { target: { value: 'Shared master-source note' } });
    fireEvent.click(screen.getByRole('button', { name: '保存片段标记' }));

    await waitFor(() => expect(replaceMediaAssetMarkers).toHaveBeenCalledWith('asset-b', [{
      ...sourceMarker,
      comment: 'Shared master-source note',
    }]));
  });

  it('generates, selects and cleans managed proxy media from the unified Project panel', async () => {
    const asset: MediaAsset = {
      id: 'asset-b',
      project_id: PROJECT.id,
      path: 'D:\\media\\source-b.mp4',
      name: 'Source B',
      kind: 'video',
      duration_seconds: 5,
      width: 1920,
      height: 1080,
      file_size: 1_024,
      has_audio: true,
      proxy_path: null,
      proxy_status: { status: 'not_requested' },
      waveform: null,
      metadata_status: { status: 'ready' },
      markers: [],
      created_at: PROJECT.updated_at,
    };
    const generateMediaProxy = vi.fn(() => Promise.resolve({
      ...asset,
      proxy_path: 'D:\\proxies\\source-b.mp4',
      proxy_status: { status: 'ready' as const, generated_at: PROJECT.updated_at },
    }));
    const cleanupMediaProxies = vi.fn(() => Promise.resolve({
      removed_files: 1,
      freed_bytes: 1_024,
      failed_files: [],
      skipped_generating: 0,
    }));
    const applyProjectPatch = vi.fn();
    renderWorkspace({ assets: [asset], generateMediaProxy, cleanupMediaProxies, applyProjectPatch });

    const panel = await screen.findByRole('region', { name: '项目素材' });
    fireEvent.click(within(panel).getByRole('option', { name: '选择素材 B' }));
    fireEvent.click(within(panel).getByRole('button', { name: '生成代理 Source B' }));
    await waitFor(() => expect(generateMediaProxy).toHaveBeenCalledWith('asset-b'));

    fireEvent.click(within(panel).getByRole('button', { name: '切换代理预览' }));
    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_settings',
        settings: { source_demo_ids: [], ripple_sequence_markers: false, use_media_proxies: true },
      }],
    })));

    fireEvent.click(within(panel).getByRole('button', { name: '清理代理媒体' }));
    await waitFor(() => expect(cleanupMediaProxies).toHaveBeenCalledTimes(1));
  });

  it('automates selected Project media to Story in selection order with default transitions', async () => {
    const source = (id: string, name: string): MediaAsset => ({
      id,
      project_id: PROJECT.id,
      path: `D:\\media\\${id}.mp4`,
      name,
      kind: 'video',
      duration_seconds: 4,
      width: 1920,
      height: 1080,
      file_size: 1_024,
      has_audio: true,
      proxy_path: null,
      proxy_status: { status: 'not_requested' },
      waveform: null,
      metadata_status: { status: 'ready' },
      markers: [],
      created_at: PROJECT.updated_at,
    });
    const project: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        duration_seconds: 0,
        tracks: PROJECT.document.tracks.map((track) => ({ ...track, clips: [] })),
      },
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project, assets: [source('first', 'First'), source('second', 'Second')], applyProjectPatch });

    const panel = await screen.findByRole('region', { name: '项目素材' });
    fireEvent.click(within(panel).getByRole('button', { name: '批量组接到序列' }));
    const dialog = screen.getByRole('dialog', { name: '批量组接到序列' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /First/u }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /First/u }));
    fireEvent.change(within(dialog).getByRole('combobox', { name: '排序' }), { target: { value: 'selection' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '应用默认视频转场（重叠 0.5 秒）' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '组接' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({
            name: 'Second',
            placement: expect.objectContaining({ start: 0, duration: 3.5, source_in: 0.25, source_out: 3.75 }),
            transitions: expect.objectContaining({ video_out: expect.objectContaining({ duration_seconds: 0.25 }) }),
          }),
          expect.objectContaining({
            name: 'First',
            placement: expect.objectContaining({ start: 3.5, duration: 3.5, source_in: 0.25, source_out: 3.75 }),
            transitions: expect.objectContaining({ video_in: expect.objectContaining({ duration_seconds: 0.25 }) }),
          }),
        ],
      })],
    })));
    expect(applyProjectPatch).toHaveBeenCalledTimes(1);
  });

  it('creates a marker-synchronized multicam source from selected Project media', async () => {
    const source = (id: string, name: string, markerTime: number): MediaAsset => ({
      id, project_id: PROJECT.id, path: `D:\\media\\${id}.mp4`, name, kind: 'video', duration_seconds: 10,
      width: 1920, height: 1080, file_size: 1_024, has_audio: true, proxy_path: null,
      proxy_status: { status: 'not_requested' }, waveform: null, metadata_status: { status: 'ready' },
      markers: [{ id: `${id}-marker`, time: markerTime, duration: 0, label: 'Clap', color: '#00AAFF', kind: 'comment', comment: '' }],
      created_at: PROJECT.updated_at,
    });
    const first = source('angle-1', 'Camera One', 2);
    const second = source('angle-2', 'Camera Two', 3);
    const createMulticam = vi.fn(() => new Promise(() => undefined));
    renderWorkspace({ assets: [first, second], createMulticam });
    const panel = await screen.findByRole('region', { name: '项目素材' });
    fireEvent.click(within(panel).getByRole('button', { name: '创建多机位序列' }));
    const dialog = screen.getByRole('dialog', { name: '创建多机位源序列' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: '同步点' }), { target: { value: 'marker' } });
    fireEvent.change(within(dialog).getByLabelText('标记名称'), { target: { value: 'Clap' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '音频随摄像机切换；关闭时固定使用角度 1 音频' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '同步并创建' }));

    await waitFor(() => expect(createMulticam).toHaveBeenCalledWith(PROJECT.id, {
      base_revision: PROJECT.revision,
      asset_ids: ['angle-1', 'angle-2'],
      sync_method: 'marker',
      marker_label: 'Clap',
      switch_audio: true,
    }));
  });

  it('shows all multicam angles in Program and switches at the Timeline playhead', async () => {
    const groupId = '00000000-0000-4000-8000-000000000700';
    const source = (id: string, name: string): MediaAsset => ({
      id, project_id: PROJECT.id, path: `D:\\media\\${id}.mp4`, name, kind: 'video', duration_seconds: 10,
      width: 1920, height: 1080, file_size: 1_024, has_audio: true, proxy_path: null,
      proxy_status: { status: 'not_requested' }, waveform: null, metadata_status: { status: 'ready' }, markers: [],
      created_at: PROJECT.updated_at,
    });
    const angleClip = (id: string, assetId: string, angle: number, enabled: boolean): TimelineClip => ({
      ...clip(id, `Angle ${angle}`),
      material: { kind: 'asset', asset_id: assetId, media_duration_seconds: 10 },
      placement: { ...clip(id, `Angle ${angle}`).placement, duration: 10, source_out: 10, enabled },
      metadata: { multicam: { group_id: groupId, angle, angle_name: `Camera ${angle}`, sync_method: 'audio', switch_audio: true } },
    });
    const firstTrack = { ...PROJECT.document.tracks[0]!, clips: [angleClip(CLIP_A, 'angle-1', 1, true)] };
    const secondTrack: TimelineTrack = {
      ...firstTrack,
      id: '00000000-0000-4000-8000-000000000701',
      name: 'Angle 2',
      order: 1,
      clips: [angleClip(CLIP_B, 'angle-2', 2, false)],
    };
    const project: Project = {
      ...PROJECT,
      document: { ...PROJECT.document, duration_seconds: 10, tracks: [firstTrack, secondTrack] },
    };
    const switchMulticamAngle = vi.fn(() => new Promise(() => undefined));
    renderWorkspace({
      project,
      assets: [source('angle-1', 'Camera One'), source('angle-2', 'Camera Two')],
      switchMulticamAngle,
      shell: { ...unavailableNativeShell, available: true, mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}` },
    });

    const view = await screen.findByRole('complementary', { name: '多机位视图' });
    expect(within(view).getAllByRole('button')).toHaveLength(2);
    expect(within(view).getByRole('button', { name: '切换到摄像机 1 Camera 1' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(view).getByRole('button', { name: '切换到摄像机 2 Camera 2' }));
    await waitFor(() => expect(switchMulticamAngle).toHaveBeenCalledWith(PROJECT.id, {
      base_revision: PROJECT.revision,
      group_id: groupId,
      angle: 2,
      timeline_time: 0,
    }));
  });

  it('switches the docked Project panel between Adobe-style List and Icon views', async () => {
    renderWorkspace({
      project: RECORDED_PROJECT,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const panel = await screen.findByRole('region', { name: '项目素材' });
    expect(within(panel).getByRole('radio', { name: '列表视图' }).getAttribute('data-state')).toBe('checked');
    fireEvent.click(within(panel).getByRole('radio', { name: '图标视图' }));

    expect(panel.querySelector('[data-project-media-view="icon"]')).toBeTruthy();
    const recorded = within(panel).getByRole('option', { name: '选择素材 B' });
    expect(recorded.querySelector('img')?.getAttribute('src')).toContain('/media/assets/asset-b/thumbnail?time=1');
    fireEvent.click(recorded);
    expect(Number(screen.getByRole('slider', { name: '时间轴播放头' }).getAttribute('aria-valuenow'))).toBe(5);

    fireEvent.click(within(panel).getByRole('radio', { name: '列表视图' }));
    expect(panel.querySelector('[data-project-media-view="list"]')).toBeTruthy();
  });

  it('toggles clip display layers and derives repeated-frame and Through Edit markers', async () => {
    const source = (id: string, name: string, start: number, sourceIn: number, sourceOut: number): TimelineClip => ({
      ...clip(id, name),
      material: { kind: 'asset', asset_id: 'shared-source', media_duration_seconds: 20 },
      placement: { ...clip(id, name).placement, start, duration: 5, source_in: sourceIn, source_out: sourceOut },
      keyframes: name === 'A'
        ? [{ id: 'x', time: 1, property: 'x', value: 10, interpolation: 'linear', in_tangent: 0, out_tangent: 0 }]
        : [],
    });
    const project: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        duration_seconds: 15,
        tracks: PROJECT.document.tracks.map((track) => track.id === STORY_ID ? {
          ...track,
          clips: [
            source(CLIP_A, 'A', 0, 0, 5),
            source(CLIP_B, 'B', 5, 5, 10),
            source('00000000-0000-4000-8000-000000000220', 'C', 10, 4, 9),
          ],
        } : track),
      },
    };
    renderWorkspace({ project });
    const clipA = await screen.findByRole('button', { name: /A 5\.0s · 已录制/u });
    expect(screen.getAllByRole('img', { name: 'Through Edit 00:05.000' })).toHaveLength(2);
    expect(screen.getAllByRole('img', { name: '重复帧 B' })).toHaveLength(1);
    expect(screen.getAllByRole('img', { name: '重复帧 C' })).toHaveLength(1);
    expect(clipA.querySelector('img')).toBeTruthy();
    expect(screen.getByRole('button', { name: '关键帧 00:01.000 1 个属性' })).toBeTruthy();

    const toggle = (name: string) => {
      fireEvent.pointerDown(screen.getByRole('button', { name: '时间轴显示设置' }), { button: 0, ctrlKey: false });
      fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(name, 'u') }));
    };
    toggle('片段名称');
    toggle('视频缩略图：不显示');
    toggle('关键帧');
    toggle('重复帧标记');
    toggle('Through Edit 标记');
    expect(clipA.querySelector('img')).toBeNull();
    expect(clipA.querySelector('.bottom-0')).toBeNull();
    expect(screen.queryByRole('button', { name: '关键帧 00:01.000 1 个属性' })).toBeNull();
    expect(screen.queryByRole('img', { name: '重复帧 B' })).toBeNull();
    expect(screen.queryByRole('img', { name: 'Through Edit 00:05.000' })).toBeNull();
  });

  it('keeps the last recorded source frame mounted until the next selected source is ready', async () => {
    renderWorkspace({
      project: RECORDED_PROJECT,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const panel = await screen.findByRole('region', { name: '项目素材' });
    fireEvent.click(within(panel).getByRole('option', { name: '选择素材 A' }));
    const sourceA = panel.querySelector<HTMLVideoElement>('video[data-source-preview-asset-id="asset-a"]');
    expect(sourceA?.getAttribute('src')).toBe('vibe-cs-media://localhost/media/assets/asset-a/stream');
    expect(sourceA?.hasAttribute('controls')).toBe(false);
    expect(sourceA?.className).toContain('object-contain');
    fireEvent.loadedData(sourceA!);
    expect(sourceA?.dataset.sourcePreviewVisible).toBe('true');

    fireEvent.click(within(panel).getByRole('option', { name: '选择素材 B' }));
    const sourceB = panel.querySelector<HTMLVideoElement>('video[data-source-preview-asset-id="asset-b"]');
    expect(sourceA?.dataset.sourcePreviewVisible).toBe('true');
    expect(sourceB?.dataset.sourcePreviewVisible).toBe('false');
    fireEvent.loadedData(sourceB!);
    expect(sourceA?.dataset.sourcePreviewVisible).toBe('false');
    expect(sourceB?.dataset.sourcePreviewVisible).toBe('true');
  });

  it('treats imported images as five-second visual media with an image source preview', async () => {
    const image: MediaAsset = {
      id: 'asset-image',
      project_id: PROJECT.id,
      path: 'D:\\media\\title.png',
      name: 'Title card',
      kind: 'image',
      duration_seconds: 0.04,
      width: 1920,
      height: 1080,
      file_size: 4_096,
      has_audio: false,
      proxy_path: null,
      proxy_status: { status: 'not_requested' },
      waveform: null,
      metadata_status: { status: 'ready' },
      markers: [],
      created_at: PROJECT.updated_at,
    };
    renderWorkspace({
      assets: [image],
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const option = await screen.findByRole('option', { name: '选择素材 Title card' });
    expect(option.textContent).toContain('00:05.000');
    fireEvent.click(option);
    const preview = await waitFor(() => {
      const element = document.querySelector<HTMLImageElement>('img[data-source-preview-asset-id="asset-image"]');
      expect(element).not.toBeNull();
      return element!;
    });
    expect(preview.getAttribute('src')).toBe('vibe-cs-media://localhost/media/assets/asset-image/stream');
    fireEvent.load(preview);
    expect(preview.dataset.sourcePreviewVisible).toBe('true');
    expect(screen.getByRole('button', { name: '在播放头插入 Title card' })).toBeTruthy();
  });

  it('relinks and removes only an unreferenced imported asset while preserving its source file', async () => {
    const asset: MediaAsset = {
      id: 'asset-manage',
      project_id: PROJECT.id,
      path: 'D:\\media\\manage.wav',
      name: 'Manage me',
      kind: 'audio',
      duration_seconds: 6,
      width: null,
      height: null,
      file_size: 4_096,
      has_audio: true,
      proxy_path: null,
      proxy_status: { status: 'not_requested' },
      waveform: [0.2],
      metadata_status: { status: 'ready' },
      markers: [],
      created_at: PROJECT.updated_at,
    };
    const relinkMediaAsset = vi.fn(async () => ({ ...asset, path: 'E:\\moved\\manage.wav' }));
    const deleteMediaAsset = vi.fn(async () => undefined);
    const chooseFiles = vi.fn(async () => ['E:\\moved\\manage.wav']);
    renderWorkspace({
      assets: [asset],
      relinkMediaAsset,
      deleteMediaAsset,
      shell: { ...unavailableNativeShell, available: true, chooseFiles },
    });

    fireEvent.click(await screen.findByRole('option', { name: '选择素材 Manage me' }));
    fireEvent.click(screen.getByRole('button', { name: '重新定位素材 Manage me' }));
    await waitFor(() => expect(relinkMediaAsset).toHaveBeenCalledWith('asset-manage', 'E:\\moved\\manage.wav'));

    fireEvent.click(await screen.findByRole('option', { name: '选择素材 Manage me' }));
    fireEvent.click(screen.getByRole('button', { name: '从项目移除素材 Manage me' }));
    const dialog = screen.getByRole('dialog', { name: '从项目移除素材？' });
    expect(dialog.textContent).toContain('磁盘上的源文件不会删除');
    fireEvent.click(within(dialog).getByRole('button', { name: '移除素材' }));
    await waitFor(() => expect(deleteMediaAsset).toHaveBeenCalledWith('asset-manage'));
  });

  it('allows a referenced Timeline asset to relink but never to delete or place again', async () => {
    const referencedAsset: MediaAsset = {
      id: 'asset-a',
      project_id: PROJECT.id,
      path: 'D:\\media\\a.mp4',
      name: 'A source',
      kind: 'video',
      duration_seconds: 5,
      width: 1920,
      height: 1080,
      file_size: 8_192,
      has_audio: true,
      proxy_path: null,
      proxy_status: { status: 'not_requested' },
      waveform: null,
      metadata_status: { status: 'unavailable', message: 'source media file is missing' },
      markers: [],
      created_at: PROJECT.updated_at,
    };
    renderWorkspace({ project: RECORDED_PROJECT, assets: [referencedAsset] });

    const option = await screen.findByRole('option', { name: '选择素材 A' });
    expect(option.textContent).toContain('不可用');
    fireEvent.click(option);
    expect(screen.getByRole('button', { name: '重新定位素材 A source' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '从项目移除素材 A source' })).toBeNull();
    expect(screen.queryByRole('button', { name: '在播放头插入 A source' })).toBeNull();
    expect(screen.getByText('源文件不可用')).toBeTruthy();
  });

  it('inserts the Source Monitor In/Out range at the transport through the Premiere comma shortcut', async () => {
    const asset: MediaAsset = {
      id: 'asset-new',
      project_id: PROJECT.id,
      path: 'D:\\media\\new.mp4',
      name: 'New angle',
      kind: 'video',
      duration_seconds: 6,
      width: 1920,
      height: 1080,
      file_size: 1_024,
      has_audio: true,
      proxy_path: null,
      proxy_status: { status: 'not_requested' },
      waveform: null,
      metadata_status: { status: 'ready' },
      markers: [],
      created_at: PROJECT.updated_at,
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ assets: [asset], applyProjectPatch });

    fireEvent.click(await screen.findByRole('option', { name: '选择素材 New angle' }));
    const sourcePlayhead = screen.getByRole('slider', { name: '源素材播放头' });
    fireEvent.change(sourcePlayhead, { target: { value: 1 } });
    fireEvent.click(screen.getByRole('button', { name: '标记源入点' }));
    fireEvent.change(sourcePlayhead, { target: { value: 4 - 1 / PROJECT.document.fps } });
    fireEvent.click(screen.getByRole('button', { name: '标记源出点' }));
    fireEvent.keyDown(window, { key: ',' });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({
            name: 'New angle',
            material: { kind: 'asset', asset_id: 'asset-new', media_duration_seconds: 6 },
            placement: expect.objectContaining({ start: 0, duration: 3, source_in: 1, source_out: 4 }),
          }),
          expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ start: 3 }) }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 8 }) }),
        ],
      })],
    })));
  });

  it('resolves a four-point duration mismatch through Fit to Fill', async () => {
    const asset: MediaAsset = {
      id: 'asset-fit', project_id: PROJECT.id, path: 'D:\\media\\fit.mp4', name: 'Fit source', kind: 'video',
      duration_seconds: 6, width: 1920, height: 1080, file_size: 4_096, has_audio: true,
      proxy_path: null, proxy_status: { status: 'not_requested' }, waveform: null,
      metadata_status: { status: 'ready' }, markers: [], created_at: PROJECT.updated_at,
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: RECORDED_PROJECT, assets: [asset], applyProjectPatch });
    const playhead = await screen.findByRole('slider', { name: '时间轴播放头' });
    stepTimelineSeconds(playhead, 2);
    fireEvent.click(screen.getByRole('button', { name: '在播放头标记入点' }));
    stepTimelineSeconds(playhead, 4);
    fireEvent.click(screen.getByRole('button', { name: '在播放头标记出点' }));
    fireEvent.click(screen.getByRole('option', { name: '选择素材 Fit source' }));
    fireEvent.click(screen.getByRole('button', { name: '在播放头插入 Fit source' }));

    const dialog = screen.getByRole('dialog', { name: 'Fit Clip：范围时长不同' });
    expect((within(dialog).getByRole('radio', { name: '更改片段速度（Fit to Fill）' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '应用四点编辑' }));
    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: expect.arrayContaining([expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: expect.arrayContaining([expect.objectContaining({
          name: 'Fit source',
          placement: expect.objectContaining({ start: 2, duration: 4, source_in: 0, source_out: 6, speed: 1.5 }),
        })]),
      })]),
    })));
  });

  it('drags Project Media onto Story through shared Timeline geometry and Ctrl Insert semantics', async () => {
    const asset: MediaAsset = {
      id: 'asset-drag-video',
      project_id: PROJECT.id,
      path: 'D:\\media\\drag.mp4',
      name: 'Drag angle',
      kind: 'video',
      duration_seconds: 6,
      width: 1920,
      height: 1080,
      file_size: 8_192,
      has_audio: true,
      proxy_path: null,
      proxy_status: { status: 'not_requested' },
      waveform: null,
      metadata_status: { status: 'ready' },
      markers: [],
      created_at: PROJECT.updated_at,
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ assets: [asset], applyProjectPatch });

    const viewport = await screen.findByRole('region', { name: '时间轴内容' });
    viewport.style.setProperty('--w-track-head', '200px');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 1_000, bottom: 400, left: 0, width: 1_000, height: 400, toJSON: () => ({}),
    });
    const source = screen.getByRole('option', { name: '选择素材 Drag angle' });
    const story = screen.getByRole('row', { name: 'Story' });
    const dataTransfer = mediaDragTransfer();

    fireEvent(source, mediaDragEvent('dragstart', dataTransfer));
    expect(source.getAttribute('draggable')).toBe('true');
    fireEvent(story, mediaDragEvent('dragover', dataTransfer, { clientX: 200, ctrlKey: true }));
    expect(screen.getByLabelText('素材落点 Story').textContent).toContain('插入');
    fireEvent(story, mediaDragEvent('drop', dataTransfer, { clientX: 200, ctrlKey: true }));
    expect(screen.queryByLabelText('素材落点 Story')).toBeNull();

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'track', track_id: STORY_ID },
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({ name: 'Drag angle', placement: expect.objectContaining({ start: 0, duration: 6 }) }),
          expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ start: 6 }) }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 11 }) }),
        ],
      })],
    })));
  });

  it('rejects the derived Story audio row and drops audio on a real free-positioned target', async () => {
    const asset: MediaAsset = {
      id: 'asset-drag-audio',
      project_id: PROJECT.id,
      path: 'D:\\media\\drag.wav',
      name: 'Drag bed',
      kind: 'audio',
      duration_seconds: 4,
      width: null,
      height: null,
      file_size: 4_096,
      has_audio: true,
      proxy_path: null,
      proxy_status: { status: 'not_requested' },
      waveform: [0.1, 0.5],
      metadata_status: { status: 'ready' },
      markers: [],
      created_at: PROJECT.updated_at,
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ assets: [asset], applyProjectPatch });

    const viewport = await screen.findByRole('region', { name: '时间轴内容' });
    viewport.style.setProperty('--w-track-head', '200px');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 1_000, bottom: 400, left: 0, width: 1_000, height: 400, toJSON: () => ({}),
    });
    const source = screen.getByRole('option', { name: '选择素材 Drag bed' });
    const derived = screen.getByRole('row', { name: 'Story 音频' });
    const music = screen.getByRole('row', { name: 'Music' });
    const dataTransfer = mediaDragTransfer();

    fireEvent(source, mediaDragEvent('dragstart', dataTransfer));
    fireEvent(derived, mediaDragEvent('dragover', dataTransfer, { clientX: 200 }));
    expect(dataTransfer.dropEffect).toBe('none');
    expect(screen.queryByLabelText('素材落点 Story 音频')).toBeNull();

    fireEvent(music, mediaDragEvent('dragover', dataTransfer, { clientX: 200 }));
    expect(screen.getByLabelText('素材落点 Music').textContent).toContain('覆盖');
    fireEvent(music, mediaDragEvent('drop', dataTransfer, { clientX: 200 }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'track', track_id: '00000000-0000-4000-8000-000000000013' },
      operations: [{
        op: 'replace_track_clips',
        track_id: '00000000-0000-4000-8000-000000000013',
        clips: [expect.objectContaining({ name: 'Drag bed', placement: expect.objectContaining({ start: 0, duration: 4 }) })],
      }],
    })));
  });

  it('overwrites Story media at the transport without rippling the later timeline', async () => {
    const asset: MediaAsset = {
      id: 'asset-overwrite',
      project_id: PROJECT.id,
      path: 'D:\\media\\overwrite.mp4',
      name: 'Overwrite angle',
      kind: 'video',
      duration_seconds: 6,
      width: 1920,
      height: 1080,
      file_size: 2_048,
      has_audio: true,
      proxy_path: null,
      proxy_status: { status: 'not_requested' },
      waveform: null,
      metadata_status: { status: 'ready' },
      markers: [],
      created_at: PROJECT.updated_at,
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ assets: [asset], applyProjectPatch });

    fireEvent.click(await screen.findByRole('option', { name: '选择素材 Overwrite angle' }));
    fireEvent.click(screen.getByRole('button', { name: '在播放头覆盖 Overwrite angle' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({ name: 'Overwrite angle', placement: expect.objectContaining({ start: 0, duration: 6 }) }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 6, duration: 4, source_in: 1 }) }),
        ],
      })],
    })));
  });

  it('replaces the selected Timeline clip source while preserving its edit and authored attributes', async () => {
    const asset: MediaAsset = {
      id: 'asset-replacement',
      project_id: PROJECT.id,
      path: 'D:\\media\\replacement.mp4',
      name: 'Replacement angle',
      kind: 'video',
      duration_seconds: 12,
      width: 1920,
      height: 1080,
      file_size: 4_096,
      has_audio: true,
      proxy_path: null,
      proxy_status: { status: 'not_requested' },
      waveform: null,
      metadata_status: { status: 'ready' },
      markers: [],
      created_at: PROJECT.updated_at,
    };
    const authoredProject: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        tracks: PROJECT.document.tracks.map((track) => track.id !== STORY_ID ? track : {
          ...track,
          clips: track.clips.map((candidate) => candidate.id !== CLIP_A ? candidate : {
            ...candidate,
            transform: { ...candidate.transform, x: 40 },
            effects: [{ id: 'blur', kind: 'blur', enabled: true, parameters: { radius: 3 } }],
            keyframes: [{ id: 'opacity', time: 1, property: 'opacity', value: 0.5, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0  }],
          }),
        }),
      },
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: authoredProject, assets: [asset], applyProjectPatch });

    fireEvent.click(await screen.findByRole('option', { name: '选择素材 Replacement angle' }));
    fireEvent.click(screen.getByRole('button', { name: '用 Replacement angle 替换所选片段' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'time_range', start: 0, end: 5 },
      operations: [{
        op: 'replace_clip',
        clip_id: CLIP_A,
        clip: expect.objectContaining({
          id: CLIP_A,
          name: 'Replacement angle',
          material: { kind: 'asset', asset_id: 'asset-replacement', media_duration_seconds: 12 },
          placement: expect.objectContaining({ start: 0, duration: 5, source_in: 0, source_out: 5 }),
          transform: expect.objectContaining({ x: 40 }),
          effects: [expect.objectContaining({ id: 'blur', kind: 'blur' })],
          keyframes: [expect.objectContaining({ id: 'opacity', property: 'opacity' })],
        }),
      }],
    })));
  });

  it('routes imported audio to the audio target without rippling Story', async () => {
    const asset: MediaAsset = {
      id: 'asset-audio',
      project_id: PROJECT.id,
      path: 'D:\\media\\bed.wav',
      name: 'Bed',
      kind: 'audio',
      duration_seconds: 6,
      width: null,
      height: null,
      file_size: 4_096,
      has_audio: true,
      proxy_path: null,
      proxy_status: { status: 'not_requested' },
      waveform: [0.1, 0.5, 0.2],
      metadata_status: { status: 'ready' },
      markers: [],
      created_at: PROJECT.updated_at,
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ assets: [asset], applyProjectPatch });

    const panel = await screen.findByRole('region', { name: '项目素材' });
    fireEvent.click(screen.getByRole('button', { name: '设为目标轨道 Music' }));
    fireEvent.click(within(panel).getByRole('option', { name: '选择素材 Bed' }));
    expect(within(panel).getByText('A → Music')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '在播放头插入 Bed' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'track', track_id: '00000000-0000-4000-8000-000000000013' },
      operations: [{
        op: 'replace_track_clips',
        track_id: '00000000-0000-4000-8000-000000000013',
        clips: [expect.objectContaining({
          name: 'Bed',
          placement: expect.objectContaining({ start: 0, duration: 6 }),
        })],
      }],
    })));
  });

  it('creates one audio track in the same Project Patch when an imported audio asset has no target', async () => {
    const project: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        tracks: PROJECT.document.tracks.filter((track) => track.id === STORY_ID),
      },
    };
    const asset: MediaAsset = {
      id: 'asset-voice',
      project_id: PROJECT.id,
      path: 'D:\\media\\voice.wav',
      name: 'Voice',
      kind: 'audio',
      duration_seconds: 3,
      width: null,
      height: null,
      file_size: 2_048,
      has_audio: true,
      proxy_path: null,
      proxy_status: { status: 'not_requested' },
      waveform: [0.2, 0.8],
      metadata_status: { status: 'ready' },
      markers: [],
      created_at: PROJECT.updated_at,
    };
    let serverProject = project;
    const applyProjectPatch = vi.fn(async (patch: ProjectPatch): Promise<ProjectPatchResult> => {
      const operation = patch.operations[0];
      if (operation?.op !== 'insert_track') throw new Error('expected one inserted track');
      const actualTrack = {
        ...operation.track,
        id: '00000000-0000-4000-8000-000000000098',
        clips: operation.track.clips.map((clip) => ({
          ...clip,
          id: '00000000-0000-4000-8000-000000000097',
        })),
      };
      const updatedProject: Project = {
        ...project,
        revision: 2,
        document: {
          ...project.document,
          tracks: [...project.document.tracks, actualTrack],
        },
      };
      serverProject = updatedProject;
      return {
        project: updatedProject,
        change_group: {
          id: '00000000-0000-4000-8000-000000000099',
          project_id: project.id,
          from_revision: 1,
          to_revision: 2,
          author: patch.author,
          status: 'completed',
          summary: patch.summary,
          reverts_change_group_id: null,
          operations: [{ ...operation, track: actualTrack }],
          inverse_operations: [{ op: 'remove_track', track_id: actualTrack.id }],
          created_at: PROJECT.updated_at,
          completed_at: PROJECT.updated_at,
        },
      };
    });
    renderWorkspace({
      project,
      assets: [asset],
      applyProjectPatch,
      getProject: () => Promise.resolve(serverProject),
    });

    const panel = await screen.findByRole('region', { name: '项目素材' });
    fireEvent.click(within(panel).getByRole('option', { name: '选择素材 Voice' }));
    expect(within(panel).getByText('A → 新建音频轨道')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '在播放头插入 Voice' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'project' },
      operations: [{
        op: 'insert_track',
        index: 1,
        track: expect.objectContaining({
          kind: 'audio',
          clips: [expect.objectContaining({ name: 'Voice', placement: expect.objectContaining({ start: 0, duration: 3 }) })],
        }),
      }],
    })));
    expect(await screen.findByText('目标：Story')).toBeTruthy();
    const voiceItems = within(panel).getAllByRole('option', { name: '选择素材 Voice' });
    expect(voiceItems).toHaveLength(1);
    expect(voiceItems[0]?.textContent).toContain('已录制');
  });

  it('source-patches an AV clip onto linked free video and audio tracks in one Project Patch', async () => {
    const bRollTrackId = '00000000-0000-4000-8000-000000000094';
    const project: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        tracks: [
          ...PROJECT.document.tracks,
          {
            id: bRollTrackId,
            name: 'B-Roll',
            kind: 'video',
            order: 2,
            muted: false,
            solo: false,
            volume: 1,
            pan: 0,
            keyframes: [],
            locked: false,
            hidden: false,
            clips: [],
          },
        ],
      },
    };
    const asset: MediaAsset = {
      id: 'asset-av',
      project_id: PROJECT.id,
      path: 'D:\\media\\av.mp4',
      name: 'AV source',
      kind: 'video',
      duration_seconds: 8,
      width: 1920,
      height: 1080,
      file_size: 8_192,
      has_audio: true,
      proxy_path: null,
      proxy_status: { status: 'not_requested' },
      waveform: [0.2, 0.8],
      metadata_status: { status: 'ready' },
      markers: [],
      created_at: PROJECT.updated_at,
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project, assets: [asset], applyProjectPatch });

    fireEvent.click(await screen.findByRole('button', { name: '设为目标轨道 B-Roll' }));
    fireEvent.click(screen.getByRole('option', { name: '选择素材 AV source' }));
    expect(screen.getByRole('button', { name: '包含源视频' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '包含源音频' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('V → B-Roll · A → Music')).toBeTruthy();
    const viewport = screen.getByRole('region', { name: '时间轴内容' });
    viewport.style.setProperty('--w-track-head', '200px');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 1_000, bottom: 400, left: 0, width: 1_000, height: 400, toJSON: () => ({}),
    });
    const source = screen.getByRole('option', { name: '选择素材 AV source' });
    const bRoll = screen.getByRole('row', { name: 'B-Roll' });
    const dataTransfer = mediaDragTransfer();
    fireEvent(source, mediaDragEvent('dragstart', dataTransfer));
    fireEvent(bRoll, mediaDragEvent('dragover', dataTransfer, { clientX: 200, ctrlKey: true }));
    fireEvent(bRoll, mediaDragEvent('drop', dataTransfer, { clientX: 200, ctrlKey: true }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'project' },
      operations: [
        expect.objectContaining({
          op: 'replace_track_clips',
          track_id: bRollTrackId,
          clips: [expect.objectContaining({
            name: 'AV source',
            link_group_id: expect.any(String),
            placement: expect.objectContaining({ start: 0, duration: 8, volume: 0 }),
          })],
        }),
        expect.objectContaining({
          op: 'replace_track_clips',
          track_id: '00000000-0000-4000-8000-000000000013',
          clips: [expect.objectContaining({
            name: 'AV source',
            link_group_id: expect.any(String),
            placement: expect.objectContaining({ start: 0, duration: 8, volume: 1 }),
          })],
        }),
      ],
    })));
    const operations = applyProjectPatch.mock.calls[0]?.[0].operations as ProjectPatch['operations'];
    const video = operations[0]?.op === 'replace_track_clips' ? operations[0].clips[0] : null;
    const audio = operations[1]?.op === 'replace_track_clips' ? operations[1].clips[0] : null;
    expect(video?.link_group_id).toBe(audio?.link_group_id);
  });

  it('can disable the source audio patch without creating a silent companion track', async () => {
    const bRollTrackId = '00000000-0000-4000-8000-000000000095';
    const project: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        tracks: [...PROJECT.document.tracks, {
          id: bRollTrackId,
          name: 'Silent B-Roll',
          kind: 'video',
          order: 2,
          muted: false,
          solo: false,
          volume: 1,
          pan: 0,
          keyframes: [],
          locked: false,
          hidden: false,
          clips: [],
        }],
      },
    };
    const asset: MediaAsset = {
      id: 'asset-silent-av',
      project_id: PROJECT.id,
      path: 'D:\\media\\silent-av.mp4',
      name: 'Silent source',
      kind: 'video',
      duration_seconds: 4,
      width: 1920,
      height: 1080,
      file_size: 4_096,
      has_audio: true,
      proxy_path: null,
      proxy_status: { status: 'not_requested' },
      waveform: [0.2],
      metadata_status: { status: 'ready' },
      markers: [],
      created_at: PROJECT.updated_at,
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project, assets: [asset], applyProjectPatch });

    fireEvent.click(await screen.findByRole('button', { name: '设为目标轨道 Silent B-Roll' }));
    fireEvent.click(screen.getByRole('option', { name: '选择素材 Silent source' }));
    fireEvent.click(screen.getByRole('button', { name: '包含源音频' }));
    expect(screen.getByText('V → Silent B-Roll')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '在播放头插入 Silent source' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'track', track_id: bRollTrackId },
      operations: [{
        op: 'replace_track_clips',
        track_id: bRollTrackId,
        clips: [expect.objectContaining({
          link_group_id: null,
          placement: expect.objectContaining({ volume: 0 }),
        })],
      }],
    })));
  });

  it('adds and removes real timeline tracks through Project operations', async () => {
    const addPatch = vi.fn();
    renderWorkspace({ applyProjectPatch: addPatch });

    await screen.findByRole('button', { name: '添加到时间轴' });
    runAddCommand('添加文字轨道');

    await waitFor(() => expect(addPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'insert_track',
        index: 2,
        track: expect.objectContaining({ name: '文字 1', kind: 'text', order: 2, clips: [] }),
      })],
    })));
  });

  it('creates an editable text clip at the playhead through one Project operation', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    await screen.findByRole('button', { name: '添加到时间轴' });
    runAddCommand('在播放头添加文字');
    const drawer = await screen.findByRole('dialog', { name: '添加文字' });
    fireEvent.change(within(drawer).getByLabelText('文字内容'), { target: { value: 'Lower third' } });
    fireEvent.change(within(drawer).getByLabelText('持续时间（秒）'), { target: { value: '3' } });
    fireEvent.click(within(drawer).getByRole('button', { name: '添加文字' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'project' },
      operations: [{
        op: 'insert_track',
        index: PROJECT.document.tracks.length,
        track: expect.objectContaining({
          kind: 'text',
          clips: [expect.objectContaining({
            name: 'Lower third',
            capture_intent: null,
            material: { kind: 'planned' },
            placement: expect.objectContaining({ start: 0, duration: 3, source_in: 0, source_out: 3 }),
            transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null },
            text: expect.objectContaining({
              content: 'Lower third',
              font_family: 'Arial',
              font_size: 72,
              color: '#FFFFFF',
              background: '#000000',
              align: 'center',
            }),
          })],
        }),
      }],
    })));
    expect(applyProjectPatch).toHaveBeenCalledTimes(1);
  });

  it('creates a canonical caption clip with caption defaults through one Project operation', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    await screen.findByRole('button', { name: '添加到时间轴' });
    runAddCommand('在播放头添加字幕');
    const drawer = await screen.findByRole('dialog', { name: '添加字幕' });
    fireEvent.change(within(drawer).getByLabelText('字幕内容'), { target: { value: 'Watch connector.' } });
    fireEvent.change(within(drawer).getByLabelText('持续时间（秒）'), { target: { value: '2.5' } });
    fireEvent.click(within(drawer).getByRole('button', { name: '添加字幕' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'insert_track',
        index: PROJECT.document.tracks.length,
        track: expect.objectContaining({
          name: '字幕 1',
          kind: 'caption',
          clips: [expect.objectContaining({
            name: 'Watch connector.',
            material: { kind: 'planned' },
            placement: expect.objectContaining({ start: 0, duration: 2.5 }),
            transform: expect.objectContaining({ y: 360 }),
            text: expect.objectContaining({ content: 'Watch connector.', font_size: 48 }),
          })],
        }),
      }],
    })));
    expect(applyProjectPatch).toHaveBeenCalledTimes(1);
  });

  it('navigates caption cues and exports the visible caption tracks as SRT', async () => {
    const caption = (id: string, start: number, content: string): TimelineClip => ({
      ...clip(id, content),
      placement: { ...clip(id, content).placement, start, duration: 2, source_out: 2 },
      transform: { ...clip(id, content).transform, y: 360 },
      text: { content, font_family: 'Arial', font_asset_id: null, font_size: 48, color: '#FFFFFF', background: '#000000', align: 'center' },
    });
    const captionTrack: TimelineTrack = {
      id: '00000000-0000-4000-8000-000000000515',
      name: 'English',
      kind: 'caption',
      order: 2,
      muted: false,
      solo: false,
      volume: 1,
      pan: 0,
      keyframes: [],
      locked: false,
      hidden: false,
      clips: [
        caption('00000000-0000-4000-8000-000000000516', 2, 'First cue'),
        caption('00000000-0000-4000-8000-000000000517', 5, 'Second cue'),
      ],
    };
    const saveBytes = vi.fn<NativeShell['saveBytes']>(() => Promise.resolve('C:\\Temp\\captions.srt'));
    renderWorkspace({
      project: { ...PROJECT, document: { ...PROJECT.document, tracks: [...PROJECT.document.tracks, captionTrack] } },
      shell: { ...unavailableNativeShell, available: true, saveBytes },
    });

    fireEvent.click(await screen.findByRole('button', { name: '下一个字幕' }));
    await waitFor(() => expect(Number(screen.getByRole('slider', { name: '时间轴播放头' }).getAttribute('aria-valuenow'))).toBe(2));
    expect(screen.getByRole('button', { name: /First cue 2\.0s/u }).className).toContain('ring-accent');
    fireEvent.click(screen.getByRole('button', { name: '下一个字幕' }));
    await waitFor(() => expect(Number(screen.getByRole('slider', { name: '时间轴播放头' }).getAttribute('aria-valuenow'))).toBe(5));
    fireEvent.click(screen.getByRole('button', { name: '上一个字幕' }));
    await waitFor(() => expect(Number(screen.getByRole('slider', { name: '时间轴播放头' }).getAttribute('aria-valuenow'))).toBe(2));

    fireEvent.click(screen.getByRole('button', { name: '导出 SRT 字幕' }));
    await waitFor(() => expect(saveBytes).toHaveBeenCalledTimes(1));
    const options = saveBytes.mock.calls[0]![0];
    expect(options.defaultFileName).toBe('captions.srt');
    expect(new TextDecoder().decode(options.bytes)).toContain('00:00:02,000 --> 00:00:04,000\r\nFirst cue');
    expect(new TextDecoder().decode(options.bytes)).toContain('00:00:05,000 --> 00:00:07,000\r\nSecond cue');
  });

  it('renders the exact In/Out range through the preview route', async () => {
    const renderProjectPreview = vi.fn(() => Promise.resolve({ job_id: 'preview-job', status: 'running' }));
    renderWorkspace({ renderProjectPreview });
    const timeline = await screen.findByRole('region', { name: '时间轴' });
    const playhead = screen.getByRole('slider', { name: '时间轴播放头' });
    fireEvent.keyDown(timeline, { key: 'i' });
    stepTimelineSeconds(playhead, 5);
    fireEvent.keyDown(timeline, { key: 'o' });
    fireEvent.pointerDown(screen.getByRole('button', { name: '时间轴显示设置' }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole('menuitem', { name: '渲染入点到出点' }));

    await waitFor(() => expect(renderProjectPreview).toHaveBeenCalledWith(PROJECT.id, {
      encoder: 'auto',
      quality: 70,
      range_start_seconds: 0,
      range_end_seconds: 5,
    }));
  });

  it('projects ready previews into Program, marks revision drift stale and clears managed previews', async () => {
    const record: ExportJobRecord = {
      kind: 'project_preview',
      job: {
        id: '00000000-0000-4000-8000-000000000600',
        project_id: PROJECT.id,
        project_revision: PROJECT.revision,
        range_start_seconds: 0,
        range_end_seconds: 5,
        status: 'completed',
        progress: 1,
        output_path: 'C:/previews/preview.mp4',
        error: null,
        error_code: null,
        created_at: '2026-09-02T00:00:00Z',
        updated_at: '2026-09-02T00:00:01Z',
      },
    };
    const clearProjectRenderPreviews = vi.fn(() => Promise.resolve({ removed: 1, cancellation_requested: 0 }));
    const first = renderWorkspace({
      listProjectRenderPreviews: vi.fn(() => Promise.resolve([record])),
      clearProjectRenderPreviews,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    const rendered = await screen.findByLabelText('已渲染时间轴预览');
    expect(rendered.getAttribute('src')).toContain(`/outputs/export/${record.job.id}/stream`);
    expect(document.querySelector('[data-render-preview-state="ready"]')).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole('button', { name: '时间轴显示设置' }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole('menuitem', { name: '删除预览文件' }));
    await waitFor(() => expect(clearProjectRenderPreviews).toHaveBeenCalledWith(PROJECT.id));
    first.unmount();

    renderWorkspace({
      project: { ...PROJECT, revision: PROJECT.revision + 1 },
      listProjectRenderPreviews: vi.fn(() => Promise.resolve([record])),
    });
    await waitFor(() => expect(document.querySelector('[data-render-preview-state="stale"]')).toBeTruthy());
    expect(screen.queryByLabelText('已渲染时间轴预览')).toBeNull();
  });

  it('creates a nested sequence from consecutive Story clips through the dedicated atomic route', async () => {
    const createNestedSequence = vi.fn(() => new Promise(() => undefined));
    renderWorkspace({ createNestedSequence });
    fireEvent.click(await screen.findByRole('button', { name: /A 5\.0s · 未录制/u }));
    fireEvent.click(screen.getByRole('button', { name: /B 5\.0s · 已录制/u }), { ctrlKey: true });
    runTimelineCommand('从所选片段创建嵌套序列…');
    const dialog = await screen.findByRole('dialog', { name: '创建嵌套序列' });
    fireEvent.change(within(dialog).getByLabelText('序列名称'), { target: { value: 'Action core' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建并打开' }));

    await waitFor(() => expect(createNestedSequence).toHaveBeenCalledWith(PROJECT.id, {
      base_revision: PROJECT.revision,
      name: 'Action core',
      clip_ids: [CLIP_A, CLIP_B],
    }));
  });

  it('opens a nested sequence by double-click, restores Sequence Tabs and previews its rendered child', async () => {
    const nestedId = '00000000-0000-4000-8000-000000000620';
    const nestedClipId = '00000000-0000-4000-8000-000000000621';
    const previewId = '00000000-0000-4000-8000-000000000622';
    const nestedClip: TimelineClip = {
      ...clip(nestedClipId, 'Action core'),
      material: { kind: 'sequence', project_id: nestedId, project_revision: 1, media_duration_seconds: 5 },
      metadata: { nested_sequence: true },
    };
    const parent: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        duration_seconds: 5,
        tracks: PROJECT.document.tracks.map((track) => track.id === STORY_ID ? { ...track, clips: [nestedClip] } : track),
      },
    };
    const nested: Project = {
      ...PROJECT,
      id: nestedId,
      name: 'Action core',
      revision: 1,
      document: { ...PROJECT.document, duration_seconds: 5, tracks: [PROJECT.document.tracks[0]!] },
    };
    globalThis.localStorage.setItem('vibe-cs:sequence-tabs:v1', JSON.stringify([parent.id, nested.id]));
    const getProject = vi.fn((id: string) => Promise.resolve(id === nested.id ? nested : parent));
    renderWorkspace({
      project: parent,
      getProject,
      listProjects: vi.fn(() => Promise.resolve([parent, nested])),
      listNestedSequenceMedia: vi.fn(() => Promise.resolve([{
        clip_id: nestedClipId,
        project_id: nestedId,
        expected_revision: 1,
        current_revision: 1,
        status: 'ready',
        preview_job_id: previewId,
      }])),
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    expect(await screen.findByRole('navigation', { name: '打开的序列' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Action core' })).toBeTruthy();
    expect((await screen.findByLabelText('Action core 视频预览')).getAttribute('src')).toContain(`/outputs/export/${previewId}/stream`);
    fireEvent.doubleClick(screen.getByRole('button', { name: /Action core 5\.0s · 已录制/u }));
    await waitFor(() => expect(getProject).toHaveBeenCalledWith(nestedId, expect.anything()));
  });

  it('refreshes a stale nested sequence through the visible Timeline command', async () => {
    const nestedId = '00000000-0000-4000-8000-000000000630';
    const nestedClipId = '00000000-0000-4000-8000-000000000631';
    const nestedClip: TimelineClip = {
      ...clip(nestedClipId, 'Nested stale'),
      material: { kind: 'sequence', project_id: nestedId, project_revision: 1, media_duration_seconds: 5 },
    };
    const parent: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        duration_seconds: 5,
        tracks: PROJECT.document.tracks.map((track) => track.id === STORY_ID ? { ...track, clips: [nestedClip] } : track),
      },
    };
    const refreshNestedSequence = vi.fn(() => new Promise(() => undefined));
    renderWorkspace({
      project: parent,
      refreshNestedSequence,
      listNestedSequenceMedia: vi.fn(() => Promise.resolve([{
        clip_id: nestedClipId,
        project_id: nestedId,
        expected_revision: 1,
        current_revision: 2,
        status: 'stale',
        preview_job_id: null,
      }])),
    });

    fireEvent.click(await screen.findByRole('button', { name: /Nested stale 5\.0s · 已录制/u }));
    runTimelineCommand('刷新所选嵌套序列');
    await waitFor(() => expect(refreshNestedSequence).toHaveBeenCalledWith(parent.id, nestedClipId, parent.revision));
  });

  it('removes a non-Story track with a real Project operation', async () => {
    const removePatch = vi.fn();
    renderWorkspace({ applyProjectPatch: removePatch });

    await screen.findByRole('button', { name: '轨道操作 Music' });
    runTrackCommand('Music', '删除轨道');

    await waitFor(() => expect(removePatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{ op: 'remove_track', track_id: '00000000-0000-4000-8000-000000000013' }],
    })));
  });

  it('renames a canonical track inline with one replace-track operation', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    fireEvent.doubleClick(await screen.findByRole('button', { name: '重命名轨道 Music' }));
    const name = screen.getByRole('textbox', { name: '轨道名称' });
    fireEvent.change(name, { target: { value: 'Music Bed' } });
    fireEvent.keyDown(name, { key: 'Enter' });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_track',
        track_id: '00000000-0000-4000-8000-000000000013',
        track: expect.objectContaining({ id: '00000000-0000-4000-8000-000000000013', name: 'Music Bed' }),
      }],
    })));
  });

  it('keeps lock and remove controls available on text tracks', async () => {
    const textTrackId = '00000000-0000-4000-8000-000000000014';
    const removePatch = vi.fn();
    renderWorkspace({
      applyProjectPatch: removePatch,
      project: {
        ...PROJECT,
        document: {
          ...PROJECT.document,
          tracks: [...PROJECT.document.tracks, {
            id: textTrackId,
            name: 'Notes',
            kind: 'text',
            order: 2,
            muted: false,
            solo: false,
            volume: 1,
            pan: 0,
            keyframes: [],
            locked: false,
            hidden: false,
            clips: [],
          }],
        },
      },
    });

    expect((await screen.findAllByRole('button', { name: '切换轨道锁定' })).length).toBeGreaterThan(3);
    runTrackCommand('Notes', '删除轨道');
    await waitFor(() => expect(removePatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{ op: 'remove_track', track_id: textTrackId }],
    })));
  });

  it('toggles video output through track.hidden instead of muting its audio', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    fireEvent.click(await screen.findByRole('button', { name: '切换视频轨道显示' }));
    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_track',
        track_id: STORY_ID,
        track: expect.objectContaining({ hidden: true, muted: false }),
      }],
    })));
  });

  it('Soloes an audio track through the canonical replace-track operation', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    const music = await screen.findByRole('row', { name: 'Music' });
    fireEvent.click(within(music).getByRole('button', { name: '切换 Solo Music' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_track',
        track_id: '00000000-0000-4000-8000-000000000013',
        track: expect.objectContaining({ solo: true }),
      }],
    })));
  });

  it('keeps output-disabled video and text tracks visible while removing them from Program', async () => {
    const textTrackId = '00000000-0000-4000-8000-000000000095';
    const hiddenProject: Project = {
      ...RECORDED_PROJECT,
      document: {
        ...RECORDED_PROJECT.document,
        tracks: [
          ...RECORDED_PROJECT.document.tracks.map((track) => track.id === STORY_ID ? { ...track, hidden: true } : track),
          {
            id: textTrackId,
            name: 'Hidden titles',
            kind: 'text',
            order: RECORDED_PROJECT.document.tracks.length,
            muted: false,
            solo: false,
            volume: 1,
            pan: 0,
            keyframes: [],
            locked: false,
            hidden: true,
            clips: [],
          },
        ],
      },
    };
    renderWorkspace({
      project: hiddenProject,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    expect(await screen.findByRole('row', { name: 'Story' })).toBeTruthy();
    expect(screen.getByRole('row', { name: 'Hidden titles' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '切换视频轨道显示' })).toHaveLength(2);
    expect(screen.getByRole('region', { name: '视频预览' }).querySelectorAll('video[data-preview-active="true"]')).toHaveLength(0);
  });

  it('reorders non-Story tracks through the canonical reorder operation', async () => {
    const textTrackId = '00000000-0000-4000-8000-000000000017';
    const reorderPatch = vi.fn();
    renderWorkspace({
      applyProjectPatch: reorderPatch,
      project: {
        ...PROJECT,
        document: {
          ...PROJECT.document,
          tracks: [...PROJECT.document.tracks, {
            id: textTrackId,
            name: 'Notes',
            kind: 'text',
            order: 2,
            muted: false,
            solo: false,
            volume: 1,
            pan: 0,
            keyframes: [],
            locked: false,
            hidden: false,
            clips: [],
          }],
        },
      },
    });

    await screen.findByRole('button', { name: '轨道操作 Music' });
    runTrackCommand('Music', '下移轨道');
    await waitFor(() => expect(reorderPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'reorder_tracks',
        track_ids: [STORY_ID, textTrackId, '00000000-0000-4000-8000-000000000013'],
      }],
    })));
  });

  it('opens clip properties on demand and writes against the same revision', async () => {
    const applyProjectPatch = vi.fn(() => Promise.resolve({
      project: { ...PROJECT, revision: 2 },
      change_group: {
        id: '00000000-0000-4000-8000-000000000020',
        project_id: PROJECT.id,
        from_revision: 1,
        to_revision: 2,
        author: { kind: 'human' },
        status: 'completed',
        summary: '修改 A',
        reverts_change_group_id: null,
        operations: [],
        inverse_operations: [],
        created_at: PROJECT.updated_at,
        completed_at: PROJECT.updated_at,
      },
    }));
    renderWorkspace({ applyProjectPatch });
    const clipButton = await screen.findByRole('button', { name: /A 5\.0s · 未录制/u });
    fireEvent.doubleClick(clipButton);
    const name = await screen.findByRole('textbox', { name: '名称' });
    fireEvent.change(name, { target: { value: 'A revised' } });
    fireEvent.change(screen.getByRole('combobox', { name: '视频入场转场' }), { target: { value: 'fade' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: '视频入场转场 持续时间' }), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => {
      expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
        project_id: PROJECT.id,
        base_revision: 1,
        operations: [expect.objectContaining({
          op: 'replace_track_clips',
          track_id: STORY_ID,
          clips: expect.arrayContaining([expect.objectContaining({
            id: CLIP_A,
            name: 'A revised',
            transitions: expect.objectContaining({ video_in: { kind: 'fade', duration_seconds: 0.5 } }),
          })]),
        })],
      }));
    });
  });

  it('authors and reorders only renderer-backed clip effects', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    fireEvent.doubleClick(await screen.findByRole('button', { name: /A 5\.0s · 未录制/u }));
    const kind = await screen.findByRole('combobox', { name: '添加效果类型' });
    fireEvent.change(kind, { target: { value: 'color_adjust' } });
    fireEvent.click(screen.getByRole('button', { name: '添加效果' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '颜色调整 亮度' }), { target: { value: '0.25' } });
    fireEvent.change(kind, { target: { value: 'blur' } });
    fireEvent.click(screen.getByRole('button', { name: '添加效果' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '模糊 半径' }), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: '上移效果 模糊' }));
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        clips: expect.arrayContaining([expect.objectContaining({
          id: CLIP_A,
          effects: [
            expect.objectContaining({ kind: 'blur', enabled: true, parameters: { radius: 5 } }),
            expect.objectContaining({ kind: 'color_adjust', enabled: true, parameters: { brightness: 0.25, contrast: 1, saturation: 1 } }),
          ],
        })]),
      })],
    })));
  });

  it('authors frame-aligned transform keyframes at the shared playhead', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    fireEvent.doubleClick(await screen.findByRole('button', { name: /A 5\.0s · 未录制/u }));
    const x = await screen.findByRole('spinbutton', { name: '位置 X' });
    fireEvent.change(x, { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: '在播放头添加 位置 X 关键帧' }));
    stepTimelineSeconds(screen.getByRole('slider', { name: '时间轴播放头' }), 1);
    expect((screen.getByRole('spinbutton', { name: '位置 X' }) as HTMLInputElement).value).toBe('100');
    fireEvent.change(screen.getByRole('spinbutton', { name: '位置 X' }), { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: '上一个关键帧' }));
    expect(Number(screen.getByRole('slider', { name: '时间轴播放头' }).getAttribute('aria-valuenow'))).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: '下一个关键帧' }));
    expect(Number(screen.getByRole('slider', { name: '时间轴播放头' }).getAttribute('aria-valuenow'))).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: expect.arrayContaining([expect.objectContaining({
          id: CLIP_A,
          transform: expect.objectContaining({ x: 100 }),
          keyframes: [
            expect.objectContaining({ time: 0, property: 'x', value: 100 }),
            expect.objectContaining({ time: 1, property: 'x', value: 200 }),
          ],
        })]),
      })],
    })));
  });

  it('authors Bezier interpolation and tangents on the canonical keyframe', async () => {
    const project: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        tracks: PROJECT.document.tracks.map((track) => track.id !== STORY_ID ? track : {
          ...track,
          clips: track.clips.map((candidate) => candidate.id !== CLIP_A ? candidate : {
            ...candidate,
            keyframes: [
              { id: 'x-0', time: 0, property: 'x', value: 0, interpolation: 'linear', in_tangent: 0, out_tangent: 0 },
              { id: 'x-1', time: 1, property: 'x', value: 100, interpolation: 'linear', in_tangent: 0, out_tangent: 0 },
            ],
          }),
        }),
      },
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project, applyProjectPatch });
    fireEvent.doubleClick(await screen.findByRole('button', { name: /A 5\.0s · 未录制/u }));
    fireEvent.change(screen.getByRole('combobox', { name: 'x 插值' }), { target: { value: 'bezier' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'x 出切线' }), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        clips: expect.arrayContaining([expect.objectContaining({
          id: CLIP_A,
          keyframes: expect.arrayContaining([expect.objectContaining({ id: 'x-0', interpolation: 'bezier', out_tangent: 2 })]),
        })]),
      })],
    })));
  });

  it('authors Volume keyframes from Inspector and keeps base volume unchanged', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    fireEvent.doubleClick(await screen.findByRole('button', { name: /A 5\.0s · 未录制/u }));
    fireEvent.click(await screen.findByRole('button', { name: '在播放头添加 音量 关键帧' }));
    stepTimelineSeconds(screen.getByRole('slider', { name: '时间轴播放头' }), 1);
    fireEvent.change(screen.getByRole('spinbutton', { name: '音量' }), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        clips: expect.arrayContaining([expect.objectContaining({
          id: CLIP_A,
          placement: expect.objectContaining({ volume: 1 }),
          keyframes: [
            expect.objectContaining({ time: 0, property: 'volume', value: 1 }),
            expect.objectContaining({ time: 1, property: 'volume', value: 2 }),
          ],
        })]),
      })],
    })));
  });

  it('projects grouped keyframe diamonds onto the canonical clip and seeks them', async () => {
    const project: Project = {
      ...PROJECT,
      document: {
        ...PROJECT.document,
        tracks: PROJECT.document.tracks.map((track) => track.id !== STORY_ID ? track : {
          ...track,
          clips: track.clips.map((candidate) => candidate.id !== CLIP_A ? candidate : {
            ...candidate,
            keyframes: [
              { id: 'x-1', time: 1, property: 'x', value: 100, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0  },
              { id: 'opacity-1', time: 1, property: 'opacity', value: 0.5, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0  },
              { id: 'x-3', time: 3, property: 'x', value: 200, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0  },
            ],
          }),
        }),
      },
    };
    renderWorkspace({ project });

    fireEvent.click(await screen.findByRole('button', { name: '关键帧 00:01.000 2 个属性' }));
    expect(Number(screen.getByRole('slider', { name: '时间轴播放头' }).getAttribute('aria-valuenow'))).toBe(1);
    expect(screen.getByRole('button', { name: '关键帧 00:03.000 1 个属性' })).toBeTruthy();
  });

  it('renders Agent text, tool output and HITL in one conversation flow', async () => {
    const session: AgentSession = {
      id: '00000000-0000-4000-8000-000000000030',
      title: 'Agent · 统一作品',
      created_at: '2026-08-28T10:00:00Z',
      updated_at: '2026-08-28T10:01:00Z',
      entries: [
        { kind: 'user', id: 'u-1', at: '2026-08-28T10:00:00Z', content: '剪成三分钟集锦' },
        {
          kind: 'assistant',
          id: 'a-1',
          at: '2026-08-28T10:01:00Z',
          content: '时间线已经重排，接下来需要录制缺失片段。',
          tool_calls: [
            { id: 'request-1:tool:1', name: 'read_workspace', input: {}, output: { revision: 1 }, status: 'completed' },
            {
              id: 'request-1:tool:2',
              name: 'request_project_recording',
              input: { projectId: PROJECT.id, baseRevision: 1, clipIds: [CLIP_A] },
              output: {
                status: 'requires_human_confirmation',
                action: 'recording',
                projectId: PROJECT.id,
                baseRevision: 1,
                request: {},
              },
              status: 'awaiting_confirmation',
            },
          ],
          status: 'completed',
          request_id: 'request-1',
          retry_of: null,
          error: null,
          metadata: null,
        },
      ],
    };
    renderWorkspace({ session });

    expect(await screen.findByText('剪成三分钟集锦')).toBeTruthy();
    expect(screen.getByText('时间线已经重排，接下来需要录制缺失片段。')).toBeTruthy();
    expect(screen.getByText('读取作品摘要')).toBeTruthy();
    expect(screen.getByText('请求录制片段')).toBeTruthy();
    expect(screen.getByText('需要你的确认')).toBeTruthy();
    expect(screen.getByRole('button', { name: '允许录制' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeTruthy();
  });

  it('keeps Agent export HITL inside the tool result and disabled until Delivery Gate passes', async () => {
    const session: AgentSession = {
      id: '00000000-0000-4000-8000-000000000034',
      title: 'Agent · blocked export',
      created_at: '2026-08-28T10:00:00Z',
      updated_at: '2026-08-28T10:01:00Z',
      entries: [{
        kind: 'assistant', id: 'a-blocked-export', at: '2026-08-28T10:01:00Z', content: '',
        tool_calls: [{
          id: 'request-blocked:tool:1',
          name: 'request_project_export',
          input: { projectId: PROJECT.id, baseRevision: PROJECT.revision },
          output: { status: 'requires_human_confirmation', action: 'export', projectId: PROJECT.id, baseRevision: PROJECT.revision },
          status: 'awaiting_confirmation',
        }],
        status: 'completed', request_id: 'request-blocked', retry_of: null, error: null, metadata: null,
      }],
    };
    renderWorkspace({ session });

    const allow = await screen.findByRole('button', { name: '允许导出' }) as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    expect(screen.getByText('时间线仍有未就绪素材；先录制、重录或重新链接后才能允许导出。')).toBeTruthy();
    expect(screen.queryByText('你 · 确认')).toBeNull();
  });

  it('expires Agent external execution confirmation when the Project revision changes', async () => {
    const session: AgentSession = {
      id: '00000000-0000-4000-8000-000000000035',
      title: 'Agent · stale export',
      created_at: '2026-08-28T10:00:00Z',
      updated_at: '2026-08-28T10:01:00Z',
      entries: [{
        kind: 'assistant', id: 'a-stale-export', at: '2026-08-28T10:01:00Z', content: '',
        tool_calls: [{
          id: 'request-stale:tool:1',
          name: 'request_project_export',
          input: { projectId: RECORDED_PROJECT.id, baseRevision: RECORDED_PROJECT.revision + 1 },
          output: {
            status: 'requires_human_confirmation', action: 'export',
            projectId: RECORDED_PROJECT.id, baseRevision: RECORDED_PROJECT.revision + 1,
          },
          status: 'awaiting_confirmation',
        }],
        status: 'completed', request_id: 'request-stale', retry_of: null, error: null, metadata: null,
      }],
    };
    renderWorkspace({ project: RECORDED_PROJECT, session });

    expect(await screen.findByText('作品版本已变化，这次请求已经过期。请拒绝后让 Agent 重新请求。')).toBeTruthy();
    expect((screen.getByRole('button', { name: '允许导出' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows an Agent tool error instead of claiming that the edit was committed', async () => {
    const session: AgentSession = {
      id: '00000000-0000-4000-8000-000000000032',
      title: 'Agent · failed patch',
      created_at: '2026-08-28T10:00:00Z',
      updated_at: '2026-08-28T10:01:00Z',
      entries: [{
        kind: 'assistant',
        id: 'a-failed-patch',
        at: '2026-08-28T10:01:00Z',
        content: '',
        tool_calls: [{
          id: 'request-failed:tool:1',
          name: 'apply_project_patch',
          input: { projectId: PROJECT.id, baseRevision: 1 },
          output: { error: 'invalid Project Patch: missing field id' },
          status: 'failed',
        }],
        status: 'completed',
        request_id: 'request-failed',
        retry_of: null,
        error: null,
        metadata: null,
      }],
    };

    renderWorkspace({ session });

    expect(await screen.findByText('执行失败')).toBeTruthy();
    expect(screen.getByText('invalid Project Patch: missing field id')).toBeTruthy();
    expect(screen.queryByText('增量修改已提交到统一时间线。')).toBeNull();
  });

  it('renders Agent GitHub-flavored Markdown tables as accessible tables', async () => {
    const openExternalUrl = vi.fn(() => Promise.resolve(true));
    const session: AgentSession = {
      id: '00000000-0000-4000-8000-000000000030',
      title: 'Agent · Markdown',
      created_at: '2026-08-28T10:00:00Z',
      updated_at: '2026-08-28T10:01:00Z',
      entries: [{
        kind: 'assistant', id: 'a-markdown', at: '2026-08-28T10:01:00Z',
        content: '| 交付项 | 说明 |\n| --- | --- |\n| 时间线微调 | 换片段、改顺序 |\n\n[打开参考](https://example.com/reference)',
        tool_calls: [], status: 'completed', request_id: 'request-markdown',
        retry_of: null, error: null, metadata: null,
      }],
    };
    renderWorkspace({
      session,
      shell: { ...unavailableNativeShell, available: true, openExternalUrl },
    });

    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: '交付项' })).toBeTruthy();
    expect(within(table).getByRole('cell', { name: '换片段、改顺序' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: '打开参考' }));
    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/reference');
  });

  it('binds a persisted HITL decision to one tool call instead of clearing it with arbitrary text', async () => {
    const session: AgentSession = {
      id: '00000000-0000-4000-8000-000000000031',
      title: 'Agent · HITL',
      created_at: '2026-08-28T10:00:00Z',
      updated_at: '2026-08-28T10:02:00Z',
      entries: [
        {
          kind: 'assistant', id: 'a-hitl', at: '2026-08-28T10:01:00Z', content: '',
          tool_calls: [{
            id: 'request-hitl:tool:1',
            name: 'request_project_export',
            input: { projectId: PROJECT.id, baseRevision: PROJECT.revision },
            output: { status: 'requires_human_confirmation', action: 'export', projectId: PROJECT.id, baseRevision: PROJECT.revision },
            status: 'awaiting_confirmation',
          }],
          status: 'completed', request_id: 'request-hitl', retry_of: null, error: null, metadata: null,
        },
        { kind: 'user', id: 'unrelated', at: '2026-08-28T10:01:30Z', content: '这是一条无关文本。' },
        {
          kind: 'tool_decision', id: 'decision-1', at: '2026-08-28T10:02:00Z',
          tool_call_id: 'request-hitl:tool:1', decision: 'approved', content: '允许导出。',
        },
      ],
    };
    renderWorkspace({ session });

    const tool = await screen.findByText('请求导出');
    const toolCard = tool.closest('[data-tool-call-id="request-hitl:tool:1"]');
    expect(toolCard?.getAttribute('data-tool-call-decision')).toBe('approved');
    expect(within(toolCard as HTMLElement).getByText('已允许')).toBeTruthy();
    expect(within(toolCard as HTMLElement).getByText('允许导出。')).toBeTruthy();
    expect(screen.queryByText('你 · 确认')).toBeNull();
    expect(screen.queryByRole('button', { name: '允许导出' })).toBeNull();
    expect(screen.queryByRole('button', { name: '拒绝' })).toBeNull();
  });

  it('records a rejected HITL decision without creating another user and Agent turn', async () => {
    const session: AgentSession = {
      id: '00000000-0000-4000-8000-000000000033',
      title: 'Agent · reject export',
      created_at: '2026-08-28T10:00:00Z',
      updated_at: '2026-08-28T10:01:00Z',
      entries: [{
        kind: 'assistant', id: 'a-reject', at: '2026-08-28T10:01:00Z', content: '',
        tool_calls: [{
          id: 'request-reject:tool:1', name: 'request_project_export',
          input: { projectId: PROJECT.id, baseRevision: PROJECT.revision },
          output: { status: 'requires_human_confirmation', action: 'export', projectId: PROJECT.id, baseRevision: PROJECT.revision },
          status: 'awaiting_confirmation',
        }],
        status: 'completed', request_id: 'request-reject', retry_of: null, error: null, metadata: null,
      }],
    };
    let sequence = 0;
    const appendAgentSessionEntry = vi.fn(async (_sessionId: string, draft: AgentSessionEntryDraft) => {
      sequence += 1;
      if (draft.kind === 'tool_decision') {
        return {
          kind: 'tool_decision' as const, id: `decision-${sequence}`, at: '2026-08-28T10:02:00Z',
          tool_call_id: draft.tool_call_id, decision: draft.decision, content: draft.content,
        };
      }
      if (draft.kind === 'user') {
        return { kind: 'user' as const, id: `user-${sequence}`, at: '2026-08-28T10:02:00Z', content: draft.content };
      }
      return {
        kind: 'assistant' as const, id: `assistant-${sequence}`, at: '2026-08-28T10:02:00Z',
        content: draft.content, tool_calls: draft.tool_calls, status: draft.status,
        request_id: draft.request_id, retry_of: draft.retry_of, error: draft.error, metadata: draft.metadata,
      };
    });
    const streamAgentChat = vi.fn(async () => ({ sessionId: 'unexpected-follow-up' }));
    const updateAgentTurn = vi.fn(async (_sessionId: string, entryId: string, update: AgentTurnUpdate) => ({
      kind: 'assistant' as const, id: entryId, at: '2026-08-28T10:02:00Z',
      request_id: 'unexpected-follow-up', retry_of: null, ...update,
    }));
    renderWorkspace({ session, appendAgentSessionEntry, streamAgentChat, updateAgentTurn });

    fireEvent.click(await screen.findByRole('button', { name: '拒绝' }));
    await waitFor(() => expect(appendAgentSessionEntry).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({
        kind: 'tool_decision', tool_call_id: 'request-reject:tool:1', decision: 'rejected',
      }),
    ));
    expect(streamAgentChat).not.toHaveBeenCalled();
  });

  it('blocks sending and points to model settings when Agent configuration is missing', async () => {
    renderWorkspace({ agentConfigured: false });

    expect(await screen.findByText('还没配置 Agent 模型')).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开模型设置' })).toBeTruthy();
    expect((screen.getByPlaceholderText('先配置 Agent 模型') as HTMLInputElement).disabled).toBe(true);
  });

  it('offers delivery only for a change made by the current session after its latest instruction', async () => {
    const session: AgentSession = {
      id: '00000000-0000-4000-8000-000000000050',
      title: 'Agent · 统一作品',
      created_at: '2026-08-28T10:00:00Z',
      updated_at: '2026-08-28T10:02:00Z',
      entries: [
        { kind: 'user', id: 'u-2', at: '2026-08-28T10:01:00Z', content: '只读取，不要修改' },
        {
          kind: 'assistant',
          id: 'a-2',
          at: '2026-08-28T10:02:00Z',
          content: '已读取，没有修改。',
          tool_calls: [{ id: 'request-2:tool:1', name: 'read_workspace', input: {}, output: { revision: 1 }, status: 'completed' }],
          status: 'completed',
          request_id: 'request-2',
          retry_of: null,
          error: null,
          metadata: null,
        },
      ],
    };
    const oldGroup: ProjectChangeGroup = {
      id: '00000000-0000-4000-8000-000000000051',
      project_id: PROJECT.id,
      from_revision: 1,
      to_revision: 2,
      author: { kind: 'agent', session_id: session.id, turn_id: 'old-turn' },
      status: 'completed',
      summary: '更早的修改',
      reverts_change_group_id: null,
      operations: [],
      inverse_operations: [],
      created_at: '2026-08-28T09:00:00Z',
      completed_at: '2026-08-28T09:00:01Z',
    };

    renderWorkspace({ session, groups: [oldGroup] });
    expect(await screen.findByText('已读取，没有修改。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '接受交付' })).toBeNull();
  });

  it('offers delivery actions for the current session change', async () => {
    const session: AgentSession = {
      id: '00000000-0000-4000-8000-000000000060',
      title: 'Agent · 统一作品',
      created_at: '2026-08-28T10:00:00Z',
      updated_at: '2026-08-28T10:02:00Z',
      entries: [
        { kind: 'user', id: 'u-3', at: '2026-08-28T10:01:00Z', content: '重排时间线' },
        {
          kind: 'assistant',
          id: 'a-3',
          at: '2026-08-28T10:02:00Z',
          content: '已经完成。',
          tool_calls: [{ id: 'request-3:tool:1', name: 'replace_story_timeline', input: {}, output: { revision: 2 }, status: 'completed' }],
          status: 'completed',
          request_id: 'request-3',
          retry_of: null,
          error: null,
          metadata: null,
        },
      ],
    };
    const currentGroup: ProjectChangeGroup = {
      id: '00000000-0000-4000-8000-000000000061',
      project_id: PROJECT.id,
      from_revision: 1,
      to_revision: 2,
      author: { kind: 'agent', session_id: session.id, turn_id: 'request-3' },
      status: 'completed',
      summary: '重排时间线',
      reverts_change_group_id: null,
      operations: [],
      inverse_operations: [],
      created_at: '2026-08-28T10:01:30Z',
      completed_at: '2026-08-28T10:01:31Z',
    };

    const appendAgentSessionEntry = vi.fn(async (_sessionId: string, draft: AgentSessionEntryDraft) => {
      if (draft.kind !== 'tool_decision') throw new Error('expected delivery decision');
      return {
        kind: 'tool_decision' as const,
        id: 'delivery-review',
        at: '2026-08-28T10:03:00Z',
        tool_call_id: draft.tool_call_id,
        decision: draft.decision,
        content: draft.content,
      };
    });
    renderWorkspace({ session, groups: [currentGroup], appendAgentSessionEntry });
    expect(await screen.findByRole('button', { name: '接受交付' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '退回修改' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '直接修改' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '接受交付' }));
    await waitFor(() => expect(appendAgentSessionEntry).toHaveBeenCalledWith(session.id, {
      kind: 'tool_decision',
      tool_call_id: `delivery:${currentGroup.id}`,
      decision: 'approved',
      content: '已接受这组 Agent 修改。',
    }));
  });

  it('collects return feedback in the existing Agent input before starting a revision turn', async () => {
    const session: AgentSession = {
      id: '00000000-0000-4000-8000-000000000064',
      title: 'Agent · return feedback',
      created_at: '2026-08-28T10:00:00Z',
      updated_at: '2026-08-28T10:02:00Z',
      entries: [
        { kind: 'user', id: 'u-return', at: '2026-08-28T10:01:00Z', content: '新增标记' },
        {
          kind: 'assistant', id: 'a-return', at: '2026-08-28T10:02:00Z', content: '已经完成。',
          tool_calls: [], status: 'completed', request_id: 'request-return', retry_of: null, error: null, metadata: null,
        },
      ],
    };
    const group: ProjectChangeGroup = {
      id: '00000000-0000-4000-8000-000000000065',
      project_id: PROJECT.id,
      from_revision: 1,
      to_revision: 2,
      author: { kind: 'agent', session_id: session.id, turn_id: 'request-return' },
      status: 'completed',
      summary: '新增标记',
      reverts_change_group_id: null,
      operations: [],
      inverse_operations: [],
      created_at: '2026-08-28T10:01:30Z',
      completed_at: '2026-08-28T10:01:31Z',
    };
    let sequence = 0;
    const appendAgentSessionEntry = vi.fn(async (_sessionId: string, draft: AgentSessionEntryDraft) => {
      sequence += 1;
      if (draft.kind === 'tool_decision') {
        return {
          kind: 'tool_decision' as const, id: `decision-${sequence}`, at: '2026-08-28T10:03:00Z',
          tool_call_id: draft.tool_call_id, decision: draft.decision, content: draft.content,
        };
      }
      if (draft.kind === 'user') {
        return { kind: 'user' as const, id: `user-${sequence}`, at: '2026-08-28T10:03:00Z', content: draft.content };
      }
      return {
        kind: 'assistant' as const, id: `assistant-${sequence}`, at: '2026-08-28T10:03:00Z',
        content: draft.content, tool_calls: draft.tool_calls, status: draft.status,
        request_id: draft.request_id, retry_of: draft.retry_of, error: draft.error, metadata: draft.metadata,
      };
    });
    const streamAgentChat = vi.fn(async () => ({ sessionId: 'return-feedback-turn' }));
    const updateAgentTurn = vi.fn(async (_sessionId: string, entryId: string, update: AgentTurnUpdate) => ({
      kind: 'assistant' as const, id: entryId, at: '2026-08-28T10:03:01Z',
      request_id: 'return-feedback-turn', retry_of: null, ...update,
    }));
    renderWorkspace({
      session,
      groups: [group],
      appendAgentSessionEntry,
      streamAgentChat,
      updateAgentTurn,
    });

    fireEvent.click(await screen.findByRole('button', { name: '退回修改' }));
    expect(appendAgentSessionEntry).not.toHaveBeenCalled();
    expect(screen.getByText('说明需要 Agent 修改什么')).toBeTruthy();
    const feedback = screen.getByPlaceholderText('例如：删除第二个标记，并保持其他内容不变');
    await waitFor(() => expect(document.activeElement).toBe(feedback));
    fireEvent.change(feedback, { target: { value: '删除第二个标记，保留第一个标记。' } });
    fireEvent.click(screen.getByRole('button', { name: '发送修改意见' }));

    await waitFor(() => expect(appendAgentSessionEntry).toHaveBeenCalledWith(session.id, {
      kind: 'tool_decision',
      tool_call_id: `delivery:${group.id}`,
      decision: 'rejected',
      content: '已退回这组 Agent 修改。修改意见：删除第二个标记，保留第一个标记。',
    }));
    await waitFor(() => expect(streamAgentChat).toHaveBeenCalledWith(
      expect.objectContaining({ message: '退回修改意见：删除第二个标记，保留第一个标记。' }),
      expect.any(Function),
    ));
  });

  it('restores an accepted delivery review against its exact Agent Change Group', async () => {
    const groupId = '00000000-0000-4000-8000-000000000063';
    const session: AgentSession = {
      id: '00000000-0000-4000-8000-000000000062',
      title: 'Agent · accepted review',
      created_at: '2026-08-28T10:00:00Z',
      updated_at: '2026-08-28T10:03:00Z',
      entries: [
        { kind: 'user', id: 'u-review', at: '2026-08-28T10:01:00Z', content: '重排时间线' },
        {
          kind: 'assistant', id: 'a-review', at: '2026-08-28T10:02:00Z', content: '已经完成。',
          tool_calls: [], status: 'completed', request_id: 'request-review', retry_of: null, error: null, metadata: null,
        },
        {
          kind: 'tool_decision', id: 'delivery-review', at: '2026-08-28T10:03:00Z',
          tool_call_id: `delivery:${groupId}`, decision: 'approved', content: '已接受这组 Agent 修改。',
        },
      ],
    };
    const group: ProjectChangeGroup = {
      id: groupId,
      project_id: PROJECT.id,
      from_revision: 1,
      to_revision: 2,
      author: { kind: 'agent', session_id: session.id, turn_id: 'request-review' },
      status: 'completed',
      summary: '重排时间线',
      reverts_change_group_id: null,
      operations: [],
      inverse_operations: [],
      created_at: '2026-08-28T10:01:30Z',
      completed_at: '2026-08-28T10:01:31Z',
    };

    renderWorkspace({ session, groups: [group] });
    expect(await screen.findByText('已接受 Agent 修改')).toBeTruthy();
    expect(screen.getByText(groupId)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '接受交付' })).toBeNull();
    expect(screen.queryByText('Agent 修改待审阅')).toBeNull();
  });

  it('locks human timeline controls immediately when Agent streaming starts before Lease polling', async () => {
    const session: AgentSession = {
      id: '00000000-0000-4000-8000-000000000070',
      title: 'Agent · 统一作品',
      created_at: '2026-08-28T10:00:00Z',
      updated_at: '2026-08-28T10:00:00Z',
      entries: [],
    };
    let finishStream!: () => void;
    const pendingStream = new Promise<void>((resolve) => { finishStream = resolve; });
    const streamAgentChat = vi.fn(async () => {
      await pendingStream;
      return { sessionId: 'thread-streaming-lock' };
    });
    const appendAgentSessionEntry = vi.fn(async (_sessionId: string, draft: AgentSessionEntryDraft) => {
      if (draft.kind === 'user') return { kind: 'user' as const, id: 'stream-user', at: PROJECT.updated_at, content: draft.content };
      if (draft.kind !== 'assistant') throw new Error('expected an assistant streaming turn');
      return {
        kind: 'assistant' as const,
        id: 'stream-assistant',
        at: PROJECT.updated_at,
        content: draft.content,
        tool_calls: draft.tool_calls,
        status: draft.status,
        request_id: draft.request_id,
        retry_of: draft.retry_of,
        error: draft.error,
        metadata: draft.metadata,
      };
    });
    const updateAgentTurn = vi.fn(async (_sessionId: string, entryId: string, update: AgentTurnUpdate) => ({
      kind: 'assistant' as const,
      id: entryId,
      at: PROJECT.updated_at,
      content: update.content,
      tool_calls: update.tool_calls,
      status: update.status,
      request_id: 'stream-request',
      retry_of: null,
      error: update.error,
      metadata: update.metadata,
    }));
    renderWorkspace({
      session,
      lease: null,
      streamAgentChat,
      appendAgentSessionEntry,
      updateAgentTurn,
      cancelAgentChat: vi.fn(async () => true),
    });

    fireEvent.click(await screen.findByRole('button', { name: /B 5\.0s/u }));
    const input = await screen.findByPlaceholderText('例如：重新规划成 3 分钟 NiKo 集锦');
    fireEvent.change(input, { target: { value: '只添加一个标记' } });
    fireEvent.click(screen.getByRole('button', { name: '发送给 Agent' }));
    await waitFor(() => expect(streamAgentChat).toHaveBeenCalledTimes(1));
    expect(streamAgentChat).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceContext: expect.objectContaining({ selectedClipId: CLIP_B }),
      }),
      expect.any(Function),
    );

    expect(screen.getByText('Agent 正在编辑 · 你暂时只能查看')).toBeTruthy();
    openAddCommands();
    expect(screen.getByRole('menuitem', { name: '在播放头添加文字' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(screen.getByRole('menu', { name: '添加到时间轴' }), { key: 'Escape' });
    openMarkerCommands();
    expect(screen.getByRole('menuitem', { name: '在播放头添加标记' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(screen.getByRole('menu', { name: '标记操作' }), { key: 'Escape' });

    finishStream();
    await waitFor(() => expect(updateAgentTurn).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: '添加到时间轴' })).toBeTruthy());
    openAddCommands();
    expect(screen.getByRole('menuitem', { name: '在播放头添加文字' }).getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.keyDown(screen.getByRole('menu', { name: '添加到时间轴' }), { key: 'Escape' });
    openMarkerCommands();
    expect(screen.getByRole('menuitem', { name: '在播放头添加标记' }).getAttribute('aria-disabled')).not.toBe('true');
  });

  it('shows the Agent lease inside the conversation and makes human controls read-only', async () => {
    renderWorkspace({
      project: {
        ...PROJECT,
        document: {
          ...PROJECT.document,
          tracks: PROJECT.document.tracks.map((track) => track.id === STORY_ID
            ? { ...track, locked: true }
            : track),
        },
      },
      lease: {
        id: '00000000-0000-4000-8000-000000000040',
        project_id: PROJECT.id,
        session_id: '00000000-0000-4000-8000-000000000041',
        turn_id: '00000000-0000-4000-8000-000000000042',
        base_revision: 1,
        acquired_at: '2026-08-28T10:00:00Z',
        heartbeat_at: '2026-08-28T10:00:01Z',
      },
    });

    expect(await screen.findByText('Agent 正在编辑 · 你暂时只能查看')).toBeTruthy();
    expect((screen.getByPlaceholderText('例如：重新规划成 3 分钟 NiKo 集锦') as HTMLInputElement).disabled).toBe(true);
    expect((within(screen.getByRole('row', { name: 'Story' })).getByRole('button', { name: '切换轨道锁定' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.doubleClick(screen.getByRole('button', { name: /A 5\.0s · 未录制/u }));
    expect((await screen.findByRole('textbox', { name: '名称' }) as HTMLInputElement).disabled).toBe(true);
  });
});
