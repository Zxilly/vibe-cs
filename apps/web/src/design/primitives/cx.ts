/**
 * Design system, layer 1 of 3 — class name joiner.
 *
 * Every primitive builds its class list from a few conditional fragments. A
 * three-line helper keeps that readable without pulling in `clsx`: the
 * redesign's dependency budget (spec §1.3) is net −1 and this is not worth a
 * package.
 *
 * Falsy entries are dropped so `condition && 'class'` reads inline.
 */

export type ClassValue = string | false | null | undefined;

export function cx(...values: readonly ClassValue[]): string {
  return values.filter((value): value is string => typeof value === 'string' && value !== '').join(' ');
}
