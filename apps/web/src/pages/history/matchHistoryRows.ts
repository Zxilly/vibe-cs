/*
 * pages/history — the vocabulary of 「比赛历史与 Steam 下载」.
 *
 * The artboard (「补齐 · 暗色与其余页面」, the 944 × 560 panel) draws four state
 * counts as tags — 「全部 42 · 未下载 11 · 已入库 29 · 已过期 2」 — and one state
 * per row: 已入库 / 未下载 / 下载中 68% / 已过期 · Valve 不再保留. Those five
 * words are not `MatchHistoryItem.demo_status`, which is
 * `available | downloading | downloaded | failed`. Two differences matter:
 *
 *   · 已过期 is not a `demo_status` at all. Valve keeps a match's demo for a
 *     limited window; after that `available` is a lie. The DTO has no expiry
 *     field, so this module derives it from `played_at` against the retention
 *     window and marks the derivation as such — the artboard's own dimmed row
 *     ("opacity:.62", no checkbox, no action) is the shape it produces.
 *   · `failed` has no artboard state. It gets one here rather than being folded
 *     into 未下载, because 「下载失败，原因是 X」 and 「还没下载」 lead to different
 *     next actions and `last_error` carries the reason.
 *
 * Pure and copy-free — the six members are tokens, and `MatchHistoryTable`
 * spells them. `matchHistoryRows.test.ts` runs it in the `unit` project.
 */

import type { MatchHistoryItem } from '../../shared/desktop/dto';

/* ── the row state ───────────────────────────────────────────────────────── */

export const MATCH_HISTORY_STATES = [
  'downloaded',
  'downloading',
  'available',
  'failed',
  'expired',
] as const;

export type MatchHistoryState = (typeof MATCH_HISTORY_STATES)[number];

/**
 * How long Valve keeps a competitive match's demo available for download.
 *
 * **[推导]** — Valve publishes no number and the DTO has no expiry field. The
 * community-observed window has been about two weeks for years, and the
 * artboard's expired row is dated 07-20 against a 08-15 "today", i.e. 26 days
 * back, so anything under 26 is consistent with the drawing. 14 days is chosen
 * as the conservative end: over-calling expiry would grey out a row the user
 * could still have downloaded, and *that* is the failure that loses data.
 *
 * This constant is the single place to change when the service starts sending
 * the fact instead of us guessing it — which is the outcome to prefer, and is
 * reported as a contract gap.
 */
export const DEMO_RETENTION_DAYS = 14;

const MS_PER_DAY = 86_400_000;

export interface MatchHistoryStateOptions {
  /** "Now", passed in so the derivation is pure and a test can pin it. */
  readonly now: Date;
  readonly retentionDays?: number | undefined;
}

/**
 * The state one row is in.
 *
 * Order of precedence is deliberate: a demo already in the library stays 已入库
 * however old the match is, and a download in flight is reported as such rather
 * than as an expiry race. Expiry is only ever asserted about a row that is
 * merely *available* — the one case where the claim 「你现在还能下」 could be
 * wrong.
 */
export function matchHistoryState(
  item: MatchHistoryItem,
  { now, retentionDays = DEMO_RETENTION_DAYS }: MatchHistoryStateOptions,
): MatchHistoryState {
  if (item.demo_status === 'downloaded') return 'downloaded';
  if (item.demo_status === 'downloading') return 'downloading';
  if (item.demo_status === 'failed') return 'failed';
  if (isBeyondRetention(item.played_at, now, retentionDays)) return 'expired';
  return 'available';
}

function isBeyondRetention(playedAt: string | null, now: Date, retentionDays: number): boolean {
  if (playedAt === null) return false;
  const played = Date.parse(playedAt);
  if (!Number.isFinite(played)) return false;
  return now.getTime() - played > retentionDays * MS_PER_DAY;
}

/* ── the count row ───────────────────────────────────────────────────────── */

export interface MatchHistoryCounts {
  readonly total: number;
  readonly downloaded: number;
  readonly downloading: number;
  readonly available: number;
  readonly failed: number;
  readonly expired: number;
}

/**
 * The artboard's tag row. Counted over the rows on screen, and the page prints
 * the *page* count beside the server's total so the two are never confused —
 * a filter strip that counts one page and reads like a corpus total is the
 * silent-truncation bug §10.3 rules out.
 */
export function matchHistoryCounts(
  items: readonly MatchHistoryItem[],
  options: MatchHistoryStateOptions,
): MatchHistoryCounts {
  const counts = {
    total: items.length,
    downloaded: 0,
    downloading: 0,
    available: 0,
    failed: 0,
    expired: 0,
  };
  for (const item of items) {
    counts[matchHistoryState(item, options)] += 1;
  }
  return counts;
}

/* ── selection ───────────────────────────────────────────────────────────── */

/**
 * Whether a row can be queued for download. Only `available` can: a downloaded
 * demo has nothing to fetch, one in flight is already fetching, and an expired
 * one has nothing left on Valve's side. The artboard says the same thing by
 * drawing no checkbox on its expired row — this is that rule as a value, so the
 * table disables the box instead of hiding it (§8) and the reason can be shown.
 */
export function isDownloadable(state: MatchHistoryState): boolean {
  return state === 'available' || state === 'failed';
}
