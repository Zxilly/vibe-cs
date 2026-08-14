import type { PlayerMatch, PlayerMatchPage } from '../../shared/desktop/dto';

export type PlayerTrendMetric = 'adr' | 'kd' | 'kills' | 'damage';

export type PlayerTrendPoint = {
  demoId: string;
  demoName: string;
  mapName: string | null;
  matchDate: string | null;
  catalogedAt: string;
  value: number | null;
  href: string;
};

export type PlayerTrend = {
  metric: PlayerTrendMetric;
  points: PlayerTrendPoint[];
  minimum: number | null;
  maximum: number | null;
  window: { first: number; last: number; total: number };
  comparison: {
    sampleSize: number;
    priorAverage: number;
    recentAverage: number;
    delta: number;
  } | null;
};

function metricValue(match: PlayerMatch, metric: PlayerTrendMetric): number | null {
  const value = metric === 'adr'
    ? match.adr
    : metric === 'kd'
      ? match.kill_death_ratio
      : metric === 'kills'
        ? match.kills
        : match.damage;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function derivePlayerTrend(
  page: PlayerMatchPage,
  metric: PlayerTrendMetric,
): PlayerTrend {
  const points = [...page.items].reverse().map((match): PlayerTrendPoint => ({
    demoId: match.demo_id,
    demoName: match.demo_name,
    mapName: match.map_name,
    matchDate: match.match_date,
    catalogedAt: match.cataloged_at,
    value: metricValue(match, metric),
    href: `/analysis?${new URLSearchParams({
      demo: match.demo_id,
      tab: 'players',
      player: page.steam_id,
    }).toString()}`,
  }));
  const values = points.flatMap((point) => point.value === null ? [] : [point.value]);
  const sampleSize = Math.min(5, Math.floor(values.length / 2));
  const comparison = sampleSize > 0 ? (() => {
    const recent = values.slice(-sampleSize);
    const prior = values.slice(-(sampleSize * 2), -sampleSize);
    const recentAverage = average(recent);
    const priorAverage = average(prior);
    return { sampleSize, priorAverage, recentAverage, delta: recentAverage - priorAverage };
  })() : null;
  const first = page.total === 0 ? 0 : (page.page - 1) * page.page_size + 1;
  const last = page.total === 0 ? 0 : first + page.items.length - 1;

  return {
    metric,
    points,
    minimum: values.length > 0 ? Math.min(...values) : null,
    maximum: values.length > 0 ? Math.max(...values) : null,
    window: { first, last, total: page.total },
    comparison,
  };
}
