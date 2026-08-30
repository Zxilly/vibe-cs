import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentSession, AgentSessionEntryDraft, AgentTurnUpdate, MediaAsset, Project, ProjectChangeGroup, ProjectDeliveryGate, ProjectEditLease, ProjectPatch, ProjectPatchResult, TimelineClip } from '../shared/desktop/dto';
import { unavailableNativeShell, type NativeShell } from '../data/nativeShell';
import { renderPage } from './delivery/test/renderPage';
import { ProjectWorkspacePage } from './ProjectWorkspacePage';

vi.mock('flexlayout-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('flexlayout-react')>();
  const React = await import('react');
  const panelIds = ['project-panel', 'program-panel', 'tactical-panel', 'timeline-panel', 'agent-panel'];
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
    placement: { start: 0, duration: 5, source_in: 0, source_out: 5, speed: 1, volume: 1, enabled: true },
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    effects: [],
    transition_in: null,
    transition_out: null,
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
        locked: false,
        hidden: false,
        clips: [
          clip(CLIP_A, 'A'),
          {
            ...clip(CLIP_B, 'B'),
            material: { kind: 'asset', asset_id: 'asset-b', media_duration_seconds: 5 },
            placement: { start: 5, duration: 5, source_in: 0, source_out: 5, speed: 1, volume: 1, enabled: true },
          },
        ],
      },
      { id: '00000000-0000-4000-8000-000000000013', name: 'Music', kind: 'audio', order: 1, muted: false, locked: false, hidden: false, clips: [] },
    ],
    markers: [],
    settings: { source_demo_ids: [] },
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
          placement: { start: 5, duration: 5, source_in: 1, source_out: 6, speed: 1, volume: 1, enabled: true },
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
    placement: { start: 12, duration: 5, source_in: 0, source_out: 5, speed: 1, volume: 1, enabled: true },
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
  readonly getProject?: (() => Promise<Project>) | undefined;
  readonly getActivity?: ReturnType<typeof vi.fn> | undefined;
  readonly listMediaAssets?: ReturnType<typeof vi.fn> | undefined;
  readonly createProjectRecordingPlan?: ReturnType<typeof vi.fn> | undefined;
  readonly executeRecordingPlan?: ReturnType<typeof vi.fn> | undefined;
  readonly exportProject?: ReturnType<typeof vi.fn> | undefined;
  readonly cancelExportJob?: ReturnType<typeof vi.fn> | undefined;
  readonly relinkMediaAsset?: ReturnType<typeof vi.fn> | undefined;
  readonly deleteMediaAsset?: ReturnType<typeof vi.fn> | undefined;
  readonly streamAgentChat?: ReturnType<typeof vi.fn> | undefined;
  readonly appendAgentSessionEntry?: ReturnType<typeof vi.fn> | undefined;
  readonly updateAgentTurn?: ReturnType<typeof vi.fn> | undefined;
  readonly cancelAgentChat?: ReturnType<typeof vi.fn> | undefined;
  readonly shell?: NativeShell | undefined;
} = {}) {
  return renderPage({
    element: <ProjectWorkspacePage />,
    client: {
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
    expect(screen.getByRole('tab', { name: '时间轴（变更审阅）' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Agent' })).toBeTruthy();
    expect(document.querySelector('[data-dock-panel="project"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重置工作区布局' })).toBeTruthy();
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

    expect(await screen.findByRole('button', { name: '取消导出任务' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看成品' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消导出任务' }));
    await waitFor(() => expect(cancelExportJob).toHaveBeenCalledWith(jobId));
  });

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

    expect(await screen.findByRole('tab', { name: '时间轴（变更审阅）' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: '变更摘要' })).toBeNull();
    expect(screen.getByText('1 处变更')).toBeTruthy();
    expect(screen.getByLabelText('时间轴变更 1').textContent).toContain('5.000s');
    expect(screen.getByLabelText('时间轴变更 1').textContent).toContain('7.000s');
    expect(screen.getByLabelText('时间轴变更 1').textContent).toContain('波纹 +2.000s');
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

  it('writes a clip move from direct manipulation against the current Project revision', async () => {
    const applyProjectPatch = vi.fn(() => Promise.resolve({
      project: { ...PROJECT, revision: 2 },
      change_group: {
        id: '00000000-0000-4000-8000-000000000020', project_id: PROJECT.id,
        from_revision: 1, to_revision: 2, author: { kind: 'human' as const }, status: 'completed' as const,
        summary: '移动 A', reverts_change_group_id: null, operations: [], inverse_operations: [],
        created_at: PROJECT.updated_at, completed_at: PROJECT.updated_at,
      },
    }));
    renderWorkspace({ applyProjectPatch });

    const clipButton = await screen.findByRole('button', { name: /A 5\.0s · 未录制/u });
    fireEvent.keyDown(clipButton, { key: 'ArrowRight', shiftKey: true });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      project_id: PROJECT.id,
      base_revision: 1,
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ start: 0 }) }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 5 }) }),
        ],
      })],
    })));
  });

  it('edits an independent audio-track clip while keeping Story audio derived', async () => {
    const audioClipId = '00000000-0000-4000-8000-000000000015';
    const audioClip: TimelineClip = {
      ...clip(audioClipId, 'Bed'),
      material: { kind: 'asset', asset_id: 'asset-audio', media_duration_seconds: 30 },
      placement: { start: 12, duration: 5, source_in: 0, source_out: 5, speed: 1, volume: 1, enabled: true },
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
    fireEvent.keyDown(audioButton, { key: 'ArrowRight', shiftKey: true });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_clip',
        clip_id: audioClipId,
        clip: expect.objectContaining({ placement: expect.objectContaining({ start: 13 }) }),
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
              { id: 'volume-0', time: 0, property: 'volume', value: 1 },
              { id: 'volume-1', time: 1, property: 'volume', value: 2 },
            ],
          }),
        }),
      },
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project, applyProjectPatch });
    fireEvent.keyDown(await screen.findByRole('slider', { name: '时间轴播放头' }), { key: 'ArrowRight', shiftKey: true });

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
            expect.objectContaining({ id: 'volume-1', time: 1, property: 'volume', value: expect.closeTo(1.782_502, 5) }),
          ],
        }),
      })],
    })));
  });

  it('edits renderer-backed fades from Story derived audio handles', async () => {
    const keyboardPatch = vi.fn();
    const keyboardRender = renderWorkspace({ applyProjectPatch: keyboardPatch });

    const fadeIn = await screen.findByRole('slider', { name: '调整淡入 A' });
    const storyAudio = screen.getByRole('row', { name: 'Story 音频' });
    expect(storyAudio.querySelector('[role="img"]')?.classList.contains('pointer-events-none')).toBe(true);
    expect(fadeIn.parentElement?.classList.contains('z-10')).toBe(false);
    expect(fadeIn.getAttribute('aria-valuetext')).toBe('0.000s');
    fireEvent.keyDown(fadeIn, { key: 'ArrowRight' });
    await waitFor(() => expect(keyboardPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_clip',
        clip_id: CLIP_A,
        clip: expect.objectContaining({ transition_in: 'fade', metadata: expect.objectContaining({ transition_duration: 0.05 }) }),
      })],
    })));

    keyboardRender.unmount();
    const pointerPatch = vi.fn();
    renderWorkspace({ applyProjectPatch: pointerPatch });
    const fadeOut = await screen.findByRole('slider', { name: '调整淡出 A' });
    fireEvent.pointerDown(fadeOut, { pointerId: 72, button: 0, clientX: 400 });
    fireEvent.pointerMove(fadeOut, { pointerId: 72, clientX: 390 });
    await waitFor(() => expect(Number(fadeOut.getAttribute('aria-valuenow'))).toBeGreaterThan(0.5));
    fireEvent.pointerUp(fadeOut, { pointerId: 72, clientX: 390 });
    await waitFor(() => expect(pointerPatch).toHaveBeenCalledTimes(1));
    expect(pointerPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_clip',
        clip_id: CLIP_A,
        clip: expect.objectContaining({ transition_out: 'fade', metadata: expect.objectContaining({ transition_duration: expect.any(Number) }) }),
      })],
    }));
  });

  it('deletes a cross-track selection in one Project revision', async () => {
    const audioClipId = '00000000-0000-4000-8000-000000000016';
    const audioClip: TimelineClip = {
      ...clip(audioClipId, 'Bed'),
      material: { kind: 'asset', asset_id: 'asset-audio', media_duration_seconds: 30 },
      placement: { start: 12, duration: 5, source_in: 0, source_out: 5, speed: 1, volume: 1, enabled: true },
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
    fireEvent.click(screen.getByRole('button', { name: '删除所选片段并闭合间隙' }));

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
    fireEvent.keyDown(playhead, { key: 'ArrowRight', shiftKey: true });
    expect((screen.getByRole('button', { name: '在播放头切分片段' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '删除所选片段并闭合间隙' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '波纹裁切片段起点到播放头' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '波纹裁切播放头到片段终点' }) as HTMLButtonElement).disabled).toBe(true);
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
      placement: { start: 12, duration: 5, source_in: 0, source_out: 5, speed: 1, volume: 1, enabled: true },
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
    fireEvent.click(screen.getByRole('button', { name: '删除所选片段并闭合间隙' }));

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

  it('splits the selected Story clip at the global playhead', async () => {
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
    fireEvent.keyDown(playhead, { key: 'ArrowRight', shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: '在播放头切分片段' }));

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

  it('adds a canonical marker at the playhead', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    fireEvent.click(await screen.findByRole('button', { name: '在播放头添加标记' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_markers',
        markers: [expect.objectContaining({ time: 0, label: '标记 1', color: '#2F6FED' })],
      }],
    })));
  });

  it('edits and deletes an existing timeline marker', async () => {
    const marker = { id: '00000000-0000-4000-8000-000000000018', time: 8, label: 'ACE', color: '#2F6FED' };
    const project: Project = {
      ...PROJECT,
      document: { ...PROJECT.document, markers: [marker] },
    };
    const editPatch = vi.fn();
    const rendered = renderWorkspace({ project, applyProjectPatch: editPatch });

    const markerButton = await screen.findByRole('button', { name: '标记 ACE 00:08.000' });
    fireEvent.doubleClick(markerButton);
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: 'ACE revised' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: '时间' }), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: '保存标记' }));

    await waitFor(() => expect(editPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_markers',
        markers: [{ ...marker, time: 9, label: 'ACE revised' }],
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

  it('drags a sequence marker with one frame-snapped Human Edit', async () => {
    const marker = { id: '00000000-0000-4000-8000-000000000018', time: 8, label: 'ACE', color: '#2F6FED' };
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
    const marker = { id: '00000000-0000-4000-8000-000000000101', time: 8, label: 'Snap probe', color: '#2F6FED' };
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

  it('bounds event labels to their clip spans and uses them as timeline navigation', async () => {
    renderWorkspace();

    const event = await screen.findByRole('button', { name: '事件 B 00:05.000' });
    expect(event.style.width).not.toBe('');
    expect(event.className).toContain('overflow-hidden');
    fireEvent.click(event);

    expect(Number(screen.getByRole('slider', { name: '时间轴播放头' }).getAttribute('aria-valuenow'))).toBe(5);
  });

  it('marks an In/Out range and extracts it from Story with ripple', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    const timeline = await screen.findByRole('region', { name: '时间轴' });
    fireEvent.keyDown(timeline, { key: 'i' });
    fireEvent.keyDown(screen.getByRole('slider', { name: '时间轴播放头' }), { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(timeline, { key: 'o' });
    expect(screen.getByLabelText('入出点范围 00:00.000 到 00:01.000')).toBeTruthy();
    fireEvent.keyDown(timeline, { key: "'" });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ start: 0, duration: 4, source_in: 1 }) }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 4 }) }),
        ],
      }],
    })));
    expect(screen.queryByLabelText('入出点范围 00:00.000 到 00:01.000')).toBeNull();
  });

  it('supports Premiere Q and W ripple trims through the shared Story edit path', async () => {
    const qPatch = vi.fn();
    const qRender = renderWorkspace({ applyProjectPatch: qPatch });
    const qTimeline = await screen.findByRole('region', { name: '时间轴' });
    fireEvent.keyDown(screen.getByRole('slider', { name: '时间轴播放头' }), { key: 'ArrowRight', shiftKey: true });
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
    fireEvent.keyDown(screen.getByRole('slider', { name: '时间轴播放头' }), { key: 'ArrowRight', shiftKey: true });
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
    fireEvent.click(screen.getByRole('button', { name: '删除所选片段并闭合间隙' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ start: 0 }) })],
      }],
    })));
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

    fireEvent.click(screen.getByRole('button', { name: '删除所选片段并闭合间隙' }));

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
    fireEvent.keyDown(screen.getByRole('slider', { name: '时间轴播放头' }), { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(timeline, { key: 'v', ctrlKey: true });

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

  it('pastes a single clipboard group to the explicitly targeted track', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    fireEvent.click(await screen.findByRole('button', { name: '复制所选片段' }));
    const musicTarget = screen.getByRole('button', { name: '设为目标轨道 Music' });
    fireEvent.click(musicTarget);
    expect(musicTarget.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('目标：Music')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '在播放头粘贴片段' }));

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_track_clips',
        track_id: '00000000-0000-4000-8000-000000000013',
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

    const storyTarget = await screen.findByRole('button', { name: '设为目标轨道 视频轨道 1' }) as HTMLButtonElement;
    expect(storyTarget.disabled).toBe(true);
    expect(storyTarget.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('目标：—')).toBeTruthy();
  });

  it('toggles the current target track off instead of immediately restoring Story', async () => {
    renderWorkspace();

    const storyTarget = await screen.findByRole('button', { name: '设为目标轨道 视频轨道 1' });
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

    fireEvent.click(await screen.findByRole('button', { name: '撤销上一次剪辑' }));

    await waitFor(() => expect(revertProjectChangeGroup).toHaveBeenCalledWith(
      PROJECT.id,
      group.id,
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
    for (let second = 0; second < 5; second += 1) {
      fireEvent.keyDown(screen.getByRole('slider', { name: '时间轴播放头' }), { key: 'ArrowRight', shiftKey: true });
    }
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

    for (let second = 0; second < 5; second += 1) {
      fireEvent.keyDown(screen.getByRole('slider', { name: '时间轴播放头' }), { key: 'ArrowRight', shiftKey: true });
    }
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
      placement: { start: 0, duration: 8, source_in: 0, source_out: 8, speed: 1, volume: 0.5, enabled: true },
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
    fireEvent.keyDown(playhead, { key: 'ArrowRight', shiftKey: true });
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
              { id: 'x-0', time: 0, property: 'x', value: 96 },
              { id: 'x-1', time: 1, property: 'x', value: 192 },
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

    fireEvent.keyDown(screen.getByRole('slider', { name: '时间轴播放头' }), { key: 'ArrowRight', shiftKey: true });
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
        { id: 'title-x-0', time: 0, property: 'x', value: 96 },
        { id: 'title-x-1', time: 1, property: 'x', value: 192 },
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

    fireEvent.keyDown(screen.getByRole('slider', { name: '时间轴播放头' }), { key: 'ArrowRight', shiftKey: true });
    await waitFor(() => expect(overlay.dataset.programTextX).toBe('192'));
    expect(overlay.style.left).toBe('60%');

    fireEvent.doubleClick(screen.getByRole('button', { name: /Title 5\.0s · 未录制/u }));
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
            transition_in: 'fade',
            metadata: { transition_duration: 1 },
            keyframes: [
              { id: 'volume-0', time: 0, property: 'volume', value: 0.5 },
              { id: 'volume-1', time: 1, property: 'volume', value: 1 },
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

    fireEvent.keyDown(screen.getByRole('slider', { name: '时间轴播放头' }), { key: 'ArrowRight', shiftKey: true });
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
            transition_in: 'zoom',
            metadata: { transition_duration: 2 },
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

    fireEvent.keyDown(screen.getByRole('slider', { name: '时间轴播放头' }), { key: 'ArrowRight', shiftKey: true });
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
            keyframes: [{ id: 'x-0', time: 0, property: 'x', value: 96 }],
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
          keyframes: [expect.objectContaining({ id: 'x-0', time: 0, property: 'x', value: 288 })],
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

    fireEvent.keyDown(playhead, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(timeline, { key: 'j' });
    await waitFor(() => expect(screen.getByText('-1.0x')).toBeTruthy());
    fireEvent.keyDown(timeline, { key: 'k' });
  });

  it('lets Space activate a focused Timeline button without also toggling transport', async () => {
    renderWorkspace();

    const marker = await screen.findByRole('button', { name: '在播放头添加标记' });
    marker.focus();
    fireEvent.keyDown(marker, { key: ' ' });

    expect(screen.getByRole('button', { name: '播放时间轴' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'K 暂停时间轴' })).toBeNull();
  });

  it('page-scrolls the timeline to follow playback while track heads stay sticky', async () => {
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
    expect(viewport.scrollLeft).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: '播放时间轴' }));
    await waitFor(() => expect(viewport.scrollLeft).toBeGreaterThan(0));
    expect((screen.getByRole('row', { name: 'Story' }).firstElementChild as HTMLElement).className).toContain('sticky');
    fireEvent.click(screen.getByRole('button', { name: 'K 暂停时间轴' }));
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
    await waitFor(() => expect(Number.parseFloat(timelineClip?.style.width ?? '0')).toBeCloseTo(34_560));
    expect(zoom.getAttribute('aria-valuetext')).toContain('3.20');
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
    fireEvent.click(screen.getByRole('button', { name: '在播放头添加标记' }));

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
    renderWorkspace();

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
    fireEvent.keyDown(screen.getByRole('region', { name: '时间轴' }), { key: 'a', ctrlKey: true });
    await waitFor(() => {
      expect(clipA.className).toContain('ring-accent');
      expect(clipB.className).toContain('ring-accent');
    });
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

  it('rebuilds a new cross-track link group when pasting linked clips', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: linkedProject(), applyProjectPatch });

    fireEvent.click(await screen.findByRole('button', { name: '复制所选片段' }));
    fireEvent.click(screen.getByRole('button', { name: '在播放头粘贴片段' }));

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
    targetVideos.forEach((video) => fireEvent.loadedData(video));
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

  it('authors Time Remapping sections and ripples Story once on save', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ project: RECORDED_PROJECT, applyProjectPatch });

    fireEvent.doubleClick(await screen.findByRole('button', { name: /A 5\.0s · 已录制/u }));
    fireEvent.click(await screen.findByRole('button', { name: '启用' }));
    const playhead = screen.getByRole('slider', { name: '时间轴播放头' });
    fireEvent.keyDown(playhead, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(playhead, { key: 'ArrowRight', shiftKey: true });
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
      if (draft.kind !== 'user') throw new Error('expected direct-edit decision');
      return { kind: 'user' as const, id: 'direct-edit', at: '2026-08-28T10:03:00Z', content: draft.content };
    });
    renderWorkspace({ project: lockedProject, session, groups: [group], appendAgentSessionEntry });

    fireEvent.click(await screen.findByRole('button', { name: '直接修改' }));
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
    expect(screen.getByRole('dialog', { name: '录制缺失片段' }).textContent).toContain('录制 1 个尚未物化的时间线片段');
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

  it('inserts a selected imported asset at the transport time through the Premiere comma shortcut', async () => {
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
      created_at: PROJECT.updated_at,
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ assets: [asset], applyProjectPatch });

    fireEvent.click(await screen.findByRole('option', { name: '选择素材 New angle' }));
    fireEvent.keyDown(window, { key: ',' });

    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'replace_track_clips',
        track_id: STORY_ID,
        clips: [
          expect.objectContaining({ name: 'New angle', placement: expect.objectContaining({ start: 0, duration: 6 }) }),
          expect.objectContaining({ id: CLIP_A, placement: expect.objectContaining({ start: 6 }) }),
          expect.objectContaining({ id: CLIP_B, placement: expect.objectContaining({ start: 11 }) }),
        ],
      })],
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
    expect(screen.getByLabelText('素材落点 视频轨道 1').textContent).toContain('插入');
    fireEvent(story, mediaDragEvent('drop', dataTransfer, { clientX: 200, ctrlKey: true }));
    expect(screen.queryByLabelText('素材落点 视频轨道 1')).toBeNull();

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
    expect(screen.queryByLabelText('素材落点 音频轨道 1')).toBeNull();

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
      created_at: PROJECT.updated_at,
    };
    const applyProjectPatch = vi.fn();
    renderWorkspace({ assets: [asset], applyProjectPatch });

    const panel = await screen.findByRole('region', { name: '项目素材' });
    fireEvent.click(screen.getByRole('button', { name: '设为目标轨道 Music' }));
    fireEvent.click(within(panel).getByRole('option', { name: '选择素材 Bed' }));
    expect(within(panel).getByText('目标：Music')).toBeTruthy();
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
    expect(within(panel).getByText('目标：新建音频轨道')).toBeTruthy();
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
    expect(await screen.findByText('目标：音频轨道 1')).toBeTruthy();
    const voiceItems = within(panel).getAllByRole('option', { name: '选择素材 Voice' });
    expect(voiceItems).toHaveLength(1);
    expect(voiceItems[0]?.textContent).toContain('已录制');
  });

  it('adds and removes real timeline tracks through Project operations', async () => {
    const addPatch = vi.fn();
    renderWorkspace({ applyProjectPatch: addPatch });

    fireEvent.pointerDown(await screen.findByRole('button', { name: '添加轨道' }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole('menuitem', { name: '添加文字轨道' }));

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

    fireEvent.click(await screen.findByRole('button', { name: '在播放头添加文字' }));
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
            transition_in: null,
            transition_out: null,
            text: expect.objectContaining({
              content: 'Lower third',
              font_family: 'Arial',
              font_size: 72,
              color: 'white',
              background: 'black',
              align: 'center',
            }),
          })],
        }),
      }],
    })));
    expect(applyProjectPatch).toHaveBeenCalledTimes(1);
  });

  it('removes a non-Story track with a real Project operation', async () => {
    const removePatch = vi.fn();
    renderWorkspace({ applyProjectPatch: removePatch });

    fireEvent.click(await screen.findByRole('button', { name: '删除轨道 Music' }));

    await waitFor(() => expect(removePatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{ op: 'remove_track', track_id: '00000000-0000-4000-8000-000000000013' }],
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
            locked: false,
            hidden: false,
            clips: [],
          }],
        },
      },
    });

    expect((await screen.findAllByRole('button', { name: '切换轨道锁定' })).length).toBeGreaterThan(3);
    fireEvent.click(screen.getByRole('button', { name: '删除轨道 Notes' }));
    await waitFor(() => expect(removePatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{ op: 'remove_track', track_id: textTrackId }],
    })));
  });

  it('toggles video output through track.hidden instead of muting its audio', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    fireEvent.click(await screen.findByRole('button', { name: '切换视频轨道输出' }));
    await waitFor(() => expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
      operations: [{
        op: 'replace_track',
        track_id: STORY_ID,
        track: expect.objectContaining({ hidden: true, muted: false }),
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
    expect(screen.getAllByRole('button', { name: '切换视频轨道输出' })).toHaveLength(2);
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
            locked: false,
            hidden: false,
            clips: [],
          }],
        },
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: '下移轨道 Music' }));
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
    fireEvent.change(screen.getByRole('combobox', { name: '入场转场' }), { target: { value: 'fade' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => {
      expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
        project_id: PROJECT.id,
        base_revision: 1,
        operations: [expect.objectContaining({
          op: 'replace_track_clips',
          track_id: STORY_ID,
          clips: expect.arrayContaining([expect.objectContaining({ id: CLIP_A, name: 'A revised', transition_in: 'fade' })]),
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
    fireEvent.keyDown(screen.getByRole('slider', { name: '时间轴播放头' }), { key: 'ArrowRight', shiftKey: true });
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

  it('authors Volume keyframes from Inspector and keeps base volume unchanged', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    fireEvent.doubleClick(await screen.findByRole('button', { name: /A 5\.0s · 未录制/u }));
    fireEvent.click(await screen.findByRole('button', { name: '在播放头添加 音量 关键帧' }));
    fireEvent.keyDown(screen.getByRole('slider', { name: '时间轴播放头' }), { key: 'ArrowRight', shiftKey: true });
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
              { id: 'x-1', time: 1, property: 'x', value: 100 },
              { id: 'opacity-1', time: 1, property: 'opacity', value: 0.5 },
              { id: 'x-3', time: 3, property: 'x', value: 200 },
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
    expect(screen.getByText('读取作品')).toBeTruthy();
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
          input: { projectId: PROJECT.id },
          output: { status: 'requires_human_confirmation', action: 'export' },
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
    const session: AgentSession = {
      id: '00000000-0000-4000-8000-000000000030',
      title: 'Agent · Markdown',
      created_at: '2026-08-28T10:00:00Z',
      updated_at: '2026-08-28T10:01:00Z',
      entries: [{
        kind: 'assistant', id: 'a-markdown', at: '2026-08-28T10:01:00Z',
        content: '| 交付项 | 说明 |\n| --- | --- |\n| 时间线微调 | 换片段、改顺序 |',
        tool_calls: [], status: 'completed', request_id: 'request-markdown',
        retry_of: null, error: null, metadata: null,
      }],
    };
    renderWorkspace({ session });

    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: '交付项' })).toBeTruthy();
    expect(within(table).getByRole('cell', { name: '换片段、改顺序' })).toBeTruthy();
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
            input: { projectId: PROJECT.id },
            output: { status: 'requires_human_confirmation', action: 'export' },
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
          input: { projectId: PROJECT.id },
          output: { status: 'requires_human_confirmation', action: 'export' },
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
    const streamAgentChat = vi.fn(async () => ({ thread_id: 'unexpected-follow-up' }));
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

    expect(await screen.findByText('Agent 尚未配置模型')).toBeTruthy();
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

    renderWorkspace({ session, groups: [currentGroup] });
    expect(await screen.findByRole('button', { name: '接受交付' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '退回修改' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '直接修改' })).toBeTruthy();
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
      return { thread_id: 'thread-streaming-lock' };
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

    const input = await screen.findByPlaceholderText('例如：重新规划成 3 分钟 NiKo 集锦');
    fireEvent.change(input, { target: { value: '只添加一个标记' } });
    fireEvent.click(screen.getByRole('button', { name: '发送给 Agent' }));
    await waitFor(() => expect(streamAgentChat).toHaveBeenCalledTimes(1));

    expect(screen.getByText('Agent 操作中 · 人类只读')).toBeTruthy();
    expect((screen.getByRole('button', { name: '在播放头添加文字' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '在播放头添加标记' }) as HTMLButtonElement).disabled).toBe(true);

    finishStream();
    await waitFor(() => expect(updateAgentTurn).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByRole('button', { name: '在播放头添加文字' }) as HTMLButtonElement).disabled).toBe(false));
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

    expect(await screen.findByText('Agent 操作中 · 人类只读')).toBeTruthy();
    expect((screen.getByPlaceholderText('例如：重新规划成 3 分钟 NiKo 集锦') as HTMLInputElement).disabled).toBe(true);
    expect((within(screen.getByRole('row', { name: 'Story' })).getByRole('button', { name: '切换轨道锁定' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.doubleClick(screen.getByRole('button', { name: /A 5\.0s · 未录制/u }));
    expect((await screen.findByRole('textbox', { name: '名称' }) as HTMLInputElement).disabled).toBe(true);
  });
});
