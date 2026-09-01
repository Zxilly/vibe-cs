import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Project } from '../shared/desktop/dto';
import { renderPage } from './delivery/test/renderPage';
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

describe('/projects', () => {
  it('renders only canonical projects and links by the real project id', async () => {
    renderPage({
      element: <ProjectsPage />,
      client: { listProjects: () => Promise.resolve([PROJECT]) },
      route: '/projects',
    });

    const link = await screen.findByRole('link', { name: 'Mirage 残局' });
    expect(link.getAttribute('href')).toBe(`/projects/${PROJECT.id}`);
    expect(screen.getByText('r2')).toBeTruthy();
  });

  it('creates one canonical project without a Plan/Montage/Editor source kind', async () => {
    const createProject = vi.fn(() => Promise.resolve(PROJECT));
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
  });
});
