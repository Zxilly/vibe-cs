/*
 * Design system, layer 1 of 3 — layout.
 *
 * The vertical skeleton every page in the reference shares: a top bar, an
 * optional secondary strip, the body, and an optional bottom strip.
 *
 *   02 Demo 资料库    Toolbar(56) · filter strip(52→`--h-bar`) · table ·
 *                     SelectionBar
 *   11 输出与任务记录  Toolbar(56) · SplitPane · footer strip
 *   03 比赛工作区     Toolbar(56, chrome) · SplitPane(subnav + Inspector)
 *
 * Only the four slots and the scroll boundary live here. The page owns what
 * goes in them; this file owns the fact that the body is the only thing that
 * scrolls. `base.css` sets `overflow: hidden` on `body` — the window is the
 * viewport, so panes scroll and the document never does. A page that manages
 * its own scrolling (a split view, a virtualised table) passes `scroll={false}`
 * and takes the boundary over.
 */

import type { ReactNode } from 'react';

import { cx } from './cx';

export interface PageProps {
  /** The top bar — normally a `<Toolbar>`. */
  toolbar?: ReactNode;
  /** The secondary strip below it — filters, saved views, context tags. */
  bar?: ReactNode;
  /** The bottom strip — normally a `<SelectionBar>` or a folded `<Inspector>`. */
  footer?: ReactNode;
  children: ReactNode;
  /** Whether the body scrolls. Default true. */
  scroll?: boolean | undefined;
  className?: string | undefined;
}

export function Page({ toolbar, bar, footer, children, scroll = true, className }: PageProps) {
  return (
    <div
      data-page
      className={cx('flex h-full min-h-0 min-w-0 flex-col bg-bg text-text', className)}
    >
      {toolbar !== undefined && toolbar !== null ? (
        <div data-page-toolbar className="flex-none">
          {toolbar}
        </div>
      ) : null}
      {bar !== undefined && bar !== null ? (
        <div data-page-bar className="flex-none">
          {bar}
        </div>
      ) : null}
      <div
        data-page-body
        className={cx(
          'flex min-h-0 min-w-0 flex-1 flex-col',
          scroll ? 'overflow-auto' : 'overflow-hidden',
        )}
      >
        {children}
      </div>
      {footer !== undefined && footer !== null ? (
        <div data-page-footer className="flex-none">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
