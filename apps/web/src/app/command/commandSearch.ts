/*
 * App shell — the command palette's search, ranking and grouping.
 *
 * Pure functions over plain strings. Everything the palette does between a
 * keystroke and a rendered list is here, so spec §6.2's `unit` project can
 * pin the ranking exhaustively without rendering anything.
 *
 * THE RANKING RULES, AND WHY THEY ARE THESE
 * -----------------------------------------
 * The 壳层规格 artboard shows a two-word query (「mirage kael」) matching a
 * match row whose title contains neither word as a prefix, and it caps each
 * group at four rows. That is the whole of the observable spec, so the rest is
 * derived from what a palette has to guarantee to be trustworthy:
 *
 *   1. Every whitespace-separated term must match something (AND, not OR).
 *      「mirage kael」 must not surface every Mirage match and every Kael row —
 *      the artboard shows exactly one row per group for that query.
 *   2. A prefix beats a substring, and the title beats a keyword. Typing 「设置」
 *      must put 「设置与诊断」above a page that merely lists 设置 as an alias.
 *   3. No fuzzy / subsequence matching, and no pinyin. Both were considered and
 *      rejected: subsequence matching makes "lbr" hit 「Library」and also nine
 *      other rows, which destroys rule 2's ordering, and pinyin needs a
 *      dictionary the app does not ship. A user who types 「ziliao」gets nothing,
 *      which is honest; a user who types 「library」gets the page, because the
 *      latin alias is in `keywords`.
 *   4. Ties break by shorter title, then by registry order. Never by identity,
 *      so the list does not reshuffle between renders. A blank query is not a
 *      tie but an absence of ranking: registry order is kept exactly, because
 *      "shorter title first" is a proxy for "matched a larger share of the
 *      title", and with nothing typed there is no share to measure.
 *
 * Scores are small integers rather than a normalized 0–1: they are summed over
 * terms, and the sum is only ever compared with another sum.
 */

import { COMMAND_GROUP_ORDER, type CommandGroupId } from './commandRegistry';

/**
 * The shape the search needs. Generic over the real command type so a unit test
 * can rank plain objects and the palette can rank `ResolvedCommand`s carrying a
 * `run` closure.
 */
export interface SearchableCommand {
  readonly id: string;
  readonly group: CommandGroupId;
  readonly title: string;
  readonly keywords: readonly string[];
}

/** Rule 2, as weights. Title beats keyword; prefix beats substring. */
export const MATCH_SCORE = {
  titlePrefix: 4,
  titleSubstring: 3,
  keywordPrefix: 2,
  keywordSubstring: 1,
} as const;

/** 「每组最多 4 条」 — the 壳层规格 artboard, verbatim. */
export const DEFAULT_GROUP_LIMIT = 4;

export interface CommandGroupResult<T extends SearchableCommand> {
  readonly group: CommandGroupId;
  /** At most `limitPerGroup` rows, best first. */
  readonly commands: readonly T[];
  /** How many matched before the cap, so the UI can say what it is hiding. */
  readonly total: number;
}

export interface CommandSearchOptions {
  readonly limitPerGroup?: number | undefined;
}

/**
 * A query split into the terms every command must satisfy. Lower-cased, so all
 * matching downstream is case-insensitive; empty when the query is blank, which
 * `scoreCommand` reads as "everything matches".
 */
export function queryTerms(query: string): readonly string[] {
  const normalized = query.trim().toLowerCase();
  return normalized === '' ? [] : normalized.split(/\s+/u);
}

/**
 * How well one term matches, or null when it does not. Keywords are scanned in
 * full because a later keyword can carry the stronger match, but a keyword
 * prefix is the best a keyword can do, so the scan stops there.
 */
function scoreTerm(title: string, keywords: readonly string[], term: string): number | null {
  if (title.startsWith(term)) return MATCH_SCORE.titlePrefix;
  if (title.includes(term)) return MATCH_SCORE.titleSubstring;

  let best: number | null = null;
  for (const keyword of keywords) {
    if (keyword.startsWith(term)) return MATCH_SCORE.keywordPrefix;
    if (keyword.includes(term)) best = MATCH_SCORE.keywordSubstring;
  }
  return best;
}

/**
 * The command's score for a whole query — the sum over its terms — or null when
 * any term fails to match (rule 1). A blank query scores every command 0, which
 * leaves the registry order untouched.
 */
export function scoreCommand(command: SearchableCommand, query: string): number | null {
  const terms = queryTerms(query);
  if (terms.length === 0) return 0;

  const title = command.title.toLowerCase();
  const keywords = command.keywords.map((keyword) => keyword.toLowerCase());

  let total = 0;
  for (const term of terms) {
    const score = scoreTerm(title, keywords, term);
    if (score === null) return null;
    total += score;
  }
  return total;
}

interface Scored<T> {
  readonly command: T;
  readonly score: number;
  readonly index: number;
}

/**
 * Matching commands, grouped by `COMMAND_GROUP_ORDER` and capped per group.
 * Empty groups are dropped, so the caller renders exactly what it is given.
 *
 * Ranking is within a group, not across groups: the group order is fixed, so
 * 「回车执行首条」 always means "the first row of the first group shown" — the
 * same row the artboard highlights.
 */
export function searchCommands<T extends SearchableCommand>(
  commands: readonly T[],
  query: string,
  options: CommandSearchOptions = {},
): readonly CommandGroupResult<T>[] {
  const limit = options.limitPerGroup ?? DEFAULT_GROUP_LIMIT;
  // Rule 4: with no terms there is nothing to rank, and sorting would reorder
  // the registry for no reason the user can see.
  const ranked = queryTerms(query).length > 0;

  const scored: Scored<T>[] = [];
  commands.forEach((command, index) => {
    const score = scoreCommand(command, query);
    if (score !== null) scored.push({ command, score, index });
  });

  const results: CommandGroupResult<T>[] = [];
  for (const group of COMMAND_GROUP_ORDER) {
    const inGroup = scored.filter((entry) => entry.command.group === group);
    if (inGroup.length === 0) continue;

    if (ranked) inGroup.sort(compareScored);
    results.push({
      group,
      commands: inGroup.slice(0, Math.max(0, limit)).map((entry) => entry.command),
      total: inGroup.length,
    });
  }
  return results;
}

/** Rule 4: score desc, then shorter title, then registry order. */
function compareScored<T extends SearchableCommand>(a: Scored<T>, b: Scored<T>): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.command.title.length !== b.command.title.length) {
    return a.command.title.length - b.command.title.length;
  }
  return a.index - b.index;
}

/** The rows in render order — the index space the arrow keys move through. */
export function flattenCommandResults<T extends SearchableCommand>(
  groups: readonly CommandGroupResult<T>[],
): readonly T[] {
  return groups.flatMap((group) => group.commands);
}

/**
 * Where ↑ / ↓ lands. Wraps at both ends: the list is short and bounded by the
 * per-group cap, so wrapping is faster than making the user reverse direction.
 * Returns 0 for an empty list so the caller can stay on a plain number.
 */
export function nextSelectionIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  const from = current < 0 ? 0 : current;
  return (((from + delta) % count) + count) % count;
}

/**
 * Where TAB lands — 「TAB 切换分组」 from the artboard's hint row: the first row
 * of the next group, wrapping past the last one. With a single group it stays
 * on that group's first row, which is a no-op the user can see is a no-op.
 * Returns -1 when there is nothing to select.
 */
export function nextGroupSelectionIndex<T extends SearchableCommand>(
  groups: readonly CommandGroupResult<T>[],
  current: number,
): number {
  const offsets: number[] = [];
  let cursor = 0;
  for (const group of groups) {
    offsets.push(cursor);
    cursor += group.commands.length;
  }
  if (offsets.length === 0 || cursor === 0) return -1;

  // The group `current` sits in: the last offset at or below it.
  let currentGroup = 0;
  offsets.forEach((offset, index) => {
    if (current >= offset) currentGroup = index;
  });

  const next = (currentGroup + 1) % offsets.length;
  return offsets[next] ?? 0;
}
