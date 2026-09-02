/**
 * Shell layer 3 — boundaries and degradation.
 *
 * RouteBoundary owns the 空 · 加载 · 错误 states of a route, plus 404.
 *
 * ── 全局提示（Toast/Notice 宿主）: 设计稿没有这个位置 ─────────────────────
 *
 * There is no global toast or notification host in this design, and its absence
 * is stated rather than merely unillustrated. 「补齐 · 规范与状态」, under
 * 「持久提示 Notice · 四态」:
 *
 *   "规则：Notice 常驻在页面里直到问题解决，不用 Toast 承载错误；
 *     每条都带一个主要恢复动作；四态都配图形，不只靠颜色区分。"
 *
 * Every message in the reference is drawn inside the surface it belongs to — the
 * offline banner under the title bar, the export failure on the delivery page,
 * the stale-proposal note in the change card. Spec §4.1 follows the same line
 * ("错误就地渲染成 Notice"). A floating host would have to invent a corner, a
 * dismissal timer and a stacking order, none of which the reference defines, so
 * none is built here. `design/feedback/Notice` is the whole story; the only
 * shell-level instance of it is `ServiceOfflineNotice`.
 */

export {
  NotFound,
  RouteBoundary,
  RouteErrorElement,
  RouteErrorState,
  RouteLoading,
  ROUTE_STATE_MIN_HEIGHT_CLASS,
  type RouteBoundaryProps,
  type RouteErrorStateProps,
  type RouteLoadingProps,
} from './RouteBoundary';
