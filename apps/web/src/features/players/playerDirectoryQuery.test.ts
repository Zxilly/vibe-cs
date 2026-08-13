import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PLAYER_DIRECTORY_QUERY,
  patchPlayerDirectoryQuery,
  playerDirectoryQueryFromParams,
  playerDirectoryQueryToParams,
} from './playerDirectoryQuery';

describe('player directory URL query', () => {
  it('round-trips directory paging, sorting, one exact profile, and its match page', () => {
    const parsed = playerDirectoryQueryFromParams(new URLSearchParams(
      'q=FalleN&page=3&sort=adr&direction=asc&player=76561197960690195&matches_page=2',
    ));

    expect(parsed).toEqual({
      search: 'FalleN',
      page: 3,
      sort: { key: 'adr', direction: 'asc' },
      comparedIds: ['76561197960690195'],
      playerId: '76561197960690195',
      matchesPage: 2,
      inspectorOpen: false,
    });
    expect(playerDirectoryQueryFromParams(playerDirectoryQueryToParams(parsed))).toEqual(parsed);
  });

  it('preserves an ordered explicit pair without pretending either player is the profile', () => {
    const parsed = playerDirectoryQueryFromParams(new URLSearchParams(
      'player=76561198041683378&compare=76561197960690195',
    ));

    expect(parsed.comparedIds).toEqual(['76561198041683378', '76561197960690195']);
    expect(parsed.playerId).toBeNull();
    expect(parsed.inspectorOpen).toBe(false);
  });

  it('owns the compact inspector state in the URL so back and reload are deterministic', () => {
    const open = playerDirectoryQueryFromParams(new URLSearchParams(
      'player=76561197960690195&inspector=1',
    ));
    const closed = patchPlayerDirectoryQuery(open, { inspectorOpen: false });

    expect(open.inspectorOpen).toBe(true);
    expect(playerDirectoryQueryToParams(open).get('inspector')).toBe('1');
    expect(playerDirectoryQueryToParams(closed).has('inspector')).toBe(false);
  });

  it.each([
    'unknown=value',
    'page=0',
    'page=1.5',
    'direction=sideways',
    'player=76561197960690195&compare=76561197960690195',
    'compare=invalid',
    'compare=76561197960690195',
    'player=invalid',
    'player=00000000000000000',
    'page=10001',
    'matches_page=2',
    'inspector=1',
    'player=76561197960690195&inspector=0',
    'player=76561197960690195&inspector=true',
    'player=76561197960690195&matches_page=1.5',
  ])('rejects non-current or internally inconsistent params: %s', (query) => {
    expect(() => playerDirectoryQueryFromParams(new URLSearchParams(query))).toThrow(
      /invalid player directory query/i,
    );
  });

  it('resets only the affected page while preserving explicit selection', () => {
    const selected = {
      ...DEFAULT_PLAYER_DIRECTORY_QUERY,
      page: 4,
      comparedIds: ['76561197960690195'],
      playerId: '76561197960690195',
      matchesPage: 3,
      inspectorOpen: true,
    };

    expect(patchPlayerDirectoryQuery(selected, { search: 'NiKo' })).toMatchObject({
      search: 'NiKo',
      page: 1,
      comparedIds: ['76561197960690195'],
      playerId: '76561197960690195',
      matchesPage: 3,
      inspectorOpen: true,
    });
    expect(patchPlayerDirectoryQuery(selected, { playerId: null, comparedIds: [] })).toMatchObject({
      page: 4,
      comparedIds: [],
      playerId: null,
      matchesPage: 1,
      inspectorOpen: false,
    });
  });

  it('refuses to serialize non-integer or out-of-bound page state', () => {
    expect(() => playerDirectoryQueryToParams({
      ...DEFAULT_PLAYER_DIRECTORY_QUERY,
      page: Number.NaN,
    })).toThrow(/page/i);
    expect(() => playerDirectoryQueryToParams({
      ...DEFAULT_PLAYER_DIRECTORY_QUERY,
      matchesPage: Number.NaN,
    })).toThrow(/matches_page/i);
    expect(() => playerDirectoryQueryToParams({
      ...DEFAULT_PLAYER_DIRECTORY_QUERY,
      page: 1.5,
    })).toThrow(/page/i);
    expect(() => playerDirectoryQueryToParams({
      ...DEFAULT_PLAYER_DIRECTORY_QUERY,
      comparedIds: ['76561197960690195'],
      playerId: '76561197960690195',
      matchesPage: 10_001,
    })).toThrow(/matches_page/i);
  });
});
