import type { TimelineEvent } from '../../shared/desktop/dto';
import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import type { EconomyAtomicEvidence } from './economyEvidenceWorkspace';
import {
  deriveStableMatchTeamContext,
  type CompetitiveSide,
  type StableMatchTeam,
  type StableMatchTeamAvailability,
} from './stableMatchTeamContext';

export const TEAM_ECONOMY_PAGE_SIZE = 50;

export type TeamEconomyFilter = {
  team: StableMatchTeam | null;
  side: CompetitiveSide | null;
  round: number | null;
  page: number;
};

export type TeamEconomyMetricAvailability = {
  state: 'available' | 'partial' | 'unavailable';
  reason: string | null;
};

export type TeamEconomyEvidence = EconomyAtomicEvidence & {
  stable_team: StableMatchTeam;
  side: CompetitiveSide;
};

export type TeamEconomyItemCount = {
  name: string;
  count: number;
};

export type TeamEconomyCell = {
  team: StableMatchTeam;
  side: CompetitiveSide;
  rounds_played: number;
  rounds: number[];
  purchase_count: number;
  decoded_purchase_cost: number | null;
  cost_availability: TeamEconomyMetricAvailability;
  items: TeamEconomyItemCount[];
};

export type TeamEconomyPage = {
  items: TeamEconomyEvidence[];
  total: number;
  page: number;
  page_size: typeof TEAM_ECONOMY_PAGE_SIZE;
  total_pages: number;
};

export type TeamEconomyAvailability = TeamEconomyMetricAvailability & {
  failure_code: StableMatchTeamAvailability['failure_code'] | 'no_purchase_evidence';
  failure_round: number | null;
  rejected_purchase_count: number;
};

export type TeamEconomyWorkspace = {
  cells: TeamEconomyCell[];
  selected_cell: TeamEconomyCell | null;
  available_rounds: number[];
  page: TeamEconomyPage;
  availability: TeamEconomyAvailability;
};

const stableTeams = ['A', 'B'] as const satisfies readonly StableMatchTeam[];
const competitiveSides = ['T', 'CT'] as const satisfies readonly CompetitiveSide[];

function emptyPage(page = 1): TeamEconomyPage {
  return {
    items: [],
    total: 0,
    page: Math.max(1, Math.trunc(page) || 1),
    page_size: TEAM_ECONOMY_PAGE_SIZE,
    total_pages: 0,
  };
}

function detail(event: TimelineEvent): Record<string, unknown> {
  return typeof event.detail === 'object' && event.detail !== null
    ? event.detail as Record<string, unknown>
    : {};
}

function normalizedSide(value: unknown): CompetitiveSide | null {
  const side = String(value ?? '').trim().toLocaleUpperCase().replaceAll('_', '-');
  if (side === 'T' || side === 'TERRORIST' || side === '2') return 'T';
  if (side === 'CT' || side === 'COUNTER-TERRORIST' || side === '3') return 'CT';
  return null;
}

function explicitEventSides(event: TimelineEvent): (CompetitiveSide | null)[] {
  const eventDetail = detail(event);
  const sides: (CompetitiveSide | null)[] = [];
  for (const key of ['team', 'team_num', 'userteam', 'user_team_num']) {
    if (key in eventDetail) sides.push(normalizedSide(eventDetail[key]));
  }
  return sides;
}

function normalizedItem(event: TimelineEvent): string | null {
  const value = event.weapon ?? detail(event).item_name;
  if (typeof value !== 'string') return null;
  const item = value.trim().toLocaleLowerCase().replace(/^weapon_/u, '');
  return item || null;
}

function decodedCost(event: TimelineEvent): number | null {
  const eventDetail = detail(event);
  for (const key of ['cost', 'price', 'item_cost', 'purchase_cost']) {
    const value = eventDetail[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function itemCounts(evidence: readonly TeamEconomyEvidence[]): TeamEconomyItemCount[] {
  const counts = new Map<string, number>();
  for (const item of evidence) {
    if (item.item) counts.set(item.item, (counts.get(item.item) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function unavailable(
  availability: StableMatchTeamAvailability,
  requestedPage: number,
): TeamEconomyWorkspace {
  return {
    cells: [],
    selected_cell: null,
    available_rounds: [],
    page: emptyPage(requestedPage),
    availability: {
      state: 'unavailable',
      reason: availability.reason,
      failure_code: availability.failure_code,
      failure_round: availability.failure_round,
      rejected_purchase_count: 0,
    },
  };
}

export function buildTeamEconomyWorkspace(
  workspace: AnalysisWorkspace,
  filter: TeamEconomyFilter,
): TeamEconomyWorkspace {
  const context = deriveStableMatchTeamContext(workspace);
  if (context.availability.state !== 'available') {
    return unavailable(context.availability, filter.page);
  }

  const players = new Map(workspace.players.map((player) => [player.id, player]));
  const purchaseIdCounts = new Map<string, number>();
  for (const round of context.rounds) {
    for (const event of round.source.events) {
      if (event.kind === 'purchase') {
        purchaseIdCounts.set(event.id, (purchaseIdCounts.get(event.id) ?? 0) + 1);
      }
    }
  }
  const evidence: TeamEconomyEvidence[] = [];
  let rejectedPurchaseCount = 0;
  for (const round of context.rounds) {
    for (const event of round.source.events) {
      if (event.kind !== 'purchase') continue;
      const actor = event.actor ? players.get(event.actor) ?? null : null;
      if (purchaseIdCounts.get(event.id) !== 1
        || !actor
        || event.tick < round.source.start_tick
        || event.tick > round.source.end_tick) {
        rejectedPurchaseCount += 1;
        continue;
      }
      const side = round.sides[actor.team];
      const explicitSides = explicitEventSides(event);
      if (explicitSides.some((explicitSide) => explicitSide !== side)) {
        rejectedPurchaseCount += 1;
        continue;
      }
      evidence.push({
        evidence_id: `demo:${workspace.demo_id}/event:${event.id}`,
        demo_id: workspace.demo_id,
        source_kind: 'event',
        source_id: event.id,
        round: round.number,
        tick: event.tick,
        end_tick: null,
        event_kind: 'purchase',
        seconds: event.seconds,
        actor_id: actor.id,
        actor_name: actor.name,
        stable_team: actor.team,
        side,
        item: normalizedItem(event),
        cost: decodedCost(event),
      });
    }
  }
  evidence.sort((left, right) => left.tick - right.tick
    || left.round - right.round
    || left.evidence_id.localeCompare(right.evidence_id));

  const cells = stableTeams.flatMap((team) => competitiveSides.map((side): TeamEconomyCell => {
    const rounds = context.rounds
      .filter((round) => round.sides[team] === side)
      .map((round) => round.number);
    const atoms = evidence.filter((item) => item.stable_team === team && item.side === side);
    const missingCostCount = atoms.filter((item) => item.cost === null).length;
    return {
      team,
      side,
      rounds_played: rounds.length,
      rounds,
      purchase_count: atoms.length,
      decoded_purchase_cost: missingCostCount > 0
        ? null
        : atoms.reduce((total, item) => total + (item.cost ?? 0), 0),
      cost_availability: missingCostCount > 0
        ? {
            state: 'partial',
            reason: `${missingCostCount} decoded purchase event${missingCostCount === 1 ? '' : 's'} has no explicit non-negative cost.`,
          }
        : { state: 'available', reason: null },
      items: itemCounts(atoms),
    };
  }));
  const selectedCell = filter.team && filter.side
    ? cells.find((cell) => cell.team === filter.team && cell.side === filter.side) ?? null
    : null;
  const filteredEvidence = selectedCell
    ? evidence.filter((item) => item.stable_team === selectedCell.team
        && item.side === selectedCell.side
        && (filter.round === null || item.round === filter.round))
    : [];
  const totalPages = Math.ceil(filteredEvidence.length / TEAM_ECONOMY_PAGE_SIZE);
  const requestedPage = Math.max(1, Math.trunc(filter.page) || 1);
  const page = totalPages === 0 ? 1 : Math.min(requestedPage, totalPages);
  const offset = (page - 1) * TEAM_ECONOMY_PAGE_SIZE;

  return {
    cells,
    selected_cell: selectedCell,
    available_rounds: selectedCell ? [...selectedCell.rounds] : [],
    page: {
      items: filteredEvidence.slice(offset, offset + TEAM_ECONOMY_PAGE_SIZE),
      total: filteredEvidence.length,
      page,
      page_size: TEAM_ECONOMY_PAGE_SIZE,
      total_pages: totalPages,
    },
    availability: evidence.length === 0
      ? {
          state: 'unavailable',
          reason: 'No canonical purchase events are available for this match.',
          failure_code: 'no_purchase_evidence',
          failure_round: null,
          rejected_purchase_count: rejectedPurchaseCount,
        }
      : rejectedPurchaseCount > 0
        ? {
            state: 'partial',
            reason: `${rejectedPurchaseCount} purchase event${rejectedPurchaseCount === 1 ? '' : 's'} could not be attributed to an exact roster side.`,
            failure_code: null,
            failure_round: null,
            rejected_purchase_count: rejectedPurchaseCount,
          }
        : {
            state: 'available',
            reason: null,
            failure_code: null,
            failure_round: null,
            rejected_purchase_count: 0,
          },
  };
}
