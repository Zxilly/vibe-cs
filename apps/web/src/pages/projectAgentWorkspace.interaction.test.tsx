import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AgentPlanSummary } from '../shared/desktop/dto';
import { PLAN } from './agent/planFixtures.testing';
import { renderPage } from './delivery/test/renderPage';
import { ProjectWorkspacePage } from './ProjectWorkspacePage';

const SUMMARY: AgentPlanSummary = {
  id: PLAN.id,
  title: PLAN.title,
  status: PLAN.status,
  revision: PLAN.revision,
  shot_count: PLAN.shots.filter((shot) => shot.removed_by === null).length,
  total_duration_seconds: PLAN.shots.reduce((total, shot) => total + shot.duration_seconds, 0),
  origin_count: PLAN.origin.length,
  created_at: PLAN.created_at,
  updated_at: PLAN.updated_at,
};

function client() {
  return {
    listAgentPlans: () => Promise.resolve([SUMMARY]),
    getAgentPlan: () => Promise.resolve(PLAN),
    listMontageProjects: () => Promise.resolve({ items: [] }),
    listEditorProjects: () => Promise.resolve({ items: [] }),
    listActivities: () => Promise.resolve({ items: [], total: 0, page: 1, page_size: 50, summary: { total: 0, active: 0, failed: 0, completed: 0, cancelled: 0 } }),
    listOutputs: () => Promise.resolve({ items: [], total: 0, page: 1, page_size: 100, scan_limited: false }),
  };
}

describe('Agent mode inside the project shot-list step', () => {
  it('mounts the existing conversation, modes, plan panel and revision trail under project context', async () => {
    const { container } = renderPage({
      element: <ProjectWorkspacePage />,
      client: client(),
      route: `/projects/${encodeURIComponent(`plan:${PLAN.id}`)}?step=shotlist`,
      pattern: '/projects/:projectId',
    });

    await waitFor(() => expect(container.querySelector('[data-agent-workspace]')).not.toBeNull());
    expect(container.querySelector('[data-agent-block="conversation"]')).not.toBeNull();
    expect(await screen.findByRole('radio', { name: '变更列表' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '就地编辑' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '候选镜头' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /会话历史/u })).toBeTruthy();
    expect(screen.getByRole('button', { name: /送去录制/u })).toBeTruthy();
    expect((await screen.findAllByText(PLAN.shots[0]?.title ?? '')).length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain(`修订 ${String(PLAN.revision)}`);
  });

  it('opens a new project on one start canvas without competing empty panels', async () => {
    const { container } = renderPage({
      element: <ProjectWorkspacePage />,
      client: { ...client(), listAgentPlans: () => Promise.resolve([]) },
      route: '/projects/new?step=shotlist',
      pattern: '/projects/:projectId',
    });

    await waitFor(() => expect(container.querySelector('[data-agent-workspace]')).not.toBeNull());
    expect(screen.getByText('告诉 Agent 你想要什么视频')).toBeTruthy();
    expect(screen.getByRole('button', { name: /写一句需求/u })).toBeTruthy();
    expect(container.querySelector('[data-agent-start-canvas]')).not.toBeNull();
    expect(screen.queryByText('还没有选中剪辑单')).toBeNull();
    expect(screen.queryByRole('radio', { name: '变更列表' })).toBeNull();
  });
});
