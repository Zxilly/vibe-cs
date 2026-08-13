import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { commands } from '../../shared/desktop/client';
import type { ActivityItem } from '../../shared/desktop/dto';
import {
  ActivityPagination,
  ActivityWorkspace,
  activityActionNotice,
  executeActivityAction,
  shouldShowActivityListLoading,
} from './ActivityPage';

const item = (overrides: Partial<ActivityItem>): ActivityItem => ({
  id: 'recording:job-1',
  kind: 'recording',
  subtype: null,
  job_id: 'job-1',
  context_id: 'demo-1',
  subject: 'FalleN R20 4K',
  status: 'running',
  stage: 'Capturing frames',
  progress_percent: 42,
  completed_units: null,
  total_units: null,
  unit: null,
  error: null,
  created_at: '2026-08-13T01:00:00Z',
  updated_at: '2026-08-13T01:01:00Z',
  available_actions: ['cancel', 'open_outputs'],
  ...overrides,
});

describe('activity workspace', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('renders durable action outcomes with truthful severity', () => {
    expect(activityActionNotice('failed')).toMatchObject({ tone: 'danger' });
    expect(activityActionNotice('cancelled')).toMatchObject({ tone: 'warning' });
    expect(activityActionNotice('queued')).toMatchObject({ tone: 'info' });
  });

  it('keeps a dense task table and evidence inspector while omitting unknown percentages', () => {
    const recording = item({
      stage: 'recording.stage.capturing', progress_percent: null,
      completed_units: 3, total_units: 5, unit: 'stages',
    });
    const failedAnalysis = item({
      id: 'analysis:run-2', kind: 'analysis', job_id: 'run-2', context_id: 'demo-2',
      subject: 'Major M1', status: 'failed', stage: 'interrupted', progress_percent: null,
      error: null, available_actions: ['retry_analysis', 'open_library'],
    });
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ActivityWorkspace
          items={[recording, failedAnalysis]}
          selectedId={failedAnalysis.id}
          busyId={null}
          onSelect={() => undefined}
          onAction={() => undefined}
        />
      </MemoryRouter>,
    );

    expect(markup).toContain('class="activity-table"');
    expect(markup).toContain('class="card activity-inspector"');
    expect(markup).toContain('data-activity-id="analysis:run-2"');
    expect(markup).not.toContain('<progress');
    expect(markup).toContain('3 / 5');
    expect(markup).toContain('demo-2');
    expect(markup).toContain('data-action="retry_analysis"');
    expect(markup).not.toContain('analysis:run-2<!-- -->%');
  });

  it('keeps an exact URL-selected activity inspectable outside the current list page', () => {
    const exact = item({
      id: 'export:11111111-1111-4111-8111-111111111111',
      kind: 'export',
      job_id: '11111111-1111-4111-8111-111111111111',
      context_id: '22222222-2222-4222-8222-222222222222',
      subject: 'C:/exports/exact.mp4',
      status: 'running',
      available_actions: ['cancel', 'open_outputs'],
    });
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ActivityWorkspace
          items={[]}
          selectedId={exact.id}
          selectedItem={exact}
          busyId={null}
          onSelect={() => undefined}
          onAction={() => undefined}
        />
      </MemoryRouter>,
    );

    expect(markup).toContain('C:/exports/exact.mp4');
    expect(markup).toContain('export:11111111-1111-4111-8111-111111111111');
  });

  it('does not let a slow list request cover an exact deep-link inspector', () => {
    expect(shouldShowActivityListLoading(true, 0, false)).toBe(true);
    expect(shouldShowActivityListLoading(true, 0, true)).toBe(false);
  });

  it('keeps cross-workflow paging compact and exposes both navigation bounds', () => {
    const markup = renderToStaticMarkup(
      <ActivityPagination
        page={2}
        pageSize={50}
        total={137}
        onPageChange={() => undefined}
      />,
    );

    expect(markup).toContain('class="activity-pagination"');
    expect(markup).toContain('data-page="2"');
    expect(markup).toContain('data-page-count="3"');
    expect(markup).toContain('data-direction="previous"');
    expect(markup).toContain('data-direction="next"');
    expect(markup).not.toContain('disabled=""');
  });

  it('retries a failed download through the persisted download command', async () => {
    const failedDownload = item({
      id: 'download:failed-job',
      kind: 'download',
      job_id: 'failed-job',
      context_id: 'match-record-42',
      status: 'failed',
      error: 'download ticket expired',
      available_actions: ['retry_download'],
    });
    const retry = vi.spyOn(commands, 'downloadMatchDemo').mockResolvedValue({
      id: 'retry-job',
      match_record_id: 'match-record-42',
      status: 'queued',
      downloaded_bytes: 0,
      total_bytes: null,
      progress: 0,
      demo_id: null,
      error: null,
      created_at: '2026-08-13T01:02:00Z',
      updated_at: '2026-08-13T01:02:00Z',
    });
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ActivityWorkspace
          items={[failedDownload]}
          selectedId={failedDownload.id}
          busyId={null}
          onSelect={() => undefined}
          onAction={() => undefined}
        />
      </MemoryRouter>,
    );

    await executeActivityAction(failedDownload, 'retry_download');

    expect(markup).toContain('data-action="retry_download"');
    expect(markup).toContain('download ticket expired');
    expect(retry).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith('match-record-42');
  });

  it('reports the durable state returned by an export cancellation', async () => {
    const runningExport = item({
      id: 'export:export-job',
      kind: 'export',
      job_id: 'export-job',
      context_id: 'project-1',
      status: 'running',
      available_actions: ['cancel', 'open_outputs'],
    });
    vi.spyOn(commands, 'cancelExportJob').mockResolvedValue({
      kind: 'editor',
      job: {
        id: 'export-job', project_id: 'project-1', status: 'cancelling', progress: 0.42,
        output_path: 'C:/exports/exact.mp4', error: null,
        created_at: '2026-08-13T01:00:00Z', updated_at: '2026-08-13T01:02:00Z',
      },
    });

    await expect(executeActivityAction(runningExport, 'cancel')).resolves.toEqual({
      status: 'cancelling',
      activityId: 'export:export-job',
      stage: null,
    });
  });

  it('reports the persisted download state returned by a retry command', async () => {
    const failedDownload = item({
      id: 'download:stale-failed-job',
      kind: 'download',
      job_id: 'stale-failed-job',
      context_id: 'match-record-already-downloaded',
      status: 'failed',
      available_actions: ['retry_download'],
    });
    vi.spyOn(commands, 'downloadMatchDemo').mockResolvedValue({
      id: 'existing-completed-job',
      match_record_id: 'match-record-already-downloaded',
      status: 'completed',
      downloaded_bytes: 0,
      total_bytes: null,
      progress: 1,
      demo_id: 'persisted-demo',
      error: null,
      created_at: '2026-08-13T01:02:00Z',
      updated_at: '2026-08-13T01:02:00Z',
    });

    const outcome = await executeActivityAction(failedDownload, 'retry_download');

    expect(outcome).toEqual({
      status: 'completed', activityId: 'download:existing-completed-job', stage: null,
    });
  });

  it('retries a failed recording through a fresh plan and native consent execution', async () => {
    const failedRecording = item({
      id: 'recording:failed-job',
      job_id: 'failed/job',
      status: 'failed',
      error: 'capture interrupted',
      available_actions: ['retry_recording'],
    });
    const plan = vi.spyOn(commands, 'planRecordingRetry').mockResolvedValue({
      plan_id: 'retry-plan',
      expires_at: '2026-08-13T01:07:00Z',
      active_items: 1,
      disabled_items: 0,
      estimated_seconds: 2,
      warnings: [],
      items: [],
      director: {
        shots: [],
        warnings: [],
        source_item_count: 1,
        merged_item_count: 1,
        victim_reaction_count: 0,
        unresolved_victim_requests: 0,
      },
    });
    const execute = vi.spyOn(commands, 'executeRecordingPlan').mockResolvedValue({
      job_id: 'retry-child',
      status: 'queued',
    });
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ActivityWorkspace
          items={[failedRecording]}
          selectedId={failedRecording.id}
          busyId={null}
          onSelect={() => undefined}
          onAction={() => undefined}
        />
      </MemoryRouter>,
    );

    const outcome = await executeActivityAction(failedRecording, 'retry_recording');

    expect(markup).toContain('data-action="retry_recording"');
    expect(plan).toHaveBeenCalledWith('failed/job');
    expect(execute).toHaveBeenCalledWith('retry-plan', false);
    expect(outcome).toEqual({
      status: 'queued', activityId: 'recording:retry-child', stage: null,
    });
  });

  it('does not bypass a rejected native recording consent', async () => {
    const failedRecording = item({
      id: 'recording:consent-job',
      job_id: 'consent-job',
      status: 'failed',
      available_actions: ['retry_recording'],
    });
    const plan = vi.spyOn(commands, 'planRecordingRetry').mockResolvedValue({
      plan_id: 'consent-plan',
      expires_at: '2026-08-13T01:07:00Z',
      active_items: 1,
      disabled_items: 0,
      estimated_seconds: null,
      warnings: [],
      items: [],
      director: {
        shots: [], warnings: [], source_item_count: 1, merged_item_count: 1,
        victim_reaction_count: 0, unresolved_victim_requests: 0,
      },
    });
    const execute = vi.spyOn(commands, 'executeRecordingPlan')
      .mockRejectedValue(new Error('native consent cancelled'));

    await expect(executeActivityAction(failedRecording, 'retry_recording'))
      .rejects.toThrow('native consent cancelled');

    expect(plan).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith('consent-plan', false);
  });

  it('retries analysis through a new durable run and returns its identity', async () => {
    const failedAnalysis = item({
      id: 'analysis:old-run', kind: 'analysis', job_id: 'old-run', context_id: 'demo-1',
      status: 'failed', stage: 'failed', progress_percent: null,
      available_actions: ['retry_analysis'],
    });
    const created = {
      id: 'new-run', demo_id: 'demo-1', input_sha256: null, input_size: null,
      status: 'queued' as const, stage: 'validating_input' as const, error: null,
      created_at: '2026-08-13T01:02:00Z', updated_at: '2026-08-13T01:02:00Z',
    };
    const retry = vi.spyOn(commands, 'startAnalysisRun').mockResolvedValue(created);

    await expect(executeActivityAction(failedAnalysis, 'retry_analysis')).resolves.toEqual({
      status: 'queued', activityId: 'analysis:new-run', stage: 'validating_input',
    });
    expect(retry).toHaveBeenCalledWith('demo-1');
  });
});
