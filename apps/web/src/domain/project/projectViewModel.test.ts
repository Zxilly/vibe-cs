import { describe, expect, it } from 'vitest';

import type { AgentPlanSummary, EditorProject, MontageProjectRecord, OutputItem } from '../../shared/desktop/dto';
import type { ActivityItem } from '../../shared/desktop/viewModels';
import { aggregateProjects } from './projectViewModel';

const plan = (id: string, status: AgentPlanSummary['status'] = 'draft', shotCount = 2): AgentPlanSummary => ({
  id, title: `Plan ${id}`, status, revision: 1, shot_count: shotCount, total_duration_seconds: 12,
  origin_count: 0, created_at: '2026-08-19T00:00:00Z', updated_at: '2026-08-19T01:00:00Z',
});
const montage = (id: string, clipCount = 1): MontageProjectRecord => ({
  id, name: `Montage ${id}`, clips: Array.from({ length: clipCount }, (_, index) => ({
    clip_id: `clip-${index}`, order: index, trim_start: 0, trim_end: null, transition: 'cut', title: null, avatar_asset_id: null,
  })), settings: {} as MontageProjectRecord['settings'], created_at: '2026-08-19T00:00:00Z', updated_at: '2026-08-19T02:00:00Z',
});
const editor = (id: string, clipCount = 1): EditorProject => ({
  id, name: `Editor ${id}`, width: 1920, height: 1080, fps: 60, duration_seconds: 10,
  tracks: [{ id: 'v1', name: 'Video', kind: 'video', order: 0, muted: false, locked: false, hidden: false,
    clips: Array.from({ length: clipCount }, (_, index) => ({ id: `e-${index}` })) as EditorProject['tracks'][number]['clips'] }],
  markers: [], settings: {}, revision: 1, created_at: '2026-08-19T00:00:00Z', updated_at: '2026-08-19T03:00:00Z',
});
const task = (contextId: string | null, status: ActivityItem['status'] = 'running'): ActivityItem => ({
  id: `recording:${contextId ?? 'orphan'}`, kind: 'recording', subtype: null, job_id: 'job-1', context_id: contextId,
  subject: 'Recording', status, stage: null, progress_percent: null, completed_units: null, total_units: null, unit: null,
  error: null, failure: null, created_at: '2026-08-19T00:00:00Z', updated_at: '2026-08-19T04:00:00Z', available_actions: [],
});
const output = (projectId: string | null): OutputItem => ({
  id: `out-${projectId ?? 'orphan'}`, output_kind: 'export', media_kind: 'video', title: 'Final', status: 'completed',
  progress: 1, path: 'D:\\final.mp4', file_name: 'final.mp4', availability: 'present', managed: true, mutable: true,
  size_bytes: 1, media: null, project_id: projectId, demo_id: 'demo-1', error: null,
  created_at: '2026-08-19T00:00:00Z', updated_at: '2026-08-19T05:00:00Z',
});

describe('project view model', () => {
  it('wraps every legacy plan, montage and editor exactly once', () => {
    const result = aggregateProjects({ plans: [plan('p')], montages: [montage('m')], editors: [editor('e')] });
    expect(result.projects.map((project) => project.id).sort()).toEqual(['editor:e', 'montage:m', 'plan:p']);
  });

  it('infers select, shot-list, recording and export steps from observable outcomes', () => {
    const result = aggregateProjects({
      plans: [plan('draft'), plan('confirmed', 'confirmed')],
      montages: [montage('empty', 0)],
      editors: [editor('finished')],
      tasks: [task('confirmed')],
      outputs: [output('finished')],
    });
    expect(Object.fromEntries(result.projects.map((project) => [project.id, project.currentStep]))).toEqual({
      'editor:finished': 'export',
      'plan:confirmed': 'record',
      'plan:draft': 'shotlist',
      'montage:empty': 'select',
    });
  });

  it('returns no phantom project for empty sources and reports unowned entities as orphans', () => {
    const orphanTask = task(null);
    const orphanOutput = output(null);
    const result = aggregateProjects({ tasks: [orphanTask], outputs: [orphanOutput] });
    expect(result.projects).toEqual([]);
    expect(result.orphanTasks).toEqual([orphanTask]);
    expect(result.orphanOutputs).toEqual([orphanOutput]);
  });

  it('keeps partial cards when another query source failed', () => {
    const result = aggregateProjects({
      plans: [plan('available')],
      warnings: [{ source: 'montages', message: 'montage service unavailable' }],
    });
    expect(result.projects.map((project) => project.name)).toEqual(['Plan available']);
    expect(result.warnings).toEqual([{ source: 'montages', message: 'montage service unavailable' }]);
  });

  it('does not guess when equal raw ids make an output ambiguous', () => {
    const ambiguous = output('same');
    const result = aggregateProjects({ montages: [montage('same')], editors: [editor('same')], outputs: [ambiguous] });
    expect(result.projects.every((project) => project.outputFiles.length === 0)).toBe(true);
    expect(result.orphanOutputs).toEqual([ambiguous]);
  });
});
