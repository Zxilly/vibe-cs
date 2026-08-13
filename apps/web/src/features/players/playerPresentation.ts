import { msg, msgf } from '../../shared/i18n';
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
  key: 'player' | 'team' | 'matches' | 'kd' | 'kills' | 'deaths' | 'assists' | 'headshots' | 'adr' | 'damage' | 'last_match';
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

export function toggleComparedPlayerIds(
  current: readonly string[],
  playerId: string,
): string[] {
  if (current.includes(playerId)) {
    return current.filter((id) => id !== playerId);
  }
  return [...current.slice(-1), playerId];
}

export async function reconcileComparedPlayerIds(
  ids: readonly string[],
  load: (id: string) => Promise<void>,
  isMissing: (error: unknown) => boolean,
): Promise<{ retainedIds: string[]; missingIds: string[] }> {
  const states = await Promise.all(ids.map(async (id) => {
    try {
      await load(id);
      return { id, missing: false } as const;
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
      return { id, missing: true } as const;
    }
  }));
  return {
    retainedIds: states.filter((state) => !state.missing).map((state) => state.id),
    missingIds: states.filter((state) => state.missing).map((state) => state.id),
  };
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
