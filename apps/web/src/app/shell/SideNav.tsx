/*
 * App shell — the primary rail, in its two states (spec §3.5, §8 rule 1).
 *
 * Expanded (`--w-nav`, 216px) is Frame.dc.html: four groups, a 40px row per
 * entry, an 11px caps group heading, the current entry on `--color-accent-100`
 * with a 2px accent edge, and 设置与诊断 pinned to the bottom above a rule.
 *
 * Collapsed (`--w-nav-collapsed`, 56px) is the 1100×700 artboard: 34px icon
 * cells, 5px apart, the current one filled with the accent, a 6px accent
 * square in the corner of an entry that carries a badge.
 *
 * 「分组标题只在悬停展开时出现」 — the fold rule the artboard states in prose.
 * A 56px cell has no room for either the group heading or the entry label, so
 * both are carried by a flyout that opens on hover *and* on keyboard focus:
 * hover-only would put the group headings out of a keyboard user's reach,
 * which is the one thing the rule must not do. The label also stays in the DOM
 * as `sr-only`, so the link keeps its accessible name whether the flyout is
 * open or not.
 *
 * Two inputs decide the state, and they are not the same thing:
 *   · the user's own preference, persisted in `shellStore`
 *   · the §8 breakpoint — at ≤1100px the rail is an icon rail whatever the
 *     preference says, so the toggle is disabled *with its reason written out*
 *     rather than hidden (the 「本地服务离线」 artboard's degradation rule,
 *     applied to a layout constraint).
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { useShellCollapsed } from '../../design/layout';
import { Button, cn } from '../../design/primitives';
import {
  activeNavItemId,
  SHELL_NAV_FOOTER_ITEM,
  SHELL_NAV_GROUPS,
  type ShellNavItem,
  type ShellNavItemId,
} from './navigation';
import { useShellStore } from './shellStore';

export interface SideNavProps {
  /** Pins the state. Omitted, it follows the preference and the §8 breakpoint. */
  collapsed?: boolean | undefined;
  /** Replaces the store's toggle. */
  onToggleCollapsed?: (() => void) | undefined;
  /** Live counts, e.g. `{ agent: 1, tasks: 3 }` — the two badges Frame draws. */
  badges?: Readonly<Partial<Record<ShellNavItemId, number>>> | undefined;
  className?: string | undefined;
}

/* Frame: 40px rows — `--h-panel-head` — 10px inline padding, 14px text. */
const ITEM_CLASS = 'flex h-[var(--h-panel-head)] items-center gap-2.5 px-2.5 text-base';
const ITEM_IDLE_CLASS = 'text-neutral-800 hover:bg-neutral-200';
const ITEM_ACTIVE_CLASS = 'bg-accent-100 text-accent-800 shadow-[inset_2px_0_0_var(--color-accent)]';

/* The 1100×700 artboard: a 34px square — `--h-ctl-md` — per entry. */
const CELL_CLASS = 'relative grid size-[var(--h-ctl-md)] place-items-center';
const CELL_IDLE_CLASS = 'text-neutral-800 hover:bg-neutral-200';
const CELL_ACTIVE_CLASS = 'bg-accent text-bg';

const GROUP_HEADING_CLASS = 'px-2 pt-3.5 pb-1.5 font-heading text-2xs tracking-caps text-neutral-600';

const BADGE_CLASS = 'ml-auto border border-accent-300 px-1.5 text-2xs text-accent-700';

export function SideNav({ collapsed, onToggleCollapsed, badges, className }: SideNavProps) {
  const { i18n } = useLingui();
  const location = useLocation();
  const storedCollapsed = useShellStore((state) => state.navCollapsed);
  const toggleNav = useShellStore((state) => state.toggleNav);
  const viewportFolded = useShellCollapsed();
  const headingPrefix = useId();
  const [flyoutId, setFlyoutId] = useState<ShellNavItemId | null>(null);

  const isCollapsed = collapsed ?? (storedCollapsed || viewportFolded);
  const activeId = activeNavItemId(location.pathname, location.search);
  const toggle = onToggleCollapsed ?? toggleNav;

  const renderItem = (item: ShellNavItem, groupLabel: string | null) => {
    const Icon = item.icon;
    const active = item.id === activeId;
    const badge = badges?.[item.id];
    const hasBadge = badge !== undefined && badge > 0;
    const label = i18n._(item.label);

    if (!isCollapsed) {
      return (
        <li key={item.id}>
          <Link
            to={item.to}
            data-nav-item={item.id}
            aria-current={active ? 'page' : undefined}
            className={cn(ITEM_CLASS, active ? ITEM_ACTIVE_CLASS : ITEM_IDLE_CLASS)}
          >
            <Icon
              size={16}
              strokeWidth={1.5}
              aria-hidden="true"
              className={cn('flex-none', active ? undefined : 'opacity-70')}
            />
            <span className="min-w-0 truncate">{label}</span>
            {hasBadge ? <span className={BADGE_CLASS}>{badge}</span> : null}
          </Link>
        </li>
      );
    }

    return (
      <li
        key={item.id}
        className="relative"
        onPointerEnter={() => setFlyoutId(item.id)}
        onPointerLeave={() => setFlyoutId((current) => (current === item.id ? null : current))}
        onFocus={() => setFlyoutId(item.id)}
        onBlur={() => setFlyoutId((current) => (current === item.id ? null : current))}
      >
        <Link
          to={item.to}
          data-nav-item={item.id}
          aria-current={active ? 'page' : undefined}
          className={cn(CELL_CLASS, active ? CELL_ACTIVE_CLASS : CELL_IDLE_CLASS)}
        >
          <Icon size={16} strokeWidth={1.5} aria-hidden="true" className={active ? undefined : 'opacity-70'} />
          <span className="sr-only">{label}</span>
          {hasBadge ? (
            /* The 6px corner square of the artboard. `size-1.5` is 5.1px on the
               0.85× spacing base — the nearest step, and a §3-shaped value
               rather than a bare 6px. */
            <span
              aria-hidden="true"
              data-nav-badge={item.id}
              className={cn('absolute top-0.5 right-0.5 size-1.5', active ? 'bg-bg' : 'bg-accent')}
            />
          ) : null}
        </Link>
        {flyoutId === item.id ? (
          <span
            data-nav-flyout={item.id}
            aria-hidden="true"
            className={
              'absolute top-0 left-full z-30 ml-1 flex flex-col justify-center gap-0.5 whitespace-nowrap ' +
              'border border-divider bg-bg px-2.5 py-1.5 shadow-[var(--shadow-md)]'
            }
          >
            {groupLabel === null ? null : (
              <span className="font-heading text-2xs tracking-caps text-neutral-600">{groupLabel}</span>
            )}
            <span className="text-base text-text">{label}</span>
            {hasBadge ? <span className="text-2xs text-accent-700">{badge}</span> : null}
          </span>
        ) : null}
      </li>
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && flyoutId !== null) setFlyoutId(null);
  };

  return (
    <nav
      aria-label={t`主导航`}
      data-shell-nav={isCollapsed ? 'collapsed' : 'expanded'}
      onKeyDown={onKeyDown}
      className={cn(
        'flex flex-none flex-col border-r border-divider bg-surface-chrome',
        isCollapsed ? 'w-[var(--w-nav-collapsed)] items-center py-2.5' : 'w-[var(--w-nav)] py-3.5',
        className,
      )}
    >
      {isCollapsed ? (
        <ul className="flex flex-col items-center gap-1.5">
          {SHELL_NAV_GROUPS.flatMap((group) =>
            group.items.map((item) => renderItem(item, group.label === null ? null : i18n._(group.label))),
          )}
        </ul>
      ) : (
        SHELL_NAV_GROUPS.map((group) => {
          const headingId = `${headingPrefix}-${group.id}`;
          return (
            <div key={group.id} className="px-3">
              {group.label === null ? null : (
                <h2 id={headingId} className={GROUP_HEADING_CLASS}>
                  {i18n._(group.label)}
                </h2>
              )}
              <ul {...(group.label === null ? {} : { 'aria-labelledby': headingId })} className="flex flex-col">
                {group.items.map((item) => renderItem(item, null))}
              </ul>
            </div>
          );
        })
      )}

      <span className="flex-1" />

      <div
        className={cn(
          'flex w-full items-center border-t border-divider pt-1.5',
          isCollapsed ? 'flex-col gap-1.5' : 'gap-1.5 px-3',
        )}
      >
        <ul className={cn('flex', isCollapsed ? 'flex-col items-center gap-1.5' : 'min-w-0 flex-1 flex-col')}>
          {renderItem(SHELL_NAV_FOOTER_ITEM, null)}
        </ul>
        <Button
          icon
          size="sm"
          variant="ghost"
          data-nav-toggle
          disabled={viewportFolded}
          aria-label={isCollapsed ? t`展开侧栏` : t`收起侧栏`}
          {...(viewportFolded
            ? { disabledReason: t`窗口宽度不足 1100px，侧栏保持为图标条` }
            : { title: isCollapsed ? t`展开侧栏` : t`收起侧栏` })}
          onClick={toggle}
        >
          {isCollapsed ? (
            <PanelLeftOpen size={16} strokeWidth={1.5} aria-hidden="true" />
          ) : (
            <PanelLeftClose size={16} strokeWidth={1.5} aria-hidden="true" />
          )}
        </Button>
      </div>
    </nav>
  );
}
