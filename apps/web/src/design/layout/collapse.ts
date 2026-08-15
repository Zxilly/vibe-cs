/*
 * Design system, layer 1 of 3 — layout.
 *
 * The shell collapse breakpoint (spec §8).
 *
 * The three collapse rules of the 「1100 × 700 折叠规则」 artboard are not
 * expressible in CSS alone: rule 2 moves the Inspector's content into a drawer
 * and rule 3 moves the tail of the view navigation into an overflow menu. Both
 * are DOM changes — a media query can hide a node, it cannot re-parent one. So
 * the breakpoint is read in JavaScript, from the same 1100px the spec names,
 * and every component that folds takes an explicit `collapsed` prop as well so
 * a caller (and a test) can pin the state without touching the viewport.
 *
 * `max-width` is inclusive on purpose: the artboard is drawn at exactly
 * 1100 × 700 and shows the folded state, so 1100 itself must collapse.
 *
 * §8 also notes that 200% zoom needs no rule of its own — zooming shrinks the
 * CSS-pixel viewport, so 1920 @200% ≈ 960 logical px and lands here anyway.
 */

import { useSyncExternalStore } from 'react';

/** Spec §8: the single shell breakpoint. */
export const COLLAPSE_BREAKPOINT_PX = 1100;

export const COLLAPSE_MEDIA_QUERY = `(max-width: ${COLLAPSE_BREAKPOINT_PX}px)`;

function hasMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

function readMatches(): boolean {
  return hasMatchMedia() ? window.matchMedia(COLLAPSE_MEDIA_QUERY).matches : false;
}

/**
 * Static-render snapshot. `renderToStaticMarkup` has no viewport, so the
 * expanded form is the one that renders — matching the desktop window's
 * default size rather than guessing.
 */
function readStaticMatches(): boolean {
  return false;
}

function subscribe(onStoreChange: () => void): () => void {
  if (!hasMatchMedia()) return () => {};
  const list = window.matchMedia(COLLAPSE_MEDIA_QUERY);
  list.addEventListener('change', onStoreChange);
  return () => {
    list.removeEventListener('change', onStoreChange);
  };
}

/** True while the window is at or below the §8 breakpoint. */
export function useShellCollapsed(): boolean {
  return useSyncExternalStore(subscribe, readMatches, readStaticMatches);
}

/**
 * The collapse state a folding component should use: the caller's override
 * when it gave one, the observed viewport otherwise. The hook is called
 * unconditionally either way, so the override may change between renders.
 */
export function useCollapsed(forced: boolean | undefined): boolean {
  const observed = useShellCollapsed();
  return forced ?? observed;
}
