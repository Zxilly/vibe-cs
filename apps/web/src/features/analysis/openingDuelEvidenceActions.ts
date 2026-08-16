import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import {
  playerEvidenceActionIntent,
  type PlayerEvidenceCompilationIntent,
} from './playerEvidenceActions';
import {
  buildOpeningDuelWorkspace,
  type OpeningDuelEvidence,
} from './openingDuelWorkspace';

export type OpeningDuelActionContext = {
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

export type OpeningDuelEvidenceActionContract = {
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

function actionPlayerId(
  workspace: AnalysisWorkspace,
  selectedPlayerId: string | null,
  evidence: OpeningDuelEvidence,
): string | null {
  const selectedIsParticipant = selectedPlayerId === evidence.actor_id
    || selectedPlayerId === evidence.target_id;
  if (selectedPlayerId && selectedIsParticipant
    && workspace.players.some((player) => player.id === selectedPlayerId)) {
    return selectedPlayerId;
  }
  return workspace.players.some((player) => player.id === evidence.actor_id)
    ? evidence.actor_id
    : null;
}

function canonicalSourceAvailable(
  workspace: AnalysisWorkspace,
  evidence: OpeningDuelEvidence,
): boolean {
  const canonical = buildOpeningDuelWorkspace(workspace, {
    playerId: null,
    round: evidence.round,
    outcome: 'all',
  }).evidence[0] ?? null;
  if (!canonical) return false;
  const samePosition = canonical.position === null
    ? evidence.position === null
    : evidence.position !== null
      && canonical.position.every((value, index) => value === evidence.position?.[index]);
  return evidence.demo_id === canonical.demo_id
    && evidence.source_kind === 'event'
    && evidence.source_id === canonical.source_id
    && evidence.evidence_id === canonical.evidence_id
    && evidence.round === canonical.round
    && evidence.tick === canonical.tick
    && evidence.end_tick === canonical.end_tick
    && evidence.event_kind === canonical.event_kind
    && evidence.seconds === canonical.seconds
    && evidence.actor_id === canonical.actor_id
    && evidence.actor_name === canonical.actor_name
    && evidence.actor_team === canonical.actor_team
    && evidence.target_id === canonical.target_id
    && evidence.target_name === canonical.target_name
    && evidence.target_team === canonical.target_team
    && evidence.weapon === canonical.weapon
    && evidence.headshot === canonical.headshot
    && evidence.penetrated === canonical.penetrated
    && samePosition;
}

export function openingDuelEvidenceActionContract(
  workspace: AnalysisWorkspace,
  selectedPlayerId: string | null,
  evidence: OpeningDuelEvidence,
  context: OpeningDuelActionContext,
): OpeningDuelEvidenceActionContract {
  const playerId = actionPlayerId(workspace, selectedPlayerId, evidence);
  const sourceAvailable = canonicalSourceAvailable(workspace, evidence);
  const sourceReason = sourceAvailable
    ? null
    : 'The canonical opening kill event is not present at this round and tick.';
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
  const addReason = sourceReason ?? (!playerId
    ? 'A verified participant is required before this evidence can be added to production.'
    : context.alreadyAdded
      ? 'This evidence is already in the production plan.'
      : null);
  const compilation = sourceAvailable && playerId
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
