import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubMatchMedia, type MatchMediaStub } from '../../../design/layout/collapse.testing';
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

const EXPORTED: ActivityItem = {
  id: 'export:job-9', kind: 'export', subtype: 'project', job_id: 'job-9',
  context_id: 'project-1', subject: '八月集锦 · r3', status: 'completed', stage: null,
  progress_percent: 100, completed_units: null, total_units: null, unit: null, error: null, failure: null,
  created_at: '2026-09-12T08:00:00Z', updated_at: '2026-09-12T08:17:00Z', available_actions: ['open_outputs'],
};

function feedOf(items: ActivityItem[]): ActivityFeed {
  return {
    items, total: items.length, page: 1, page_size: 20,
    summary: { total: items.length, active: 0, failed: 0, completed: items.length, cancelled: 0 },
  };
}

let media: MatchMediaStub | null = null;

afterEach(() => {
  media?.restore();
  media = null;
});

describe('shared task center', () => {
  it('retries the current page after a read failure instead of treating it as an empty result', async () => {
    let fail = false;
    const listActivities = vi.fn((query: ActivityQuery): Promise<ActivityFeed> => fail
      ? Promise.reject(new Error('task feed unavailable'))
      : Promise.resolve({ ...feedOf([task(query.page)]), total: 21, page: query.page ?? 1 }));
    renderPage({ route: '/tasks', element: <TaskCenterPage />, client: { listActivities } });
    await screen.findByRole('heading', { name: /录制片段 1/u });
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByRole('heading', { name: /录制片段 2/u });
    fail = true;
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(await screen.findByText('task feed unavailable')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    await screen.findByRole('heading', { name: /录制片段 2/u });
    expect(listActivities.mock.calls.at(-1)?.[0]).toMatchObject({ page: 2 });
  });

  it('returns to a valid page when completion empties the last filtered page', async () => {
    let completed = false;
    const listActivities = vi.fn((query: ActivityQuery): Promise<ActivityFeed> => Promise.resolve({
      items: completed && query.page === 2 ? [] : [task(query.page)], total: completed ? 20 : 21,
      page: query.page ?? 1, page_size: 20,
      summary: { total: 21, active: completed ? 20 : 21, failed: 0, completed: completed ? 1 : 0, cancelled: 0 },
    }));
    renderPage({ route: '/tasks', element: <TaskCenterPage />, client: { listActivities } });
    fireEvent.click(screen.getByRole('radio', { name: '进行中' }));
    await screen.findByRole('heading', { name: /录制片段 1/u });
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByRole('heading', { name: /录制片段 2/u });
    completed = true;
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(listActivities.mock.calls.at(-1)?.[0]).toMatchObject({ page: 1, state: 'active' }));
    expect(await screen.findByRole('heading', { name: /录制片段 1/u })).toBeTruthy();
    expect(screen.queryByText('没有进行中的任务')).toBeNull();
  });

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

  it('names the filter in the empty state and offers the way back to 全部', async () => {
    const listActivities = vi.fn((query: ActivityQuery): Promise<ActivityFeed> =>
      Promise.resolve(query.state === 'cancelled' ? feedOf([]) : feedOf([task()])));
    renderPage({ route: '/tasks', element: <TaskCenterPage />, client: { listActivities } });
    await screen.findByRole('heading', { name: /录制片段 1/ });

    fireEvent.click(screen.getByRole('radio', { name: '已取消' }));
    expect(await screen.findByRole('heading', { name: '没有已取消的任务' })).toBeTruthy();
    expect(screen.queryByText('还没有后台任务')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '查看全部' }));
    expect(await screen.findByRole('heading', { name: /录制片段 1/ })).toBeTruthy();
    expect(listActivities.mock.calls.at(-1)?.[0]).not.toHaveProperty('state');
  });

  it('opens the detail as an overlay below the fold, where there is no room beside the list', async () => {
    media = stubMatchMedia(true);
    renderPage({ route: '/tasks', element: <TaskCenterPage />, client: {
      listActivities: () => Promise.resolve(feedOf([task()])),
    } });
    await screen.findByRole('heading', { name: /录制片段 1/ });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('打开任务详情')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    const overlay = await screen.findByRole('dialog', { name: '任务详情' });
    expect(overlay.textContent).toContain('录制片段 1');
  });

  it('links a finished export to 成品文件, because the record offers open_outputs', async () => {
    renderPage({ route: '/tasks', element: <TaskCenterPage />, client: {
      listActivities: () => Promise.resolve(feedOf([EXPORTED])),
      getExportJob: () => Promise.resolve({
        kind: 'project',
        job: {
          id: 'job-9', project_id: 'project-1', project_revision: 3, range_start_seconds: 0, range_end_seconds: 10,
          status: 'completed', progress: 1, output_path: 'C:\\exports\\august.mp4', error: null, error_code: null,
          created_at: EXPORTED.created_at, updated_at: EXPORTED.updated_at,
        },
      }),
    } });
    const row = await screen.findByRole('heading', { name: /八月集锦 · r3/ });
    const link = screen.getByRole('link', { name: '查看成品' });
    expect(link.getAttribute('href')).toContain('/delivery?view=outputs');

    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    const detail = await screen.findByRole('complementary', { name: '任务详情' });
    expect(detail.querySelector('a[href*="/delivery?view=outputs"]')).not.toBeNull();
    // The path is a detail, not the title: the row is named after its Project.
    expect(row.textContent).not.toContain('C:\\exports');
    expect(await screen.findByText('C:\\exports\\august.mp4')).toBeTruthy();
  });
});
