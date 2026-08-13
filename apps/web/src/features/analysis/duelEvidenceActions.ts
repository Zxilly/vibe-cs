import type { AnalysisWorkspace } from '../../shared/desktop/dto';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import {
  playerEvidenceActionIntent,
  type PlayerEvidenceCompilationIntent,
} from './playerEvidenceActions';
import type { PlayerDuelInteraction } from './playerMatchEvidence';

export type DuelEvidenceActionContext = {
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

export type DuelEvidenceActionContract = {
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

export function duelEvidenceActionContract(
  workspace: AnalysisWorkspace,
  selectedPlayerId: string,
  evidence: PlayerDuelInteraction,
  context: DuelEvidenceActionContext,
): DuelEvidenceActionContract {
  const selectedPlayerAvailable = workspace.players.some(
    (player) => player.id === selectedPlayerId,
  );
  const roundAvailable = workspace.rounds.some((round) => round.number === evidence.round);
  const roundReason = roundAvailable
    ? null
    : `Round ${evidence.round} is not present in this analysis.`;
  const navigation = (tab: 'rounds' | 'replay'): AnalysisNavigationPatch => ({
    tab,
    round: evidence.round,
    tick: evidence.tick,
    playerId: selectedPlayerAvailable ? selectedPlayerId : null,
    evidenceId: evidence.evidence_id,
  });
  const watchReason = roundReason ?? (!context.serviceAvailable
    ? 'Watch requires an analyzed local demo.'
    : !context.runtimeIdle
      ? 'Watch is unavailable while another playback or capture session is active.'
      : context.watchPending
        ? 'Watch is already starting.'
        : null);
  const addReason = !selectedPlayerAvailable
    ? 'A verified selected player is required before this evidence can be added to production.'
    : context.alreadyAdded
      ? 'This evidence is already in the production plan.'
      : null;
  const compilation = selectedPlayerAvailable
    ? playerEvidenceActionIntent(workspace, selectedPlayerId, evidence).compilation
    : null;

  return {
    round: { available: roundAvailable, reason: roundReason, navigation: navigation('rounds') },
    replay: { available: roundAvailable, reason: roundReason, navigation: navigation('replay') },
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
