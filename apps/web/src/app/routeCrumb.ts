/*
 * App shell — the title bar's breadcrumb.
 *
 * `Frame.dc.html` passes the crumb into the shell as a string
 * (`crumb="资料库 › Aurora vs Meridian › 概览"`) and every artboard draws it in
 * the 44px bar, never inside the page. So the crumb is shell state derived from
 * the location, not something a page renders — which matters, because §2.1
 * rule 3 forbids `pages/**` from importing `app/**`, so a page could not hand
 * one up even if it wanted to.
 *
 * The table is `shell/navigation.tsx`, reused rather than restated: an entry's
 * group is the first crumb segment and its label is the second, which is
 * exactly what the reference draws for every rail destination
 * (「资料库 › Demo 资料库」). Four §7 routes are not rail entries and need the
 * leaf spelled out; they are listed below and nowhere else.
 *
 * The middle segment of the reference's three-part crumb — the match title —
 * is server data (`data/demos.ts`, phase 3b). It is deliberately absent rather
 * than faked: a crumb reading 「资料库 › 比赛工作区」 is short, whereas one
 * reading 「资料库 › 未命名比赛 › 概览」 is wrong.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

import {
  activeNavItemId,
  SHELL_NAV_GROUPS,
  SHELL_NAV_ITEMS,
  type ShellNavItemId,
} from './shell/navigation';

/**
 * A §7 destination the rail does not list. `base` names the rail entry whose
 * group (or, for the group-less footer entry, whose own label) opens the crumb;
 * `leaf` closes it. The rail entry's own label is dropped — the leaf replaces
 * it, the way 「比赛工作区」 replaces 「Demo 资料库」 in the reference.
 */
interface CrumbOverride {
  readonly pattern: RegExp;
  readonly base: ShellNavItemId;
  readonly leaf: MessageDescriptor;
}

const CRUMB_OVERRIDES: readonly CrumbOverride[] = [
  { pattern: /^\/match\/[^/]+$/u, base: 'library', leaf: msg`比赛工作区` },
  { pattern: /^\/players\/[^/]+$/u, base: 'players', leaf: msg`玩家档案` },
  { pattern: /^\/delivery\/task\/[^/]+$/u, base: 'tasks', leaf: msg`任务详情` },
  /* Frame draws no rail entry for it; `activeNavItemId` lights 设置与诊断,
     which is the group-less footer item, so that label is the head. */
  { pattern: /^\/recovery$/u, base: 'settings', leaf: msg`恢复中心` },
];

/** `/library/` and `/library` are the same destination; `/` stays `/`. */
function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname === '' ? '/' : pathname;
}

function itemLabel(id: ShellNavItemId): MessageDescriptor | null {
  return SHELL_NAV_ITEMS.find((item) => item.id === id)?.label ?? null;
}

/** The heading of the group an entry sits in, or null for 工作台 and the footer. */
function groupLabel(id: ShellNavItemId): MessageDescriptor | null {
  const group = SHELL_NAV_GROUPS.find((entry) => entry.items.some((item) => item.id === id));
  return group?.label ?? null;
}

/**
 * The crumb segments for a location, outermost first. Empty for a location
 * outside the route table — a 404 has no place in the hierarchy, and the page
 * itself already says so.
 *
 * `search` is the raw `location.search`, leading `?` optional; `/delivery`
 * needs it to tell 输出 from 任务记录.
 */
export function routeCrumb(pathname: string, search = ''): readonly MessageDescriptor[] {
  const path = normalizePath(pathname);

  const override = CRUMB_OVERRIDES.find((entry) => entry.pattern.test(path));
  if (override !== undefined) {
    const head = groupLabel(override.base) ?? itemLabel(override.base);
    return head === null ? [override.leaf] : [head, override.leaf];
  }

  const id = activeNavItemId(path, search);
  if (id === null) return [];
  const leaf = itemLabel(id);
  if (leaf === null) return [];
  const head = groupLabel(id);
  return head === null ? [leaf] : [head, leaf];
}

/** The separator the reference draws between segments. */
export const CRUMB_SEPARATOR = ' › ';
