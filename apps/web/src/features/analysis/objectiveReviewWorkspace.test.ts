import { describe, expect, it } from 'vitest';

import type {
  AnalysisWorkspace,
  PlayerAnalysis,
  TimelineEvent,
} from '../../shared/desktop/dto';
import { buildObjectiveReviewWorkspace } from './objectiveReviewWorkspace';

const teamA = ['a1', 'a2', 'a3', 'a4', 'a5'] as const;
const teamB = ['b1', 'b2', 'b3', 'b4', 'b5'] as const;

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
      { name: 'Team A', side: 'A', score: 1, players: [...teamA] },
      { name: 'Team B', side: 'B', score: 0, players: [...teamB] },
    ],
    players: [...teamA.map((id) => player(id, 'A')), ...teamB.map((id) => player(id, 'B'))],
    rounds: [{
      number: 1,
      winner: 'A',
      reason: 'target_bombed',
      start_tick: 1_000,
      end_tick: 2_000,
      team_a_score: 1,
      team_b_score: 0,
      events: [
        event('start-r1', 1_000, 'round_start', { detail: { _round_roster: roster } }),
        event('plant-r1', 1_200, 'bomb_plant', {
          actor: 'a1',
          detail: { site: 407, userteam: 2 },
        }),
        event('explode-r1', 1_900, 'bomb_explode', { actor: 'a1' }),
        event('end-r1', 1_900, 'round_end'),
      ],
    }],
    highlights: [],
  };
}

describe('objective review workspace', () => {
  it('projects one canonical plant with stable Team A/B and the planting-round T side', () => {
    const result = buildObjectiveReviewWorkspace(workspace());

    expect(result.availability).toEqual({
      state: 'available',
      reason: null,
      failure_code: null,
      failure_round: null,
    });
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]).toMatchObject({
      round: 1,
      plant: {
        evidence_id: 'demo:major-m1/event:plant-r1',
        source_id: 'plant-r1',
        tick: 1_200,
        actor_id: 'a1',
        actor_name: 'A1',
        actor_team: 'A',
        actor_side: 'T',
        raw_site_code: '407',
      },
      winner: 'A',
      terminal: {
        kind: 'explode',
        evidence_id: 'demo:major-m1/event:explode-r1',
        tick: 1_900,
      },
      round_end_evidence_id: 'demo:major-m1/event:end-r1',
      round_end: {
        evidence_id: 'demo:major-m1/event:end-r1',
        source_id: 'end-r1',
        tick: 1_900,
      },
    });
  });

  it('keeps a no-terminal post-plant window and folds same-tick damage without inventing order', () => {
    const source = workspace();
    source.rounds[0]!.reason = 'terrorists_win';
    source.rounds[0]!.events = source.rounds[0]!.events.filter((item) => item.kind !== 'bomb_explode');
    source.rounds[0]!.events.splice(2, 0,
      event('damage-z', 1_400, 'damage', {
        actor: 'a2',
        target: 'b2',
        detail: { dmg_health: 18 },
      }),
      event('kill-a', 1_400, 'kill', {
        actor: 'a1',
        target: 'b1',
        weapon: 'ak47',
      }),
      event('damage-a', 1_400, 'damage', {
        actor: 'b3',
        target: 'a3',
        detail: { dmg_health: 7 },
      }),
    );

    const round = buildObjectiveReviewWorkspace(source).rounds[0];

    expect(round).toMatchObject({ state: 'available', terminal: null });
    expect(round?.timeline_groups.map((group) => ({
      tick: group.tick,
      ids: group.atomic_event_ids,
      damage_count: group.damage_event_count,
      damage_total: group.damage_total,
    }))).toEqual([
      { tick: 1_200, ids: ['plant-r1'], damage_count: 0, damage_total: 0 },
      {
        tick: 1_400,
        ids: ['damage-a', 'damage-z', 'kill-a'],
        damage_count: 2,
        damage_total: 25,
      },
      { tick: 1_900, ids: ['end-r1'], damage_count: 0, damage_total: 0 },
    ]);
    expect(round?.timeline_groups[1]?.atoms.map((atom) => atom.kind)).toEqual([
      'damage',
      'damage',
      'kill',
    ]);
  });

  it('fails the round closed when more than one terminal objective event claims the plant window', () => {
    const source = workspace();
    source.rounds[0]!.events.splice(3, 0,
      event('defuse-r1', 1_850, 'bomb_defuse', { actor: 'b1' }),
    );

    expect(buildObjectiveReviewWorkspace(source).rounds[0]).toMatchObject({
      round: 1,
      state: 'unavailable',
      reason_code: 'ambiguous_terminal',
      plant: null,
      terminal: null,
      timeline_groups: [],
    });
  });

  it('fails closed when a canonical source ID is empty or duplicated', () => {
    const duplicate = workspace();
    duplicate.rounds[0]!.events.at(-1)!.id = 'plant-r1';

    expect(buildObjectiveReviewWorkspace(duplicate).rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'duplicate_event_id',
    });

    const empty = workspace();
    empty.rounds[0]!.events[1]!.id = '   ';

    expect(buildObjectiveReviewWorkspace(empty).rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'duplicate_event_id',
    });
  });

  it('does not publish a plant round without an exact Team A/B winner', () => {
    const source = workspace();
    source.rounds[0]!.winner = 'unknown' as 'A';

    expect(buildObjectiveReviewWorkspace(source).rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'unknown_round_winner',
      winner: null,
    });
  });

  it('fails closed when present round-end winner aliases conflict with the verified Team A/B winner', () => {
    const invalid = workspace();
    invalid.rounds[0]!.events.find((candidate) => candidate.kind === 'round_end')!.detail = {
      winner: 99,
    };
    expect(buildObjectiveReviewWorkspace(invalid).rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'round_end_winner_conflict',
    });

    const conflictingAliases = workspace();
    conflictingAliases.rounds[0]!.events.find(
      (candidate) => candidate.kind === 'round_end',
    )!.detail = { winner: 2, winner_name: 'CT' };
    expect(buildObjectiveReviewWorkspace(conflictingAliases).rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'round_end_winner_conflict',
    });
  });

  it('requires exactly one in-bounds canonical round end at or after the plant', () => {
    const beforePlant = workspace();
    beforePlant.rounds[0]!.events.at(-1)!.tick = 1_100;
    expect(buildObjectiveReviewWorkspace(beforePlant).rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'round_end_before_plant',
    });

    const ambiguous = workspace();
    ambiguous.rounds[0]!.events.push(event('end-r1-second', 1_950, 'round_end'));
    expect(buildObjectiveReviewWorkspace(ambiguous).rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'ambiguous_round_end',
    });

    const outOfBounds = workspace();
    outOfBounds.rounds[0]!.events.at(-1)!.tick = 2_001;
    expect(buildObjectiveReviewWorkspace(outOfBounds).rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'missing_round_end',
    });
  });

  it('rejects kill and damage atoms whose required target is missing or outside the roster', () => {
    const unknownTarget = workspace();
    unknownTarget.rounds[0]!.events.splice(2, 0,
      event('kill-unknown', 1_400, 'kill', { actor: 'a2', target: 'not-in-roster' }),
    );
    expect(buildObjectiveReviewWorkspace(unknownTarget).rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'unknown_target',
    });

    const missingTarget = workspace();
    missingTarget.rounds[0]!.events.splice(2, 0,
      event('damage-missing', 1_400, 'damage', { actor: 'a2', target: null }),
    );
    expect(buildObjectiveReviewWorkspace(missingTarget).rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'missing_target',
    });
  });

  it('keeps actorless encounter evidence explicit but rejects a non-null actor outside the roster', () => {
    const actorless = workspace();
    actorless.rounds[0]!.events.splice(2, 0,
      event('kill-actorless', 1_400, 'kill', { actor: null, target: 'b1' }),
    );
    const actorlessAtom = buildObjectiveReviewWorkspace(actorless).rounds[0]
      ?.timeline_groups.flatMap((group) => group.atoms)
      .find((atom) => atom.source_id === 'kill-actorless');
    expect(actorlessAtom).toMatchObject({ actor_id: null, actor_name: null, target_id: 'b1' });

    const unknownActor = workspace();
    unknownActor.rounds[0]!.events.splice(2, 0,
      event('damage-unknown-actor', 1_400, 'damage', {
        actor: 'not-in-roster',
        target: 'b1',
      }),
    );
    expect(buildObjectiveReviewWorkspace(unknownActor).rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'unknown_actor',
    });
  });

  it('requires a canonical CT actor for defuse and a null-or-canonical actor for explosion', () => {
    const wrongSideDefuse = workspace();
    const terminal = wrongSideDefuse.rounds[0]!.events[2]!;
    terminal.kind = 'bomb_defuse';
    terminal.actor = 'a2';
    expect(buildObjectiveReviewWorkspace(wrongSideDefuse).rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'defuse_actor_side_mismatch',
    });

    const missingDefuser = workspace();
    missingDefuser.rounds[0]!.events[2]!.kind = 'bomb_defuse';
    missingDefuser.rounds[0]!.events[2]!.actor = null;
    expect(buildObjectiveReviewWorkspace(missingDefuser).rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'missing_defuse_actor',
    });

    const actorlessExplosion = workspace();
    actorlessExplosion.rounds[0]!.events[2]!.actor = null;
    expect(buildObjectiveReviewWorkspace(actorlessExplosion).rounds[0]).toMatchObject({
      state: 'available',
      terminal: { kind: 'explode', actor_id: null },
    });

    const unknownExplosionActor = workspace();
    unknownExplosionActor.rounds[0]!.events[2]!.actor = 'not-in-roster';
    expect(buildObjectiveReviewWorkspace(unknownExplosionActor).rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'unknown_terminal_actor',
    });
  });

  it('marks a damage tick total unavailable when any canonical damage atom lacks decoded health damage', () => {
    const source = workspace();
    source.rounds[0]!.events.splice(2, 0,
      event('damage-known', 1_400, 'damage', {
        actor: 'a2', target: 'b2', detail: { dmg_health: 12 },
      }),
      event('damage-undecoded', 1_400, 'damage', {
        actor: 'b3', target: 'a3', detail: {},
      }),
    );

    expect(buildObjectiveReviewWorkspace(source).rounds[0]?.timeline_groups[1]).toMatchObject({
      damage_event_count: 2,
      damage_total: null,
    });
  });

  it('summarizes only verified plant rounds and their canonical post-plant atoms', () => {
    const source = workspace();
    source.rounds[0]!.events.splice(2, 0,
      event('kill-r1', 1_300, 'kill', { actor: 'a2', target: 'b2' }),
      event('damage-r1', 1_350, 'damage', {
        actor: 'b3', target: 'a3', detail: { dmg_health: 22 },
      }),
    );

    expect(buildObjectiveReviewWorkspace(source).summary).toEqual({
      total_rounds: 1,
      plant_rounds: 1,
      verified_plant_rounds: 1,
      unavailable_plant_rounds: 0,
      planting_team_wins: 1,
      planting_team_losses: 0,
      defuses: 0,
      explosions: 1,
      no_terminal_events: 0,
      post_plant_kills: 1,
      post_plant_damage: 1,
    });
  });

  it('requires positive unique round numbers before constructing objective deep links', () => {
    const invalid = workspace();
    invalid.rounds[0]!.number = 0;
    expect(buildObjectiveReviewWorkspace(invalid).availability).toMatchObject({
      state: 'unavailable',
      failure_code: 'invalid_round_number',
    });

    const duplicate = workspace();
    duplicate.rounds.push({
      ...structuredClone(duplicate.rounds[0]!),
      start_tick: 3_000,
      end_tick: 4_000,
      events: [
        event('start-r1-again', 3_000, 'round_start', {
          detail: duplicate.rounds[0]!.events[0]!.detail as Record<string, unknown>,
        }),
      ],
    });
    expect(buildObjectiveReviewWorkspace(duplicate).availability).toMatchObject({
      state: 'unavailable',
      failure_code: 'duplicate_round_number',
      failure_round: 1,
    });
  });

  it('rejects a terminal objective result that contradicts the verified winning team', () => {
    const defuseWithPlantingWin = workspace();
    defuseWithPlantingWin.rounds[0]!.events[2]!.kind = 'bomb_defuse';
    defuseWithPlantingWin.rounds[0]!.events[2]!.actor = 'b1';
    expect(buildObjectiveReviewWorkspace(defuseWithPlantingWin).rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'terminal_winner_mismatch',
    });

    const explosionWithCtWin = workspace();
    explosionWithCtWin.rounds[0]!.winner = 'B';
    expect(buildObjectiveReviewWorkspace(explosionWithCtWin).rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'terminal_winner_mismatch',
    });
  });

  it('requires every published atom to stay inside the canonical plant-to-round-end window', () => {
    const source = workspace();
    source.rounds[0]!.events.splice(2, 0,
      event('kill-after-round-end', 1_950, 'kill', { actor: 'a2', target: 'b2' }),
    );
    source.rounds[0]!.events.at(-1)!.tick = 1_900;

    const result = buildObjectiveReviewWorkspace(source);
    const publishedIds = result.rounds[0]?.timeline_groups.flatMap((group) => group.atomic_event_ids);
    expect(publishedIds).not.toContain('kill-after-round-end');
    expect(result.rounds[0]).toMatchObject({ state: 'available' });
  });

  it('fails closed when a decoded raw plant or defuse side contradicts the verified round roster', () => {
    const plantConflict = workspace();
    plantConflict.rounds[0]!.events.find((candidate) => candidate.kind === 'bomb_plant')!.detail = {
      userteam: 3,
    };
    expect(buildObjectiveReviewWorkspace(plantConflict).rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'plant_actor_side_conflict',
    });

    const defuseConflict = workspace();
    defuseConflict.rounds[0]!.winner = 'B';
    const terminal = defuseConflict.rounds[0]!.events.find(
      (candidate) => candidate.kind === 'bomb_explode',
    )!;
    terminal.kind = 'bomb_defuse';
    terminal.actor = 'b1';
    terminal.detail = { userteam: 2 };
    expect(buildObjectiveReviewWorkspace(defuseConflict).rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'terminal_actor_side_conflict',
    });
  });

  it('rejects a post-plant atom whose tick is not a safe integer', () => {
    const source = workspace();
    source.rounds[0]!.events.splice(2, 0,
      event('damage-fractional-tick', 1_400.5, 'damage', {
        actor: 'a2', target: 'b2', detail: { dmg_health: 10 },
      }),
    );

    expect(buildObjectiveReviewWorkspace(source).rounds[0]).toMatchObject({
      state: 'unavailable',
      reason_code: 'atom_tick_invalid',
    });
  });

  it('distinguishes ambiguous, out-of-bounds, missing-actor, and unknown-actor plants', () => {
    const ambiguous = workspace();
    ambiguous.rounds[0]!.events.splice(2, 0,
      event('plant-r1-second', 1_250, 'bomb_plant', { actor: 'a2' }),
    );
    expect(buildObjectiveReviewWorkspace(ambiguous).rounds[0]).toMatchObject({
      state: 'unavailable', reason_code: 'ambiguous_plant',
    });

    const outOfBounds = workspace();
    outOfBounds.rounds[0]!.events.find((candidate) => candidate.kind === 'bomb_plant')!.tick = 999;
    expect(buildObjectiveReviewWorkspace(outOfBounds).rounds[0]).toMatchObject({
      state: 'unavailable', reason_code: 'plant_outside_round_bounds',
    });

    const missingActor = workspace();
    missingActor.rounds[0]!.events.find((candidate) => candidate.kind === 'bomb_plant')!.actor = null;
    expect(buildObjectiveReviewWorkspace(missingActor).rounds[0]).toMatchObject({
      state: 'unavailable', reason_code: 'missing_plant_actor',
    });

    const unknownActor = workspace();
    unknownActor.rounds[0]!.events.find((candidate) => candidate.kind === 'bomb_plant')!.actor = 'unknown';
    expect(buildObjectiveReviewWorkspace(unknownActor).rounds[0]).toMatchObject({
      state: 'unavailable', reason_code: 'unknown_plant_actor',
    });
  });

  it('fails closed when a terminal objective event lies outside the canonical plant window', () => {
    const beforePlant = workspace();
    beforePlant.rounds[0]!.events.find((candidate) => candidate.kind === 'bomb_explode')!.tick = 1_100;
    expect(buildObjectiveReviewWorkspace(beforePlant).rounds[0]).toMatchObject({
      state: 'unavailable', reason_code: 'terminal_outside_plant_window',
    });

    const afterRoundEnd = workspace();
    afterRoundEnd.rounds[0]!.events.find((candidate) => candidate.kind === 'bomb_explode')!.tick = 1_901;
    expect(buildObjectiveReviewWorkspace(afterRoundEnd).rounds[0]).toMatchObject({
      state: 'unavailable', reason_code: 'terminal_outside_plant_window',
    });
  });

  it('fails closed when any present plant-side alias is invalid or aliases conflict', () => {
    const invalidSide = workspace();
    invalidSide.rounds[0]!.events.find((candidate) => candidate.kind === 'bomb_plant')!.detail = {
      site: 407,
      userteam: 99,
    };
    expect(buildObjectiveReviewWorkspace(invalidSide).rounds[0]).toMatchObject({
      state: 'unavailable', reason_code: 'plant_actor_side_conflict',
    });

    const conflictingAliases = workspace();
    conflictingAliases.rounds[0]!.events.find((candidate) => candidate.kind === 'bomb_plant')!.detail = {
      site: 407,
      userteam: 2,
      user_team_num: 3,
    };
    expect(buildObjectiveReviewWorkspace(conflictingAliases).rounds[0]).toMatchObject({
      state: 'unavailable', reason_code: 'plant_actor_side_conflict',
    });

    const producerAliasPoison = workspace();
    producerAliasPoison.rounds[0]!.events.find(
      (candidate) => candidate.kind === 'bomb_plant',
    )!.detail = { userteam: 2, actor_team: 'CT', teamnum: 2 };
    expect(buildObjectiveReviewWorkspace(producerAliasPoison).rounds[0]).toMatchObject({
      state: 'unavailable', reason_code: 'plant_actor_side_conflict',
    });
  });

  it('fails closed on invalid or conflicting explicit side aliases for encounters and terminals', () => {
    const encounter = workspace();
    encounter.rounds[0]!.events.splice(2, 0, event('kill-r1', 1_400, 'kill', {
      actor: 'a2',
      target: 'b2',
      detail: { attackerteam: 2, attacker_team_num: null, victimteam: 3 },
    }));
    expect(buildObjectiveReviewWorkspace(encounter).rounds[0]).toMatchObject({
      state: 'unavailable', reason_code: 'encounter_actor_side_conflict',
    });

    const target = workspace();
    target.rounds[0]!.events.splice(2, 0, event('damage-r1', 1_400, 'damage', {
      actor: 'a2',
      target: 'b2',
      detail: { attackerteam: 2, victimteam: 3, victim_team_num: 2 },
    }));
    expect(buildObjectiveReviewWorkspace(target).rounds[0]).toMatchObject({
      state: 'unavailable', reason_code: 'encounter_target_side_conflict',
    });

    const producerActorAliasPoison = workspace();
    producerActorAliasPoison.rounds[0]!.events.splice(2, 0, event(
      'kill-actor-alias-poison',
      1_400,
      'kill',
      {
        actor: 'a2',
        target: 'b2',
        detail: { attackerteam: 2, actor_team: 'CT', victimteam: 3 },
      },
    ));
    expect(buildObjectiveReviewWorkspace(producerActorAliasPoison).rounds[0]).toMatchObject({
      state: 'unavailable', reason_code: 'encounter_actor_side_conflict',
    });

    const producerTargetAliasPoison = workspace();
    producerTargetAliasPoison.rounds[0]!.events.splice(2, 0, event(
      'kill-target-alias-poison',
      1_400,
      'kill',
      {
        actor: 'a2',
        target: 'b2',
        detail: { attackerteam: 2, victimteam: 3, target_team: 'T' },
      },
    ));
    expect(buildObjectiveReviewWorkspace(producerTargetAliasPoison).rounds[0]).toMatchObject({
      state: 'unavailable', reason_code: 'encounter_target_side_conflict',
    });

    const terminal = workspace();
    terminal.rounds[0]!.events.find((candidate) => candidate.kind === 'bomb_explode')!.detail = {
      userteam: 'not-a-side',
    };
    expect(buildObjectiveReviewWorkspace(terminal).rounds[0]).toMatchObject({
      state: 'unavailable', reason_code: 'terminal_actor_side_conflict',
    });

    const actorlessEncounterWithSide = workspace();
    actorlessEncounterWithSide.rounds[0]!.events.splice(2, 0, event(
      'kill-actorless-with-side',
      1_400,
      'kill',
      { actor: null, target: 'b2', detail: { attackerteam: 2, victimteam: 3 } },
    ));
    expect(buildObjectiveReviewWorkspace(actorlessEncounterWithSide).rounds[0]).toMatchObject({
      state: 'unavailable', reason_code: 'encounter_actor_side_conflict',
    });

    const actorlessTerminalWithSide = workspace();
    const actorlessTerminal = actorlessTerminalWithSide.rounds[0]!.events.find(
      (candidate) => candidate.kind === 'bomb_explode',
    )!;
    actorlessTerminal.actor = null;
    actorlessTerminal.detail = { userteam: 2 };
    expect(buildObjectiveReviewWorkspace(actorlessTerminalWithSide).rounds[0]).toMatchObject({
      state: 'unavailable', reason_code: 'terminal_actor_side_conflict',
    });
  });

  it('publishes canonical round end as its own actorless boundary atom at the terminal tick', () => {
    const source = workspace();
    const poisonedBoundary = source.rounds[0]!.events.find(
      (candidate) => candidate.kind === 'round_end',
    )!;
    poisonedBoundary.actor = 'a1';
    poisonedBoundary.target = 'b1';
    poisonedBoundary.weapon = 'ak47';
    poisonedBoundary.headshot = true;
    poisonedBoundary.penetrated = true;

    const round = buildObjectiveReviewWorkspace(source).rounds[0];
    const terminalGroup = round?.timeline_groups.find((group) => group.tick === 1_900);

    expect(terminalGroup?.atomic_event_ids).toEqual(['end-r1', 'explode-r1']);
    expect(terminalGroup?.atoms.map((atom) => ({
      kind: atom.kind,
      evidence_id: atom.evidence_id,
      actor_id: atom.actor_id,
    }))).toEqual([
      {
        kind: 'round_end',
        evidence_id: 'demo:major-m1/event:end-r1',
        actor_id: null,
      },
      {
        kind: 'explode',
        evidence_id: 'demo:major-m1/event:explode-r1',
        actor_id: 'a1',
      },
    ]);
    expect(terminalGroup?.atoms[0]).toMatchObject({
      kind: 'round_end',
      actor_id: null,
      actor_name: null,
      actor_team: null,
      actor_side: null,
      target_id: null,
      target_name: null,
      target_team: null,
      target_side: null,
      weapon: null,
      headshot: false,
      penetrated: false,
      damage_health: null,
    });
  });

  it('projects every atom through its event-kind role schema', () => {
    const source = workspace();
    const plant = source.rounds[0]!.events.find((candidate) => candidate.kind === 'bomb_plant')!;
    plant.target = 'b1';
    plant.weapon = 'ak47';
    plant.headshot = true;
    plant.penetrated = true;
    plant.detail = { ...plant.detail as Record<string, unknown>, dmg_health: 99 };
    const terminal = source.rounds[0]!.events.find(
      (candidate) => candidate.kind === 'bomb_explode',
    )!;
    terminal.target = 'b2';
    terminal.weapon = 'awp';
    terminal.headshot = true;
    terminal.penetrated = true;
    terminal.detail = { dmg_health: 88 };
    source.rounds[0]!.events.splice(2, 0,
      event('kill-r1', 1_300, 'kill', {
        actor: 'a2', target: 'b2', weapon: 'ak47', headshot: true, penetrated: true,
        detail: { dmg_health: 77 },
      }),
      event('damage-r1', 1_400, 'damage', {
        actor: 'b3', target: 'a3', weapon: 'm4a1', headshot: true, penetrated: true,
        detail: { dmg_health: 22 },
      }),
    );

    const atoms = buildObjectiveReviewWorkspace(source).rounds[0]?.timeline_groups
      .flatMap((group) => group.atoms);
    expect(atoms?.find((atom) => atom.kind === 'plant')).toMatchObject({
      actor_id: 'a1', target_id: null, weapon: null,
      headshot: false, penetrated: false, damage_health: null,
    });
    expect(atoms?.find((atom) => atom.kind === 'explode')).toMatchObject({
      actor_id: 'a1', target_id: null, weapon: null,
      headshot: false, penetrated: false, damage_health: null,
    });
    expect(atoms?.find((atom) => atom.kind === 'kill')).toMatchObject({
      actor_id: 'a2', target_id: 'b2', weapon: 'ak47',
      headshot: true, penetrated: true, damage_health: null,
    });
    expect(atoms?.find((atom) => atom.kind === 'damage')).toMatchObject({
      actor_id: 'b3', target_id: 'a3', weapon: 'm4a1',
      headshot: false, penetrated: false, damage_health: 22,
    });
  });

  it('only exposes a bounded numeric raw site code without failing the round', () => {
    for (const misleadingSite of ['A', 'B', ' 407 ', '-1', '9'.repeat(32)]) {
      const source = workspace();
      source.rounds[0]!.events.find((candidate) => candidate.kind === 'bomb_plant')!.detail = {
        site: misleadingSite,
        userteam: 2,
      };
      expect(buildObjectiveReviewWorkspace(source).rounds[0]).toMatchObject({
        state: 'available',
        plant: { raw_site_code: null },
      });
    }

    const integerString = workspace();
    integerString.rounds[0]!.events.find((candidate) => candidate.kind === 'bomb_plant')!.detail = {
      site: '407',
      userteam: 2,
    };
    expect(buildObjectiveReviewWorkspace(integerString).rounds[0]).toMatchObject({
      plant: { raw_site_code: '407' },
    });
  });
});
