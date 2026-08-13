import { describe, expect, it, vi } from 'vitest';

import type {
  AnalysisRun,
  AnalysisRunDetail,
  AnalysisWorkspace,
  DemoSummary,
} from '../../shared/desktop/dto';
import { AnalysisRunError, loadDemoAnalysis } from './analysisLoader';

const demo = (lifecycle_status: DemoSummary['lifecycle_status']): DemoSummary => ({
  id: 'demo-1', path: 'D:\\Demos\\major.dem', filename: 'major.dem', display_name: 'Major final',
  map_name: 'unknown', played_at: '2026-08-12T00:00:00Z', duration_seconds: 0,
  total_rounds: 0, score_team_a: null, score_team_b: null, team_a_name: null,
  team_b_name: null, status: lifecycle_status === 'ready' ? 'ready' : 'pending',
  lifecycle_status, players: [], source: 'local', remark: '', updated_at: '2026-08-12T00:00:00Z',
});

const run = (status: AnalysisRun['status'], error: string | null = null): AnalysisRun => ({
  id: 'run-1', demo_id: 'demo-1', input_sha256: status === 'queued' ? null : 'a'.repeat(64),
  input_size: status === 'queued' ? null : 42, status,
  stage: status === 'queued' ? 'validating_input'
    : status === 'running' ? 'parser_running' : status,
  error, created_at: '2026-08-13T01:00:00Z', updated_at: '2026-08-13T01:01:00Z',
});

const detail = (
  status: AnalysisRun['status'],
  result_available = status === 'completed',
  error: string | null = null,
): AnalysisRunDetail => {
  const current = run(status, error);
  const terminalCode = status === 'queued' ? 'input_validation_started'
    : status === 'running' ? 'parser_started' : status;
  return {
    run: current,
    events: [{
      run_id: current.id,
      sequence: 0,
      stage: current.stage,
      message_code: terminalCode,
      detail: error,
      created_at: current.updated_at,
    }],
    result_available,
  };
};

const unavailable = { available: false, reason: 'No parsed evidence.' };
const workspace: AnalysisWorkspace = {
  demo_id: 'demo-1', map_name: 'de_mirage', tick_rate: 64, duration_seconds: 90,
  teams: [], players: [], rounds: [], highlights: [],
  insights: { round_economy: [], player_utility: [], matchups: [], availability: {
    purchase_events: unavailable, purchase_spend: unavailable, utility_events: unavailable,
    utility_damage: unavailable, flash_effects: unavailable, matchups: unavailable,
  } },
};

const client = (overrides: Record<string, unknown> = {}) => ({
  getDemo: vi.fn(),
  getAnalysis: vi.fn().mockResolvedValue(workspace),
  getAnalysisRunResult: vi.fn().mockResolvedValue(workspace),
  startAnalysisRun: vi.fn(),
  getActiveAnalysisRun: vi.fn(),
  getAnalysisRun: vi.fn(),
  ...overrides,
});

describe('durable analysis lifecycle loader', () => {
  it('opens a ready result without creating a run', async () => {
    const api = client({ getDemo: vi.fn().mockResolvedValue(demo('ready')) });
    await expect(loadDemoAnalysis('demo-1', api)).resolves.toBe(workspace);
    expect(api.startAnalysisRun).not.toHaveBeenCalled();
    expect(api.getAnalysisRunResult).not.toHaveBeenCalled();
  });

  it.each(['discovered', 'failed'] as const)('starts one run for %s and polls only its run ID', async (status) => {
    const api = client({
      getDemo: vi.fn().mockResolvedValue(demo(status)),
      startAnalysisRun: vi.fn().mockResolvedValue(run('queued')),
      getAnalysisRun: vi.fn()
        .mockResolvedValueOnce(detail('running', false))
        .mockResolvedValueOnce(detail('completed')),
    });
    const observed: string[] = [];
    await expect(loadDemoAnalysis('demo-1', api, undefined, {
      wait: vi.fn().mockResolvedValue(undefined),
      onRun: (value) => observed.push(`${value.id}:${value.stage}`),
    })).resolves.toBe(workspace);
    expect(api.startAnalysisRun).toHaveBeenCalledOnce();
    expect(api.getAnalysisRun).toHaveBeenNthCalledWith(1, 'run-1', undefined);
    expect(api.getDemo).toHaveBeenCalledOnce();
    expect(api.getAnalysisRunResult).toHaveBeenCalledWith('run-1', undefined);
    expect(observed).toEqual(['run-1:validating_input', 'run-1:parser_running', 'run-1:completed']);
  });

  it('does not emit the accepted run twice when the first exact read is unchanged', async () => {
    const api = client({
      getDemo: vi.fn().mockResolvedValue(demo('discovered')),
      startAnalysisRun: vi.fn().mockResolvedValue(run('queued')),
      getAnalysisRun: vi.fn()
        .mockResolvedValueOnce(detail('queued', false))
        .mockResolvedValueOnce(detail('completed')),
    });
    const observed: string[] = [];
    await loadDemoAnalysis('demo-1', api, undefined, {
      wait: vi.fn().mockResolvedValue(undefined),
      onRun: (value) => observed.push(`${value.status}:${value.updated_at}`),
    });
    expect(observed).toEqual([
      'queued:2026-08-13T01:01:00Z',
      'completed:2026-08-13T01:01:00Z',
    ]);
  });

  it('resumes an exact route run without reading Demo lifecycle', async () => {
    const api = client({ getAnalysisRun: vi.fn().mockResolvedValue(detail('completed')) });
    await expect(loadDemoAnalysis('demo-1', api, undefined, { runId: 'run-1' })).resolves.toBe(workspace);
    expect(api.getDemo).not.toHaveBeenCalled();
    expect(api.getAnalysisRun).toHaveBeenCalledWith('run-1', undefined);
    expect(api.getAnalysisRunResult).toHaveBeenCalledWith('run-1', undefined);
  });

  it('recovers the active run for an analyzing deep link then keeps its identity', async () => {
    const api = client({
      getDemo: vi.fn().mockResolvedValue(demo('analyzing')),
      getActiveAnalysisRun: vi.fn().mockResolvedValue(detail('running', false)),
      getAnalysisRun: vi.fn().mockResolvedValue(detail('completed')),
    });
    await expect(loadDemoAnalysis('demo-1', api, undefined, {
      wait: vi.fn().mockResolvedValue(undefined),
    })).resolves.toBe(workspace);
    expect(api.getActiveAnalysisRun).toHaveBeenCalledOnce();
    expect(api.getAnalysisRun).toHaveBeenCalledWith('run-1', undefined);
  });

  it('re-reads the Demo when active lookup loses a completion race without starting another run', async () => {
    const api = client({
      getDemo: vi.fn()
        .mockResolvedValueOnce(demo('analyzing'))
        .mockResolvedValueOnce(demo('ready')),
      getActiveAnalysisRun: vi.fn().mockRejectedValue({ status: 404, code: 'not_found' }),
    });
    await expect(loadDemoAnalysis('demo-1', api)).resolves.toBe(workspace);
    expect(api.getDemo).toHaveBeenCalledTimes(2);
    expect(api.getAnalysis).toHaveBeenCalledOnce();
    expect(api.startAnalysisRun).not.toHaveBeenCalled();
  });

  it('keeps polling indexing until it can start a durable run', async () => {
    const api = client({
      getDemo: vi.fn()
        .mockResolvedValueOnce(demo('indexing'))
        .mockResolvedValueOnce(demo('discovered')),
      startAnalysisRun: vi.fn().mockResolvedValue(run('queued')),
      getAnalysisRun: vi.fn().mockResolvedValue(detail('completed')),
    });
    await expect(loadDemoAnalysis('demo-1', api, undefined, {
      wait: vi.fn().mockResolvedValue(undefined),
    })).resolves.toBe(workspace);
    expect(api.startAnalysisRun).toHaveBeenCalledOnce();
  });

  it.each(['failed', 'interrupted'] as const)('surfaces persisted %s detail as a terminal failure', async (status) => {
    const api = client({ getAnalysisRun: vi.fn().mockResolvedValue(detail(status, false, 'parser stopped')) });
    await expect(loadDemoAnalysis('demo-1', api, undefined, { runId: 'run-1' }))
      .rejects.toMatchObject({ runId: 'run-1', status, message: 'parser stopped' } satisfies Partial<AnalysisRunError>);
    expect(api.getAnalysis).not.toHaveBeenCalled();
    expect(api.getAnalysisRunResult).not.toHaveBeenCalled();
  });

  it('rejects a completed run that has no committed result', async () => {
    const api = client({ getAnalysisRun: vi.fn().mockResolvedValue(detail('completed', false)) });
    await expect(loadDemoAnalysis('demo-1', api, undefined, { runId: 'run-1' }))
      .rejects.toThrow('completed without a committed result');
    expect(api.getAnalysis).not.toHaveBeenCalled();
    expect(api.getAnalysisRunResult).not.toHaveBeenCalled();
  });

  it('rejects an exact run result whose Demo identity does not match the route', async () => {
    const api = client({
      getAnalysisRun: vi.fn().mockResolvedValue(detail('completed')),
      getAnalysisRunResult: vi.fn().mockResolvedValue({ ...workspace, demo_id: 'demo-2' }),
    });
    await expect(loadDemoAnalysis('demo-1', api, undefined, { runId: 'run-1' }))
      .rejects.toThrow('result identity does not match');
    expect(api.getAnalysis).not.toHaveBeenCalled();
  });

  it('rejects a missing Demo without starting analysis', async () => {
    const api = client({ getDemo: vi.fn().mockResolvedValue(demo('missing')) });
    await expect(loadDemoAnalysis('demo-1', api)).rejects.toThrow('Restore the Demo file');
    expect(api.startAnalysisRun).not.toHaveBeenCalled();
  });
});
