/*
 * `unit` project — the five states of a Steam match row.
 *
 * The one worth arguing about is 已过期: it is *derived*, not sent, and getting
 * it wrong in the permissive direction only shows a row the user cannot act on,
 * while getting it wrong in the strict direction greys out a demo they could
 * still have downloaded. The tests pin the direction as well as the boundary.
 */

import { describe, expect, it } from 'vitest';

import {
  DEMO_RETENTION_DAYS,
  MATCH_HISTORY_STATES,
  isDownloadable,
  matchHistoryCounts,
  matchHistoryState,
} from './matchHistoryRows';
import { NOW, matchHistoryItem, matchHistoryRows } from './test/fixtures';

const options = { now: NOW };

describe('the state of one row', () => {
  it('reads the artboard s five rows the way the artboard labels them', () => {
    expect(matchHistoryRows().map((item) => matchHistoryState(item, options))).toEqual([
      'downloaded',
      'available',
      'downloading',
      'available',
      'expired',
    ]);
  });

  it('gives a failed download its own state rather than folding it into 未下载', () => {
    // 「还没下载」 and 「下载失败，原因是 X」 lead to different next actions.
    expect(
      matchHistoryState(matchHistoryItem({ demo_status: 'failed', demo_id: null }), options),
    ).toBe('failed');
  });

  it('never calls an already-downloaded demo expired', () => {
    const old = matchHistoryItem({ played_at: '2020-01-01T00:00:00Z', demo_status: 'downloaded' });
    expect(matchHistoryState(old, options)).toBe('downloaded');
  });

  it('never calls an in-flight download expired', () => {
    const old = matchHistoryItem({
      played_at: '2020-01-01T00:00:00Z',
      demo_status: 'downloading',
      demo_id: null,
    });
    expect(matchHistoryState(old, options)).toBe('downloading');
  });

  it('expires exactly at the retention boundary and not before', () => {
    const day = 86_400_000;
    const inside = new Date(NOW.getTime() - DEMO_RETENTION_DAYS * day + 1000).toISOString();
    const outside = new Date(NOW.getTime() - DEMO_RETENTION_DAYS * day - 1000).toISOString();
    const row = (playedAt: string) =>
      matchHistoryState(
        matchHistoryItem({ played_at: playedAt, demo_status: 'available', demo_id: null }),
        options,
      );
    expect(row(inside)).toBe('available');
    expect(row(outside)).toBe('expired');
  });

  it('does not guess an expiry it has no date for', () => {
    expect(
      matchHistoryState(
        matchHistoryItem({ played_at: null, demo_status: 'available', demo_id: null }),
        options,
      ),
    ).toBe('available');
    expect(
      matchHistoryState(
        matchHistoryItem({ played_at: 'not-a-date', demo_status: 'available', demo_id: null }),
        options,
      ),
    ).toBe('available');
  });

  it('declares every state it can return', () => {
    const seen = new Set(matchHistoryRows().map((item) => matchHistoryState(item, options)));
    for (const state of seen) expect(MATCH_HISTORY_STATES).toContain(state);
  });
});

describe('the count row', () => {
  it('is the artboard s tag row, counted over the rows on screen', () => {
    expect(matchHistoryCounts(matchHistoryRows(), options)).toEqual({
      total: 5,
      downloaded: 1,
      downloading: 1,
      available: 2,
      failed: 0,
      expired: 1,
    });
  });

  it('is all zeroes for an empty list rather than throwing', () => {
    expect(matchHistoryCounts([], options).total).toBe(0);
  });
});

describe('what can be queued', () => {
  it('is only what Valve can still serve', () => {
    expect(isDownloadable('available')).toBe(true);
    // A failed attempt is worth retrying; the other three have nothing to fetch.
    expect(isDownloadable('failed')).toBe(true);
    expect(isDownloadable('downloaded')).toBe(false);
    expect(isDownloadable('downloading')).toBe(false);
    expect(isDownloadable('expired')).toBe(false);
  });
});
