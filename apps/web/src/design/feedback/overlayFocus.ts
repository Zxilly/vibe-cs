/*
 * Design system, layer 1 of 3 — the focus contract shared by Dialog and Drawer.
 *
 * The 「浮层与状态规范」artboard states it once for both overlays:
 *   "两者都有焦点陷阱、Esc 关闭和关闭后焦点归位。"
 * so the behaviour lives in one hook rather than being re-derived per overlay.
 *
 * The approach is the one `shared/ui/index.tsx` proved (query the container for
 * focusables on every keystroke rather than caching them, so a list that grows
 * while the overlay is open stays reachable), re-written here: the design layer
 * may not import from `shared/**`, and the old hook is deleted in phase 4.
 */

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Everything the platform can focus. `[tabindex]` is included without a value
 * filter because the container itself carries `tabindex="-1"`; the negative
 * ones are dropped below by reading `tabIndex`, which resolves the attribute
 * for us and needs no parsing.
 */
export const OVERLAY_FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]',
].join(',');

/** Focusable descendants of `container`, in document order. */
function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(OVERLAY_FOCUSABLE_SELECTOR)).filter(
    (element) => element.tabIndex >= 0 && !element.hidden && element.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * Wires an overlay's focus lifecycle and returns the ref to put on its
 * container. The container must be rendered (and therefore `open`) before the
 * effect can reach it, so callers return `null` while closed rather than
 * hiding the panel with CSS.
 *
 * On open: remembers what had focus, then moves focus to the first focusable
 * descendant, falling back to the container.
 * While open: Escape closes; Tab and Shift+Tab wrap inside the container.
 * On close: returns focus to whatever had it, if that element is still in the
 * document — the artboard's 「焦点回到触发行」.
 */
export function useOverlayFocus<T extends HTMLElement>(open: boolean, onClose: () => void): RefObject<T | null> {
  const containerRef = useRef<T | null>(null);

  // Kept in a ref so a caller passing a fresh closure every render does not
  // tear the listener down and re-run the "focus the first control" step.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (focusableWithin(container)[0] ?? container).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = focusableWithin(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      const active = document.activeElement;

      // Focus outside the container counts as "before the first" so a stray
      // click on the page behind a non-modal Drawer cannot strand the user.
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
    };
  }, [open]);

  return containerRef;
}
