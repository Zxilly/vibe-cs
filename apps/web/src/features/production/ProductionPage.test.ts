import { describe, expect, it } from 'vitest';

import type { ActivityItem } from '../../shared/desktop/dto';
import { productionActivityHref, productionActivityPreview } from './ProductionPage';

function activity(jobId: string, updatedAt: string): ActivityItem {
  return {
    id: `export:${jobId}`,
    kind: 'export',
    subtype: 'editor',
    job_id: jobId,
    context_id: '99999999-9999-4999-8999-999999999999',
    subject: `C:/exports/${jobId}.mp4`,
    status: 'completed',
    stage: null,
    progress_percent: 100,
    completed_units: null,
    total_units: null,
    unit: null,
    error: null,
    created_at: updatedAt,
    updated_at: updatedAt,
    available_actions: ['open_outputs'],
  };
}

describe('production activity preview', () => {
  it('shows only real persisted activities in server order', () => {
    const items = [
      activity('11111111-1111-4111-8111-111111111111', '2026-08-13T10:00:00Z'),
      activity('22222222-2222-4222-8222-222222222222', '2026-08-13T09:00:00Z'),
      activity('33333333-3333-4333-8333-333333333333', '2026-08-13T08:00:00Z'),
      activity('44444444-4444-4444-8444-444444444444', '2026-08-13T07:00:00Z'),
      activity('55555555-5555-4555-8555-555555555555', '2026-08-13T06:00:00Z'),
    ];

    expect(productionActivityPreview(items).map((item) => item.job_id)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ]);
    expect(productionActivityPreview([])).toEqual([]);
  });

  it('deep-links every preview row to its exact durable Activity locator', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(productionActivityHref(`analysis:${id}`)).toBe(
      `/activity?activity=analysis%3A${id}`,
    );
  });
});
