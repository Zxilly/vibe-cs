import { msg } from '../../shared/i18n';
import type {
  AnalysisInsightsRecord,
  AnalysisWorkspace,
  Highlight,
  PlayerAnalysis,
  PlayerMatchupInsightRecord,
  RoundEconomyInsightRecord,
  TeamPurchaseInsightRecord,
} from '../../shared/desktop/dto';

const unavailable = (reason: string) => ({ available: false, reason });

export function emptyAnalysisInsights(reason = msg("m0563")): AnalysisInsightsRecord {
  return {
    round_economy: [],
    player_utility: [],
    matchups: [],
    availability: {
      purchase_events: unavailable(reason),
      purchase_spend: unavailable(reason),
      utility_events: unavailable(reason),
      utility_damage: unavailable(reason),
      flash_effects: unavailable(reason),
      matchups: unavailable(reason),
    },
  };
}

export function normalizeAnalysisInsights(
  insights: AnalysisInsightsRecord,
): AnalysisInsightsRecord {
  return {
    round_economy: [...insights.round_economy].sort((left, right) => left.round - right.round),
    player_utility: [...insights.player_utility],
    matchups: [...insights.matchups],
    availability: { ...insights.availability },
  };
}

export function analysisInsightsForWorkspace(
  workspace: Pick<AnalysisWorkspace, 'insights'>,
): AnalysisInsightsRecord {
  return workspace.insights ? normalizeAnalysisInsights(workspace.insights) : emptyAnalysisInsights();
}

export function teamPurchaseForSide(
  round: RoundEconomyInsightRecord,
  side: 'T' | 'CT',
): TeamPurchaseInsightRecord | null {
  return round.teams.find((team) => team.team.trim().toLocaleUpperCase() === side) ?? null;
}

export function matchupsForPlayer(
  insights: AnalysisInsightsRecord,
  playerId: string,
  players: PlayerAnalysis[],
): PlayerMatchupInsightRecord[] {
  const playersById = new Map(players.map((player) => [player.id, player]));
  const player = playersById.get(playerId);
  const playerTeam = player?.team;
  return insights.matchups
    .filter((matchup) => {
      if (matchup.player_id !== playerId) return false;
      const opponent = playersById.get(matchup.opponent_id);
      return !playerTeam || !opponent || opponent.team !== playerTeam;
    })
    .sort((left, right) => {
      const leftImpact = left.kills * 1000 + left.damage_dealt;
      const rightImpact = right.kills * 1000 + right.damage_dealt;
      return rightImpact - leftImpact || left.opponent_id.localeCompare(right.opponent_id);
    });
}

export function orderHighlightsForCompilation(highlights: Highlight[]): Highlight[] {
  const unique = new Map<string, Highlight>();
  highlights.forEach((highlight) => unique.set(highlight.id, highlight));
  return [...unique.values()].sort((left, right) =>
    left.round - right.round
    || left.start_tick - right.start_tick
    || left.id.localeCompare(right.id));
}
