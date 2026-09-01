import type { ExportJobRecord } from '../../shared/desktop/dto';

export type ProjectRenderPreviewState = 'rendering' | 'ready' | 'stale' | 'failed';

export interface ProjectRenderPreviewSegment {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly state: ProjectRenderPreviewState;
  readonly progress: number;
}

export function projectRenderPreviewSegments(
  records: readonly ExportJobRecord[],
  projectRevision: number,
): ProjectRenderPreviewSegment[] {
  return records
    .filter((record) => record.kind === 'project_preview' && record.job.status !== 'cancelled')
    .map((record) => ({
      id: record.job.id,
      start: record.job.range_start_seconds,
      end: record.job.range_end_seconds,
      state: previewState(record, projectRevision),
      progress: record.job.progress,
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end || left.id.localeCompare(right.id));
}

export function activeProjectRenderPreview(
  records: readonly ExportJobRecord[],
  projectRevision: number,
  timelineTime: number,
): ExportJobRecord | null {
  return records
    .filter((record) => record.kind === 'project_preview'
      && record.job.status === 'completed'
      && record.job.project_revision === projectRevision
      && timelineTime >= record.job.range_start_seconds
      && timelineTime < record.job.range_end_seconds)
    .sort((left, right) => right.job.updated_at.localeCompare(left.job.updated_at))[0] ?? null;
}

export function projectRenderPreviewStreamPath(jobId: string): string {
  return `/api/outputs/export/${encodeURIComponent(jobId)}/stream`;
}

function previewState(record: ExportJobRecord, projectRevision: number): ProjectRenderPreviewState {
  if (record.job.project_revision !== projectRevision) return 'stale';
  if (record.job.status === 'failed') return 'failed';
  if (record.job.status === 'completed') return 'ready';
  return 'rendering';
}
