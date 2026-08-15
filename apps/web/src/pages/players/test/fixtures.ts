/*
 * Test fixtures for `pages/players`.
 *
 * Under `test/` so `lingui.config.ts` keeps the fixture copy out of the message
 * catalogue. Names and numbers are the artboard's where it prints them —
 * 「Kael · Aurora · 64 场 · K/D 1.42 · ADR 89.7 · HS 57%」 — so a test failure
 * can be compared against a drawing.
 */

import type {
  PlayerDirectoryItem,
  PlayerHeatmap,
  PlayerHeatmapPoint,
  PlayerMapItem,
  PlayerMatch,
  PlayerSteamProfile,
} from '../../../shared/desktop/dto';

const NO_STEAM: PlayerSteamProfile = {
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

export function directoryItem(overrides: Partial<PlayerDirectoryItem> = {}): PlayerDirectoryItem {
  return {
    steam_id: 'STEAM_KAEL',
    name: 'Kael',
    aliases: ['kael', 'k43l', 'Kael.'],
    aliases_total: 3,
    last_team: 'Aurora',
    last_match_date: '2026-08-14T20:11:00Z',
    last_cataloged_at: '2026-08-14T21:00:00Z',
    stats: {
      matches: 64,
      kills: 1420,
      deaths: 1000,
      assists: 240,
      headshots: 809,
      damage: 91_000,
      average_adr: 89.7,
      average_kill_death_ratio: 1.42,
    },
    steam: NO_STEAM,
    ...overrides,
  };
}

/** `count` distinct rows, K/D descending, so a table renders the artboard's
 *  ordering without the test having to sort. */
export function directoryItems(count: number): PlayerDirectoryItem[] {
  return Array.from({ length: count }, (_, index) =>
    directoryItem({
      steam_id: `STEAM_${String(index)}`,
      name: `Kael-${String(index)}`,
      last_team: index % 2 === 0 ? 'Aurora' : 'Meridian',
      stats: {
        matches: 64 - (index % 10),
        kills: 1420 - index,
        deaths: 1000 + index,
        assists: 240,
        headshots: 800 - index,
        damage: 91_000,
        average_adr: 89.7 - index * 0.1,
        average_kill_death_ratio: 1.42 - index * 0.001,
      },
    }),
  );
}

export function playerMatch(overrides: Partial<PlayerMatch> = {}): PlayerMatch {
  return {
    demo_id: 'aurora',
    demo_name: 'Aurora vs Meridian',
    map_name: 'de_mirage',
    match_date: '2026-08-14T20:11:00Z',
    cataloged_at: '2026-08-14T21:00:00Z',
    team: 'Aurora',
    kills: 27,
    deaths: 14,
    assists: 5,
    headshots: 15,
    damage: 1400,
    adr: 95.2,
    kill_death_ratio: 1.93,
    ...overrides,
  };
}

/** Newest first, as `listPlayerMatches` answers. */
export function playerMatches(count: number): PlayerMatch[] {
  return Array.from({ length: count }, (_, index) =>
    playerMatch({
      demo_id: `demo-${String(index)}`,
      demo_name: `Aurora vs Meridian ${String(index)}`,
      kill_death_ratio: 1.9 - index * 0.05,
      adr: 95 - index,
      kills: 27 - index,
      headshots: 15 - Math.floor(index / 2),
    }),
  );
}

export function playerMapItem(overrides: Partial<PlayerMapItem> = {}): PlayerMapItem {
  return {
    map_name: 'de_mirage',
    stats: {
      matches: 21,
      kills: 480,
      deaths: 304,
      assists: 70,
      headshots: 274,
      damage: 30_000,
      average_adr: 95.2,
      average_kill_death_ratio: 1.58,
    },
    ...overrides,
  };
}

/**
 * `count` positions inside `de_mirage`'s world extent.
 *
 * `mapCalibration`'s checked-in `de_mirage` entry is pos_x −3230 / pos_y 1713 /
 * scale 5 over a 1024px overview, i.e. x ∈ [−3230, 1890] and y ∈ [−3407, 1713].
 * The walk stays inside that box so every sample lands on the artwork and the
 * binning drops none of them — a fixture that silently fell off the map would
 * make a bin-count assertion meaningless.
 */
export function heatmapPoints(count: number): PlayerHeatmapPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    demo_id: 'aurora',
    evidence_id: `demo:aurora/event:e-${String(index)}`,
    round: (index % 24) + 1,
    tick: 100_000 + index * 137,
    kind: index % 2 === 0 ? ('kills' as const) : ('deaths' as const),
    x: -3230 + ((index * 37) % 5120),
    y: -3407 + ((index * 61) % 5120),
    floor: 0,
    analysis_href: '/demos/aurora/analysis',
    replay_href: '/demos/aurora/replay',
  }));
}

export function playerHeatmap(overrides: Partial<PlayerHeatmap> = {}): PlayerHeatmap {
  const points = heatmapPoints(200);
  return {
    steam_id: 'STEAM_KAEL',
    map_name: 'de_mirage',
    points,
    total: points.length,
    maximum_points: 5000,
    complete: true,
    coverage: { projected_demos: 21, total_analyses: 21, projection_complete: true },
    ...overrides,
  };
}
