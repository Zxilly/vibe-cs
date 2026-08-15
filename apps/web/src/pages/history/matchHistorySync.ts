/*
 * pages/history — 「上次同步 08-15 08:40」, derived from the rows themselves.
 *
 * `MatchHistorySyncResult` says what one sync did; nothing on the wire says
 * when the last one happened. `MatchHistoryItem.synced_at` does, per row, so
 * the head prints the newest of them — a fact about data that is on screen
 * rather than a timestamp the page remembers locally and would keep printing
 * after a restart that fetched nothing.
 *
 * Pure and copy-free; `matchHistorySync.test.ts` runs it in the `unit` project.
 */

import type { MatchHistoryItem } from '../../shared/desktop/dto';

/**
 * The newest `synced_at` among the rows, or `null` when there are no rows or
 * none of them carries a parseable instant. `null` means 「不知道」 and the page
 * prints its subtitle instead of a made-up time.
 */
export function latestSyncedAt(items: readonly MatchHistoryItem[]): Date | null {
  let newest: number | null = null;
  for (const item of items) {
    const at = Date.parse(item.synced_at);
    if (!Number.isFinite(at)) continue;
    if (newest === null || at > newest) newest = at;
  }
  return newest === null ? null : new Date(newest);
}

/**
 * `MM-DD HH:mm`, the artboard's own spelling. Local time, because the user is
 * comparing it against "did I just press sync"; zero-padded by hand rather than
 * through `Intl`, whose short forms differ per locale and would make the head
 * jump width when the app is switched to English.
 */
export function formatSyncedAt(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
