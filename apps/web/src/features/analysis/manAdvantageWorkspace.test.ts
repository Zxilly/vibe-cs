import { describe, expect, it } from 'vitest';

import type {
  AnalysisWorkspace,
  PlayerAnalysis,
  TimelineEvent,
} from '../../shared/desktop/dto';
import { buildManAdvantageWorkspace } from './manAdvantageWorkspace';

const teamA = ['a1', 'a2', 'a3', 'a4', 'a5'];
const teamB = ['b1', 'b2', 'b3', 'b4', 'b5'];

const player = (id: string, team: PlayerAnalysis['team']): PlayerAnalysis => ({
  id,
  name: id.toLocaleUpperCase(),
  team,
  kills: 0,
  deaths: 0,
  assists: 0,
  headshot_rate: 0,
  kill_death_ratio: 0,
  adr: 0,
});

const event = (
  id: string,
  tick: number,
  kind: TimelineEvent['kind'],
  overrides: Partial<TimelineEvent> = {},
): TimelineEvent => ({
  id,
  tick,
  seconds: tick / 64,
  kind,
  actor: null,
  target: null,
  weapon: null,
  headshot: false,
  penetrated: false,
  position: null,
  detail: {},
  ...overrides,
});

function workspace(): AnalysisWorkspace {
  const roster = Object.fromEntries([
    ...teamA.map((id) => [id, 'T']),
    ...teamB.map((id) => [id, 'CT']),
  ]);
  return {
    demo_id: 'major-m1',
    map_name: 'de_mirage',
    tick_rate: 64,
    duration_seconds: 60,
    teams: [
      { name: 'Team A', side: 'A', score: 1, players: teamA },
      { name: 'Team B', side: 'B', score: 0, players: teamB },
    ],
    players: [...teamA.map((id) => player(id, 'A')), ...teamB.map((id) => player(id, 'B'))],
    rounds: [{
      number: 1,
      winner: 'A',
      reason: 'elimination',
      start_tick: 1_000,
      end_tick: 2_000,
      team_a_score: 1,
      team_b_score: 0,
      events: [
        event('start-r1', 1_000, 'round_start', { detail: { _round_roster: roster } }),
        event('kill-a1-b1', 1_200, 'kill', {
          actor: 'a1',
          target: 'b1',
          weapon: 'ak47',
        }),
        event('kill-b2-a1', 1_400, 'kill', {
          actor: 'b2',
          target: 'a1',
          weapon: 'm4a1',
        }),
        event('end-r1', 2_000, 'round_end'),
      ],
    }],
    highlights: [],
  };
}

describe('man advantage workspace', () => {
  it('reconstructs exact remaining-uneliminated transitions from canonical death targets', () => {
    const result = buildManAdvantageWorkspace(workspace());

    expect(result.availability).toEqual({
      state: 'available',
      reason: null,
      failure_code: null,
      failure_round: null,
    });
    expect(result.rounds[0]).toMatchObject({
      round: 1,
      state: 'available',
      winner: 'A',
      first_lead_team: 'A',
      first_lead_won: true,
      lead_changes: 0,
      remaining_after_deaths: { A: 4, B: 4 },
    });
    expect(result.rounds[0]?.transitions.map((transition) => ({
      tick: transition.tick,
      before: transition.remaining_before,
      after: transition.remaining_after,
      source_ids: transition.deaths.map((death) => death.source_id),
    }))).toEqual([
      {
        tick: 1_200,
        before: { A: 5, B: 5 },
        after: { A: 5, B: 4 },
        source_ids: ['kill-a1-b1'],
      },
      {
        tick: 1_400,
        before: { A: 5, B: 4 },
        after: { A: 4, B: 4 },
        source_ids: ['kill-b2-a1'],
      },
    ]);
  });

  it('applies every death at the same tick as one simultaneous state transition', () => {
    const sameTick = workspace();
    const secondKill = sameTick.rounds[0]?.events.find((item) => item.id === 'kill-b2-a1');
    if (!secondKill) throw new Error('The fixture must contain the second kill.');
    secondKill.tick = 1_200;
    secondKill.seconds = 1_200 / 64;

    const result = buildManAdvantageWorkspace(sameTick);

    expect(result.rounds[0]?.transitions).toHaveLength(1);
    expect(result.rounds[0]?.transitions[0]).toMatchObject({
      tick: 1_200,
      remaining_before: { A: 5, B: 5 },
      remaining_after: { A: 4, B: 4 },
      leading_team_after: null,
    });
    expect(result.rounds[0]?.transitions[0]?.deaths.map((death) => death.source_id)).toEqual([
      'kill-a1-b1',
      'kill-b2-a1',
    ]);
    expect(result.rounds[0]).toMatchObject({
      first_lead_team: null,
      first_lead_won: null,
      lead_changes: 0,
    });
  });

  it('keeps actorless and same-team deaths explicit while decrementing only the target team', () => {
    const provenance = workspace();
    const actorless = provenance.rounds[0]?.events.find((item) => item.id === 'kill-a1-b1');
    const teamKill = provenance.rounds[0]?.events.find((item) => item.id === 'kill-b2-a1');
    if (!actorless || !teamKill) throw new Error('The fixture must contain both deaths.');
    actorless.actor = null;
    teamKill.actor = 'a2';

    const result = buildManAdvantageWorkspace(provenance);
    const deaths = result.rounds[0]?.transitions.flatMap((transition) => transition.deaths);

    expect(deaths?.map((death) => ({
      source_id: death.source_id,
      actor_id: death.actor_id,
      target_team: death.target_team,
      relation: death.elimination_relation,
    }))).toEqual([
      {
        source_id: 'kill-a1-b1',
        actor_id: null,
        target_team: 'B',
        relation: 'unattributed',
      },
      {
        source_id: 'kill-b2-a1',
        actor_id: 'a2',
        target_team: 'A',
        relation: 'same_team',
      },
    ]);
    expect(result.rounds[0]?.remaining_after_deaths).toEqual({ A: 4, B: 4 });
  });

  it('marks a round unavailable when a death lies outside its verified tick bounds', () => {
    const outsideBounds = workspace();
    const kill = outsideBounds.rounds[0]?.events.find((item) => item.id === 'kill-a1-b1');
    if (!kill) throw new Error('The fixture must contain a kill.');
    kill.tick = 999;

    const result = buildManAdvantageWorkspace(outsideBounds);

    expect(result.rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'kill_outside_round_bounds',
      transitions: [],
      remaining_after_deaths: null,
    });
    expect(result.availability).toMatchObject({
      state: 'unavailable',
      failure_code: 'kill_outside_round_bounds',
      failure_round: 1,
    });
    expect(result.summary).toMatchObject({
      total_rounds: 1,
      verified_rounds: 0,
      unavailable_rounds: 1,
    });
  });

  it('treats non-finite ticks as out of bounds instead of emitting unlocatable evidence', () => {
    const invalidTick = workspace();
    const kill = invalidTick.rounds[0]?.events.find((item) => item.id === 'kill-a1-b1');
    if (!kill) throw new Error('The fixture must contain a kill.');
    kill.tick = Number.NaN;

    const result = buildManAdvantageWorkspace(invalidTick);

    expect(result.rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'kill_outside_round_bounds',
      transitions: [],
    });
  });

  it('fails the whole round closed when a death target is absent', () => {
    const missingTarget = workspace();
    const kill = missingTarget.rounds[0]?.events.find((item) => item.id === 'kill-a1-b1');
    if (!kill) throw new Error('The fixture must contain a kill.');
    kill.target = null;

    const result = buildManAdvantageWorkspace(missingTarget);

    expect(result.rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'missing_target',
      transitions: [],
    });
  });

  it('fails the whole round closed when a death target is outside the verified roster', () => {
    const unknownTarget = workspace();
    const kill = unknownTarget.rounds[0]?.events.find((item) => item.id === 'kill-a1-b1');
    if (!kill) throw new Error('The fixture must contain a kill.');
    kill.target = 'unknown-player';

    const result = buildManAdvantageWorkspace(unknownTarget);

    expect(result.rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'unknown_target',
      transitions: [],
    });
  });

  it('fails the whole round closed when a non-null actor is outside the verified roster', () => {
    const unknownActor = workspace();
    const kill = unknownActor.rounds[0]?.events.find((item) => item.id === 'kill-a1-b1');
    if (!kill) throw new Error('The fixture must contain a kill.');
    kill.actor = 'unknown-player';

    const result = buildManAdvantageWorkspace(unknownActor);

    expect(result.rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'unknown_actor',
      transitions: [],
    });
  });

  it('rejects two same-tick death events for the same target instead of ordering them', () => {
    const duplicateAtTick = workspace();
    const secondKill = duplicateAtTick.rounds[0]?.events.find(
      (item) => item.id === 'kill-b2-a1',
    );
    if (!secondKill) throw new Error('The fixture must contain the second kill.');
    secondKill.tick = 1_200;
    secondKill.target = 'b1';

    const result = buildManAdvantageWorkspace(duplicateAtTick);

    expect(result.rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'duplicate_target_same_tick',
      transitions: [],
    });
  });

  it('rejects a later death event for a target already eliminated in the round', () => {
    const repeatedTarget = workspace();
    const secondKill = repeatedTarget.rounds[0]?.events.find(
      (item) => item.id === 'kill-b2-a1',
    );
    if (!secondKill) throw new Error('The fixture must contain the second kill.');
    secondKill.target = 'b1';

    const result = buildManAdvantageWorkspace(repeatedTarget);

    expect(result.rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'target_already_eliminated',
      transitions: [],
    });
  });

  it('rejects duplicate canonical kill IDs instead of creating ambiguous evidence links', () => {
    const duplicateId = workspace();
    const secondKill = duplicateId.rounds[0]?.events.find((item) => item.id === 'kill-b2-a1');
    if (!secondKill) throw new Error('The fixture must contain the second kill.');
    secondKill.id = 'kill-a1-b1';

    const result = buildManAdvantageWorkspace(duplicateId);

    expect(result.rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'duplicate_event_id',
      transitions: [],
    });
  });

  it('rejects a death ID that collides with any canonical source event', () => {
    const crossKindCollision = workspace();
    const kill = crossKindCollision.rounds[0]?.events.find((item) => item.id === 'kill-a1-b1');
    if (!kill) throw new Error('The fixture must contain a kill.');
    kill.id = 'start-r1';

    const result = buildManAdvantageWorkspace(crossKindCollision);

    expect(result.rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'duplicate_event_id',
      transitions: [],
    });
  });

  it('rejects a death ID shared with a non-death event in another round', () => {
    const crossRoundCollision = workspace();
    const copiedRound = structuredClone(crossRoundCollision.rounds[0]);
    if (!copiedRound) throw new Error('The fixture must contain a round.');
    copiedRound.number = 2;
    copiedRound.start_tick = 3_000;
    copiedRound.end_tick = 4_000;
    copiedRound.events = [
      event('start-r2', 3_000, 'round_start', {
        detail: copiedRound.events.find((item) => item.kind === 'round_start')?.detail ?? {},
      }),
      event('kill-a1-b1', 3_500, 'damage', { actor: 'a1', target: 'b1' }),
      event('end-r2', 4_000, 'round_end'),
    ];
    crossRoundCollision.rounds.push(copiedRound);

    const result = buildManAdvantageWorkspace(crossRoundCollision);

    expect(result.rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'duplicate_event_id',
      transitions: [],
    });
  });

  it('requires exactly one in-bounds round-end event', () => {
    const duplicateEnd = workspace();
    duplicateEnd.rounds[0]?.events.push(event('end-r1-duplicate', 2_000, 'round_end'));

    const result = buildManAdvantageWorkspace(duplicateEnd);

    expect(result.rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'ambiguous_round_end',
      round_end_evidence_id: null,
      transitions: [],
    });
  });

  it('rejects a round-end ID that cannot identify one canonical source event', () => {
    const duplicateEndId = workspace();
    const roundEnd = duplicateEndId.rounds[0]?.events.find((item) => item.kind === 'round_end');
    if (!roundEnd) throw new Error('The fixture must contain a round-end event.');
    roundEnd.id = 'start-r1';

    const result = buildManAdvantageWorkspace(duplicateEndId);

    expect(result.rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'duplicate_event_id',
      round_end_evidence_id: null,
      transitions: [],
    });
  });

  it('fails the match closed when round numbers cannot identify one canonical round', () => {
    const duplicateRound = workspace();
    const copiedRound = structuredClone(duplicateRound.rounds[0]);
    if (!copiedRound) throw new Error('The fixture must contain a round.');
    copiedRound.events.forEach((item) => { item.id = `${item.id}-copy`; });
    duplicateRound.rounds.push(copiedRound);

    const result = buildManAdvantageWorkspace(duplicateRound);

    expect(result.rounds).toEqual([]);
    expect(result.availability).toMatchObject({
      state: 'unavailable',
      failure_code: 'duplicate_round_number',
      failure_round: 1,
    });
    expect(result.summary).toMatchObject({
      total_rounds: 2,
      verified_rounds: 0,
      unavailable_rounds: 2,
    });
  });

  it('fails the match closed when a source round number cannot be deep-linked exactly', () => {
    const invalidRound = workspace();
    if (!invalidRound.rounds[0]) throw new Error('The fixture must contain a round.');
    invalidRound.rounds[0].number = Number.NaN;

    const result = buildManAdvantageWorkspace(invalidRound);

    expect(result.rounds).toEqual([]);
    expect(result.availability).toMatchObject({
      state: 'unavailable',
      failure_code: 'invalid_round_number',
    });
  });
});
