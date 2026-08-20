/*
 * `interaction` project — 工作台首页, the two blocks phase 3a owns.
 *
 * The page is scheduled for 3g; what is asserted here is that the parts built
 * from task and output data are real, and that the parts that are not built are
 * *named* rather than mocked up. A placeholder that says which phase fills it
 * is honest; a hard-coded 「Aurora vs Meridian」 row would not be.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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
  agent_plan_id: null,
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
    renderPage({ element: <HomePage />, client: CLIENT, route: '/', health: HEALTHY });

    expect(await screen.findByText('需要我处理')).toBeTruthy();
    expect(screen.queryByText('analysis:run-1')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('prints a plan s length beside its shot count', async () => {
    const plans = [
      {
        id: 'plan-1',
        title: 'Kael Mirage 1v3',
        status: 'awaiting_confirmation' as const,
        revision: 3,
        // Both figures come from the summary and both exclude soft-removed
        // shots — the service computes them where the shot bodies already are,
        // so a list of plans does not become a list of requests.
        shot_count: 4,
        total_duration_seconds: 42,
        origin_count: 3,
        created_at: '2026-08-15T09:00:00.000Z',
        updated_at: '2026-08-15T09:30:00.000Z',
      },
    ];
    renderPage({
      element: <HomePage />,
      client: { ...CLIENT, listAgentPlans: () => Promise.resolve(plans) },
      route: '/',
      health: HEALTHY,
    });

    const row = await waitFor(() => {
      const node = document.querySelector('[data-plan="plan-1"]');
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    expect(row.textContent).toContain('42.0s');
    expect(row.textContent).toContain('4 个镜头');
  });

  it('hides a snoozed plan until its instant has passed', async () => {
    const base = {
      title: 'Kael Mirage 1v3',
      status: 'awaiting_confirmation' as const,
      revision: 3,
      shot_count: 4,
      total_duration_seconds: 42,
      origin_count: 3,
      created_at: '2026-08-15T09:00:00.000Z',
      updated_at: '2026-08-15T09:30:00.000Z',
    };
    const plans = [
      { ...base, id: 'plan-open', snoozed_until: null },
      // Pushed away until a moment that has not arrived.
      { ...base, id: 'plan-later', snoozed_until: '2099-01-01T00:00:00.000Z' },
      // Pushed away, and the moment came: it is back on its own, with nothing
      // having had to clear a flag.
      { ...base, id: 'plan-returned', snoozed_until: '2020-01-01T00:00:00.000Z' },
    ];
    renderPage({
      element: <HomePage />,
      client: { ...CLIENT, listAgentPlans: () => Promise.resolve(plans) },
      route: '/',
      health: HEALTHY,
    });

    await waitFor(() => {
      expect(document.querySelector('[data-plan="plan-open"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-plan="plan-returned"]')).not.toBeNull();
    expect(document.querySelector('[data-plan="plan-later"]')).toBeNull();
  });

  it('snoozes a plan until the reader s own next midnight', async () => {
    const snoozeAgentPlan = vi.fn(async (planId: string, until: string | null) => ({
      id: planId,
      title: 'Kael Mirage 1v3',
      status: 'awaiting_confirmation' as const,
      revision: 3,
      snoozed_until: until,
      shots: [],
      origin: [],
      agent_baseline: { revision: 1, captured_at: '2026-08-15T09:00:00.000Z', shots: [] },
      created_at: '2026-08-15T09:00:00.000Z',
      updated_at: '2026-08-15T09:30:00.000Z',
    }));
    const plans = [
      {
        id: 'plan-1',
        title: 'Kael Mirage 1v3',
        status: 'awaiting_confirmation' as const,
        revision: 3,
        snoozed_until: null,
        shot_count: 4,
        total_duration_seconds: 42,
        origin_count: 3,
        created_at: '2026-08-15T09:00:00.000Z',
        updated_at: '2026-08-15T09:30:00.000Z',
      },
    ];
    renderPage({
      element: <HomePage />,
      client: { ...CLIENT, listAgentPlans: () => Promise.resolve(plans), snoozeAgentPlan },
      route: '/',
      health: HEALTHY,
    });

    fireEvent.click(await screen.findByRole('button', { name: /稍后处理/u }));

    await waitFor(() => expect(snoozeAgentPlan).toHaveBeenCalledTimes(1));
    const until = snoozeAgentPlan.mock.calls[0]?.[1];
    expect(until).toBeTypeOf('string');
    // Midnight in the reader's own zone, which is the whole reason the client
    // computes it: the service cannot.
    const at = new Date(until as string);
    expect(at.getHours()).toBe(0);
    expect(at.getMinutes()).toBe(0);
    expect(at.getTime()).toBeGreaterThan(Date.now());
  });

  it('raises the one failure that can still be recovered', async () => {
    renderPage({ element: <HomePage />, client: CLIENT, route: '/', health: HEALTHY });

    const block = await screen.findByRole('region', { name: '失败可恢复' });
    expect(within(block).getByText(/磁盘空间不足/u)).toBeTruthy();
    // 「合辑导出」 rather than 「导出」: the subtype is where 合辑 lives.
    expect(within(block).getByText(/合辑/u)).toBeTruthy();
  });

  it('leaves finished files out of the workbench now that they have their own destination', async () => {
    renderPage({ element: <HomePage />, client: CLIENT, route: '/', health: HEALTHY });

    await screen.findByText('需要我处理');
    expect(screen.queryByText('Kael_Mirage_1v3.mp4')).toBeNull();
    expect(screen.queryByRole('link', { name: '全部成品文件' })).toBeNull();
  });

  it('draws exactly the three IA blocks in their required order', async () => {
    renderPage({ element: <HomePage />, client: CLIENT, route: '/', health: HEALTHY });

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
    renderPage({ element: <HomePage />, client: CLIENT, route: '/', health: HEALTHY });
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
      health: HEALTHY,
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
    renderPage({ element: <HomePage />, client: CLIENT, route: '/', health: HEALTHY });

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
      health: HEALTHY,
    });

    expect(await screen.findByText('从导入 Demo 开始')).toBeTruthy();
    const firstRun = document.querySelector('[data-home-block="first-run"]') as HTMLElement;
    expect(within(firstRun).getAllByRole('link', { name: '导入 Demo' })).toHaveLength(1);
  });
});
