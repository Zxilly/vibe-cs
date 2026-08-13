import type {
  AnalysisWorkspace,
  CountedItemRecord,
  Highlight,
  InsightCapabilityRecord,
  PlayerAnalysis,
  PlayerMatchupInsightRecord,
  TimelineEvent,
} from '../../shared/desktop/dto';

export type PlayerEvidenceAvailability = {
  state: 'available' | 'partial' | 'unavailable';
  reason: string | null;
};

export type PlayerEvidenceRef = {
  evidence_id: string;
  demo_id: string;
  source_kind: 'event' | 'highlight' | 'projection';
  source_id: string;
  round: number;
  tick: number;
  end_tick: number | null;
};

export type PlayerCombatEvidence = PlayerEvidenceRef & {
  kind: 'kill';
  seconds: number;
  actor_id: string | null;
  actor_name: string | null;
  target_id: string | null;
  target_name: string | null;
  weapon: string | null;
  headshot: boolean;
  penetrated: boolean;
  position: [number, number, number] | null;
};

export type PlayerEvidenceSummary = Pick<
  PlayerAnalysis,
  'id' | 'name' | 'team' | 'kills' | 'deaths' | 'assists' | 'headshot_rate' | 'adr'
>;

export type PlayerWeaponEvidence = {
  id: string;
  name: string;
  kills: number;
  headshots: number;
  damage: number;
  damage_events: number;
  evidence_ids: string[];
};

export type PlayerDuelPerspective = 'kill' | 'death' | 'damage_dealt' | 'damage_taken';

export type PlayerDuelInteraction = PlayerEvidenceRef & {
  event_kind: 'kill' | 'damage';
  perspective: PlayerDuelPerspective;
  seconds: number;
  actor_id: string | null;
  actor_name: string | null;
  target_id: string | null;
  target_name: string | null;
  weapon: string | null;
  headshot: boolean;
  penetrated: boolean;
  damage: number | null;
};

export type PlayerDuelEvidence = {
  id: string;
  opponent_id: string;
  opponent_name: string;
  opponent_team: PlayerAnalysis['team'] | null;
  kills: number;
  deaths: number;
  headshot_kills: number;
  damage_dealt: number | null;
  damage_taken: number | null;
  damage_events: number;
  summary_source: 'insights' | 'events';
  engagements: PlayerDuelInteraction[];
};

export type PlayerUtilityEventEvidence = PlayerEvidenceRef & {
  event_kind: 'grenade' | 'damage';
  phase: 'throw' | 'detonation' | 'damage';
  utility_name: string;
  seconds: number;
  actor_id: string | null;
  actor_name: string | null;
  target_id: string | null;
  target_name: string | null;
  position: [number, number, number] | null;
  damage: number | null;
};

export type PlayerUtilitySummary = {
  id: string;
  throws: number;
  detonations: number;
  items: CountedItemRecord[];
  damage: number;
  damage_events: number;
  flash_events: number;
  players_flashed: number;
  flash_duration_seconds: number | null;
};

export type PlayerUtilityEvidence = {
  summary: PlayerUtilitySummary | null;
  events: PlayerUtilityEventEvidence[];
};

export type PlayerObjectiveEvidence = PlayerEvidenceRef & {
  objective: 'plant' | 'defuse' | 'explode';
  attribution: 'actor' | 'related_to_player_plant';
  seconds: number;
  actor_id: string | null;
  actor_name: string | null;
  position: [number, number, number] | null;
};

export type PlayerHighlightEvidence = PlayerEvidenceRef & {
  kind: Highlight['kind'];
  category: Highlight['category'];
  quality: 'parsed_highlight' | 'review_candidate';
  label: string;
  description: string;
  tags: string[];
  victims: string[];
  player_id: string;
  player_name: string;
  confidence: number;
};

export type PlayerMatchEvidence = {
  player: PlayerEvidenceSummary;
  kills: PlayerCombatEvidence[];
  deaths: PlayerCombatEvidence[];
  weapons: PlayerWeaponEvidence[];
  duels: PlayerDuelEvidence[];
  utility: PlayerUtilityEvidence;
  objectives: PlayerObjectiveEvidence[];
  highlights: PlayerHighlightEvidence[];
  availability: {
    kills: PlayerEvidenceAvailability;
    deaths: PlayerEvidenceAvailability;
    weapons: PlayerEvidenceAvailability;
    duels: PlayerEvidenceAvailability;
    utility_events: PlayerEvidenceAvailability;
    utility_damage: PlayerEvidenceAvailability;
    flash_effects: PlayerEvidenceAvailability;
    objectives: PlayerEvidenceAvailability;
    highlights: PlayerEvidenceAvailability;
  };
};

type ResolvedPlayer = Pick<PlayerAnalysis, 'id' | 'name' | 'team'>;

function playerAliases(players: PlayerAnalysis[]): Map<string, ResolvedPlayer> {
  const aliases = new Map<string, ResolvedPlayer>();
  const duplicateNames = new Set<string>();
  for (const player of players) {
    aliases.set(player.id, player);
    if (aliases.has(player.name)) duplicateNames.add(player.name);
    else aliases.set(player.name, player);
  }
  duplicateNames.forEach((name) => aliases.delete(name));
  return aliases;
}

function eventEvidence(
  workspace: AnalysisWorkspace,
  round: number,
  event: TimelineEvent,
  aliases: Map<string, ResolvedPlayer>,
): PlayerCombatEvidence {
  const actor = event.actor ? aliases.get(event.actor) : null;
  const target = event.target ? aliases.get(event.target) : null;
  return {
    evidence_id: `demo:${workspace.demo_id}/event:${event.id}`,
    demo_id: workspace.demo_id,
    source_kind: 'event',
    source_id: event.id,
    round,
    tick: event.tick,
    end_tick: null,
    kind: 'kill',
    seconds: event.seconds,
    actor_id: actor?.id ?? event.actor,
    actor_name: actor?.name ?? event.actor,
    target_id: target?.id ?? event.target,
    target_name: target?.name ?? event.target,
    weapon: event.weapon,
    headshot: event.headshot,
    penetrated: event.penetrated,
    position: event.position ? [...event.position] : null,
  };
}

function byTick(left: PlayerEvidenceRef, right: PlayerEvidenceRef): number {
  return left.tick - right.tick
    || left.round - right.round
    || left.evidence_id.localeCompare(right.evidence_id);
}

function evidenceRef(
  workspace: AnalysisWorkspace,
  round: number,
  event: TimelineEvent,
): PlayerEvidenceRef {
  return {
    evidence_id: `demo:${workspace.demo_id}/event:${event.id}`,
    demo_id: workspace.demo_id,
    source_kind: 'event',
    source_id: event.id,
    round,
    tick: event.tick,
    end_tick: null,
  };
}

function weaponName(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLocaleLowerCase().replace(/^weapon_/, '');
  return normalized || null;
}

function damageAmount(detail: unknown): number | null {
  if (!detail || typeof detail !== 'object') return null;
  const record = detail as Record<string, unknown>;
  const value = record.dmg_health ?? record.damage;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function duelInteraction(
  workspace: AnalysisWorkspace,
  round: number,
  event: TimelineEvent,
  perspective: PlayerDuelPerspective,
  aliases: Map<string, ResolvedPlayer>,
): PlayerDuelInteraction {
  const actor = event.actor ? aliases.get(event.actor) : null;
  const target = event.target ? aliases.get(event.target) : null;
  return {
    ...evidenceRef(workspace, round, event),
    event_kind: event.kind === 'kill' ? 'kill' : 'damage',
    perspective,
    seconds: event.seconds,
    actor_id: actor?.id ?? event.actor,
    actor_name: actor?.name ?? event.actor,
    target_id: target?.id ?? event.target,
    target_name: target?.name ?? event.target,
    weapon: weaponName(event.weapon),
    headshot: event.headshot,
    penetrated: event.penetrated,
    damage: event.kind === 'damage' ? damageAmount(event.detail) : null,
  };
}

function utilityName(event: TimelineEvent): string {
  const weapon = weaponName(event.weapon);
  if (weapon) return weapon;
  const prefixes: Array<[string, string]> = [
    ['hegrenade_', 'hegrenade'],
    ['flashbang_', 'flashbang'],
    ['smokegrenade_', 'smokegrenade'],
    ['decoy_', 'decoy'],
    ['inferno_', 'inferno'],
  ];
  return prefixes.find(([prefix]) => event.id.startsWith(prefix))?.[1] ?? 'grenade';
}

function utilityPhase(event: TimelineEvent): PlayerUtilityEventEvidence['phase'] | null {
  if (event.kind === 'damage' && isUtilityWeapon(event.weapon)) return 'damage';
  if (event.kind !== 'grenade') return null;
  if (event.id.startsWith('grenade_thrown-')) return 'throw';
  if ([
    'hegrenade_detonate-',
    'flashbang_detonate-',
    'smokegrenade_detonate-',
    'decoy_started-',
    'inferno_startburn-',
  ].some((prefix) => event.id.startsWith(prefix))) return 'detonation';
  return null;
}

function isUtilityWeapon(value: string | null): boolean {
  const weapon = weaponName(value);
  return Boolean(weapon && [
    'hegrenade',
    'flashbang',
    'smokegrenade',
    'decoy',
    'molotov',
    'incgrenade',
    'inferno',
  ].some((candidate) => weapon.includes(candidate)));
}

function utilityEventEvidence(
  workspace: AnalysisWorkspace,
  round: number,
  event: TimelineEvent,
  phase: PlayerUtilityEventEvidence['phase'],
  aliases: Map<string, ResolvedPlayer>,
): PlayerUtilityEventEvidence {
  const actor = event.actor ? aliases.get(event.actor) : null;
  const target = event.target ? aliases.get(event.target) : null;
  return {
    ...evidenceRef(workspace, round, event),
    event_kind: event.kind === 'damage' ? 'damage' : 'grenade',
    phase,
    utility_name: utilityName(event),
    seconds: event.seconds,
    actor_id: actor?.id ?? event.actor,
    actor_name: actor?.name ?? event.actor,
    target_id: target?.id ?? event.target,
    target_name: target?.name ?? event.target,
    position: event.position ? [...event.position] : null,
    damage: phase === 'damage' ? damageAmount(event.detail) : null,
  };
}

function capabilityAvailability(
  capability: InsightCapabilityRecord | undefined,
  hasEvidence: boolean,
  fallbackReason: string,
): PlayerEvidenceAvailability {
  if (capability?.available) {
    return { state: 'available', reason: null };
  }
  if (hasEvidence) {
    return {
      state: 'partial',
      reason: capability?.reason ?? fallbackReason,
    };
  }
  return {
    state: 'unavailable',
    reason: capability?.reason ?? fallbackReason,
  };
}

function objectiveEvidence(
  workspace: AnalysisWorkspace,
  round: number,
  event: TimelineEvent,
  attribution: PlayerObjectiveEvidence['attribution'],
  aliases: Map<string, ResolvedPlayer>,
): PlayerObjectiveEvidence {
  const actor = event.actor ? aliases.get(event.actor) : null;
  const objective = event.kind === 'bomb_plant'
    ? 'plant'
    : event.kind === 'bomb_defuse'
      ? 'defuse'
      : 'explode';
  return {
    ...evidenceRef(workspace, round, event),
    objective,
    attribution,
    seconds: event.seconds,
    actor_id: actor?.id ?? event.actor,
    actor_name: actor?.name ?? event.actor,
    position: event.position ? [...event.position] : null,
  };
}

function countAvailability(
  decoded: number,
  expected: number,
  label: 'kills' | 'deaths',
): PlayerEvidenceAvailability {
  if (decoded === expected) {
    return {
      state: 'available',
      reason: null,
    };
  }
  return {
    state: decoded > 0 ? 'partial' : 'unavailable',
    reason: `Decoded ${decoded} of ${expected} scoreboard ${label}.`,
  };
}

export function buildPlayerMatchEvidence(
  workspace: AnalysisWorkspace,
  playerId: string,
): PlayerMatchEvidence | null {
  const player = workspace.players.find((candidate) => candidate.id === playerId) ?? null;
  if (!player) return null;

  const aliases = playerAliases(workspace.players);
  const identities = new Set([player.id, player.name]);
  const kills: PlayerCombatEvidence[] = [];
  const deaths: PlayerCombatEvidence[] = [];
  const weapons = new Map<string, {
    kills: number;
    headshots: number;
    damage: number;
    damage_events: number;
    evidence: PlayerEvidenceRef[];
  }>();
  const duelGroups = new Map<string, {
    opponent: { id: string; name: string; team: PlayerAnalysis['team'] | null };
    insight: PlayerMatchupInsightRecord | null;
    engagements: PlayerDuelInteraction[];
  }>();
  const utilityEvents: PlayerUtilityEventEvidence[] = [];
  const objectives: PlayerObjectiveEvidence[] = [];
  let globalDamageEvents = 0;
  let selectedWeaponDamageWithoutAmount = 0;

  const ensureDuel = (opponentValue: string) => {
    const resolved = aliases.get(opponentValue);
    const opponent = resolved
      ? { id: resolved.id, name: resolved.name, team: resolved.team }
      : { id: opponentValue, name: opponentValue, team: null };
    if (opponent.id === player.id || opponent.team === player.team) return null;
    const existing = duelGroups.get(opponent.id);
    if (existing) return existing;
    const created = { opponent, insight: null, engagements: [] as PlayerDuelInteraction[] };
    duelGroups.set(opponent.id, created);
    return created;
  };

  for (const matchup of workspace.insights?.matchups ?? []) {
    if (!identities.has(matchup.player_id)) continue;
    const duel = ensureDuel(matchup.opponent_id);
    if (duel) duel.insight = matchup;
  }

  for (const round of workspace.rounds) {
    const selectedPlantTicks = round.events
      .filter((event) => event.kind === 'bomb_plant'
        && Boolean(event.actor && identities.has(event.actor)))
      .map((event) => event.tick);
    for (const event of round.events) {
      const selectedActor = Boolean(event.actor && identities.has(event.actor));
      const selectedTarget = Boolean(event.target && identities.has(event.target));
      if (event.kind === 'damage') globalDamageEvents += 1;
      if (event.kind === 'kill') {
        if (selectedActor) {
          kills.push(eventEvidence(workspace, round.number, event, aliases));
          const weapon = weaponName(event.weapon);
          if (weapon) {
            const current = weapons.get(weapon) ?? {
              kills: 0,
              headshots: 0,
              damage: 0,
              damage_events: 0,
              evidence: [],
            };
            current.kills += 1;
            current.headshots += event.headshot ? 1 : 0;
            current.evidence.push(evidenceRef(workspace, round.number, event));
            weapons.set(weapon, current);
          }
        }
        if (event.target && identities.has(event.target)) {
          deaths.push(eventEvidence(workspace, round.number, event, aliases));
        }
      }
      if (event.kind === 'damage' && selectedActor) {
        const weapon = weaponName(event.weapon);
        const damage = damageAmount(event.detail);
        if (weapon) {
          if (damage === null) selectedWeaponDamageWithoutAmount += 1;
        }
        if (weapon && damage !== null) {
          const current = weapons.get(weapon) ?? {
            kills: 0,
            headshots: 0,
            damage: 0,
            damage_events: 0,
            evidence: [],
          };
          current.damage += damage;
          current.damage_events += 1;
          current.evidence.push(evidenceRef(workspace, round.number, event));
          weapons.set(weapon, current);
        }
      }
      if (selectedActor) {
        const phase = utilityPhase(event);
        if (phase) {
          utilityEvents.push(utilityEventEvidence(
            workspace,
            round.number,
            event,
            phase,
            aliases,
          ));
        }
      }
      if (event.kind === 'bomb_plant'
        || event.kind === 'bomb_defuse'
        || event.kind === 'bomb_explode') {
        if (selectedActor) {
          objectives.push(objectiveEvidence(
            workspace,
            round.number,
            event,
            'actor',
            aliases,
          ));
        } else if (event.kind === 'bomb_explode'
          && event.actor === null
          && selectedPlantTicks.some((tick) => tick <= event.tick)) {
          objectives.push(objectiveEvidence(
            workspace,
            round.number,
            event,
            'related_to_player_plant',
            aliases,
          ));
        }
      }
      if ((event.kind === 'kill' || event.kind === 'damage')
        && event.actor
        && event.target
        && (selectedActor || selectedTarget)) {
        const opponentValue = selectedActor ? event.target : event.actor;
        const duel = ensureDuel(opponentValue);
        if (duel) {
          const perspective: PlayerDuelPerspective = event.kind === 'kill'
            ? (selectedActor ? 'kill' : 'death')
            : (selectedActor ? 'damage_dealt' : 'damage_taken');
          duel.engagements.push(duelInteraction(
            workspace,
            round.number,
            event,
            perspective,
            aliases,
          ));
        }
      }
    }
  }

  const utilitySummary = workspace.insights?.player_utility.find(
    (candidate) => identities.has(candidate.player_id),
  ) ?? null;
  const utilityCapabilities = workspace.insights?.availability;
  const killAvailability = countAvailability(kills.length, player.kills, 'kills');
  const deathAvailability = countAvailability(deaths.length, player.deaths, 'deaths');
  const weaponsAvailability: PlayerEvidenceAvailability = (() => {
    if (weapons.size === 0 && killAvailability.state === 'unavailable') {
      return {
        state: 'unavailable',
        reason: killAvailability.reason,
      };
    }
    const reasons = [
      killAvailability.state === 'available' ? null : killAvailability.reason,
      globalDamageEvents === 0 ? 'Weapon damage events are not present in this analysis.' : null,
      selectedWeaponDamageWithoutAmount > 0
        ? `${selectedWeaponDamageWithoutAmount} weapon damage events have no numeric damage amount.`
        : null,
    ].filter((reason): reason is string => Boolean(reason));
    return {
      state: reasons.length === 0 ? 'available' : 'partial',
      reason: reasons.length === 0 ? null : reasons.join(' '),
    };
  })();
  const matchupCapability = workspace.insights?.availability.matchups;
  const duelAvailability = capabilityAvailability(
    matchupCapability,
    duelGroups.size > 0,
    'Directional matchup capability is not present in this analysis.',
  );
  const highlights: PlayerHighlightEvidence[] = workspace.highlights
    .filter((highlight) => identities.has(highlight.player_id))
    .map((highlight): PlayerHighlightEvidence => ({
      evidence_id: `demo:${workspace.demo_id}/highlight:${highlight.id}`,
      demo_id: workspace.demo_id,
      source_kind: 'highlight',
      source_id: highlight.id,
      round: highlight.round,
      tick: highlight.start_tick,
      end_tick: highlight.end_tick,
      kind: highlight.kind,
      category: highlight.category,
      quality: highlight.kind === 'timeline' || highlight.kind === 'fail'
        ? 'review_candidate'
        : 'parsed_highlight',
      label: highlight.label,
      description: highlight.description,
      tags: [...highlight.tags],
      victims: [...highlight.victims],
      player_id: player.id,
      player_name: player.name,
      confidence: highlight.confidence,
    }))
    .sort(byTick);

  return {
    player: {
      id: player.id,
      name: player.name,
      team: player.team,
      kills: player.kills,
      deaths: player.deaths,
      assists: player.assists,
      headshot_rate: player.headshot_rate,
      adr: player.adr,
    },
    kills: kills.sort(byTick),
    deaths: deaths.sort(byTick),
    weapons: [...weapons.entries()]
      .map(([name, counts]) => ({
        id: `demo:${workspace.demo_id}/player:${player.id}/weapon:${encodeURIComponent(name)}`,
        name,
        kills: counts.kills,
        headshots: counts.headshots,
        damage: counts.damage,
        damage_events: counts.damage_events,
        evidence_ids: counts.evidence.sort(byTick).map((item) => item.evidence_id),
      }))
      .sort((left, right) => right.kills - left.kills
        || right.headshots - left.headshots
        || right.damage - left.damage
        || left.name.localeCompare(right.name)),
    duels: [...duelGroups.values()]
      .map(({ opponent, insight, engagements }) => {
        const ordered = engagements.sort(byTick);
        const dealt = ordered.filter((item) => item.perspective === 'damage_dealt');
        const taken = ordered.filter((item) => item.perspective === 'damage_taken');
        const completeDamage = (items: PlayerDuelInteraction[]) => items.length === 0
          || items.every((item) => item.damage !== null);
        return {
          id: `demo:${workspace.demo_id}/player:${player.id}/duel:${encodeURIComponent(opponent.id)}`,
          opponent_id: opponent.id,
          opponent_name: opponent.name,
          opponent_team: opponent.team,
          kills: insight?.kills ?? ordered.filter((item) => item.perspective === 'kill').length,
          deaths: insight?.deaths ?? ordered.filter((item) => item.perspective === 'death').length,
          headshot_kills: insight?.headshot_kills
            ?? ordered.filter((item) => item.perspective === 'kill' && item.headshot).length,
          damage_dealt: insight?.damage_dealt
            ?? (completeDamage(dealt)
              ? dealt.reduce((total, item) => total + (item.damage ?? 0), 0)
              : null),
          damage_taken: insight?.damage_taken
            ?? (completeDamage(taken)
              ? taken.reduce((total, item) => total + (item.damage ?? 0), 0)
              : null),
          damage_events: insight?.damage_events ?? dealt.length,
          summary_source: insight ? 'insights' as const : 'events' as const,
          engagements: ordered,
        };
      })
      .sort((left, right) => right.kills - left.kills
        || (right.damage_dealt ?? -1) - (left.damage_dealt ?? -1)
        || left.opponent_id.localeCompare(right.opponent_id)),
    utility: {
      summary: utilitySummary ? {
        id: `demo:${workspace.demo_id}/player:${player.id}/utility`,
        throws: utilitySummary.throws,
        detonations: utilitySummary.detonations,
        items: [...utilitySummary.items].sort((left, right) => right.count - left.count
          || left.name.localeCompare(right.name)),
        damage: utilitySummary.damage,
        damage_events: utilitySummary.damage_events,
        flash_events: utilitySummary.flash_events,
        players_flashed: utilitySummary.players_flashed,
        flash_duration_seconds: utilitySummary.flash_duration_seconds,
      } : null,
      events: utilityEvents.sort(byTick),
    },
    objectives: objectives.sort(byTick),
    highlights,
    availability: {
      kills: killAvailability,
      deaths: deathAvailability,
      weapons: weaponsAvailability,
      duels: duelAvailability,
      utility_events: capabilityAvailability(
        utilityCapabilities?.utility_events,
        utilitySummary !== null || utilityEvents.some((item) => item.phase !== 'damage'),
        'Utility event capability is not present in this analysis.',
      ),
      utility_damage: capabilityAvailability(
        utilityCapabilities?.utility_damage,
        Boolean(utilitySummary?.damage_events) || utilityEvents.some((item) => item.phase === 'damage'),
        'Utility damage capability is not present in this analysis.',
      ),
      flash_effects: capabilityAvailability(
        utilityCapabilities?.flash_effects,
        Boolean(utilitySummary?.flash_events),
        'Flash-effect capability is not present in this analysis.',
      ),
      objectives: workspace.rounds.length > 0
        ? {
          state: 'available',
          reason: null,
        }
        : {
          state: 'unavailable',
          reason: 'No parsed rounds are present in this analysis.',
        },
      highlights: {
        state: 'available',
        reason: null,
      },
    },
  };
}
