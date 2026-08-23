import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AgentPlanSummary, OutputItem, RecordingJob } from '../shared/desktop/dto';
import type { ActivityFeed, ActivityItem } from '../shared/desktop/viewModels';
import { HealthyServiceGate } from '../test/ServiceGate.testing';
import { ProjectWorkspacePage } from './ProjectWorkspacePage';
import { HEALTHY, renderPage } from './delivery/test/renderPage';

const PLAN: AgentPlanSummary = {
  id: 'p-1', title: 'Mirage 残局', status: 'confirmed', revision: 3, shot_count: 3,
  total_duration_seconds: 28, origin_count: 1,
  created_at: '2026-08-20T00:00:00Z', updated_at: '2026-08-20T01:00:00Z',
};

const TASK: ActivityItem = {
  id: 'recording:job-1', kind: 'recording', subtype: null, job_id: 'job-1', context_id: PLAN.id,
  subject: 'Mirage 残局', status: 'running', stage: 'recording.stage.capturing',
  progress_percent: null, completed_units: 3, total_units: 5, unit: 'stages',
  error: null, failure: null, created_at: '2026-08-20T01:00:00Z',
  updated_at: '2026-08-20T01:01:00Z', available_actions: ['cancel'],
};

const FEED: ActivityFeed = {
  items: [TASK], total: 1, page: 1, page_size: 50,
  summary: { total: 1, active: 1, failed: 0, completed: 0, cancelled: 0 },
};

const JOB: RecordingJob = {
  id: 'job-1', retry_of: null, status: 'running', current_index: 1, progress: 1 / 3,
  message: 'recording.stage.capturing', error_code: null,
  items: [
    request('shot-1', '建立地点'),
    request('shot-2', '跟随突破'),
    request('shot-3', '高潮收尾'),
  ],
  outputs: [{
    id: 'clip-1', path: 'D:/clips/1.mp4', title: '建立地点', duration_seconds: 8,
    demo_id: 'demo-1', player_name: 'Kael', category: 'recording', tags: [], metadata: null,
    created_at: '2026-08-20T01:00:30Z',
  }],
  created_at: '2026-08-20T01:00:00Z', updated_at: '2026-08-20T01:01:00Z',
};

function request(id: string, title: string): RecordingJob['items'][number] {
  return {
    id, demo_id: 'demo-1', highlight_id: `highlight-${id}`, player_id: '76561198000000001',
    title, start_tick: 100, end_tick: 200, pre_roll_seconds: 1, post_roll_seconds: 1,
    victim_pov: false, camera_style: 'static', presentation: null,
  };
}

describe('project recording step', () => {
  it('uses the shared activity feed, shows per-clip progress and cancels the recording job', async () => {
    const cancelled: string[] = [];
    const activityQueries: unknown[] = [];
    const client = {
      listAgentPlans: async () => [PLAN],
      listMontageProjects: async () => ({ items: [] }),
      listEditorProjects: async () => ({ items: [] }),
      listActivities: async (query: unknown) => {
        activityQueries.push(query);
        return FEED;
      },
      listOutputs: async () => ({ items: [], total: 0, page: 1, page_size: 100, scan_limited: false }),
      quickCheck: async () => ({
        checked_at: '2026-08-20T01:00:00Z',
        checks: [
          { kind: 'game', state: 'ready', label: 'CS2', detail: '' },
          { kind: 'hlae', state: 'missing', label: 'HLAE', detail: '未找到受管运行时' },
          { kind: 'encoder', state: 'ready', label: '编码器', detail: 'H.264 / AAC' },
        ],
      }),
      getRecordingJob: async () => JOB,
      cancelRecordingJob: async (jobId: string) => {
        cancelled.push(jobId);
      },
    };

    renderPage({
      element: <HealthyServiceGate><ProjectWorkspacePage /></HealthyServiceGate>,
      client,
      health: HEALTHY,
      route: '/projects/plan%3Ap-1?step=record',
      pattern: '/projects/:projectId',
    });

    expect(await screen.findByRole('heading', { name: '录制队列' })).toBeTruthy();
    const environment = await waitFor(() => {
      const row = document.querySelector('[data-recording-environment-missing="hlae"]');
      expect(row).not.toBeNull();
      return row as HTMLElement;
    });
    expect(environment.textContent).toContain('HLAE');
    expect(environment.textContent).toContain('未找到受管运行时');
    expect(screen.getByRole('button', { name: '去设置' })).toBeTruthy();
    expect(await screen.findByText('片段进度 1/3')).toBeTruthy();

    const completed = document.querySelector('[data-recording-clip-state="completed"]') as HTMLElement;
    const active = document.querySelector('[data-recording-clip-state="active"]') as HTMLElement;
    const pending = document.querySelector('[data-recording-clip-state="pending"]') as HTMLElement;
    expect(within(completed).getByText('建立地点')).toBeTruthy();
    expect(within(active).getByText('跟随突破')).toBeTruthy();
    expect(within(pending).getByText('高潮收尾')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    await waitFor(() => expect(cancelled).toEqual(['job-1']));
    expect(activityQueries).toContainEqual({ page: 1, page_size: 50 });
  });

  it('unlocks export when a polled recording finishes without requiring a page reload', async () => {
    const awaitingPlan: AgentPlanSummary = { ...PLAN, status: 'awaiting_confirmation' };
    let feedCalls = 0;
    let outputCalls = 0;
    const completedTask: ActivityItem = {
      ...TASK,
      status: 'completed',
      stage: 'recording.stage.completed',
      completed_units: 5,
      updated_at: '2026-08-20T01:02:00Z',
      available_actions: ['open_outputs'],
    };
    const output: OutputItem = {
      id: 'output-1', output_kind: 'export', media_kind: 'montage', title: PLAN.title,
      status: 'completed', progress: 1, path: 'D:/outputs/final.mp4', file_name: 'final.mp4',
      availability: 'present', managed: true, mutable: true, size_bytes: 1024, media: null,
      project_id: 'composition-1', agent_plan_id: PLAN.id, demo_id: null, error: null,
      created_at: '2026-08-20T01:02:00Z', updated_at: '2026-08-20T01:02:00Z',
    };
    const client = {
      listAgentPlans: async () => [awaitingPlan],
      listMontageProjects: async () => ({ items: [] }),
      listEditorProjects: async () => ({ items: [] }),
      listActivities: async () => {
        feedCalls += 1;
        return feedCalls === 1
          ? FEED
          : {
              ...FEED,
              items: [completedTask],
              summary: { total: 1, active: 0, failed: 0, completed: 1, cancelled: 0 },
            };
      },
      listOutputs: async () => {
        outputCalls += 1;
        return {
          items: feedCalls > 1 ? [output] : [], total: feedCalls > 1 ? 1 : 0,
          page: 1, page_size: 100, scan_limited: false,
        };
      },
      quickCheck: async () => ({ checked_at: '2026-08-20T01:00:00Z', checks: [] }),
      getRecordingJob: async () => ({ ...JOB, status: feedCalls > 1 ? 'completed' : 'running' }),
    };

    renderPage({
      element: <HealthyServiceGate><ProjectWorkspacePage /></HealthyServiceGate>,
      client,
      health: HEALTHY,
      route: '/projects/plan%3Ap-1?step=record',
      pattern: '/projects/:projectId',
    });

    const exportButton = await screen.findByRole('button', { name: '导出' });
    expect((exportButton as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => {
      expect(feedCalls).toBeGreaterThan(1);
      expect(outputCalls).toBeGreaterThan(1);
      expect((screen.getByRole('button', { name: '导出' }) as HTMLButtonElement).disabled).toBe(false);
    }, { timeout: 4_000 });
  });
});
