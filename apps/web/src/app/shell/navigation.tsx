/*
 * App shell — the primary navigation table.
 *
 * Source of truth: `Frame.dc.html` in the Claude Design project
 * (f5cf6827-461a-4508-837f-4d18ba7d192f). Its `renderVals()` spells the four
 * groups out, in order, with the icon path and the badge each entry carries:
 *
 *   ''      工作台
 *   资料库   Demo 资料库 · 比赛历史 · 玩家目录 · 证据检索
 *   制作     Agent 创作 (badge) · 录制计划 · 快速合辑 · 多轨编辑
 *   交付     输出 · 任务记录 (badge)
 *   footer  设置与诊断        (drawn below a `flex:1` spacer, above a top rule)
 *
 * The destinations are spec §7's route table. Two entries there are not nav
 * entries and are reached from a page instead:
 *   · `/match/:demoId` — opened from the library; the 1100×700 artboard proves
 *     it, drawing the match workspace (crumb 「Aurora vs Meridian › 概览」)
 *     with the *library* icon lit, so the workspace lights 资料库.
 *   · `/recovery` — Frame draws no entry for it. It lights 设置与诊断, whose
 *     own label already names diagnostics.
 *
 * The 交付 group is two entries onto one route: §7 gives `/delivery` a
 * `?view=outputs|tasks` query, and Frame lists 输出 and 任务记录 separately. So
 * "which entry is current" is a function of pathname *and* query, which is why
 * matching is a function here rather than react-router's `NavLink` isActive.
 *
 * Labels are `msg` descriptors (spec §5.2) rather than `<Trans>` nodes: the
 * collapsed rail needs the same string as a flyout, as the link's accessible
 * name, and as a `title`, and a descriptor renders into all three.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import {
  Activity,
  Archive,
  Film,
  Folder,
  History,
  Home,
  Layers,
  Search,
  Settings,
  SlidersVertical,
  Sparkles,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

export type ShellNavItemId =
  | 'home'
  | 'library'
  | 'history'
  | 'players'
  | 'evidence'
  | 'agent'
  | 'recording'
  | 'montage'
  | 'editor'
  | 'outputs'
  | 'tasks'
  | 'settings';

export interface ShellNavItem {
  readonly id: ShellNavItemId;
  readonly label: MessageDescriptor;
  readonly icon: LucideIcon;
  /** What `<Link to>` receives, query included. */
  readonly to: string;
}

export interface ShellNavGroup {
  readonly id: string;
  /** Frame's first group has no heading; the other three do. */
  readonly label: MessageDescriptor | null;
  readonly items: readonly ShellNavItem[];
}

export const SHELL_NAV_GROUPS: readonly ShellNavGroup[] = [
  {
    id: 'workspace',
    label: null,
    items: [{ id: 'home', label: msg`工作台`, icon: Home, to: '/' }],
  },
  {
    id: 'library',
    label: msg`资料库`,
    items: [
      { id: 'library', label: msg`Demo 资料库`, icon: Folder, to: '/library' },
      { id: 'history', label: msg`比赛历史`, icon: History, to: '/history' },
      { id: 'players', label: msg`玩家目录`, icon: UsersRound, to: '/players' },
      { id: 'evidence', label: msg`证据检索`, icon: Search, to: '/evidence' },
    ],
  },
  {
    id: 'production',
    label: msg`制作`,
    items: [
      { id: 'agent', label: msg`Agent 创作`, icon: Sparkles, to: '/agent' },
      { id: 'recording', label: msg`录制计划`, icon: Film, to: '/recording' },
      { id: 'montage', label: msg`快速合辑`, icon: Layers, to: '/montage' },
      /* Frame's `D.cut` is lucide's `sliders-vertical` path, verbatim. */
      { id: 'editor', label: msg`多轨编辑`, icon: SlidersVertical, to: '/editor' },
    ],
  },
  {
    id: 'delivery',
    label: msg`交付`,
    items: [
      { id: 'outputs', label: msg`输出`, icon: Archive, to: '/delivery?view=outputs' },
      { id: 'tasks', label: msg`任务记录`, icon: Activity, to: '/delivery?view=tasks' },
    ],
  },
];

/** Frame pins this one to the bottom of the rail, below a `flex:1` spacer. */
export const SHELL_NAV_FOOTER_ITEM: ShellNavItem = {
  id: 'settings',
  label: msg`设置与诊断`,
  icon: Settings,
  to: '/settings',
};

/** Every entry in rail order, footer last. */
export const SHELL_NAV_ITEMS: readonly ShellNavItem[] = [
  ...SHELL_NAV_GROUPS.flatMap((group) => group.items),
  SHELL_NAV_FOOTER_ITEM,
];

/**
 * Path prefixes that light an entry. Ordered, first match wins; `/delivery` is
 * not here because it needs the query as well (see `activeNavItemId`).
 */
const PREFIX_RULES: readonly (readonly [string, ShellNavItemId])[] = [
  ['/library', 'library'],
  ['/match', 'library'],
  ['/history', 'history'],
  ['/players', 'players'],
  ['/evidence', 'evidence'],
  ['/agent', 'agent'],
  ['/recording', 'recording'],
  ['/montage', 'montage'],
  ['/editor', 'editor'],
  ['/settings', 'settings'],
  ['/recovery', 'settings'],
  /* The guide has no rail entry of its own; it lights 设置 for the same
     reason 恢复中心 does — it is reached from there and from the palette,
     and an unlit rail during a visit reads as "you are nowhere". */
  ['/guide', 'settings'],
];

/** `/library/` and `/library` are the same destination; `/` stays `/`. */
function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname === '' ? '/' : pathname;
}

/**
 * The nav entry a location belongs to, or null when the location is outside
 * the table (the command palette can reach routes the rail does not list).
 *
 * `search` is the raw `location.search`, leading `?` optional.
 */
export function activeNavItemId(pathname: string, search = ''): ShellNavItemId | null {
  const path = normalizePath(pathname);
  if (path === '/') return 'home';

  if (path === '/delivery' || path.startsWith('/delivery/')) {
    /* §7: `/delivery/task/:taskId` is the task detail, which belongs to
       任务记录 rather than to 输出. */
    if (path.startsWith('/delivery/task')) return 'tasks';
    const view = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('view');
    return view === 'tasks' ? 'tasks' : 'outputs';
  }

  for (const [prefix, id] of PREFIX_RULES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return id;
  }
  return null;
}
