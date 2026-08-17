/*
 * Design system, layer 1 of 3 — layout.
 *
 * The view navigation of a workspace, in the two forms the design reference
 * draws it.
 *
 *   rail  (03 比赛工作区, at 1920)  a 190px column — `--w-subnav`, which §3.5
 *         merges the reference's 180 / 200 / 220 / 270 into — of 38px rows
 *         (`--h-row-compact`) at 14px. The current view takes the accent-100
 *         plate with a 2px accent rule down its left edge and accent-800 text;
 *         「高光」 carries a count badge outlined in accent-300.
 *
 *   tabs  (補齊 · 壳层规格, the 1100 × 700 artboard)  the same eight views as a
 *         38px-tall row of tabs, the current one underlined by a 2px accent
 *         rule, and 「更多 ▾」 at the end holding the ones that did not fit.
 *
 * Spec §8, collapse rule 3: 「比赛工作区左侧视图导航 → 顶部标签，放不下的进
 * 『更多』」. Which of the two renders is decided by the §8 breakpoint unless
 * `orientation` pins it.
 *
 * These are navigation, not tabs in the ARIA sense — the workspace view lives
 * in the URL (spec §4.4, 「URL 是唯一真值」), so the items are links-shaped
 * buttons in a `<nav>` marked with `aria-current="page"`, not a `tablist`
 * owning panels. The distinction matters for screen readers: activating one
 * navigates, it does not reveal a panel that is already in the DOM.
 */

import { t } from '@lingui/core/macro';
import type { ReactNode } from 'react';

import { useCollapsed } from './collapse';
import { cn } from '../cn';
import { OverflowMenu, type OverflowMenuItem } from './OverflowMenu';

export interface SubNavItem {
  id: string;
  label: ReactNode;
  /** The outlined count the reference puts on 「高光 18」. */
  badge?: ReactNode;
  disabled?: boolean | undefined;
}

export type SubNavOrientation = 'rail' | 'tabs';

export interface SubNavProps {
  items: readonly SubNavItem[];
  activeId: string;
  onSelect?: ((id: string) => void) | undefined;
  /** Accessible name of the `<nav>`. */
  label: string;
  /** Pins the form. Omitted, it follows the §8 breakpoint. */
  orientation?: SubNavOrientation | undefined;
  /** Overrides the observed §8 breakpoint. */
  collapsed?: boolean | undefined;
  /** How many tabs stay on the bar before 「更多」. Default 5, per the artboard. */
  visibleTabs?: number | undefined;
  className?: string | undefined;
}

/** The 1100 × 700 artboard draws five tabs (概览 回合 玩家 对位 回放) plus 更多. */
export const SUBNAV_DEFAULT_VISIBLE_TABS = 5;

const RAIL_ITEM_CLASS =
  'flex h-[var(--h-row-compact)] w-full items-center gap-3 px-5 text-left text-base text-text disabled:opacity-45';

const RAIL_ACTIVE_CLASS = 'bg-accent-100 text-accent-800 shadow-[inset_2px_0_0_var(--color-accent)]';

const TAB_ITEM_CLASS =
  'flex h-[var(--h-row-compact)] items-center gap-2 whitespace-nowrap px-3 text-sm text-text disabled:opacity-45';

const TAB_ACTIVE_CLASS = 'text-accent-800 shadow-[inset_0_-2px_0_var(--color-accent)]';

const BADGE_CLASS = 'border border-accent-300 px-1.5 text-2xs text-accent-700';

/**
 * The visible tabs. The current view is never allowed to hide inside 「更多」 —
 * if it would fall past the cut it takes the last visible slot, so the bar
 * always says which view you are looking at.
 */
export function splitSubNavTabs(
  items: readonly SubNavItem[],
  activeId: string,
  visibleTabs: number,
): { visible: readonly SubNavItem[]; folded: readonly SubNavItem[] } {
  if (items.length <= visibleTabs) return { visible: items, folded: [] };

  const cut = Math.max(1, visibleTabs);
  const visible = items.slice(0, cut);
  const folded = items.slice(cut);
  const activeIndex = folded.findIndex((item) => item.id === activeId);
  if (activeIndex === -1) return { visible, folded };

  const promoted = folded[activeIndex];
  const demoted = visible[visible.length - 1];
  if (promoted === undefined || demoted === undefined) return { visible, folded };

  return {
    visible: [...visible.slice(0, -1), promoted],
    folded: [...folded.slice(0, activeIndex), demoted, ...folded.slice(activeIndex + 1)],
  };
}

export function SubNav({
  items,
  activeId,
  onSelect,
  label,
  orientation,
  collapsed,
  visibleTabs = SUBNAV_DEFAULT_VISIBLE_TABS,
  className,
}: SubNavProps) {
  const isCollapsed = useCollapsed(collapsed);
  const form: SubNavOrientation = orientation ?? (isCollapsed ? 'tabs' : 'rail');

  if (form === 'rail') {
    return (
      <nav
        aria-label={label}
        data-subnav="rail"
        className={cn(
          'flex w-[var(--w-subnav)] flex-none flex-col border-r border-divider py-3.5',
          className,
        )}
      >
        <ul className="flex flex-col">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                data-subnav-item={item.id}
                disabled={item.disabled === true}
                aria-current={item.id === activeId ? 'page' : undefined}
                className={cn(RAIL_ITEM_CLASS, item.id === activeId && RAIL_ACTIVE_CLASS)}
                onClick={() => onSelect?.(item.id)}
              >
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.badge !== undefined && item.badge !== null ? (
                  <span className={BADGE_CLASS}>{item.badge}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    );
  }

  const { visible, folded } = splitSubNavTabs(items, activeId, visibleTabs);
  const overflowItems: OverflowMenuItem[] = folded.map((item) => ({
    id: item.id,
    label: item.label,
    disabled: item.disabled,
    current: item.id === activeId,
    onSelect: () => onSelect?.(item.id),
  }));

  return (
    <nav
      aria-label={label}
      data-subnav="tabs"
      className={cn(
        'flex h-[var(--h-row-compact)] flex-none items-center overflow-hidden border-b border-divider px-2',
        className,
      )}
    >
      <ul className="flex min-w-0 items-center">
        {visible.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              data-subnav-item={item.id}
              disabled={item.disabled === true}
              aria-current={item.id === activeId ? 'page' : undefined}
              className={cn(TAB_ITEM_CLASS, item.id === activeId && TAB_ACTIVE_CLASS)}
              onClick={() => onSelect?.(item.id)}
            >
              <span className="truncate">{item.label}</span>
              {item.badge !== undefined && item.badge !== null ? (
                <span className={BADGE_CLASS}>{item.badge}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      <OverflowMenu items={overflowItems} label={t`更多视图`} align="start" />
    </nav>
  );
}
