/*
 * `unit` project — one round, and the two retired tabs §7 folded into it.
 *
 * The survivor curve is a *derivation* (there is no alive count on the wire), so
 * the tests that matter are the ones that pin what it refuses to do: it never
 * rises, it never moves on a death it could not attribute, and it does not
 * divide by zero on a round whose start and end tick are the same.
 */

import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace } from '../../../shared/desktop/viewModels';
import {
  buildRoundDetail,
  curvePolylines,
  roundNeighbours,
  survivorCurve,
} from './roundDetail';
import { ANALYSIS, BARE_ANALYSIS } from './test/matchFixture';

const detail = buildRoundDetail(ANALYSIS, 5);

describe('building a round', () => {
  it('returns null for a round this match does not have', () => {
    expect(buildRoundDetail(ANALYSIS, 99)).toBeNull();
  });

  it('carries only the kills and the objective events onto the axis', () => {
    expect(detail).not.toBeNull();
    const round = ANALYSIS.rounds.find((entry) => entry.number === 5);
    // The round really does carry purchase and damage events; they are the noise
    // a 30-row table cannot hold, and 道具与经济 owns the throw lifecycle.
    expect(round?.events.some((event) => event.kind === 'purchase')).toBe(true);
    const kept = new Set(detail?.moments.map((moment) => moment.id));
    for (const event of round?.events ?? []) {
      if (event.kind === 'purchase' || event.kind === 'damage') {
        expect(kept.has(event.id)).toBe(false);
      }
    }
    expect(detail?.moments.every((moment) => moment.kind === 'kill')).toBe(true);
  });

  it('keeps the round’s whole event count, so the view can say what it left out', () => {
    const round = ANALYSIS.rounds.find((entry) => entry.number === 5);
    expect(detail?.eventCount).toBe(round?.events.length);
    expect(detail?.moments.length).toBeLessThan(detail?.eventCount ?? 0);
  });

  it('sorts by tick, because the wire promises no order', () => {
    const ticks = detail?.moments.map((moment) => moment.tick) ?? [];
    expect([...ticks].sort((left, right) => left - right)).toEqual(ticks);
  });

  it('resolves an actor named by id and one named by name alike', () => {
    // Round 3 is the one whose kills name their actor by display name.
    const byName = buildRoundDetail(ANALYSIS, 3);
    expect(byName?.moments[0]?.actor).toBe('Kael');
    expect(detail?.moments[0]?.actor).toBe('Kael');
  });
});

describe('the survivor curve', () => {
  it('starts at the roster sizes rather than at a hard-coded five', () => {
    expect(detail?.rosterA).toBe(5);
    expect(detail?.rosterB).toBe(5);
    const first = survivorCurve(detail as NonNullable<typeof detail>)[0];
    expect(first).toEqual({ at: 0, aliveA: 5, aliveB: 5 });
  });

  it('never rises: no event on the wire says a player came back', () => {
    const points = survivorCurve(detail as NonNullable<typeof detail>);
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      expect(current?.aliveA).toBeLessThanOrEqual(previous?.aliveA ?? 0);
      expect(current?.aliveB).toBeLessThanOrEqual(previous?.aliveB ?? 0);
    }
  });

  it('does not move on a kill whose target names nobody, and counts it instead', () => {
    // Round 5's first kill targets a player who is not on either roster.
    expect(detail?.unattributedKills).toBe(1);
    const first = detail?.moments[0];
    expect(first?.attributed).toBe(false);
    expect(first?.aliveA).toBe(5);
    expect(first?.aliveB).toBe(5);
  });

  it('spans the whole axis even when the last kill happened early', () => {
    const points = survivorCurve(detail as NonNullable<typeof detail>);
    expect(points[points.length - 1]?.at).toBe(1);
  });

  it('survives a zero-length round instead of dividing by zero', () => {
    const flat: AnalysisWorkspace = {
      ...ANALYSIS,
      rounds: ANALYSIS.rounds
        .filter((entry) => entry.number === 5)
        .map((entry) => ({ ...entry, end_tick: entry.start_tick })),
    };
    const degenerate = buildRoundDetail(flat, 5);
    const points = survivorCurve(degenerate as NonNullable<typeof degenerate>);
    expect(points.every((point) => Number.isFinite(point.at))).toBe(true);
  });

  it('draws a step, not a slope — a player is alive up to the tick they die', () => {
    const points = survivorCurve(detail as NonNullable<typeof detail>);
    const lines = curvePolylines(detail as NonNullable<typeof detail>, points);
    // Every coordinate is a finite number pair inside the unit box.
    for (const pair of `${lines.a} ${lines.b}`.split(' ')) {
      const [x, y] = pair.split(',').map(Number);
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      expect((x ?? 0) >= 0 && (x ?? 0) <= 1).toBe(true);
      expect((y ?? 0) >= 0 && (y ?? 0) <= 1).toBe(true);
    }
    // A step repeats an x with two different y values.
    expect(lines.a.split(' ').length).toBeGreaterThan(points.length);
  });

  it('shares one axis between the two lines', () => {
    const lopsided = buildRoundDetail(
      { ...ANALYSIS, players: ANALYSIS.players.filter((player) => player.team === 'A') },
      5,
    );
    expect(lopsided?.rosterB).toBe(0);
    const lines = curvePolylines(
      lopsided as NonNullable<typeof lopsided>,
      survivorCurve(lopsided as NonNullable<typeof lopsided>),
    );
    // Team B is flat on the floor of the shared axis, not on a floor of its own.
    expect(lines.b.split(' ').every((pair) => pair.endsWith(',1'))).toBe(true);
  });
});

describe('walking between rounds', () => {
  it('uses the list, not number ± 1, so a gap cannot strand the view', () => {
    const gapped = ANALYSIS.rounds.filter((entry) => entry.number !== 4);
    expect(roundNeighbours(gapped, 3)).toEqual({ previous: 2, next: 5 });
  });

  it('has no neighbours at the ends, and none at all with nothing selected', () => {
    expect(roundNeighbours(ANALYSIS.rounds, 1).previous).toBeNull();
    expect(roundNeighbours(ANALYSIS.rounds, 24).next).toBeNull();
    expect(roundNeighbours(ANALYSIS.rounds, null)).toEqual({ previous: null, next: null });
    expect(roundNeighbours(ANALYSIS.rounds, 99)).toEqual({ previous: null, next: null });
  });
});

describe('a parse that produced no events', () => {
  it('yields a round with an empty axis rather than throwing', () => {
    const bare = buildRoundDetail(BARE_ANALYSIS, 5);
    expect(bare?.moments).toEqual([]);
    expect(bare?.objectives).toEqual([]);
    expect(bare?.eventCount).toBe(0);
    expect(survivorCurve(bare as NonNullable<typeof bare>)).toHaveLength(2);
  });
});
