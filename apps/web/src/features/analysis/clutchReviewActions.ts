import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import {
  buildClutchReviewWorkspace,
  type ClutchReviewEvidence,
} from './clutchReviewWorkspace';

export type ClutchReviewActionContext = {
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

export type ClutchReviewActionContract = {
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
  };
};

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalSourceAvailable(
  workspace: AnalysisWorkspace,
  evidence: ClutchReviewEvidence,
): boolean {
  const canonical = buildClutchReviewWorkspace(workspace, {
    outcome: null,
    opponent_count: null,
    player_id: null,
  }).evidence.find((candidate) => candidate.evidence_id === evidence.evidence_id) ?? null;
  return canonical !== null
    && canonical.demo_id === evidence.demo_id
    && canonical.source_kind === evidence.source_kind
    && canonical.source_id === evidence.source_id
    && canonical.outcome === evidence.outcome
    && canonical.opponent_count === evidence.opponent_count
    && canonical.player_id === evidence.player_id
    && canonical.player_name === evidence.player_name
    && canonical.round === evidence.round
    && canonical.tick === evidence.tick
    && canonical.end_tick === evidence.end_tick
    && canonical.eliminations === evidence.eliminations
    && canonical.survived === evidence.survived
    && sameStrings(canonical.victim_ids, evidence.victim_ids)
    && sameStrings(canonical.victim_names, evidence.victim_names);
}

export function clutchReviewActionContract(
  workspace: AnalysisWorkspace,
  evidence: ClutchReviewEvidence,
  context: ClutchReviewActionContext,
): ClutchReviewActionContract {
  const canonical = canonicalSourceAvailable(workspace, evidence);
  const sourceReason = canonical
    ? null
    : 'The canonical clutch highlight is not present with these exact facts.';
  const navigation = (tab: 'rounds' | 'replay'): AnalysisNavigationPatch => ({
    tab,
    round: evidence.round,
    tick: evidence.tick,
    playerId: evidence.player_id,
    evidenceId: evidence.evidence_id,
  });
  const watchReason = sourceReason ?? (!context.serviceAvailable
    ? 'Watch requires an analyzed local demo.'
    : !context.runtimeIdle
      ? 'Watch is unavailable while another playback or capture session is active.'
      : context.watchPending
        ? 'Watch is already starting.'
        : null);
  const addReason = sourceReason ?? (context.alreadyAdded
    ? 'This clutch evidence is already in the production plan.'
    : null);
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
    },
  };
}
