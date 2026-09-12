/** Per-player utility and per-side purchase projections.
 * Freeze-end equipment values are projected independently in equipmentModel. */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

import type {
  AnalysisInsightsRecord,
  CountedItemRecord,
  InsightCapabilityRecord,
  PlayerUtilityInsightRecord,
  TeamPurchaseInsightRecord,
} from '../../../../shared/desktop/dto';
import type { RoundSummary } from '../../../../shared/desktop/viewModels';
import type { RosterEntry } from './duelsModel';

/* ── the item vocabulary ─────────────────────────────────────────────────── */

/**
 * The five grenades, plus 其他 for anything the demo spelled differently.
 *
 * The wire names are the service's `normalized_item_name` output — the weapon
 * name lowercased with `weapon_` stripped — so `flashbang`, `smokegrenade`,
 * `hegrenade`, `decoy`, and the three spellings the fire grenade travels under
 * (`molotov`, `incgrenade`, `inferno`, the last being the burning-area entity
 * the service falls back to). Anything unrecognised keeps its raw name rather
 * than being folded into 其他, because an unfamiliar name is information and
 * 其他 is not.
 */
export type UtilityItemKind = 'flash' | 'smoke' | 'fire' | 'he' | 'decoy' | 'other';

/*
 * Every member carries `context: 'utility-item'`, including the ones that
 * collide with nothing today. §10.4 deviation 3's lesson is that a vocabulary
 * is tagged as a set or the next member added to it silently inherits another
 * screen's translation — 烟雾 and 闪光 are exactly the kind of two-character
 * words that turn up again as a filter chip or a camera mode. `msg` is a
 * compile-time macro, so each call is written out rather than generated.
 */
export const UTILITY_ITEM_LABEL: Readonly<Record<UtilityItemKind, MessageDescriptor>> = {
  flash: msg({ message: '闪光弹', context: 'utility-item' }),
  smoke: msg({ message: '烟雾弹', context: 'utility-item' }),
  fire: msg({ message: '燃烧瓶 / 燃烧弹', context: 'utility-item' }),
  he: msg({ message: '手雷', context: 'utility-item' }),
  decoy: msg({ message: '诱饵弹', context: 'utility-item' }),
  other: msg({ message: '其他道具', context: 'utility-item' }),
};

const ITEM_KIND: Readonly<Record<string, UtilityItemKind>> = {
  flashbang: 'flash',
  smokegrenade: 'smoke',
  molotov: 'fire',
  incgrenade: 'fire',
  inferno: 'fire',
  hegrenade: 'he',
  decoy: 'decoy',
};

/** `null` for a name nothing recognises, so the caller prints the raw name. */
export function utilityItemKind(name: string): UtilityItemKind | null {
  return ITEM_KIND[name.trim().toLowerCase()] ?? null;
}

/* ── the 道具 half ───────────────────────────────────────────────────────── */

export interface UtilityTotals {
  readonly throws: number;
  readonly detonations: number;
  readonly damage: number;
  readonly damageEvents: number;
  /** `player_blind` events attributed to a thrower — 致盲人次, not 「有效闪」. */
  readonly flashEvents: number;
  /** 投出但没有解出后续 — see the module header. */
  readonly incompleteLifecycle: number;
}

export function utilityTotals(insights: AnalysisInsightsRecord | undefined): UtilityTotals {
  let throws = 0;
  let detonations = 0;
  let damage = 0;
  let damageEvents = 0;
  let flashEvents = 0;

  for (const player of insights?.player_utility ?? []) {
    throws += player.throws;
    detonations += player.detonations;
    damage += player.damage;
    damageEvents += player.damage_events;
    flashEvents += player.flash_events;
  }

  return {
    throws,
    detonations,
    damage,
    damageEvents,
    flashEvents,
    incompleteLifecycle: Math.max(0, throws - detonations),
  };
}

export interface UtilityRow {
  readonly playerId: string;
  /** The raw id when the analysis has no player by that id — ugly and true. */
  readonly name: string;
  readonly team: 'A' | 'B' | null;
  readonly throws: number;
  readonly detonations: number;
  readonly damage: number;
  readonly damageEvents: number;
  readonly flashEvents: number;
  readonly playersFlashed: number;
  /** `null` when one decoded blind event omitted its duration — the wire says so. */
  readonly flashDurationSeconds: number | null;
  readonly items: readonly CountedItemRecord[];
}

/**
 * One row per player who has a utility record, busiest first.
 *
 * Players with no record at all are dropped rather than listed at zero: the
 * service seeds the accumulator from `analysis.players`, so an *absent* row
 * means the insight block itself is missing, not that the player threw nothing.
 * Rows that are present and genuinely zero stay — that zero was measured.
 */
export function utilityRows(
  insights: AnalysisInsightsRecord | undefined,
  index: ReadonlyMap<string, RosterEntry>,
): readonly UtilityRow[] {
  return (insights?.player_utility ?? [])
    .map((record: PlayerUtilityInsightRecord): UtilityRow => {
      const player = index.get(record.player_id);
      return {
        playerId: record.player_id,
        name: player?.name ?? record.player_id,
        team: player?.team ?? null,
        throws: record.throws,
        detonations: record.detonations,
        damage: record.damage,
        damageEvents: record.damage_events,
        flashEvents: record.flash_events,
        playersFlashed: record.players_flashed,
        flashDurationSeconds: record.flash_duration_seconds,
        items: record.items,
      };
    })
    .sort(
      (left, right) =>
        right.throws - left.throws ||
        right.damage - left.damage ||
        left.name.localeCompare(right.name),
    );
}

/** One player's item histogram, most thrown first. */
export function utilityItems(row: UtilityRow | undefined): readonly CountedItemRecord[] {
  return (row?.items ?? [])
    .slice()
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

/* ── the 经济 half ───────────────────────────────────────────────────────── */

export interface EconomySideRow {
  /** 「CT」/「T」, as the purchase event spelled it. Not a team. */
  readonly side: string;
  readonly purchaseCount: number;
  /** `null` when one decoded purchase carried no explicit price. */
  readonly spend: number | null;
  readonly items: readonly CountedItemRecord[];
}

export interface EconomyRow {
  readonly round: number;
  readonly sides: readonly EconomySideRow[];
  readonly unattributed: number;
  /** Which team took the round, or `null` when the round is not in the analysis. */
  readonly winner: 'A' | 'B' | null;
}

/**
 * The per-round economy, joined to the round's winner.
 *
 * `round_economy` is emitted for every round the analysis has, so the join is
 * a lookup and not a merge; a round with no matching summary keeps a `null`
 * winner rather than being dropped, because the purchases are still real.
 */
export function economyRows(
  insights: AnalysisInsightsRecord | undefined,
  rounds: readonly RoundSummary[],
): readonly EconomyRow[] {
  const winners = new Map<number, 'A' | 'B'>();
  for (const round of rounds) winners.set(round.number, round.winner);

  return (insights?.round_economy ?? [])
    .map((record) => ({
      round: record.round,
      sides: record.teams.map((team: TeamPurchaseInsightRecord) => ({
        side: team.team,
        purchaseCount: team.purchase_count,
        spend: team.spend,
        items: team.items,
      })),
      unattributed: record.unattributed_purchase_count,
      winner: winners.get(record.round) ?? null,
    }))
    .sort((left, right) => left.round - right.round);
}

/** The sides the economy table draws a column pair for, in the artboard's order. */
export const ECONOMY_SIDES = ['CT', 'T'] as const;

export function economySide(row: EconomyRow, side: string): EconomySideRow | null {
  return row.sides.find((entry) => entry.side.trim().toUpperCase() === side) ?? null;
}

/** Total decoded purchases, attributed or not — the denominator of the header. */
export function economyPurchaseTotal(rows: readonly EconomyRow[]): number {
  return rows.reduce(
    (total, row) =>
      total + row.unattributed + row.sides.reduce((sum, side) => sum + side.purchaseCount, 0),
    0,
  );
}

/* ── capability gates ────────────────────────────────────────────────────── */

/**
 * The reason a capability is unavailable, or `null` when it is available.
 *
 * The service sends English reasons (「no grenade lifecycle events were
 * decoded」). They are shown as the `detail` of a Notice under an authored
 * Chinese sentence rather than as the message itself — a translated sentence
 * the user can act on, with the service's own words kept underneath so a bug
 * report can quote them.
 */
export function capabilityReason(capability: InsightCapabilityRecord | undefined): string | null {
  if (capability === undefined) return null;
  if (capability.available) return null;
  const reason = capability.reason?.trim() ?? '';
  return reason === '' ? null : reason;
}
