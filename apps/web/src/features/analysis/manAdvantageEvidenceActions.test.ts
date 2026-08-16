import { describe, expect, it } from 'vitest';

import type { TimelineEvent } from '../../shared/desktop/dto';
import type { AnalysisWorkspace, PlayerAnalysis } from '../../shared/desktop/viewModels';
import { manAdvantageEvidenceActionContract } from './manAdvantageEvidenceActions';
import { buildManAdvantageWorkspace } from './manAdvantageWorkspace';

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
  const a = ['a1', 'a2', 'a3', 'a4', 'a5'];
  const b = ['b1', 'b2', 'b3', 'b4', 'b5'];
  const roster = Object.fromEntries([
    ...a.map((id) => [id, 'T']),
    ...b.map((id) => [id, 'CT']),
  ]);
  return {
    demo_id: 'major-m1',
    map_name: 'de_mirage',
    tick_rate: 64,
    duration_seconds: 60,
    teams: [
      { name: 'Team A', side: 'A', score: 1, players: a },
      { name: 'Team B', side: 'B', score: 0, players: b },
    ],
    players: [...a.map((id) => player(id, 'A')), ...b.map((id) => player(id, 'B'))],
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
        event('end-r1', 2_000, 'round_end'),
      ],
    }],
    highlights: [],
  };
}

describe('man advantage evidence actions', () => {
  it('opens and compiles only the exact canonical death event', () => {
    const analysis = workspace();
    const evidence = buildManAdvantageWorkspace(analysis).rounds[0]?.transitions[0]?.deaths[0];
    if (!evidence) throw new Error('The fixture must produce one death evidence item.');

    const actions = manAdvantageEvidenceActionContract(analysis, evidence, {
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
        tick: 1_200,
        playerId: 'a1',
        evidenceId: 'demo:major-m1/event:kill-a1-b1',
      },
    });
    expect(actions.replay.navigation).toEqual({
      tab: 'replay',
      round: 1,
      tick: 1_200,
      playerId: 'a1',
      evidenceId: 'demo:major-m1/event:kill-a1-b1',
    });
    expect(actions.watch).toEqual({ available: true, reason: null, start_tick: 1_200 });
    expect(actions.add).toMatchObject({
      available: true,
      reason: null,
      compilation: {
        id: 'demo:major-m1/event:kill-a1-b1',
        playerId: 'a1',
        startTick: 1_200,
        endTick: 1_201,
        category: 'custom',
      },
    });
  });

  it('keeps later deaths and same-team deaths production-neutral instead of labeling them entries', () => {
    const analysis = workspace();
    const round = analysis.rounds[0];
    if (!round) throw new Error('The fixture must contain a round.');
    round.events.splice(2, 0, event('kill-a2-a3', 1_400, 'kill', {
      actor: 'a2',
      target: 'a3',
      weapon: 'ak47',
    }));
    const evidence = buildManAdvantageWorkspace(analysis).rounds[0]?.transitions
      .flatMap((transition) => transition.deaths)
      .find((death) => death.source_id === 'kill-a2-a3');
    if (!evidence) throw new Error('The fixture must produce the same-team death evidence.');

    const actions = manAdvantageEvidenceActionContract(analysis, evidence, {
      serviceAvailable: true,
      runtimeIdle: true,
      watchPending: false,
      alreadyAdded: false,
    });

    expect(actions.add.compilation).toMatchObject({
      id: evidence.evidence_id,
      category: 'custom',
    });
  });

  it('keeps actorless deaths navigable and watchable but never invents a production POV', () => {
    const analysis = workspace();
    const kill = analysis.rounds[0]?.events.find((item) => item.kind === 'kill');
    if (!kill) throw new Error('The fixture must contain a death.');
    kill.actor = null;
    const evidence = buildManAdvantageWorkspace(analysis).rounds[0]?.transitions[0]?.deaths[0];
    if (!evidence) throw new Error('The fixture must produce one death evidence item.');

    const actions = manAdvantageEvidenceActionContract(analysis, evidence, {
      serviceAvailable: true,
      runtimeIdle: true,
      watchPending: false,
      alreadyAdded: false,
    });

    expect(actions.round.navigation.playerId).toBe('b1');
    expect(actions.replay.navigation.playerId).toBe('b1');
    expect(actions.watch.available).toBe(true);
    expect(actions.add).toEqual({
      available: false,
      reason: 'This death has no verified actor for a production POV.',
      compilation: null,
    });
  });

  it('fails every action closed when any canonical death fact is forged', () => {
    const analysis = workspace();
    const evidence = buildManAdvantageWorkspace(analysis).rounds[0]?.transitions[0]?.deaths[0];
    if (!evidence) throw new Error('The fixture must produce one death evidence item.');

    const actions = manAdvantageEvidenceActionContract(analysis, {
      ...evidence,
      weapon: 'forged-weapon',
    }, {
      serviceAvailable: true,
      runtimeIdle: true,
      watchPending: false,
      alreadyAdded: false,
    });

    expect(actions.round.available).toBe(false);
    expect(actions.replay.available).toBe(false);
    expect(actions.watch.available).toBe(false);
    expect(actions.add).toMatchObject({ available: false, compilation: null });
  });

  it('marks an already-added canonical death unavailable even if its compilation remains reproducible', () => {
    const analysis = workspace();
    const evidence = buildManAdvantageWorkspace(analysis).rounds[0]?.transitions[0]?.deaths[0];
    if (!evidence) throw new Error('The fixture must produce one death evidence item.');

    const actions = manAdvantageEvidenceActionContract(analysis, evidence, {
      serviceAvailable: true,
      runtimeIdle: true,
      watchPending: false,
      alreadyAdded: true,
    });

    expect(actions.add.available).toBe(false);
    expect(actions.add.reason).toBe('This evidence is already in the production plan.');
    expect(actions.add.compilation?.id).toBe(evidence.evidence_id);
  });
});
