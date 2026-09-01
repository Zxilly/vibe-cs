import { describe, expect, it } from 'vitest';

import type { ExportJobRecord } from '../../shared/desktop/dto';
import { activeProjectRenderPreview, projectRenderPreviewSegments, projectRenderPreviewStreamPath } from './renderPreview';

function preview(id: string, revision: number, start: number, end: number, status: ExportJobRecord['job']['status']): ExportJobRecord {
  return {
    kind: 'project_preview',
    job: {
      id,
      project_id: 'project',
      project_revision: revision,
      range_start_seconds: start,
      range_end_seconds: end,
      status,
      progress: status === 'completed' ? 1 : 0.4,
      output_path: `C:/previews/${id}.mp4`,
      error: null,
      error_code: null,
      created_at: '2026-09-02T00:00:00Z',
      updated_at: `2026-09-02T00:00:0${id}Z`,
    },
  };
}

describe('render preview projection', () => {
  it('projects ready, rendering, failed and stale ranges without cancelled jobs', () => {
    expect(projectRenderPreviewSegments([
      preview('4', 3, 6, 8, 'cancelled'),
      preview('3', 2, 4, 6, 'completed'),
      preview('2', 3, 2, 4, 'failed'),
      preview('1', 3, 0, 2, 'running'),
    ], 3).map(({ id, state }) => [id, state])).toEqual([
      ['1', 'rendering'], ['2', 'failed'], ['3', 'stale'],
    ]);
  });

  it('uses only the newest completed preview for the exact revision and half-open range', () => {
    const old = preview('1', 3, 1, 4, 'completed');
    const latest = { ...preview('2', 3, 1, 4, 'completed'), job: { ...preview('2', 3, 1, 4, 'completed').job, updated_at: '2026-09-02T00:01:00Z' } };
    expect(activeProjectRenderPreview([old, latest], 3, 2)?.job.id).toBe('2');
    expect(activeProjectRenderPreview([latest], 4, 2)).toBeNull();
    expect(activeProjectRenderPreview([latest], 3, 4)).toBeNull();
  });

  it('builds the existing safe output stream route', () => {
    expect(projectRenderPreviewStreamPath('a/b')).toBe('/api/outputs/export/a%2Fb/stream');
  });
});
