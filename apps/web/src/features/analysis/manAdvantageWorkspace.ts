import type {
  AnalysisWorkspace,
  PlayerAnalysis,
  TimelineEvent,
} from '../../shared/desktop/dto';
import {
  deriveStableMatchTeamContext,
  type StableMatchTeam,
} from './stableMatchTeamContext';

export type RemainingUneliminated = Record<StableMatchTeam, number>;

export type ManAdvantageDeathEvidence = {
  evidence_id: string;
  demo_id: string;
  source_kind: 'event';
  source_id: string;
  round: number;
  tick: number;
  end_tick: null;
  seconds: number;
  actor_id: string | null;
  actor_name: string | null;
  actor_team: StableMatchTeam | null;
  elimination_relation: 'opponent' | 'same_team' | 'unattributed';
  target_id: string;
  target_name: string;
  target_team: StableMatchTeam;
  weapon: string | null;
  headshot: boolean;
  penetrated: boolean;
  position: [number, number, number] | null;
};

export type ManAdvantageTransition = {
  key: string;
  round: number;
  tick: number;
  remaining_before: RemainingUneliminated;
  remaining_after: RemainingUneliminated;
  leading_team_after: StableMatchTeam | null;
  deaths: ManAdvantageDeathEvidence[];
};

export type ManAdvantageRoundFailureCode =
  | 'unknown_round_winner'
  | 'missing_round_end'
  | 'ambiguous_round_end'
  | 'kill_outside_round_bounds'
  | 'missing_target'
  | 'unknown_target'
  | 'unknown_actor'
  | 'duplicate_target_same_tick'
  | 'target_already_eliminated'
  | 'duplicate_event_id';

export type ManAdvantageRound = {
  round: number;
  state: 'available' | 'unavailable';
  reason: string | null;
  reason_code: ManAdvantageRoundFailureCode | null;
  winner: StableMatchTeam | null;
  round_end_evidence_id: string | null;
  transitions: ManAdvantageTransition[];
  first_lead_team: StableMatchTeam | null;
  first_lead_won: boolean | null;
  lead_changes: number | null;
  remaining_after_deaths: RemainingUneliminated | null;
};

export type ManAdvantageMatrixCell = {
  first_lead_team: StableMatchTeam;
  winner: StableMatchTeam;
  round_count: number;
  rounds: number[];
};

export type ManAdvantageWorkspace = {
  teams: Array<{
    id: StableMatchTeam;
    player_ids: string[];
    player_names: string[];
  }>;
  rounds: ManAdvantageRound[];
  matrix: ManAdvantageMatrixCell[];
  summary: {
    total_rounds: number;
    verified_rounds: number;
    unavailable_rounds: number;
    first_lead_won: number;
    first_lead_lost: number;
    no_lead_rounds: number;
    lead_change_rounds: number;
  };
  availability: {
    state: 'available' | 'partial' | 'unavailable';
    reason: string | null;
    failure_code: string | null;
    failure_round: number | null;
  };
};

const stableTeams = ['A', 'B'] as const satisfies readonly StableMatchTeam[];

type ResolvedDeathEvent = {
  source: TimelineEvent;
  actor: PlayerAnalysis | null;
  target: PlayerAnalysis;
};

function remainingCount(remaining: Readonly<Record<StableMatchTeam, Set<string>>>): RemainingUneliminated {
  return { A: remaining.A.size, B: remaining.B.size };
}

function leadingTeam(remaining: RemainingUneliminated): StableMatchTeam | null {
  if (remaining.A === remaining.B) return null;
  return remaining.A > remaining.B ? 'A' : 'B';
}

function tickInRound(
  tick: number,
  round: AnalysisWorkspace['rounds'][number],
): boolean {
  return Number.isSafeInteger(tick)
    && Number.isSafeInteger(round.start_tick)
    && Number.isSafeInteger(round.end_tick)
    && round.start_tick <= round.end_tick
    && tick >= round.start_tick
    && tick <= round.end_tick;
}

function unavailableRound(
  round: number,
  reasonCode: ManAdvantageRoundFailureCode,
  reason: string,
  winner: StableMatchTeam | null = null,
  roundEndEvidenceId: string | null = null,
): ManAdvantageRound {
  return {
    round,
    state: 'unavailable',
    reason,
    reason_code: reasonCode,
    winner,
    round_end_evidence_id: roundEndEvidenceId,
    transitions: [],
    first_lead_team: null,
    first_lead_won: null,
    lead_changes: null,
    remaining_after_deaths: null,
  };
}

function unavailableWorkspace(
  workspace: AnalysisWorkspace,
  reason: string | null,
  failureCode: string | null,
  failureRound: number | null,
): ManAdvantageWorkspace {
  return {
    teams: [],
    rounds: [],
    matrix: [],
    summary: {
      total_rounds: workspace.rounds.length,
      verified_rounds: 0,
      unavailable_rounds: workspace.rounds.length,
      first_lead_won: 0,
      first_lead_lost: 0,
      no_lead_rounds: 0,
      lead_change_rounds: 0,
    },
    availability: {
      state: 'unavailable',
      reason,
      failure_code: failureCode,
      failure_round: failureRound,
    },
  };
}

function deathEvidence(
  workspace: AnalysisWorkspace,
  round: number,
  death: ResolvedDeathEvent,
): ManAdvantageDeathEvidence {
  const { actor, source: event, target } = death;
  return {
    evidence_id: `demo:${workspace.demo_id}/event:${event.id}`,
    demo_id: workspace.demo_id,
    source_kind: 'event',
    source_id: event.id,
    round,
    tick: event.tick,
    end_tick: null,
    seconds: event.seconds,
    actor_id: actor?.id ?? null,
    actor_name: actor?.name ?? null,
    actor_team: actor?.team ?? null,
    elimination_relation: actor === null
      ? 'unattributed'
      : actor.team === target.team ? 'same_team' : 'opponent',
    target_id: target.id,
    target_name: target.name,
    target_team: target.team,
    weapon: event.weapon?.trim() || null,
    headshot: event.headshot,
    penetrated: event.penetrated,
    position: event.position ? [...event.position] : null,
  };
}

export function buildManAdvantageWorkspace(workspace: AnalysisWorkspace): ManAdvantageWorkspace {
  if (workspace.rounds.some((round) => !Number.isSafeInteger(round.number) || round.number <= 0)) {
    return unavailableWorkspace(
      workspace,
      'Every source round requires a positive safe-integer number for exact navigation.',
      'invalid_round_number',
      null,
    );
  }
  const roundNumberCounts = workspace.rounds.reduce(
    (counts, round) => counts.set(round.number, (counts.get(round.number) ?? 0) + 1),
    new Map<number, number>(),
  );
  const duplicateRoundNumber = [...roundNumberCounts].find(([, count]) => count > 1)?.[0] ?? null;
  if (duplicateRoundNumber !== null) {
    return unavailableWorkspace(
      workspace,
      `Round ${duplicateRoundNumber} cannot identify one canonical source round.`,
      'duplicate_round_number',
      duplicateRoundNumber,
    );
  }
  const context = deriveStableMatchTeamContext(workspace);
  if (context.availability.state !== 'available') {
    return unavailableWorkspace(
      workspace,
      context.availability.reason,
      context.availability.failure_code,
      context.availability.failure_round,
    );
  }

  const players = new Map(workspace.players.map((player) => [player.id, player]));
  const eventIdCounts = context.rounds
    .flatMap((round) => round.source.events)
    .reduce((counts, event) => counts.set(event.id, (counts.get(event.id) ?? 0) + 1), new Map<string, number>());
  const duplicateEventIds = new Set(
    [...eventIdCounts].filter(([, count]) => count > 1).map(([id]) => id),
  );
  const rounds = context.rounds.map((stableRound): ManAdvantageRound => {
    const round = stableRound.source;
    if (round.winner !== 'A' && round.winner !== 'B') {
      return unavailableRound(
        round.number,
        'unknown_round_winner',
        `Round ${round.number} has no verified Team A/B winner.`,
      );
    }
    const roundEnds = round.events.filter((event) => event.kind === 'round_end');
    if (roundEnds.length > 1) {
      return unavailableRound(
        round.number,
        'ambiguous_round_end',
        `Round ${round.number} contains more than one round-end event.`,
        round.winner,
      );
    }
    const roundEnd = roundEnds[0];
    if (!roundEnd || !tickInRound(roundEnd.tick, round)) {
      return unavailableRound(
        round.number,
        'missing_round_end',
        `Round ${round.number} has no verified in-bounds round-end event.`,
        round.winner,
      );
    }
    if (!roundEnd.id.trim() || duplicateEventIds.has(roundEnd.id)) {
      return unavailableRound(
        round.number,
        'duplicate_event_id',
        `Round ${round.number} has an empty or non-unique canonical round-end event ID.`,
        round.winner,
      );
    }
    const remaining = {
      A: new Set(context.teams.find((team) => team.id === 'A')?.player_ids ?? []),
      B: new Set(context.teams.find((team) => team.id === 'B')?.player_ids ?? []),
    };
    const transitions: ManAdvantageTransition[] = [];
    const kills = round.events
      .filter((event) => event.kind === 'kill')
      .sort((left, right) => left.tick - right.tick || left.id.localeCompare(right.id));
    if (kills.some((event) => !event.id.trim() || duplicateEventIds.has(event.id))) {
      return unavailableRound(
        round.number,
        'duplicate_event_id',
        `Round ${round.number} contains an empty or non-unique canonical death event ID.`,
        round.winner,
        `demo:${workspace.demo_id}/event:${roundEnd.id}`,
      );
    }
    if (kills.some((event) => !tickInRound(event.tick, round))) {
      return unavailableRound(
        round.number,
        'kill_outside_round_bounds',
        `Round ${round.number} contains a death outside its verified tick range.`,
        round.winner,
        `demo:${workspace.demo_id}/event:${roundEnd.id}`,
      );
    }
    const resolvedKills: ResolvedDeathEvent[] = [];
    for (const source of kills) {
      if (!source.target?.trim()) {
        return unavailableRound(
          round.number,
          'missing_target',
          `Round ${round.number} contains a death without a target.`,
          round.winner,
          `demo:${workspace.demo_id}/event:${roundEnd.id}`,
        );
      }
      const target = players.get(source.target);
      if (!target) {
        return unavailableRound(
          round.number,
          'unknown_target',
          `Round ${round.number} contains a death target outside the verified roster.`,
          round.winner,
          `demo:${workspace.demo_id}/event:${roundEnd.id}`,
        );
      }
      const actor = source.actor === null ? null : players.get(source.actor);
      if (actor === undefined) {
        return unavailableRound(
          round.number,
          'unknown_actor',
          `Round ${round.number} contains a non-null death actor outside the verified roster.`,
          round.winner,
          `demo:${workspace.demo_id}/event:${roundEnd.id}`,
        );
      }
      resolvedKills.push({ source, actor, target });
    }
    const tickGroups = resolvedKills.reduce<ResolvedDeathEvent[][]>((groups, kill) => {
      const current = groups.at(-1);
      if (current?.[0]?.source.tick === kill.source.tick) current.push(kill);
      else groups.push([kill]);
      return groups;
    }, []);
    if (tickGroups.some((group) => {
      const targets = group.map((death) => death.target.id);
      return new Set(targets).size !== targets.length;
    })) {
      return unavailableRound(
        round.number,
        'duplicate_target_same_tick',
        `Round ${round.number} contains duplicate same-tick deaths for one target.`,
        round.winner,
        `demo:${workspace.demo_id}/event:${roundEnd.id}`,
      );
    }
    const killTargets = resolvedKills.map((death) => death.target.id);
    if (new Set(killTargets).size !== killTargets.length) {
      return unavailableRound(
        round.number,
        'target_already_eliminated',
        `Round ${round.number} contains a later death for a target already eliminated.`,
        round.winner,
        `demo:${workspace.demo_id}/event:${roundEnd.id}`,
      );
    }
    for (const group of tickGroups) {
      const tick = group[0]?.source.tick;
      if (tick === undefined) continue;
      const before = remainingCount(remaining);
      for (const death of group) {
        remaining[death.target.team].delete(death.target.id);
      }
      const after = remainingCount(remaining);
      transitions.push({
        key: `${round.number}:${tick}`,
        round: round.number,
        tick,
        remaining_before: before,
        remaining_after: after,
        leading_team_after: leadingTeam(after),
        deaths: group.map((death) => deathEvidence(workspace, round.number, death)),
      });
    }
    const nonTiedLeaders = transitions.flatMap((transition) => (
      transition.leading_team_after ? [transition.leading_team_after] : []
    ));
    const firstLead = nonTiedLeaders[0] ?? null;
    const leadChanges = nonTiedLeaders.slice(1).reduce(
      (count, leader, index) => count + (leader !== nonTiedLeaders[index] ? 1 : 0),
      0,
    );
    return {
      round: round.number,
      state: 'available',
      reason: null,
      reason_code: null,
      winner: round.winner,
      round_end_evidence_id: `demo:${workspace.demo_id}/event:${roundEnd.id}`,
      transitions,
      first_lead_team: firstLead,
      first_lead_won: firstLead === null ? null : firstLead === round.winner,
      lead_changes: leadChanges,
      remaining_after_deaths: remainingCount(remaining),
    };
  });

  const verified = rounds.filter((round) => round.state === 'available');
  const matrix = stableTeams.flatMap((firstLeadTeam) => stableTeams.map((winner) => {
    const matching = verified.filter(
      (round) => round.first_lead_team === firstLeadTeam && round.winner === winner,
    );
    return {
      first_lead_team: firstLeadTeam,
      winner,
      round_count: matching.length,
      rounds: matching.map((round) => round.round),
    };
  }));
  const unavailableCount = rounds.length - verified.length;
  return {
    teams: context.teams,
    rounds,
    matrix,
    summary: {
      total_rounds: rounds.length,
      verified_rounds: verified.length,
      unavailable_rounds: unavailableCount,
      first_lead_won: verified.filter((round) => round.first_lead_won === true).length,
      first_lead_lost: verified.filter((round) => round.first_lead_won === false).length,
      no_lead_rounds: verified.filter((round) => round.first_lead_team === null).length,
      lead_change_rounds: verified.filter((round) => (round.lead_changes ?? 0) > 0).length,
    },
    availability: {
      state: unavailableCount === 0 ? 'available' : verified.length > 0 ? 'partial' : 'unavailable',
      reason: unavailableCount === 0
        ? null
        : `${unavailableCount} round(s) could not prove a complete elimination-state sequence.`,
      failure_code: rounds.find((round) => round.state === 'unavailable')?.reason_code ?? null,
      failure_round: rounds.find((round) => round.state === 'unavailable')?.round ?? null,
    },
  };
}
