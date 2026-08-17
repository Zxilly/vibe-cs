/*
 * Design system, layer 1 of 3 — layout.
 *
 * The 「更多 ▾」 disclosure, drawn once and shared by `Toolbar` (secondary
 * actions past the fold), `SubNav` (view tabs past the fold) and the library's
 * 「地图：Mirage ▾」 filters. The design reference draws it in the 1100 × 700
 * artboard as a plain 38px-tall label in `--color-neutral-600` at the end of
 * the tab row.
 *
 * What it may never contain is the page's main action — see `Toolbar`, where
 * the `primary` slot is rendered outside this component by construction.
 *
 * ── shadcn's DropdownMenu, and the two bugs it retires ────────────────────
 *
 * The keyboard contract (↓/↑ wrapping and skipping disabled items, Home/End,
 * Esc back to the trigger, Tab closing on the way out) was hand-written, and
 * spec §6.2 tests it — so that part was already honest. Two things it could
 * not answer for:
 *
 *   · **The menu was clipped.** It was `position: absolute` inside the
 *     trigger's own box, and its two heaviest callers put it inside a bar that
 *     scrolls its overflow (`Toolbar`, `SubNav`). A menu longer than the bar
 *     was cut off at the bar's edge with no scroll of its own. Radix portals
 *     it to the body and positions it against the viewport, so it also flips
 *     and shifts near an edge instead of running off screen.
 *   · **No typeahead.** Ten folded views and no way to jump to 「阵容」 by
 *     typing it — the one menu affordance users reach for without being told.
 *
 * `align` maps onto Radix's own; the menu hangs from the trigger's start or
 * end edge as the artboard draws it.
 */

import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { cn } from '../cn';

export interface OverflowMenuItem {
  id: string;
  /** What the item reads as inside the menu. */
  label: ReactNode;
  onSelect?: (() => void) | undefined;
  disabled?: boolean | undefined;
  /** Marks the item as the current view — `SubNav` uses it. */
  current?: boolean | undefined;
}

export interface OverflowMenuProps {
  items: readonly OverflowMenuItem[];
  /** Accessible name of both the trigger and the menu it opens. */
  label: string;
  /** Trigger copy. Defaults to 「更多」. */
  triggerLabel?: ReactNode;
  /** Which edge of the trigger the menu hangs from. */
  align?: 'start' | 'end' | undefined;
  className?: string | undefined;
  triggerClassName?: string | undefined;
}

const TRIGGER_CLASS =
  'flex h-[var(--h-row-compact)] items-center gap-2 px-3 text-sm text-neutral-600 hover:text-text';

const LIST_CLASS =
  'z-30 flex min-w-[var(--w-subnav)] flex-col border border-divider bg-bg py-2 shadow-[var(--shadow-md)]';

/**
 * `data-highlighted` is Radix's own attribute for the item the keyboard or the
 * pointer is on. It replaces a `:hover` rule, which could not paint the item
 * the arrow keys had moved to.
 */
const ITEM_CLASS =
  'flex h-[var(--h-row-compact)] w-full cursor-pointer items-center gap-3 whitespace-nowrap px-4 ' +
  'text-left text-sm text-text outline-none data-[highlighted]:bg-accent-100 ' +
  'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45';

export function OverflowMenu({
  items,
  label,
  triggerLabel,
  align = 'end',
  className,
  triggerClassName,
}: OverflowMenuProps) {
  if (items.length === 0) return null;

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger
        aria-label={label}
        data-overflow-trigger
        data-overflow-menu
        className={cn(TRIGGER_CLASS, 'flex-none', className, triggerClassName)}
      >
        {triggerLabel ?? <Trans>更多</Trans>}
        <span aria-hidden="true">▾</span>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align={align}
          sideOffset={1}
          /* The hand-rolled menu wrapped at both ends and spec §6.2 tests it.
             Radix does not loop by default. */
          loop
          aria-label={label}
          data-overflow-list
          className={LIST_CLASS}
        >
          {items.map((item) => (
            <DropdownMenuPrimitive.Item
              key={item.id}
              disabled={item.disabled === true}
              aria-current={item.current === true ? 'page' : undefined}
              className={cn(ITEM_CLASS, item.current === true && 'bg-accent-100 text-accent-800')}
              onSelect={() => item.onSelect?.()}
            >
              {item.label}
            </DropdownMenuPrimitive.Item>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
