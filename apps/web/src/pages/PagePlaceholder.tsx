/*
 * pages/ — what sits in a page's content area until its phase 3 owner arrives.
 *
 * The routes are live now, so every one of them has to render something a user
 * can read and act on. This is that something: `design/data/EmptyState`, whose
 * contract already forces the honest shape — a title, a description and a
 * required recovery action ("每条都带一个主要恢复动作", 「补齐 · 规范与状态」).
 *
 * It is *not* the page skeleton. Each page builds its own `Page` + `Toolbar`,
 * reads its own §7 query parameters and renders this in the body, so the phase
 * 3 owner replaces one child and keeps the frame, the title, the breadcrumb and
 * the query contract that the tests already hold down.
 *
 * The phase number is stated rather than softened into 「即将上线」: 「阶段 3c」
 * is checkable against the spec's own table, and a reader who wants to know
 * what lands here can go read it.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { EmptyState } from '../design/data';
import { RouteLink } from './RouteLink';

export interface PagePlaceholderProps {
  /** The spec §10 phase that fills this page in — `3a` … `3g`. */
  readonly phase: string;
  /** What lands here, in the spec's or the reference's own words. */
  readonly description: ReactNode;
  /** Replaces the default 「返回工作台」 recovery action. */
  readonly actions?: ReactNode | undefined;
}

export function PagePlaceholder({ phase, description, actions }: PagePlaceholderProps) {
  return (
    <EmptyState
      className="m-7"
      title={<Trans>本页在阶段 {phase} 实现</Trans>}
      description={description}
      actions={
        actions ?? (
          <RouteLink to="/">
            <Trans>返回工作台</Trans>
          </RouteLink>
        )
      }
    />
  );
}
