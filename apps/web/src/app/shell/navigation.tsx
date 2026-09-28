/** One rail ordered by work mode. Shared routes retain the current workspace mode. */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import {
  Archive,
  Clapperboard,
  Folder,
  Home,
  Search,
  Settings,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

import { UI_TERMINOLOGY } from '../../terminology';

export type ShellNavItemId =
  | 'home'
  | 'library'
  | 'players'
  | 'evidence'
  | 'projects'
  | 'outputs'
  | 'settings';

/** The two work lenses share data and routes but expose different primary jobs. */
export type WorkspaceMode = 'edit' | 'analysis';

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
  /** The other mode's entries, drawn below the current mode's groups. */
  readonly otherMode?: true;
}

const EDIT_NAV_GROUPS: readonly ShellNavGroup[] = [
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
    ],
  },
  {
    id: 'production',
    label: msg`制作`,
    items: [
      { id: 'projects', label: UI_TERMINOLOGY.project.current, icon: Clapperboard, to: '/projects' },
    ],
  },
  {
    id: 'delivery',
    label: msg`交付`,
    items: [
      { id: 'outputs', label: UI_TERMINOLOGY.outputFile.current, icon: Archive, to: '/delivery?view=outputs' },
    ],
  },
];

const ANALYSIS_NAV_GROUPS: readonly ShellNavGroup[] = [
  {
    id: 'analysis-library',
    label: null,
    items: [{ id: 'library', label: msg`Demo 资料库`, icon: Folder, to: '/library' }],
  },
  {
    id: 'analysis-insights',
    label: msg`分析`,
    items: [
      { id: 'players', label: msg`选手目录`, icon: UsersRound, to: '/players' },
      { id: 'evidence', label: msg`证据检索`, icon: Search, to: '/evidence' },
    ],
  },
];

/** Each mode's own groups — the ones that lead the rail while it is current. */
export const SHELL_NAV_GROUPS_BY_MODE: Readonly<Record<WorkspaceMode, readonly ShellNavGroup[]>> = {
  edit: EDIT_NAV_GROUPS,
  analysis: ANALYSIS_NAV_GROUPS,
};

function withOtherMode(mode: WorkspaceMode, other: WorkspaceMode, label: MessageDescriptor): readonly ShellNavGroup[] {
  const own = SHELL_NAV_GROUPS_BY_MODE[mode];
  const shown = new Set(own.flatMap((group) => group.items.map((item) => item.id)));
  return [
    ...own,
    {
      id: `mode-${other}`,
      label,
      items: SHELL_NAV_GROUPS_BY_MODE[other]
        .flatMap((group) => group.items)
        .filter((item) => !shown.has(item.id)),
      otherMode: true,
    },
  ];
}

/*
 * Every destination stays in the rail in both modes. Switching mode reorders
 * it — the current mode's groups first, the other mode's remaining entries in
 * one group under that mode's name — so the user's map of the app survives
 * the switch.
 */
const SHELL_NAV_RAIL: Readonly<Record<WorkspaceMode, readonly ShellNavGroup[]>> = {
  edit: withOtherMode('edit', 'analysis', msg`分析`),
  analysis: withOtherMode('analysis', 'edit', msg`剪辑`),
};

export function shellNavGroups(mode: WorkspaceMode): readonly ShellNavGroup[] {
  return SHELL_NAV_RAIL[mode];
}

/** Frame pins this one to the bottom of the rail, below a `flex:1` spacer. */
export const SHELL_NAV_FOOTER_ITEM: ShellNavItem = {
  id: 'settings',
  label: msg`设置与诊断`,
  icon: Settings,
  to: '/settings',
};

/** Every entry in rail order, footer last. */
const NAV_ITEM_BY_ID = new Map(
  Object.values(SHELL_NAV_GROUPS_BY_MODE)
    .flatMap((groups) => groups.flatMap((group) => group.items))
    .map((item) => [item.id, item]),
);

export const SHELL_NAV_ITEMS: readonly ShellNavItem[] = [
  ...(['home', 'library', 'players', 'evidence', 'projects', 'outputs'] as const)
    .map((id) => NAV_ITEM_BY_ID.get(id))
    .filter((item): item is ShellNavItem => item !== undefined),
  SHELL_NAV_FOOTER_ITEM,
];

export const MODE_LANDING_PATH: Readonly<Record<WorkspaceMode, string>> = {
  edit: '/',
  analysis: '/library',
};

/**
 * Routes with one unambiguous owner switch the shell lens on deep-link entry.
 * The match workspace serves both jobs, so it keeps the lens the user is in —
 * unless a project sent them there to collect clips (`?project=`), which is
 * editing work whatever lens they left.
 */
export function workspaceModeForPath(pathname: string, search = ''): WorkspaceMode | null {
  const path = normalizePath(pathname);
  if (path === '/' || path === '/projects' || path.startsWith('/projects/') || path === '/delivery' || path.startsWith('/delivery/')) {
    return 'edit';
  }
  if (path === '/match' || path.startsWith('/match/')) {
    return new URLSearchParams(search).has('project') ? 'edit' : null;
  }
  if (path === '/players' || path.startsWith('/players/') || path === '/evidence' || path.startsWith('/evidence/')) {
    return 'analysis';
  }
  return null;
}

/**
 * Path prefixes that light an entry. Ordered, first match wins; `/delivery` is
 * not here because it needs the query as well (see `activeNavItemId`).
 */
const PREFIX_RULES: readonly (readonly [string, ShellNavItemId])[] = [
  ['/library', 'library'],
  ['/match', 'library'],
  ['/history', 'library'],
  ['/players', 'players'],
  ['/evidence', 'evidence'],
  ['/projects', 'projects'],
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
export function activeNavItemId(pathname: string): ShellNavItemId | null {
  const path = normalizePath(pathname);
  if (path === '/') return 'home';

  if (path === '/delivery' || path.startsWith('/delivery/')) {
    return 'outputs';
  }

  for (const [prefix, id] of PREFIX_RULES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return id;
  }
  return null;
}
