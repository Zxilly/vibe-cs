/**
 * data layer — player directory and profile reads (spec §2 `data/players.ts`).
 *
 * Feeds `/players` and `/players/:playerId` (§7). Reads only; the one write in
 * this area, `updatePlayerReviewMetadata`, is still not here because
 * `DesktopClient` (`desktopClient.tsx`) does not list it and widening that
 * `Pick` means editing a file phase 3d does not own. Its invalidation target is
 * recorded on `usePlayer` below so the hook is a two-line addition once the
 * seam is widened.
 *
 * The paging arguments are `PageQuery` (`page` / `page_size`), copied from the
 * IPC signatures rather than renamed, so a page hands the same object to the
 * hook that the client will put on the query string.
 *
 * ## The heat map is capped, not aggregated (spec §10.3 gap 7)
 *
 * `getPlayerHeatmap` answers with *raw* points — `PlayerHeatmapPoint[]` — and
 * caps them server-side at `MAXIMUM_PLAYER_HEATMAP_POINTS`
 * (`crates/application/src/routes/players.rs:353`, 5 000). There is no
 * server-side binning, so the aggregation §10.3 asked for still does not exist;
 * what does exist is a ceiling low enough that one linear pass through
 * `domain/map`'s `binWorldSamples` is cheap, and a `complete` flag that says
 * whether the ceiling was hit. `heatmapTruncation` below turns that flag into
 * the two numbers a page has to print, because a heat map drawn from a
 * truncated sample and presented as the whole picture is exactly the
 * 「编造没有数据的区域」 the product forbids.
 */

import { skipToken, useQuery, type QueryClient } from '@tanstack/react-query';

import type { PlayerHeatmap } from '../shared/desktop/dto';
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

/* ── how much of the heat map came back ──────────────────────────────────── */

/**
 * What the response says about its own completeness.
 *
 * `total` is how many positions the player actually has on this map; `shown` is
 * how many the service was willing to send. When they differ the picture is a
 * sample and the page has to say which sample it is — the legend of 「04」 names
 * its own denominator (「覆盖 12 场比赛」) for the same reason.
 */
export interface HeatmapTruncation {
  readonly truncated: boolean;
  /** Points in the response — what the picture is drawn from. */
  readonly shown: number;
  /** Points the service holds for this player and map. */
  readonly total: number;
  /** The server-side ceiling that produced the cut, as the response reports it. */
  readonly limit: number;
}

/**
 * Pure, so `players.test.ts` can walk it without a query client.
 *
 * `complete` is trusted over comparing `points.length` with `total`: the two
 * can also differ because a point failed to project, and only the service knows
 * which of the two happened.
 */
export function heatmapTruncation(heatmap: PlayerHeatmap): HeatmapTruncation {
  return {
    truncated: !heatmap.complete,
    shown: heatmap.points.length,
    total: heatmap.total,
    limit: heatmap.maximum_points,
  };
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
