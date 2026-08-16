/*
 * pages/match/views — the arithmetic behind 回放与热力图.
 *
 * Everything in this file is pure: wire records in, `domain/map` presentation
 * models out. It is React-free so `replayModel.test.ts` runs it in the `unit`
 * project, and it is separate from `ReplayView.tsx` for the reason
 * `domain/map` states about its own five modules — the drawing and the
 * geometry fail in different ways and are worth failing separately.
 *
 * ── What the backend gives, and what it does not ───────────────────────────
 *
 * `useMatchReplay` decodes one binary stream for the **whole match**
 * (`data/match.ts` gap 1: the per-round route needs an analysis-run id nothing
 * can look up). So the round scoping the workspace promises is a client-side
 * slice, and it is done here rather than in the view.
 *
 * `ReplayFrameRecord` carries every player's position at a tick.
 * `TimelineEvent` carries a kill's actor, target and weapon — and one
 * `position`, which is the event's, not the pair's. An engagement axis needs
 * *two* points, so `buildEngagements` reads both ends out of the replay frame
 * at the kill's tick. That is the honest source: the same stream the map is
 * already drawing, at the tick the kill is stamped with. When either end
 * cannot be located the engagement is **dropped**, never drawn from one point
 * and a guess.
 *
 * ── Why paths are strided ──────────────────────────────────────────────────
 *
 * §10.3 gap 1 measured `PathLayer` at 2.65 MB of markup for 240 tracks × 600
 * samples. Ten players over a whole 20 000-frame match would be 200 000 points
 * in ten `d` attributes. The node count is fine (ten `<path>`); the byte count
 * is not, and `domain/map/density.test.tsx` pins a ceiling that a whole-match
 * track would sail past. So a track is strided down to `PATH_SAMPLE_LIMIT`
 * points and the stride is reported back to the view, which prints it. A route
 * is a shape, not a measurement — but a thinned shape has to say it is thinned.
 */

import type { EvidenceKind } from '../../../domain/match';
import type { Engagement, HeatSample, MapSide, PathSample, PlayerPath } from '../../../domain/map';
import type {
  HeatPointRecord,
  ReplayFrameRecord,
  ReplayPayload,
  ReplayPlayerRecord,
  TimelineEvent,
} from '../../../shared/desktop/dto';
import type { AnalysisWorkspace } from '../../../shared/desktop/viewModels';

/* ── the slice ───────────────────────────────────────────────────────────── */

/** A closed tick interval. Both ends are inclusive, as the wire spells them. */
export interface TickRange {
  readonly startTick: number;
  readonly endTick: number;
}

/**
 * The round the address selects, in ticks. `null` when nothing is selected or
 * the analysis has no such round — both of which mean 「整场」 rather than an
 * error, because the workspace opens with no round chosen.
 */
export function roundBounds(
  analysis: AnalysisWorkspace | undefined,
  round: number | null,
): TickRange | null {
  if (analysis === undefined || round === null) return null;
  const match = analysis.rounds.find((entry) => entry.number === round);
  if (match === undefined) return null;
  if (!Number.isFinite(match.start_tick) || !Number.isFinite(match.end_tick)) return null;
  if (match.end_tick <= match.start_tick) return null;
  return { startTick: match.start_tick, endTick: match.end_tick };
}

export interface ReplaySlice extends TickRange {
  readonly frames: readonly ReplayFrameRecord[];
  /** Ticks per second, from the stream itself rather than from the analysis. */
  readonly tickRate: number;
  /** Frames the whole stream holds, for the provenance line. */
  readonly totalFrames: number;
}

/**
 * The frames the view is actually going to draw.
 *
 * The bounds come from `fidelity` rather than from the frame list because a
 * stream may legitimately start before its first positioned frame; where
 * `fidelity` is unusable (a synthetic payload, an interrupted parse) the frames
 * themselves are the fallback, and an empty stream yields `null` — 「没有回放
 * 数据」 is a state, not a zero-length interval.
 */
export function sliceReplay(
  payload: ReplayPayload | undefined,
  bounds: TickRange | null,
): ReplaySlice | null {
  if (payload === undefined) return null;

  const frames = payload.frames;
  const first = frames[0];
  const last = frames[frames.length - 1];
  const fidelity = payload.fidelity;

  const rawStart = Number.isFinite(fidelity.start_tick) ? fidelity.start_tick : (first?.tick ?? null);
  const rawEnd = Number.isFinite(fidelity.end_tick) ? fidelity.end_tick : (last?.tick ?? null);
  if (rawStart === null || rawEnd === null || rawEnd <= rawStart) return null;

  const startTick = bounds === null ? rawStart : Math.max(rawStart, bounds.startTick);
  const endTick = bounds === null ? rawEnd : Math.min(rawEnd, bounds.endTick);
  if (endTick <= startTick) return null;

  return {
    startTick,
    endTick,
    frames: frames.filter((frame) => frame.tick >= startTick && frame.tick <= endTick),
    tickRate: fidelity.tick_rate > 0 ? fidelity.tick_rate : 64,
    totalFrames: frames.length,
  };
}

/** Keeps a playhead inside the slice. Ticks are integers on the wire. */
export function clampTick(tick: number, range: TickRange): number {
  if (!Number.isFinite(tick)) return range.startTick;
  return Math.min(range.endTick, Math.max(range.startTick, Math.round(tick)));
}

/**
 * The index of the last frame at or before `tick`, or `-1` when the playhead
 * sits before the first frame.
 *
 * Binary search rather than a scan: this runs on every step of the playback
 * loop over a list that can hold twenty thousand frames.
 */
export function frameIndexAtTick(frames: readonly ReplayFrameRecord[], tick: number): number {
  let low = 0;
  let high = frames.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const frame = frames[middle];
    if (frame === undefined) break;
    if (frame.tick <= tick) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

export function frameAtTick(
  frames: readonly ReplayFrameRecord[],
  tick: number,
): ReplayFrameRecord | null {
  const index = frameIndexAtTick(frames, tick);
  return index < 0 ? null : (frames[index] ?? null);
}

/* ── tracks ──────────────────────────────────────────────────────────────── */

/** See the module note. Ten tracks of 240 points is the density budget. */
export const PATH_SAMPLE_LIMIT = 240;

/** How many frames are skipped between two kept samples. Never below 1. */
export function pathStride(frameCount: number, limit: number = PATH_SAMPLE_LIMIT): number {
  if (frameCount <= limit || limit < 1) return 1;
  return Math.ceil(frameCount / limit);
}

export interface PlayerTracks {
  readonly paths: readonly PlayerPath[];
  /** 1 when nothing was thinned. Printed by the view when it is not 1. */
  readonly stride: number;
  /** Frames the tracks were built from, before striding. */
  readonly frameCount: number;
}

/**
 * The trail every player has walked from the start of the slice up to the
 * playhead — which is what makes a still frame readable as motion, and what
 * gives `PathLayer` its direction head at the position the player is at *now*.
 *
 * The frame at the playhead is always kept, whatever the stride does, so the
 * head of the track and the marker on the map cannot disagree.
 */
export function buildPlayerTracks(
  frames: readonly ReplayFrameRecord[],
  upToIndex: number,
  limit: number = PATH_SAMPLE_LIMIT,
): PlayerTracks {
  const last = Math.min(upToIndex, frames.length - 1);
  if (last < 0) return { paths: [], stride: 1, frameCount: 0 };

  const frameCount = last + 1;
  const stride = pathStride(frameCount, limit);

  const order: string[] = [];
  const samples = new Map<string, PathSample[]>();
  const identity = new Map<string, { name: string; side: MapSide | undefined }>();

  for (let index = 0; index <= last; index += 1) {
    if (index % stride !== 0 && index !== last) continue;
    const frame = frames[index];
    if (frame === undefined) continue;
    for (const player of frame.players) {
      const point = worldPoint(player);
      if (point === null) continue;
      let track = samples.get(player.id);
      if (track === undefined) {
        track = [];
        samples.set(player.id, track);
        order.push(player.id);
        identity.set(player.id, { name: player.name, side: normaliseSide(player.team) });
      }
      track.push({ ...point, tick: frame.tick });
    }
  }

  const paths: PlayerPath[] = [];
  for (const playerId of order) {
    const track = samples.get(playerId) ?? [];
    const who = identity.get(playerId);
    paths.push({
      playerId,
      playerName: who?.name ?? playerId,
      samples: track,
      ...(who?.side === undefined ? {} : { side: who.side }),
    });
  }

  return { paths, stride, frameCount };
}

/* ── the markers at the playhead ─────────────────────────────────────────── */

/**
 * 「选手位置」 — one square per living player at the current frame, which is the
 * first layer artboard 04 lists and the one thing a 2D replay cannot be without.
 *
 * There is no `domain/map` component for it (the directory has heat, paths,
 * duels and camera paths), and this round may not add one, so the view draws
 * the squares itself through `MapCanvas`'s projection callback. The shape of
 * the record is kept close to `PlayerPath` so promoting it into `domain/map`
 * later is a move, not a rewrite.
 */
export interface PlayerMarker {
  readonly playerId: string;
  readonly playerName: string;
  /** The first character of the name, which is what the artboard prints. */
  readonly initial: string;
  readonly x: number;
  readonly y: number;
  readonly side: MapSide | undefined;
  readonly health: number;
  readonly weapon: string;
}

/** Living players only: a corpse is not a position, and the kill is drawn. */
export function playerMarkers(frame: ReplayFrameRecord | null): readonly PlayerMarker[] {
  if (frame === null) return [];
  const markers: PlayerMarker[] = [];
  for (const player of frame.players) {
    if (!player.alive) continue;
    const point = worldPoint(player);
    if (point === null) continue;
    markers.push({
      playerId: player.id,
      playerName: player.name,
      initial: (player.name.trim()[0] ?? '?').toUpperCase(),
      x: point.x,
      y: point.y,
      side: normaliseSide(player.team),
      health: player.health,
      weapon: player.weapon,
    });
  }
  return markers;
}

/* ── duels ───────────────────────────────────────────────────────────────── */

/**
 * The kill-verified engagement axes of a set of events.
 *
 * Both endpoints are read out of the replay frame at the kill's tick. A kill
 * whose actor or target cannot be located in that frame produces no axis:
 * `skipped` counts those so the view can say 「N 条击杀没有位置样本」 rather than
 * quietly drawing fewer lines than the list has rows.
 *
 * `TimelineEvent.actor` / `.target` are free text on the wire — some producers
 * write the player id, others the display name — so both are tried, the id
 * first. Comparison is case-insensitive on the name because the two sources
 * disagree about capitalisation more often than about spelling.
 */
export interface EngagementBuild {
  readonly engagements: readonly Engagement[];
  readonly skipped: number;
}

export function buildEngagements(
  events: readonly RoundEvent[],
  frames: readonly ReplayFrameRecord[],
): EngagementBuild {
  const engagements: Engagement[] = [];
  let skipped = 0;

  for (const event of events) {
    if (event.event.kind !== 'kill') continue;
    const { actor, target } = event.event;
    if (actor === null || target === null) {
      skipped += 1;
      continue;
    }
    const frame = frameAtTick(frames, event.event.tick);
    const attacker = frame === null ? null : findPlayer(frame, actor);
    const victim = frame === null ? null : findPlayer(frame, target);
    if (attacker === null || victim === null) {
      skipped += 1;
      continue;
    }
    const attackerPoint = worldPoint(attacker);
    const victimPoint = worldPoint(victim);
    if (attackerPoint === null || victimPoint === null) {
      skipped += 1;
      continue;
    }

    const attackerSide = normaliseSide(attacker.team);
    const victimSide = normaliseSide(victim.team);

    engagements.push({
      id: event.event.id,
      tick: event.event.tick,
      round: event.round,
      attacker: {
        playerId: attacker.id,
        playerName: attacker.name,
        ...attackerPoint,
        ...(attackerSide === undefined ? {} : { side: attackerSide }),
      },
      victim: {
        playerId: victim.id,
        playerName: victim.name,
        ...victimPoint,
        ...(victimSide === undefined ? {} : { side: victimSide }),
      },
      weapon: event.event.weapon ?? '',
      headshot: event.event.headshot,
      throughWall: event.event.penetrated,
    });
  }

  return { engagements, skipped };
}

function findPlayer(frame: ReplayFrameRecord, who: string): ReplayPlayerRecord | null {
  const key = who.trim();
  if (key === '') return null;
  const byId = frame.players.find((player) => player.id === key);
  if (byId !== undefined) return byId;
  const lowered = key.toLowerCase();
  return frame.players.find((player) => player.name.trim().toLowerCase() === lowered) ?? null;
}

/* ── the event list ──────────────────────────────────────────────────────── */

/** One timeline event with the round it belongs to attached. */
export interface RoundEvent {
  readonly round: number;
  readonly event: TimelineEvent;
}

/**
 * The events of the selected round, or of the whole match when no round is
 * selected. Rounds carry their events inline (`AnalysisWorkspace.rounds[]`),
 * which is the only place a round number is attached to one.
 */
export function roundEvents(
  analysis: AnalysisWorkspace | undefined,
  round: number | null,
): readonly RoundEvent[] {
  if (analysis === undefined) return [];
  const rows: RoundEvent[] = [];
  for (const entry of analysis.rounds) {
    if (round !== null && entry.number !== round) continue;
    for (const event of entry.events) rows.push({ round: entry.number, event });
  }
  rows.sort((a, b) => a.event.tick - b.event.tick);
  return rows;
}

/**
 * Wire event kind → the closed evidence vocabulary, or `null` for the two the
 * workspace does not list.
 *
 * `damage` and `purchase` are `null` on purpose. A round holds dozens of each
 * and neither is a *moment* — damage is a running total the scoreboard already
 * states, and a purchase is economy, which the 道具与经济 view owns. Listing
 * them would push the kills the artboard draws off the panel.
 */
export const EVENT_EVIDENCE_KIND: Readonly<Record<TimelineEvent['kind'], EvidenceKind | null>> = {
  kill: 'kill',
  damage: null,
  round_start: 'round',
  round_end: 'round',
  bomb_plant: 'objective',
  bomb_defuse: 'objective',
  bomb_explode: 'objective',
  grenade: 'utility',
  purchase: null,
};

/** What artboard 04's right rail lists: kills and objective events. */
export const LISTED_EVIDENCE_KINDS: readonly EvidenceKind[] = ['kill', 'objective'];

export interface ReplayEventRow {
  readonly id: string;
  readonly tick: number;
  readonly round: number;
  readonly kind: EvidenceKind;
  readonly wireKind: TimelineEvent['kind'];
  readonly actor: string | null;
  readonly target: string | null;
  readonly weapon: string | null;
  readonly headshot: boolean;
  readonly penetrated: boolean;
}

/** The listable events of `rows`, in tick order, already narrowed to `kinds`. */
export function replayEventRows(
  rows: readonly RoundEvent[],
  kinds: readonly EvidenceKind[] = LISTED_EVIDENCE_KINDS,
): readonly ReplayEventRow[] {
  const wanted = new Set(kinds);
  const out: ReplayEventRow[] = [];
  for (const { round, event } of rows) {
    const kind = EVENT_EVIDENCE_KIND[event.kind];
    if (kind === null || !wanted.has(kind)) continue;
    out.push({
      id: event.id,
      tick: event.tick,
      round,
      kind,
      wireKind: event.kind,
      actor: event.actor,
      target: event.target,
      weapon: event.weapon,
      headshot: event.headshot,
      penetrated: event.penetrated,
    });
  }
  return out;
}

/** The row the playhead is inside — the last one at or before `tick`. */
export function currentEventId(rows: readonly ReplayEventRow[], tick: number | null): string | null {
  if (tick === null) return null;
  let current: string | null = null;
  for (const row of rows) {
    if (row.tick > tick) break;
    current = row.id;
  }
  return current;
}

/* ── heat ────────────────────────────────────────────────────────────────── */

/**
 * The positioned-event cloud, narrowed to the selected round.
 *
 * `HeatPointRecord.round` is nullable — a point the indexer could not attribute
 * to a round is kept only when no round is selected, because 「这一回合的位置」
 * must not include points that might belong to another one.
 */
export function heatSamplesOf(
  points: readonly HeatPointRecord[] | undefined,
  round: number | null,
): readonly HeatSample[] {
  if (points === undefined) return [];
  const samples: HeatSample[] = [];
  for (const point of points) {
    if (round !== null && point.round !== round) continue;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    samples.push({
      x: point.x,
      y: point.y,
      weight: Number.isFinite(point.weight) ? point.weight : 1,
      floor: point.floor,
    });
  }
  return samples;
}

/**
 * The floors the cloud actually occupies, ascending.
 *
 * Returned rather than assumed so the view can drop the 楼层 control entirely on
 * a single-storey map: §10.3 gap 6 left the decision to this phase, and a
 * two-option segment on Mirage would be a control that cannot change anything.
 */
export function heatFloors(points: readonly HeatPointRecord[] | undefined): readonly number[] {
  if (points === undefined) return [];
  const floors = new Set<number>();
  for (const point of points) {
    if (Number.isInteger(point.floor)) floors.add(point.floor);
  }
  return [...floors].sort((a, b) => a - b);
}

/* ── shared bits ─────────────────────────────────────────────────────────── */

function worldPoint(player: ReplayPlayerRecord): { x: number; y: number } | null {
  const [x, y] = player.position;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/**
 * `ReplayPlayerRecord.team` is free text — 「CT」/「T」 from the parser, 「A」/「B」
 * from the workspace projection. Only the two side spellings become a `MapSide`;
 * a team letter is not a side and is dropped rather than mapped to one, because
 * sides swap at the half and the letter does not.
 */
export function normaliseSide(team: string): MapSide | undefined {
  const key = team.trim().toUpperCase();
  if (key === 'CT') return 'CT';
  if (key === 'T') return 'T';
  return undefined;
}
