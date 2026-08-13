import { formatKillDeathRatioValue } from '../../shared/performanceMetrics';

type AnalysisScoreboardPlayer = {
  id: string;
  name?: string;
  team?: string;
  kills: number;
  deaths: number;
  assists: number;
  kill_death_ratio: number;
  adr: number;
  headshot_rate: number;
};

export const analysisScoreboardColumns = ['player', 'K', 'D', 'A', 'K/D', 'ADR', 'HS%'] as const;

export type AnalysisScoreboardRow = {
  id: string;
  name: string;
  team: string;
  kills: number;
  deaths: number;
  assists: number;
  killDeathRatio: string;
  adr: string;
  headshotRate: string;
};

export function analysisScoreboardRows<T extends AnalysisScoreboardPlayer>(
  players: readonly T[],
): AnalysisScoreboardRow[] {
  return [...players].sort((left, right) => right.kill_death_ratio - left.kill_death_ratio).map((player) => ({
    id: player.id,
    name: player.name ?? player.id,
    team: player.team ?? '—',
    kills: player.kills,
    deaths: player.deaths,
    assists: player.assists,
    killDeathRatio: formatKillDeathRatioValue(player.kill_death_ratio, 2),
    adr: player.adr.toFixed(1),
    headshotRate: `${Math.round(player.headshot_rate * 100)}%`,
  }));
}
