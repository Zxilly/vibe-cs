import { assign, fromPromise, setup, type SnapshotFrom } from 'xstate';

import { commands } from '../../shared/desktop/client';
import type { AnalysisRun, DemoLifecycleStatus } from '../../shared/desktop/dto';
import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import { runBatchAnalysis, type BatchAnalysisState } from './analysisBatch';
import {
  AnalysisLifecycleError,
  AnalysisRunError,
  loadDemoAnalysis,
} from './analysisLoader';

export type AnalysisLifecycleMachineInput = {
  ownerScopeId: string;
  demoId: string;
  runId: string | null;
  batchIds: readonly string[];
  onRunObserved?: (run: AnalysisRun) => void;
};

type AnalysisRouteIdentity = {
  generation: number;
};

export type AnalysisRouteLoaderInput = AnalysisLifecycleMachineInput & {
  routeKey: string;
  generation: number;
  onLifecycle: (status: DemoLifecycleStatus) => void;
  onRun: (run: AnalysisRun) => void;
  onBatchUpdate: (demoId: string, state: BatchAnalysisState) => void;
};

type AnalysisLifecycleOutcome = 'cancelled' | 'failed' | 'unavailable' | null;

export type AnalysisLifecycleContext = {
  ownerScopeId: string;
  routeKey: string;
  generation: number;
  demoId: string;
  requestedRunId: string | null;
  runId: string | null;
  batchIds: readonly string[];
  onRunObserved: ((run: AnalysisRun) => void) | undefined;
  workspace: AnalysisWorkspace;
  lifecycle: DemoLifecycleStatus | null;
  message: string | null;
  outcome: AnalysisLifecycleOutcome;
  batchStates: Record<string, BatchAnalysisState>;
};

type AnalysisLifecycleEvent =
  | ({ type: 'ROUTE_CHANGED' } & AnalysisLifecycleMachineInput)
  | ({ type: 'LIFECYCLE_OBSERVED'; status: DemoLifecycleStatus } & AnalysisRouteIdentity)
  | ({ type: 'RUN_OBSERVED'; run: AnalysisRun } & AnalysisRouteIdentity)
  | ({ type: 'BATCH_UPDATED'; demoId: string; state: BatchAnalysisState } & AnalysisRouteIdentity)
  | { type: 'xstate.done.actor.load-route'; output: AnalysisWorkspace }
  | { type: 'xstate.error.actor.load-route'; error: unknown };

class AnalysisRouteUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisRouteUnavailableError';
  }
}

export function emptyAnalysisWorkspace(demoId: string): AnalysisWorkspace {
  return {
    demo_id: demoId,
    map_name: '',
    tick_rate: 0,
    duration_seconds: 0,
    teams: [],
    players: [],
    rounds: [],
    highlights: [],
  };
}

function initialBatchStates(ids: readonly string[]): Record<string, BatchAnalysisState> {
  return Object.fromEntries(ids.map((id) => [id, { status: 'pending' as const }]));
}

export function analysisRouteKey(input: AnalysisLifecycleMachineInput): string {
  return JSON.stringify([input.demoId, input.runId, [...input.batchIds]]);
}

async function loadAnalysisRoute(
  input: AnalysisRouteLoaderInput,
  signal: AbortSignal,
): Promise<AnalysisWorkspace> {
  if (!input.demoId) throw new AnalysisRouteUnavailableError('Select a Demo to analyze.');
  if (input.batchIds.length <= 1) {
    return loadDemoAnalysis(input.demoId, commands, signal, {
      runId: input.runId,
      onLifecycle: input.onLifecycle,
      onRun: input.onRun,
    });
  }

  const settled = new Map<string, BatchAnalysisState>();
  const failures = new Map<string, unknown>();
  await runBatchAnalysis(
    input.batchIds,
    async (demoId) => {
      try {
        return await loadDemoAnalysis(
          demoId,
          commands,
          signal,
          demoId === input.demoId
            ? { onLifecycle: input.onLifecycle, onRun: input.onRun }
            : {},
        );
      } catch (error) {
        failures.set(demoId, error);
        throw error;
      }
    },
    (demoId, state) => {
      settled.set(demoId, state);
      input.onBatchUpdate(demoId, state);
    },
    2,
    signal,
  );
  const selected = settled.get(input.demoId);
  if (selected?.status === 'ready') return selected.workspace;
  if (selected?.status === 'error') {
    throw failures.get(input.demoId) ?? new Error(selected.message);
  }
  throw new AnalysisRouteUnavailableError('The selected batch Demo is unavailable.');
}

type AnalysisRouteObserver = Pick<
  AnalysisRouteLoaderInput,
  'onLifecycle' | 'onRun' | 'onBatchUpdate'
>;

type SharedAnalysisRoute = {
  routeKey: string;
  controller: AbortController;
  observers: Set<AnalysisRouteObserver>;
  promise: Promise<AnalysisWorkspace>;
  abortTimer: ReturnType<typeof setTimeout> | null;
};

const sharedAnalysisRoutes = new Map<string, SharedAnalysisRoute>();

function acquireAnalysisRoute(
  input: AnalysisRouteLoaderInput,
  signal: AbortSignal,
): Promise<AnalysisWorkspace> {
  signal.throwIfAborted();
  let shared = sharedAnalysisRoutes.get(input.ownerScopeId);
  if (shared && shared.routeKey !== input.routeKey) {
    if (shared.abortTimer !== null) clearTimeout(shared.abortTimer);
    sharedAnalysisRoutes.delete(input.ownerScopeId);
    shared.controller.abort();
    shared = undefined;
  }
  if (!shared) {
    const observers = new Set<AnalysisRouteObserver>();
    const controller = new AbortController();
    const ownedInput: AnalysisRouteLoaderInput = {
      ...input,
      onLifecycle: (status) => {
        for (const observer of [...observers]) observer.onLifecycle(status);
      },
      onRun: (run) => {
        for (const observer of [...observers]) observer.onRun(run);
      },
      onBatchUpdate: (demoId, state) => {
        for (const observer of [...observers]) observer.onBatchUpdate(demoId, state);
      },
    };
    const created: SharedAnalysisRoute = {
      routeKey: input.routeKey,
      controller,
      observers,
      promise: Promise.resolve(emptyAnalysisWorkspace(input.demoId)),
      abortTimer: null,
    };
    created.promise = loadAnalysisRoute(ownedInput, controller.signal).finally(() => {
      if (sharedAnalysisRoutes.get(input.ownerScopeId) === created) {
        sharedAnalysisRoutes.delete(input.ownerScopeId);
      }
      if (created.abortTimer !== null) clearTimeout(created.abortTimer);
    });
    sharedAnalysisRoutes.set(input.ownerScopeId, created);
    shared = created;
  }
  if (shared.abortTimer !== null) {
    clearTimeout(shared.abortTimer);
    shared.abortTimer = null;
  }

  const observer: AnalysisRouteObserver = {
    onLifecycle: input.onLifecycle,
    onRun: input.onRun,
    onBatchUpdate: input.onBatchUpdate,
  };
  shared.observers.add(observer);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    shared!.observers.delete(observer);
    if (shared!.observers.size > 0 || sharedAnalysisRoutes.get(input.ownerScopeId) !== shared) return;
    shared!.abortTimer = setTimeout(() => {
      if (shared!.observers.size > 0 || sharedAnalysisRoutes.get(input.ownerScopeId) !== shared) return;
      sharedAnalysisRoutes.delete(input.ownerScopeId);
      shared!.controller.abort();
    }, 0);
  };
  signal.addEventListener('abort', release, { once: true });
  return shared.promise.finally(() => {
    signal.removeEventListener('abort', release);
    release();
  });
}

function sameRoute(
  context: AnalysisLifecycleContext,
  event: Extract<AnalysisLifecycleEvent, { type: 'ROUTE_CHANGED' }>,
): boolean {
  return context.ownerScopeId === event.ownerScopeId
    && context.demoId === event.demoId
    && context.requestedRunId === event.runId
    && context.batchIds.join(',') === event.batchIds.join(',');
}

function errorOutcome(error: unknown): Exclude<AnalysisLifecycleOutcome, null> {
  if (error instanceof AnalysisRunError && error.status === 'cancelled') return 'cancelled';
  if (error instanceof AnalysisLifecycleError) {
    return error.lifecycle === 'failed' ? 'failed' : 'unavailable';
  }
  if (error instanceof AnalysisRouteUnavailableError) return 'unavailable';
  return 'failed';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const analysisLifecycleMachine = setup({
  types: {
    context: {} as AnalysisLifecycleContext,
    input: {} as AnalysisLifecycleMachineInput,
    events: {} as AnalysisLifecycleEvent,
  },
  actors: {
    loadRoute: fromPromise<AnalysisWorkspace, AnalysisRouteLoaderInput>(
      ({ input, signal }) => acquireAnalysisRoute(input, signal),
    ),
  },
  guards: {
    sameRoute: ({ context, event }) => event.type === 'ROUTE_CHANGED' && sameRoute(context, event),
    errorCancelled: ({ event }) => event.type === 'xstate.error.actor.load-route'
      && errorOutcome(event.error) === 'cancelled',
    errorUnavailable: ({ event }) => event.type === 'xstate.error.actor.load-route'
      && errorOutcome(event.error) === 'unavailable',
    currentObservation: ({ context, event }) => 'generation' in event
      && event.generation === context.generation,
  },
  actions: {
    assignRoute: assign(({ context, event }) => {
      if (event.type !== 'ROUTE_CHANGED') return {};
      return {
        ownerScopeId: event.ownerScopeId,
        demoId: event.demoId,
        routeKey: analysisRouteKey(event),
        generation: context.generation + 1,
        requestedRunId: event.runId,
        runId: event.runId,
        batchIds: [...event.batchIds],
        onRunObserved: event.onRunObserved,
        workspace: emptyAnalysisWorkspace(event.demoId),
        lifecycle: null,
        message: null,
        outcome: null,
        batchStates: initialBatchStates(event.batchIds),
      };
    }),
    assignLifecycle: assign(({ event }) => event.type === 'LIFECYCLE_OBSERVED'
      ? { lifecycle: event.status }
      : {}),
    assignObservedRun: assign(({ event }) => event.type === 'RUN_OBSERVED'
      ? { runId: event.run.id }
      : {}),
    publishObservedRun: ({ context, event }) => {
      if (event.type === 'RUN_OBSERVED') context.onRunObserved?.(event.run);
    },
    assignCancelledRun: assign(({ event }) => event.type === 'RUN_OBSERVED'
      ? {
        runId: event.run.id,
        message: 'Analysis run was cancelled.',
        outcome: 'cancelled' as const,
      }
      : {}),
    assignFailedRun: assign(({ event }) => event.type === 'RUN_OBSERVED'
      ? {
        runId: event.run.id,
        message: event.run.error ?? `Analysis run ${event.run.status}.`,
        outcome: 'failed' as const,
      }
      : {}),
    assignBatchUpdate: assign(({ context, event }) => event.type === 'BATCH_UPDATED'
      ? { batchStates: { ...context.batchStates, [event.demoId]: event.state } }
      : {}),
    assignResolved: assign(({ event }) => event.type === 'xstate.done.actor.load-route'
      ? {
        workspace: event.output,
        message: null,
        outcome: null,
      }
      : {}),
    assignRejected: assign(({ event }) => {
      if (event.type !== 'xstate.error.actor.load-route') return {};
      const outcome = errorOutcome(event.error);
      return {
        ...(event.error instanceof AnalysisLifecycleError
          ? { lifecycle: event.error.lifecycle }
          : {}),
        ...(event.error instanceof AnalysisRunError ? { runId: event.error.runId } : {}),
        message: errorMessage(event.error),
        outcome,
      };
    }),
  },
}).createMachine({
  id: 'analysis-lifecycle',
  context: ({ input }) => ({
    ownerScopeId: input.ownerScopeId,
    routeKey: analysisRouteKey(input),
    generation: 1,
    demoId: input.demoId,
    requestedRunId: input.runId,
    runId: input.runId,
    batchIds: [...input.batchIds],
    onRunObserved: input.onRunObserved,
    workspace: emptyAnalysisWorkspace(input.demoId),
    lifecycle: null,
    message: null,
    outcome: null,
    batchStates: initialBatchStates(input.batchIds),
  }),
  initial: 'route',
  on: {
    ROUTE_CHANGED: [
      { guard: 'sameRoute' },
      { target: '.route.work.loading', reenter: true, actions: 'assignRoute' },
    ],
  },
  states: {
    route: {
      initial: 'work',
      states: {
        work: {
          initial: 'loading',
          invoke: {
            id: 'load-route',
            src: 'loadRoute',
            input: ({ context, self }) => ({
              ownerScopeId: context.ownerScopeId,
              demoId: context.demoId,
              runId: context.requestedRunId,
              batchIds: context.batchIds,
              routeKey: context.routeKey,
              generation: context.generation,
              onLifecycle: (status) => self.send({
                type: 'LIFECYCLE_OBSERVED', generation: context.generation, status,
              }),
              onRun: (run) => self.send({
                type: 'RUN_OBSERVED', generation: context.generation, run,
              }),
              onBatchUpdate: (demoId, state) => self.send({
                type: 'BATCH_UPDATED', generation: context.generation, demoId, state,
              }),
            }),
            onDone: {
              target: '#analysis-lifecycle.route.ready',
              actions: 'assignResolved',
            },
            onError: [
              { guard: 'errorCancelled', target: '#analysis-lifecycle.route.cancelled', actions: 'assignRejected' },
              { guard: 'errorUnavailable', target: '#analysis-lifecycle.route.unavailable', actions: 'assignRejected' },
              { target: '#analysis-lifecycle.route.failed', actions: 'assignRejected' },
            ],
          },
          on: {
            LIFECYCLE_OBSERVED: {
              guard: 'currentObservation', target: '.observing', actions: 'assignLifecycle',
            },
            RUN_OBSERVED: [
              {
                guard: ({ context, event }) => event.generation === context.generation
                  && event.run.status === 'cancelled',
                target: '#analysis-lifecycle.route.cancelled',
                actions: ['assignCancelledRun', 'publishObservedRun'],
              },
              {
                guard: ({ context, event }) => event.generation === context.generation
                  && (event.run.status === 'failed' || event.run.status === 'interrupted'),
                target: '#analysis-lifecycle.route.failed',
                actions: ['assignFailedRun', 'publishObservedRun'],
              },
              {
                guard: 'currentObservation',
                target: '.observing',
                actions: ['assignObservedRun', 'publishObservedRun'],
              },
            ],
            BATCH_UPDATED: { guard: 'currentObservation', actions: 'assignBatchUpdate' },
          },
          states: {
            loading: {},
            observing: {},
          },
        },
        ready: {},
        cancelled: {},
        failed: {},
        unavailable: {},
      },
    },
  },
});

export type AnalysisLifecycleViewState =
  | 'loading'
  | 'observing'
  | 'ready'
  | 'cancelled'
  | 'failed'
  | 'unavailable';

export function analysisLifecycleViewState(
  snapshot: SnapshotFrom<typeof analysisLifecycleMachine>,
): AnalysisLifecycleViewState {
  for (const state of ['loading', 'observing'] as const) {
    if (snapshot.matches({ route: { work: state } })) return state;
  }
  for (const state of ['ready', 'cancelled', 'failed', 'unavailable'] as const) {
    if (snapshot.matches({ route: state })) return state;
  }
  return 'loading';
}
