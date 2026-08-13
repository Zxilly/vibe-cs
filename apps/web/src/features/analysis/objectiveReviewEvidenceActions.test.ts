import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace, PlayerAnalysis, TimelineEvent } from '../../shared/desktop/dto';
import { objectiveReviewEvidenceActionContract } from './objectiveReviewEvidenceActions';
import { buildObjectiveReviewWorkspace } from './objectiveReviewWorkspace';

const a = ['a1', 'a2', 'a3', 'a4', 'a5'];
const b = ['b1', 'b2', 'b3', 'b4', 'b5'];
const player = (id: string, team: PlayerAnalysis['team']): PlayerAnalysis => ({
  id, name: id.toUpperCase(), team, kills: 0, deaths: 0, assists: 0,
  headshot_rate: 0, kill_death_ratio: 0, adr: 0,
});
const event = (
  id: string,
  tick: number,
  kind: TimelineEvent['kind'],
  overrides: Partial<TimelineEvent> = {},
): TimelineEvent => ({
  id, tick, seconds: tick / 64, kind, actor: null, target: null, weapon: null,
  headshot: false, penetrated: false, position: null, detail: {}, ...overrides,
});

function workspace(): AnalysisWorkspace {
  const roster = Object.fromEntries([...a.map((id) => [id, 'T']), ...b.map((id) => [id, 'CT'])]);
  return {
    demo_id: 'major-m1', map_name: 'de_mirage', tick_rate: 64, duration_seconds: 60,
    teams: [
      { name: 'Team A', side: 'A', score: 1, players: a },
      { name: 'Team B', side: 'B', score: 0, players: b },
    ],
    players: [...a.map((id) => player(id, 'A')), ...b.map((id) => player(id, 'B'))],
    rounds: [{
      number: 1, winner: 'A', reason: 'target_bombed', start_tick: 1_000, end_tick: 2_000,
      team_a_score: 1, team_b_score: 0,
      events: [
        event('start-r1', 1_000, 'round_start', { detail: { _round_roster: roster } }),
        event('plant-r1', 1_200, 'bomb_plant', { actor: 'a1', detail: { site: 407 } }),
        event('kill-r1', 1_400, 'kill', { actor: 'a2', target: 'b2', weapon: 'ak47' }),
        event('explode-r1', 1_900, 'bomb_explode', { actor: 'a1' }),
        event('end-r1', 1_900, 'round_end'),
      ],
    }],
    highlights: [],
  };
}

describe('objective review evidence actions', () => {
  it('recanonicalizes one exact atom before enabling navigation, Watch, and Add POV', () => {
    const analysis = workspace();
    const atom = buildObjectiveReviewWorkspace(analysis).rounds[0]?.timeline_groups
      .flatMap((group) => group.atoms)
      .find((candidate) => candidate.source_id === 'kill-r1');
    if (!atom) throw new Error('The fixture must produce a post-plant kill atom.');

    const actions = objectiveReviewEvidenceActionContract(analysis, atom, {
      serviceAvailable: true,
      runtimeIdle: true,
      watchPending: false,
      alreadyAdded: false,
    });

    expect(actions.round).toEqual({
      available: true,
      reason: null,
      navigation: {
        tab: 'rounds',
        round: 1,
        tick: 1_400,
        playerId: 'a2',
        evidenceId: 'demo:major-m1/event:kill-r1',
      },
    });
    expect(actions.replay.navigation).toMatchObject({ tab: 'replay', round: 1, tick: 1_400 });
    expect(actions.watch).toEqual({ available: true, reason: null, start_tick: 1_400 });
    expect(actions.add).toMatchObject({
      available: true,
      reason: null,
      compilation: {
        id: 'demo:major-m1/event:kill-r1',
        playerId: 'a2',
        startTick: 1_400,
        endTick: 1_401,
      },
    });
  });

  it('fails every action closed when an atom fact is forged or its source disappears', () => {
    const analysis = workspace();
    const atom = buildObjectiveReviewWorkspace(analysis).rounds[0]?.timeline_groups
      .flatMap((group) => group.atoms)
      .find((candidate) => candidate.source_id === 'kill-r1');
    if (!atom) throw new Error('The fixture must produce a post-plant kill atom.');

    const forged = objectiveReviewEvidenceActionContract(analysis, {
      ...atom,
      weapon: 'forged-weapon',
    }, {
      serviceAvailable: true,
      runtimeIdle: true,
      watchPending: false,
      alreadyAdded: false,
    });
    expect(forged.round.available).toBe(false);
    expect(forged.replay.available).toBe(false);
    expect(forged.watch.available).toBe(false);
    expect(forged.add).toMatchObject({ available: false, compilation: null });

    analysis.rounds[0]!.events = analysis.rounds[0]!.events
      .filter((candidate) => candidate.id !== 'kill-r1');
    const missing = objectiveReviewEvidenceActionContract(analysis, atom, {
      serviceAvailable: true,
      runtimeIdle: true,
      watchPending: false,
      alreadyAdded: false,
    });
    expect(missing.round.available).toBe(false);
    expect(missing.watch.available).toBe(false);
  });

  it('keeps an actorless canonical explosion navigable and watchable without inventing a POV', () => {
    const analysis = workspace();
    analysis.rounds[0]!.events.find((candidate) => candidate.kind === 'bomb_explode')!.actor = null;
    const atom = buildObjectiveReviewWorkspace(analysis).rounds[0]?.timeline_groups
      .flatMap((group) => group.atoms)
      .find((candidate) => candidate.kind === 'explode');
    if (!atom) throw new Error('The fixture must produce an explosion atom.');

    const actions = objectiveReviewEvidenceActionContract(analysis, atom, {
      serviceAvailable: true,
      runtimeIdle: true,
      watchPending: false,
      alreadyAdded: false,
    });

    expect(actions.round.available).toBe(true);
    expect(actions.replay.available).toBe(true);
    expect(actions.watch.available).toBe(true);
    expect(actions.add).toEqual({
      available: false,
      reason: 'This objective atom has no verified actor for a production POV.',
      compilation: null,
    });
  });

  it('keeps the canonical round-end boundary navigable and watchable without inventing a POV', () => {
    const analysis = workspace();
    const poisonedBoundary = analysis.rounds[0]!.events.find(
      (candidate) => candidate.kind === 'round_end',
    )!;
    poisonedBoundary.actor = 'a1';
    poisonedBoundary.target = 'b1';
    poisonedBoundary.weapon = 'ak47';
    poisonedBoundary.headshot = true;
    poisonedBoundary.penetrated = true;
    const atom = buildObjectiveReviewWorkspace(analysis).rounds[0]?.timeline_groups
      .flatMap((group) => group.atoms)
      .find((candidate) => candidate.kind === 'round_end');
    if (!atom) throw new Error('The fixture must produce a canonical round-end atom.');
    expect(atom).toMatchObject({
      actor_id: null,
      target_id: null,
      weapon: null,
      headshot: false,
      penetrated: false,
    });

    const actions = objectiveReviewEvidenceActionContract(analysis, atom, {
      serviceAvailable: true,
      runtimeIdle: true,
      watchPending: false,
      alreadyAdded: false,
    });

    expect(actions.round.available).toBe(true);
    expect(actions.replay.available).toBe(true);
    expect(actions.watch).toEqual({ available: true, reason: null, start_tick: 1_900 });
    expect(actions.add).toEqual({
      available: false,
      reason: 'This objective atom has no verified actor for a production POV.',
      compilation: null,
    });
  });

  it('applies runtime and production-plan gates after the source atom is re-canonicalized', () => {
    const analysis = workspace();
    const atom = buildObjectiveReviewWorkspace(analysis).rounds[0]?.timeline_groups
      .flatMap((group) => group.atoms)
      .find((candidate) => candidate.source_id === 'plant-r1');
    if (!atom) throw new Error('The fixture must produce a canonical plant atom.');

    const actions = objectiveReviewEvidenceActionContract(analysis, atom, {
      serviceAvailable: true,
      runtimeIdle: false,
      watchPending: false,
      alreadyAdded: true,
    });

    expect(actions.round.available).toBe(true);
    expect(actions.replay.available).toBe(true);
    expect(actions.watch).toMatchObject({ available: false });
    expect(actions.add).toMatchObject({
      available: false,
      compilation: { id: atom.evidence_id, playerId: 'a1', category: 'custom' },
    });
  });
});
