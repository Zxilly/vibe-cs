import type { PlayerAnalysis, RoundSummary } from '../../../../shared/desktop/viewModels';

export interface OpeningDuel {
  readonly round: number;
  readonly eventId: string;
  readonly tick: number;
  readonly killerId: string;
  readonly victimId: string;
  readonly weapon: string | null;
  readonly headshot: boolean;
  readonly penetrated: boolean;
}

export interface OpeningTally {
  readonly kills: number;
  readonly deaths: number;
}

export interface OpeningEvidence {
  readonly a: number;
  readonly b: number;
  /** Rounds with a kill event, including those that cannot be attributed. */
  readonly rounds: number;
  readonly unattributed: number;
  /** Exact totals are available only when every observed opening is verified. */
  readonly complete: boolean;
  readonly duels: readonly OpeningDuel[];
  readonly tallies: ReadonlyMap<string, OpeningTally>;
}

/**
 * The earliest kill is selected before identity resolution. A missing identity
 * makes that round unavailable; a later event never becomes its opening.
 * All three match views consume this same evidence and canonical player IDs.
 */
export function openingEvidence(
  rounds: readonly RoundSummary[],
  players: readonly PlayerAnalysis[],
): OpeningEvidence {
  const ids = new Map<string, PlayerAnalysis | null>();
  const names = new Map<string, PlayerAnalysis | null>();
  for (const player of players) {
    if (player.id === '') continue;
    ids.set(player.id, ids.has(player.id) ? null : player);
    if (player.name !== '') names.set(player.name, names.has(player.name) ? null : player);
  }
  const resolve = (identity: string | null): PlayerAnalysis | null => identity === null
    ? null
    : (ids.has(identity) ? ids.get(identity) : names.get(identity)) ?? null;
  const duels: OpeningDuel[] = [];
  const tallies = new Map<string, { kills: number; deaths: number }>();
  const tally = (id: string) => {
    const existing = tallies.get(id);
    if (existing !== undefined) return existing;
    const created = { kills: 0, deaths: 0 };
    tallies.set(id, created);
    return created;
  };
  let a = 0;
  let b = 0;
  let counted = 0;
  let unattributed = 0;
  for (const round of rounds) {
    const first = round.events.reduce<RoundSummary['events'][number] | null>((earliest, event) => (
      event.kind === 'kill' && (earliest === null || event.tick < earliest.tick) ? event : earliest
    ), null);
    if (first === null) continue;
    counted += 1;
    const killer = resolve(first.actor);
    const victim = resolve(first.target);
    if (killer === null || victim === null) {
      unattributed += 1;
      continue;
    }
    if (killer.team === 'A') a += 1;
    else b += 1;
    tally(killer.id).kills += 1;
    tally(victim.id).deaths += 1;
    duels.push({
      round: round.number,
      eventId: first.id,
      tick: first.tick,
      killerId: killer.id,
      victimId: victim.id,
      weapon: first.weapon,
      headshot: first.headshot,
      penetrated: first.penetrated,
    });
  }
  return {
    a, b, rounds: counted, unattributed,
    complete: counted > 0 && unattributed === 0,
    duels: duels.sort((left, right) => left.round - right.round),
    tallies,
  };
}
