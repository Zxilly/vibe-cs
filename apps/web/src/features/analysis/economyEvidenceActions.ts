import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import {
  playerEvidenceActionIntent,
  type PlayerEvidenceCompilationIntent,
} from './playerEvidenceActions';
import type { EconomyAtomicEvidence } from './economyEvidenceWorkspace';

export type EconomyEvidenceActionContext = {
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

export type EconomyEvidenceActionContract = {
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

function isLocatable(workspace: AnalysisWorkspace, evidence: EconomyAtomicEvidence): boolean {
  if (evidence.demo_id !== workspace.demo_id
    || evidence.source_kind !== 'event'
    || evidence.evidence_id !== `demo:${workspace.demo_id}/event:${evidence.source_id}`) return false;
  const round = workspace.rounds.find((candidate) => candidate.number === evidence.round);
  const event = round?.events.find((candidate) => candidate.id === evidence.source_id);
  const eventActor = event?.actor
    ? workspace.players.find((player) => player.id === event.actor || player.name === event.actor)?.id
      ?? event.actor
    : null;
  return event?.kind === 'purchase'
    && event.tick === evidence.tick
    && eventActor === evidence.actor_id;
}

export function economyEvidenceActionContract(
  workspace: AnalysisWorkspace,
  evidence: EconomyAtomicEvidence,
  context: EconomyEvidenceActionContext,
): EconomyEvidenceActionContract {
  const locatable = isLocatable(workspace, evidence);
  const playerId = evidence.actor_id
    && workspace.players.some((player) => player.id === evidence.actor_id)
    ? evidence.actor_id
    : null;
  const locationReason = locatable
    ? null
    : 'This purchase evidence is not locatable in the current analysis.';
  const navigation = (tab: 'rounds' | 'replay'): AnalysisNavigationPatch => ({
    tab,
    round: evidence.round,
    tick: evidence.tick,
    playerId,
    evidenceId: evidence.evidence_id,
  });
  const watchReason = locationReason ?? (!context.serviceAvailable
    ? 'Watch requires an analyzed local demo.'
    : !context.runtimeIdle
      ? 'Watch is unavailable while another playback or capture session is active.'
      : context.watchPending
        ? 'Watch is already starting.'
        : null);
  const addReason = locationReason ?? (playerId === null
    ? 'A verified purchase actor is required before this evidence can be added to production.'
    : context.alreadyAdded
      ? 'This evidence is already in the production plan.'
      : null);
  const compilation = locatable && playerId
    ? {
        ...playerEvidenceActionIntent(workspace, playerId, evidence).compilation,
        title: [
          'Purchase',
          evidence.item?.toLocaleUpperCase(),
          evidence.actor_name,
          `Round ${evidence.round}`,
        ].filter(Boolean).join(' · '),
        category: 'custom' as const,
      }
    : null;

  return {
    round: { available: locatable, reason: locationReason, navigation: navigation('rounds') },
    replay: { available: locatable, reason: locationReason, navigation: navigation('replay') },
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
