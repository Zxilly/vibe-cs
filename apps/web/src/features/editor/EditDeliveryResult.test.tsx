import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { ExportJobRecord } from '../../shared/desktop/dto';
import { EditDeliveryResult } from './EditDeliveryResult';

const completed: ExportJobRecord = {
  kind: 'editor_export',
  job: {
    id: '11111111-1111-4111-8111-111111111111',
    project_id: '22222222-2222-4222-8222-222222222222',
    status: 'completed',
    progress: 1,
    output_path: 'C:/exports/final.mp4',
    error: null,
    created_at: '2026-08-14T08:00:00Z',
    updated_at: '2026-08-14T08:05:00Z',
  },
};

describe('EditDeliveryResult', () => {
  it('renders a completed export as an exact, revealable delivery result', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <EditDeliveryResult record={completed} desktop onReveal={vi.fn()} />
      </MemoryRouter>,
    );

    expect(markup).toContain('C:/exports/final.mp4');
    expect(markup).toContain(completed.job.id);
    expect(markup).toContain(completed.job.project_id);
    expect(markup).toContain('data-action="reveal-edit-delivery"');
    expect(markup).toContain('href="/outputs"');
  });

  it('does not claim a failed export is delivered', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <EditDeliveryResult
          record={{ ...completed, job: { ...completed.job, status: 'failed', progress: 0.6, error: 'encoder failed' } }}
          desktop
          onReveal={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(markup).not.toContain('data-delivery-status="completed"');
    expect(markup).not.toContain('data-action="reveal-edit-delivery"');
  });
});
