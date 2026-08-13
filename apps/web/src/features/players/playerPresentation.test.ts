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
  retainComparedPlayersOnPage,
  toggleComparedPlayer,
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
    const second = { ...player, steam_id: '2', name: 'Second' };
    const third = { ...player, steam_id: '3', name: 'Third' };

    expect(toggleComparedPlayer([], player)).toEqual([player]);
    expect(toggleComparedPlayer([player], second)).toEqual([player, second]);
    expect(toggleComparedPlayer([player, second], third)).toEqual([second, third]);
    expect(toggleComparedPlayer([player, second], player)).toEqual([second]);
  });

  it('drops comparison selections that are not on the current server page', () => {
    const second = { ...player, steam_id: '2', name: 'Second' };

    expect(retainComparedPlayersOnPage([player, second], [second])).toEqual([second]);
    expect(retainComparedPlayersOnPage([player], [])).toEqual([]);
  });

});
