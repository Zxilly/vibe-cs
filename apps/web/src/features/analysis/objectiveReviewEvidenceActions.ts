import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import {
  playerEvidenceActionIntent,
  type PlayerEvidenceCompilationIntent,
} from './playerEvidenceActions';
import {
  buildObjectiveReviewWorkspace,
  type ObjectiveReviewAtom,
} from './objectiveReviewWorkspace';

export type ObjectiveReviewEvidenceActionContext = {
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

export type ObjectiveReviewEvidenceActionContract = {
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

function canonicalAtom(
  workspace: AnalysisWorkspace,
  evidence: ObjectiveReviewAtom,
): ObjectiveReviewAtom | null {
  return buildObjectiveReviewWorkspace(workspace).rounds
    .flatMap((round) => round.timeline_groups)
    .flatMap((group) => group.atoms)
    .find((candidate) => candidate.evidence_id === evidence.evidence_id) ?? null;
}

function exactAtom(
  workspace: AnalysisWorkspace,
  evidence: ObjectiveReviewAtom,
): ObjectiveReviewAtom | null {
  const canonical = canonicalAtom(workspace, evidence);
  if (!canonical) return null;
  const fields = [
    'evidence_id',
    'demo_id',
    'source_id',
    'source_kind',
    'round',
    'tick',
    'end_tick',
    'seconds',
    'kind',
    'actor_id',
    'actor_name',
    'actor_team',
    'actor_side',
    'target_id',
    'target_name',
    'target_team',
    'target_side',
    'weapon',
    'headshot',
    'penetrated',
    'damage_health',
  ] as const satisfies readonly (keyof ObjectiveReviewAtom)[];
  return fields.every((field) => canonical[field] === evidence[field]) ? canonical : null;
}

export function objectiveReviewEvidenceActionContract(
  workspace: AnalysisWorkspace,
  evidence: ObjectiveReviewAtom,
  context: ObjectiveReviewEvidenceActionContext,
): ObjectiveReviewEvidenceActionContract {
  const canonical = exactAtom(workspace, evidence);
  const sourceReason = canonical
    ? null
    : 'The canonical objective-review atom is not present with these exact facts.';
  const navigationPlayerId = canonical?.actor_id ?? canonical?.target_id ?? null;
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
  const addReason = sourceReason ?? (!canonical?.actor_id
    ? 'This objective atom has no verified actor for a production POV.'
    : context.alreadyAdded
      ? 'This evidence is already in the production plan.'
      : null);
  const compilation = canonical?.actor_id
    ? {
        ...playerEvidenceActionIntent(workspace, canonical.actor_id, canonical).compilation,
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
