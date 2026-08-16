import { createActor, fromPromise } from 'xstate';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { commands } from '../../shared/desktop/client';
import type { AnalysisRun } from '../../shared/desktop/dto';
import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import {
  analysisLifecycleMachine,
  type AnalysisRouteLoaderInput,
} from './analysisLifecycleMachine';
import { AnalysisLifecycleError } from './analysisLoader';

const workspace = (demoId: string): AnalysisWorkspace => ({
  demo_id: demoId,
  map_name: 'de_mirage',
  tick_rate: 64,
  duration_seconds: 90,
  teams: [],
  players: [],
  rounds: [],
  highlights: [],
});

const cancelledRun = (demoId: string, id = 'run-1'): AnalysisRun => ({
  id,
  demo_id: demoId,
  input_sha256: 'a'.repeat(64),
  input_size: 42,
  status: 'cancelled',
  stage: 'cancelled',
  error: null,
  created_at: '2026-08-13T01:00:00Z',
  updated_at: '2026-08-13T01:01:00Z',
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('analysis lifecycle state machine', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps durable cancellation terminal even if its request resolves late', async () => {
    const result = deferred<AnalysisWorkspace>();
    let loaderInput!: AnalysisRouteLoaderInput;
    const machine = analysisLifecycleMachine.provide({
      actors: {
        loadRoute: fromPromise(async ({ input }) => {
          loaderInput = input;
          return result.promise;
        }),
      },
    });
    const actor = createActor(machine, {
      input: {
        ownerScopeId: 'cancel-owner', demoId: 'demo-1', runId: 'run-1', batchIds: ['demo-1'],
      },
    });
    actor.start();

    loaderInput.onLifecycle('missing');
    await Promise.resolve();
    loaderInput.onRun(cancelledRun('demo-1'));
    await Promise.resolve();
    expect(actor.getSnapshot().matches({ route: 'cancelled' })).toBe(true);
    expect(actor.getSnapshot().context).toMatchObject({
      demoId: 'demo-1', runId: 'run-1', lifecycle: 'missing',
    });

    result.resolve(workspace('demo-1'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actor.getSnapshot().matches({ route: 'cancelled' })).toBe(true);
    expect(actor.getSnapshot().context.workspace.demo_id).toBe('demo-1');
    actor.stop();
  });

  it('keeps authoritative Demo lifecycle separate from a failed run outcome', async () => {
    const result = deferred<AnalysisWorkspace>();
    let loaderInput!: AnalysisRouteLoaderInput;
    const machine = analysisLifecycleMachine.provide({
      actors: {
        loadRoute: fromPromise(async ({ input }) => {
          loaderInput = input;
          return result.promise;
        }),
      },
    });
    const actor = createActor(machine, {
      input: {
        ownerScopeId: 'failed-lifecycle', demoId: 'demo-1', runId: 'run-1', batchIds: ['demo-1'],
      },
    });
    actor.start();
    loaderInput.onLifecycle('missing');
    loaderInput.onRun({
      ...cancelledRun('demo-1'), status: 'running', stage: 'parser_running', error: null,
    });
    await Promise.resolve();
    expect(actor.getSnapshot().context.lifecycle).toBe('missing');
    loaderInput.onRun({
      ...cancelledRun('demo-1'), status: 'failed', stage: 'failed', error: 'parser stopped',
    });
    await Promise.resolve();

    expect(actor.getSnapshot().matches({ route: 'failed' })).toBe(true);
    expect(actor.getSnapshot().context).toMatchObject({
      lifecycle: 'missing', outcome: 'failed', message: 'parser stopped',
    });
    actor.stop();
  });

  it('treats an authoritative non-failed lifecycle race as changed instead of failed', async () => {
    const machine = analysisLifecycleMachine.provide({
      actors: {
        loadRoute: fromPromise<AnalysisWorkspace, AnalysisRouteLoaderInput>(async () => {
          throw new AnalysisLifecycleError(
            'discovered',
            'The active analysis run changed while this view was loading.',
          );
        }),
      },
    });
    const actor = createActor(machine, {
      input: {
        ownerScopeId: 'lifecycle-race', demoId: 'demo-1', runId: null, batchIds: ['demo-1'],
      },
    });
    actor.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(actor.getSnapshot().matches({ route: 'unavailable' })).toBe(true);
    expect(actor.getSnapshot().context).toMatchObject({
      lifecycle: 'discovered', outcome: 'unavailable',
    });
    actor.stop();
  });

  it('preserves an authoritative lifecycle race for the selected Demo in a batch', async () => {
    vi.spyOn(commands, 'getDemo').mockImplementation(async (id) => {
      if (id === 'demo-2') {
        return {
          id, path: 'D:/b.dem', filename: 'b.dem', display_name: 'B', map_name: 'de_dust2',
          match_date: null, cataloged_at: '2026-08-13T01:00:00Z', duration_seconds: 90,
          total_rounds: 1, score_team_a: null, score_team_b: null, team_a_name: null,
          team_b_name: null, status: 'ready', lifecycle_status: 'ready', players: [],
          source: 'local', remark: '', updated_at: '2026-08-13T01:00:00Z',
        };
      }
      const calls = vi.mocked(commands.getDemo).mock.calls
        .filter(([demoId]) => demoId === 'demo-1').length;
      return {
        id, path: 'D:/a.dem', filename: 'a.dem', display_name: 'A', map_name: 'unknown',
        match_date: null, cataloged_at: '2026-08-13T01:00:00Z', duration_seconds: 0,
        total_rounds: 0, score_team_a: null, score_team_b: null, team_a_name: null,
        team_b_name: null, status: 'pending',
        lifecycle_status: calls === 1 ? 'analyzing' : 'discovered', players: [],
        source: 'local', remark: '', updated_at: '2026-08-13T01:00:00Z',
      };
    });
    vi.spyOn(commands, 'getActiveAnalysisRun').mockRejectedValue({ status: 404, code: 'not_found' });
    vi.spyOn(commands, 'getAnalysis').mockImplementation(async (id) => {
      if (id === 'demo-2') throw new Error('secondary Demo failed independently');
      return workspace(id);
    });
    const actor = createActor(analysisLifecycleMachine, {
      input: {
        ownerScopeId: 'batch-race', demoId: 'demo-1', runId: null,
        batchIds: ['demo-1', 'demo-2'],
      },
    });
    actor.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(actor.getSnapshot().matches({ route: 'unavailable' })).toBe(true);
    expect(actor.getSnapshot().context).toMatchObject({
      lifecycle: 'discovered', outcome: 'unavailable',
    });
    actor.stop();
  });

  it('synchronously aborts the default old-route loader before a same-tick result can start work', async () => {
    const firstDemo = deferred<Awaited<ReturnType<typeof commands.getDemo>>>();
    const secondDemo = deferred<Awaited<ReturnType<typeof commands.getDemo>>>();
    vi.spyOn(commands, 'getDemo').mockImplementation((id) => (
      id === 'demo-a' ? firstDemo.promise : secondDemo.promise
    ));
    const start = vi.spyOn(commands, 'startAnalysisRun').mockResolvedValue({
      ...cancelledRun('demo-a', 'run-a'),
      status: 'queued',
      stage: 'validating_input',
      input_sha256: null,
      input_size: null,
    });
    vi.spyOn(commands, 'getAnalysisRun').mockReturnValue(new Promise(() => undefined));
    const actor = createActor(analysisLifecycleMachine, {
      input: {
        ownerScopeId: 'route-owner', demoId: 'demo-a', runId: null, batchIds: ['demo-a'],
      },
    });
    actor.start();
    actor.send({
      type: 'ROUTE_CHANGED', ownerScopeId: 'route-owner',
      demoId: 'demo-b', runId: null, batchIds: ['demo-b'],
    });
    firstDemo.resolve({
      id: 'demo-a', path: 'D:/a.dem', filename: 'a.dem', display_name: 'A', map_name: 'unknown',
      match_date: null, cataloged_at: '2026-08-13T01:00:00Z', duration_seconds: 0,
      total_rounds: 0, score_team_a: null, score_team_b: null, team_a_name: null,
      team_b_name: null, status: 'pending', lifecycle_status: 'discovered', players: [],
      source: 'local', remark: '', updated_at: '2026-08-13T01:00:00Z',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(start).not.toHaveBeenCalled();
    actor.stop();
  });

  it('does not restart the owner for the same route and ignores a stopped route result', async () => {
    const first = deferred<AnalysisWorkspace>();
    const second = deferred<AnalysisWorkspace>();
    const aborted: string[] = [];
    const calls = vi.fn(async ({ input, signal }: {
      input: AnalysisRouteLoaderInput;
      signal: AbortSignal;
    }) => {
      signal.addEventListener('abort', () => aborted.push(input.demoId), { once: true });
      return input.demoId === 'demo-1' ? first.promise : second.promise;
    });
    const machine = analysisLifecycleMachine.provide({
      actors: { loadRoute: fromPromise(calls) },
    });
    const actor = createActor(machine, {
      input: {
        ownerScopeId: 'route-switch-owner', demoId: 'demo-1', runId: null, batchIds: ['demo-1'],
      },
    });
    actor.start();

    actor.send({
      type: 'ROUTE_CHANGED', ownerScopeId: 'route-switch-owner',
      demoId: 'demo-1', runId: null, batchIds: ['demo-1'],
    });
    expect(calls).toHaveBeenCalledOnce();
    actor.send({
      type: 'ROUTE_CHANGED', ownerScopeId: 'route-switch-owner',
      demoId: 'demo-2', runId: 'run-2', batchIds: ['demo-2'],
    });
    expect(calls).toHaveBeenCalledTimes(2);
    expect(aborted).toEqual(['demo-1']);

    first.resolve(workspace('demo-1'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actor.getSnapshot().context.demoId).toBe('demo-2');
    expect(actor.getSnapshot().matches({ route: 'ready' })).toBe(false);

    second.resolve(workspace('demo-2'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actor.getSnapshot().matches({ route: 'ready' })).toBe(true);
    expect(actor.getSnapshot().context.workspace.demo_id).toBe('demo-2');
    actor.stop();
  });

  it('rejects every stale observation callback after the route identity changes', async () => {
    const first = deferred<AnalysisWorkspace>();
    const second = deferred<AnalysisWorkspace>();
    const inputs: AnalysisRouteLoaderInput[] = [];
    const machine = analysisLifecycleMachine.provide({
      actors: {
        loadRoute: fromPromise(async ({ input }) => {
          inputs.push(input);
          return input.demoId === 'demo-1' ? first.promise : second.promise;
        }),
      },
    });
    const actor = createActor(machine, {
      input: {
        ownerScopeId: 'stale-owner', demoId: 'demo-1', runId: null, batchIds: ['demo-1'],
      },
    });
    actor.start();
    actor.send({
      type: 'ROUTE_CHANGED', ownerScopeId: 'stale-owner',
      demoId: 'demo-2', runId: 'run-2', batchIds: ['demo-2'],
    });

    inputs[0]!.onLifecycle('missing');
    inputs[0]!.onRun(cancelledRun('demo-1', 'run-stale'));
    inputs[0]!.onBatchUpdate('demo-1', { status: 'ready', workspace: workspace('demo-1') });
    await Promise.resolve();

    expect(actor.getSnapshot().context).toMatchObject({
      demoId: 'demo-2', requestedRunId: 'run-2', runId: 'run-2', lifecycle: null,
      outcome: null,
    });
    expect(actor.getSnapshot().context.batchStates).toEqual({ 'demo-2': { status: 'pending' } });
    expect(actor.getSnapshot().matches({ route: { work: 'loading' } })).toBe(true);
    actor.stop();
  });

  it('rejects an old A generation after navigating A to B to A again', async () => {
    const pending = [deferred<AnalysisWorkspace>(), deferred<AnalysisWorkspace>(), deferred<AnalysisWorkspace>()];
    const inputs: AnalysisRouteLoaderInput[] = [];
    const machine = analysisLifecycleMachine.provide({
      actors: {
        loadRoute: fromPromise(async ({ input }) => {
          const index = inputs.push(input) - 1;
          return pending[index]!.promise;
        }),
      },
    });
    const actor = createActor(machine, {
      input: {
        ownerScopeId: 'aba-owner', demoId: 'demo-a', runId: null, batchIds: ['demo-a'],
      },
    });
    actor.start();
    actor.send({
      type: 'ROUTE_CHANGED', ownerScopeId: 'aba-owner',
      demoId: 'demo-b', runId: null, batchIds: ['demo-b'],
    });
    actor.send({
      type: 'ROUTE_CHANGED', ownerScopeId: 'aba-owner',
      demoId: 'demo-a', runId: null, batchIds: ['demo-a'],
    });
    expect(inputs.map((input) => input.generation)).toEqual([1, 2, 3]);

    inputs[0]!.onLifecycle('missing');
    inputs[0]!.onRun(cancelledRun('demo-a', 'run-stale-a'));
    inputs[0]!.onBatchUpdate('demo-a', { status: 'ready', workspace: workspace('demo-a') });
    await Promise.resolve();

    expect(actor.getSnapshot().context).toMatchObject({
      demoId: 'demo-a', generation: 3, runId: null, lifecycle: null, outcome: null,
    });
    expect(actor.getSnapshot().matches({ route: { work: 'loading' } })).toBe(true);
    actor.stop();
  });

  it('keeps a terminal cancellation absorbing for every same-route late callback', async () => {
    const result = deferred<AnalysisWorkspace>();
    let input!: AnalysisRouteLoaderInput;
    const machine = analysisLifecycleMachine.provide({
      actors: {
        loadRoute: fromPromise(async ({ input: next }) => {
          input = next;
          return result.promise;
        }),
      },
    });
    const actor = createActor(machine, {
      input: {
        ownerScopeId: 'terminal-owner', demoId: 'demo-1', runId: 'run-1', batchIds: ['demo-1'],
      },
    });
    actor.start();
    input.onRun(cancelledRun('demo-1'));
    await Promise.resolve();
    const terminal = actor.getSnapshot().context;

    input.onRun({ ...cancelledRun('demo-1'), status: 'running', stage: 'parser_running' });
    input.onRun({ ...cancelledRun('demo-1'), status: 'completed', stage: 'completed' });
    input.onLifecycle('analyzing');
    input.onBatchUpdate('demo-1', { status: 'ready', workspace: workspace('demo-1') });
    result.resolve(workspace('demo-1'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(actor.getSnapshot().matches({ route: 'cancelled' })).toBe(true);
    expect(actor.getSnapshot().context).toEqual(terminal);
    actor.stop();
  });
});
