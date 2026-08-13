import type { AnalysisWorkspace } from '../../shared/desktop/dto';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import {
  economyEvidenceActionContract,
  type EconomyEvidenceActionContext,
  type EconomyEvidenceActionContract,
} from './economyEvidenceActions';
import {
  buildTeamEconomyWorkspace,
  type TeamEconomyEvidence,
} from './teamEconomyWorkspace';

export type TeamEconomyEvidenceActionContext = EconomyEvidenceActionContext;
export type TeamEconomyEvidenceActionContract = EconomyEvidenceActionContract;

function sameEvidence(
  left: TeamEconomyEvidence,
  right: TeamEconomyEvidence,
): boolean {
  return left.evidence_id === right.evidence_id
    && left.demo_id === right.demo_id
    && left.source_kind === right.source_kind
    && left.source_id === right.source_id
    && left.round === right.round
    && left.tick === right.tick
    && left.end_tick === right.end_tick
    && left.event_kind === right.event_kind
    && left.seconds === right.seconds
    && left.actor_id === right.actor_id
    && left.actor_name === right.actor_name
    && left.stable_team === right.stable_team
    && left.side === right.side
    && left.item === right.item
    && left.cost === right.cost;
}

function canonicalSourceAvailable(
  workspace: AnalysisWorkspace,
  evidence: TeamEconomyEvidence,
): boolean {
  const first = buildTeamEconomyWorkspace(workspace, {
    team: evidence.stable_team,
    side: evidence.side,
    round: evidence.round,
    page: 1,
  });
  for (let page = 1; page <= first.page.total_pages; page += 1) {
    const items = page === 1
      ? first.page.items
      : buildTeamEconomyWorkspace(workspace, {
          team: evidence.stable_team,
          side: evidence.side,
          round: evidence.round,
          page,
        }).page.items;
    const candidate = items.find((item) => item.evidence_id === evidence.evidence_id);
    if (candidate) return sameEvidence(candidate, evidence);
  }
  return false;
}

function unavailableContract(
  evidence: TeamEconomyEvidence,
): TeamEconomyEvidenceActionContract {
  const reason = 'The canonical team purchase is not present at this round and tick.';
  const navigation = (tab: 'rounds' | 'replay'): AnalysisNavigationPatch => ({
    tab,
    round: evidence.round,
    tick: evidence.tick,
    playerId: evidence.actor_id,
    evidenceId: evidence.evidence_id,
  });
  return {
    round: { available: false, reason, navigation: navigation('rounds') },
    replay: { available: false, reason, navigation: navigation('replay') },
    watch: { available: false, reason, start_tick: evidence.tick },
    add: { available: false, reason, compilation: null },
  };
}

export function teamEconomyEvidenceActionContract(
  workspace: AnalysisWorkspace,
  evidence: TeamEconomyEvidence,
  context: TeamEconomyEvidenceActionContext,
): TeamEconomyEvidenceActionContract {
  return canonicalSourceAvailable(workspace, evidence)
    ? economyEvidenceActionContract(workspace, evidence, context)
    : unavailableContract(evidence);
}
