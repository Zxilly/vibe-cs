import { describe, expect, it } from 'vitest';

import type { ActivityItem } from '../../shared/desktop/dto';
import { productionActivityPreview } from './ProductionPage';

function activity(id: string, updatedAt: string): ActivityItem {
  return {
    id,
    kind: 'analysis',
    subtype: null,
    job_id: null,
    context_id: id,
    subject: `Match ${id}`,
    status: 'completed',
    stage: null,
    progress_percent: null,
    completed_units: null,
    total_units: null,
    unit: null,
    error: null,
    created_at: updatedAt,
    updated_at: updatedAt,
    available_actions: ['open_analysis'],
  };
}

describe('production activity preview', () => {
  it('shows only real persisted activities in server order', () => {
    const items = [
      activity('a', '2026-08-13T10:00:00Z'),
      activity('b', '2026-08-13T09:00:00Z'),
      activity('c', '2026-08-13T08:00:00Z'),
      activity('d', '2026-08-13T07:00:00Z'),
      activity('e', '2026-08-13T06:00:00Z'),
    ];

    expect(productionActivityPreview(items).map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(productionActivityPreview([])).toEqual([]);
  });
});
