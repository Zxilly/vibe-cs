/**
 * Reads the reason a disabled control gives for being disabled.
 *
 * `Button` used to put it in the native `title`, and a long tail of tests read
 * it back from there. That attribute never showed anything on a disabled
 * button — Chromium delivers no pointer events to one — so the reason now
 * travels two ways: `aria-describedby` to an `sr-only` sentence, and a
 * `Tooltip` on a focusable wrapper. This reads the first, which is the one an
 * assertion can see without simulating a hover.
 *
 * Returns the whole sentence, 「此动作当前不可用：…」 prefix included, so callers
 * match with `toContain` rather than `toBe`.
 */
export function reasonOf(element: Element | null | undefined): string | null {
  const id = element?.getAttribute('aria-describedby');
  if (id === null || id === undefined || id === '') return null;
  return element?.ownerDocument.getElementById(id)?.textContent ?? null;
}
