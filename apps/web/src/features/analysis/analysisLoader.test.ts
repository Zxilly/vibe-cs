import { describe, expect, it, vi } from 'vitest';

import { loadDemoAnalysis } from './analysisLoader';
import type { AnalysisWorkspace, DemoSummary } from '../../shared/desktop/dto';

const demo = (lifecycle_status: DemoSummary['lifecycle_status']): DemoSummary => ({
  id: 'demo-1',
  path: 'D:\\Demos\\major.dem',
  filename: 'major.dem',
  display_name: 'Major final',
  map_name: 'unknown',
  played_at: '2026-08-12T00:00:00Z',
  duration_seconds: 0,
  total_rounds: 0,
  score_team_a: null,
  score_team_b: null,
  team_a_name: null,
  team_b_name: null,
  status: lifecycle_status === 'ready' ? 'ready' : 'pending',
  lifecycle_status,
  players: [],
  source: 'local',
  remark: '',
  updated_at: '2026-08-12T00:00:00Z',
});

const unavailable = { available: false, reason: 'No parsed evidence.' };
const workspace: AnalysisWorkspace = {
  demo_id: 'demo-1',
  map_name: 'de_mirage',
  tick_rate: 64,
  duration_seconds: 90,
  teams: [],
  players: [],
  rounds: [],
  highlights: [],
  insights: {
    round_economy: [],
    player_utility: [],
    matchups: [],
    availability: {
      purchase_events: unavailable,
      purchase_spend: unavailable,
      utility_events: unavailable,
      utility_damage: unavailable,
      flash_effects: unavailable,
      matchups: unavailable,
    },
  },
};

describe('analysis lifecycle loader', () => {
  it('opens the current persisted analysis for a ready demo without posting another analysis', async () => {
    const client = {
      getDemo: vi.fn().mockResolvedValue(demo('ready')),
      getAnalysis: vi.fn().mockResolvedValue(workspace),
      analyzeDemo: vi.fn(),
    };

    await expect(loadDemoAnalysis('demo-1', client)).resolves.toBe(workspace);
    expect(client.getAnalysis).toHaveBeenCalledOnce();
    expect(client.analyzeDemo).not.toHaveBeenCalled();
  });

  it.each(['discovered', 'failed'] as const)('starts exactly one analysis for %s', async (status) => {
    const client = {
      getDemo: vi.fn().mockResolvedValue(demo(status)),
      getAnalysis: vi.fn(),
      analyzeDemo: vi.fn().mockResolvedValue(workspace),
    };

    const lifecycles: string[] = [];
    await expect(loadDemoAnalysis('demo-1', client, undefined, {
      onLifecycle: (lifecycle) => lifecycles.push(lifecycle),
    })).resolves.toBe(workspace);
    expect(client.analyzeDemo).toHaveBeenCalledOnce();
    expect(client.getAnalysis).not.toHaveBeenCalled();
    expect(lifecycles).toEqual([status, 'analyzing']);
  });

  it('observes an active analysis until ready without posting a duplicate', async () => {
    const client = {
      getDemo: vi.fn()
        .mockResolvedValueOnce(demo('analyzing'))
        .mockResolvedValueOnce(demo('ready')),
      getAnalysis: vi.fn().mockResolvedValue(workspace),
      analyzeDemo: vi.fn(),
    };
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(loadDemoAnalysis('demo-1', client, undefined, { wait })).resolves.toBe(workspace);
    expect(client.getDemo).toHaveBeenCalledTimes(2);
    expect(client.getAnalysis).toHaveBeenCalledOnce();
    expect(client.analyzeDemo).not.toHaveBeenCalled();
  });

  it('rejects a missing demo with a recovery action instead of a fake locate command', async () => {
    const client = {
      getDemo: vi.fn().mockResolvedValue(demo('missing')),
      getAnalysis: vi.fn(),
      analyzeDemo: vi.fn(),
    };

    await expect(loadDemoAnalysis('demo-1', client)).rejects.toThrow(
      'Restore the Demo file to its watched folder, then rescan the library.',
    );
    expect(client.analyzeDemo).not.toHaveBeenCalled();
  });

  it('surfaces an observed failure without automatically retrying it', async () => {
    const client = {
      getDemo: vi.fn()
        .mockResolvedValueOnce(demo('indexing'))
        .mockResolvedValueOnce(demo('failed')),
      getAnalysis: vi.fn(),
      analyzeDemo: vi.fn(),
    };

    await expect(loadDemoAnalysis('demo-1', client, undefined, {
      wait: vi.fn().mockResolvedValue(undefined),
    })).rejects.toThrow('Analysis failed. Return to the library to review the Demo and retry.');
    expect(client.analyzeDemo).not.toHaveBeenCalled();
  });

  it('moves a started request to failed when the backend rejects it', async () => {
    const client = {
      getDemo: vi.fn().mockResolvedValue(demo('discovered')),
      getAnalysis: vi.fn(),
      analyzeDemo: vi.fn().mockRejectedValue(new Error('parser rejected malformed protobuf')),
    };
    const lifecycles: string[] = [];

    await expect(loadDemoAnalysis('demo-1', client, undefined, {
      onLifecycle: (status) => lifecycles.push(status),
    })).rejects.toThrow('parser rejected malformed protobuf');
    expect(lifecycles).toEqual(['discovered', 'analyzing', 'failed']);
  });
});
