import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { commands } from '../../shared/desktop/client';
import type { ActivityItem } from '../../shared/desktop/dto';
import { ActivityPagination, ActivityWorkspace, executeActivityAction } from './ActivityPage';

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
  it('keeps a dense task table and evidence inspector while omitting unknown percentages', () => {
    const recording = item({
      stage: 'recording.stage.capturing', progress_percent: null,
      completed_units: 3, total_units: 5, unit: 'stages',
    });
    const failedAnalysis = item({
      id: 'analysis:demo-2', kind: 'analysis', job_id: null, context_id: 'demo-2',
      subject: 'Major M1', status: 'failed', stage: null, progress_percent: null,
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
    expect(markup).toContain('data-activity-id="analysis:demo-2"');
    expect(markup).not.toContain('<progress');
    expect(markup).toContain('3 / 5');
    expect(markup).toContain('demo-2');
    expect(markup).toContain('data-action="retry_analysis"');
    expect(markup).not.toContain('analysis:demo-2<!-- -->%');
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
    retry.mockRestore();
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
    const retry = vi.spyOn(commands, 'downloadMatchDemo').mockResolvedValue({
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

    const returnedStatus = await executeActivityAction(failedDownload, 'retry_download');

    expect(returnedStatus).toBe('completed');
    retry.mockRestore();
  });
});
