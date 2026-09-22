import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Project, TimelineClip } from '../../../shared/desktop/dto';
import { renderPage } from '../../../test/renderPage';
import { ProjectsPage } from './ProjectsPage';

const PROJECT: Project = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Mirage 残局',
  revision: 2,
  document: {
    width: 1920,
    height: 1080,
    fps: 60,
    duration_seconds: 32,
    story_track_id: '00000000-0000-4000-8000-000000000002',
    tracks: [{
      id: '00000000-0000-4000-8000-000000000002',
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
      clips: [],
    }],
    markers: [],
    settings: { source_demo_ids: [], ripple_sequence_markers: false, use_media_proxies: false },
  },
  created_at: '2026-08-19T00:00:00Z',
  updated_at: '2026-08-19T01:00:00Z',
};

const CLIP: TimelineClip = {
  id: '00000000-0000-4000-8000-000000000010',
  name: '残局片段',
  capture_intent: null,
  material: { kind: 'asset', asset_id: 'asset-1', media_duration_seconds: 32 },
  placement: { start: 0, duration: 32, source_in: 0, source_out: 32, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
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

describe('/projects', () => {
  it('renders only canonical projects and links by the real project id', async () => {
    renderPage({
      element: <ProjectsPage />,
      client: { listProjects: () => Promise.resolve([PROJECT]) },
      route: '/projects',
    });

    const link = await screen.findByRole('link', { name: 'Mirage 残局' });
    expect(link.getAttribute('href')).toBe(`/projects/${PROJECT.id}`);
    expect(screen.getByText('第 2 版')).toBeTruthy();
    expect(screen.getByText('还没有素材')).toBeTruthy();
    expect(screen.getByText('00:32')).toBeTruthy();
    expect(screen.getByText('最近更新')).toBeTruthy();
    // The title stays the only anchor; its box is stretched over the card.
    expect(link.className).toContain('after:inset-0');
    expect(link.closest('[data-project-card]')?.className).toContain('relative');
  });

  it('keeps a failed load distinct from an empty library and recovers through retry', async () => {
    const listProjects = vi.fn()
      .mockRejectedValueOnce(new Error('Library unavailable'))
      .mockResolvedValue([PROJECT]);
    renderPage({
      element: <ProjectsPage />,
      client: { listProjects },
      route: '/projects',
    });

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('还没有作品')).toBeNull();
    expect(screen.queryByText('0 个作品')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByRole('link', { name: 'Mirage 残局' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('1 个作品')).toBeTruthy();
  });

  it('only shows readiness for the same project revision as the card', async () => {
    const project = { ...PROJECT, document: { ...PROJECT.document, tracks: PROJECT.document.tracks.map((track) => ({ ...track, clips: [CLIP] })) } };
    const newerProject = { ...project, id: '00000000-0000-4000-8000-000000000003', name: 'Mirage 新剪辑', revision: 3 };
    renderPage({
      element: <ProjectsPage />,
      client: {
        listProjects: () => Promise.resolve([project, newerProject]),
        getProjectDeliveryGate: (id: string) => Promise.resolve({ project_id: id, revision: 2, ready: true, blockers: [] }),
      },
      route: '/projects',
    });

    await screen.findByText(/全部就绪/);
    const currentCard = screen.getByRole('link', { name: 'Mirage 残局' }).closest('article')!;
    const staleCard = screen.getByRole('link', { name: 'Mirage 新剪辑' }).closest('article')!;
    expect(within(currentCard).getByText(/全部就绪/)).toBeTruthy();
    expect(within(staleCard).queryByText(/全部就绪/)).toBeNull();
    expect(within(staleCard).getByText(/素材状态待更新/)).toBeTruthy();
    expect(within(staleCard).queryByText(/正在检查素材/)).toBeNull();
  });

  it('offers to clear a search that matched nothing instead of a second 新建作品', async () => {
    renderPage({
      element: <ProjectsPage />,
      client: { listProjects: () => Promise.resolve([PROJECT]) },
      route: '/projects',
    });

    await screen.findByRole('link', { name: 'Mirage 残局' });
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索作品' }), { target: { value: 'zzzz' } });
    expect(await screen.findByRole('heading', { name: '没有匹配的作品' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '新建作品' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '清空搜索' }));
    expect(await screen.findByRole('link', { name: 'Mirage 残局' })).toBeTruthy();
  });

  it('creates one canonical project without a Plan/Montage/Editor source kind', async () => {
    let completeCreate!: (project: Project) => void;
    const createProject = vi.fn(() => new Promise<Project>((resolve) => { completeCreate = resolve; }));
    renderPage({
      element: <ProjectsPage />,
      client: {
        listProjects: () => Promise.resolve([]),
        createProject,
      },
      route: '/projects',
    });

    await screen.findByText('还没有作品');
    fireEvent.click(screen.getAllByRole('button', { name: '新建作品' })[0]!);
    await waitFor(() => {
      expect(createProject).toHaveBeenCalledWith({
        name: '新作品',
        width: 1920,
        height: 1080,
        fps: 60,
        source_demo_ids: [],
      });
    });
    const pendingActions = await screen.findAllByRole('button', { name: '正在创建…' });
    for (const button of pendingActions) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      expect(button.getAttribute('aria-busy')).toBe('true');
      fireEvent.click(button);
    }
    expect(createProject).toHaveBeenCalledTimes(1);
    await act(async () => completeCreate(PROJECT));
  });
});
