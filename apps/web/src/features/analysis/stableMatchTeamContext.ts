import type {
  AnalysisWorkspace,
  PlayerAnalysis,
} from '../../shared/desktop/dto';

export type StableMatchTeam = PlayerAnalysis['team'];
export type CompetitiveSide = 'T' | 'CT';

export type StableMatchTeamRecord = {
  id: StableMatchTeam;
  player_ids: string[];
  player_names: string[];
};

export type StableMatchRound = {
  number: number;
  sides: Record<StableMatchTeam, CompetitiveSide>;
  source: AnalysisWorkspace['rounds'][number];
};

export type StableMatchTeamAvailability = {
  state: 'available' | 'unavailable';
  reason: string | null;
  failure_code:
    | 'stable_team_identity'
    | 'no_analyzed_rounds'
    | 'incomplete_round_roster'
    | 'inconsistent_team_membership'
    | null;
  failure_round: number | null;
};

export type StableMatchTeamContext = {
  teams: StableMatchTeamRecord[];
  rounds: StableMatchRound[];
  availability: StableMatchTeamAvailability;
};

const stableTeams = ['A', 'B'] as const satisfies readonly StableMatchTeam[];

function unavailable(
  reason: string,
  failureCode: NonNullable<StableMatchTeamAvailability['failure_code']>,
  failureRound: number | null = null,
): StableMatchTeamContext {
  return {
    teams: [],
    rounds: [],
    availability: {
      state: 'unavailable',
      reason,
      failure_code: failureCode,
      failure_round: failureRound,
    },
  };
}

export function normalizedCompetitiveSide(value: unknown): CompetitiveSide | null {
  const side = String(value ?? '').trim().toLocaleUpperCase().replaceAll('_', '-');
  if (side === 'T' || side === 'TERRORIST' || side === '2') return 'T';
  if (side === 'CT' || side === 'COUNTER-TERRORIST' || side === '3') return 'CT';
  return null;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const actual = new Set(left);
  const expected = new Set(right);
  return actual.size === left.length
    && expected.size === right.length
    && left.every((id) => expected.has(id));
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
    const summary = workspace.teams.find(
      (team) => team.side.trim().toLocaleUpperCase() === record.id,
    );
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
    const side = normalizedCompetitiveSide(rawSide);
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

export function deriveStableMatchTeamContext(
  workspace: AnalysisWorkspace,
): StableMatchTeamContext {
  const teams = stableTeamRecords(workspace);
  if (!teams) {
    return unavailable(
      'Stable Team A/B identity requires two exact five-player match rosters.',
      'stable_team_identity',
    );
  }
  if (workspace.rounds.length === 0) {
    return unavailable('No analyzed rounds are available.', 'no_analyzed_rounds');
  }

  const expectedPlayers = teams.flatMap((team) => team.player_ids);
  const rounds: StableMatchRound[] = [];
  for (const round of workspace.rounds) {
    const roster = roundRoster(round);
    if (!roster || !sameMembers([...roster.keys()], expectedPlayers)) {
      return unavailable(
        `Round ${round.number} cannot prove a complete ten-player roster.`,
        'incomplete_round_roster',
        round.number,
      );
    }
    const teamA = teams.find((team) => team.id === 'A');
    const teamB = teams.find((team) => team.id === 'B');
    const aSide = teamSide(roster, teamA?.player_ids ?? []);
    const bSide = teamSide(roster, teamB?.player_ids ?? []);
    if (!aSide || !bSide || aSide === bSide) {
      return unavailable(
        `Round ${round.number} cannot prove consistent Team A/B side assignment.`,
        'inconsistent_team_membership',
        round.number,
      );
    }
    rounds.push({
      number: round.number,
      sides: { A: aSide, B: bSide },
      source: round,
    });
  }

  return {
    teams,
    rounds,
    availability: {
      state: 'available',
      reason: null,
      failure_code: null,
      failure_round: null,
    },
  };
}
