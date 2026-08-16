import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';

export const maximumBatchDemos = 12;

export function analysisBatchIds(primary: string, encoded: string | null): string[] {
  const candidates = [...(encoded?.split(',') ?? []), primary]
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(candidates)].slice(0, maximumBatchDemos);
}

export type BatchAnalysisState =
  | { status: 'pending' | 'loading' }
  | { status: 'ready'; workspace: AnalysisWorkspace }
  | { status: 'error'; message: string };

export async function runBatchAnalysis(
  ids: readonly string[],
  analyze: (id: string) => Promise<AnalysisWorkspace>,
  update: (id: string, state: BatchAnalysisState) => void,
  concurrency = 2,
  signal?: AbortSignal,
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      signal?.throwIfAborted();
      const id = ids[cursor++];
      if (!id) continue;
      update(id, { status: 'loading' });
      try {
        const workspace = await analyze(id);
        signal?.throwIfAborted();
        update(id, { status: 'ready', workspace });
      } catch (error) {
        signal?.throwIfAborted();
        update(id, {
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), ids.length) }, worker));
}
