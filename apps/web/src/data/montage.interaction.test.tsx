/*
 * `interaction` project — 「09」's data layer.
 *
 * The subject is the write path. A montage project has no revision, so the
 * read-modify-write in `saveMontageProject` is the only thing standing between
 * two panels and a lost update — these tests are what make that claim
 * checkable, including the case it *cannot* fix.
 */

import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type {
  BeatAlignmentDraft,
  MontageClipRecord,
  MontageProjectRecord,
  MontageSettingsRecord,
} from '../shared/desktop/dto';
import type { DesktopClientStub } from './desktopClient';
import { qk } from './keys';
import {
  isMontageWriteConflict,
  useApplyBeatAlignment,
  useBeatAlignmentPreview,
  useExportMontageProject,
  useMontageProject,
  useSaveMontageProject,
} from './montage';
import { countingStub, renderDataHook } from './test/renderDataHook';

const SETTINGS: MontageSettingsRecord = {
  width: 1920,
  height: 1080,
  fps: 60,
  encoder: 'auto',
  quality: 60,
  background_music: null,
  music_volume: 0.8,
  transition_seconds: 0.25,
  intro_title: null,
  intro_duration_seconds: 3,
  include_name_cards: true,
  name_card_duration_seconds: 2,
  outro_title: null,
  outro_duration_seconds: 2,
  branding_theme: 'vibe',
};

const CLIP: MontageClipRecord = {
  clip_id: 'clip-a',
  order: 0,
  trim_start: 0,
  trim_end: 42,
  transition: 'cut',
  title: null,
  avatar_asset_id: null,
};

function project(overrides: Partial<MontageProjectRecord> = {}): MontageProjectRecord {
  return {
    id: 'm-1',
    name: 'Kael 个人集锦 v2',
    clips: [CLIP],
    settings: SETTINGS,
    created_at: '2026-08-15T09:00:00.000Z',
    updated_at: '2026-08-15T09:40:00.000Z',
    ...overrides,
  };
}

function trackInvalidations(queryClient: {
  invalidateQueries: (filters?: { queryKey?: readonly unknown[] }) => Promise<void>;
}): unknown[][] {
  const seen: unknown[][] = [];
  const original = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = (filters?: { queryKey?: readonly unknown[] }) => {
    if (filters?.queryKey) seen.push([...filters.queryKey]);
    return original(filters);
  };
  return seen;
}

/* ── the read-modify-write ───────────────────────────────────────────────── */

describe('useSaveMontageProject', () => {
  it('re-reads before it writes, and edits the document it just read', async () => {
    /* The service has already moved on: someone renamed the project while this
       panel was rendering a settings change. */
    const read = countingStub(project({ name: '另一个人改的名字' }));
    const write = countingStub(project());
    const client: DesktopClientStub = {
      getMontageProject: read.call,
      putMontageProject: write.call,
    };

    const { result } = renderDataHook(() => useSaveMontageProject(), { client });

    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'm-1',
        edit: (current) => ({ ...current, settings: { ...current.settings, quality: 90 } }),
      });
    });

    expect(read.calls()).toBe(1);
    const [, body] = write.lastArgs() as [string, MontageProjectRecord];
    /* The rename survived — the edit composed onto the fresh document instead
       of overwriting it with the copy this panel was holding. */
    expect(body.name).toBe('另一个人改的名字');
    expect(body.settings.quality).toBe(90);
  });

  it('forces the body id to match the path the route was given', async () => {
    const read = countingStub(project());
    const write = countingStub(project());
    const { result } = renderDataHook(() => useSaveMontageProject(), {
      client: {
        getMontageProject: read.call,
        putMontageProject: write.call,
      },
    });

    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'm-1',
        edit: (current) => ({ ...current, id: 'something-else' }),
      });
    });

    const [path, body] = write.lastArgs() as [string, MontageProjectRecord];
    expect(path).toBe('m-1');
    expect(body.id).toBe('m-1');
  });

  it('refuses the write when the document moved under the caller', async () => {
    const read = countingStub(project({ updated_at: '2026-08-15T09:41:00.000Z' }));
    const write = countingStub(project());
    const { result } = renderDataHook(() => useSaveMontageProject(), {
      client: {
        getMontageProject: read.call,
        putMontageProject: write.call,
      },
    });

    let caught: unknown = null;
    await act(async () => {
      await result.current
        .mutateAsync({
          projectId: 'm-1',
          edit: (current) => current,
          baseUpdatedAt: '2026-08-15T09:40:00.000Z',
        })
        .catch((error: unknown) => {
          caught = error;
        });
    });

    expect(isMontageWriteConflict(caught)).toBe(true);
    /* Nothing was written, and the fresh document rides along so the page can
       offer 「重新载入」 without a second round trip. */
    expect(write.calls()).toBe(0);
    expect(isMontageWriteConflict(caught) ? caught.current.updated_at : null).toBe(
      '2026-08-15T09:41:00.000Z',
    );
  });

  it('writes without the guard when the caller did not ask for one', async () => {
    const read = countingStub(project({ updated_at: '2026-08-15T09:41:00.000Z' }));
    const write = countingStub(project());
    const { result } = renderDataHook(() => useSaveMontageProject(), {
      client: {
        getMontageProject: read.call,
        putMontageProject: write.call,
      },
    });

    await act(async () => {
      await result.current.mutateAsync({ projectId: 'm-1', edit: (current) => current });
    });

    expect(write.calls()).toBe(1);
  });

  it('refreshes the document and the list, because the list prints the clip count', async () => {
    const read = countingStub(project());
    const write = countingStub(project({ updated_at: '2026-08-15T09:50:00.000Z' }));
    const { result, queryClient } = renderDataHook(() => useSaveMontageProject(), {
      client: {
        getMontageProject: read.call,
        putMontageProject: write.call,
      },
    });

    const invalidated = trackInvalidations(queryClient);
    await act(async () => {
      await result.current.mutateAsync({ projectId: 'm-1', edit: (current) => current });
    });

    expect(invalidated).toContainEqual([...qk.montage.detail('m-1')]);
    expect(invalidated).toContainEqual([...qk.montage.list()]);
    /* The answer is in the cache before the refetch lands, so the next
       `baseUpdatedAt` is already the new one. */
    expect(
      (queryClient.getQueryData(qk.montage.detail('m-1')) as MontageProjectRecord).updated_at,
    ).toBe('2026-08-15T09:50:00.000Z');
  });
});

/* ── beat suggestions ────────────────────────────────────────────────────── */

const DRAFT: BeatAlignmentDraft = {
  advisory_only: true,
  clips: [
    {
      clip_id: 'clip-a',
      timeline_start_seconds: 0,
      timeline_end_seconds: 40,
      planned_duration_seconds: 40,
      source_duration_seconds: 42,
      duration_change_ratio: 0.95,
      start_beat_index: 0,
      end_beat_index: 32,
      rationale: ['对齐段落起点'],
    },
  ],
  unplaced_clip_ids: [],
  constraints: [],
};

describe('useBeatAlignmentPreview', () => {
  it('writes nothing — the project is never read and never put', async () => {
    const align = countingStub(DRAFT);
    const read = countingStub(project());
    const write = countingStub(project());
    const { result } = renderDataHook(() => useBeatAlignmentPreview(), {
      client: {
        alignClipsToBeats: align.call,
        getMontageProject: read.call,
        putMontageProject: write.call,
      },
    });

    await act(async () => {
      await result.current.mutateAsync({
        beats: [],
        clips: [{ clip_id: 'clip-a', source_duration_seconds: 42 }],
        options: {
          timeline_start_seconds: 0,
          maximum_duration_change_ratio: 0.2,
          beats_per_phrase: 4,
          prefer_strong_boundaries: true,
        },
      });
    });

    expect(align.calls()).toBe(1);
    expect(read.calls()).toBe(0);
    expect(write.calls()).toBe(0);
    await waitFor(() => expect(result.current.data?.advisory_only).toBe(true));
  });
});

describe('useApplyBeatAlignment', () => {
  it('applies the caller’s transform through the same read-modify-write', async () => {
    const read = countingStub(project());
    const write = countingStub(project());
    const { result } = renderDataHook(() => useApplyBeatAlignment(), {
      client: {
        getMontageProject: read.call,
        putMontageProject: write.call,
      },
    });

    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'm-1',
        draft: DRAFT,
        clipIds: ['clip-a'],
        apply: (current, draft, clipIds) => ({
          ...current,
          clips: current.clips.map((clip) =>
            clipIds.includes(clip.clip_id)
              ? {
                ...clip,
                trim_end:
                    clip.trim_start
                    + (draft.clips[0]?.planned_duration_seconds ?? 0),
              }
              : clip,
          ),
        }),
      });
    });

    expect(read.calls()).toBe(1);
    const [, body] = write.lastArgs() as [string, MontageProjectRecord];
    expect(body.clips[0]?.trim_end).toBe(40);
  });
});

/* ── export ──────────────────────────────────────────────────────────────── */

describe('useExportMontageProject', () => {
  it('refreshes the job list, the task feed and the outputs — but not the project', async () => {
    const exportJob = countingStub({ job_id: 'job-7', status: 'queued' as const });
    const { result, queryClient } = renderDataHook(() => useExportMontageProject(), {
      client: {
        exportMontageProject: exportJob.call,
      },
    });

    const invalidated = trackInvalidations(queryClient);
    await act(async () => {
      await result.current.mutateAsync('m-1');
    });

    expect(invalidated).toContainEqual([...qk.montage.exports('m-1')]);
    expect(invalidated).toContainEqual([...qk.tasks.all]);
    expect(invalidated).toContainEqual([...qk.outputs.all]);
    expect(invalidated).not.toContainEqual([...qk.montage.detail('m-1')]);
  });
});

/* ── reads ───────────────────────────────────────────────────────────────── */

describe('useMontageProject', () => {
  it('reads nothing with no project — 「全部合辑」 is a state, not a loading one', () => {
    const read = countingStub(project());
    const { result } = renderDataHook(() => useMontageProject(null), {
      client: { getMontageProject: read.call },
    });

    expect(read.calls()).toBe(0);
    expect(result.current.isLoading).toBe(false);
  });

  it('forwards the abort signal so a fast switch cancels the previous read', async () => {
    const read = countingStub(project());
    const { result } = renderDataHook(() => useMontageProject('m-1'), {
      client: { getMontageProject: read.call },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(read.lastArgs()[0]).toBe('m-1');
    expect(read.lastArgs()[1]).toBeInstanceOf(AbortSignal);
  });
});
