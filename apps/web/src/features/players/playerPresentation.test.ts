import { describe, expect, it } from 'vitest';

import type { PlayerDirectoryItem, PlayerSteamProfile } from '../../shared/desktop/dto';
import {
  MAXIMUM_PLAYER_SEARCH_CHARACTERS,
  PLAYER_SEARCH_DEBOUNCE_MS,
  formatCacheBytes,
  formatOptionalMetric,
  isCurrentRequest,
  localPlayerAvatarPath,
  normalizePlayerSearch,
  playerHeadshotRate,
  playerKd,
  playerPageCount,
  steamEvidence,
  reconcileComparedPlayerIds,
  toggleComparedPlayerIds,
} from './playerPresentation';

const baseSteam: PlayerSteamProfile = {
  state: 'available',
  persona_name: 'Public Player',
  real_name: null,
  profile_url: 'https://steamcommunity.com/profiles/76561198000000001/',
  country_code: 'CN',
  persona_state: 1,
  last_logoff: null,
  created_at: null,
  avatar_url: '/api/players/76561198000000001/avatar',
  reason: null,
};

const player: PlayerDirectoryItem = {
  steam_id: '76561198000000001',
  name: 'Local Player',
  aliases: [],
  last_team: 'CT',
  last_match_at: '2026-08-10T08:00:00Z',
  stats: {
    matches: 2,
    kills: 30,
    deaths: 20,
    assists: 8,
    headshots: 15,
    damage: 3_200,
    average_adr: 82.25,
    average_kill_death_ratio: 1.1,
  },
  steam: baseSteam,
};

describe('player presentation', () => {
  it('accepts only the exact service-owned avatar route', () => {
    expect(localPlayerAvatarPath(player)).toBe('/api/players/76561198000000001/avatar');
    expect(localPlayerAvatarPath({
      ...player,
      steam: { ...baseSteam, avatar_url: 'https://avatars.steamstatic.com/avatar.jpg' },
    })).toBeNull();
    expect(localPlayerAvatarPath({
      ...player,
      steam: { ...baseSteam, state: 'unavailable' },
    })).toBeNull();
  });

  it('keeps search, pagination, and request guards bounded', () => {
    expect(normalizePlayerSearch(`  ${'玩'.repeat(200)}  `)).toHaveLength(
      MAXIMUM_PLAYER_SEARCH_CHARACTERS,
    );
    expect(PLAYER_SEARCH_DEBOUNCE_MS).toBe(250);
    expect(playerPageCount(49, 24)).toBe(3);
    expect(playerPageCount(Number.NaN, 0)).toBe(1);
    expect(isCurrentRequest(4, 4)).toBe(true);
    expect(isCurrentRequest(5, 4)).toBe(false);
  });

  it('labels evidence states and formats only evidenced statistics', () => {
    expect(steamEvidence(baseSteam)).toMatchObject({ tone: 'success' });
    expect(steamEvidence({ ...baseSteam, state: 'not_configured' })).toMatchObject({
      tone: 'warning',
    });
    expect(steamEvidence({ ...baseSteam, state: 'unavailable', reason: 'private' })).toMatchObject({
      detail: 'private',
      tone: 'neutral',
    });
    expect(playerKd(player.stats)).toBe('1.50');
    expect(playerKd({ ...player.stats, kills: 3, deaths: 0 })).toBe('∞');
    expect(playerHeadshotRate(player.stats)).toBe('50.0%');
    expect(formatOptionalMetric(Number.NaN)).toBe('—');
    expect(formatCacheBytes(1536)).toBe('1.5 KiB');
  });

  it('keeps an ordered comparison of at most two real directory players', () => {
    expect(toggleComparedPlayerIds([], 'player-1')).toEqual(['player-1']);
    expect(toggleComparedPlayerIds(['player-1'], 'player-2')).toEqual(['player-1', 'player-2']);
    expect(toggleComparedPlayerIds(['player-1', 'player-2'], 'player-3')).toEqual(['player-2', 'player-3']);
    expect(toggleComparedPlayerIds(['player-1', 'player-2'], 'player-1')).toEqual(['player-2']);
  });

  it('removes only ids proven absent by an exact player read', async () => {
    const missing = new Error('missing');
    const result = await reconcileComparedPlayerIds(
      ['player-1', 'player-2'],
      async (id) => {
        if (id === 'player-1') throw missing;
      },
      (error) => error === missing,
    );

    expect(result).toEqual({ retainedIds: ['player-2'], missingIds: ['player-1'] });
    await expect(reconcileComparedPlayerIds(
      ['player-1', 'player-2'],
      async () => { throw new Error('offline'); },
      () => false,
    )).rejects.toThrow('offline');
  });

  it('does not expose a current-page retention helper that could erase explicit ids', async () => {
    const presentation = await import('./playerPresentation');
    expect(presentation).not.toHaveProperty('retainComparedPlayersOnPage');
  });
});
