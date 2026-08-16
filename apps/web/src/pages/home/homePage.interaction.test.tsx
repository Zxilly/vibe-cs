/*
 * `interaction` project — 工作台首页, the two blocks phase 3a owns.
 *
 * The page is scheduled for 3g; what is asserted here is that the parts built
 * from task and output data are real, and that the parts that are not built are
 * *named* rather than mocked up. A placeholder that says which phase fills it
 * is honest; a hard-coded 「Aurora vs Meridian」 row would not be.
 */

import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ActivityQuery, OutputItem, OutputPage } from '../../shared/desktop/dto';
import type { ActivityFeed, ActivityItem } from '../../shared/desktop/viewModels';
import { HomePage } from '../HomePage';
import { HEALTHY, renderPage } from '../delivery/test/renderPage';

const RUNNING: ActivityItem = {
  id: 'analysis:run-1',
  kind: 'analysis',
  subtype: null,
  job_id: 'run-1',
  context_id: 'demo-1',
  subject: 'Aurora vs Meridian',
  status: 'running',
  stage: 'parser_running',
  progress_percent: 62,
  completed_units: null,
  total_units: null,
  unit: null,
  error: null,
  failure: null,
  created_at: '2026-08-15T09:00:00.000Z',
  updated_at: '2026-08-15T09:02:00.000Z',
  available_actions: ['cancel'],
};

const FAILED: ActivityItem = {
  ...RUNNING,
  id: 'export:job-9',
  kind: 'export',
  subtype: 'montage',
  job_id: 'job-9',
  context_id: 'project-1',
  subject: 'Aurora 赛点集锦',
  status: 'failed',
  stage: null,
  progress_percent: null,
  error: '磁盘空间不足，已保留工程与素材',
  failure: null,
  available_actions: ['open_outputs'],
};

const OUTPUT: OutputItem = {
  id: 'out-1',
  output_kind: 'recording',
  media_kind: 'clip',
  title: 'Kael 1v3',
  path: 'D:\\vibe\\outputs\\Kael_Mirage_1v3.mp4',
  file_name: 'Kael_Mirage_1v3.mp4',
  status: 'completed',
  progress: 1,
  availability: 'present',
  managed: true,
  mutable: true,
  size_bytes: 186_000_000,
  media: null,
  project_id: null,
  demo_id: 'demo-1',
  error: null,
  created_at: '2026-08-15T09:12:00.000Z',
  updated_at: '2026-08-15T09:12:00.000Z',
};

const OUTPUTS: OutputPage = { items: [OUTPUT], total: 34, page: 1, page_size: 2, scan_limited: false };

function feed(items: readonly ActivityItem[], active: number, failed: number): ActivityFeed {
  return {
    items: [...items],
    total: items.length,
    page: 1,
    page_size: 5,
    summary: { total: items.length, active, failed, completed: 0, cancelled: 0 },
  };
}

const CLIENT = {
  listActivities: (query: ActivityQuery) =>
    Promise.resolve(
      query.state === 'failed' ? feed([FAILED], 1, 2) : feed([RUNNING], 1, 2),
    ),
  listOutputs: () => Promise.resolve(OUTPUTS),
};

describe('工作台首页', () => {
  it('shows what is running, with the service s own denominator', async () => {
    renderPage({ element: <HomePage />, client: CLIENT, route: '/', health: HEALTHY });

    // The record's own locator, printed in the mono face beside its title —
    // the title itself is 「分析 · Aurora vs Meridian」, two nodes in one line.
    expect(await screen.findByText('analysis:run-1')).toBeTruthy();
    const bar = screen.getAllByRole('progressbar')[0];
    // 62 % came from `progress_percent`; nothing here derives it from a stage.
    expect(bar?.getAttribute('aria-valuenow')).toBe('62');
  });

  it('raises the one failure that can still be recovered', async () => {
    renderPage({ element: <HomePage />, client: CLIENT, route: '/', health: HEALTHY });

    const block = await screen.findByRole('region', { name: '失败可恢复' });
    expect(within(block).getByText(/磁盘空间不足/u)).toBeTruthy();
    // 「合辑导出」 rather than 「导出」: the subtype is where 合辑 lives.
    expect(within(block).getByText(/合辑/u)).toBeTruthy();
  });

  it('shows the most recent outputs beside them', async () => {
    renderPage({ element: <HomePage />, client: CLIENT, route: '/', health: HEALTHY });

    expect(await screen.findByText('Kael_Mirage_1v3.mp4')).toBeTruthy();
    expect(screen.getByRole('link', { name: '全部输出' }).getAttribute('href')).toBe('/delivery');
  });

  it('names the blocks it does not build yet instead of faking them', async () => {
    renderPage({ element: <HomePage />, client: CLIENT, route: '/', health: HEALTHY });

    expect(await screen.findByText('待确认的方案')).toBeTruthy();
    expect(screen.getByText(/这一块在阶段 3e 接入/u)).toBeTruthy();
    expect(screen.getByText('最近比赛')).toBeTruthy();
    expect(screen.getByText(/这一块在阶段 3b 接入/u)).toBeTruthy();
  });

  it('keeps the main action on the bar at any width', async () => {
    renderPage({ element: <HomePage />, client: CLIENT, route: '/', health: HEALTHY });

    const primary = await screen.findByRole('button', { name: '用 Agent 制作视频' });
    // §8: the main action never enters an overflow menu — `Toolbar` keeps it in
    // its own slot, which is what `data-toolbar-primary` marks.
    expect(primary.closest('[data-toolbar-primary]')).not.toBeNull();
  });
});
