/**
 * `interaction` project — player directory and profile reads.
 *
 * No real IPC: the bridge is a typechecked stub through `DesktopClientProvider`
 * (see `demos.interaction.test.tsx` for the full rationale and the complete
 * success / failure / invalidation contract). What this file adds is the shape
 * peculiar to players — sub-resources hanging under one profile, so that
 * `invalidatePlayer` refreshes the profile *and* its matches while leaving the
 * directory alone.
 */

import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type {
  PlayerAggregateStats,
  PlayerDirectoryItem,
  PlayerDirectoryPage,
  PlayerMatchPage,
  PlayerProfile,
  PlayerProjectionCoverage,
  PlayerSteamProfile,
} from '../shared/desktop/dto';
import { dataErrorMessage } from './errors';
import {
  invalidatePlayer,
  invalidatePlayers,
  usePlayer,
  usePlayerDirectory,
  usePlayerHeatmap,
  usePlayerMatches,
} from './players';
import { countingStub, renderDataHook } from './test/renderDataHook';

const STATS: PlayerAggregateStats = {
  matches: 42,
  kills: 700,
  deaths: 620,
  assists: 130,
  headshots: 350,
  damage: 52_000,
  average_adr: 84.2,
  average_kill_death_ratio: 1.13,
};

const STEAM: PlayerSteamProfile = {
  state: 'not_configured',
  persona_name: null,
  real_name: null,
  profile_url: null,
  country_code: null,
  persona_state: null,
  last_logoff: null,
  created_at: null,
  avatar_url: null,
  reason: null,
};

const COVERAGE: PlayerProjectionCoverage = {
  projected_demos: 42,
  total_analyses: 42,
  projection_complete: true,
};

const PLAYER: PlayerDirectoryItem = {
  steam_id: '7656119',
  name: 'Kael',
  aliases: ['Kael'],
  aliases_total: 1,
  last_team: 'Aurora',
  last_match_date: '2026-08-01T18:00:00Z',
  last_cataloged_at: '2026-08-01T19:00:00Z',
  stats: STATS,
  steam: STEAM,
};

const DIRECTORY: PlayerDirectoryPage = {
  items: [PLAYER],
  total: 1,
  page: 1,
  page_size: 20,
  coverage: COVERAGE,
};

const PROFILE: PlayerProfile = { player: PLAYER, coverage: COVERAGE };

const MATCHES: PlayerMatchPage = {
  items: [],
  total: 0,
  page: 1,
  page_size: 20,
  steam_id: '7656119',
  coverage: COVERAGE,
};

describe('usePlayerDirectory', () => {
  it('resolves a sorted page and passes the sort through', async () => {
    const list = countingStub(DIRECTORY);
    const { result } = renderDataHook(
      () => usePlayerDirectory({ sort: 'adr', direction: 'desc', page: 1, page_size: 20 }),
      { client: { listPlayers: list.call } },
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.items[0]?.name).toBe('Kael');
    expect(list.lastArgs()[0]).toEqual({
      sort: 'adr',
      direction: 'desc',
      page: 1,
      page_size: 20,
    });
  });

  it('reports a failure instead of an empty table', async () => {
    const list = countingStub(DIRECTORY);
    list.fail(new Error('player projection unavailable'));

    const { result } = renderDataHook(
      () => usePlayerDirectory({ sort: 'player', direction: 'asc' }),
      { client: { listPlayers: list.call } },
    );

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.data).toBeUndefined();
    expect(dataErrorMessage(result.current.error)).toBe('player projection unavailable');
  });

  it('re-runs after invalidatePlayers — an analysis moves every aggregate', async () => {
    const list = countingStub(DIRECTORY);
    const { result, queryClient } = renderDataHook(
      () => usePlayerDirectory({ sort: 'player', direction: 'asc' }),
      { client: { listPlayers: list.call } },
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    await act(async () => {
      await invalidatePlayers(queryClient);
    });
    await waitFor(() => {
      expect(list.calls()).toBe(2);
    });
  });
});

describe('usePlayer + usePlayerMatches', () => {
  it('waits for a selected player before calling the bridge', () => {
    const profile = countingStub(PROFILE);
    const matches = countingStub(MATCHES);
    const { result } = renderDataHook(
      () => ({
        profile: usePlayer(null),
        matches: usePlayerMatches(null, { page: 1, page_size: 20 }),
      }),
      { client: { getPlayer: profile.call, listPlayerMatches: matches.call } },
    );

    expect(result.current.profile.fetchStatus).toBe('idle');
    expect(result.current.matches.fetchStatus).toBe('idle');
    expect(profile.calls()).toBe(0);
    expect(matches.calls()).toBe(0);
  });

  it('invalidatePlayer refreshes the profile and its matches together', async () => {
    const profile = countingStub(PROFILE);
    const matches = countingStub(MATCHES);
    const directory = countingStub(DIRECTORY);

    const { result, queryClient } = renderDataHook(
      () => ({
        profile: usePlayer('7656119'),
        matches: usePlayerMatches('7656119', { page: 1, page_size: 20 }),
        directory: usePlayerDirectory({ sort: 'player', direction: 'asc' }),
      }),
      {
        client: {
          getPlayer: profile.call,
          listPlayerMatches: matches.call,
          listPlayers: directory.call,
        },
      },
    );

    await waitFor(() => {
      expect(result.current.profile.isSuccess).toBe(true);
      expect(result.current.matches.isSuccess).toBe(true);
      expect(result.current.directory.isSuccess).toBe(true);
    });

    await act(async () => {
      await invalidatePlayer(queryClient, '7656119');
    });

    await waitFor(() => {
      expect(profile.calls()).toBe(2);
      expect(matches.calls()).toBe(2);
    });
    // The directory is a sibling of the detail key, not a descendant.
    expect(directory.calls()).toBe(1);
  });
});

describe('usePlayerHeatmap', () => {
  it('does not fetch until a map is chosen', () => {
    const heatmap = countingStub({
      steam_id: '7656119',
      map_name: 'de_mirage',
      points: [],
      total: 0,
      maximum_points: 5_000,
      complete: true,
      coverage: COVERAGE,
    });

    const { result } = renderDataHook(
      () => usePlayerHeatmap('7656119', { map: '', kind: 'all' }),
      { client: { getPlayerHeatmap: heatmap.call } },
    );

    expect(result.current.fetchStatus).toBe('idle');
    expect(heatmap.calls()).toBe(0);
  });

  it('re-fetches when the map changes, rather than showing the previous layer', async () => {
    const heatmap = countingStub({
      steam_id: '7656119',
      map_name: 'de_mirage',
      points: [],
      total: 0,
      maximum_points: 5_000,
      complete: true,
      coverage: COVERAGE,
    });

    let map = 'de_mirage';
    const { result, rerender } = renderDataHook(
      () => usePlayerHeatmap('7656119', { map, kind: 'all' }),
      { client: { getPlayerHeatmap: heatmap.call } },
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(heatmap.calls()).toBe(1);

    map = 'de_dust2';
    rerender();

    await waitFor(() => {
      expect(heatmap.calls()).toBe(2);
    });
    expect(heatmap.lastArgs()[1]).toEqual({ map: 'de_dust2', kind: 'all' });
  });
});
