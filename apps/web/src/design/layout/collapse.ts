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

/** Spec §8: the shell breakpoint. */
export const COLLAPSE_BREAKPOINT_PX = 1100;

export const COLLAPSE_MEDIA_QUERY = `(max-width: ${COLLAPSE_BREAKPOINT_PX}px)`;

/**
 * The second breakpoint, and the reason there has to be one.
 *
 * Crossing §8's 1100 *upward* makes the content column narrower, not wider: the
 * side nav goes 56 → 216 and the Agent rail appears at 46, so a 1101px window
 * gives a page 791px where a 1100px window gave it 996px. Anything that fitted
 * at 1100 by folding has a band just above 1100 where it is unfolded and has
 * less room than it had folded. The 「比赛工作区」 context bar is the case the
 * §9 risk-6 density review actually hit: unfolded it needs ~1300px, which the
 * shell only yields at about 1600 (1600 − 216 nav − 46 rail − 48 page padding).
 *
 * This is a component-level breakpoint, not a second shell fold — the shell
 * itself still has exactly one, and nothing here re-parents shell chrome.
 */
export const CONTEXT_BAR_BREAKPOINT_PX = 1600;

export function collapseMediaQuery(breakpointPx: number): string {
  return `(max-width: ${breakpointPx}px)`;
}

function hasMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

function readMatchesAt(breakpointPx: number): boolean {
  return hasMatchMedia() ? window.matchMedia(collapseMediaQuery(breakpointPx)).matches : false;
}

function readMatches(): boolean {
  return readMatchesAt(COLLAPSE_BREAKPOINT_PX);
}

/**
 * Static-render snapshot. `renderToStaticMarkup` has no viewport, so the
 * expanded form is the one that renders — matching the desktop window's
 * default size rather than guessing.
 */
function readStaticMatches(): boolean {
  return false;
}

function subscribeAt(breakpointPx: number, onStoreChange: () => void): () => void {
  if (!hasMatchMedia()) return () => {};
  const list = window.matchMedia(collapseMediaQuery(breakpointPx));
  list.addEventListener('change', onStoreChange);
  return () => {
    list.removeEventListener('change', onStoreChange);
  };
}

function subscribe(onStoreChange: () => void): () => void {
  return subscribeAt(COLLAPSE_BREAKPOINT_PX, onStoreChange);
}

/** True while the window is at or below the §8 breakpoint. */
export function useShellCollapsed(): boolean {
  return useSyncExternalStore(subscribe, readMatches, readStaticMatches);
}

/**
 * The same observation at any breakpoint, for a component whose own content
 * runs out of room somewhere other than 1100. `breakpointPx` must be a
 * constant — the subscription is re-made when it changes, so a value computed
 * per render would resubscribe on every render.
 */
export function useBelowWidth(breakpointPx: number): boolean {
  return useSyncExternalStore(
    (onStoreChange) => subscribeAt(breakpointPx, onStoreChange),
    () => readMatchesAt(breakpointPx),
    readStaticMatches,
  );
}

/**
 * The collapse state a folding component should use: the caller's override
 * when it gave one, the observed viewport otherwise. The hook is called
 * unconditionally either way, so the override may change between renders.
 */
export function useCollapsed(
  forced: boolean | undefined,
  breakpointPx: number = COLLAPSE_BREAKPOINT_PX,
): boolean {
  const observed = useBelowWidth(breakpointPx);
  return forced ?? observed;
}
