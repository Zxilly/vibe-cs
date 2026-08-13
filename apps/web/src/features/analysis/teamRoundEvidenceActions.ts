import type { AnalysisWorkspace } from '../../shared/desktop/dto';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import {
  playerEvidenceActionIntent,
  type PlayerEvidenceCompilationIntent,
} from './playerEvidenceActions';
import {
  buildTeamRoundWorkspace,
  type TeamRoundEvidence,
} from './teamRoundWorkspace';

export type TeamRoundEvidenceActionContext = {
  serviceAvailable: boolean;
  runtimeIdle: boolean;
  watchPending: boolean;
  alreadyAdded: boolean;
};

type NavigableAction = {
  available: boolean;
  reason: string | null;
  navigation: AnalysisNavigationPatch;
};

export type TeamRoundEvidenceActionContract = {
  round: NavigableAction;
  replay: NavigableAction;
  watch: {
    available: boolean;
    reason: string | null;
    start_tick: number;
  };
  add: {
    available: boolean;
    reason: string | null;
    compilation: PlayerEvidenceCompilationIntent | null;
  };
};

function canonicalSourceAvailable(
  workspace: AnalysisWorkspace,
  evidence: TeamRoundEvidence,
): boolean {
  const canonical = buildTeamRoundWorkspace(workspace, {
    team: evidence.selected_team,
    side: evidence.selected_side,
  }).evidence.find((candidate) => candidate.evidence_id === evidence.evidence_id) ?? null;
  return canonical !== null
    && canonical.demo_id === evidence.demo_id
    && canonical.source_kind === evidence.source_kind
    && canonical.source_id === evidence.source_id
    && canonical.round === evidence.round
    && canonical.tick === evidence.tick
    && canonical.end_tick === evidence.end_tick
    && canonical.event_kind === evidence.event_kind
    && canonical.seconds === evidence.seconds
    && canonical.selected_team === evidence.selected_team
    && canonical.selected_side === evidence.selected_side
    && canonical.actor_id === evidence.actor_id
    && canonical.actor_name === evidence.actor_name
    && canonical.actor_team === evidence.actor_team
    && canonical.target_id === evidence.target_id
    && canonical.target_name === evidence.target_name
    && canonical.target_team === evidence.target_team
    && canonical.winner_team === evidence.winner_team
    && canonical.weapon === evidence.weapon
    && canonical.headshot === evidence.headshot
    && canonical.penetrated === evidence.penetrated;
}

export function teamRoundEvidenceActionContract(
  workspace: AnalysisWorkspace,
  evidence: TeamRoundEvidence,
  context: TeamRoundEvidenceActionContext,
): TeamRoundEvidenceActionContract {
  const canonical = canonicalSourceAvailable(workspace, evidence);
  const sourceReason = canonical
    ? null
    : 'The canonical team round event is not present at this round and tick.';
  const playerId = evidence.event_kind === 'kill' ? evidence.actor_id : null;
  const navigation = (tab: 'rounds' | 'replay'): AnalysisNavigationPatch => ({
    tab,
    round: evidence.round,
    tick: evidence.tick,
    playerId,
    evidenceId: evidence.evidence_id,
  });
  const watchReason = sourceReason ?? (!context.serviceAvailable
    ? 'Watch requires an analyzed local demo.'
    : !context.runtimeIdle
      ? 'Watch is unavailable while another playback or capture session is active.'
      : context.watchPending
        ? 'Watch is already starting.'
        : null);
  const addReason = sourceReason ?? (evidence.event_kind !== 'kill' || !playerId
    ? 'Round-end evidence has no verified POV actor for the production plan.'
    : context.alreadyAdded
      ? 'This evidence is already in the production plan.'
      : null);
  const compilation = canonical && evidence.event_kind === 'kill' && playerId
    ? playerEvidenceActionIntent(workspace, playerId, evidence).compilation
    : null;
  return {
    round: {
      available: sourceReason === null,
      reason: sourceReason,
      navigation: navigation('rounds'),
    },
    replay: {
      available: sourceReason === null,
      reason: sourceReason,
      navigation: navigation('replay'),
    },
    watch: {
      available: watchReason === null,
      reason: watchReason,
      start_tick: evidence.tick,
    },
    add: {
      available: addReason === null,
      reason: addReason,
      compilation,
    },
  };
}
