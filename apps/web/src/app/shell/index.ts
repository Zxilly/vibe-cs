/*
 * App shell — barrel.
 *
 * `AppShell` composes these three into the frame every route renders inside:
 *
 *   WindowTitleBar   44px, full width, window controls right
 *   SideNav          216 / 56, left, in the row below the bar
 *   <Outlet/>        flex:1
 *   AgentRail        46 / 380, right, in the same row — it squeezes the
 *                    outlet rather than floating over it (see AgentRail.tsx)
 *
 * The shell's own state lives in `shellStore`; nothing here reads `uiStore`.
 */

export { AgentRail, type AgentRailProps } from './AgentRail';
export {
  activeNavItemId,
  SHELL_NAV_FOOTER_ITEM,
  SHELL_NAV_GROUPS,
  SHELL_NAV_ITEMS,
  type ShellNavGroup,
  type ShellNavItem,
  type ShellNavItemId,
} from './navigation';
export { SideNav, type SideNavProps } from './SideNav';
export {
  resetShellStore,
  SHELL_INITIAL_STATE,
  useShellStore,
  type ShellState,
} from './shellStore';
export {
  createWindowTitleBarController,
  WindowTitleBar,
  type DesktopWindowAdapter,
  type ShellServiceStatus,
  type WindowTitleBarController,
  type WindowTitleBarProps,
} from './WindowTitleBar';
export { RouteBreadcrumb, type RouteBreadcrumbProps } from './RouteBreadcrumb';
