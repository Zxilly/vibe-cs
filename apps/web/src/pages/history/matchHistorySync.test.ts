/*
 * `unit` project — 「上次同步」 derived from the rows.
 */

import { describe, expect, it } from 'vitest';

import { formatSyncedAt, latestSyncedAt } from './matchHistorySync';
import { matchHistoryItem } from './test/fixtures';

describe('latestSyncedAt', () => {
  it('is null for an empty list — the head then says nothing rather than guessing', () => {
    expect(latestSyncedAt([])).toBeNull();
  });

  it('takes the newest instant, whatever order the rows arrive in', () => {
    const at = latestSyncedAt([
      matchHistoryItem({ id: 'a', synced_at: '2026-08-15T08:40:00.000Z' }),
      matchHistoryItem({ id: 'b', synced_at: '2026-08-15T09:10:00.000Z' }),
      matchHistoryItem({ id: 'c', synced_at: '2026-08-14T23:00:00.000Z' }),
    ]);

    expect(at?.toISOString()).toBe('2026-08-15T09:10:00.000Z');
  });

  it('ignores a row whose timestamp does not parse', () => {
    const at = latestSyncedAt([
      matchHistoryItem({ id: 'a', synced_at: 'not a date' }),
      matchHistoryItem({ id: 'b', synced_at: '2026-08-15T08:40:00.000Z' }),
    ]);

    expect(at?.toISOString()).toBe('2026-08-15T08:40:00.000Z');
  });

  it('is null when no row carries a parseable one', () => {
    expect(latestSyncedAt([matchHistoryItem({ synced_at: '' })])).toBeNull();
  });
});

describe('formatSyncedAt', () => {
  it('is MM-DD HH:mm, zero-padded, in local time', () => {
    // Constructed in local time on purpose: the string is meant to be read
    // against the user's own clock.
    expect(formatSyncedAt(new Date(2026, 7, 15, 8, 40))).toBe('08-15 08:40');
    expect(formatSyncedAt(new Date(2026, 0, 3, 19, 5))).toBe('01-03 19:05');
  });
});
