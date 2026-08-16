import type { AnalysisWorkspace, PlayerAnalysis } from '../../shared/desktop/viewModels';
import {
  buildPlayerMatchEvidence,
  type PlayerDuelInteraction,
  type PlayerEvidenceAvailability,
} from './playerMatchEvidence';

export type DuelEvidenceFilter = {
  playerId: string | null;
  opponentId: string | null;
  round: number | null;
};

export type DuelMatchupAggregate = {
  id: string;
  player_id: string;
  player_name: string;
  player_team: PlayerAnalysis['team'];
  opponent_id: string;
  opponent_name: string;
  opponent_team: PlayerAnalysis['team'] | null;
  kills: number;
  deaths: number;
  headshot_kills: number;
  damage_dealt: number | null;
  damage_taken: number | null;
  damage_events: number;
  summary_source: 'insights' | 'events';
  aggregate_scope: 'match';
  atomic_evidence_count: number;
};

export type DuelEvidenceWorkspace = {
  player: PlayerAnalysis | null;
  matchups: DuelMatchupAggregate[];
  evidence: PlayerDuelInteraction[];
  atomic_summary: DuelAtomicSummary;
  availability: PlayerEvidenceAvailability;
};

export type DuelMetricAvailability = {
  state: 'available' | 'partial' | 'unavailable';
  reason: string | null;
};

export type DuelAtomicSummary = {
  engagement_count: number;
  kill_events: number;
  death_events: number;
  damage_dealt_events: number;
  damage_taken_events: number;
  verified_damage_dealt: number | null;
  verified_damage_taken: number | null;
  damage_availability: DuelMetricAvailability;
};

const unavailable = (reason: string): PlayerEvidenceAvailability => ({
  state: 'unavailable',
  reason,
});

function summarizeAtomicEvidence(evidence: PlayerDuelInteraction[]): DuelAtomicSummary {
  const damageEvents = evidence.filter((item) => item.event_kind === 'damage');
  const missingDamage = damageEvents.filter((item) => item.damage === null).length;
  const dealt = damageEvents.filter((item) => item.perspective === 'damage_dealt');
  const taken = damageEvents.filter((item) => item.perspective === 'damage_taken');
  const damageAvailability: DuelMetricAvailability = damageEvents.length === 0
    ? {
        state: 'unavailable',
        reason: 'No directional damage events match these filters.',
      }
    : missingDamage > 0
      ? {
          state: 'partial',
          reason: `${missingDamage} matching damage event${missingDamage === 1 ? '' : 's'} ${missingDamage === 1 ? 'has' : 'have'} no numeric amount; totals include verified amounts only.`,
        }
      : { state: 'available', reason: null };
  return {
    engagement_count: evidence.length,
    kill_events: evidence.filter((item) => item.perspective === 'kill').length,
    death_events: evidence.filter((item) => item.perspective === 'death').length,
    damage_dealt_events: dealt.length,
    damage_taken_events: taken.length,
    verified_damage_dealt: dealt.length > 0
      ? dealt.reduce((total, item) => total + (item.damage ?? 0), 0)
      : null,
    verified_damage_taken: taken.length > 0
      ? taken.reduce((total, item) => total + (item.damage ?? 0), 0)
      : null,
    damage_availability: damageAvailability,
  };
}

export function buildDuelEvidenceWorkspace(
  workspace: AnalysisWorkspace,
  filter: DuelEvidenceFilter,
): DuelEvidenceWorkspace {
  const player = filter.playerId
    ? workspace.players.find((candidate) => candidate.id === filter.playerId) ?? null
    : null;
  if (!player) {
    return {
      player: null,
      matchups: [],
      evidence: [],
      atomic_summary: summarizeAtomicEvidence([]),
      availability: unavailable('Select a verified player to inspect directional matchups.'),
    };
  }

  const playerEvidence = buildPlayerMatchEvidence(workspace, player.id);
  if (!playerEvidence) {
    return {
      player,
      matchups: [],
      evidence: [],
      atomic_summary: summarizeAtomicEvidence([]),
      availability: unavailable('Directional matchup evidence could not be built for this player.'),
    };
  }

  const selectedDuels = playerEvidence.duels.filter(
    (duel) => filter.opponentId === null || duel.opponent_id === filter.opponentId,
  );
  const matchups: DuelMatchupAggregate[] = selectedDuels.map((duel) => ({
    id: duel.id,
    player_id: player.id,
    player_name: player.name,
    player_team: player.team,
    opponent_id: duel.opponent_id,
    opponent_name: duel.opponent_name,
    opponent_team: duel.opponent_team,
    kills: duel.kills,
    deaths: duel.deaths,
    headshot_kills: duel.headshot_kills,
    damage_dealt: duel.damage_dealt,
    damage_taken: duel.damage_taken,
    damage_events: duel.damage_events,
    summary_source: duel.summary_source,
    aggregate_scope: 'match',
    atomic_evidence_count: duel.engagements.length,
  }));
  const evidence = selectedDuels
    .flatMap((duel) => duel.engagements)
    .filter((item) => filter.round === null || item.round === filter.round)
    .sort((left, right) => left.round - right.round
      || left.tick - right.tick
      || left.evidence_id.localeCompare(right.evidence_id));

  return {
    player,
    matchups,
    evidence,
    atomic_summary: summarizeAtomicEvidence(evidence),
    availability: playerEvidence.availability.duels,
  };
}
