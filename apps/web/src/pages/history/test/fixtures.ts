/*
 * Test fixtures for `pages/history`.
 *
 * Under `test/` so `lingui.config.ts` keeps the fixture copy out of the
 * catalogue. The five rows reproduce the artboard's own table: 已入库 / 未下载 /
 * 下载中 / 未下载 / 已过期.
 */

import type { MatchHistoryItem } from '../../../shared/desktop/dto';

/** The instant every state derivation in these tests is taken against. The
 *  artboard's own 「上次同步 08-15 08:40」. */
export const NOW = new Date('2026-08-15T08:40:00Z');

export function matchHistoryItem(overrides: Partial<MatchHistoryItem> = {}): MatchHistoryItem {
  return {
    id: 'mh-1',
    steam_id: 'STEAM_KAEL',
    match_id: 'CSGO-abcde-fghij',
    outcome_id: 'outcome-1',
    token: 1,
    map_name: 'de_mirage',
    played_at: '2026-08-14T20:11:00Z',
    score: '13 : 11',
    result: 'win',
    demo_status: 'downloaded',
    demo_id: 'aurora',
    last_error: null,
    synced_at: '2026-08-15T08:40:00Z',
    updated_at: '2026-08-15T08:40:00Z',
    ...overrides,
  };
}

/** The artboard's five rows, in its order. */
export function matchHistoryRows(): MatchHistoryItem[] {
  return [
    matchHistoryItem(),
    matchHistoryItem({
      id: 'mh-2',
      map_name: 'de_ancient',
      played_at: '2026-08-12T19:38:00Z',
      score: '13 : 9',
      demo_status: 'available',
      demo_id: null,
    }),
    matchHistoryItem({
      id: 'mh-3',
      map_name: 'de_nuke',
      played_at: '2026-08-11T21:02:00Z',
      score: '7 : 13',
      result: 'loss',
      demo_status: 'downloading',
      demo_id: null,
    }),
    matchHistoryItem({
      id: 'mh-4',
      map_name: 'de_inferno',
      played_at: '2026-08-09T18:20:00Z',
      score: '13 : 6',
      demo_status: 'available',
      demo_id: null,
    }),
    matchHistoryItem({
      id: 'mh-5',
      map_name: 'de_dust2',
      played_at: '2026-07-20T20:55:00Z',
      score: '11 : 13',
      result: 'loss',
      demo_status: 'available',
      demo_id: null,
    }),
  ];
}
