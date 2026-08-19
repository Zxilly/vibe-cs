import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AgentPlanSummary } from '../shared/desktop/dto';
import { renderPage } from './delivery/test/renderPage';
import { ProjectsPage } from './ProjectsPage';

const PLAN: AgentPlanSummary = {
  id: 'p-1', title: 'Mirage 残局', status: 'awaiting_confirmation', revision: 2,
  shot_count: 4, total_duration_seconds: 32, origin_count: 2,
  created_at: '2026-08-19T00:00:00Z', updated_at: '2026-08-19T01:00:00Z',
};

const emptyFeed = { items: [], total: 0, page: 1, page_size: 50, summary: { total: 0, active: 0, failed: 0, completed: 0, cancelled: 0 } };
const emptyOutputs = { items: [], total: 0, page: 1, page_size: 100, scan_limited: false };

function client(overrides: Record<string, unknown> = {}) {
  return {
    listAgentPlans: () => Promise.resolve([PLAN]),
    listMontageProjects: () => Promise.resolve({ items: [] }),
    listEditorProjects: () => Promise.resolve({ items: [] }),
    listActivities: () => Promise.resolve(emptyFeed),
    listOutputs: () => Promise.resolve(emptyOutputs),
    ...overrides,
  };
}

describe('/projects', () => {
  it('renders the aggregate card facts and links to the workspace address', async () => {
    renderPage({ element: <ProjectsPage />, client: client(), route: '/projects' });

    const link = await screen.findByRole('link', { name: 'Mirage 残局' });
    expect(link.getAttribute('href')).toBe('/projects/plan%3Ap-1');
    expect(screen.getByText('剪辑单')).toBeTruthy();
    expect(screen.getByText('需要处理')).toBeTruthy();
    expect(screen.getByText('尚未关联比赛')).toBeTruthy();
  });

  it('shows one new-project action when every anchor source is empty', async () => {
    renderPage({
      element: <ProjectsPage />,
      client: client({ listAgentPlans: () => Promise.resolve([]) }),
      route: '/projects',
    });

    expect(await screen.findByText('还没有作品')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: '新建作品' })).toHaveLength(1);
  });

  it('keeps available cards when another source fails', async () => {
    renderPage({
      element: <ProjectsPage />,
      client: client({ listMontageProjects: () => Promise.reject(new Error('montages offline')) }),
      route: '/projects',
    });

    expect(await screen.findByRole('link', { name: 'Mirage 残局' })).toBeTruthy();
    expect(screen.getByText('部分来源暂时读不到，下面仍显示已经取到的作品。')).toBeTruthy();
  });
});
