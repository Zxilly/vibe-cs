import type { CountedItemRecord } from '../../shared/desktop/dto';
import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import { analysisInsightsForWorkspace, matchupsForPlayer } from './analysisInsights';

export type OverviewWeaponEvidence = {
  name: string;
  kills: number;
  headshots: number;
};

export type OverviewDuelEvidence = {
  opponent_id: string;
  opponent_name: string;
  kills: number;
  deaths: number;
  headshot_kills: number;
  damage_dealt: number;
  damage_taken: number;
};

export type OverviewEvidence = {
  weapons: OverviewWeaponEvidence[];
  duel: OverviewDuelEvidence | null;
  utility: {
    available: boolean;
    throws: number;
    detonations: number;
    damage: number;
    items: CountedItemRecord[];
  };
  objectives: {
    plants: number;
    defuses: number;
    explosions: number;
  };
  economy: {
    available: boolean;
    purchases: number;
    spend: number | null;
    unattributed: number;
  };
};

export function buildOverviewEvidence(
  workspace: AnalysisWorkspace,
  playerId: string,
): OverviewEvidence {
  const player = workspace.players.find((candidate) => candidate.id === playerId) ?? null;
  const identities = new Set(player ? [player.id, player.name] : []);
  const weaponCounts = new Map<string, { kills: number; headshots: number }>();
  const objectives = { plants: 0, defuses: 0, explosions: 0 };

  for (const round of workspace.rounds) {
    for (const event of round.events) {
      if (!event.actor || !identities.has(event.actor)) continue;
      if (event.kind === 'kill' && event.weapon) {
        const current = weaponCounts.get(event.weapon) ?? { kills: 0, headshots: 0 };
        current.kills += 1;
        current.headshots += event.headshot ? 1 : 0;
        weaponCounts.set(event.weapon, current);
      } else if (event.kind === 'bomb_plant') {
        objectives.plants += 1;
      } else if (event.kind === 'bomb_defuse') {
        objectives.defuses += 1;
      } else if (event.kind === 'bomb_explode') {
        objectives.explosions += 1;
      }
    }
  }

  const insights = analysisInsightsForWorkspace(workspace);
  const utility = player
    ? insights.player_utility.find((candidate) => candidate.player_id === player.id) ?? null
    : null;
  const duel = player ? matchupsForPlayer(insights, player.id, workspace.players)[0] ?? null : null;
  const opponent = duel
    ? workspace.players.find((candidate) => candidate.id === duel.opponent_id) ?? null
    : null;
  const teamPurchases = insights.round_economy
    .flatMap((round) => round.teams)
    .filter((team) => ['T', 'CT'].includes(team.team.trim().toLocaleUpperCase()));
  const purchasedTeams = teamPurchases.filter((team) => team.purchase_count > 0);
  const spendIsComplete = insights.availability.purchase_spend.available
    && purchasedTeams.every((team) => team.spend !== null);

  return {
    weapons: [...weaponCounts.entries()]
      .map(([name, counts]) => ({ name, ...counts }))
      .sort((left, right) => right.kills - left.kills
        || right.headshots - left.headshots
        || left.name.localeCompare(right.name))
      .slice(0, 5),
    duel: duel ? {
      opponent_id: duel.opponent_id,
      opponent_name: opponent?.name ?? duel.opponent_id,
      kills: duel.kills,
      deaths: duel.deaths,
      headshot_kills: duel.headshot_kills,
      damage_dealt: duel.damage_dealt,
      damage_taken: duel.damage_taken,
    } : null,
    utility: utility ? {
      available: insights.availability.utility_events.available,
      throws: utility.throws,
      detonations: utility.detonations,
      damage: utility.damage,
      items: [...utility.items].sort((left, right) => right.count - left.count
        || left.name.localeCompare(right.name)),
    } : { available: false, throws: 0, detonations: 0, damage: 0, items: [] },
    objectives,
    economy: {
      available: insights.availability.purchase_events.available,
      purchases: teamPurchases.reduce((total, team) => total + team.purchase_count, 0),
      spend: spendIsComplete
        ? purchasedTeams.reduce((total, team) => total + (team.spend ?? 0), 0)
        : null,
      unattributed: insights.round_economy.reduce(
        (total, round) => total + round.unattributed_purchase_count,
        0,
      ),
    },
  };
}
