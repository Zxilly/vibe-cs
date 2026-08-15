/*
 * Design system, layer 1 of 3 — layout.
 *
 * The 「更多 ▾」 disclosure, drawn once and shared by `Toolbar` (secondary
 * actions past the fold) and `SubNav` (view tabs past the fold). The design
 * reference draws it in the 1100 × 700 artboard as a plain 38px-tall label in
 * `--color-neutral-600` at the end of the tab row.
 *
 * What it may never contain is the page's main action — see `Toolbar`, where
 * the `primary` slot is rendered outside this component by construction.
 *
 * Keyboard contract (spec §6.2 makes it testable, not decorative):
 *   ↓ / ↑     move between items, wrapping, skipping disabled ones
 *   Home/End  first / last item
 *   Esc       close and return focus to the trigger
 *   Tab       close, and let focus leave naturally
 * A pointer press outside closes without moving focus.
 */

import { Trans } from '@lingui/react/macro';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { cx } from './cx';

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

const ITEM_CLASS =
  'flex h-[var(--h-row-compact)] w-full items-center gap-3 whitespace-nowrap px-4 text-left text-sm text-text hover:bg-accent-100 disabled:opacity-45';

function nextEnabledIndex(items: readonly OverflowMenuItem[], from: number, step: number): number {
  const total = items.length;
  for (let offset = 1; offset <= total; offset += 1) {
    const index = (from + step * offset + total * total) % total;
    if (items[index]?.disabled !== true) return index;
  }
  return from;
}

function firstEnabledIndex(items: readonly OverflowMenuItem[]): number {
  const index = items.findIndex((item) => item.disabled !== true);
  return index === -1 ? 0 : index;
}

function lastEnabledIndex(items: readonly OverflowMenuItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.disabled !== true) return index;
  }
  return 0;
}

export function OverflowMenu({
  items,
  label,
  triggerLabel,
  align = 'end',
  className,
  triggerClassName,
}: OverflowMenuProps) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Focus follows the active index while the menu is open, so ↓/↑ move the
  // real focus rather than only a visual highlight.
  useEffect(() => {
    if (!open) return;
    itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: Event) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  if (items.length === 0) return null;

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        close(true);
        break;
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((index) => nextEnabledIndex(items, index, 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((index) => nextEnabledIndex(items, index, -1));
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(firstEnabledIndex(items));
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(lastEnabledIndex(items));
        break;
      case 'Tab':
        close(false);
        break;
      default:
        break;
    }
  };

  return (
    <div ref={rootRef} data-overflow-menu className={cx('relative flex-none', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        data-overflow-trigger
        className={cx(TRIGGER_CLASS, triggerClassName)}
        onClick={() => {
          setActiveIndex(firstEnabledIndex(items));
          setOpen((wasOpen) => !wasOpen);
        }}
      >
        {triggerLabel ?? <Trans>更多</Trans>}
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          data-overflow-list
          className={cx(
            'absolute top-full z-30 mt-px flex min-w-[var(--w-subnav)] flex-col border border-divider bg-bg py-2 shadow-[var(--shadow-md)]',
            align === 'end' ? 'right-0' : 'left-0',
          )}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled === true}
              aria-current={item.current === true ? 'page' : undefined}
              className={cx(ITEM_CLASS, item.current === true && 'bg-accent-100 text-accent-800')}
              onClick={() => {
                item.onSelect?.();
                close(true);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
