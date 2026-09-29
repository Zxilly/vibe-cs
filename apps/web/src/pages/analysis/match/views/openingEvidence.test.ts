import { describe, expect, it } from 'vitest';

import type { TimelineEvent } from '../../../../shared/desktop/dto';
import { openingEvidence } from './openingEvidence';
import { ANALYSIS, ROUNDS } from './test/rosterFixtures';

const round = ROUNDS[0]!;
const identified = round.events[1]!;

describe('one opening evidence projection for all match views', () => {
  it.each([
    { actor: null, target: 'sable' },
    { actor: 'kael', target: null },
    { actor: 'departed', target: 'sable' },
    { actor: 'kael', target: 'departed' },
  ])('keeps the actual first event unavailable when its participants cannot be verified: %j', (identity) => {
    const first = { ...identified, ...identity, id: 'first', tick: 10_050 };
    const result = openingEvidence([{ ...round, events: [identified, first] }], ANALYSIS.players);
    expect(result).toMatchObject({ a: 0, b: 0, rounds: 1, unattributed: 1, complete: false, duels: [] });
    expect(result.tallies.size).toBe(0);
  });

  it('resolves unique event names to the same canonical IDs used by all counters and navigation', () => {
    const first: TimelineEvent = { ...identified, actor: 'Kael', target: 'Sable' };
    const result = openingEvidence([{ ...round, events: [first] }], ANALYSIS.players);
    expect(result).toMatchObject({ a: 1, b: 0, rounds: 1, unattributed: 0, complete: true });
    expect(result.duels[0]).toMatchObject({ eventId: first.id, killerId: 'kael', victimId: 'sable', tick: first.tick });
    expect(result.tallies.get('kael')).toEqual({ kills: 1, deaths: 0 });
    expect(result.tallies.get('sable')).toEqual({ kills: 0, deaths: 1 });
    expect(result.tallies.has('Kael')).toBe(false);
  });

  it('rejects an ambiguous name while retaining an exact canonical ID', () => {
    const players = ANALYSIS.players.map((player) => player.id === 'rhea' ? { ...player, name: 'Kael' } : player);
    const named = { ...round, events: [{ ...identified, actor: 'Kael' }] };
    expect(openingEvidence([named], players)).toMatchObject({ complete: false, unattributed: 1, duels: [] });
    expect(openingEvidence([{ ...named, events: [identified] }], players)).toMatchObject({ complete: true, a: 1 });
  });

  it('keeps verified rows inspectable but refuses to present partial counts as exact totals', () => {
    const result = openingEvidence(ROUNDS, ANALYSIS.players);
    expect(result).toMatchObject({ rounds: 3, unattributed: 1, complete: false, a: 1, b: 1 });
    expect(result.duels.map((duel) => [duel.round, duel.tick])).toEqual([[2, 20_100], [3, 30_100]]);
  });

  it('does not confuse a missing event stream with an unverified kill', () => {
    expect(openingEvidence([{ ...round, events: [] }], ANALYSIS.players))
      .toMatchObject({ rounds: 0, unattributed: 0, complete: false, duels: [] });
    expect(openingEvidence([{ ...round, events: [round.events[0]!] }], ANALYSIS.players))
      .toMatchObject({ rounds: 1, unattributed: 1, complete: false, duels: [] });
  });
});
