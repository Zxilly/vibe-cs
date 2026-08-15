/**
 * `interaction` project — delivery outputs.
 *
 * No real IPC (see `demos.interaction.test.tsx`). What is pinned here is that
 * outputs and recorded clips share one namespace, because one finished
 * recording produces both and they must not refresh at different times.
 */

import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { OutputItem, OutputPage, Paginated, RecordedClip } from '../shared/desktop/dto';
import { dataErrorMessage } from './errors';
import { invalidateOutputs, useOutputList, useRecordedClips } from './outputs';
import { countingStub, renderDataHook } from './test/renderDataHook';

const OUTPUT: OutputItem = {
  id: 'out-1',
  output_kind: 'export',
  media_kind: 'video',
  title: 'Kael 的 1v3',
  status: 'completed',
  progress: 1,
  path: 'C:/outputs/kael-1v3.mp4',
  file_name: 'kael-1v3.mp4',
  availability: 'present',
  managed: true,
  mutable: true,
  size_bytes: 84_000_000,
  project_id: 'proj-1',
  demo_id: 'demo-a',
  error: null,
  created_at: '2026-08-15T09:00:00Z',
  updated_at: '2026-08-15T09:20:00Z',
};

const PAGE: OutputPage = {
  items: [OUTPUT],
  total: 1,
  page: 1,
  page_size: 20,
  scan_limited: false,
};

const CLIPS: Paginated<RecordedClip> = {
  items: [
    {
      id: 'clip-1',
      title: 'Kael 的 1v3',
      player_name: 'Kael',
      map_name: 'de_mirage',
      duration_seconds: 18,
      created_at: '2026-08-15T09:10:00Z',
      stream_url: 'vibe-cs-media://localhost/recorded-clips/clip-1',
    },
  ],
  total: 1,
  page: 1,
  page_size: 20,
};

describe('useOutputList', () => {
  it('returns the page and the scan_limited flag', async () => {
    const list = countingStub(PAGE);
    const { result } = renderDataHook(() => useOutputList({ kind: 'export' }), {
      client: { listOutputs: list.call },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    // 「文件缺失」 honesty depends on this: a limited scan is not an empty list.
    expect(result.current.data?.scan_limited).toBe(false);
    expect(list.lastArgs()[0]).toEqual({ kind: 'export' });
  });

  it('keeps a failure readable', async () => {
    const list = countingStub(PAGE);
    list.fail(new Error('输出目录不可访问'));

    const { result } = renderDataHook(() => useOutputList({}), {
      client: { listOutputs: list.call },
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(dataErrorMessage(result.current.error)).toBe('输出目录不可访问');
  });
});

describe('invalidateOutputs', () => {
  it('refreshes the output list and the recorded clips together', async () => {
    const list = countingStub(PAGE);
    const clips = countingStub(CLIPS);

    const { result, queryClient } = renderDataHook(
      () => ({ outputs: useOutputList({}), clips: useRecordedClips() }),
      { client: { listOutputs: list.call, listRecordedClips: clips.call } },
    );

    await waitFor(() => {
      expect(result.current.outputs.isSuccess).toBe(true);
      expect(result.current.clips.isSuccess).toBe(true);
    });

    await act(async () => {
      await invalidateOutputs(queryClient);
    });

    await waitFor(() => {
      expect(list.calls()).toBe(2);
      expect(clips.calls()).toBe(2);
    });
  });
});
