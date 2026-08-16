/*
 * pages/match/views — the derivations 概览 / 回合 / 队伍 share.
 *
 * Everything here is a fold over `AnalysisWorkspace`, and every one of them is
 * pure so `matchAggregates.test.ts` runs it in the `unit` project with no React
 * and no client. A view that needs a derivation only it uses keeps that
 * derivation next to itself (`roundDetail.ts`, `economyModel.ts`); these three
 * are the ones more than one of the three views reads.
 *
 * ── Why identity resolution needs a table with two keys ────────────────────
 *
 * `TimelineEvent.actor` and `.target` are free strings, and the analyser fills
 * them with **either** the player id or the player name depending on the demo
 * and the event source — `features/analysis/analysisOverview.ts` already had to
 * build a two-member identity set for exactly this, and
 * `economyEvidenceActions.ts` matches `player.id === actor || player.name ===
 * actor`. So `playerDirectory` indexes both, and a lookup that misses returns
 * `null` rather than a guess.
 *
 * Nothing here invents a fallback for a miss. Every function that can fail to
 * attribute an event reports how many it could not — `openingKills.unattributed`,
 * `RoundDetail.unattributedKills` — so the view can print 「其中 N 条没能归属」
 * instead of quietly folding them into one side. A silently wrong 首杀差 is the
 * kind of number a coach would act on.
 *
 * ── What is deliberately not here ─────────────────────────────────────────
 *
 *   * **Halves.** `Scoreboard` takes `periods`, and there is no half boundary on
 *     the wire: `TeamSummary.side` is the side a team is on *now*, and the
 *     rounds carry only running scores. Splitting at round 12 would be the MR12
 *     rule applied to a document that never states its own format, and an MR15
 *     demo would print two false half scores. Reported as a gap instead.
 *   * **Clutch wins.** The artboard's 「残局 3 / 5」 is won-over-attempted;
 *     `Highlight` has `kind: 'clutch'` and a separate `kind: 'fail'`, with no
 *     field that says which clutch was taken. Only the count of clutch
 *     candidates is derivable, so only the count is offered — under a label that
 *     says what it counts.
 */

import type { AnalysisRoundRecord as WireRound } from '../../../shared/desktop/dto';
import type {
  AnalysisWorkspace,
  Highlight,
  PlayerAnalysis,
} from '../../../shared/desktop/viewModels';
import {
  normaliseRoundEndReason,
  type HighlightCandidate,
  type HighlightKind,
  type RoundEndReason,
  type RoundWinner,
} from '../../../domain/match';

/* ── identity ────────────────────────────────────────────────────────────── */

/** Which of the two teams on the context bar. Matches `RoundWinner`. */
export type TeamKey = RoundWinner;

/**
 * Player id **and** player name → the player. Two keys per player because the
 * event stream uses both; see the header.
 *
 * A name that collides with another player's id would shadow it. That is a
 * theoretical demo, not one anybody has, and the alternative — dropping the
 * name key — loses every event on the demos that only carry names.
 */
export function playerDirectory(
  players: readonly PlayerAnalysis[],
): ReadonlyMap<string, PlayerAnalysis> {
  const directory = new Map<string, PlayerAnalysis>();
  for (const player of players) {
    if (player.id !== '') directory.set(player.id, player);
    if (player.name !== '' && !directory.has(player.name)) directory.set(player.name, player);
  }
  return directory;
}

/** `'a'` / `'b'`, or `null` when the string names nobody in this match. */
export function teamOfActor(
  actor: string | null | undefined,
  directory: ReadonlyMap<string, PlayerAnalysis>,
): TeamKey | null {
  if (actor === null || actor === undefined || actor === '') return null;
  const player = directory.get(actor);
  if (player === undefined) return null;
  return player.team === 'A' ? 'a' : 'b';
}

export interface TeamNames {
  /** Empty when the analysis did not name the team; the caller labels it. */
  readonly a: string;
  readonly b: string;
}

/**
 * The two team names as the analysis spells them.
 *
 * Empty rather than 「队伍 A」: naming is copy, copy goes through a Lingui macro,
 * and a macro cannot live in a pure module a node test imports. `matchModel`
 * makes the same choice for the same reason.
 */
export function teamNames(analysis: AnalysisWorkspace): TeamNames {
  const [a, b] = analysis.teams;
  return { a: a?.name.trim() ?? '', b: b?.name.trim() ?? '' };
}

/** 「+4」「-2」「0」 — a difference that has to show which way it points. */
export function signedDelta(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

export interface Rosters {
  readonly a: readonly PlayerAnalysis[];
  readonly b: readonly PlayerAnalysis[];
}

/**
 * The two rosters, each sorted the way a scoreboard is: by kills, then by the
 * ADR that breaks a tie, then by name so the order is stable across renders.
 */
export function rosters(players: readonly PlayerAnalysis[]): Rosters {
  const byImpact = (left: PlayerAnalysis, right: PlayerAnalysis): number =>
    right.kills - left.kills || right.adr - left.adr || left.name.localeCompare(right.name);

  return {
    a: players.filter((player) => player.team === 'A').sort(byImpact),
    b: players.filter((player) => player.team === 'B').sort(byImpact),
  };
}

/* ── rounds ──────────────────────────────────────────────────────────────── */

export interface TeamTally {
  readonly a: number;
  readonly b: number;
}

/**
 * Rounds won, counted off the round list rather than read off
 * `TeamSummary.score`.
 *
 * The two disagree on an interrupted parse — the same reason `matchModel`'s
 * `matchIdentity` prefers `rounds.length` over `DemoSummary.total_rounds` — and
 * everything else on 概览 is drawn from the round list, so the tally has to come
 * from the same place or the strip and the number above it contradict.
 */
export function roundsWon(rounds: readonly WireRound[]): TeamTally {
  let a = 0;
  let b = 0;
  for (const round of rounds) {
    if (round.winner === 'A') a += 1;
    else b += 1;
  }
  return { a, b };
}

export interface OpeningKills extends TeamTally {
  /** Rounds that had at least one kill event at all. */
  readonly rounds: number;
  /** Opening kills whose actor named nobody in this match. */
  readonly unattributed: number;
}

/**
 * 「首杀差 +4」 — the first kill of each round, attributed to the killer's team.
 *
 * The events of a round are walked in tick order rather than in array order:
 * the wire does not promise a sort, and 「first kill」 is a claim about time.
 */
export function openingKills(
  rounds: readonly WireRound[],
  directory: ReadonlyMap<string, PlayerAnalysis>,
): OpeningKills {
  let a = 0;
  let b = 0;
  let counted = 0;
  let unattributed = 0;

  for (const round of rounds) {
    const kills = round.events.filter((event) => event.kind === 'kill');
    if (kills.length === 0) continue;
    counted += 1;

    const first = kills.reduce((earliest, event) => (event.tick < earliest.tick ? event : earliest));
    const team = teamOfActor(first.actor, directory);
    if (team === 'a') a += 1;
    else if (team === 'b') b += 1;
    else unattributed += 1;
  }

  return { a, b, rounds: counted, unattributed };
}

export interface PositionedEvidence {
  /** Events carrying world coordinates — what the 2D replay can draw. */
  readonly positioned: number;
  readonly total: number;
}

/**
 * 「空间证据」 on the 概览 artboard.
 *
 * The artboard's copy is 「可用（含路线与朝向）」; 朝向 comes from the replay
 * frame stream, which 概览 does not read, so what is stated here is the one
 * thing the analysis document itself answers: how many of its events carry a
 * position. Printing the two numbers rather than the word 「可用」 also survives
 * the case the word cannot describe — a parse where only some events are
 * positioned.
 */
export function positionedEvidence(rounds: readonly WireRound[]): PositionedEvidence {
  let positioned = 0;
  let total = 0;
  for (const round of rounds) {
    for (const event of round.events) {
      total += 1;
      if (event.position !== null) positioned += 1;
    }
  }
  return { positioned, total };
}

/**
 * Rounds won by each team, broken down by how they ended — the 「回合」 third of
 * §7's 「队伍（阵营 · 经济 · 回合）」.
 *
 * A `Record` over the closed `RoundEndReason` union rather than a map built from
 * what happened to appear, so a reason with no rounds prints 0 in a row that
 * exists rather than vanishing from the table between two matches.
 */
export type ReasonTally = Readonly<Record<RoundEndReason, number>>;

export interface WinsByReason {
  readonly a: ReasonTally;
  readonly b: ReasonTally;
}

export function winsByReason(rounds: readonly WireRound[]): WinsByReason {
  const empty = (): Record<RoundEndReason, number> => ({
    elimination: 0,
    'bomb-exploded': 0,
    'bomb-defused': 0,
    'time-expired': 0,
    unknown: 0,
  });

  const a = empty();
  const b = empty();
  for (const round of rounds) {
    const reason = normaliseRoundEndReason(round.reason);
    const side = round.winner === 'A' ? a : b;
    side[reason] += 1;
  }
  return { a, b };
}

/* ── highlights ──────────────────────────────────────────────────────────── */

/**
 * Wire kind → the `HighlightKind` vocabulary `domain/match` draws.
 *
 * The two unions were written from different ends: the wire's is what the
 * detector emits, the domain's is the type filter 「高光列表」 offers. Four wire
 * kinds (`knife` / `taser` / `defuse` / `timeline`) have no member on the filter
 * and become `other`, which prints 「其他」 — the row still carries the
 * analysis's own `title` as its label, so nothing is lost, and inventing four
 * filter chips nobody drew would be worse.
 *
 * `fail` is `other` too and not 「残局」: the artboard's 「1v2 残局失败」 is a
 * failed *clutch*, but `fail` is emitted for any failed candidate, so mapping it
 * onto 残局 would file every failed multi-kill under the clutch filter.
 */
const WIRE_HIGHLIGHT_KIND: Readonly<Record<Highlight['kind'], HighlightKind>> = {
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
  return WIRE_HIGHLIGHT_KIND[kind];
}

/**
 * One wire highlight as the row model `domain/match/HighlightRow` takes.
 *
 * `subject` is the player's name when this match knows the id and the raw id
 * when it does not — the same choice `matchModel.focusedPlayers` records: an id
 * is ugly and true, and an empty subject column would make the row look like a
 * team-level moment.
 *
 * Empty strings are dropped rather than passed through: `label: ''` would render
 * an empty `Tag` where the kind name belongs.
 */
export function toHighlightCandidate(
  highlight: Highlight,
  directory: ReadonlyMap<string, PlayerAnalysis>,
): HighlightCandidate {
  const player = directory.get(highlight.player_id);
  const label = highlight.label.trim();
  const description = highlight.description.trim();
  const subject = player?.name ?? (highlight.player_id === '' ? undefined : highlight.player_id);

  return {
    id: highlight.id,
    kind: highlightKindOf(highlight.kind),
    round: highlight.round,
    startTick: highlight.start_tick,
    endTick: highlight.end_tick,
    ...(label === '' ? {} : { label }),
    ...(description === '' ? {} : { description }),
    ...(subject === undefined ? {} : { subject }),
  };
}

/**
 * The 「关键时刻」 block of 概览: the strongest candidates first.
 *
 * `confidence` is the detector's own ranking and is the only field on the wire
 * that says one moment matters more than another. Ties break on the later round,
 * then on the id, so the order is total and does not shuffle between renders of
 * the same document.
 */
export function rankedHighlights(
  highlights: readonly Highlight[],
  limit: number,
): readonly Highlight[] {
  return [...highlights]
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        right.round - left.round ||
        left.id.localeCompare(right.id),
    )
    .slice(0, Math.max(0, limit));
}

/** How many candidates carry each filter type — 「残局 5 · 多杀 4」. */
export function highlightKindCounts(
  highlights: readonly Highlight[],
): ReadonlyMap<HighlightKind, number> {
  const counts = new Map<HighlightKind, number>();
  for (const highlight of highlights) {
    const kind = highlightKindOf(highlight.kind);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts;
}

/* ── the one call the views make ─────────────────────────────────────────── */

export interface MatchOverviewFacts {
  readonly rounds: number;
  readonly won: TeamTally;
  readonly opening: OpeningKills;
  readonly spatial: PositionedEvidence;
  readonly highlights: number;
  readonly clutchCandidates: number;
}

/**
 * Everything the 概览 stat strip prints, in one pass per fold rather than five
 * passes hidden behind five call sites.
 */
export function matchOverviewFacts(analysis: AnalysisWorkspace): MatchOverviewFacts {
  const directory = playerDirectory(analysis.players);
  return {
    rounds: analysis.rounds.length,
    won: roundsWon(analysis.rounds),
    opening: openingKills(analysis.rounds, directory),
    spatial: positionedEvidence(analysis.rounds),
    highlights: analysis.highlights.length,
    clutchCandidates: highlightKindCounts(analysis.highlights).get('clutch') ?? 0,
  };
}
