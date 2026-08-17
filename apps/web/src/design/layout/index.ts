/*
 * Design system, layer 1 of 3 — layout.
 *
 * The seven shapes every page in the design reference is built from. Pages
 * import from here, never from the files directly, so a component can be split
 * or renamed without touching call sites.
 */

export {
  Blueprint,
  BlueprintCorners,
  BLUEPRINT_LIST_GAP_CLASS,
  type BlueprintElement,
  type BlueprintProps,
} from '../Blueprint';
export {
  COLLAPSE_BREAKPOINT_PX,
  COLLAPSE_MEDIA_QUERY,
  CONTEXT_BAR_BREAKPOINT_PX,
  collapseMediaQuery,
  useBelowWidth,
  useCollapsed,
  useShellCollapsed,
} from './collapse';
export { cn, type ClassValue } from '../cn';
export { Inspector, type InspectorProps, type InspectorWidth } from './Inspector';
export { OverflowMenu, type OverflowMenuItem, type OverflowMenuProps } from './OverflowMenu';
export { Page, type PageProps } from './Page';
export { SelectionBar, type SelectionBarProps } from './SelectionBar';
export { SplitPane, type SplitPaneProps, type SplitPaneWidth } from './SplitPane';
export {
  SubNav,
  SUBNAV_DEFAULT_VISIBLE_TABS,
  splitSubNavTabs,
  type SubNavItem,
  type SubNavOrientation,
  type SubNavProps,
} from './SubNav';
export {
  Toolbar,
  type ToolbarAction,
  type ToolbarHeight,
  type ToolbarProps,
  type ToolbarTitleLevel,
} from './Toolbar';
export {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbText,
  type BreadcrumbItemProps,
  type BreadcrumbLinkProps,
  type BreadcrumbListProps,
  type BreadcrumbPageProps,
  type BreadcrumbProps,
  type BreadcrumbSeparatorProps,
  type BreadcrumbTextProps,
} from './Breadcrumb';
