/*
 * pages/match/views — the rules behind 「Review 与结论」.
 *
 * Pure, React-free, `unit` project. The artboard's caption is the whole
 * specification of this file: 「自动洞察与 AI 点评并列，两者都必须标注证据」 —
 * an insight that cannot name what it was derived from does not get drawn.
 *
 * ── Why the artboard's three example insights are not the three here ──────
 *
 * It draws: 「Aurora 的首杀集中在中路（6 / 13）」, 「Kael 在经济劣势回合的 ADR
 * 反而更高」, 「Meridian 在残局里 1 胜 4 负」. Two of them cannot be computed
 * from anything the service sends:
 *
 *   · 「集中在中路」 needs a map region per kill. `TimelineEvent.position` is a
 *     world coordinate and there is no region table anywhere in the product;
 *     naming a callout from a coordinate would be this layer inventing an
 *     analysis result.
 *   · 「经济劣势回合的 ADR」 needs per-round damage per player.
 *     `PlayerAnalysis.adr` is a match total and `RoundEconomyInsightRecord`
 *     carries purchases, not damage. The join does not exist.
 *   · 「残局里 1 胜 4 负」 needs a clutch outcome. `AnalysisHighlightRecord`
 *     has a `clutch` kind and a `fail` kind but nothing that says a given
 *     clutch was won.
 *
 * So the three rules below are the ones the document *can* answer, each gated
 * on the capability flag the service itself publishes
 * (`AnalysisInsightsRecord.availability`), and every one of them carries the
 * count it was derived from. The capabilities that come back unavailable are
 * rendered as the artboard's dashed card, quoting the service's own reason —
 * which is the artboard's 「段位与历史对比不可用：…不用推算值填空」 done from real
 * data rather than from a fixed sentence.
 */

import type { InsightCapabilityRecord, TimelineEvent } from '../../../shared/desktop/dto';
import type { AnalysisWorkspace, Highlight } from '../../../shared/desktop/viewModels';

/* ── capabilities ────────────────────────────────────────────────────────── */

export type InsightCapabilityId =
  | 'purchase_events'
  | 'purchase_spend'
  | 'utility_events'
  | 'utility_damage'
  | 'flash_effects'
  | 'matchups';

/** The six the wire declares, in the order the panel lists them. */
export const INSIGHT_CAPABILITY_IDS: readonly InsightCapabilityId[] = [
  'matchups',
  'utility_events',
  'utility_damage',
  'flash_effects',
  'purchase_events',
  'purchase_spend',
];

export interface CapabilityGap {
  readonly id: InsightCapabilityId;
  /** The service's own sentence. `null` when it declined without one. */
  readonly reason: string | null;
}

function capability(
  analysis: AnalysisWorkspace | undefined,
  id: InsightCapabilityId,
): InsightCapabilityRecord | null {
  return analysis?.insights?.availability[id] ?? null;
}

function isAvailable(analysis: AnalysisWorkspace | undefined, id: InsightCapabilityId): boolean {
  return capability(analysis, id)?.available === true;
}

/**
 * The capabilities this analysis does **not** have.
 *
 * An absent `insights` block (which `AnalysisWorkspace` marks optional — it is
 * missing on in-memory loading and error workspaces) yields an empty list
 * rather than six gaps: 「还没读到」 is not 「不可用」, and the panel is already in
 * its loading state when that happens.
 */
export function capabilityGaps(analysis: AnalysisWorkspace | undefined): readonly CapabilityGap[] {
  if (analysis?.insights === undefined) return [];
  const gaps: CapabilityGap[] = [];
  for (const id of INSIGHT_CAPABILITY_IDS) {
    const record = analysis.insights.availability[id];
    if (record.available) continue;
    const reason = record.reason?.trim() ?? '';
    gaps.push({ id, reason: reason === '' ? null : reason });
  }
  return gaps;
}

/* ── rule 1: opening kills ───────────────────────────────────────────────── */

export interface OpeningKillInsight {
  readonly leaderId: string;
  readonly leaderName: string;
  readonly leaderCount: number;
  /** Rounds that had a kill at all — the denominator of 「6 / 13」. */
  readonly roundsWithOpening: number;
  /** Where 「查看证据」 goes: the leader's first opening kill. */
  readonly round: number;
  readonly tick: number;
}

/**
 * Who took the first kill of a round most often.
 *
 * Derived from `rounds[].events` — the first event of kind `kill` in each
 * round, in tick order — which is the definition of an opening kill and needs
 * no capability flag, because the event list is the analysis itself rather than
 * a derived insight block.
 *
 * `null` when no round has a kill: an empty match produces no card rather than
 * a card that says nobody did anything.
 */
export function openingKillInsight(analysis: AnalysisWorkspace | undefined): OpeningKillInsight | null {
  if (analysis === undefined) return null;

  const counts = new Map<string, { count: number; round: number; tick: number }>();
  let roundsWithOpening = 0;

  for (const round of analysis.rounds) {
    const kills = round.events
      .filter((event) => event.kind === 'kill' && event.actor !== null)
      .sort((a, b) => a.tick - b.tick);
    const first = kills[0];
    if (first === undefined || first.actor === null) continue;
    roundsWithOpening += 1;
    const seen = counts.get(first.actor);
    if (seen === undefined) {
      counts.set(first.actor, { count: 1, round: round.number, tick: first.tick });
    } else {
      seen.count += 1;
    }
  }

  let leaderId: string | null = null;
  let leader: { count: number; round: number; tick: number } | null = null;
  for (const [id, entry] of counts) {
    if (leader === null || entry.count > leader.count) {
      leaderId = id;
      leader = entry;
    }
  }
  if (leaderId === null || leader === null) return null;

  return {
    leaderId,
    leaderName: displayName(analysis, leaderId),
    leaderCount: leader.count,
    roundsWithOpening,
    round: leader.round,
    tick: leader.tick,
  };
}

/* ── rule 2: the decided duel ────────────────────────────────────────────── */

export interface MatchupInsight {
  readonly playerId: string;
  readonly playerName: string;
  readonly opponentId: string;
  readonly opponentName: string;
  readonly kills: number;
  readonly deaths: number;
  /** How many pairs the analysis recorded — the derivation's own denominator. */
  readonly pairCount: number;
}

/**
 * The most one-sided head-to-head of the match, from `insights.matchups`.
 *
 * Gated on `availability.matchups`: the service says outright when it could not
 * attribute duels, and a 「最大分差 0-0」 card built on an unattributed set would
 * be the invented number §4.6 keeps warning about.
 *
 * Ties are broken by the higher kill count, so the pair chosen is the one with
 * more evidence behind the same margin.
 */
export function matchupInsight(analysis: AnalysisWorkspace | undefined): MatchupInsight | null {
  if (analysis?.insights === undefined || !isAvailable(analysis, 'matchups')) return null;

  const pairs = analysis.insights.matchups;
  let best: (typeof pairs)[number] | null = null;
  for (const pair of pairs) {
    const margin = pair.kills - pair.deaths;
    if (margin <= 0) continue;
    if (best === null) {
      best = pair;
      continue;
    }
    const bestMargin = best.kills - best.deaths;
    if (margin > bestMargin || (margin === bestMargin && pair.kills > best.kills)) best = pair;
  }
  if (best === null) return null;

  return {
    playerId: best.player_id,
    playerName: displayName(analysis, best.player_id),
    opponentId: best.opponent_id,
    opponentName: displayName(analysis, best.opponent_id),
    kills: best.kills,
    deaths: best.deaths,
    pairCount: pairs.length,
  };
}

/* ── rule 3: utility ─────────────────────────────────────────────────────── */

export interface UtilityInsight {
  readonly playerId: string;
  readonly playerName: string;
  readonly damage: number;
  readonly throws: number;
  /** Only present when `availability.flash_effects` is true. */
  readonly playersFlashed: number | null;
}

/**
 * Who got the most out of their grenades, from `insights.player_utility`.
 *
 * Two flags, not one: `utility_events` says the throws were seen at all and
 * `utility_damage` says the damage could be attributed to them. The card needs
 * both, because 「投了 18 个，造成 0 伤害」 read off an unattributed damage field
 * is worse than no card. `players_flashed` is carried only when
 * `flash_effects` is also available, and is `null` otherwise so the view omits
 * the clause rather than printing a zero.
 */
export function utilityInsight(analysis: AnalysisWorkspace | undefined): UtilityInsight | null {
  if (analysis?.insights === undefined) return null;
  if (!isAvailable(analysis, 'utility_events') || !isAvailable(analysis, 'utility_damage')) return null;

  const rows = analysis.insights.player_utility;
  let best: (typeof rows)[number] | null = null;
  for (const row of rows) {
    if (row.damage <= 0) continue;
    if (best === null || row.damage > best.damage) best = row;
  }
  if (best === null) return null;

  return {
    playerId: best.player_id,
    playerName: displayName(analysis, best.player_id),
    damage: Math.round(best.damage),
    throws: best.throws,
    playersFlashed: isAvailable(analysis, 'flash_effects') ? best.players_flashed : null,
  };
}

/* ── citations ───────────────────────────────────────────────────────────── */

/**
 * One entry of 「引用了 4 条证据，全部属于发送给模型的集合」.
 *
 * `LlmReviewResult.evidence_ids` is a list of bare ids. They are resolved
 * against the two id spaces this match has — its highlights and its timeline
 * events — so the citation reads 「R21 · 1v3 残局」 rather than a hash, and so
 * clicking it can address the workspace. An id that matches neither keeps its
 * raw text: it is still evidence the model was given, and hiding it would break
 * the claim that all of them are shown.
 */
export type EvidenceCitation =
  | {
      readonly kind: 'highlight';
      readonly id: string;
      readonly label: string;
      readonly round: number;
      readonly tick: number;
    }
  | {
      readonly kind: 'event';
      readonly id: string;
      readonly round: number;
      readonly tick: number;
      readonly actor: string | null;
      readonly target: string | null;
    }
  | { readonly kind: 'unknown'; readonly id: string };

export function resolveCitations(
  ids: readonly string[],
  analysis: AnalysisWorkspace | undefined,
): readonly EvidenceCitation[] {
  const highlights = new Map<string, Highlight>();
  const events = new Map<string, { round: number; event: TimelineEvent }>();
  if (analysis !== undefined) {
    for (const highlight of analysis.highlights) highlights.set(highlight.id, highlight);
    for (const round of analysis.rounds) {
      for (const event of round.events) events.set(event.id, { round: round.number, event });
    }
  }

  return ids.map((id): EvidenceCitation => {
    const highlight = highlights.get(id);
    if (highlight !== undefined) {
      const label = highlight.label.trim();
      return {
        kind: 'highlight',
        id,
        label: label === '' ? highlight.kind : label,
        round: highlight.round,
        tick: highlight.start_tick,
      };
    }
    const event = events.get(id);
    if (event !== undefined) {
      return {
        kind: 'event',
        id,
        round: event.round,
        tick: event.event.tick,
        actor: event.event.actor,
        target: event.event.target,
      };
    }
    return { kind: 'unknown', id };
  });
}

/* ── annotations ─────────────────────────────────────────────────────────── */

export interface AnnotationTally {
  readonly total: number;
  readonly open: number;
  readonly resolved: number;
}

/** 「我的注释 3」 — and the split the artboard's two tags imply. */
export function annotationTally(
  rows: readonly { readonly review_state: 'open' | 'resolved' }[] | undefined,
): AnnotationTally {
  if (rows === undefined) return { total: 0, open: 0, resolved: 0 };
  let open = 0;
  for (const row of rows) if (row.review_state === 'open') open += 1;
  return { total: rows.length, open, resolved: rows.length - open };
}

/* ── shared ──────────────────────────────────────────────────────────────── */

/**
 * A player's display name, falling back to the id.
 *
 * `TimelineEvent.actor` is free text — some producers write the id, some the
 * name — so the id lookup is tried first and the value is returned unchanged
 * when it misses. An id printed as-is is ugly and true; a blank is neither.
 */
export function displayName(analysis: AnalysisWorkspace | undefined, who: string): string {
  const byId = analysis?.players.find((player) => player.id === who);
  return byId?.name ?? who;
}
