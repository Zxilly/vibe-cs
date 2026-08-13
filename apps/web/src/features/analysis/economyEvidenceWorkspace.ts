import type {
  AnalysisWorkspace,
  CountedItemRecord,
  TimelineEvent,
} from '../../shared/desktop/dto';
import type { PlayerEvidenceRef } from './playerMatchEvidence';

export type EconomySide = 'T' | 'CT';

export type EconomyEvidenceFilter = {
  playerId: string | null;
  round: number | null;
};

export type EconomyMetricAvailability = {
  state: 'available' | 'partial' | 'unavailable';
  reason: string | null;
};

export type EconomyAtomicEvidence = PlayerEvidenceRef & {
  event_kind: 'purchase';
  seconds: number;
  actor_id: string | null;
  actor_name: string | null;
  side: EconomySide | null;
  item: string | null;
  cost: number | null;
};

export type EconomySideAggregate = {
  side: EconomySide;
  purchase_count: number;
  items: CountedItemRecord[];
  spend: number | null;
  summary_source: 'insights' | 'events';
  aggregate_scope: 'round-side';
  atomic_count: number;
  matching_atomic_count: number;
  purchase_availability: EconomyMetricAvailability;
  spend_availability: EconomyMetricAvailability;
};

export type EconomyRoundRow = {
  id: string;
  round: number;
  sides: Record<EconomySide, EconomySideAggregate>;
  unattributed_purchase_count: number;
  unattributed_atomic_count: number;
  matching_atomic_count: number;
  evidence_ids: string[];
};

export type EconomyEvidenceWorkspace = {
  rows: EconomyRoundRow[];
  evidence: EconomyAtomicEvidence[];
  availability: {
    purchases: EconomyMetricAvailability;
    spend: EconomyMetricAvailability;
    equipment_value: EconomyMetricAvailability;
    economy_type: EconomyMetricAvailability;
    advantage: EconomyMetricAvailability;
    money_snapshot: EconomyMetricAvailability;
  };
};

type ResolvedPlayer = AnalysisWorkspace['players'][number];

function playerAliases(workspace: AnalysisWorkspace): Map<string, ResolvedPlayer> {
  const aliases = new Map<string, ResolvedPlayer>();
  const duplicateNames = new Set<string>();
  for (const player of workspace.players) {
    aliases.set(player.id, player);
    if (aliases.has(player.name)) duplicateNames.add(player.name);
    else aliases.set(player.name, player);
  }
  duplicateNames.forEach((name) => aliases.delete(name));
  return aliases;
}

function detail(event: TimelineEvent): Record<string, unknown> {
  return typeof event.detail === 'object' && event.detail !== null
    ? event.detail as Record<string, unknown>
    : {};
}

function sideValue(value: unknown): EconomySide | null {
  const normalized = String(value ?? '').trim().toLocaleUpperCase().replaceAll('_', '-');
  if (normalized === 'T' || normalized === 'TERRORIST' || normalized === '2') return 'T';
  if (normalized === 'CT' || normalized === 'COUNTER-TERRORIST' || normalized === '3') return 'CT';
  return null;
}

function purchaseSide(event: TimelineEvent): EconomySide | null {
  const eventDetail = detail(event);
  for (const key of ['team', 'team_num', 'userteam', 'user_team_num']) {
    const side = sideValue(eventDetail[key]);
    if (side) return side;
  }
  return null;
}

function normalizedItem(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLocaleLowerCase().replace(/^weapon_/u, '');
  return normalized || null;
}

function purchaseItem(event: TimelineEvent): string | null {
  return normalizedItem(event.weapon) ?? normalizedItem(detail(event).item_name);
}

function purchaseCost(event: TimelineEvent): number | null {
  const eventDetail = detail(event);
  for (const key of ['cost', 'price', 'item_cost', 'purchase_cost']) {
    const value = eventDetail[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function atomicEvidence(
  workspace: AnalysisWorkspace,
  round: number,
  event: TimelineEvent,
  aliases: Map<string, ResolvedPlayer>,
): EconomyAtomicEvidence {
  const actor = event.actor ? aliases.get(event.actor) ?? null : null;
  return {
    evidence_id: `demo:${workspace.demo_id}/event:${event.id}`,
    demo_id: workspace.demo_id,
    source_kind: 'event',
    source_id: event.id,
    round,
    tick: event.tick,
    end_tick: null,
    event_kind: 'purchase',
    seconds: event.seconds,
    actor_id: actor?.id ?? event.actor,
    actor_name: actor?.name ?? event.actor,
    side: purchaseSide(event),
    item: purchaseItem(event),
    cost: purchaseCost(event),
  };
}

function itemCounts(evidence: readonly EconomyAtomicEvidence[]): CountedItemRecord[] {
  const counts = new Map<string, number>();
  for (const item of evidence) {
    if (item.item) counts.set(item.item, (counts.get(item.item) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function sideAggregate(
  workspace: AnalysisWorkspace,
  round: number,
  side: EconomySide,
  allRoundEvidence: readonly EconomyAtomicEvidence[],
  matchingEvidence: readonly EconomyAtomicEvidence[],
): EconomySideAggregate {
  const insight = workspace.insights?.round_economy.find((candidate) => candidate.round === round);
  const record = insight?.teams.find(
    (candidate) => sideValue(candidate.team) === side,
  );
  const sideEvidence = allRoundEvidence.filter((item) => item.side === side);
  const unattributedCount = Math.max(
    insight?.unattributed_purchase_count ?? 0,
    allRoundEvidence.filter((item) => item.side === null).length,
  );
  const purchaseReasons = [
    unattributedCount > 0
      ? `${unattributedCount} purchase event${unattributedCount === 1 ? ' is' : 's are'} unattributed to T or CT.`
      : null,
    record && record.purchase_count !== sideEvidence.length
      ? `Decoded ${sideEvidence.length} of ${record.purchase_count} ${side} purchase events for round ${round}.`
      : null,
    workspace.insights?.availability.purchase_events.available === false
      ? workspace.insights.availability.purchase_events.reason
        ?? 'Purchase event capability is incomplete for this analysis.'
      : null,
  ].filter((reason): reason is string => Boolean(reason));
  const spend = record?.spend ?? (sideEvidence.length > 0
    && sideEvidence.every((item) => item.cost !== null)
    ? sideEvidence.reduce((total, item) => total + (item.cost ?? 0), 0)
    : null);
  return {
    side,
    purchase_count: record?.purchase_count ?? sideEvidence.length,
    items: record ? [...record.items] : itemCounts(sideEvidence),
    spend,
    summary_source: record ? 'insights' : 'events',
    aggregate_scope: 'round-side',
    atomic_count: sideEvidence.length,
    matching_atomic_count: matchingEvidence.filter((item) => item.side === side).length,
    purchase_availability: purchaseReasons.length > 0
      ? { state: 'partial', reason: purchaseReasons.join(' ') }
      : { state: 'available', reason: null },
    spend_availability: (() => {
      const capability = workspace.insights?.availability.purchase_spend;
      if (spend === null) {
        return {
          state: 'unavailable' as const,
          reason: capability?.reason
            ?? 'Explicit purchase spend is not available for this round side.',
        };
      }
      if (capability?.available === false) {
        return {
          state: 'partial' as const,
          reason: capability.reason ?? 'Purchase spend capability is incomplete for this analysis.',
        };
      }
      return { state: 'available' as const, reason: null };
    })(),
  };
}

export function buildEconomyEvidenceWorkspace(
  workspace: AnalysisWorkspace,
  filter: EconomyEvidenceFilter,
): EconomyEvidenceWorkspace {
  const aliases = playerAliases(workspace);
  const allEvidence = workspace.rounds.flatMap((round) => round.events
    .filter((event) => event.kind === 'purchase')
    .map((event) => atomicEvidence(workspace, round.number, event, aliases)));
  const evidence = allEvidence
    .filter((item) => filter.round === null || item.round === filter.round)
    .filter((item) => filter.playerId === null || item.actor_id === filter.playerId)
    .sort((left, right) => left.tick - right.tick
      || left.round - right.round
      || left.evidence_id.localeCompare(right.evidence_id));
  const rounds = workspace.rounds
    .filter((round) => filter.round === null || round.number === filter.round)
    .filter((round) => filter.playerId === null
      ? allEvidence.some((item) => item.round === round.number)
        || workspace.insights?.round_economy.some((item) => item.round === round.number)
      : evidence.some((item) => item.round === round.number));
  const rows = rounds.map((round): EconomyRoundRow => {
    const allRoundEvidence = allEvidence.filter((item) => item.round === round.number);
    const matchingEvidence = evidence.filter((item) => item.round === round.number);
    const insight = workspace.insights?.round_economy.find(
      (candidate) => candidate.round === round.number,
    );
    return {
      id: `demo:${workspace.demo_id}/projection:economy-round:${round.number}`,
      round: round.number,
      sides: {
        T: sideAggregate(workspace, round.number, 'T', allRoundEvidence, matchingEvidence),
        CT: sideAggregate(workspace, round.number, 'CT', allRoundEvidence, matchingEvidence),
      },
      unattributed_purchase_count: insight?.unattributed_purchase_count
        ?? allRoundEvidence.filter((item) => item.side === null).length,
      unattributed_atomic_count: allRoundEvidence.filter((item) => item.side === null).length,
      matching_atomic_count: matchingEvidence.length,
      evidence_ids: matchingEvidence.map((item) => item.evidence_id),
    };
  });
  const purchaseCapability = workspace.insights?.availability.purchase_events;
  const spendCapability = workspace.insights?.availability.purchase_spend;
  return {
    rows,
    evidence,
    availability: {
      purchases: purchaseCapability?.available
        ? (evidence.length > 0
          ? { state: 'available', reason: null }
          : { state: 'unavailable', reason: 'No purchase events match these filters.' })
        : {
            state: evidence.length > 0 ? 'partial' : 'unavailable',
            reason: purchaseCapability?.reason
              ?? 'Purchase event capability metadata is not present in this analysis.',
          },
      spend: spendCapability?.available
        ? { state: 'available', reason: null }
        : {
            state: rows.some((row) => row.sides.T.spend !== null || row.sides.CT.spend !== null)
              ? 'partial'
              : 'unavailable',
            reason: spendCapability?.reason
              ?? 'Purchase spend capability metadata is not present in this analysis.',
          },
      equipment_value: {
        state: 'unavailable',
        reason: 'Equipment value snapshots are not present in this analysis schema.',
      },
      economy_type: {
        state: 'unavailable',
        reason: 'Economy classifications cannot be derived from purchase events alone.',
      },
      advantage: {
        state: 'unavailable',
        reason: 'Economy advantage cannot be derived without complete team value or money snapshots.',
      },
      money_snapshot: {
        state: 'unavailable',
        reason: 'Player money snapshots are not present in this analysis schema.',
      },
    },
  };
}
