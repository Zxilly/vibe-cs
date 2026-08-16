import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import {
  playerEvidenceActionIntent,
  type PlayerEvidenceCompilationIntent,
} from './playerEvidenceActions';
import {
  buildManAdvantageWorkspace,
  type ManAdvantageDeathEvidence,
} from './manAdvantageWorkspace';

export type ManAdvantageEvidenceActionContext = {
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

export type ManAdvantageEvidenceActionContract = {
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

function samePosition(
  left: readonly number[] | null,
  right: readonly number[] | null,
): boolean {
  return left === null
    ? right === null
    : right !== null
      && left.length === right.length
      && left.every((value, index) => value === right[index]);
}

function canonicalSourceAvailable(
  workspace: AnalysisWorkspace,
  evidence: ManAdvantageDeathEvidence,
): boolean {
  const canonical = buildManAdvantageWorkspace(workspace).rounds
    .flatMap((round) => round.transitions)
    .flatMap((transition) => transition.deaths)
    .find((candidate) => candidate.evidence_id === evidence.evidence_id) ?? null;
  return canonical !== null
    && canonical.demo_id === evidence.demo_id
    && canonical.source_kind === evidence.source_kind
    && canonical.source_id === evidence.source_id
    && canonical.round === evidence.round
    && canonical.tick === evidence.tick
    && canonical.end_tick === evidence.end_tick
    && canonical.seconds === evidence.seconds
    && canonical.actor_id === evidence.actor_id
    && canonical.actor_name === evidence.actor_name
    && canonical.actor_team === evidence.actor_team
    && canonical.elimination_relation === evidence.elimination_relation
    && canonical.target_id === evidence.target_id
    && canonical.target_name === evidence.target_name
    && canonical.target_team === evidence.target_team
    && canonical.weapon === evidence.weapon
    && canonical.headshot === evidence.headshot
    && canonical.penetrated === evidence.penetrated
    && samePosition(canonical.position, evidence.position);
}

export function manAdvantageEvidenceActionContract(
  workspace: AnalysisWorkspace,
  evidence: ManAdvantageDeathEvidence,
  context: ManAdvantageEvidenceActionContext,
): ManAdvantageEvidenceActionContract {
  const canonical = canonicalSourceAvailable(workspace, evidence);
  const sourceReason = canonical
    ? null
    : 'The canonical man-advantage death event is not present with these exact facts.';
  const navigationPlayerId = evidence.actor_id ?? evidence.target_id;
  const navigation = (tab: 'rounds' | 'replay'): AnalysisNavigationPatch => ({
    tab,
    round: evidence.round,
    tick: evidence.tick,
    playerId: navigationPlayerId,
    evidenceId: evidence.evidence_id,
  });
  const watchReason = sourceReason ?? (!context.serviceAvailable
    ? 'Watch requires an analyzed local demo.'
    : !context.runtimeIdle
      ? 'Watch is unavailable while another playback or capture session is active.'
      : context.watchPending
        ? 'Watch is already starting.'
        : null);
  const addReason = sourceReason ?? (!evidence.actor_id
    ? 'This death has no verified actor for a production POV.'
    : context.alreadyAdded
      ? 'This evidence is already in the production plan.'
      : null);
  const compilation = canonical && evidence.actor_id
    ? {
        ...playerEvidenceActionIntent(workspace, evidence.actor_id, evidence).compilation,
        category: 'custom' as const,
      }
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
