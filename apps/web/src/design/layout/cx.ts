/*
 * Design system, layer 1 of 3 — layout.
 *
 * The class-name joiner the layout components share. Deliberately tiny and
 * local: `design/**` may not import another layer (spec §2.1 rule 1), and a
 * dependency is not worth adding for eight lines of string work.
 */

export type ClassValue = string | false | null | undefined;

/** Joins the truthy class names with a single space. */
export function cx(...values: readonly ClassValue[]): string {
  let joined = '';
  for (const value of values) {
    if (!value) continue;
    joined = joined === '' ? value : `${joined} ${value}`;
  }
  return joined;
}
