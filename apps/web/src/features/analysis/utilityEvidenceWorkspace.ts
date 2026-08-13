import type {
  AnalysisWorkspace,
  InsightCapabilityRecord,
  TimelineEvent,
} from '../../shared/desktop/dto';
import type { PlayerEvidenceRef } from './playerMatchEvidence';

export type UtilityType = 'smoke' | 'flash' | 'he' | 'fire' | 'decoy' | 'other';

export type UtilityEvidenceFilter = {
  playerId: string | null;
  round: number | null;
  utilityType: UtilityType | null;
};

export type UtilityMetricAvailability = {
  state: 'available' | 'partial' | 'unavailable';
  reason: string | null;
};

export type UtilityAtomicEvidence = PlayerEvidenceRef & {
  event_kind: 'grenade' | 'flash' | 'damage';
  phase:
    | 'throw_event'
    | 'activation_event'
    | 'expiration_event'
    | 'blind_event'
    | 'damage_event'
    | 'timeline_event';
  utility_type: UtilityType;
  seconds: number;
  actor_id: string | null;
  actor_name: string | null;
  target_id: string | null;
  target_name: string | null;
  weapon: string | null;
  position: [number, number, number] | null;
  damage: number | null;
  blind_duration_seconds: number | null;
};

export type UtilityEvidenceMetric = {
  value: number | null;
  event_count: number;
  availability: UtilityMetricAvailability;
};

export type UtilityEvidenceWorkspace = {
  evidence: UtilityAtomicEvidence[];
  decoded_event_count: number;
  utility_types: UtilityType[];
  availability: {
    events: UtilityMetricAvailability;
  };
  metrics: {
    damage: UtilityEvidenceMetric;
    blind_duration: UtilityEvidenceMetric;
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

function normalizedWeapon(value: string | null): string | null {
  const normalized = value?.trim().toLocaleLowerCase().replace(/^weapon_/, '') ?? '';
  return normalized || null;
}

function utilityType(event: TimelineEvent): UtilityType {
  const source = `${normalizedWeapon(event.weapon) ?? ''} ${event.id}`.toLocaleLowerCase();
  if (source.includes('smokegrenade')) return 'smoke';
  if (source.includes('flashbang') || source.includes('player_blind')) return 'flash';
  if (source.includes('hegrenade')) return 'he';
  if (source.includes('inferno') || source.includes('molotov') || source.includes('incgrenade')) return 'fire';
  if (source.includes('decoy')) return 'decoy';
  return 'other';
}

function isUtilityDamage(event: TimelineEvent): boolean {
  if (event.kind !== 'damage') return false;
  return utilityType(event) !== 'other';
}

function numericDetail(event: TimelineEvent, keys: readonly string[]): number | null {
  if (typeof event.detail !== 'object' || event.detail === null) return null;
  const detail = event.detail as Record<string, unknown>;
  for (const key of keys) {
    const value = detail[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function eventPhase(event: TimelineEvent): UtilityAtomicEvidence['phase'] {
  if (event.id.startsWith('player_blind-')) return 'blind_event';
  if (event.kind === 'damage') return 'damage_event';
  if (event.id.startsWith('grenade_thrown-')) return 'throw_event';
  if ([
    'hegrenade_detonate-',
    'flashbang_detonate-',
    'smokegrenade_detonate-',
    'decoy_started-',
    'inferno_startburn-',
  ].some((prefix) => event.id.startsWith(prefix))) return 'activation_event';
  if ([
    'smokegrenade_expired-',
    'decoy_detonate-',
    'inferno_expire-',
  ].some((prefix) => event.id.startsWith(prefix))) return 'expiration_event';
  return 'timeline_event';
}

function atomicEvidence(
  workspace: AnalysisWorkspace,
  round: number,
  event: TimelineEvent,
  aliases: Map<string, ResolvedPlayer>,
): UtilityAtomicEvidence {
  const actor = event.actor ? aliases.get(event.actor) ?? null : null;
  const target = event.target ? aliases.get(event.target) ?? null : null;
  const blind = event.id.startsWith('player_blind-');
  return {
    evidence_id: `demo:${workspace.demo_id}/event:${event.id}`,
    demo_id: workspace.demo_id,
    source_kind: 'event',
    source_id: event.id,
    round,
    tick: event.tick,
    end_tick: null,
    event_kind: blind ? 'flash' : event.kind === 'damage' ? 'damage' : 'grenade',
    phase: eventPhase(event),
    utility_type: utilityType(event),
    seconds: event.seconds,
    actor_id: actor?.id ?? event.actor,
    actor_name: actor?.name ?? event.actor,
    target_id: target?.id ?? event.target,
    target_name: target?.name ?? event.target,
    weapon: normalizedWeapon(event.weapon),
    position: event.position ? [...event.position] : null,
    damage: event.kind === 'damage' ? numericDetail(event, ['dmg_health', 'damage']) : null,
    blind_duration_seconds: blind
      ? numericDetail(event, ['blind_duration', 'blind_duration_full', 'duration'])
      : null,
  };
}

function eventAvailability(
  capability: InsightCapabilityRecord | undefined,
  eventCount: number,
): UtilityMetricAvailability {
  if (capability?.available) {
    return eventCount > 0
      ? { state: 'available', reason: null }
      : { state: 'unavailable', reason: 'No utility timeline events match these filters.' };
  }
  const reason = capability?.reason ?? 'Utility event capability metadata is not present in this analysis.';
  return { state: eventCount > 0 ? 'partial' : 'unavailable', reason };
}

function aggregateMetric(
  capability: InsightCapabilityRecord | undefined,
  values: Array<number | null>,
  capabilityMissingReason: string,
  noMatchReason: string,
  missingReason: (missing: number, total: number) => string,
): UtilityEvidenceMetric {
  if (!capability?.available) {
    return {
      value: null,
      event_count: values.length,
      availability: {
        state: values.length > 0 ? 'partial' : 'unavailable',
        reason: capability?.reason ?? capabilityMissingReason,
      },
    };
  }
  if (values.length === 0) {
    return {
      value: null,
      event_count: 0,
      availability: { state: 'unavailable', reason: noMatchReason },
    };
  }
  const missing = values.filter((value) => value === null).length;
  if (missing > 0) {
    return {
      value: null,
      event_count: values.length,
      availability: {
        state: 'partial',
        reason: missingReason(missing, values.length),
      },
    };
  }
  return {
    value: values.reduce<number>((total, value) => total + (value ?? 0), 0),
    event_count: values.length,
    availability: { state: 'available', reason: null },
  };
}

export function buildUtilityEvidenceWorkspace(
  workspace: AnalysisWorkspace,
  filter: UtilityEvidenceFilter,
): UtilityEvidenceWorkspace {
  const aliases = playerAliases(workspace);
  const evidence: UtilityAtomicEvidence[] = [];

  for (const round of workspace.rounds) {
    if (filter.round !== null && round.number !== filter.round) continue;
    for (const event of round.events) {
      if (event.kind !== 'grenade' && !isUtilityDamage(event)) continue;
      const actor = event.actor ? aliases.get(event.actor) ?? null : null;
      if (filter.playerId !== null && actor?.id !== filter.playerId) continue;
      if (filter.utilityType !== null && utilityType(event) !== filter.utilityType) continue;
      evidence.push(atomicEvidence(workspace, round.number, event, aliases));
    }
  }

  evidence.sort((left, right) => left.tick - right.tick
    || left.round - right.round
    || left.evidence_id.localeCompare(right.evidence_id));
  const capabilities = workspace.insights?.availability;
  const damageValues = evidence
    .filter((item) => item.event_kind === 'damage')
    .map((item) => item.damage);
  const blindValues = evidence
    .filter((item) => item.event_kind === 'flash')
    .map((item) => item.blind_duration_seconds);

  return {
    evidence,
    decoded_event_count: evidence.length,
    utility_types: [...new Set(evidence.map((item) => item.utility_type))].sort(),
    availability: {
      events: eventAvailability(capabilities?.utility_events, evidence.length),
    },
    metrics: {
      damage: aggregateMetric(
        capabilities?.utility_damage,
        damageValues,
        'Utility damage capability metadata is not present in this analysis.',
        'No utility damage events match these filters.',
        (missing, total) => `${missing} of ${total} matching utility damage event${total === 1 ? '' : 's'} ${missing === 1 ? 'has' : 'have'} no numeric damage amount.`,
      ),
      blind_duration: aggregateMetric(
        capabilities?.flash_effects,
        blindValues,
        'Flash-effect capability metadata is not present in this analysis.',
        'No blind events match these filters.',
        (missing, total) => `${missing} of ${total} matching blind event${total === 1 ? '' : 's'} ${missing === 1 ? 'has' : 'have'} no numeric duration.`,
      ),
    },
  };
}
