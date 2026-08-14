import { useMachine } from '@xstate/react';
import { StrictMode, useId } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { commands } from '../../shared/desktop/client';
import { analysisLifecycleMachine } from './analysisLifecycleMachine';

describe('analysis lifecycle React owner', () => {
  afterEach(() => vi.restoreAllMocks());

  it('starts one route owner when React StrictMode reconnects effects', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(commands, 'getDemo').mockResolvedValue({
      id: 'demo-1', path: 'D:/major.dem', filename: 'major.dem', display_name: 'Major',
      map_name: 'unknown', match_date: null, cataloged_at: '2026-08-13T01:00:00Z',
      duration_seconds: 0, total_rounds: 0, score_team_a: null, score_team_b: null,
      team_a_name: null, team_b_name: null, status: 'pending', lifecycle_status: 'discovered',
      players: [], source: 'local', remark: '', updated_at: '2026-08-13T01:00:00Z',
    });
    const start = vi.spyOn(commands, 'startAnalysisRun').mockResolvedValue({
      id: 'run-1', demo_id: 'demo-1', input_sha256: null, input_size: null,
      status: 'queued', stage: 'validating_input', error: null,
      created_at: '2026-08-13T01:00:00Z', updated_at: '2026-08-13T01:00:00Z',
    });
    vi.spyOn(commands, 'getAnalysisRun').mockReturnValue(new Promise(() => undefined));
    let renderer!: ReactTestRenderer;
    function Harness() {
      const ownerScopeId = useId();
      useMachine(analysisLifecycleMachine, {
        input: {
          ownerScopeId, demoId: 'demo-1', runId: null, batchIds: ['demo-1'],
        },
      });
      return null;
    }

    await act(async () => {
      renderer = create(<StrictMode><Harness /></StrictMode>);
      await Promise.resolve();
    });
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith('demo-1', expect.any(AbortSignal));
    await act(async () => renderer.unmount());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
