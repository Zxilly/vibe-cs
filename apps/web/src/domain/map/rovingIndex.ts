/*
 * Domain layer, 2 of 3 — `domain/map/`: keyboard movement between map objects.
 *
 * A map is a picture, but the objects on it are a list, and 简报 §15.3 requires
 * the main selections to be reachable from the keyboard. Every selectable layer
 * therefore implements the roving-tabindex pattern: the group is one tab stop,
 * and the arrow keys move within it.
 *
 * The decision of *which* item an arrow key lands on is here, as a pure
 * function, so it is exhaustible in the `unit` project and so the three layers
 * that need it cannot drift apart.
 *
 * Both axes move the same list. On a map there is no visual row or column to
 * follow — the objects are scattered — so binding ↓ to "next" and → to "next"
 * is not a compromise, it is the only definition available. Movement wraps,
 * because the alternative (stopping at the ends) leaves a keyboard user unable
 * to reach the first item from the last without counting.
 */

/** Keys this module answers to. Anything else returns `null`. */
export const ROVING_KEYS = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'] as const;

export type RovingKey = (typeof ROVING_KEYS)[number];

export function isRovingKey(key: string): key is RovingKey {
  return (ROVING_KEYS as readonly string[]).includes(key);
}

/**
 * The index a key press moves to.
 *
 * `current` may be `-1` for "nothing selected yet", in which case a forward key
 * lands on the first item and a backward key on the last — the same behaviour a
 * listbox has when it is entered from either end.
 *
 * Returns `null` when the key is not a movement key or when there is nothing to
 * move through, so the caller knows whether to call `preventDefault`.
 */
export function nextRovingIndex(current: number, key: string, count: number): number | null {
  if (!isRovingKey(key)) return null;
  if (!Number.isFinite(count) || count <= 0) return null;

  const size = Math.trunc(count);
  const position = Number.isFinite(current) ? Math.trunc(current) : -1;

  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return size - 1;
    case 'ArrowRight':
    case 'ArrowDown':
      return position < 0 ? 0 : (position + 1) % size;
    case 'ArrowLeft':
    case 'ArrowUp':
      return position < 0 ? size - 1 : (position - 1 + size) % size;
    default:
      return null;
  }
}

/**
 * Which item carries `tabindex="0"`.
 *
 * Exactly one must, or the group either swallows several tab stops or becomes
 * unreachable. The selected item wins; with nothing selected the first item
 * holds the stop, which is what makes an untouched map focusable at all.
 */
export function rovingTabIndex(index: number, activeIndex: number): 0 | -1 {
  const active = activeIndex >= 0 ? activeIndex : 0;
  return index === active ? 0 : -1;
}
