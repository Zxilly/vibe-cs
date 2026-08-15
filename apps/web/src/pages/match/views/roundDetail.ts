/*
 * pages/match/views — one round, as 回合 draws it.
 *
 * §7 merged two retired tabs into 回合 and this module is why they could be
 * merged: 「advantage 人数优势本身就是回合内的时间序列」 and 「objective 下包、
 * 拆包、爆炸已经在回合事件轴上」 are the same walk over the same event list. The
 * survivor curve and the objective markers are two readings of one fold, so they
 * are computed once, here, and the view only draws them.
 *
 * Pure — no React, no client — so `roundDetail.test.ts` runs it in the `unit`
 * project.
 *
 * ── The survivor curve is a derivation and says so ────────────────────────
 *
 * There is no per-tick alive count on the wire. What there is: a roster
 * (`players`, each with a team) and kill events carrying a target. So the curve
 * starts at the roster sizes and steps down by one on every kill whose target
 * this match knows. Three consequences, all of them stated rather than hidden:
 *
 *   * A kill whose target names nobody moves nothing and is counted in
 *     `unattributedKills`. The view prints that count when it is non-zero — a
 *     curve that quietly ignored two deaths is worse than one that admits it.
 *   * A player who disconnects mid-round never dies, so the curve holds. That is
 *     the honest reading of the evidence available.
 *   * The curve is not clamped upward: it cannot rise, because no event on the
 *     wire says a player came back.
 *
 * ── What the artboard draws and the wire cannot answer ────────────────────
 *
 * The 「回合内事件」 table has a 位置 column reading 「中路」「A 大道」.
 * `TimelineEvent.position` is a world coordinate triple, and there is no callout
 * table anywhere in the product that turns one into a name. The column is
 * omitted rather than filled with three floats under a heading that promises a
 * place name.
 */

import type {
  AnalysisWorkspace,
  PlayerAnalysis,
  RoundSummary as WireRound,
  TimelineEvent,
} from '../../../shared/desktop/dto';
import {
  normaliseRoundEndReason,
  type EvidenceKind,
  type RoundEndReason,
  type RoundWinner,
} from '../../../domain/match';
import { playerDirectory, rosters, teamOfActor } from './matchAggregates';

/* ── which events the round axis carries ─────────────────────────────────── */

/**
 * Kills and the three bomb events, and nothing else.
 *
 * `round_start` / `round_end` are the frame the round already is; `damage` and
 * `purchase` are per-tick noise a 30-row table cannot hold (a single round
 * carries hundreds); `grenade` belongs to 道具与经济, which owns the throw
 * lifecycle and its degradation rules. The set is exactly what the artboard's
 * 回合内事件 table lists — 「Sable → Vex · AWP」 rows and 「C4 已下包」.
 */
const AXIS_KINDS: ReadonlySet<string> = new Set([
  'kill',
  'bomb_plant',
  'bomb_defuse',
  'bomb_explode',
]);

export type RoundMomentKind = 'kill' | 'bomb_plant' | 'bomb_defuse' | 'bomb_explode';

/** Axis kind → the evidence vocabulary `domain/match/EvidenceRow` draws. */
const EVIDENCE_KIND_OF: Readonly<Record<RoundMomentKind, EvidenceKind>> = {
  kill: 'kill',
  bomb_plant: 'objective',
  bomb_defuse: 'objective',
  bomb_explode: 'objective',
};

type AxisEvent = TimelineEvent & { readonly kind: RoundMomentKind };

function isAxisEvent(event: TimelineEvent): event is AxisEvent {
  return AXIS_KINDS.has(event.kind);
}

export interface RoundMoment {
  readonly id: string;
  readonly tick: number;
  /** Ticks since the round started — what 「00:19」 is a rendering of. */
  readonly offsetTick: number;
  readonly kind: RoundMomentKind;
  readonly evidenceKind: EvidenceKind;
  /** Display name when this match knows the identity, else the raw string. */
  readonly actor: string | null;
  readonly target: string | null;
  readonly weapon: string | null;
  readonly headshot: boolean;
  readonly penetrated: boolean;
  /** Survivors **after** this moment. */
  readonly aliveA: number;
  readonly aliveB: number;
  /** False when a kill's target could not be attributed to a team. */
  readonly attributed: boolean;
}

export interface RoundDetail {
  readonly number: number;
  readonly winner: RoundWinner;
  readonly reason: RoundEndReason;
  readonly startTick: number;
  readonly endTick: number;
  readonly teamAScore: number;
  readonly teamBScore: number;
  /** Roster sizes, which are where the survivor curve starts. */
  readonly rosterA: number;
  readonly rosterB: number;
  readonly moments: readonly RoundMoment[];
  /** The subset the artboard marks on the axis — 「下包 00:31」「拆包 00:43」. */
  readonly objectives: readonly RoundMoment[];
  /** Kills whose target named nobody in this match. */
  readonly unattributedKills: number;
  /** Every event of the round, including the ones the axis does not carry. */
  readonly eventCount: number;
}

/* ── the fold ────────────────────────────────────────────────────────────── */

/** `null` when this match has no such round — a hand-edited `?round=99`. */
export function buildRoundDetail(
  analysis: AnalysisWorkspace,
  roundNumber: number,
): RoundDetail | null {
  const round = analysis.rounds.find((candidate) => candidate.number === roundNumber);
  if (round === undefined) return null;

  const directory = playerDirectory(analysis.players);
  const roster = rosters(analysis.players);
  let aliveA = roster.a.length;
  let aliveB = roster.b.length;
  let unattributedKills = 0;

  const moments: RoundMoment[] = [];
  for (const event of axisEvents(round)) {
    let attributed = true;

    if (event.kind === 'kill') {
      const team = teamOfActor(event.target, directory);
      if (team === 'a') aliveA = Math.max(0, aliveA - 1);
      else if (team === 'b') aliveB = Math.max(0, aliveB - 1);
      else {
        attributed = false;
        unattributedKills += 1;
      }
    }

    moments.push({
      id: event.id,
      tick: event.tick,
      offsetTick: Math.max(0, event.tick - round.start_tick),
      kind: event.kind,
      evidenceKind: EVIDENCE_KIND_OF[event.kind],
      actor: displayName(event.actor, directory),
      target: displayName(event.target, directory),
      weapon: event.weapon === null || event.weapon === '' ? null : event.weapon,
      headshot: event.headshot,
      penetrated: event.penetrated,
      aliveA,
      aliveB,
      attributed,
    });
  }

  return {
    number: round.number,
    winner: round.winner === 'A' ? 'a' : 'b',
    reason: normaliseRoundEndReason(round.reason),
    startTick: round.start_tick,
    endTick: round.end_tick,
    teamAScore: round.team_a_score,
    teamBScore: round.team_b_score,
    rosterA: roster.a.length,
    rosterB: roster.b.length,
    moments,
    objectives: moments.filter((moment) => moment.kind !== 'kill'),
    unattributedKills,
    eventCount: round.events.length,
  };
}

/**
 * The axis events in tick order.
 *
 * Sorted rather than trusted: the wire makes no ordering promise, and every
 * number downstream — the survivor curve, 「第一次击杀」, the table — is a claim
 * about time. A stable tie-break on the id keeps two events on the same tick in
 * one order across renders.
 */
function axisEvents(round: WireRound): readonly AxisEvent[] {
  return round.events
    .filter(isAxisEvent)
    .sort((left, right) => left.tick - right.tick || left.id.localeCompare(right.id));
}

function displayName(
  raw: string | null,
  directory: ReadonlyMap<string, PlayerAnalysis>,
): string | null {
  if (raw === null || raw === '') return null;
  return directory.get(raw)?.name ?? raw;
}

/* ── the survivor curve, as points ───────────────────────────────────────── */

export interface CurvePoint {
  /** 0…1 across the round's tick span. */
  readonly at: number;
  readonly aliveA: number;
  readonly aliveB: number;
}

/**
 * The step curve as normalised points, ready for an `<svg viewBox="0 0 1 1">`.
 *
 * Normalised here rather than in the view because the arithmetic — including the
 * degenerate round whose start and end tick are equal — is exactly the kind of
 * thing a node test should pin, and a component that does its own division ends
 * up dividing by zero on the one demo that has a zero-length round.
 *
 * The first point is the round's start at full rosters; the last is the round's
 * end holding the final counts, so the curve spans the whole axis even when the
 * last kill happened early.
 */
export function survivorCurve(detail: RoundDetail): readonly CurvePoint[] {
  const span = detail.endTick - detail.startTick;
  const at = (offsetTick: number): number =>
    span <= 0 ? 0 : Math.min(1, Math.max(0, offsetTick / span));

  const points: CurvePoint[] = [{ at: 0, aliveA: detail.rosterA, aliveB: detail.rosterB }];
  for (const moment of detail.moments) {
    points.push({ at: at(moment.offsetTick), aliveA: moment.aliveA, aliveB: moment.aliveB });
  }

  const last = points[points.length - 1];
  if (last !== undefined && last.at < 1) {
    points.push({ at: 1, aliveA: last.aliveA, aliveB: last.aliveB });
  }
  return points;
}

/**
 * The two polyline point lists, in the `x,y` form SVG wants, for a unit box.
 *
 * `y` is inverted (a full roster is at the top) and scaled against the larger of
 * the two rosters so both lines share one axis — two independently scaled lines
 * would make a 5v5 and a 5v4 look identical.
 */
export function curvePolylines(
  detail: RoundDetail,
  points: readonly CurvePoint[],
): { readonly a: string; readonly b: string } {
  const ceiling = Math.max(1, detail.rosterA, detail.rosterB);
  const step = (
    pick: (point: CurvePoint) => number,
  ): string => {
    const parts: string[] = [];
    let previous: number | null = null;
    for (const point of points) {
      const y = 1 - pick(point) / ceiling;
      // A step, not a slope: a player is alive right up to the tick they die.
      if (previous !== null && previous !== y) parts.push(`${point.at},${previous}`);
      parts.push(`${point.at},${y}`);
      previous = y;
    }
    return parts.join(' ');
  };

  return { a: step((point) => point.aliveA), b: step((point) => point.aliveB) };
}

/* ── moving between rounds ───────────────────────────────────────────────── */

export interface RoundNeighbours {
  readonly previous: number | null;
  readonly next: number | null;
}

/**
 * 「‹ R20 · R22 ›」.
 *
 * Neighbours in the *list*, not `number ± 1`: an interrupted parse can leave a
 * gap, and a button that walks to a round the analysis does not have would land
 * the workspace on an empty detail pane with no way back but the strip.
 */
export function roundNeighbours(
  rounds: readonly WireRound[],
  current: number | null,
): RoundNeighbours {
  if (current === null) return { previous: null, next: null };
  const ordered = [...rounds].sort((left, right) => left.number - right.number);
  const index = ordered.findIndex((round) => round.number === current);
  if (index < 0) return { previous: null, next: null };

  return {
    previous: ordered[index - 1]?.number ?? null,
    next: ordered[index + 1]?.number ?? null,
  };
}
