/*
 * pages/match/views — the arithmetic behind 玩家 (`?view=players`).
 *
 * Pure and React-free, so `playersModel.test.ts` runs it in the `unit` project.
 *
 * ── 单场记分板, not a cross-match profile ───────────────────────────────────
 *
 * `/players/:id` answers 「这名选手一贯怎么打」 from `PlayerAggregateStats`. This
 * view answers 「这一场他打成什么样」 from `AnalysisWorkspace.players`, which is a
 * different record with different fields — and §10.4 gap 13's missing columns
 * (首杀 / 残局胜率 / 常用地图) are a statement about the *aggregate*, not about
 * this one. What is missing here is listed below on its own terms.
 *
 * ── What this file will not invent ────────────────────────────────────────
 *
 *   · **命中率.** 「AK-47 16 杀 · 命中 34%」 on the artboard needs shots fired;
 *     `TimelineEvent` has no weapon-fire event (`data/match.ts` gap 3). The
 *     weapon breakdown therefore counts kills and stops there.
 *   · **残局.** The 03 artboard's 「残局 3 / 5」 is won-over-attempted. Nothing on
 *     the wire records a clutch *attempt*; the highlight detector emits a
 *     `clutch` highlight for the ones it recognised, which is a different
 *     denominator. The column is dropped rather than filled with the numerator
 *     twice.
 *   · **首杀 out of nothing.** 首杀 / 首死 are derived from the round event
 *     stream (`duelsModel.openingDuels`). When the analysis carries no kill
 *     events the columns are `null` and the view omits them — 「没有事件流」 is
 *     not 「零次首杀」.
 */

import type {
  AnalysisWorkspace,
  Highlight,
  RoundSummary,
} from '../../../shared/desktop/viewModels';
import { TICK_GROUP_SEPARATOR, type HighlightKind } from '../../../domain/match';
import { hasKillEvents, openingDuels, openingTallies } from './duelsModel';

/* ── formatting ──────────────────────────────────────────────────────────── */

/**
 * The glyph for 「这个数不存在」, and the two formatters the three sibling views
 * share.
 *
 * Page-local by the same convention `pages/players/playerStats.ts` and
 * `pages/library/libraryFormat.ts` follow: no page imports another page's
 * module, and the numbers a screen prints are that screen's policy. Fixed-point
 * rather than `Intl` for the reason `playerStats` records — these columns are
 * mono and a locale that regroups digits makes them ragged between rows.
 */
export const NO_VALUE = '—';

export function formatFixed(value: number | null | undefined, digits: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  return value.toFixed(digits);
}

/** 「62%」 from a fraction in [0, 1]; whole percents, as every artboard prints. */
export function formatPercent(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return NO_VALUE;
  return `${String(Math.round(fraction * 100))}%`;
}

/**
 * 「1 246」 — a thin space every three digits, matching the artboard's tiles.
 *
 * The separator is `domain/match`'s `TICK_GROUP_SEPARATOR` rather than a space
 * typed here: `formatTickCount` already groups digits for the mono tick column,
 * and two grouped numbers side by side must not differ by a code point.
 */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  return String(Math.trunc(value)).replace(GROUP_BOUNDARY, TICK_GROUP_SEPARATOR);
}

/** Every position where a thousands separator belongs. */
const GROUP_BOUNDARY = /\B(?=(?:\d{3})+(?!\d))/gu;

/* ── the scoreboard ──────────────────────────────────────────────────────── */

export interface ScoreboardRow {
  readonly id: string;
  readonly name: string;
  readonly team: 'A' | 'B';
  /** 「Aurora」 — the team's own name, which the row prints instead of A / B. */
  readonly teamName: string;
  readonly kills: number;
  readonly deaths: number;
  readonly assists: number;
  readonly killDeathRatio: number;
  readonly adr: number;
  readonly headshotRate: number;
  /** `null` when the analysis carries no kill events at all. */
  readonly openingKills: number | null;
  readonly openingDeaths: number | null;
  readonly highlights: number;
}

/**
 * 「Aurora」/「Meridian」 by side letter.
 *
 * `AnalysisWorkspace.teams` is positional — index 0 is A — which is the same
 * assumption `pages/match/matchModel.ts` makes for the context bar's two lines.
 * An empty string rather than 「队伍 A」 when the analysis has no name: the
 * caller decides what to draw for an unnamed team, and inventing one here would
 * put a different label in the table than in the bar above it.
 */
export function teamNames(analysis: AnalysisWorkspace | undefined): {
  readonly A: string;
  readonly B: string;
} {
  const [a, b] = analysis?.teams ?? [];
  return { A: a?.name.trim() ?? '', B: b?.name.trim() ?? '' };
}

/**
 * The rows, in the artboard's order: team A then team B, most kills first
 * inside each. A `sort` from the table header replaces that order entirely —
 * a sorted scoreboard is a ranking across both sides, which is the question the
 * user asked by clicking the header.
 */
export function scoreboardRows(analysis: AnalysisWorkspace | undefined): readonly ScoreboardRow[] {
  if (analysis === undefined) return [];

  const names = teamNames(analysis);
  const events = hasKillEvents(analysis.rounds);
  const tallies = openingTallies(openingDuels(analysis.rounds));
  const highlights = new Map<string, number>();
  for (const highlight of analysis.highlights) {
    highlights.set(highlight.player_id, (highlights.get(highlight.player_id) ?? 0) + 1);
  }

  return analysis.players
    .map((player) => {
      const tally = tallies.get(player.id);
      return {
        id: player.id,
        name: player.name,
        team: player.team,
        teamName: player.team === 'A' ? names.A : names.B,
        kills: player.kills,
        deaths: player.deaths,
        assists: player.assists,
        killDeathRatio: player.kill_death_ratio,
        adr: player.adr,
        headshotRate: player.headshot_rate,
        openingKills: events ? (tally?.kills ?? 0) : null,
        openingDeaths: events ? (tally?.deaths ?? 0) : null,
        highlights: highlights.get(player.id) ?? 0,
      };
    })
    .sort(
      (left, right) =>
        left.team.localeCompare(right.team) ||
        right.kills - left.kills ||
        left.name.localeCompare(right.name),
    );
}

/** The sortable columns of the scoreboard, spelled once for the table and the test. */
export const SCOREBOARD_SORT_IDS = [
  'name',
  'kills',
  'deaths',
  'assists',
  'kd',
  'adr',
  'headshot',
  'opening',
  'highlights',
] as const;

export type ScoreboardSortId = (typeof SCOREBOARD_SORT_IDS)[number];

function sortValue(row: ScoreboardRow, id: ScoreboardSortId): number | string {
  switch (id) {
    case 'name':
      return row.name;
    case 'kills':
      return row.kills;
    case 'deaths':
      return row.deaths;
    case 'assists':
      return row.assists;
    case 'kd':
      return row.killDeathRatio;
    case 'adr':
      return row.adr;
    case 'headshot':
      return row.headshotRate;
    case 'opening':
      return row.openingKills ?? -1;
    case 'highlights':
      return row.highlights;
  }
}

/**
 * Sorts a copy. `null` leaves the natural team-then-kills order alone, which is
 * what the table shows before anyone touches a header.
 */
export function sortScoreboardRows(
  rows: readonly ScoreboardRow[],
  /* Structurally `design/data`'s `SortState`, spelled out so this module stays
     React- and design-layer-free and runs in the `unit` project. */
  sort: { readonly columnId: string; readonly direction: 'asc' | 'desc' } | null,
): readonly ScoreboardRow[] {
  if (sort === null) return rows;
  const id = SCOREBOARD_SORT_IDS.find((candidate) => candidate === sort.columnId);
  if (id === undefined) return rows;

  const sign = sort.direction === 'asc' ? 1 : -1;
  return rows.slice().sort((left, right) => {
    const a = sortValue(left, id);
    const b = sortValue(right, id);
    const order = typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b) : Number(a) - Number(b);
    return order * sign || left.name.localeCompare(right.name);
  });
}

/* ── one player's weapons ────────────────────────────────────────────────── */

export interface WeaponKills {
  /** As the demo spells it — `ak47`, `deagle`. Rendered verbatim. */
  readonly weapon: string;
  readonly kills: number;
}

export interface WeaponBreakdown {
  readonly entries: readonly WeaponKills[];
  /** Kills the tail beyond `limit` accounts for — the artboard's 「其他」 row. */
  readonly other: number;
  readonly total: number;
}

/**
 * Kills per weapon for one player, most first, with the tail folded into
 * 「其他」 exactly as the artboard draws it.
 *
 * `null` — not an empty breakdown — when the analysis carries no kill events,
 * so the view can say 「这份分析没有事件流」 instead of drawing an empty panel
 * that reads as 「他没有击杀」.
 */
export function weaponBreakdown(
  rounds: readonly RoundSummary[],
  playerId: string,
  limit: number,
): WeaponBreakdown | null {
  if (!hasKillEvents(rounds)) return null;

  const counts = new Map<string, number>();
  let total = 0;
  for (const round of rounds) {
    for (const event of round.events) {
      if (event.kind !== 'kill' || event.actor !== playerId) continue;
      const weapon = event.weapon === null || event.weapon.trim() === '' ? NO_VALUE : event.weapon;
      counts.set(weapon, (counts.get(weapon) ?? 0) + 1);
      total += 1;
    }
  }

  const ordered = [...counts.entries()]
    .map(([weapon, kills]) => ({ weapon, kills }))
    .sort((left, right) => right.kills - left.kills || left.weapon.localeCompare(right.weapon));

  const entries = ordered.slice(0, Math.max(0, limit));
  const other = ordered.slice(Math.max(0, limit)).reduce((sum, entry) => sum + entry.kills, 0);
  return { entries, other, total };
}

/* ── one player's highlights ─────────────────────────────────────────────── */

/**
 * Wire kind → the `domain/match` vocabulary the `HighlightRow` tag speaks.
 *
 * A `Record` over the wire union rather than a switch, so a new detector kind
 * fails to compile here instead of rendering an untagged row. `one_tap` folds
 * onto 爆头 because that is what a one-tap is; `knife` / `taser` / `defuse` /
 * `fail` / `timeline` have no member of their own and become 其他 rather than
 * borrowing a label that would misdescribe them.
 */
const HIGHLIGHT_KIND_OF: Readonly<Record<Highlight['kind'], HighlightKind>> = {
  multi_kill: 'multi-kill',
  clutch: 'clutch',
  one_tap: 'headshot',
  wallbang: 'wallbang',
  no_scope: 'no-scope',
  knife: 'other',
  taser: 'other',
  defuse: 'other',
  fail: 'other',
  timeline: 'other',
};

export function highlightKindOf(kind: Highlight['kind']): HighlightKind {
  return HIGHLIGHT_KIND_OF[kind];
}

/** This match's highlights for one player, earliest round first. */
export function playerHighlights(
  analysis: AnalysisWorkspace | undefined,
  playerId: string,
): readonly Highlight[] {
  return (analysis?.highlights ?? [])
    .filter((highlight) => highlight.player_id === playerId)
    .slice()
    .sort((left, right) => left.round - right.round || left.start_tick - right.start_tick);
}
