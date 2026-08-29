import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AgentSession, MediaAsset, Project, ProjectChangeGroup, ProjectEditLease, TimelineClip } from '../shared/desktop/dto';
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
  assets = [],
  agentConfigured = true,
  project = PROJECT,
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
  readonly shell?: NativeShell | undefined;
} = {}) {
  return renderPage({
    element: <ProjectWorkspacePage />,
    client: {
      getProject: () => Promise.resolve(project),
      listProjectChangeGroups: () => Promise.resolve(groups),
      listMediaAssets: () => Promise.resolve({ items: assets }),
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
  it('uses one fixed video and tactical split preview', async () => {
    renderWorkspace();

    expect(await screen.findByRole('region', { name: '视频预览' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '战术示意' })).toBeTruthy();
    expect(screen.queryByRole('separator', { name: '调整视频与战术图宽度' })).toBeNull();
    const split = screen.getByRole('region', { name: '预览分栏' }).firstElementChild as HTMLElement;
    expect(split.style.gridTemplateColumns).toBe('minmax(0, 1fr) 1px minmax(0, 1fr)');
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
    fireEvent.click(screen.getByRole('button', { name: '暂停时间轴' }));

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
    expect(applyProjectPatch).not.toHaveBeenCalled();
  });

  it('opens the project media bin and inserts a full asset at the transport time', async () => {
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

    fireEvent.click(await screen.findByRole('button', { name: '项目素材' }));
    expect(screen.getByRole('heading', { name: '项目素材' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '在播放头插入 New angle' }));

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

    fireEvent.click(await screen.findByRole('button', { name: '项目素材' }));
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
