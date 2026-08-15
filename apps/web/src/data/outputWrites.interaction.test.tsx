/*
 * `interaction` project — the output writes phase 3a added, and what each one
 * invalidates. No real IPC; see `data/test/renderDataHook.tsx`.
 */

import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { DeleteOutputResult, OutputItem, OutputPage } from '../shared/desktop/dto';
import {
  useCleanupMissingOutputs,
  useDeleteOutput,
  useOutputList,
  useRecordedClips,
  useRevealOutput,
} from './outputs';
import type { DesktopClientStub } from './desktopClient';
import { countingStub, renderDataHook } from './test/renderDataHook';

const OUTPUT: OutputItem = {
  id: 'out-1',
  output_kind: 'recording',
  media_kind: 'clip',
  title: 'Kael 1v3',
  path: 'D:\\vibe\\outputs\\Kael_Mirage_1v3.mp4',
  file_name: 'Kael_Mirage_1v3.mp4',
  status: 'completed',
  progress: 1,
  availability: 'present',
  managed: true,
  mutable: true,
  size_bytes: 186_000_000,
  project_id: null,
  demo_id: 'demo-1',
  error: null,
  created_at: '2026-08-15T09:12:00.000Z',
  updated_at: '2026-08-15T09:12:00.000Z',
};

const PAGE: OutputPage = { items: [OUTPUT], total: 1, page: 1, page_size: 12, scan_limited: false };

const DELETED: DeleteOutputResult = {
  id: 'out-1',
  output_kind: 'recording',
  record_deleted: true,
  file_deleted: false,
  file_action: 'external_file_preserved',
  warning: null,
};

describe('useDeleteOutput', () => {
  it('re-runs the list that showed the record', async () => {
    const list = countingStub(PAGE);
    const remove = countingStub(DELETED);
    const client: DesktopClientStub = { listOutputs: list.call, deleteOutput: remove.call };

    const { result } = renderDataHook(
      () => ({ list: useOutputList({ page: 1 }), remove: useDeleteOutput() }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.list.isSuccess).toBe(true);
    });
    const before = list.calls();

    await act(async () => {
      const outcome = await result.current.remove.mutateAsync({ kind: 'recording', id: 'out-1' });
      expect(outcome.file_action).toBe('external_file_preserved');
    });

    // 「移除记录不会删除文件」: the destructive flag is opt-in per call.
    expect(remove.lastArgs()).toEqual(['recording', 'out-1', false]);
    await waitFor(() => {
      expect(list.calls()).toBeGreaterThan(before);
    });
  });

  it('reaches the recorded clips too — one file, two views of it', async () => {
    const clips = countingStub({ items: [], total: 0, page: 1, page_size: 20 });
    const remove = countingStub(DELETED);
    const client: DesktopClientStub = { listRecordedClips: clips.call, deleteOutput: remove.call };

    const { result } = renderDataHook(
      () => ({ clips: useRecordedClips(), remove: useDeleteOutput() }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.clips.isSuccess).toBe(true);
    });
    const before = clips.calls();

    await act(async () => {
      await result.current.remove.mutateAsync({ kind: 'recording', id: 'out-1' });
    });

    await waitFor(() => {
      expect(clips.calls()).toBeGreaterThan(before);
    });
  });
});

describe('useCleanupMissingOutputs', () => {
  it('re-runs the list, which is the whole point of the button', async () => {
    const list = countingStub(PAGE);
    const cleanup = countingStub({ inspected: 12, deleted: 3, scan_limited: false });
    const client: DesktopClientStub = { listOutputs: list.call, cleanupMissingOutputs: cleanup.call };

    const { result } = renderDataHook(
      () => ({ list: useOutputList({ page: 1 }), cleanup: useCleanupMissingOutputs() }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.list.isSuccess).toBe(true);
    });
    const before = list.calls();

    await act(async () => {
      const outcome = await result.current.cleanup.mutateAsync(undefined);
      expect(outcome.deleted).toBe(3);
    });

    await waitFor(() => {
      expect(list.calls()).toBeGreaterThan(before);
    });
  });

  it('says which command is missing rather than throwing undefined is not a function', async () => {
    const { result } = renderDataHook(() => useCleanupMissingOutputs(), { client: {} });

    await act(async () => {
      await expect(result.current.mutateAsync(undefined)).rejects.toThrow(/cleanupMissingOutputs/u);
    });
  });
});

describe('useRevealOutput', () => {
  it('reports honestly that a browser cannot open a file manager', async () => {
    const { result } = renderDataHook(() => useRevealOutput(), { client: {} });

    await act(async () => {
      // jsdom is not the desktop shell, so `revealLocalPath` resolves false
      // without importing the Tauri plugin — the page turns that into a
      // sentence instead of pretending the action happened.
      await expect(result.current.mutateAsync(OUTPUT.path)).resolves.toBe(false);
    });
  });
});
