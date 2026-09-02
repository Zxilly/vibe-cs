/*
 * App shell — barrel.
 *
 * `AppShell` composes these into the frame every route renders inside:
 *
 *   WindowTitleBar   44px, full width, window controls right
 *   SideNav          216 / 56, left, in the row below the bar
 *   <Outlet/>        flex:1
 *
 * The shell's own state lives in `shellStore`; nothing here reads `uiStore`.
 */

export { FirstRunGuide, type FirstRunGuideProps } from './FirstRunGuide';
export {
  activeNavItemId,
  MODE_LANDING_PATH,
  SHELL_NAV_FOOTER_ITEM,
  SHELL_NAV_GROUPS,
  SHELL_NAV_GROUPS_BY_MODE,
  SHELL_NAV_ITEMS,
  shellNavGroups,
  workspaceModeForPath,
  type ShellNavGroup,
  type ShellNavItem,
  type ShellNavItemId,
  type WorkspaceMode,
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
  type WindowTitleBarController,
  type WindowTitleBarProps,
} from './WindowTitleBar';
export { WorkspaceModeMenu, type WorkspaceModeMenuProps } from './WorkspaceModeMenu';
export { RouteBreadcrumb, type RouteBreadcrumbProps } from './RouteBreadcrumb';
