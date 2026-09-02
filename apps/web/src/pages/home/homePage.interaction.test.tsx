/*
 * `interaction` project — 工作台首页, the two blocks phase 3a owns.
 *
 * The page is scheduled for 3g; what is asserted here is that the parts built
 * from task and output data are real, and that the parts that are not built are
 * *named* rather than mocked up. A placeholder that says which phase fills it
 * is honest; a hard-coded 「Aurora vs Meridian」 row would not be.
 */

import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ActivityQuery, OutputItem, OutputPage } from '../../shared/desktop/dto';
import type { ActivityFeed, ActivityItem } from '../../shared/desktop/viewModels';
import { HomePage } from '../HomePage';
import { renderPage } from '../delivery/test/renderPage';

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
  project_revision: null,
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
  it('removes the task progress wall and raw task ids from the first screen', async () => {
    renderPage({ element: <HomePage />, client: CLIENT, route: '/' });

    expect(await screen.findByText('需要我处理')).toBeTruthy();
    expect(screen.queryByText('analysis:run-1')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('raises the one failure that can still be recovered', async () => {
    renderPage({ element: <HomePage />, client: CLIENT, route: '/' });

    const block = await screen.findByRole('region', { name: '失败可恢复' });
    expect(within(block).getByText(/磁盘空间不足/u)).toBeTruthy();
    // 「剪辑」 rather than generic 「导出」: the subtype names the failed work.
    expect(within(block).getByText(/剪辑/u)).toBeTruthy();
  });

  it('keeps internal HLAE diagnostics on the task detail surface', async () => {
    const internal = {
      ...FAILED,
      error: 'internal operation failed: managed HLAE bridge reported failure: record start arrived before observer identity was verified',
    };
    renderPage({
      element: <HomePage />,
      client: {
        ...CLIENT,
        listActivities: (query: ActivityQuery) => Promise.resolve(
          query.state === 'failed' ? feed([internal], 1, 1) : feed([RUNNING], 1, 1),
        ),
      },
      route: '/',
    });

    const block = await screen.findByRole('region', { name: '失败可恢复' });
    expect(within(block).getByText(/采集组件没能启动/u)).toBeTruthy();
    expect(block.textContent).not.toContain('observer identity');
  });

  it('leaves finished files out of the workbench now that they have their own destination', async () => {
    renderPage({ element: <HomePage />, client: CLIENT, route: '/' });

    await screen.findByText('需要我处理');
    expect(screen.queryByText('Kael_Mirage_1v3.mp4')).toBeNull();
    expect(screen.queryByRole('link', { name: '全部成品文件' })).toBeNull();
  });

  it('draws exactly the three IA blocks in their required order', async () => {
    renderPage({ element: <HomePage />, client: CLIENT, route: '/' });

    await screen.findByText('需要我处理');
    const blocks = [...document.querySelectorAll('[data-home-layout="three-sections"] > [data-home-block]')];
    expect(blocks.map((block) => block.getAttribute('data-home-block'))).toEqual([
      'needs-attention',
      'continue',
      'new',
    ]);
  });

  it('says nothing about the environment while nothing is blocked', async () => {
    // 「环境问题只在阻塞相应任务时出现在这里」 — a banner on a healthy
    // workbench is the thing that sentence rules out.
    renderPage({ element: <HomePage />, client: CLIENT, route: '/' });
    await screen.findByText('需要我处理');
    expect(document.querySelector('[data-home-block="environment"]')).toBeNull();
  });

  it('says what a blocked dependency stops, not just that it is missing', async () => {
    renderPage({
      element: <HomePage />,
      client: {
        ...CLIENT,
        quickCheck: () =>
          Promise.resolve({
            checks: [
              { kind: 'hlae', state: 'missing', label: '受管 HLAE', detail: '未探测到可执行文件' },
              { kind: 'cs2', state: 'warning', label: 'CS2', detail: '版本较旧' },
            ],
            checked_at: '2026-08-16T08:00:00.000Z',
          }),
      },
      route: '/',
    });

    await waitFor(() => {
      expect(document.querySelector('[data-home-block="environment"]')).not.toBeNull();
    });
    // The consequence, beside the service's own words.
    expect(document.body.textContent).toContain('录制起不来');
    expect(document.body.textContent).toContain('未探测到可执行文件');
    // A warning is worth reading in diagnostics and is not worth a banner.
    expect(document.querySelector('[data-blocking-check="cs2"]')).toBeNull();
  });

  it('keeps the main action on the bar at any width', async () => {
    renderPage({ element: <HomePage />, client: CLIENT, route: '/' });

    const primary = (await screen.findAllByRole('button', { name: '新建作品' }))[0];
    // §8: the main action never enters an overflow menu — `Toolbar` keeps it in
    // its own slot, which is what `data-toolbar-primary` marks.
    expect(primary?.closest('[data-toolbar-primary]')).not.toBeNull();
  });

  it('shows one import-Demo first-run action when the library is empty', async () => {
    renderPage({
      element: <HomePage />,
      client: { ...CLIENT, listDemos: () => Promise.resolve({ items: [], total: 0, page: 1, page_size: 1 }) },
      route: '/',
    });

    expect(await screen.findByText('从导入 Demo 开始')).toBeTruthy();
    const firstRun = document.querySelector('[data-home-block="first-run"]') as HTMLElement;
    expect(within(firstRun).getAllByRole('link', { name: '导入 Demo' })).toHaveLength(1);
    expect(firstRun.className).toContain('border-accent');
  });
});
