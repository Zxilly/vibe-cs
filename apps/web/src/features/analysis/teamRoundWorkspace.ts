import type {
  AnalysisWorkspace,
  PlayerAnalysis,
  TimelineEvent,
} from '../../shared/desktop/dto';
import type { PlayerEvidenceRef } from './playerMatchEvidence';

export type StableMatchTeam = PlayerAnalysis['team'];
export type CompetitiveSide = 'T' | 'CT';

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

export type StableMatchTeamRecord = {
  id: StableMatchTeam;
  player_ids: string[];
  player_names: string[];
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
  number: number;
  winner: StableMatchTeam;
  sides: Record<StableMatchTeam, CompetitiveSide>;
  source: AnalysisWorkspace['rounds'][number];
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

function normalizedSide(value: unknown): CompetitiveSide | null {
  const side = String(value ?? '').trim().toLocaleUpperCase().replaceAll('_', '-');
  if (side === 'T' || side === 'TERRORIST' || side === '2') return 'T';
  if (side === 'CT' || side === 'COUNTER-TERRORIST' || side === '3') return 'CT';
  return null;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left].sort().every((id, index) => id === sortedRight[index]);
}

function stableTeamRecords(workspace: AnalysisWorkspace): StableMatchTeamRecord[] | null {
  if (workspace.players.length !== 10) return null;
  const uniquePlayerIds = new Set(workspace.players.map((player) => player.id));
  if (uniquePlayerIds.size !== 10 || [...uniquePlayerIds].some((id) => !id.trim())) return null;

  const records = stableTeams.map((team): StableMatchTeamRecord => {
    const players = workspace.players.filter((player) => player.team === team);
    return {
      id: team,
      player_ids: players.map((player) => player.id),
      player_names: players.map((player) => player.name),
    };
  });
  if (records.some((team) => team.player_ids.length !== 5)) return null;

  for (const record of records) {
    const summary = workspace.teams.find((team) => team.side.trim().toLocaleUpperCase() === record.id);
    if (!summary
      || summary.name.trim().toLocaleUpperCase() !== `TEAM ${record.id}`
      || !sameMembers(summary.players, record.player_ids)) return null;
  }
  return records;
}

function roundRoster(
  round: AnalysisWorkspace['rounds'][number],
): Map<string, CompetitiveSide> | null {
  const start = round.events.find((event) => event.kind === 'round_start');
  if (!start || start.tick < round.start_tick || start.tick > round.end_tick) return null;
  if (typeof start.detail !== 'object' || start.detail === null) return null;
  const rawRoster = (start.detail as Record<string, unknown>)._round_roster;
  if (typeof rawRoster !== 'object' || rawRoster === null || Array.isArray(rawRoster)) return null;
  const roster = new Map<string, CompetitiveSide>();
  for (const [playerId, rawSide] of Object.entries(rawRoster)) {
    const side = normalizedSide(rawSide);
    if (!playerId.trim() || !side) return null;
    roster.set(playerId, side);
  }
  return roster;
}

function teamSide(
  roster: ReadonlyMap<string, CompetitiveSide>,
  playerIds: readonly string[],
): CompetitiveSide | null {
  const sides = new Set(playerIds.map((id) => roster.get(id)));
  if (sides.size !== 1 || sides.has(undefined)) return null;
  return [...sides][0] ?? null;
}

function verifyRounds(
  workspace: AnalysisWorkspace,
  teams: readonly StableMatchTeamRecord[],
): {
  rounds: VerifiedRound[] | null;
  failure_code: NonNullable<TeamRoundAvailability['failure_code']> | null;
  failure_round: number | null;
} {
  const expectedPlayers = teams.flatMap((team) => team.player_ids);
  const rounds: VerifiedRound[] = [];
  for (const round of workspace.rounds) {
    const roster = roundRoster(round);
    if (!roster || !sameMembers([...roster.keys()], expectedPlayers)) {
      return {
        rounds: null,
        failure_code: 'incomplete_round_roster',
        failure_round: round.number,
      };
    }
    const aSide = teamSide(roster, teams[0]?.player_ids ?? []);
    const bSide = teamSide(roster, teams[1]?.player_ids ?? []);
    if (!aSide || !bSide || aSide === bSide) {
      return {
        rounds: null,
        failure_code: 'inconsistent_team_membership',
        failure_round: round.number,
      };
    }
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
      number: round.number,
      winner: round.winner,
      sides: { A: aSide, B: bSide },
      source: round,
      round_end: roundEnd,
    });
  }
  return rounds.length > 0
    ? { rounds, failure_code: null, failure_round: null }
    : { rounds: null, failure_code: 'no_analyzed_rounds', failure_round: null };
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
  const teams = stableTeamRecords(workspace);
  if (!teams) {
    return unavailable(
      'Stable Team A/B identity requires two exact five-player match rosters.',
      'stable_team_identity',
    );
  }
  const verification = verifyRounds(workspace, teams);
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
