import type { AnalysisRun, AnalysisRunDetail } from '../../shared/desktop/dto';
import type { AnalysisWorkspace, DemoSummary } from '../../shared/desktop/viewModels';

export type AnalysisLifecycleClient = {
  getDemo(id: string, signal?: AbortSignal): Promise<DemoSummary>;
  getAnalysis(id: string, signal?: AbortSignal): Promise<AnalysisWorkspace>;
  startAnalysisRun(id: string, signal?: AbortSignal): Promise<AnalysisRun>;
  getActiveAnalysisRun(id: string, signal?: AbortSignal): Promise<AnalysisRunDetail>;
  getAnalysisRun(id: string, signal?: AbortSignal): Promise<AnalysisRunDetail>;
  getAnalysisRunResult(id: string, signal?: AbortSignal): Promise<AnalysisWorkspace>;
};

export type AnalysisLoaderOptions = {
  runId?: string | null;
  wait?: (signal?: AbortSignal) => Promise<void>;
  onLifecycle?: (status: DemoSummary['lifecycle_status']) => void;
  onRun?: (run: AnalysisRun) => void;
};

export class AnalysisLifecycleError extends Error {
  readonly lifecycle: DemoSummary['lifecycle_status'];

  constructor(lifecycle: DemoSummary['lifecycle_status'], message: string) {
    super(message);
    this.name = 'AnalysisLifecycleError';
    this.lifecycle = lifecycle;
  }
}

export class AnalysisRunError extends Error {
  readonly runId: string;
  readonly status: 'failed' | 'interrupted' | 'cancelled' | 'completed';

  constructor(run: AnalysisRun, message: string) {
    super(message);
    this.name = 'AnalysisRunError';
    this.runId = run.id;
    this.status = run.status as AnalysisRunError['status'];
  }
}

function waitForPoll(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    let timer = 0;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      window.clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    timer = window.setTimeout(() => {
      cleanup();
      resolve();
    }, 1_000);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isNotFound(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'status' in error
    && error.status === 404;
}

async function observeRun(
  demoId: string,
  runId: string,
  client: AnalysisLifecycleClient,
  signal: AbortSignal | undefined,
  options: AnalysisLoaderOptions,
  initial?: AnalysisRunDetail,
  observed?: AnalysisRun,
): Promise<AnalysisWorkspace> {
  let detail = initial;
  let lastObserved = observed;
  for (;;) {
    signal?.throwIfAborted();
    detail ??= await client.getAnalysisRun(runId, signal);
    signal?.throwIfAborted();
    if (detail.run.id !== runId || detail.run.demo_id !== demoId) {
      throw new Error('Analysis run identity does not match the requested Demo.');
    }
    if (
      !lastObserved
      || lastObserved.id !== detail.run.id
      || lastObserved.status !== detail.run.status
      || lastObserved.stage !== detail.run.stage
      || lastObserved.updated_at !== detail.run.updated_at
    ) {
      options.onRun?.(detail.run);
      lastObserved = detail.run;
    }
    if (detail.run.status === 'completed') {
      if (!detail.result_available) {
        throw new AnalysisRunError(detail.run, 'Analysis run completed without a committed result.');
      }
      signal?.throwIfAborted();
      const workspace = await client.getAnalysisRunResult(runId, signal);
      signal?.throwIfAborted();
      if (workspace.demo_id !== demoId) {
        throw new Error('Analysis run result identity does not match the requested Demo.');
      }
      return workspace;
    }
    if (detail.run.status === 'failed' || detail.run.status === 'interrupted') {
      throw new AnalysisRunError(
        detail.run,
        detail.run.error ?? `Analysis run ${detail.run.status}. Review its persisted events in Activity.`,
      );
    }
    if (detail.run.status === 'cancelled') {
      throw new AnalysisRunError(detail.run, 'Analysis run was cancelled.');
    }
    signal?.throwIfAborted();
    await (options.wait ?? waitForPoll)(signal);
    signal?.throwIfAborted();
    detail = await client.getAnalysisRun(runId, signal);
    signal?.throwIfAborted();
  }
}

export async function loadDemoAnalysis(
  demoId: string,
  client: AnalysisLifecycleClient,
  signal?: AbortSignal,
  options: AnalysisLoaderOptions = {},
): Promise<AnalysisWorkspace> {
  signal?.throwIfAborted();
  if (options.runId) {
    return observeRun(demoId, options.runId, client, signal, options);
  }

  let demo = await client.getDemo(demoId, signal);
  signal?.throwIfAborted();
  options.onLifecycle?.(demo.lifecycle_status);
  while (demo.lifecycle_status === 'indexing') {
    signal?.throwIfAborted();
    await (options.wait ?? waitForPoll)(signal);
    signal?.throwIfAborted();
    demo = await client.getDemo(demoId, signal);
    signal?.throwIfAborted();
    options.onLifecycle?.(demo.lifecycle_status);
  }

  if (demo.lifecycle_status === 'ready') {
    signal?.throwIfAborted();
    return client.getAnalysis(demoId, signal);
  }
  if (demo.lifecycle_status === 'analyzing') {
    try {
      signal?.throwIfAborted();
      const active = await client.getActiveAnalysisRun(demoId, signal);
      signal?.throwIfAborted();
      return observeRun(demoId, active.run.id, client, signal, options, active);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      signal?.throwIfAborted();
      const settled = await client.getDemo(demoId, signal);
      signal?.throwIfAborted();
      options.onLifecycle?.(settled.lifecycle_status);
      if (settled.lifecycle_status === 'ready') {
        signal?.throwIfAborted();
        return client.getAnalysis(demoId, signal);
      }
      if (settled.lifecycle_status === 'missing') {
        throw new AnalysisLifecycleError(
          'missing',
          'Restore the Demo file to its watched folder, then rescan the library.',
        );
      }
      throw new AnalysisLifecycleError(
        settled.lifecycle_status,
        settled.lifecycle_status === 'failed'
          ? 'Analysis failed. Review its persisted run in Activity before retrying.'
          : 'The active analysis run changed while this view was loading. Refresh Activity to inspect persisted state.',
      );
    }
  }
  if (demo.lifecycle_status === 'discovered' || demo.lifecycle_status === 'failed') {
    signal?.throwIfAborted();
    const run = await client.startAnalysisRun(demoId, signal);
    signal?.throwIfAborted();
    options.onRun?.(run);
    return observeRun(demoId, run.id, client, signal, options, undefined, run);
  }
  if (demo.lifecycle_status === 'missing') {
    throw new AnalysisLifecycleError(
      'missing',
      'Restore the Demo file to its watched folder, then rescan the library.',
    );
  }
  throw new Error(`Analysis is unavailable while Demo is ${demo.lifecycle_status}.`);
}
