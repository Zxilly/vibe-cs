/*
 * `interaction` project — 「08」's data layer.
 *
 * Three things are proved here, and the first is proved by what is *not*
 * called:
 *
 *   1. §4.5.3 rule ① — nothing readable starts a recording. Every read in this
 *      file is rendered against a stub that logs `executeRecordingPlan`, and
 *      the assertion is that the log stays empty.
 *   2. The check list disappears the moment the shots move (invariant 3 of
 *      `pages/recording/recordingContract.ts`), rather than going quietly stale.
 *   3. Starting a recording refreshes the task feed **and** the output list.
 *      That pair is the one 「录完了『最近输出』还是空的」 depends on.
 */

import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type {
  RecordingPlanResponse,
  RecordingPreflight,
  RecordingShotPresetDraft,
} from '../shared/desktop/dto';
import type { DesktopClientStub } from './desktopClient';
import { qk } from './keys';
import {
  confirmRecordingStart,
  useCreateRecordingShotPreset,
  useDemoPlaybackStatus,
  useExecuteRecordingPlan,
  usePlanRecordingFromAgentPlan,
  useRecordingPreflight,
  useRecordingShotPresets,
} from './recording';
import { countingStub, renderDataHook } from './test/renderDataHook';

const PREFLIGHT_OK: RecordingPreflight = {
  checks: [
    { code: 'game_ready', state: 'ok', detail: 'cs2.exe', affected_item_ids: [] },
    {
      code: 'camera_collision_unverified',
      state: 'warning',
      detail: '1 observer shot',
      affected_item_ids: ['item-2'],
    },
  ],
  blocking: 0,
};

const PREFLIGHT_BLOCKED: RecordingPreflight = {
  checks: [
    {
      code: 'output_directory_writable',
      state: 'blocked',
      detail: '0 bytes available',
      affected_item_ids: [],
    },
  ],
  blocking: 1,
};

const PRESET_DRAFT: RecordingShotPresetDraft = {
  name: '我的 POV 参数',
  camera_style: 'pov',
  victim_pov: false,
  pre_roll_seconds: 1.5,
  post_roll_seconds: 1,
  presentation: {
    camera_fov: 110,
    viewmodel_fov: 60,
    flash_alpha: 102,
    show_hud: true,
    show_radar: true,
    voice: 'all_players',
  },
};

/* ── §4.5.3 rule ① ───────────────────────────────────────────────────────── */

describe('nothing readable can start a recording', () => {
  it('leaves executeRecordingPlan untouched while every read of this page runs', async () => {
    const execute = countingStub({ job_id: 'job-1', status: 'queued' as const });
    const presets = countingStub({ items: [] });
    const playback = countingStub({
      executable_available: true,
      executable: null,
      gsi_installed: true,
      gsi_fresh: true,
      gsi_sequence: 1,
      gsi_received_at: null,
      map_name: null,
      map_phase: null,
      player_name: null,
      player_activity: null,
      ready_to_launch: true,
      gsi_ready: true,
      warnings: [],
    });
    const client: DesktopClientStub = {
      executeRecordingPlan: execute.call,
      listRecordingShotPresets: presets.call,
      playbackStatus: playback.call,
    };

    const { result } = renderDataHook(
      () => ({
        presets: useRecordingShotPresets(),
        playback: useDemoPlaybackStatus(),
        /* The check list is mounted but never run — mounting must not probe. */
        preflight: useRecordingPreflight('plan-1', 'sig'),
      }),
      { client },
    );

    await waitFor(() => expect(result.current.presets.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.playback.isSuccess).toBe(true));

    expect(execute.calls()).toBe(0);
    expect(result.current.preflight.status).toBe('idle');
    expect(result.current.preflight.canStart).toBe(false);
  });
});

/* ── the check list ──────────────────────────────────────────────────────── */

describe('useRecordingPreflight', () => {
  it('does not probe until it is asked to', async () => {
    const preflight = countingStub(PREFLIGHT_OK);
    const { result } = renderDataHook(() => useRecordingPreflight('plan-1', 'sig-a'), {
      client: { preflightRecordingPlan: preflight.call },
    });

    expect(preflight.calls()).toBe(0);
    act(() => result.current.run());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(preflight.calls()).toBe(1);
    expect(result.current.canStart).toBe(true);
  });

  it('blocks the start while any row is blocked, and never on a warning alone', async () => {
    const preflight = countingStub(PREFLIGHT_BLOCKED);
    const { result } = renderDataHook(() => useRecordingPreflight('plan-1', 'sig-a'), {
      client: { preflightRecordingPlan: preflight.call },
    });

    act(() => result.current.run());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.canStart).toBe(false);
    /* The same answer with the warning row and no blocked one does start. */
    preflight.succeed(PREFLIGHT_OK);
    act(() => result.current.run());
    await waitFor(() => expect(result.current.canStart).toBe(true));
  });

  it('forgets the answer the moment the shots move', async () => {
    const preflight = countingStub(PREFLIGHT_OK);
    let signature = 'sig-a';
    const { result, rerender } = renderDataHook(
      () => useRecordingPreflight('plan-1', signature),
      { client: { preflightRecordingPlan: preflight.call } },
    );

    act(() => result.current.run());
    await waitFor(() => expect(result.current.canStart).toBe(true));

    signature = 'sig-b';
    rerender();

    expect(result.current.status).toBe('idle');
    expect(result.current.result).toBeNull();
    expect(result.current.canStart).toBe(false);
    /* And it did not silently re-probe: a check list costs a disk sweep. */
    expect(preflight.calls()).toBe(1);
  });

  it('forgets it for a new plan id too', async () => {
    const preflight = countingStub(PREFLIGHT_OK);
    let planId = 'plan-1';
    const { result, rerender } = renderDataHook(() => useRecordingPreflight(planId, 'sig-a'), {
      client: { preflightRecordingPlan: preflight.call },
    });

    act(() => result.current.run());
    await waitFor(() => expect(result.current.canStart).toBe(true));

    planId = 'plan-2';
    rerender();
    expect(result.current.canStart).toBe(false);
  });

  it('scopes a failure the same way it scopes a success', async () => {
    const preflight = countingStub(PREFLIGHT_OK);
    preflight.fail(new Error('encoder probe failed'));
    let signature = 'sig-a';
    const { result, rerender } = renderDataHook(
      () => useRecordingPreflight('plan-1', signature),
      { client: { preflightRecordingPlan: preflight.call } },
    );

    act(() => result.current.run());
    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current.canStart).toBe(false);

    signature = 'sig-b';
    rerender();
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('does nothing at all with no plan id', () => {
    const preflight = countingStub(PREFLIGHT_OK);
    const { result } = renderDataHook(() => useRecordingPreflight(null, 'sig'), {
      client: { preflightRecordingPlan: preflight.call },
    });

    act(() => result.current.run());
    expect(preflight.calls()).toBe(0);
  });
});

/* ── starting ────────────────────────────────────────────────────────────── */

describe('useExecuteRecordingPlan', () => {
  it('needs a confirmation value nothing but the confirm button can mint', async () => {
    const execute = countingStub({ job_id: 'job-1', status: 'queued' as const });
    const { result } = renderDataHook(() => useExecuteRecordingPlan(), {
      client: { executeRecordingPlan: execute.call },
    });

    await act(async () => {
      await result.current.mutateAsync(
        confirmRecordingStart({ planId: 'plan-1', offlineInsecureAcknowledged: true }),
      );
    });

    expect(execute.calls()).toBe(1);
    expect(execute.lastArgs()).toEqual(['plan-1', true]);
  });

  it('refreshes the task feed and the output list together', async () => {
    const execute = countingStub({ job_id: 'job-1', status: 'queued' as const });
    const { result, queryClient } = renderDataHook(() => useExecuteRecordingPlan(), {
      client: { executeRecordingPlan: execute.call },
    });

    const invalidated: unknown[][] = [];
    const original = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = (filters?: { queryKey?: readonly unknown[] }) => {
      if (filters?.queryKey) invalidated.push([...filters.queryKey]);
      return original(filters as never);
    };

    await act(async () => {
      await result.current.mutateAsync(
        confirmRecordingStart({ planId: 'plan-1', offlineInsecureAcknowledged: false }),
      );
    });

    expect(invalidated).toContainEqual([...qk.tasks.all]);
    expect(invalidated).toContainEqual([...qk.outputs.all]);
    expect(invalidated).toContainEqual([...qk.config.all]);
  });
});

/* ── the two doors onto a plan ───────────────────────────────────────────── */

describe('usePlanRecordingFromAgentPlan', () => {
  it('hands the 422 through untouched — the page reads the code, not the body', async () => {
    const plan = countingStub<RecordingPlanResponse>({
      plan_id: 'never',
      expires_at: '2026-08-15T09:45:00.000Z',
      active_items: 0,
      disabled_items: 0,
      estimated_seconds: null,
      warnings: [],
      items: [],
      director: {
        shots: [],
        warnings: [],
        source_item_count: 0,
        merged_item_count: 0,
        victim_reaction_count: 0,
        unresolved_victim_requests: 0,
      },
    });
    plan.fail({ status: 422, code: 'agent_plan_shots_unbound', message: '2 of 4' });
    const { result } = renderDataHook(() => usePlanRecordingFromAgentPlan(), {
      client: { planRecordingFromAgentPlan: plan.call },
    });

    await act(async () => {
      await result.current.mutateAsync('P-118').catch(() => undefined);
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as { code?: string }).code).toBe('agent_plan_shots_unbound');
  });
});

/* ── presets ─────────────────────────────────────────────────────────────── */

describe('shot presets', () => {
  it('refreshes only the preset catalogue', async () => {
    const presets = countingStub({ items: [] });
    const create = countingStub({
      id: 'preset-1',
      ...PRESET_DRAFT,
      created_at: '2026-08-15T09:00:00.000Z',
      updated_at: '2026-08-15T09:00:00.000Z',
    });

    const { result, queryClient } = renderDataHook(
      () => ({
        list: useRecordingShotPresets(),
        create: useCreateRecordingShotPreset(),
      }),
      {
        client: {
          listRecordingShotPresets: presets.call,
          createRecordingShotPreset: create.call,
        },
      },
    );

    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    expect(presets.calls()).toBe(1);

    const invalidated: unknown[][] = [];
    const original = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = (filters?: { queryKey?: readonly unknown[] }) => {
      if (filters?.queryKey) invalidated.push([...filters.queryKey]);
      return original(filters as never);
    };

    await act(async () => {
      await result.current.create.mutateAsync(PRESET_DRAFT);
    });

    expect(invalidated).toEqual([[...qk.recording.shotPresets()]]);
    await waitFor(() => expect(presets.calls()).toBe(2));
  });
});
