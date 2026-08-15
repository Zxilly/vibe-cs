/**
 * data layer — player directory and profile reads (spec §2 `data/players.ts`).
 *
 * Feeds `/players` and `/players/:playerId` (§7). Reads only; the one write in
 * this area, `updatePlayerReviewMetadata`, belongs to phase 3d together with
 * the editor that calls it — its invalidation target is recorded on
 * `usePlayer` below.
 *
 * The paging arguments are `PageQuery` (`page` / `page_size`), copied from the
 * IPC signatures rather than renamed, so a page hands the same object to the
 * hook that the client will put on the query string.
 */

import { skipToken, useQuery, type QueryClient } from '@tanstack/react-query';

import { useDesktopClient } from './desktopClient';
import {
  qk,
  type PageQuery,
  type PlayerDirectoryQuery,
  type PlayerHeatmapQuery,
} from './keys';
import { resolveQueryTuning, type DataQueryTuning } from './queryTuning';

/**
 * One page of the player directory table.
 *
 * Invalidated by: an analysis run completing — it adds matches, which moves
 * every aggregate the table sorts on. That is a `qk.players.all`, not a
 * per-player, invalidation.
 */
export function usePlayerDirectory(query: PlayerDirectoryQuery, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.players.list(query),
    queryFn: ({ signal }) => client.listPlayers(query, signal),
    ...resolveQueryTuning(tuning),
  });
}

/**
 * One player's profile header and aggregate stats.
 *
 * Invalidated by: `updatePlayerReviewMetadata` (3d) → `invalidatePlayer`, and
 * by analysis completion → `invalidatePlayers`.
 */
export function usePlayer(steamId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.players.detail(steamId ?? ''),
    queryFn: steamId === null ? skipToken : ({ signal }) => client.getPlayer(steamId, signal),
    ...resolveQueryTuning(tuning, { enabled: steamId !== null }),
  });
}

/** The profile's match list. Below the player's detail key, so
 *  `invalidatePlayer` reaches it. */
export function usePlayerMatches(
  steamId: string | null,
  page: PageQuery,
  tuning: DataQueryTuning = {},
) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.players.matches(steamId ?? '', page),
    queryFn:
      steamId === null ? skipToken : ({ signal }) => client.listPlayerMatches(steamId, page, signal),
    ...resolveQueryTuning(tuning, { enabled: steamId !== null }),
  });
}

/** The profile's per-map breakdown. */
export function usePlayerMaps(
  steamId: string | null,
  page: PageQuery,
  tuning: DataQueryTuning = {},
) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.players.maps(steamId ?? '', page),
    queryFn:
      steamId === null ? skipToken : ({ signal }) => client.listPlayerMaps(steamId, page, signal),
    ...resolveQueryTuning(tuning, { enabled: steamId !== null }),
  });
}

/**
 * Kill / death positions for one player on one map, for `domain/map`'s
 * `HeatLayer`. The map name is part of the key, so switching maps is a cache
 * miss rather than a stale layer.
 */
export function usePlayerHeatmap(
  steamId: string | null,
  query: PlayerHeatmapQuery,
  tuning: DataQueryTuning = {},
) {
  const client = useDesktopClient();
  const ready = steamId !== null && query.map !== '';
  return useQuery({
    queryKey: qk.players.heatmap(steamId ?? '', query),
    queryFn:
      steamId === null || !ready
        ? skipToken
        : ({ signal }) => client.getPlayerHeatmap(steamId, query, signal),
    ...resolveQueryTuning(tuning, { enabled: ready }),
  });
}

/* ── invalidation ────────────────────────────────────────────────────────── */

/** Directory and every profile. Use after an analysis run completes. */
export function invalidatePlayers(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.players.all });
}

/** One profile, its matches, its maps and its heatmaps; the directory stays. */
export function invalidatePlayer(client: QueryClient, steamId: string): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.players.detail(steamId) });
}
