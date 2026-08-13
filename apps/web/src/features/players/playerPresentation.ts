import { currentLocale, msg, msgf } from '../../shared/i18n';
import type {
  PlayerAggregateStats,
  PlayerDirectoryItem,
  PlayerSteamProfile,
} from '../../shared/desktop/dto';
import { formatKillDeathRatio } from '../../shared/performanceMetrics';

export const PLAYER_PAGE_SIZE = 24;
export const PLAYER_SEARCH_DEBOUNCE_MS = 250;
export const MAXIMUM_PLAYER_SEARCH_CHARACTERS = 128;

export type PlayerDirectorySort = {
  key: 'player' | 'team' | 'matches' | 'kd' | 'kills' | 'deaths' | 'assists' | 'headshots' | 'adr' | 'damage' | 'lastMatch' | 'steam';
  direction: 'asc' | 'desc';
};

export type SteamEvidence = {
  label: string;
  detail: string;
  tone: 'success' | 'warning' | 'neutral';
};

export function normalizePlayerSearch(value: string): string {
  return Array.from(value.trim()).slice(0, MAXIMUM_PLAYER_SEARCH_CHARACTERS).join('');
}

export function playerPageCount(total: number, pageSize = PLAYER_PAGE_SIZE): number {
  if (!Number.isFinite(total) || !Number.isFinite(pageSize) || pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
}

export function sortPlayerDirectory(
  players: readonly PlayerDirectoryItem[],
  sort: PlayerDirectorySort,
): PlayerDirectoryItem[] {
  return [...players].sort((left, right) => {
    const leftValue = playerDirectorySortValue(left, sort.key);
    const rightValue = playerDirectorySortValue(right, sort.key);
    if (leftValue === null && rightValue === null) return left.name.localeCompare(right.name);
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), currentLocale(), { numeric: true, sensitivity: 'base' });
    return sort.direction === 'asc' ? comparison : -comparison;
  });
}

function playerDirectorySortValue(
  player: PlayerDirectoryItem,
  key: PlayerDirectorySort['key'],
): string | number | null {
  switch (key) {
    case 'player': return player.name.trim() || player.steam_id;
    case 'team': return player.last_team?.trim() || null;
    case 'matches': return player.stats.matches;
    case 'kd': return player.stats.deaths > 0
      ? player.stats.kills / player.stats.deaths
      : player.stats.kills > 0 ? Number.POSITIVE_INFINITY : 0;
    case 'kills': return player.stats.kills;
    case 'deaths': return player.stats.deaths;
    case 'assists': return player.stats.assists;
    case 'headshots': return player.stats.kills > 0 ? player.stats.headshots / player.stats.kills : null;
    case 'adr': return player.stats.average_adr;
    case 'damage': return player.stats.damage;
    case 'lastMatch': {
      const timestamp = Date.parse(player.last_match_at);
      return Number.isFinite(timestamp) ? timestamp : null;
    }
    case 'steam': return player.steam.state;
  }
}

export function toggleComparedPlayer(
  current: readonly PlayerDirectoryItem[],
  player: PlayerDirectoryItem,
): PlayerDirectoryItem[] {
  if (current.some((item) => item.steam_id === player.steam_id)) {
    return current.filter((item) => item.steam_id !== player.steam_id);
  }
  return [...current.slice(-1), player];
}

export function retainComparedPlayersOnPage(
  current: readonly PlayerDirectoryItem[],
  pageItems: readonly PlayerDirectoryItem[],
): PlayerDirectoryItem[] {
  const currentPageIds = new Set(pageItems.map((item) => item.steam_id));
  return current.filter((item) => currentPageIds.has(item.steam_id));
}

export function localPlayerAvatarPath(player: PlayerDirectoryItem): string | null {
  const expected = `/api/players/${encodeURIComponent(player.steam_id)}/avatar`;
  return player.steam.state === 'available' && player.steam.avatar_url === expected
    ? expected
    : null;
}

export function playerInitials(name: string): string {
  const normalized = name.trim();
  return Array.from(normalized || '?').slice(0, 2).join('').toLocaleUpperCase();
}

export function steamEvidence(profile: PlayerSteamProfile): SteamEvidence {
  if (profile.state === 'available') {
    return {
      label: msg("m0068"),
      detail: profile.persona_name
        ? msgf("m0238", [profile.persona_name])
        : msg("m0071"),
      tone: 'success',
    };
  }
  if (profile.state === 'not_configured') {
    return {
      label: msg("m0077"),
      detail: msg("m0798"),
      tone: 'warning',
    };
  }
  return {
    label: msg("m0076"),
    detail: profile.reason?.trim() || msg("m0072"),
    tone: 'neutral',
  };
}

export function playerKd(stats: PlayerAggregateStats): string {
  return formatKillDeathRatio(stats);
}

export function playerHeadshotRate(stats: PlayerAggregateStats): string {
  if (stats.kills <= 0) return '—';
  const percentage = (stats.headshots / stats.kills) * 100;
  return Number.isFinite(percentage) ? `${percentage.toFixed(1)}%` : '—';
}

export function formatOptionalMetric(value: number | null, digits = 1): string {
  return value !== null && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

export function formatCacheBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

export function isCurrentRequest(currentRevision: number, requestRevision: number): boolean {
  return currentRevision === requestRevision;
}
