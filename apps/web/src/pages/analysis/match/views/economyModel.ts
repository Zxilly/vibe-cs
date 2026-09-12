/** Purchase summaries retain CT/T side identity; freeze-end equipment
 * snapshots provide separate stable-team A/B measurements. */

import type {
  AnalysisInsightsRecord,
  RoundEconomyInsightRecord,
  AnalysisRoundRecord as WireRound,
} from '../../../../shared/desktop/dto';
import type { AnalysisWorkspace } from '../../../../shared/desktop/viewModels';
import { normaliseRoundEndReason, type RoundEndReason, type RoundWinner } from '../../../../domain/match';

/** The two sides a purchase event can name. Not a team — see the header. */
export type EconomySide = 'ct' | 't';

export interface SidePurchases {
  readonly purchases: number;
  /** `null` when at least one purchase in this round carried no price. */
  readonly spend: number | null;
}

export interface SideEconomyRow {
  readonly round: number;
  /** Which of the two *teams* won — the one thing that is per-team here. */
  readonly winner: RoundWinner;
  readonly reason: RoundEndReason;
  readonly ct: SidePurchases;
  readonly t: SidePurchases;
  /** Purchases the analyser could not attribute to either side. */
  readonly unattributed: number;
}

const EMPTY: SidePurchases = { purchases: 0, spend: null };

/**
 * One row per round of the analysis, in round order.
 *
 * Driven by `analysis.rounds` rather than by `insights.round_economy`, so a
 * round the economy pass produced nothing for still appears — with zeros it can
 * defend, because「这一回合没有购买事件」is itself a fact — instead of the table
 * skipping round numbers and looking like a truncation.
 */
export function sideEconomyRows(analysis: AnalysisWorkspace): readonly SideEconomyRow[] {
  const economy = new Map<number, RoundEconomyInsightRecord>();
  for (const entry of analysis.insights?.round_economy ?? []) economy.set(entry.round, entry);

  return [...analysis.rounds]
    .sort((left, right) => left.number - right.number)
    .map((round) => rowFor(round, economy.get(round.number)));
}

function rowFor(round: WireRound, entry: RoundEconomyInsightRecord | undefined): SideEconomyRow {
  return {
    round: round.number,
    winner: round.winner === 'A' ? 'a' : 'b',
    reason: normaliseRoundEndReason(round.reason),
    ct: purchasesFor(entry, 'CT'),
    t: purchasesFor(entry, 'T'),
    unattributed: entry?.unattributed_purchase_count ?? 0,
  };
}

function purchasesFor(
  entry: RoundEconomyInsightRecord | undefined,
  side: 'CT' | 'T',
): SidePurchases {
  const found = entry?.teams.find((team) => team.team.trim().toUpperCase() === side);
  if (found === undefined) return EMPTY;
  return { purchases: found.purchase_count, spend: found.spend };
}

export interface EconomyTotals {
  readonly rounds: number;
  readonly ct: SidePurchases;
  readonly t: SidePurchases;
  readonly unattributed: number;
  /** True when at least one round carried a purchase — the table means something. */
  readonly anyPurchases: boolean;
}

/**
 * The footer line of the economy table.
 *
 * Spend is summed only while every contributing round has one; the first `null`
 * makes the total `null` and it stays that way. See the header.
 */
export function economyTotals(rows: readonly SideEconomyRow[]): EconomyTotals {
  let ctPurchases = 0;
  let tPurchases = 0;
  let ctSpend: number | null = 0;
  let tSpend: number | null = 0;
  let unattributed = 0;

  for (const row of rows) {
    ctPurchases += row.ct.purchases;
    tPurchases += row.t.purchases;
    unattributed += row.unattributed;
    ctSpend = addSpend(ctSpend, row.ct);
    tSpend = addSpend(tSpend, row.t);
  }

  return {
    rounds: rows.length,
    ct: { purchases: ctPurchases, spend: ctSpend },
    t: { purchases: tPurchases, spend: tSpend },
    unattributed,
    anyPurchases: ctPurchases + tPurchases + unattributed > 0,
  };
}

/**
 * A round with no purchases at all contributes nothing and cannot spoil the
 * total: its `spend` is `null` only because there was nothing to price.
 */
function addSpend(running: number | null, side: SidePurchases): number | null {
  if (running === null) return null;
  if (side.purchases === 0) return running;
  return side.spend === null ? null : running + side.spend;
}

/* ── what the insight block says about itself ────────────────────────────── */

export interface EconomyAvailability {
  readonly available: boolean;
  /** The service's own sentence when it declared the capability unavailable. */
  readonly reason: string | null;
  /** `false` when the analysis document carries no `insights` block at all. */
  readonly present: boolean;
}

/**
 * Whether the purchase pass ran, and what the service said when it did not.
 *
 * `insights` is optional on `AnalysisWorkspace` ("absent only in in-memory
 * loading/error workspaces"), so its absence is a third state and not the same
 * as 「跑了但没有数据」. The view says which of the three it is instead of
 * drawing an empty table under a heading that promises numbers.
 */
export function economyAvailability(
  insights: AnalysisInsightsRecord | undefined,
): EconomyAvailability {
  if (insights === undefined) return { available: false, reason: null, present: false };
  const capability = insights.availability.purchase_events;
  return { available: capability.available, reason: capability.reason, present: true };
}
