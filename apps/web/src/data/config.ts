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

/* ── the watched folders ─────────────────────────────────────────────────── */

/**
 * 「添加监听目录」 / 「停止监听」.
 *
 * The watched folders are a field of the config document (`demo_watch_paths`),
 * so the write is the same `updateConfig` PUT — which is why this hook lives
 * here and not in `demos.ts` even though the library is the page that calls it.
 *
 * The whole document is taken as an argument rather than read out of the cache:
 * `updateConfig` replaces the document, so a hook that fetched its own copy
 * could overwrite an edit the caller had already made. The library page holds
 * the config it rendered the list from, and hands that same object back.
 *
 * Invalidation is `useUpdateAppConfig`'s, for the same reason — a watch path
 * change is read back by `useAppConfig`, `useDemoWatchStatus` *and* the demo
 * list — so it delegates rather than restating the chain.
 */
export function useSetDemoWatchPaths() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ config, paths }: { config: AppConfig; paths: readonly string[] }) =>
      client.updateConfig({ ...config, demo_watch_paths: [...paths] }),
    onSuccess: async () => {
      await Promise.all([
        invalidateConfig(queryClient),
        queryClient.invalidateQueries({ queryKey: qk.demos.all }),
      ]);
    },
  });
}

/**
 * Whether `path` may join `existing`.
 *
 * Pure, and exported, because the 「添加监听目录」 dialog has to disable its
 * confirm button on the same answer it would otherwise only discover after the
 * round trip. 「不接受符号链接根目录」 from the artboard is *not* checked here:
 * the renderer cannot resolve a symlink, and the service rejects it — the
 * dialog states the rule and the service enforces it.
 */
export type WatchPathRejection = 'empty' | 'duplicate';

export function rejectWatchPath(
  path: string,
  existing: readonly string[],
): WatchPathRejection | null {
  const trimmed = path.trim();
  if (trimmed === '') return 'empty';
  // Windows paths differ only by case and by a trailing separator; two entries
  // that name one folder would make 「停止监听」 remove the wrong row.
  const normalised = normaliseWatchPath(trimmed);
  return existing.some((entry) => normaliseWatchPath(entry) === normalised) ? 'duplicate' : null;
}

function normaliseWatchPath(path: string): string {
  return path.trim().replaceAll('\\', '/').replace(/\/+$/u, '').toLowerCase();
}

/* ── invalidation ────────────────────────────────────────────────────────── */

/** The config document and every probe derived from it. */
export function invalidateConfig(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.config.all });
}
