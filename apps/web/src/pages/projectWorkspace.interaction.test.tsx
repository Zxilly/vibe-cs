import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AgentSession, Project, ProjectChangeGroup, ProjectEditLease, TimelineClip } from '../shared/desktop/dto';
import { unavailableNativeShell, type NativeShell } from '../data/nativeShell';
import { renderPage } from './delivery/test/renderPage';
import { ProjectWorkspacePage } from './ProjectWorkspacePage';

const STORY_ID = '00000000-0000-4000-8000-000000000010';
const CLIP_A = '00000000-0000-4000-8000-000000000011';
const CLIP_B = '00000000-0000-4000-8000-000000000012';

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
    settings: {},
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

function renderWorkspace({
  applyProjectPatch = vi.fn(),
  revertProjectChangeGroup = vi.fn(),
  session = null,
  lease = null,
  groups = [],
  agentConfigured = true,
  project = PROJECT,
  shell,
}: {
  readonly applyProjectPatch?: ReturnType<typeof vi.fn>;
  readonly revertProjectChangeGroup?: ReturnType<typeof vi.fn>;
  readonly session?: AgentSession | null;
  readonly lease?: ProjectEditLease | null;
  readonly groups?: readonly ProjectChangeGroup[];
  readonly agentConfigured?: boolean;
  readonly project?: Project;
  readonly shell?: NativeShell | undefined;
} = {}) {
  return renderPage({
    element: <ProjectWorkspacePage />,
    client: {
      getProject: () => Promise.resolve(project),
      listProjectChangeGroups: () => Promise.resolve(groups),
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
  it('uses one adjustable video and tactical split preview', async () => {
    renderWorkspace();

    expect(await screen.findByRole('region', { name: '视频预览' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '战术示意' })).toBeTruthy();
    const separator = screen.getByRole('separator', { name: '调整视频与战术图宽度' });
    const split = separator.parentElement!;
    vi.spyOn(split, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 1000,
      bottom: 400,
      left: 0,
      width: 1000,
      height: 400,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(separator, { clientX: 680, pointerId: 1 });
    expect(separator.getAttribute('aria-valuenow')).toBe('68');
    fireEvent.doubleClick(separator);
    expect(separator.getAttribute('aria-valuenow')).toBe('52');
  });

  it('shows recorded and unrecorded state on the unified timeline', async () => {
    renderWorkspace();

    expect(await screen.findByText('已录制 1')).toBeTruthy();
    expect(screen.getByText('未录制 1')).toBeTruthy();
    expect(screen.getByRole('button', { name: /B 5\.0s · 已录制/u })).toBeTruthy();
    expect(screen.getByRole('button', { name: /A 5\.0s · 未录制/u })).toBeTruthy();
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

    expect(await screen.findByRole('heading', { name: '时间轴（变更审阅）' })).toBeTruthy();
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
    renderWorkspace();

    const playhead = await screen.findByRole('slider', { name: '时间轴播放头' });
    const timeline = screen.getByRole('region', { name: '时间轴内容' });
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

    expect(fireEvent.pointerDown(playhead, { clientX: 310, pointerId: 7, button: 0 })).toBe(false);
    fireEvent.pointerMove(playhead, { clientX: 550, pointerId: 7 });
    fireEvent.pointerUp(playhead, { clientX: 550, pointerId: 7 });

    expect(Number(playhead.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
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


  it('plays the selected recorded asset through the desktop media bridge', async () => {
    renderWorkspace({
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: /B 5\.0s · 已录制/u }));
    const preview = screen.getByLabelText('B 视频预览') as HTMLVideoElement;
    expect(preview.getAttribute('src')).toBe('vibe-cs-media://localhost/media/assets/asset-b/stream');
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
    expect(videos).toHaveLength(2);
    expect([...videos].every((video) => !video.controls)).toBe(true);
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
    fireEvent.click(screen.getByRole('button', { name: '暂停时间轴' }));

    fireEvent.click(screen.getByRole('button', { name: /B 5\.0s · 已录制/u }));
    const target = screen.getByLabelText('B 视频预览') as HTMLVideoElement;
    Object.defineProperty(target, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_ENOUGH_DATA });
    fireEvent.loadedData(target);
    await waitFor(() => {
      const active = monitor.querySelector<HTMLVideoElement>('[data-preview-active="true"]');
      expect(active?.getAttribute('src')).toBe('vibe-cs-media://localhost/media/assets/asset-b/stream');
      expect(active?.currentTime).toBe(1);
    });
  });

  it('shows the whole editing document without mode-switch chrome', async () => {
    const applyProjectPatch = vi.fn();
    renderWorkspace({ applyProjectPatch });

    expect(await screen.findByRole('row', { name: 'Story' })).toBeTruthy();
    expect(screen.getByRole('row', { name: 'Music' })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: '快速剪辑' })).toBeNull();
    expect(screen.queryByRole('radio', { name: '多轨精剪' })).toBeNull();
    expect(screen.queryByRole('button', { name: '录制缺失片段' })).toBeNull();
    expect(screen.queryByRole('button', { name: '导出成片' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Agent' })).toBeNull();
    expect(applyProjectPatch).not.toHaveBeenCalled();
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
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => {
      expect(applyProjectPatch).toHaveBeenCalledWith(expect.objectContaining({
        project_id: PROJECT.id,
        base_revision: 1,
        operations: [expect.objectContaining({
          op: 'replace_track_clips',
          track_id: STORY_ID,
          clips: expect.arrayContaining([expect.objectContaining({ id: CLIP_A, name: 'A revised' })]),
        })],
      }));
    });
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
            { name: 'read_workspace', input: {}, output: { revision: 1 } },
            {
              name: 'request_project_recording',
              input: { projectId: PROJECT.id, baseRevision: 1, clipIds: [CLIP_A] },
              output: {
                status: 'requires_human_confirmation',
                action: 'recording',
                projectId: PROJECT.id,
                baseRevision: 1,
                request: {},
              },
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
          tool_calls: [{ name: 'read_workspace', input: {}, output: { revision: 1 } }],
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
          tool_calls: [{ name: 'replace_story_timeline', input: {}, output: { revision: 2 } }],
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

  it('shows the Agent lease inside the conversation and makes human controls read-only', async () => {
    renderWorkspace({
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
    fireEvent.doubleClick(screen.getByRole('button', { name: /A 5\.0s · 未录制/u }));
    expect((await screen.findByRole('textbox', { name: '名称' }) as HTMLInputElement).disabled).toBe(true);
  });
});
