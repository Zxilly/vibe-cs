/*
 * Design system, layer 1 of 3 — the focus contract shared by the overlays.
 *
 * The 「浮层与状态规范」artboard states it once for Dialog and Drawer:
 *   "两者都有焦点陷阱、Esc 关闭和关闭后焦点归位。"
 *
 * Radix carries the trap and the Esc; what it cannot carry for these overlays
 * is the third clause, and that is what is left in this file. Everything else
 * that used to be here — a document-level keydown listener, a focusable-element
 * query re-run on every Tab — is `@radix-ui/react-focus-scope`'s job now.
 */

import { useCallback, useRef } from 'react';

/**
 * Returns focus to whatever had it before the overlay opened — the artboard's
 * 「关闭后焦点归位」 — for the overlays that are Radix dialogs.
 *
 * Radix restores focus through its own `Dialog.Trigger`, and these overlays
 * have none: `open` is a prop and the caller owns the button that set it. Its
 * modal content also `preventDefault`s the unmount autofocus unconditionally,
 * so with no trigger registered the focus simply lands on `<body>`. This hook
 * puts it back.
 *
 * The element is captured during the render that opens the overlay rather than
 * in an effect. A child's effects run before its parent's, and Radix moves
 * focus into the panel in one of them, so a parent effect would only ever see
 * the panel's own first button.
 */
export function useOverlayReturnFocus(open: boolean): (event: Event) => void {
  const restoreTo = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  if (open && !wasOpen.current) {
    restoreTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  wasOpen.current = open;

  return useCallback((event: Event) => {
    const target = restoreTo.current;
    // Still in the document: a row that closed the drawer by deleting itself
    // has nowhere to give focus back to, and Radix's fallback is right there.
    if (target === null || !document.contains(target)) return;
    event.preventDefault();
    target.focus();
  }, []);
}
