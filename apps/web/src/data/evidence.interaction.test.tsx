/**
 * `interaction` project — evidence search and annotations.
 *
 * No real IPC (see `demos.interaction.test.tsx`). The shape this file exists to
 * pin is the *split* invalidation: `/evidence` shows search results and
 * annotations side by side, and writing a note must not re-run the search.
 */

import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type {
  EvidenceAnnotation,
  EvidenceSearchResponse,
  Paginated,
} from '../shared/desktop/dto';
import { dataErrorMessage } from './errors';
import {
  invalidateEvidence,
  invalidateEvidenceAnnotations,
  useEvidenceAnnotations,
  useEvidenceSearch,
} from './evidence';
import { countingStub, renderDataHook } from './test/renderDataHook';

const SEARCH: EvidenceSearchResponse = {
  items: [],
  total: 0,
  page: 1,
  page_size: 20,
  availability: {
    indexed_items: 0,
    indexed_demos: 0,
    total_analyses: 0,
    scan_complete: true,
    match_date: { available: false, indexed_items: 0, reason: '尚未分析任何比赛' },
    source: { available: false, indexed_items: 0, reason: null },
  },
};

const ANNOTATIONS: Paginated<EvidenceAnnotation> = {
  items: [
    {
      id: 'note-1',
      demo_id: 'demo-a',
      evidence_id: 'ev-1',
      round: 12,
      tick: 100_000,
      body: '这里换位太慢',
      tags: ['复盘'],
      review_state: 'open',
      created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-01T00:00:00Z',
    },
  ],
  total: 1,
  page: 1,
  page_size: 20,
};

describe('useEvidenceSearch', () => {
  it('returns the availability block alongside the results', async () => {
    const search = countingStub(SEARCH);
    const { result } = renderDataHook(() => useEvidenceSearch({ q: 'ace' }), {
      client: { searchEvidence: search.call },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    // The page needs this to say 「索引尚未建立」 instead of 「没有结果」.
    expect(result.current.data?.availability.match_date.reason).toBe('尚未分析任何比赛');
    expect(search.lastArgs()[0]).toEqual({ q: 'ace' });
  });

  it('keeps a failure readable', async () => {
    const search = countingStub(SEARCH);
    search.fail(new Error('evidence index unavailable'));

    const { result } = renderDataHook(() => useEvidenceSearch({}), {
      client: { searchEvidence: search.call },
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(dataErrorMessage(result.current.error)).toBe('evidence index unavailable');
  });
});

describe('invalidation', () => {
  it('an annotation write refreshes the notes and leaves the search alone', async () => {
    const search = countingStub(SEARCH);
    const annotations = countingStub(ANNOTATIONS);

    const { result, queryClient } = renderDataHook(
      () => ({
        search: useEvidenceSearch({ q: 'ace' }),
        annotations: useEvidenceAnnotations({ state: 'open' }),
      }),
      { client: { searchEvidence: search.call, listEvidenceAnnotations: annotations.call } },
    );

    await waitFor(() => {
      expect(result.current.search.isSuccess).toBe(true);
      expect(result.current.annotations.isSuccess).toBe(true);
    });

    await act(async () => {
      await invalidateEvidenceAnnotations(queryClient);
    });

    await waitFor(() => {
      expect(annotations.calls()).toBe(2);
    });
    expect(search.calls()).toBe(1);
  });

  it('an analysis completing refreshes both', async () => {
    const search = countingStub(SEARCH);
    const annotations = countingStub(ANNOTATIONS);

    const { result, queryClient } = renderDataHook(
      () => ({
        search: useEvidenceSearch({}),
        annotations: useEvidenceAnnotations({}),
      }),
      { client: { searchEvidence: search.call, listEvidenceAnnotations: annotations.call } },
    );

    await waitFor(() => {
      expect(result.current.search.isSuccess).toBe(true);
      expect(result.current.annotations.isSuccess).toBe(true);
    });

    await act(async () => {
      await invalidateEvidence(queryClient);
    });

    await waitFor(() => {
      expect(search.calls()).toBe(2);
      expect(annotations.calls()).toBe(2);
    });
  });
});
