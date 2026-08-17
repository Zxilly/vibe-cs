/**
 * Design system, layer 1 of 3 — class name merge.
 *
 * `cn` is shadcn/ui's helper, and it is here for the reason shadcn has it: a
 * component that takes a `className` has to let the caller *override* a class
 * it already sets, not merely append after it. Appending leaves both rules in
 * the list and hands the outcome to CSS source order, which for two utilities
 * of the same property is whichever Tailwind happened to emit last — an
 * override that works on `bg-accent` and silently fails on `bg-surface`.
 *
 * `twMerge` resolves that by property: the later class of a conflicting pair
 * wins and the earlier one is dropped. `clsx` handles the conditional forms
 * (`cond && 'class'`, arrays, objects) that the previous three-line `cx` also
 * handled.
 *
 * ── Why this is `extendTailwindMerge` and not the stock `twMerge` ──────────
 *
 * `theme.css` wipes Tailwind's stock scales (`--text-*: initial`) and declares
 * its own, so two of our steps are names stock Tailwind has never had:
 *
 *   text-2xs   11px, §3.2 step 1 — 138 uses
 *   text-md    15px, §3.2 step 5 — 6 uses
 *
 * `twMerge` classifies `text-*` by looking the value up in its font-size list
 * and falling through to *colour* when it misses. Unconfigured, `text-2xs` is
 * therefore a colour, and `cn('text-2xs', 'text-neutral-600')` drops the size —
 * a silent, theme-wide regression of exactly the kind this helper exists to
 * prevent. `tracking-caps` (§3, 32 uses) is likewise not a stock step.
 *
 * The rule for adding to the lists below: a token that shares a Tailwind
 * property prefix with a stock scale has to be declared here, or it will be
 * merged as something it is not. Sizes that are only ever read through an
 * arbitrary value (`h-[var(--h-ctl-sm)]`) need no entry — `twMerge` groups
 * those by their property already.
 */

import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

export type { ClassValue };

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      /* §3.2 type scale — the two steps whose names stock Tailwind lacks. */
      'font-size': [{ text: ['2xs', 'md'] }],
      /* §3 letter spacing — `wide` is stock, `caps` (0.16em) is ours. */
      tracking: [{ tracking: ['caps'] }],
    },
  },
});

export function cn(...values: readonly ClassValue[]): string {
  return twMerge(clsx(values));
}
