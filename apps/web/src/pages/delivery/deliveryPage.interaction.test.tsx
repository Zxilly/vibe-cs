/*
 * `interaction` project — 交付 with a stubbed service behind it.
 *
 * What is worth holding down here, in order of how badly it would hurt to lose:
 *
 *   1. 取消 actually cancels *and* the list it was clicked in re-runs. That is
 *      the invalidation chain from the page's side; `data/taskWrites` proves it
 *      from the data side, and both are needed — the page could bind the wrong
 *      job id and the data test would still pass.
 *   2. A service that is not connected disables the writes and says why
 *      (「不隐藏、不静默失败」), while the reading half of the page keeps working.
 *   3. The `?view=` switch is a real navigation, so the back button and a deep
 *      link both keep working.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { OutputItem, OutputPage } from '../../shared/desktop/dto';
import type { ActivityFeed, ActivityItem } from '../../shared/desktop/viewModels';
import { ActivityDrawer } from '../../ActivityDrawer';
import { DeliveryPage } from '../DeliveryPage';
import { HEALTHY, renderPage } from './test/renderPage';
import { reasonOf } from '../../test/reason';
import { unavailableNativeShell } from '../../data/nativeShell';

const RUNNING: ActivityItem = {
  id: 'recording:job-1',
  kind: 'recording',
  subtype: null,
  job_id: 'job-1',
  context_id: 'demo-1',
  subject: 'Kael_Mirage_1v3',
  status: 'running',
  stage: 'recording.stage.capturing',
  progress_percent: null,
  completed_units: 3,
  total_units: 5,
  unit: 'stages',
  error: null,
  failure: null,
  created_at: '2026-08-15T09:05:00.000Z',
  updated_at: '2026-08-15T09:09:00.000Z',
  available_actions: ['cancel', 'open_outputs'],
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
  media: {
    width: 1920,
    height: 1080,
    duration_seconds: 8.75,
    frame_rate: '60',
    video_codec: 'h264',
    audio_codec: 'aac',
  },
  project_id: null,
  agent_plan_id: null,
  demo_id: 'demo-1',
  error: null,
  created_at: '2026-08-15T09:12:00.000Z',
  updated_at: '2026-08-15T09:12:00.000Z',
};

const FEED: ActivityFeed = {
  items: [RUNNING],
  total: 1,
  page: 1,
  page_size: 50,
  summary: { total: 1, active: 1, failed: 0, completed: 0, cancelled: 0 },
};

const OUTPUTS: OutputPage = {
  items: [OUTPUT],
  total: 34,
  page: 1,
  page_size: 12,
  scan_limited: false,
};

interface Stubs {
  readonly cancelled: string[];
  readonly feedCalls: () => number;
  readonly client: Record<string, unknown>;
}

function stubs(): Stubs {
  const cancelled: string[] = [];
  let feedCalls = 0;

  return {
    cancelled,
    feedCalls: () => feedCalls,
    client: {
      listActivities: () => {
        feedCalls += 1;
        return Promise.resolve(FEED);
      },
      listOutputs: () => Promise.resolve(OUTPUTS),
      storageStatus: () =>
        Promise.resolve({
          data_dir: 'D:\\vibe',
          directory_bytes: 1,
          filesystem_total_bytes: 500_000_000_000,
          filesystem_available_bytes: 218_000_000_000,
          file_count: 1,
          directory_count: 1,
          scan_complete: true,
          checked_at: '2026-08-15T09:00:00.000Z',
        }),
      cancelRecordingJob: (id: string) => {
        cancelled.push(id);
        return Promise.resolve(undefined);
      },
    },
  };
}

function renderActivity(client: Record<string, unknown>, health = HEALTHY) {
  return renderPage({
    element: <ActivityDrawer open onClose={() => undefined} onUnreadChange={() => undefined} />,
    client,
    health,
  });
}

describe('成品 › 成品文件', () => {
  it('prints the count and the free space the header promises', async () => {
    const { client } = stubs();
    renderPage({
      element: <DeliveryPage />, client, route: '/delivery', health: HEALTHY,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    expect(await screen.findByText(/34 个成品文件/u)).toBeTruthy();
    expect(screen.getByText(/218 GB/u)).toBeTruthy();
  });

  it('lists the produced files with their path and a way to find them', async () => {
    const { client } = stubs();
    renderPage({
      element: <DeliveryPage />, client, route: '/delivery', health: HEALTHY,
      shell: {
        ...unavailableNativeShell,
        available: true,
        mediaSrc: (path) => `vibe-cs-media://localhost${path.slice(4)}`,
      },
    });

    expect(await screen.findByText('Kael_Mirage_1v3.mp4')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Kael 1v3' })).toBeTruthy();
    expect(screen.getByLabelText('Kael 1v3 preview')).toBeTruthy();
    expect(screen.getByText('8.75 s · 1920×1080 · 60 fps · H264 / AAC')).toBeTruthy();
    expect(screen.getByRole('button', { name: '定位文件' })).toBeTruthy();
  });

  it('uses one comparable file row and anchors the newest output', async () => {
    const { client } = stubs();
    const { container } = renderPage({
      element: <DeliveryPage />, client, route: '/delivery', health: HEALTHY,
    });

    await screen.findByRole('heading', { name: 'Kael 1v3' });
    expect(screen.getByText('文件大小')).toBeTruthy();
    expect(screen.getByText('时长 · 分辨率 · 帧率 · 编码')).toBeTruthy();
    expect(container.querySelector('[data-output-emphasized="true"]')?.getAttribute('data-output')).toBe('out-1');
  });
});

describe('成品 › 后台任务', () => {
  it('groups records by state and opens the existing detail body', async () => {
    const { client } = stubs();
    renderActivity(client);
    expect(await screen.findByRole('heading', { name: '进行中 · 1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    expect((await screen.findAllByText('recording:job-1')).length).toBeGreaterThan(0);
  });

  it('exposes all four task kinds through the unified feed contract', async () => {
    const items: ActivityItem[] = (['analysis', 'download', 'recording', 'export'] as const).map(
      (kind, index) => ({
        ...RUNNING,
        id: `${kind}:job-${String(index)}`,
        kind,
        job_id: `job-${String(index)}`,
        subject: `subject-${kind}`,
      }),
    );
    const client = {
      listActivities: () => Promise.resolve({ ...FEED, items, total: 4, summary: { ...FEED.summary, total: 4, active: 4 } }),
    };
    renderActivity(client);
    for (const label of ['分析', '下载', '录制', '导出']) {
      expect(await screen.findByText(new RegExp(`${label} · subject-`, 'u'))).toBeTruthy();
    }
  });

  it('retries a failed task from inside the drawer', async () => {
    const started: string[] = [];
    const failed: ActivityItem = {
      ...RUNNING,
      id: 'analysis:run-1',
      kind: 'analysis',
      job_id: 'run-1',
      context_id: 'demo-1',
      status: 'failed',
      error: 'parser failed',
      available_actions: ['retry_analysis'],
    };
    const client = {
      listActivities: () => Promise.resolve({
        ...FEED,
        items: [failed],
        summary: { total: 1, active: 0, failed: 1, completed: 0, cancelled: 0 },
      }),
      startAnalysisRun: (demoId: string) => {
        started.push(demoId);
        return Promise.resolve(undefined);
      },
    };
    renderActivity(client);

    fireEvent.click(await screen.findByRole('button', { name: '重试' }));
    await waitFor(() => expect(started).toEqual(['demo-1']));
  });

  it('cancels the job it was clicked in, and re-runs the list afterwards', async () => {
    const { client, cancelled, feedCalls } = stubs();
    renderActivity(client);

    const cancel = await screen.findByRole('button', { name: '取消' });
    const before = feedCalls();
    fireEvent.click(cancel);

    await waitFor(() => {
      expect(cancelled).toEqual(['job-1']);
    });
    await waitFor(() => {
      expect(feedCalls()).toBeGreaterThan(before);
    });
  });

  it('draws a progress bar only where the service sent a denominator', async () => {
    const { client } = stubs();
    renderActivity(client);

    // This record has 3/5 stages; the bar is the service's number, not a
    // percentage derived from the stage index.
    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuemax')).toBe('5');
    expect(bar.getAttribute('aria-valuenow')).toBe('3');
  });
});

describe('密度 (§10.3)', () => {
  /**
   * `TASK_RECORD_COUNT` — the 「最近 50 条」 retention default — with more
   * records behind it than fit on the page. The rule being checked is
   * 「该分页的要分页且页脚印出总数（静默截断是 bug）」.
   */
  const MANY = Array.from({ length: 50 }, (_unused, index): ActivityItem => ({
    ...RUNNING,
    id: `recording:job-${String(index)}`,
    job_id: `job-${String(index)}`,
    // Only every fifth record carries a denominator; the rest have a stage and
    // no numbers, which is the artboard's other branch.
    ...(index % 5 === 0
      ? {}
      : { completed_units: null, total_units: null, unit: null, progress_percent: null }),
  }));

  const client = {
    listActivities: () =>
      Promise.resolve({
        items: MANY,
        total: 137,
        page: 1,
        page_size: 50,
        summary: { total: 137, active: 50, failed: 0, completed: 87, cancelled: 0 },
      }),
    listOutputs: () => Promise.resolve(OUTPUTS),
  };

  it('prints the real total under a paged list instead of stopping silently', async () => {
    renderActivity(client);

    expect(await screen.findByText(/共 137 条/u)).toBeTruthy();
    expect(screen.getByText(/第 1–50 条/u)).toBeTruthy();
  });

  it('draws a bar for exactly the records that have a denominator', async () => {
    renderActivity(client);

    await screen.findByRole('heading', { name: '进行中 · 50' });
    // 10 of the 50 carry `completed_units` / `total_units`; the other 40 show a
    // stage name and no graphic. This is §10.3's own count, one page larger.
    expect(screen.getAllByRole('progressbar')).toHaveLength(10);
  });

  it('scrolls the records inside their own column, never on the document', async () => {
    const { container } = renderActivity(client);

    await screen.findByRole('heading', { name: '进行中 · 50' });
    expect(document.querySelector('[data-overlay="drawer"] .overflow-y-auto')).not.toBeNull();
    expect(container.querySelector('[data-page-body]')).toBeNull();
  });
});

describe('本地服务离线', () => {
  it('disables the writes, writes the reason, and leaves the reading half alone', async () => {
    const { client } = stubs();
    // No `health`: the probe has never answered, which is what the shell shows
    // as 「正在连接本地服务」 and what blocks an action.
    renderPage({ element: <DeliveryPage />, client, route: '/delivery' });

    // Read-only content is still there.
    expect(await screen.findByText('Kael_Mirage_1v3.mp4')).toBeTruthy();

    const cleanup = screen.getByRole('button', { name: /清理无效记录/u });
    expect(cleanup.hasAttribute('disabled')).toBe(true);
    expect(reasonOf(cleanup)).toMatch(/服务/u);

    // 定位文件 is a shell action, not a service call — it stays available.
    expect(screen.getByRole('button', { name: '定位文件' }).hasAttribute('disabled')).toBe(false);
  });

  it('marks the blocked action with the artboard s 「· 需要服务」 tail', async () => {
    const { client } = stubs();
    renderPage({ element: <DeliveryPage />, client, route: '/delivery' });

    const cleanup = await screen.findByRole('button', { name: /清理无效记录/u });
    expect(within(cleanup).getByText(/需要服务/u)).toBeTruthy();
  });
});
