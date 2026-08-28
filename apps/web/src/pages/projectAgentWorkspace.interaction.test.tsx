import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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

function client(overrides: Record<string, unknown> = {}) {
  return {
    listAgentPlans: () => Promise.resolve([SUMMARY]),
    getAgentPlan: () => Promise.resolve(PLAN),
    getAgentPlanWorkbench: () => Promise.resolve({
      plan: PLAN,
      materializations: PLAN.shots.map((shot) => ({
        shot_id: shot.id,
        state: 'unrecorded' as const,
        compatible_take_count: 0,
        stale_take_count: 0,
      })),
      composition: null,
    }),
    listMontageProjects: () => Promise.resolve({ items: [] }),
    listEditorProjects: () => Promise.resolve({ items: [] }),
    listActivities: () => Promise.resolve({ items: [], total: 0, page: 1, page_size: 50, summary: { total: 0, active: 0, failed: 0, completed: 0, cancelled: 0 } }),
    listOutputs: () => Promise.resolve({ items: [], total: 0, page: 1, page_size: 100, scan_limited: false }),
    getAgentComposition: () => Promise.resolve(null),
    ...overrides,
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
    expect(await screen.findByRole('radio', { name: '修改列表' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '就地编辑' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Take 比较' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /会话历史/u })).toBeTruthy();
    expect(screen.getByRole('button', { name: /确认剪辑单并录制/u })).toBeTruthy();
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
    expect(container.querySelector('[data-agent-draft-canvas]')).not.toBeNull();
    expect(screen.getByRole('textbox', { name: /给剪辑单下一条指令/u })).toBeTruthy();
    expect(container.querySelector('[data-agent-start-canvas]')).not.toBeNull();
    expect(screen.queryByText('还没有选中剪辑单')).toBeNull();
    expect(screen.queryByRole('radio', { name: '修改列表' })).toBeNull();
  });

  it('opens the persisted Quick copy without pretending it is a live mode switch', async () => {
    const montage = {
      id: 'composition-1', name: 'Quick copy', clips: [],
      settings: {
        width: 1920, height: 1080, fps: 60, encoder: 'auto', quality: 80,
        background_music: null, music_volume: 0.25, transition_seconds: 0.35,
        intro_title: null, intro_duration_seconds: 0, include_name_cards: false,
        name_card_duration_seconds: 2.5, outro_title: null, outro_duration_seconds: 0,
        branding_theme: 'vibe',
      },
      created_at: '2026-08-20T00:00:00Z', updated_at: '2026-08-20T00:00:00Z',
    };
    const getMontageProject = vi.fn(() => Promise.resolve(montage));
    const composition = {
      id: montage.id,
      plan_id: PLAN.id,
      plan_revision: PLAN.revision,
      title: PLAN.title,
      status: 'exported' as const,
      items: [],
      export_job_id: 'export-1',
      export_status: 'completed' as const,
      output_path: 'C:/outputs/final.mp4',
      error: null,
      created_at: '2026-08-20T00:00:00Z',
      updated_at: '2026-08-20T00:00:00Z',
    };
    renderPage({
      element: <ProjectWorkspacePage />,
      client: client({
        listMontageProjects: () => Promise.resolve({ items: [montage] }),
        getMontageProject,
        getAgentComposition: () => Promise.resolve(composition),
        getAgentPlanWorkbench: () => Promise.resolve({
          plan: PLAN,
          materializations: PLAN.shots.map((shot) => ({
            shot_id: shot.id,
            state: 'recorded' as const,
            compatible_take_count: 1,
            stale_take_count: 0,
          })),
          composition,
        }),
      }),
      route: `/projects/${encodeURIComponent(`plan:${PLAN.id}`)}?step=shotlist`,
      pattern: '/projects/:projectId',
    });

    await screen.findByRole('radio', { name: '快速剪辑' });
    await waitFor(() => expect(getMontageProject).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('radio', { name: '快速剪辑' }));

    expect(screen.getByText(/已确认 Composition 生成的快速剪辑工程/u)).toBeTruthy();
    expect(screen.getByText(/两边后续修改不会同步/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开副本' })).toBeTruthy();
  });
});
