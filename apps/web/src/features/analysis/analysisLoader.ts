import type { AnalysisWorkspace, DemoSummary } from '../../shared/desktop/dto';

export type AnalysisLifecycleClient = {
  getDemo(id: string, signal?: AbortSignal): Promise<DemoSummary>;
  getAnalysis(id: string, signal?: AbortSignal): Promise<AnalysisWorkspace>;
  analyzeDemo(id: string, signal?: AbortSignal): Promise<AnalysisWorkspace>;
};

export type AnalysisLoaderOptions = {
  wait?: (signal?: AbortSignal) => Promise<void>;
  onLifecycle?: (status: DemoSummary['lifecycle_status']) => void;
};

export class AnalysisLifecycleError extends Error {
  readonly lifecycle: DemoSummary['lifecycle_status'];

  constructor(lifecycle: DemoSummary['lifecycle_status'], message: string) {
    super(message);
    this.name = 'AnalysisLifecycleError';
    this.lifecycle = lifecycle;
  }
}

function waitForPoll(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
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

export async function loadDemoAnalysis(
  demoId: string,
  client: AnalysisLifecycleClient,
  signal?: AbortSignal,
  options: AnalysisLoaderOptions = {},
): Promise<AnalysisWorkspace> {
  let demo = await client.getDemo(demoId, signal);
  options.onLifecycle?.(demo.lifecycle_status);
  if (demo.lifecycle_status === 'ready') {
    return client.getAnalysis(demoId, signal);
  }
  if (demo.lifecycle_status === 'discovered' || demo.lifecycle_status === 'failed') {
    options.onLifecycle?.('analyzing');
    try {
      return await client.analyzeDemo(demoId, signal);
    } catch (error) {
      options.onLifecycle?.('failed');
      throw error;
    }
  }
  while (demo.lifecycle_status === 'indexing' || demo.lifecycle_status === 'analyzing') {
    await (options.wait ?? waitForPoll)(signal);
    demo = await client.getDemo(demoId, signal);
    options.onLifecycle?.(demo.lifecycle_status);
    if (demo.lifecycle_status === 'ready') {
      return client.getAnalysis(demoId, signal);
    }
  }
  if (demo.lifecycle_status === 'failed') {
    throw new AnalysisLifecycleError(
      'failed',
      'Analysis failed. Return to the library to review the Demo and retry.',
    );
  }
  if (demo.lifecycle_status === 'missing') {
    throw new AnalysisLifecycleError(
      'missing',
      'Restore the Demo file to its watched folder, then rescan the library.',
    );
  }
  throw new Error(`analysis is unavailable while demo is ${demo.lifecycle_status}`);
}
