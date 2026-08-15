/*
 * Domain layer, 2 of 3 — `domain/map/`: one selection behaviour for every layer.
 *
 * Three of the four layers hold objects a reader can pick, and all three have
 * to behave identically or the map becomes three widgets stacked on top of each
 * other. The shared behaviour is:
 *
 *   · the layer is one tab stop (roving `tabindex`)
 *   · arrows / Home / End move focus inside it, wrapping — the arithmetic is
 *     `rovingIndex.ts`, which is pure and exhaustively tested
 *   · Enter and Space commit, matching a `button`
 *   · focus itself does not commit: on a map, moving through objects would
 *     otherwise fire a selection per keystroke and drag the rest of the page
 *     (the tick, the round, the evidence panel) along with it
 *   · hover is tracked here and nowhere else
 *
 * Selection state is *not* held here. `selectedId` comes down as a prop and
 * `onSelect` goes back up, per the group's controlled-layer rule; the only
 * state this hook owns is `hoveredId`, which is purely visual and is the one
 * exception the task allows.
 *
 * A layer with no `onSelect` is inert: no tab stop, no role, no handlers. That
 * is the read-only map, and it must not advertise affordances it does not have.
 */

import { useCallback, useRef, useState, type KeyboardEvent, type SVGProps } from 'react';

import { nextRovingIndex, rovingTabIndex } from './rovingIndex';

export interface RovingSelectionItem {
  readonly id: string;
}

export interface RovingSelectionOptions {
  /** The controlled selection. `null` / `undefined` means nothing is selected. */
  readonly selectedId?: string | null | undefined;
  /** Omit to make the layer non-interactive. */
  readonly onSelect?: ((id: string) => void) | undefined;
}

/** The props a layer spreads onto each object's `<g>`. */
export type RovingItemProps = Pick<
  SVGProps<SVGGElement>,
  'ref' | 'role' | 'tabIndex' | 'aria-selected' | 'onKeyDown' | 'onClick' | 'onPointerEnter' | 'onPointerLeave'
>;

export interface RovingSelection {
  /** True when the layer has an `onSelect` and therefore takes focus. */
  readonly interactive: boolean;
  /** Which object the pointer is over. Visual only. */
  readonly hoveredId: string | null;
  /** Index of the selected object, `-1` when nothing is selected. */
  readonly activeIndex: number;
  itemProps(id: string, index: number): RovingItemProps;
}

export function useRovingSelection(
  items: readonly RovingSelectionItem[],
  { selectedId, onSelect }: RovingSelectionOptions,
): RovingSelection {
  const nodes = useRef(new Map<string, SVGGElement>());
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const interactive = typeof onSelect === 'function';
  const activeIndex = items.findIndex((item) => item.id === selectedId);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<SVGGElement>, id: string, index: number) => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        onSelect?.(id);
        return;
      }
      const next = nextRovingIndex(index, event.key, items.length);
      if (next === null) return;
      event.preventDefault();
      const target = items[next];
      if (!target) return;
      nodes.current.get(target.id)?.focus();
    },
    [items, onSelect],
  );

  const itemProps = useCallback(
    (id: string, index: number): RovingItemProps => {
      if (!interactive) return {};
      return {
        ref: (node: SVGGElement | null) => {
          if (node) nodes.current.set(id, node);
          else nodes.current.delete(id);
        },
        /*
         * `option`, not `button`: these are the members of a selection, one of
         * which is current, and `aria-selected` is only defined on the former.
         * The layer wraps them in a `listbox`, which is also the role whose
         * expected keyboard behaviour matches what `rovingIndex` implements.
         */
        role: 'option',
        tabIndex: rovingTabIndex(index, activeIndex),
        'aria-selected': id === selectedId,
        onKeyDown: (event: KeyboardEvent<SVGGElement>) => handleKeyDown(event, id, index),
        onClick: () => onSelect?.(id),
        onPointerEnter: () => setHoveredId(id),
        onPointerLeave: () => setHoveredId((current) => (current === id ? null : current)),
      };
    },
    [activeIndex, handleKeyDown, interactive, onSelect, selectedId],
  );

  return { interactive, hoveredId, activeIndex, itemProps };
}
