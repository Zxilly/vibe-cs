import type {
  AnalysisWorkspace,
  PlayerAnalysis,
  TimelineEvent,
} from '../../shared/desktop/dto';
import type { PlayerEvidenceAvailability, PlayerEvidenceRef } from './playerMatchEvidence';

export type OpeningDuelOutcome = 'all' | 'opening_kill' | 'opening_death';

export type OpeningDuelFilter = {
  playerId: string | null;
  targetId?: string | null;
  round: number | null;
  outcome: OpeningDuelOutcome;
};

export type OpeningDuelEvidence = PlayerEvidenceRef & {
  event_kind: 'kill';
  seconds: number;
  actor_id: string;
  actor_name: string;
  actor_team: PlayerAnalysis['team'];
  target_id: string;
  target_name: string;
  target_team: PlayerAnalysis['team'];
  weapon: string | null;
  headshot: boolean;
  penetrated: boolean;
  position: [number, number, number] | null;
};

export type OpeningRoundUnavailableReason =
  | 'no_kill_event'
  | 'outside_round_bounds'
  | 'missing_actor'
  | 'missing_target'
  | 'unknown_actor'
  | 'unknown_target'
  | 'self_elimination';

export type OpeningRoundAssessment = {
  round: number;
  state: 'available' | 'unavailable';
  reason_code: OpeningRoundUnavailableReason | null;
  reason: string | null;
  source_id: string | null;
  evidence: OpeningDuelEvidence | null;
};

export type OpeningPlayerAggregate = {
  player_id: string;
  player_name: string;
  player_team: PlayerAnalysis['team'];
  opening_kills: number;
  opening_deaths: number;
  atomic_evidence_count: number;
};

export type OpeningDuelMatrixPlayer = {
  player_id: string;
  player_name: string;
  player_team: PlayerAnalysis['team'];
};

export type OpeningDuelMatrixCell = {
  actor_id: string;
  target_id: string;
  opening_kills: number;
  evidence_ids: string[];
};

export type OpeningDuelMatrix = {
  players: OpeningDuelMatrixPlayer[];
  cells: OpeningDuelMatrixCell[];
};

export type OpeningUnavailableSummary = {
  count: number;
  reasons: Array<{ code: OpeningRoundUnavailableReason; count: number }>;
};

export type OpeningDuelWorkspace = {
  selected_player: PlayerAnalysis | null;
  evidence: OpeningDuelEvidence[];
  player_aggregates: OpeningPlayerAggregate[];
  matrix: OpeningDuelMatrix;
  round_assessments: OpeningRoundAssessment[];
  unavailable_rounds: OpeningUnavailableSummary;
  availability: PlayerEvidenceAvailability;
};

function earliestKill(events: TimelineEvent[]): TimelineEvent | null {
  let earliest: TimelineEvent | null = null;
  for (const event of events) {
    if (event.kind !== 'kill') continue;
    if (earliest === null || event.tick < earliest.tick) earliest = event;
  }
  return earliest;
}

function unavailableAssessment(
  round: number,
  code: OpeningRoundUnavailableReason,
  reason: string,
  sourceId: string | null,
): OpeningRoundAssessment {
  return {
    round,
    state: 'unavailable',
    reason_code: code,
    reason,
    source_id: sourceId,
    evidence: null,
  };
}

function assessRound(
  workspace: AnalysisWorkspace,
  round: AnalysisWorkspace['rounds'][number],
  playersById: ReadonlyMap<string, PlayerAnalysis>,
): OpeningRoundAssessment {
  const firstKill = earliestKill(round.events);
  if (!firstKill) {
    return unavailableAssessment(
      round.number,
      'no_kill_event',
      `Round ${round.number} has no parsed kill event.`,
      null,
    );
  }
  if (!Number.isFinite(firstKill.tick)
    || firstKill.tick < round.start_tick
    || firstKill.tick > round.end_tick) {
    return unavailableAssessment(
      round.number,
      'outside_round_bounds',
      `The first kill event in Round ${round.number} is outside its verified tick range.`,
      firstKill.id,
    );
  }
  const actorValue = firstKill.actor?.trim() ?? '';
  if (!actorValue) {
    return unavailableAssessment(
      round.number,
      'missing_actor',
      `The first kill event in Round ${round.number} has no actor.`,
      firstKill.id,
    );
  }
  const targetValue = firstKill.target?.trim() ?? '';
  if (!targetValue) {
    return unavailableAssessment(
      round.number,
      'missing_target',
      `The first kill event in Round ${round.number} has no target.`,
      firstKill.id,
    );
  }
  const actor = playersById.get(actorValue) ?? null;
  if (!actor) {
    return unavailableAssessment(
      round.number,
      'unknown_actor',
      `The first kill actor in Round ${round.number} does not resolve to a verified player.`,
      firstKill.id,
    );
  }
  const target = playersById.get(targetValue) ?? null;
  if (!target) {
    return unavailableAssessment(
      round.number,
      'unknown_target',
      `The first kill target in Round ${round.number} does not resolve to a verified player.`,
      firstKill.id,
    );
  }
  if (actor.id === target.id) {
    return unavailableAssessment(
      round.number,
      'self_elimination',
      `The first kill event in Round ${round.number} resolves to the same player twice.`,
      firstKill.id,
    );
  }

  const evidence: OpeningDuelEvidence = {
    evidence_id: `demo:${workspace.demo_id}/event:${firstKill.id}`,
    demo_id: workspace.demo_id,
    source_kind: 'event',
    source_id: firstKill.id,
    round: round.number,
    tick: firstKill.tick,
    end_tick: null,
    event_kind: 'kill',
    seconds: firstKill.seconds,
    actor_id: actor.id,
    actor_name: actor.name,
    actor_team: actor.team,
    target_id: target.id,
    target_name: target.name,
    target_team: target.team,
    weapon: firstKill.weapon?.trim() || null,
    headshot: firstKill.headshot,
    penetrated: firstKill.penetrated,
    position: firstKill.position ? [...firstKill.position] : null,
  };
  return {
    round: round.number,
    state: 'available',
    reason_code: null,
    reason: null,
    source_id: firstKill.id,
    evidence,
  };
}

function unavailableSummary(assessments: OpeningRoundAssessment[]): OpeningUnavailableSummary {
  const counts = new Map<OpeningRoundUnavailableReason, number>();
  for (const assessment of assessments) {
    if (assessment.reason_code) {
      counts.set(assessment.reason_code, (counts.get(assessment.reason_code) ?? 0) + 1);
    }
  }
  return {
    count: [...counts.values()].reduce((total, count) => total + count, 0),
    reasons: [...counts].map(([code, count]) => ({ code, count })),
  };
}

function evidenceAvailability(
  assessments: OpeningRoundAssessment[],
  unavailable: OpeningUnavailableSummary,
): PlayerEvidenceAvailability {
  if (assessments.length === 0) {
    return { state: 'unavailable', reason: 'No analyzed rounds match this filter.' };
  }
  if (unavailable.count === 0) return { state: 'available', reason: null };
  const reason = `Opening evidence is unavailable for ${unavailable.count} of ${assessments.length} rounds.`;
  return {
    state: unavailable.count === assessments.length ? 'unavailable' : 'partial',
    reason,
  };
}

function playerAggregates(
  players: PlayerAnalysis[],
  evidence: OpeningDuelEvidence[],
): OpeningPlayerAggregate[] {
  return players.map((player) => {
    const openingKills = evidence.filter((item) => item.actor_id === player.id).length;
    const openingDeaths = evidence.filter((item) => item.target_id === player.id).length;
    return {
      player_id: player.id,
      player_name: player.name,
      player_team: player.team,
      opening_kills: openingKills,
      opening_deaths: openingDeaths,
      atomic_evidence_count: openingKills + openingDeaths,
    };
  });
}

function openingDuelMatrix(
  players: PlayerAnalysis[],
  evidence: OpeningDuelEvidence[],
): OpeningDuelMatrix {
  return {
    players: players.map((player) => ({
      player_id: player.id,
      player_name: player.name,
      player_team: player.team,
    })),
    cells: players.flatMap((actor) => players
      .filter((target) => target.id !== actor.id)
      .map((target) => {
        const matchingEvidence = evidence.filter(
          (item) => item.actor_id === actor.id && item.target_id === target.id,
        );
        return {
          actor_id: actor.id,
          target_id: target.id,
          opening_kills: matchingEvidence.length,
          evidence_ids: matchingEvidence.map((item) => item.evidence_id),
        };
      })),
  };
}

export function buildOpeningDuelWorkspace(
  workspace: AnalysisWorkspace,
  filter: OpeningDuelFilter,
): OpeningDuelWorkspace {
  const selectedPlayer = filter.playerId
    ? workspace.players.find((player) => player.id === filter.playerId) ?? null
    : null;
  const playersById = new Map(workspace.players.map((player) => [player.id, player]));
  const rounds = workspace.rounds.filter(
    (round) => filter.round === null || round.number === filter.round,
  );
  const assessments = rounds.map((round) => assessRound(workspace, round, playersById));
  const allEvidence = assessments
    .flatMap((assessment) => assessment.evidence ? [assessment.evidence] : [])
    .sort((left, right) => left.round - right.round || left.tick - right.tick);
  const unavailable = unavailableSummary(assessments);
  const matrix = openingDuelMatrix(workspace.players, allEvidence);
  const aggregates = playerAggregates(workspace.players, allEvidence);
  const unavailableResult = (
    player: PlayerAnalysis | null,
    reason: string,
  ): OpeningDuelWorkspace => ({
    selected_player: player,
    evidence: [],
    player_aggregates: aggregates,
    matrix,
    round_assessments: assessments,
    unavailable_rounds: unavailable,
    availability: { state: 'unavailable', reason },
  });

  if (filter.playerId && !selectedPlayer) {
    return unavailableResult(null, 'Select a verified player or clear the player filter.');
  }
  if (filter.targetId && !selectedPlayer) {
    return unavailableResult(
      null,
      'Select a verified actor before filtering an opening matchup.',
    );
  }
  if (filter.targetId
    && !workspace.players.some((player) => player.id === filter.targetId)) {
    return unavailableResult(
      selectedPlayer,
      'Select a verified target or clear the matchup filter.',
    );
  }
  if (filter.targetId && filter.targetId === selectedPlayer?.id) {
    return unavailableResult(
      selectedPlayer,
      'Opening matchup actor and target must be different players.',
    );
  }
  if (!selectedPlayer && filter.outcome !== 'all') {
    return unavailableResult(
      null,
      'Select a verified player before filtering opening kills or deaths.',
    );
  }

  const evidence = allEvidence.filter((item) => {
    if (filter.targetId) {
      return item.actor_id === selectedPlayer?.id && item.target_id === filter.targetId;
    }
    if (!selectedPlayer) return true;
    if (filter.outcome === 'opening_kill') return item.actor_id === selectedPlayer.id;
    if (filter.outcome === 'opening_death') return item.target_id === selectedPlayer.id;
    return item.actor_id === selectedPlayer.id || item.target_id === selectedPlayer.id;
  });
  return {
    selected_player: selectedPlayer,
    evidence,
    player_aggregates: aggregates,
    matrix,
    round_assessments: assessments,
    unavailable_rounds: unavailable,
    availability: evidenceAvailability(assessments, unavailable),
  };
}
