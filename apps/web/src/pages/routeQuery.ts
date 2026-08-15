/*
 * pages/ — reading the §7 query parameters.
 *
 * Six of the sixteen routes carry a query that selects which face of the page
 * is shown (`?view=`, `?section=`, `?mode=`). §7 fixes the allowed values for
 * each, and every one of them has a default, because the bare path is always a
 * legal address — 「/library」 must open the table without anyone writing
 * `?view=table` first.
 *
 * That makes one rule worth stating once instead of six times: an unknown value
 * falls back to the default rather than rendering nothing. A hand-typed or
 * stale deep link is a navigation, not an error, and the shell already has a
 * 404 for addresses that really do not exist.
 *
 * Pure, so `pages/routeQuery.test.ts` covers it in the `unit` project without a
 * DOM, and so a page can read its own query in one expression.
 */

/**
 * The value if `allowed` contains it, the fallback otherwise. `null` (the
 * parameter is absent) and an unrecognised string are the same case.
 */
export function pickQueryValue<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === null) return fallback;
  return allowed.includes(value as T) ? (value as T) : fallback;
}
