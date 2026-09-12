import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ActivityQuery } from '../../../shared/desktop/dto';
import type { ActivityFeed, ActivityItem } from '../../../shared/desktop/viewModels';
import { renderPage } from '../../../test/renderPage';
import { TaskCenterPage } from './TaskCenterPage';

function task(page = 1): ActivityItem {
  return {
    id: `recording:job-${page}`, kind: 'recording', subtype: null, job_id: `job-${page}`,
    context_id: 'project-1', subject: `录制片段 ${page}`, status: 'running', stage: 'recording.stage.capturing',
    progress_percent: null, completed_units: 3, total_units: 5, unit: 'stages', error: null, failure: null,
    created_at: '2026-09-12T08:00:00Z', updated_at: '2026-09-12T08:01:00Z', available_actions: [],
  };
}

describe('shared task center', () => {
  it('requests filtered pages from the task feed and resets pagination when the filter changes', async () => {
    const listActivities = vi.fn((query: ActivityQuery): Promise<ActivityFeed> => Promise.resolve({
      items: [task(query.page)], total: 41, page: query.page ?? 1, page_size: 20,
      summary: { total: 41, active: 40, failed: 1, completed: 0, cancelled: 0 },
    }));
    renderPage({ route: '/tasks', element: <TaskCenterPage />, client: { listActivities } });
    await screen.findByRole('heading', { name: /录制片段 1/ });
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(listActivities.mock.calls.at(-1)?.[0]).toMatchObject({ page: 2, page_size: 20 }));
    fireEvent.click(screen.getByRole('radio', { name: '失败' }));
    await waitFor(() => expect(listActivities.mock.calls.at(-1)?.[0]).toMatchObject({ page: 1, state: 'failed' }));
  });

  it('opens the selected task detail and does not invent unsupported task actions', async () => {
    renderPage({ route: '/tasks', element: <TaskCenterPage />, client: {
      listActivities: () => Promise.resolve({
        items: [task()], total: 1, page: 1, page_size: 20,
        summary: { total: 1, active: 1, failed: 0, completed: 0, cancelled: 0 },
      }),
    } });
    fireEvent.click(await screen.findByRole('button', { name: '查看详情' }));
    expect(await screen.findByRole('complementary', { name: '任务详情' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '取消任务' })).toBeNull();
  });
});
