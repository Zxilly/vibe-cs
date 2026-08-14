import { describe, expect, it, vi } from 'vitest';

import { analysisBatchIds, runBatchAnalysis } from './analysisBatch';

describe('analysis batch workspace', () => {
  it('keeps stable query order and bounds duplicate query values', () => {
    expect(analysisBatchIds('a', 'b,a,c')).toEqual(['b', 'a', 'c']);
    expect(analysisBatchIds('a', Array.from({ length: 30 }, (_, index) => `d${index}`).join(','))).toHaveLength(12);
  });

  it('reports evidence-backed success and failure for every demo', async () => {
    const states: string[] = [];
    await runBatchAnalysis(
      ['a', 'b'],
      async (id) => {
        if (id === 'b') throw new Error('bad demo');
        return { demo_id: id } as never;
      },
      (id, state) => states.push(`${id}:${state.status}`),
    );
    expect(states).toEqual(expect.arrayContaining(['a:loading', 'a:ready', 'b:loading', 'b:error']));
  });

  it('does not begin another Demo after the route owner aborts', async () => {
    const controller = new AbortController();
    const analyze = vi.fn(async (id: string) => {
      controller.abort();
      return { demo_id: id } as never;
    });

    await expect(runBatchAnalysis(
      ['a', 'b'], analyze, () => undefined, 1, controller.signal,
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(analyze).toHaveBeenCalledOnce();
    expect(analyze).toHaveBeenCalledWith('a');
  });
});
