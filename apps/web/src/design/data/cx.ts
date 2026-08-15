/**
 * Design system, layer 1 of 3 — class-name joiner.
 *
 * Local to `design/data/` on purpose: the redesign builds the design layer one
 * directory at a time, and a shared helper hoisted too early becomes a merge
 * point for four parallel branches. Fold it into a single `design/cx.ts` once
 * every directory exists.
 */

export type ClassValue = string | false | null | undefined;

/** Joins the truthy parts, so a conditional class can be written inline. */
export function cx(...parts: readonly ClassValue[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
}
