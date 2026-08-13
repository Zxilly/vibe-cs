import type { AnalysisWorkspace, TimelineEvent } from '../../shared/desktop/dto';

export type RoundContextSectionKind =
  | 'encounters'
  | 'objective'
  | 'utility'
  | 'economy'
  | 'other';

export type RoundEncounterSummary = Readonly<{
  participant_ids: readonly string[];
  weapon_names: readonly string[];
  kill_count: number;
  dominant_actor_id: string | null;
}>;

export type RoundContextGroup = Readonly<{
  id: string;
  kind: RoundContextSectionKind;
  start_tick: number;
  end_tick: number;
  atomic_event_ids: readonly string[];
  events: readonly TimelineEvent[];
  side: 'T' | 'CT' | null;
  encounter: RoundEncounterSummary | null;
}>;

export type RoundContextSection = Readonly<{
  id: string;
  kind: RoundContextSectionKind;
  start_tick: number | null;
  end_tick: number | null;
  atomic_event_ids: readonly string[];
  groups: readonly RoundContextGroup[];
}>;

export type RoundEvidenceReason =
  | 'purchase-events-unavailable'
  | 'purchase-side-unattributed'
  | 'purchase-evidence-incomplete'
  | 'purchase-spend-unavailable'
  | 'life-state-snapshot-unavailable'
  | 'equipment-snapshot-unavailable'
  | 'participant-side-unavailable'
  | 'participant-side-conflicting';

export type RoundEvidenceAvailability<T> =
  | Readonly<{ state: 'available'; value: T }>
  | Readonly<{ state: 'partial'; value: T; reason: RoundEvidenceReason }>
  | Readonly<{ state: 'unavailable'; reason: RoundEvidenceReason }>;

export type RoundPurchaseEvidence = Readonly<{
  count: number;
  items: readonly Readonly<{ name: string; count: number }>[];
  atomic_event_ids: readonly string[];
}>;

export type RoundSideLifeEvidence = Readonly<{
  known_dead_player_ids: readonly string[];
  observed_player_ids: readonly string[];
}>;

export type RoundParticipant = Readonly<{
  player_id: string;
  name: string;
  atomic_event_ids: readonly string[];
  side: RoundEvidenceAvailability<'T' | 'CT'>;
  alive: RoundEvidenceAvailability<boolean>;
  equipment: RoundEvidenceAvailability<Readonly<{ items: readonly string[] }>>;
}>;

export type RoundSideInspector = Readonly<{
  side: 'T' | 'CT';
  purchases: RoundEvidenceAvailability<RoundPurchaseEvidence>;
  spend: RoundEvidenceAvailability<number>;
  alive: RoundEvidenceAvailability<RoundSideLifeEvidence>;
  equipment: RoundEvidenceAvailability<Readonly<{ total_value: number }>>;
}>;

export type RoundInspector = Readonly<{
  at_tick: number;
  sides: readonly RoundSideInspector[];
  participants: readonly RoundParticipant[];
}>;

export type RoundContextFocusRequest = Readonly<{
  event_id?: string | null;
  player_id?: string | null;
  tick?: number | null;
}>;

export type RoundContextFocusEvidence = Readonly<{
  requested_event_id: string | null;
  requested_player_id: string | null;
  requested_tick: number | null;
  resolved_tick: number;
  matched_group_ids: readonly string[];
  atomic_event_ids: readonly string[];
  participant_ids: readonly string[];
}>;

export type RoundContext = Readonly<{
  round_number: number;
  start_tick: number;
  end_tick: number;
  sections: readonly RoundContextSection[];
  inspector: RoundInspector;
  focus: RoundContextFocusEvidence | null;
}>;

const sectionKinds: readonly RoundContextSectionKind[] = [
  'encounters',
  'objective',
  'utility',
  'economy',
  'other',
];

function eventSequence(event: TimelineEvent): number {
  const suffix = event.id.match(/-(\d+)$/)?.[1];
  return suffix ? Number(suffix) : Number.MAX_SAFE_INTEGER;
}

function compareEvents(left: TimelineEvent, right: TimelineEvent): number {
  return left.tick - right.tick
    || eventSequence(left) - eventSequence(right)
    || left.id.localeCompare(right.id);
}

function sectionFor(event: TimelineEvent): RoundContextSectionKind {
  if (event.kind === 'kill' || event.kind === 'damage') return 'encounters';
  if (event.kind.startsWith('bomb_')) return 'objective';
  if (event.kind === 'grenade') return 'utility';
  if (event.kind === 'purchase') return 'economy';
  return 'other';
}

function eventParticipants(event: TimelineEvent): string[] {
  return [event.actor, event.target].filter((id): id is string => Boolean(id));
}

function eventDetail(event: TimelineEvent): Record<string, unknown> {
  return typeof event.detail === 'object' && event.detail !== null
    ? event.detail as Record<string, unknown>
    : {};
}

function sideValue(value: unknown): 'T' | 'CT' | null {
  const normalized = String(value ?? '').trim().toLocaleUpperCase().replaceAll('_', '-');
  if (normalized === 'T' || normalized === 'TERRORIST' || normalized === '2') return 'T';
  if (normalized === 'CT' || normalized === 'COUNTER-TERRORIST' || normalized === '3') return 'CT';
  return null;
}

function actorSide(event: TimelineEvent): 'T' | 'CT' | null {
  const detail = eventDetail(event);
  const keys = event.kind === 'kill' || event.kind === 'damage' || event.id.startsWith('player_blind-')
    ? ['attackerteam', 'attacker_team', 'attacker_team_num']
    : ['team', 'team_num', 'userteam', 'user_team_num'];
  for (const key of keys) {
    const side = sideValue(detail[key]);
    if (side) return side;
  }
  return null;
}

function targetSide(event: TimelineEvent): 'T' | 'CT' | null {
  const detail = eventDetail(event);
  for (const key of ['userteam', 'victimteam', 'user_team_num', 'victim_team_num']) {
    const side = sideValue(detail[key]);
    if (side) return side;
  }
  return null;
}

function sharesParticipant(left: readonly TimelineEvent[], right: TimelineEvent): boolean {
  const previous = new Set(left.flatMap(eventParticipants));
  return eventParticipants(right).some((id) => previous.has(id));
}

function stableGroupId(
  roundNumber: number,
  kind: RoundContextSectionKind,
  events: readonly TimelineEvent[],
): string {
  let hash = 2_166_136_261;
  for (const character of events.map((event) => event.id).join('\u001f')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return `round:${roundNumber}:${kind}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function encounterSummary(events: readonly TimelineEvent[]): RoundEncounterSummary {
  const kills = events.filter((event) => event.kind === 'kill');
  const killCounts = new Map<string, number>();
  kills.forEach((event) => {
    if (event.actor) killCounts.set(event.actor, (killCounts.get(event.actor) ?? 0) + 1);
  });
  const rankedActors = [...killCounts].sort((left, right) =>
    right[1] - left[1] || left[0].localeCompare(right[0]));
  const dominant = rankedActors[0];
  const tied = dominant && rankedActors[1]?.[1] === dominant[1];
  return {
    participant_ids: [...new Set(events.flatMap(eventParticipants))].sort(),
    weapon_names: [...new Set(events.flatMap((event) => event.weapon ? [event.weapon] : []))].sort(),
    kill_count: kills.length,
    dominant_actor_id: dominant && !tied ? dominant[0] : null,
  };
}

function toGroup(
  roundNumber: number,
  kind: RoundContextSectionKind,
  events: readonly TimelineEvent[],
  side: 'T' | 'CT' | null = null,
): RoundContextGroup {
  const first = events[0]!;
  const last = events.at(-1)!;
  return {
    id: stableGroupId(roundNumber, kind, events),
    kind,
    start_tick: first.tick,
    end_tick: last.tick,
    atomic_event_ids: events.map((event) => event.id),
    events,
    side,
    encounter: kind === 'encounters' ? encounterSummary(events) : null,
  };
}

function encounterGroups(
  roundNumber: number,
  events: readonly TimelineEvent[],
  tickRate: number,
): RoundContextGroup[] {
  const maximumGap = Math.max(1, Math.round(tickRate * 3));
  const groups: TimelineEvent[][] = [];
  for (const event of events) {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    if (current && previous && event.tick - previous.tick <= maximumGap && sharesParticipant(current, event)) {
      current.push(event);
    } else {
      groups.push([event]);
    }
  }
  return groups.map((group) => toGroup(roundNumber, 'encounters', group));
}

function economyGroups(
  roundNumber: number,
  events: readonly TimelineEvent[],
): RoundContextGroup[] {
  const bySide = new Map<'T' | 'CT' | null, TimelineEvent[]>();
  events.forEach((event) => {
    const side = actorSide(event);
    const group = bySide.get(side) ?? [];
    group.push(event);
    bySide.set(side, group);
  });
  return [...bySide.entries()]
    .map(([side, group]) => toGroup(roundNumber, 'economy', group, side))
    .sort((left, right) => left.start_tick - right.start_tick || (left.side ?? '').localeCompare(right.side ?? ''));
}

function purchaseItem(event: TimelineEvent): string | null {
  const weapon = event.weapon?.trim();
  if (weapon) return weapon;
  const item = eventDetail(event).item_name;
  return typeof item === 'string' && item.trim() ? item.trim() : null;
}

function purchaseEvidence(
  workspace: AnalysisWorkspace,
  roundNumber: number,
  allEvents: readonly TimelineEvent[],
  side: 'T' | 'CT',
): RoundEvidenceAvailability<RoundPurchaseEvidence> {
  const purchaseEvents = allEvents.filter((event) => event.kind === 'purchase');
  const sideEvents = purchaseEvents.filter((event) => actorSide(event) === side);
  const itemCounts = new Map<string, number>();
  sideEvents.forEach((event) => {
    const item = purchaseItem(event);
    if (item) itemCounts.set(item, (itemCounts.get(item) ?? 0) + 1);
  });
  const value: RoundPurchaseEvidence = {
    count: sideEvents.length,
    items: [...itemCounts]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    atomic_event_ids: sideEvents.map((event) => event.id),
  };
  const economy = workspace.insights?.round_economy.find((record) => record.round === roundNumber);
  const sideRecord = economy?.teams.find((team) => team.team.trim().toLocaleUpperCase() === side);
  const capability = workspace.insights?.availability.purchase_events;
  const hasUnattributedEvents = purchaseEvents.some((event) => actorSide(event) === null)
    || (economy?.unattributed_purchase_count ?? 0) > 0;
  if (hasUnattributedEvents) {
    return { state: 'partial', value, reason: 'purchase-side-unattributed' };
  }
  if (sideRecord && sideRecord.purchase_count !== sideEvents.length) {
    return { state: 'partial', value, reason: 'purchase-evidence-incomplete' };
  }
  if (capability?.available || sideEvents.length > 0 || sideRecord) {
    return { state: 'available', value };
  }
  return { state: 'unavailable', reason: 'purchase-events-unavailable' };
}

function spendEvidence(
  workspace: AnalysisWorkspace,
  roundNumber: number,
  side: 'T' | 'CT',
): RoundEvidenceAvailability<number> {
  const economy = workspace.insights?.round_economy.find((record) => record.round === roundNumber);
  const sideRecord = economy?.teams.find((team) => team.team.trim().toLocaleUpperCase() === side);
  const spend = sideRecord?.spend;
  if (typeof spend !== 'number' || !Number.isFinite(spend)) {
    return { state: 'unavailable', reason: 'purchase-spend-unavailable' };
  }
  if (workspace.insights?.availability.purchase_spend.available === false) {
    return { state: 'partial', value: spend, reason: 'purchase-evidence-incomplete' };
  }
  return { state: 'available', value: spend };
}

function roundInspector(
  workspace: AnalysisWorkspace,
  roundNumber: number,
  atTick: number,
  events: readonly TimelineEvent[],
): RoundInspector {
  const playersById = new Map(workspace.players.map((player) => [player.id, player]));
  const participantEvidence = new Map<string, { events: TimelineEvent[]; sides: Set<'T' | 'CT'> }>();
  const observe = (playerId: string | null, event: TimelineEvent, side: 'T' | 'CT' | null) => {
    if (!playerId) return;
    const evidence = participantEvidence.get(playerId) ?? { events: [], sides: new Set<'T' | 'CT'>() };
    evidence.events.push(event);
    if (side) evidence.sides.add(side);
    participantEvidence.set(playerId, evidence);
  };
  events.forEach((event) => {
    observe(event.actor, event, actorSide(event));
    observe(event.target, event, targetSide(event));
  });
  const playerOrder = new Map(workspace.players.map((player, index) => [player.id, index]));
  const participants = [...participantEvidence]
    .sort((left, right) =>
      (playerOrder.get(left[0]) ?? Number.MAX_SAFE_INTEGER)
      - (playerOrder.get(right[0]) ?? Number.MAX_SAFE_INTEGER)
      || left[0].localeCompare(right[0]))
    .map(([playerId, evidence]): RoundParticipant => {
      const sides = [...evidence.sides];
      const side: RoundEvidenceAvailability<'T' | 'CT'> = sides.length === 1
        ? { state: 'available', value: sides[0]! }
        : {
            state: 'unavailable',
            reason: sides.length > 1 ? 'participant-side-conflicting' : 'participant-side-unavailable',
          };
      const verifiedDead = events.some((event) =>
        event.kind === 'kill' && event.tick <= atTick && event.target === playerId);
      return {
        player_id: playerId,
        name: playersById.get(playerId)?.name ?? playerId,
        atomic_event_ids: evidence.events.map((event) => event.id),
        side,
        alive: verifiedDead
          ? { state: 'available', value: false }
          : { state: 'unavailable', reason: 'life-state-snapshot-unavailable' },
        equipment: { state: 'unavailable', reason: 'equipment-snapshot-unavailable' },
      };
    });
  const sideLifeEvidence = (side: 'T' | 'CT'): RoundEvidenceAvailability<RoundSideLifeEvidence> => {
    const observed = participants
      .filter((participant) => participant.side.state === 'available' && participant.side.value === side)
      .map((participant) => participant.player_id);
    const observedSet = new Set(observed);
    const knownDead = events
      .filter((event) => event.kind === 'kill' && event.tick <= atTick && Boolean(event.target))
      .map((event) => event.target!)
      .filter((playerId, index, all) => observedSet.has(playerId) && all.indexOf(playerId) === index);
    if (knownDead.length === 0) {
      return { state: 'unavailable', reason: 'life-state-snapshot-unavailable' };
    }
    return {
      state: 'partial',
      value: { known_dead_player_ids: knownDead, observed_player_ids: observed },
      reason: 'life-state-snapshot-unavailable',
    };
  };
  return {
    at_tick: atTick,
    sides: (['T', 'CT'] as const).map((side): RoundSideInspector => ({
      side,
      purchases: purchaseEvidence(workspace, roundNumber, events, side),
      spend: spendEvidence(workspace, roundNumber, side),
      alive: sideLifeEvidence(side),
      equipment: { state: 'unavailable', reason: 'equipment-snapshot-unavailable' },
    })),
    participants,
  };
}

function focusEvidence(
  focus: RoundContextFocusRequest,
  resolvedTick: number,
  sections: readonly RoundContextSection[],
): RoundContextFocusEvidence | null {
  const requestedEventId = focus.event_id?.trim() || null;
  const requestedPlayerId = focus.player_id?.trim() || null;
  const requestedTick = typeof focus.tick === 'number' && Number.isFinite(focus.tick)
    ? Math.round(focus.tick)
    : null;
  if (requestedEventId === null && requestedPlayerId === null && requestedTick === null) return null;
  const groups = sections.flatMap((section) => section.groups).filter((group) => {
    if (requestedEventId && !group.atomic_event_ids.includes(requestedEventId)) return false;
    if (requestedPlayerId && !group.events.some((event) =>
      event.actor === requestedPlayerId || event.target === requestedPlayerId)) return false;
    if (requestedTick !== null && (requestedTick < group.start_tick || requestedTick > group.end_tick)) return false;
    return true;
  });
  const events = groups.flatMap((group) => group.events);
  return {
    requested_event_id: requestedEventId,
    requested_player_id: requestedPlayerId,
    requested_tick: requestedTick,
    resolved_tick: resolvedTick,
    matched_group_ids: groups.map((group) => group.id),
    atomic_event_ids: [...new Set(events.map((event) => event.id))],
    participant_ids: [...new Set(events.flatMap(eventParticipants))].sort(),
  };
}

export function buildRoundContext(
  workspace: AnalysisWorkspace,
  roundNumber: number,
  focus: RoundContextFocusRequest = {},
): RoundContext | null {
  const round = workspace.rounds.find((candidate) => candidate.number === roundNumber);
  if (!round) return null;
  const events = [...round.events].sort(compareEvents);
  const focusedEvent = focus.event_id
    ? events.find((event) => event.id === focus.event_id)
    : undefined;
  const requestedTick = typeof focus.tick === 'number' && Number.isFinite(focus.tick)
    ? Math.round(focus.tick)
    : null;
  const atTick = focusedEvent?.tick
    ?? (requestedTick === null
      ? round.end_tick
      : Math.min(round.end_tick, Math.max(round.start_tick, requestedTick)));
  const sections = sectionKinds.map((kind): RoundContextSection => {
    const sectionEvents = events.filter((event) => sectionFor(event) === kind);
    const groups = kind === 'encounters'
      ? encounterGroups(round.number, sectionEvents, workspace.tick_rate)
      : kind === 'economy'
        ? economyGroups(round.number, sectionEvents)
        : sectionEvents.map((event) => toGroup(round.number, kind, [event]));
    return {
      id: `round:${round.number}:section:${kind}`,
      kind,
      start_tick: sectionEvents[0]?.tick ?? null,
      end_tick: sectionEvents.at(-1)?.tick ?? null,
      atomic_event_ids: sectionEvents.map((event) => event.id),
      groups,
    };
  });
  return {
    round_number: round.number,
    start_tick: round.start_tick,
    end_tick: round.end_tick,
    sections,
    inspector: roundInspector(workspace, round.number, atTick, events),
    focus: focusEvidence(focus, atTick, sections),
  };
}
