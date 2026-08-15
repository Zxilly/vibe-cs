/**
 * data layer — application configuration and the environment probes that
 * depend on it (spec §2 `data/config.ts`).
 *
 * Feeds `/settings` (five sections, §7) and `/recovery`.
 *
 * ## Why this file has the round's only mutation
 *
 * The brief says writes wait for the phase that needs them, unless a read
 * cannot be explained without one. This is that case. `updateConfig` is a
 * single PUT that can change the CS2 path, the Steam credentials, the data
 * directory and the watched folders in one call, and each of those is read back
 * by a *different* query:
 *
 *   cs2_path / steam_path     → `useQuickCheck`   (dependency states)
 *   data_dir                  → `useStorageStatus`, `useRuntimeState`
 *   demo_watch_paths          → `useDemoWatchStatus`, and the demo list itself
 *   any of them               → `useHlaeStatus`   (resolved under the CS2 path)
 *
 * Documenting that chain in a comment and leaving the write to a later phase
 * would mean the settings page rediscovers it — and the failure mode is silent:
 * the save succeeds, the dependency row keeps showing the old state, and the
 * user is told the path is still missing. So the mutation ships with the reads,
 * and it is the only one.
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import type { AppConfig } from '../shared/desktop/dto';
import { useDesktopClient } from './desktopClient';
import { qk } from './keys';
import { resolveQueryTuning, type DataQueryTuning } from './queryTuning';

/** The whole config document. Settings edits it as a form draft, so this is
 *  read once per section mount and written back through `useUpdateAppConfig`. */
export function useAppConfig(tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.config.app(),
    queryFn: ({ signal }) => client.getConfig(signal),
    ...resolveQueryTuning(tuning),
  });
}

/** Dependency checks (「游戏就绪 / 缺失」) for the settings header and the
 *  workbench's readiness strip. */
export function useQuickCheck(tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.config.quickCheck(),
    queryFn: ({ signal }) => client.quickCheck(signal),
    ...resolveQueryTuning(tuning),
  });
}

/** Disk usage under the data directory — the 「占用统计」 of settings·文件. */
export function useStorageStatus(tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.config.storage(),
    queryFn: ({ signal }) => client.storageStatus(signal),
    ...resolveQueryTuning(tuning),
  });
}

/**
 * HLAE install state for settings·游戏.
 *
 * Invalidated by: `prepareManagedHlae` (3g) → `invalidateConfig`, and by a
 * config write that moves the CS2 path.
 */
export function useHlaeStatus(tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.config.hlae(),
    queryFn: ({ signal }) => client.getHlaeStatus(signal),
    ...resolveQueryTuning(tuning),
  });
}

/**
 * Whether the configuration needs recovering, for `/recovery`.
 *
 * Invalidated by: `recoverConfiguration` (3g), which must invalidate
 * `qk.config.all` — a restore replaces the config document itself, not just
 * this flag.
 */
export function useRecoveryStatus(tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.config.recovery(),
    queryFn: ({ signal }) => client.recoveryStatus(signal),
    ...resolveQueryTuning(tuning),
  });
}

/**
 * Runtime state: version, data directory, the active recording job id and the
 * playback session. Distinct from the health probe — health answers 「服务在不
 * 在」 and is excluded from the recovery invalidation; this answers 「服务现在
 * 在做什么」 and must refresh when the service comes back, which is why it lives
 * under `config` and not under `service` (see `keys.ts`).
 */
export function useRuntimeState(tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.config.runtime(),
    queryFn: ({ signal }) => client.runtimeState(signal),
    ...resolveQueryTuning(tuning),
  });
}

/* ── the one write ───────────────────────────────────────────────────────── */

/**
 * Saves the config document and refreshes everything derived from it.
 *
 * Both invalidations are awaited inside `onSuccess`, so the mutation stays
 * pending until the dependent reads have been marked stale. Settings·应用 shows
 * 「保存成功后才切换，不会切到一半」 (§5.2) off exactly this: the language does
 * not change while the write is still settling.
 */
export function useUpdateAppConfig() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (config: AppConfig) => client.updateConfig(config),
    onSuccess: async () => {
      await Promise.all([
        invalidateConfig(queryClient),
        // `demo_watch_paths` lives in the same document; a saved path change
        // must show up in the library without a manual rescan.
        queryClient.invalidateQueries({ queryKey: qk.demos.all }),
      ]);
    },
  });
}

/* ── invalidation ────────────────────────────────────────────────────────── */

/** The config document and every probe derived from it. */
export function invalidateConfig(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.config.all });
}
