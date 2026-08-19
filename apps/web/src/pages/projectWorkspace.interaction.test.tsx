import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AgentPlanSummary } from '../shared/desktop/dto';
import { reasonOf } from '../test/reason';
import { renderPage } from './delivery/test/renderPage';
import { ProjectWorkspacePage } from './ProjectWorkspacePage';

function plan(status: AgentPlanSummary['status'] = 'awaiting_confirmation', shots = 2): AgentPlanSummary {
  return { id: 'p-1', title: 'Mirage 残局', status, revision: 1, shot_count: shots,
    total_duration_seconds: 20, origin_count: 1, created_at: '2026-08-20T00:00:00Z', updated_at: '2026-08-20T01:00:00Z' };
}

function client(summary = plan()) {
  return {
    listAgentPlans: () => Promise.resolve([summary]),
    listMontageProjects: () => Promise.resolve({ items: [] }),
    listEditorProjects: () => Promise.resolve({ items: [] }),
    listActivities: () => Promise.resolve({ items: [], total: 0, page: 1, page_size: 50, summary: { total: 0, active: 0, failed: 0, completed: 0, cancelled: 0 } }),
    listOutputs: () => Promise.resolve({ items: [], total: 0, page: 1, page_size: 100, scan_limited: false }),
  };
}

function render(url: string, summary = plan()) {
  return renderPage({ element: <ProjectWorkspacePage />, client: client(summary), route: url, pattern: '/projects/:projectId' });
}

describe('project workspace steps', () => {
  it('renders the four-step navigation and explains both gates', async () => {
    render('/projects/plan%3Ap-1?step=shotlist', plan('draft', 0));
    await screen.findByRole('navigation', { name: '作品步骤' });
    expect(screen.getByRole('button', { name: '选材' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '剪辑单' })).toBeTruthy();
    expect(reasonOf(screen.getByRole('button', { name: '录制' }))).toContain('还没有片段');
    expect(reasonOf(screen.getByRole('button', { name: '导出' }))).toContain('还没有片段');
  });

  it('allows arbitrary backward navigation instead of behaving like a locked wizard', async () => {
    render('/projects/plan%3Ap-1?step=export', plan('confirmed', 2));
    await screen.findByText('导出设置与这份作品的成品文件会显示在这里。');
    fireEvent.click(screen.getByRole('button', { name: '选材' }));
    expect(await screen.findByText('比赛工作区与证据检索加入的片段会汇总到这里。')).toBeTruthy();
  });

  it('falls an illegal query back to the first reachable step', async () => {
    render('/projects/plan%3Ap-1?step=unknown');
    expect(await screen.findByText('比赛工作区与证据检索加入的片段会汇总到这里。')).toBeTruthy();
  });

  it.each([
    ['select', '比赛工作区与证据检索加入的片段会汇总到这里。'],
    ['shotlist', 'agent-workspace'],
    ['record', '这份作品的录制队列与片段进度会显示在这里。'],
    ['export', '导出设置与这份作品的成品文件会显示在这里。'],
  ])('renders the %s placeholder', async (step, copy) => {
    render(`/projects/plan%3Ap-1?step=${step}`, plan('confirmed', 2));
    if (step === 'shotlist') {
      await waitFor(() => expect(document.querySelector('[data-agent-workspace]')).not.toBeNull());
      return;
    }
    expect(await screen.findByText(new RegExp(copy, 'u'))).toBeTruthy();
  });
});
