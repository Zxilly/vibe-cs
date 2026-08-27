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
  const task = {
    id: 'recording:job-1', kind: 'recording', subtype: null, job_id: 'job-1', context_id: summary.id,
    subject: 'Mirage 残局', status: 'completed', stage: null, progress_percent: 100,
    completed_units: 5, total_units: 5, unit: 'stages', error: null, failure: null,
    created_at: '2026-08-20T01:00:00Z', updated_at: '2026-08-20T01:02:00Z', available_actions: [],
  } as const;
  return {
    listAgentPlans: () => Promise.resolve([summary]),
    listMontageProjects: () => Promise.resolve({ items: [] }),
    listEditorProjects: () => Promise.resolve({ items: [] }),
    listActivities: () => Promise.resolve({ items: [task], total: 1, page: 1, page_size: 50, summary: { total: 1, active: 0, failed: 0, completed: 1, cancelled: 0 } }),
    listOutputs: () => Promise.resolve({ items: [], total: 0, page: 1, page_size: 100, scan_limited: false }),
    quickCheck: () => Promise.resolve({ checks: [], checked_at: '2026-08-20T01:00:00Z' }),
    getRecordingJob: () => Promise.resolve({
      id: 'job-1', retry_of: null, status: 'completed', items: [], current_index: 0,
      progress: 1, message: '', outputs: [], error_code: null,
      created_at: '2026-08-20T01:00:00Z', updated_at: '2026-08-20T01:02:00Z',
    }),
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
    expect(reasonOf(screen.getByRole('button', { name: '录制' }))).toContain('添加片段后即可开始录制');
    expect(reasonOf(screen.getByRole('button', { name: '导出' }))).toContain('添加片段后即可导出');
  });

  it('allows arbitrary backward navigation instead of behaving like a locked wizard', async () => {
    render('/projects/plan%3Ap-1?step=export', plan('confirmed', 2));
    await screen.findByText('导出设置与这份作品的成品文件会显示在这里。');
    fireEvent.click(screen.getByRole('button', { name: '选材' }));
    expect(await screen.findByText('这份作品还没有收集片段')).toBeTruthy();
  });

  it('falls an illegal query back to the first reachable step', async () => {
    render('/projects/plan%3Ap-1?step=unknown');
    expect(await screen.findByText('这份作品还没有收集片段')).toBeTruthy();
  });

  it.each([
    ['select', '这份作品还没有收集片段'],
    ['shotlist', 'agent-workspace'],
    ['record', '录制队列'],
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
