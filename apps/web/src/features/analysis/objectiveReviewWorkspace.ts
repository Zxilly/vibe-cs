import type {
  AnalysisWorkspace,
  TimelineEvent,
} from '../../shared/desktop/dto';
import {
  deriveStableMatchTeamContext,
  normalizedCompetitiveSide,
  type CompetitiveSide,
  type StableMatchTeam,
} from './stableMatchTeamContext';

export type ObjectiveTerminalKind = 'defuse' | 'explode';

export type ObjectivePlantEvidence = {
  evidence_id: string;
  demo_id: string;
  source_kind: 'event';
  source_id: string;
  round: number;
  tick: number;
  end_tick: null;
  seconds: number;
  actor_id: string;
  actor_name: string;
  actor_team: StableMatchTeam;
  actor_side: CompetitiveSide;
  raw_site_code: string | null;
};

export type ObjectiveTerminalEvidence = {
  kind: ObjectiveTerminalKind;
  evidence_id: string;
  source_id: string;
  tick: number;
  actor_id: string | null;
};

export type ObjectiveRoundEndEvidence = {
  evidence_id: string;
  source_id: string;
  tick: number;
};

export type ObjectiveReviewAtomKind =
  | 'plant'
  | 'kill'
  | 'damage'
  | 'defuse'
  | 'explode'
  | 'round_end';

export type ObjectiveReviewAtom = {
  evidence_id: string;
  demo_id: string;
  source_id: string;
  source_kind: 'event';
  round: number;
  tick: number;
  end_tick: null;
  seconds: number;
  kind: ObjectiveReviewAtomKind;
  actor_id: string | null;
  actor_name: string | null;
  actor_team: StableMatchTeam | null;
  actor_side: CompetitiveSide | null;
  target_id: string | null;
  target_name: string | null;
  target_team: StableMatchTeam | null;
  target_side: CompetitiveSide | null;
  weapon: string | null;
  headshot: boolean;
  penetrated: boolean;
  damage_health: number | null;
};

export type ObjectiveReviewTimelineGroup = {
  key: string;
  tick: number;
  atomic_event_ids: string[];
  atoms: ObjectiveReviewAtom[];
  damage_event_count: number;
  damage_total: number | null;
};

export type ObjectiveReviewRound = {
  round: number;
  state: 'available' | 'unavailable';
  reason: string | null;
  reason_code: string | null;
  winner: StableMatchTeam | null;
  plant: ObjectivePlantEvidence | null;
  terminal: ObjectiveTerminalEvidence | null;
  round_end_evidence_id: string | null;
  round_end?: ObjectiveRoundEndEvidence;
  timeline_groups: ObjectiveReviewTimelineGroup[];
};

export type ObjectiveReviewWorkspace = {
  teams: Array<{
    id: StableMatchTeam;
    player_ids: string[];
    player_names: string[];
  }>;
  rounds: ObjectiveReviewRound[];
  summary: {
    total_rounds: number;
    plant_rounds: number;
    verified_plant_rounds: number;
    unavailable_plant_rounds: number;
    planting_team_wins: number;
    planting_team_losses: number;
    defuses: number;
    explosions: number;
    no_terminal_events: number;
    post_plant_kills: number;
    post_plant_damage: number;
  };
  availability: {
    state: 'available' | 'partial' | 'unavailable';
    reason: string | null;
    failure_code: string | null;
    failure_round: number | null;
  };
};

function inBounds(
  event: TimelineEvent,
  round: AnalysisWorkspace['rounds'][number],
): boolean {
  return Number.isSafeInteger(event.tick)
    && Number.isSafeInteger(round.start_tick)
    && Number.isSafeInteger(round.end_tick)
    && round.start_tick <= round.end_tick
    && event.tick >= round.start_tick
    && event.tick <= round.end_tick;
}

function rawSiteCode(event: TimelineEvent): string | null {
  if (typeof event.detail !== 'object' || event.detail === null) return null;
  const site = (event.detail as Record<string, unknown>).site;
  if (typeof site === 'number' && Number.isSafeInteger(site) && site >= 0) return String(site);
  if (typeof site === 'string'
    && /^(?:0|[1-9]\d{0,15})$/.test(site)
    && Number.isSafeInteger(Number(site))) return site;
  return null;
}

function eventDetail(event: TimelineEvent): Record<string, unknown> {
  return typeof event.detail === 'object' && event.detail !== null
    ? event.detail as Record<string, unknown>
    : {};
}

type ExplicitSideEvidence =
  | { present: false; side: null }
  | { present: true; side: CompetitiveSide | null };

const combatActorSideKeys = [
  'actor_team',
  'attacker_team',
  'attackerteam',
  'attacker_team_num',
] as const;

const combatTargetSideKeys = [
  'target_team',
  'victim_team',
  'user_team',
  'userteam',
  'victimteam',
  'user_team_num',
  'victim_team_num',
  'team_num',
  'teamnum',
  'team',
] as const;

const objectiveActorSideKeys = [
  'actor_team',
  'attacker_team',
  'attackerteam',
  'attacker_team_num',
  'user_team',
  'userteam',
  'user_team_num',
  'team_num',
  'teamnum',
  'team',
] as const;

const roundEndWinnerSideKeys = ['winner', 'winner_team', 'winner_name'] as const;

function explicitSideEvidence(
  event: TimelineEvent,
  keys: readonly string[],
): ExplicitSideEvidence {
  const detail = eventDetail(event);
  const decoded: Array<CompetitiveSide | null> = [];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(detail, key)) {
      decoded.push(normalizedCompetitiveSide(detail[key]));
    }
  }
  if (decoded.length === 0) return { present: false, side: null };
  if (decoded.some((side) => side === null)) return { present: true, side: null };
  const sides = new Set(decoded as CompetitiveSide[]);
  return { present: true, side: sides.size === 1 ? [...sides][0]! : null };
}

function decodedActorSide(event: TimelineEvent): ExplicitSideEvidence {
  const keys = event.kind === 'kill' || event.kind === 'damage'
    ? combatActorSideKeys
    : objectiveActorSideKeys;
  return explicitSideEvidence(event, keys);
}

function decodedTargetSide(event: TimelineEvent): ExplicitSideEvidence {
  return explicitSideEvidence(event, combatTargetSideKeys);
}

function damageHealth(event: TimelineEvent): number | null {
  const value = eventDetail(event).dmg_health;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function atomKind(event: TimelineEvent): ObjectiveReviewAtomKind | null {
  if (event.kind === 'bomb_plant') return 'plant';
  if (event.kind === 'bomb_defuse') return 'defuse';
  if (event.kind === 'bomb_explode') return 'explode';
  if (event.kind === 'round_end') return 'round_end';
  if (event.kind === 'kill' || event.kind === 'damage') return event.kind;
  return null;
}

function unavailableWorkspace(
  workspace: AnalysisWorkspace,
  reason: string | null,
  failureCode: string | null,
  failureRound: number | null,
): ObjectiveReviewWorkspace {
  return {
    teams: [],
    rounds: [],
    summary: {
      total_rounds: workspace.rounds.length,
      plant_rounds: 0,
      verified_plant_rounds: 0,
      unavailable_plant_rounds: 0,
      planting_team_wins: 0,
      planting_team_losses: 0,
      defuses: 0,
      explosions: 0,
      no_terminal_events: 0,
      post_plant_kills: 0,
      post_plant_damage: 0,
    },
    availability: {
      state: 'unavailable',
      reason,
      failure_code: failureCode,
      failure_round: failureRound,
    },
  };
}

export function buildObjectiveReviewWorkspace(
  workspace: AnalysisWorkspace,
): ObjectiveReviewWorkspace {
  if (workspace.rounds.some((round) => !Number.isSafeInteger(round.number) || round.number <= 0)) {
    return unavailableWorkspace(
      workspace,
      'Every source round requires a positive safe-integer number for exact navigation.',
      'invalid_round_number',
      null,
    );
  }
  const roundNumberCounts = workspace.rounds.reduce(
    (counts, round) => counts.set(round.number, (counts.get(round.number) ?? 0) + 1),
    new Map<number, number>(),
  );
  const duplicateRoundNumber = [...roundNumberCounts].find(([, count]) => count > 1)?.[0] ?? null;
  if (duplicateRoundNumber !== null) {
    return unavailableWorkspace(
      workspace,
      `Round ${duplicateRoundNumber} cannot identify one canonical source round.`,
      'duplicate_round_number',
      duplicateRoundNumber,
    );
  }
  const context = deriveStableMatchTeamContext(workspace);
  if (context.availability.state !== 'available') {
    return unavailableWorkspace(
      workspace,
      context.availability.reason,
      context.availability.failure_code,
      context.availability.failure_round,
    );
  }
  const players = new Map(workspace.players.map((player) => [player.id, player]));
  const eventIdCounts = context.rounds
    .flatMap((round) => round.source.events)
    .reduce((counts, item) => counts.set(item.id, (counts.get(item.id) ?? 0) + 1), new Map<string, number>());
  const duplicateEventIds = new Set(
    [...eventIdCounts].filter(([, count]) => count > 1).map(([id]) => id),
  );
  const rounds: ObjectiveReviewRound[] = [];
  for (const stableRound of context.rounds) {
    const round = stableRound.source;
    const plants = round.events.filter((item) => item.kind === 'bomb_plant');
    if (plants.length === 0) continue;
    if (round.winner !== 'A' && round.winner !== 'B') {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} has no verified Team A/B winner.`,
        reason_code: 'unknown_round_winner',
        winner: null,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    if (plants.length > 1) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} contains more than one plant event.`,
        reason_code: 'ambiguous_plant',
        winner: round.winner,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    const plant = plants[0]!;
    if (!inBounds(plant, round)) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} plant lies outside its verified tick range.`,
        reason_code: 'plant_outside_round_bounds',
        winner: round.winner,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    if (!plant.actor?.trim()) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} plant has no actor.`,
        reason_code: 'missing_plant_actor',
        winner: round.winner,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    const actor = players.get(plant.actor);
    if (!actor) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} plant actor is outside the verified roster.`,
        reason_code: 'unknown_plant_actor',
        winner: round.winner,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    const roundEnds = round.events.filter((item) => item.kind === 'round_end');
    if (roundEnds.length > 1) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} contains more than one round-end event.`,
        reason_code: 'ambiguous_round_end',
        winner: round.winner,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    const roundEnd = roundEnds[0];
    if (!roundEnd || !inBounds(roundEnd, round)) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} has no verified in-bounds round-end event.`,
        reason_code: 'missing_round_end',
        winner: round.winner,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    if (roundEnd.tick < plant.tick) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} round end occurs before its plant.`,
        reason_code: 'round_end_before_plant',
        winner: round.winner,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    const roundEndWinnerSide = explicitSideEvidence(roundEnd, roundEndWinnerSideKeys);
    if (roundEndWinnerSide.present
      && roundEndWinnerSide.side !== stableRound.sides[round.winner]) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} round-end winner side contradicts the verified Team A/B winner.`,
        reason_code: 'round_end_winner_conflict',
        winner: round.winner,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    const actorTeam = actor.team;
    if (stableRound.sides[actorTeam] !== 'T') {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} plant actor is not on the verified T side.`,
        reason_code: 'plant_actor_side_mismatch',
        winner: round.winner === 'A' || round.winner === 'B' ? round.winner : null,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    const plantRawSide = decodedActorSide(plant);
    if (plantRawSide.present && plantRawSide.side !== stableRound.sides[actorTeam]) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} plant actor raw side contradicts the verified roster.`,
        reason_code: 'plant_actor_side_conflict',
        winner: round.winner,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    const canonicalWindowEvents = round.events.filter((item) =>
      (item.tick >= plant.tick && item.tick <= roundEnd.tick) || item === roundEnd);
    const invalidAtomTick = canonicalWindowEvents.find((item) =>
      atomKind(item) !== null && !Number.isSafeInteger(item.tick));
    if (invalidAtomTick) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} contains an objective-review atom without a safe-integer tick.`,
        reason_code: 'atom_tick_invalid',
        winner: round.winner,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    if (canonicalWindowEvents.some((item) => !item.id.trim() || duplicateEventIds.has(item.id))) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} contains an empty or non-unique canonical event ID.`,
        reason_code: 'duplicate_event_id',
        winner: round.winner === 'A' || round.winner === 'B' ? round.winner : null,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    const encounterEvents = canonicalWindowEvents
      .filter((item) => item.kind === 'kill' || item.kind === 'damage')
      .sort((left, right) => left.tick - right.tick || left.id.localeCompare(right.id));
    const missingTarget = encounterEvents.find((item) => !item.target?.trim());
    if (missingTarget) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} contains a ${missingTarget.kind} atom without a target.`,
        reason_code: 'missing_target',
        winner: round.winner,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    const unknownTarget = encounterEvents.find((item) => !players.has(item.target!));
    if (unknownTarget) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} contains a ${unknownTarget.kind} target outside the verified roster.`,
        reason_code: 'unknown_target',
        winner: round.winner,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    const unknownActor = encounterEvents.find((item) => item.actor !== null && !players.has(item.actor));
    if (unknownActor) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} contains a non-null ${unknownActor.kind} actor outside the verified roster.`,
        reason_code: 'unknown_actor',
        winner: round.winner,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    const actorSideConflict = encounterEvents.find((item) => {
      const rawSide = decodedActorSide(item);
      if (!rawSide.present) return false;
      if (!item.actor) return true;
      const participant = players.get(item.actor);
      return participant === undefined || rawSide.side !== stableRound.sides[participant.team];
    });
    if (actorSideConflict) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} ${actorSideConflict.kind} actor raw side contradicts the verified roster.`,
        reason_code: 'encounter_actor_side_conflict',
        winner: round.winner,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    const targetSideConflict = encounterEvents.find((item) => {
      const participant = item.target ? players.get(item.target) : undefined;
      const rawSide = decodedTargetSide(item);
      if (!rawSide.present) return false;
      return participant === undefined || rawSide.side !== stableRound.sides[participant.team];
    });
    if (targetSideConflict) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} ${targetSideConflict.kind} target raw side contradicts the verified roster.`,
        reason_code: 'encounter_target_side_conflict',
        winner: round.winner,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    const terminals = round.events.filter((item) =>
      item.kind === 'bomb_defuse' || item.kind === 'bomb_explode');
    if (terminals.some((item) =>
      !Number.isSafeInteger(item.tick) || item.tick < plant.tick || item.tick > roundEnd.tick)) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} contains a terminal objective event outside its canonical plant window.`,
        reason_code: 'terminal_outside_plant_window',
        winner: round.winner,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    if (terminals.length > 1) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} contains more than one terminal objective event in the plant window.`,
        reason_code: 'ambiguous_terminal',
        winner: round.winner === 'A' || round.winner === 'B' ? round.winner : null,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    const terminalSource = terminals.length === 1 ? terminals[0]! : null;
    const terminalActor = terminalSource?.actor ? players.get(terminalSource.actor) : undefined;
    if (terminalSource?.actor && !terminalActor) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} terminal objective actor is outside the verified roster.`,
        reason_code: 'unknown_terminal_actor',
        winner: round.winner,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    const terminalRawSide = terminalSource ? decodedActorSide(terminalSource) : null;
    if (terminalSource
      && terminalRawSide
      && terminalRawSide.present
      && (!terminalActor || terminalRawSide.side !== stableRound.sides[terminalActor.team])) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} terminal actor raw side contradicts the verified roster.`,
        reason_code: 'terminal_actor_side_conflict',
        winner: round.winner,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    if (terminalSource?.kind === 'bomb_defuse' && !terminalActor) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} defuse has no canonical actor.`,
        reason_code: 'missing_defuse_actor',
        winner: round.winner,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    if (terminalSource?.kind === 'bomb_defuse'
      && terminalActor
      && stableRound.sides[terminalActor.team] !== 'CT') {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} defuse actor is not on the verified CT side.`,
        reason_code: 'defuse_actor_side_mismatch',
        winner: round.winner,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    const plantingTeamWon = round.winner === actorTeam;
    if ((terminalSource?.kind === 'bomb_defuse' && plantingTeamWon)
      || (terminalSource?.kind === 'bomb_explode' && !plantingTeamWon)) {
      rounds.push({
        round: round.number,
        state: 'unavailable',
        reason: `Round ${round.number} terminal objective result contradicts the verified winner.`,
        reason_code: 'terminal_winner_mismatch',
        winner: round.winner,
        plant: null,
        terminal: null,
        round_end_evidence_id: null,
        timeline_groups: [],
      });
      continue;
    }
    const timelineAtoms = round.events
      .filter((item) => item.tick >= plant.tick && item.tick <= roundEnd.tick)
      .sort((left, right) => left.tick - right.tick || left.id.localeCompare(right.id))
      .flatMap((item): ObjectiveReviewAtom[] => {
        const kind = atomKind(item);
        if (!kind) return [];
        const exposesActor = kind !== 'round_end';
        const exposesTarget = kind === 'kill' || kind === 'damage';
        const exposesWeapon = kind === 'kill' || kind === 'damage';
        const exposesKillFlags = kind === 'kill';
        const atomActor = exposesActor && item.actor ? players.get(item.actor) ?? null : null;
        const atomTarget = exposesTarget && item.target ? players.get(item.target) ?? null : null;
        return [{
          evidence_id: `demo:${workspace.demo_id}/event:${item.id}`,
          demo_id: workspace.demo_id,
          source_id: item.id,
          source_kind: 'event',
          round: round.number,
          tick: item.tick,
          end_tick: null,
          seconds: item.seconds,
          kind,
          actor_id: atomActor?.id ?? null,
          actor_name: atomActor?.name ?? null,
          actor_team: atomActor?.team ?? null,
          actor_side: atomActor ? stableRound.sides[atomActor.team] : null,
          target_id: atomTarget?.id ?? null,
          target_name: atomTarget?.name ?? null,
          target_team: atomTarget?.team ?? null,
          target_side: atomTarget ? stableRound.sides[atomTarget.team] : null,
          weapon: exposesWeapon ? item.weapon?.trim() || null : null,
          headshot: exposesKillFlags ? item.headshot : false,
          penetrated: exposesKillFlags ? item.penetrated : false,
          damage_health: kind === 'damage' ? damageHealth(item) : null,
        }];
      });
    const timelineGroups = timelineAtoms.reduce<ObjectiveReviewTimelineGroup[]>((groups, atom) => {
      let group = groups.at(-1);
      if (!group || group.tick !== atom.tick) {
        group = {
          key: `${round.number}:${atom.tick}`,
          tick: atom.tick,
          atomic_event_ids: [],
          atoms: [],
          damage_event_count: 0,
          damage_total: 0,
        };
        groups.push(group);
      }
      group.atomic_event_ids.push(atom.source_id);
      group.atoms.push(atom);
      if (atom.kind === 'damage') {
        group.damage_event_count += 1;
        group.damage_total = atom.damage_health === null || group.damage_total === null
          ? null
          : group.damage_total + atom.damage_health;
      }
      return groups;
    }, []);
    rounds.push({
      round: round.number,
      state: 'available',
      reason: null,
      reason_code: null,
      winner: round.winner === 'A' || round.winner === 'B' ? round.winner : null,
      plant: {
        evidence_id: `demo:${workspace.demo_id}/event:${plant.id}`,
        demo_id: workspace.demo_id,
        source_kind: 'event',
        source_id: plant.id,
        round: round.number,
        tick: plant.tick,
        end_tick: null,
        seconds: plant.seconds,
        actor_id: actor.id,
        actor_name: actor.name,
        actor_team: actorTeam,
        actor_side: stableRound.sides[actorTeam],
        raw_site_code: rawSiteCode(plant),
      },
      terminal: terminalSource ? {
        kind: terminalSource.kind === 'bomb_defuse' ? 'defuse' : 'explode',
        evidence_id: `demo:${workspace.demo_id}/event:${terminalSource.id}`,
        source_id: terminalSource.id,
        tick: terminalSource.tick,
        actor_id: terminalSource.actor,
      } : null,
      round_end_evidence_id: `demo:${workspace.demo_id}/event:${roundEnd.id}`,
      round_end: {
        evidence_id: `demo:${workspace.demo_id}/event:${roundEnd.id}`,
        source_id: roundEnd.id,
        tick: roundEnd.tick,
      },
      timeline_groups: timelineGroups,
    });
  }
  const unavailable = rounds.filter((round) => round.state === 'unavailable');
  const verified = rounds.filter((round): round is ObjectiveReviewRound & {
    state: 'available'; plant: ObjectivePlantEvidence;
  } => round.state === 'available' && round.plant !== null);
  const atoms = verified.flatMap((round) => round.timeline_groups.flatMap((group) => group.atoms));
  return {
    teams: context.teams,
    rounds,
    summary: {
      total_rounds: workspace.rounds.length,
      plant_rounds: rounds.length,
      verified_plant_rounds: verified.length,
      unavailable_plant_rounds: unavailable.length,
      planting_team_wins: verified.filter((round) => round.winner === round.plant.actor_team).length,
      planting_team_losses: verified.filter((round) => round.winner !== round.plant.actor_team).length,
      defuses: verified.filter((round) => round.terminal?.kind === 'defuse').length,
      explosions: verified.filter((round) => round.terminal?.kind === 'explode').length,
      no_terminal_events: verified.filter((round) => round.terminal === null).length,
      post_plant_kills: atoms.filter((atom) => atom.kind === 'kill').length,
      post_plant_damage: atoms.filter((atom) => atom.kind === 'damage').length,
    },
    availability: {
      state: unavailable.length === 0 ? 'available' : unavailable.length === rounds.length ? 'unavailable' : 'partial',
      reason: unavailable.length === 0 ? null : `${unavailable.length} post-plant round(s) are unavailable.`,
      failure_code: unavailable[0]?.reason_code ?? null,
      failure_round: unavailable[0]?.round ?? null,
    },
  };
}
