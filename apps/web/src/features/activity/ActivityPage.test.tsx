import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import type { ActivityItem } from '../../shared/desktop/dto';
import { ActivityWorkspace } from './ActivityPage';

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
});
