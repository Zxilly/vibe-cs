import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import {
  playerEvidenceActionIntent,
  type PlayerEvidenceCompilationIntent,
} from './playerEvidenceActions';
import type { WeaponAtomicEvidence } from './weaponEvidenceWorkspace';

export type WeaponEvidenceActionContext = {
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

export type WeaponEvidenceActionContract = {
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

export function weaponEvidenceActionContract(
  workspace: AnalysisWorkspace,
  evidence: WeaponAtomicEvidence,
  context: WeaponEvidenceActionContext,
): WeaponEvidenceActionContract {
  const playerId = evidence.actor_id
    && workspace.players.some((player) => player.id === evidence.actor_id)
    ? evidence.actor_id
    : null;
  const roundAvailable = workspace.rounds.some((round) => round.number === evidence.round);
  const roundReason = roundAvailable ? null : `Round ${evidence.round} is not present in this analysis.`;
  const navigation = (tab: 'rounds' | 'replay'): AnalysisNavigationPatch => ({
    tab,
    round: evidence.round,
    tick: evidence.tick,
    playerId,
    evidenceId: evidence.evidence_id,
  });
  const watchReason = roundReason ?? (!context.serviceAvailable
    ? 'Watch requires an analyzed local demo.'
    : !context.runtimeIdle
      ? 'Watch is unavailable while another playback or capture session is active.'
      : context.watchPending
        ? 'Watch is already starting.'
        : null);
  const alreadyAddedReason = context.alreadyAdded ? 'This evidence is already in the production plan.' : null;
  const addReason = playerId === null
    ? 'A verified actor is required before this evidence can be added to production.'
    : alreadyAddedReason;
  const compilation = playerId === null
    ? null
    : playerEvidenceActionIntent(workspace, playerId, evidence).compilation;

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
