import type { TimelineEvent } from '../../shared/desktop/dto';
import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import type { PlayerEvidenceRef } from './playerMatchEvidence';
import {
  deriveStableMatchTeamContext,
  type CompetitiveSide,
  type StableMatchRound,
  type StableMatchTeam,
  type StableMatchTeamRecord,
} from './stableMatchTeamContext';

export type TeamRoundFilter = {
  team: StableMatchTeam | null;
  side: CompetitiveSide | null;
};

export type TeamRoundSelection = {
  cell_key: string | null;
  evidence_id: string | null;
  local_owner: boolean;
};

export type TeamRoundSelectionAction =
  | { type: 'select_cell'; cell_key: string }
  | { type: 'select_evidence'; cell_key: string; evidence_id: string };

export function initialTeamRoundSelection(): TeamRoundSelection {
  return { cell_key: null, evidence_id: null, local_owner: false };
}

export function reduceTeamRoundSelection(
  _current: TeamRoundSelection,
  action: TeamRoundSelectionAction,
): TeamRoundSelection {
  return action.type === 'select_cell'
    ? { cell_key: action.cell_key, evidence_id: null, local_owner: true }
    : {
        cell_key: action.cell_key,
        evidence_id: action.evidence_id,
        local_owner: true,
      };
}

export function resolveTeamRoundEvidenceId(
  selection: TeamRoundSelection,
  focusedEvidenceId: string | null,
  availableEvidenceIds: readonly string[],
): string | null {
  const preferred = selection.local_owner ? selection.evidence_id : focusedEvidenceId;
  return preferred && availableEvidenceIds.includes(preferred)
    ? preferred
    : availableEvidenceIds[0] ?? null;
}

export type TeamRoundAvailability = {
  state: 'available' | 'partial' | 'unavailable';
  reason: string | null;
  failure_code:
    | 'stable_team_identity'
    | 'no_analyzed_rounds'
    | 'incomplete_round_roster'
    | 'inconsistent_team_membership'
    | 'unknown_round_winner'
    | 'missing_round_end'
    | null;
  failure_round: number | null;
};

export type TeamRoundCell = {
  team: StableMatchTeam;
  side: CompetitiveSide;
  rounds_played: number;
  round_wins: number;
  rounds: number[];
};

export type TeamRoundEvidence = PlayerEvidenceRef & {
  event_kind: 'kill' | 'round_end';
  seconds: number;
  selected_team: StableMatchTeam;
  selected_side: CompetitiveSide;
  actor_id: string | null;
  actor_name: string | null;
  actor_team: StableMatchTeam | null;
  target_id: string | null;
  target_name: string | null;
  target_team: StableMatchTeam | null;
  winner_team: StableMatchTeam | null;
  weapon: string | null;
  headshot: boolean;
  penetrated: boolean;
};

export type TeamRoundWorkspace = {
  teams: StableMatchTeamRecord[];
  cells: TeamRoundCell[];
  selected_cell: TeamRoundCell | null;
  evidence: TeamRoundEvidence[];
  availability: TeamRoundAvailability;
};

type VerifiedRound = {
  number: StableMatchRound['number'];
  winner: StableMatchTeam;
  sides: StableMatchRound['sides'];
  source: StableMatchRound['source'];
  round_end: TimelineEvent;
};

const stableTeams = ['A', 'B'] as const;
const competitiveSides = ['T', 'CT'] as const;

function unavailable(
  reason: string,
  failureCode: NonNullable<TeamRoundAvailability['failure_code']>,
  failureRound: number | null = null,
): TeamRoundWorkspace {
  return {
    teams: [],
    cells: [],
    selected_cell: null,
    evidence: [],
    availability: {
      state: 'unavailable',
      reason,
      failure_code: failureCode,
      failure_round: failureRound,
    },
  };
}

function verifyRounds(
  stableRounds: readonly StableMatchRound[],
): {
  rounds: VerifiedRound[] | null;
  failure_code: NonNullable<TeamRoundAvailability['failure_code']> | null;
  failure_round: number | null;
} {
  const rounds: VerifiedRound[] = [];
  for (const stableRound of stableRounds) {
    const round = stableRound.source;
    if (round.winner !== 'A' && round.winner !== 'B') {
      return {
        rounds: null,
        failure_code: 'unknown_round_winner',
        failure_round: round.number,
      };
    }
    const roundEnd = round.events.find((event) => event.kind === 'round_end');
    if (!roundEnd || roundEnd.tick < round.start_tick || roundEnd.tick > round.end_tick) {
      return {
        rounds: null,
        failure_code: 'missing_round_end',
        failure_round: round.number,
      };
    }
    rounds.push({
      number: stableRound.number,
      winner: round.winner,
      sides: stableRound.sides,
      source: round,
      round_end: roundEnd,
    });
  }
  return { rounds, failure_code: null, failure_round: null };
}

function eventEvidence(
  workspace: AnalysisWorkspace,
  round: VerifiedRound,
  event: TimelineEvent,
  team: StableMatchTeam,
  side: CompetitiveSide,
): TeamRoundEvidence | null {
  const actor = event.actor
    ? workspace.players.find((player) => player.id === event.actor) ?? null
    : null;
  const target = event.target
    ? workspace.players.find((player) => player.id === event.target) ?? null
    : null;
  if (event.kind === 'kill' && (!actor || !target)) return null;
  return {
    evidence_id: `demo:${workspace.demo_id}/event:${event.id}`,
    demo_id: workspace.demo_id,
    source_kind: 'event',
    source_id: event.id,
    round: round.number,
    tick: event.tick,
    end_tick: null,
    event_kind: event.kind === 'kill' ? 'kill' : 'round_end',
    seconds: event.seconds,
    selected_team: team,
    selected_side: side,
    actor_id: actor?.id ?? null,
    actor_name: actor?.name ?? null,
    actor_team: actor?.team ?? null,
    target_id: target?.id ?? null,
    target_name: target?.name ?? null,
    target_team: target?.team ?? null,
    winner_team: event.kind === 'round_end' ? round.winner : null,
    weapon: event.weapon?.trim() || null,
    headshot: event.headshot,
    penetrated: event.penetrated,
  };
}

export function buildTeamRoundWorkspace(
  workspace: AnalysisWorkspace,
  filter: TeamRoundFilter,
): TeamRoundWorkspace {
  const context = deriveStableMatchTeamContext(workspace);
  if (context.availability.state !== 'available') {
    return unavailable(
      context.availability.reason ?? 'Stable Team A/B identity cannot be proven.',
      context.availability.failure_code ?? 'stable_team_identity',
      context.availability.failure_round,
    );
  }
  const verification = verifyRounds(context.rounds);
  if (!verification.rounds) {
    const roundLabel = verification.failure_round === null
      ? ''
      : `Round ${verification.failure_round} `;
    return unavailable(
      `${roundLabel}cannot prove a complete Team A/B roster, side assignment, winner, and round-end event.`,
      verification.failure_code ?? 'incomplete_round_roster',
      verification.failure_round,
    );
  }
  const teams = context.teams;
  const rounds = verification.rounds;
  const cells = stableTeams.flatMap((team) => competitiveSides.map((side): TeamRoundCell => {
    const matching = rounds.filter((round) => round.sides[team] === side);
    return {
      team,
      side,
      rounds_played: matching.length,
      round_wins: matching.filter((round) => round.winner === team).length,
      rounds: matching.map((round) => round.number),
    };
  }));
  const selectedCell = filter.team && filter.side
    ? cells.find((cell) => cell.team === filter.team && cell.side === filter.side) ?? null
    : null;
  const evidence = selectedCell
    ? rounds
        .filter((round) => round.sides[selectedCell.team] === selectedCell.side)
        .flatMap((round) => [
          ...round.source.events.filter((event) => event.kind === 'kill'),
          round.round_end,
        ].flatMap((event) => {
          const item = eventEvidence(workspace, round, event, selectedCell.team, selectedCell.side);
          return item ? [item] : [];
        }))
        .sort((left, right) => left.tick - right.tick
          || left.evidence_id.localeCompare(right.evidence_id))
    : [];
  return {
    teams,
    cells,
    selected_cell: selectedCell,
    evidence,
    availability: {
      state: 'available',
      reason: null,
      failure_code: null,
      failure_round: null,
    },
  };
}
