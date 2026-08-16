import type { TimelineEvent } from '../../shared/desktop/dto';
import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import type { PlayerEvidenceRef } from './playerMatchEvidence';

export type WeaponEvidenceFilter = {
  playerId: string | null;
  round: number | null;
};

export type WeaponMetricAvailability = {
  state: 'available' | 'partial' | 'unavailable';
  reason: string | null;
};

export type WeaponAtomicEvidence = PlayerEvidenceRef & {
  event_kind: 'kill' | 'damage';
  seconds: number;
  actor_id: string | null;
  actor_name: string | null;
  target_id: string | null;
  target_name: string | null;
  weapon: string;
  damage: number | null;
  headshot: boolean;
  penetrated: boolean;
};

export type WeaponEvidenceSummary = {
  id: string;
  name: string;
  kills: number;
  headshot_kills: number;
  damage: number | null;
  damage_events: number;
  damage_availability: WeaponMetricAvailability;
  evidence: WeaponAtomicEvidence[];
};

export type WeaponEvidenceWorkspace = {
  weapons: WeaponEvidenceSummary[];
  availability: {
    damage: WeaponMetricAvailability;
    hits: WeaponMetricAvailability;
  };
};

function playerAliases(workspace: AnalysisWorkspace) {
  const aliases = new Map<string, AnalysisWorkspace['players'][number]>();
  const duplicateNames = new Set<string>();
  for (const player of workspace.players) {
    aliases.set(player.id, player);
    if (aliases.has(player.name)) duplicateNames.add(player.name);
    else aliases.set(player.name, player);
  }
  duplicateNames.forEach((name) => aliases.delete(name));
  return aliases;
}

function weaponName(value: string | null): string | null {
  const normalized = value?.trim().toLocaleLowerCase().replace(/^weapon_/, '') ?? '';
  return normalized || null;
}

function numericDamage(event: TimelineEvent): number | null {
  if (typeof event.detail !== 'object' || event.detail === null) return null;
  const detail = event.detail as Record<string, unknown>;
  const value = detail.dmg_health ?? detail.damage;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function buildWeaponEvidenceWorkspace(
  workspace: AnalysisWorkspace,
  filter: WeaponEvidenceFilter,
): WeaponEvidenceWorkspace {
  const players = playerAliases(workspace);
  const summaries = new Map<string, WeaponEvidenceSummary & { damage_events_without_amount: number }>();
  let damageEvents = 0;
  let damageEventsWithoutAmount = 0;

  for (const round of workspace.rounds) {
    if (filter.round !== null && round.number !== filter.round) continue;
    for (const event of round.events) {
      if (event.kind !== 'kill' && event.kind !== 'damage') continue;
      const actor = event.actor ? players.get(event.actor) ?? null : null;
      if (filter.playerId !== null && actor?.id !== filter.playerId) continue;
      const weapon = weaponName(event.weapon);
      if (!weapon) continue;
      const target = event.target ? players.get(event.target) ?? null : null;
      const damage = event.kind === 'damage' ? numericDamage(event) : null;
      if (event.kind === 'damage') {
        damageEvents += 1;
        if (damage === null) damageEventsWithoutAmount += 1;
      }
      const evidence: WeaponAtomicEvidence = {
        evidence_id: `demo:${workspace.demo_id}/event:${event.id}`,
        demo_id: workspace.demo_id,
        source_kind: 'event',
        source_id: event.id,
        round: round.number,
        tick: event.tick,
        end_tick: null,
        event_kind: event.kind,
        seconds: event.seconds,
        actor_id: actor?.id ?? event.actor,
        actor_name: actor?.name ?? event.actor,
        target_id: target?.id ?? event.target,
        target_name: target?.name ?? event.target,
        weapon,
        damage,
        headshot: event.headshot,
        penetrated: event.penetrated,
      };
      const summary = summaries.get(weapon) ?? {
        id: `demo:${workspace.demo_id}/weapon:${encodeURIComponent(weapon)}`,
        name: weapon,
        kills: 0,
        headshot_kills: 0,
        damage: null,
        damage_events: 0,
        damage_events_without_amount: 0,
        damage_availability: {
          state: 'unavailable',
          reason: 'No weapon-attributed damage events match this weapon.',
        },
        evidence: [],
      };
      if (event.kind === 'kill') {
        summary.kills += 1;
        summary.headshot_kills += event.headshot ? 1 : 0;
      } else {
        summary.damage_events += 1;
        if (damage === null) summary.damage_events_without_amount += 1;
        else summary.damage = (summary.damage ?? 0) + damage;
      }
      summary.evidence.push(evidence);
      summaries.set(weapon, summary);
    }
  }

  const weapons = [...summaries.values()]
    .map((summary): WeaponEvidenceSummary => {
      const { damage_events_without_amount: missing, ...publicSummary } = summary;
      return {
        ...publicSummary,
        damage_availability: summary.damage_events === 0
          ? {
              state: 'unavailable',
              reason: 'No weapon-attributed damage events match this weapon.',
            }
          : missing > 0
            ? {
                state: 'partial',
                reason: `${missing} damage event${missing === 1 ? '' : 's'} ${missing === 1 ? 'has' : 'have'} no numeric amount; this weapon total includes verified amounts only.`,
              }
            : { state: 'available', reason: null },
        evidence: summary.evidence.sort((left, right) => left.tick - right.tick
          || left.evidence_id.localeCompare(right.evidence_id)),
      };
    })
    .sort((left, right) => right.kills - left.kills
      || (right.damage ?? -1) - (left.damage ?? -1)
      || left.name.localeCompare(right.name));

  return {
    weapons,
    availability: {
      damage: damageEvents === 0
        ? {
            state: 'unavailable',
            reason: 'No weapon-attributed damage events match these filters.',
          }
        : damageEventsWithoutAmount > 0
          ? {
              state: 'partial',
              reason: `${damageEventsWithoutAmount} matching damage event${damageEventsWithoutAmount === 1 ? '' : 's'} ${damageEventsWithoutAmount === 1 ? 'has' : 'have'} no numeric damage amount; totals include verified amounts only.`,
            }
          : { state: 'available', reason: null },
      hits: {
        state: 'unavailable',
        reason: 'Damage events do not prove individual bullet or pellet hits.',
      },
    },
  };
}
