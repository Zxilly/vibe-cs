/*
 * `interaction` project — 任务详情与阶段日志.
 *
 * The three things this page owes the rest of the app:
 *   · a bad address is answered here, not sent to the service;
 *   · the stage log is the analysis run's real events, in the user's language;
 *   · 重试 / 取消 appear only where `taskMachine` allows the transition, and
 *     firing one calls the command the service actually offers.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ActivityItem, AnalysisRunDetail } from '../../shared/desktop/dto';
import { TaskDetailPage } from '../TaskDetailPage';
import { HEALTHY, renderPage } from './test/renderPage';

const ANALYSIS: ActivityItem = {
  id: 'analysis:run-1',
  kind: 'analysis',
  subtype: null,
  job_id: 'run-1',
  context_id: 'demo-1',
  subject: 'Kestrel vs Halcyon',
  status: 'failed',
  stage: 'parser_running',
  progress_percent: null,
  completed_units: null,
  total_units: null,
  unit: null,
  error: '解析器在第 3 阶段退出',
  created_at: '2026-08-15T09:00:00.000Z',
  updated_at: '2026-08-15T09:04:00.000Z',
  available_actions: ['retry_analysis', 'open_library'],
};

const RUN: AnalysisRunDetail = {
  run: {
    id: 'run-1',
    demo_id: 'demo-1',
    input_sha256: null,
    input_size: null,
    status: 'failed',
    stage: 'parser_running',
    error: '解析器在第 3 阶段退出',
    created_at: '2026-08-15T09:00:00.000Z',
    updated_at: '2026-08-15T09:04:00.000Z',
  },
  result_available: false,
  events: [
    {
      run_id: 'run-1',
      sequence: 1,
      stage: 'validating_input',
      message_code: 'input_validation_started',
      detail: null,
      created_at: '2026-08-15T09:00:00.000Z',
    },
    {
      run_id: 'run-1',
      sequence: 2,
      stage: 'parser_running',
      message_code: 'failed',
      detail: '解析器在第 3 阶段退出',
      created_at: '2026-08-15T09:04:00.000Z',
    },
  ],
};

function stubs(item: ActivityItem = ANALYSIS) {
  const started: string[] = [];
  const cancelled: string[] = [];

  return {
    started,
    cancelled,
    client: {
      getActivity: () => Promise.resolve(item),
      getAnalysisRun: () => Promise.resolve(RUN),
      startAnalysisRun: (id: string) => {
        started.push(id);
        return Promise.resolve(RUN.run);
      },
      cancelRecordingJob: (id: string) => {
        cancelled.push(id);
        return Promise.resolve(undefined);
      },
    },
  };
}

function render(taskId: string, client: Record<string, unknown>) {
  return renderPage({
    element: <TaskDetailPage />,
    client,
    route: `/delivery/task/${encodeURIComponent(taskId)}`,
    pattern: '/delivery/task/:taskId',
    health: HEALTHY,
  });
}

/** The same page with the health entry never seeded — the offline state. */
function renderOffline(taskId: string, client: Record<string, unknown>) {
  return renderPage({
    element: <TaskDetailPage />,
    client,
    route: `/delivery/task/${encodeURIComponent(taskId)}`,
    pattern: '/delivery/task/:taskId',
  });
}

describe('the address', () => {
  it('answers an address that is not a task locator without asking the service', async () => {
    let asked = 0;
    render('t-42', {
      getActivity: () => {
        asked += 1;
        return Promise.resolve(ANALYSIS);
      },
    });

    expect(await screen.findByText('找不到这条任务')).toBeTruthy();
    expect(asked).toBe(0);
  });

  it('keeps the way back to 任务记录, not to 输出', async () => {
    const { client } = stubs();
    render('analysis:run-1', client);

    const back = await screen.findByRole('link', { name: '‹ 任务记录' });
    expect(back.getAttribute('href')).toBe('/delivery?view=tasks');
  });
});

describe('the stage log', () => {
  it('prints the run s own events in the user s language', async () => {
    const { client } = stubs();
    render('analysis:run-1', client);

    expect(await screen.findByText('开始校验输入文件')).toBeTruthy();
    // The service's own sentence rides along behind the closed-set label — in
    // the log line, and again in the failure Notice above it.
    expect(screen.getAllByText(/解析器在第 3 阶段退出/u).length).toBeGreaterThan(0);
  });

  it('has no log for a kind the service keeps none for, and says so', async () => {
    const recording: ActivityItem = {
      ...ANALYSIS,
      id: 'recording:job-1',
      kind: 'recording',
      job_id: 'job-1',
      status: 'running',
      stage: 'recording.stage.capturing',
      error: null,
      available_actions: ['cancel'],
    };
    const { client } = stubs(recording);
    render('recording:job-1', client);

    expect(await screen.findByText('还没有阶段日志')).toBeTruthy();
  });
});

describe('重试 / 取消', () => {
  it('retries a failed analysis against its demo', async () => {
    const { client, started } = stubs();
    render('analysis:run-1', client);

    // Exactly one 重试: the failure Notice's recovery action. The header's
    // retry belongs to a *cancelled* task (「重新发起」), so a failed one does
    // not draw the same action twice.
    const retry = await screen.findByRole('button', { name: '重试' });
    fireEvent.click(retry);

    await waitFor(() => {
      expect(started).toEqual(['demo-1']);
    });
  });

  it('offers 取消 on a running recording and not on a finished analysis', async () => {
    const recording: ActivityItem = {
      ...ANALYSIS,
      id: 'recording:job-1',
      kind: 'recording',
      job_id: 'job-1',
      status: 'running',
      stage: 'recording.stage.capturing',
      error: null,
      available_actions: ['cancel'],
    };
    const { client, cancelled } = stubs(recording);
    render('recording:job-1', client);

    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    await waitFor(() => {
      expect(cancelled).toEqual(['job-1']);
    });
  });

  it('offers neither once the task has succeeded — the machine has no transition left', async () => {
    const done: ActivityItem = {
      ...ANALYSIS,
      status: 'completed',
      error: null,
      available_actions: ['open_analysis', 'open_library'],
    };
    const { client } = stubs(done);
    render('analysis:run-1', client);

    await screen.findByText('分析 · Kestrel vs Halcyon');
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();
  });

  it('blocks the write while the service is not connected, and says why', async () => {
    const { client, started } = stubs();
    renderOffline('analysis:run-1', client);

    // The record still reads; only the write is gated.
    expect(await screen.findByText('开始校验输入文件')).toBeTruthy();

    // The failure Notice keeps its recovery action — disabled, with the reason
    // attached, which is 「不隐藏、不静默失败」.
    const recovery = screen.getByRole('button', { name: '重试' });
    expect(recovery.hasAttribute('disabled')).toBe(true);
    fireEvent.click(recovery);
    expect(started).toEqual([]);
  });
});
