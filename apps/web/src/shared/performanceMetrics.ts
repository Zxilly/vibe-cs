export type KillDeathStats = {
  kills: number;
  deaths: number;
};

function normalizedCount(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function killDeathRatio<T extends KillDeathStats>(stats: T): number | null {
  const kills = normalizedCount(stats.kills);
  const deaths = normalizedCount(stats.deaths);
  if (kills === null || deaths === null || (kills === 0 && deaths === 0)) return null;
  if (deaths === 0) return Number.POSITIVE_INFINITY;
  return kills / deaths;
}

export function formatKillDeathRatioValue(value: number | null, digits = 2): string {
  if (value === Number.POSITIVE_INFINITY) return '∞';
  return value !== null && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

export function formatKillDeathRatio<T extends KillDeathStats>(stats: T, digits = 2): string {
  return formatKillDeathRatioValue(killDeathRatio(stats), digits);
}

export function averageKillDeathRatio<T extends KillDeathStats>(stats: readonly T[]): number | null {
  const ratios = stats.map(killDeathRatio).filter((value): value is number => value !== null);
  if (ratios.length === 0) return null;
  if (ratios.some((value) => value === Number.POSITIVE_INFINITY)) return Number.POSITIVE_INFINITY;
  return ratios.reduce((total, value) => total + value, 0) / ratios.length;
}

export function compareKillDeathRatio<T extends KillDeathStats>(left: T, right: T): number {
  const leftRatio = killDeathRatio(left) ?? Number.NEGATIVE_INFINITY;
  const rightRatio = killDeathRatio(right) ?? Number.NEGATIVE_INFINITY;
  return rightRatio - leftRatio;
}
