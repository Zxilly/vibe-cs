/*
 * pages/match — the Inspector, in the one shape all nine views share.
 *
 * 「03 比赛工作区」 draws the panel as: a head naming the selection (「选中：第 21
 * 回合」), a body of blocks, and a footer whose first row is the main action
 * (「把这个回合加入视频」) with two seconds under it (「2D 回放」「添加注释」).
 * §8 rule 2 folds all of that into a 46px summary strip plus a drawer below
 * 1100px, and `design/layout/Inspector` already implements the fold.
 *
 * This wrapper exists so the *workspace-wide* parts of that panel are written
 * once rather than nine times: the accessible name of the aside, the main
 * action and its disabled reason, and the rule that the main action stays on
 * the folded strip instead of going into the drawer (§8's non-negotiable line).
 * A view supplies the title, the summary line and the body.
 *
 * A view must not render `design/layout/Inspector` itself — the shell decides
 * where the panel sits at each width, and two views placing it differently is
 * exactly the drift this wrapper prevents.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { Inspector } from '../../design/layout';
import { Button } from '../../design/primitives';
import type { MatchVideoAction, MatchVideoSelection } from './viewContract';

export interface MatchInspectorPanelProps {
  /** The head — 「选中：第 21 回合」, 「选中：Kael」. */
  readonly title: ReactNode;
  /** The one line the folded strip shows. Falls back to `title`. */
  readonly summary?: ReactNode | undefined;
  readonly children: ReactNode;
  /** The workspace action, in the state the shell decided. */
  readonly addToVideo: MatchVideoAction;
  /** 「把这个回合加入视频」 — the wording depends on what is selected. */
  readonly addLabel?: ReactNode | undefined;
  /** What the view is proposing to add. */
  readonly selection?: MatchVideoSelection | undefined;
  /** The row of seconds under the main action. */
  readonly secondaryActions?: ReactNode | undefined;
  /** The §8 fold, as the shell observed it. */
  readonly collapsed: boolean;
}

export function MatchInspectorPanel({
  title,
  summary,
  children,
  addToVideo,
  addLabel,
  selection,
  secondaryActions,
  collapsed,
}: MatchInspectorPanelProps) {
  const label = t`选中项详情`;
  const hasSelection = selection !== undefined && Object.keys(selection).length > 0;
  const addDisabled = addToVideo.disabled || !hasSelection;
  const addDisabledReason = addToVideo.disabledReason ?? (hasSelection ? undefined : t`先选择一个回合、选手或片段`);
  const add = (
    <Button
      variant="primary"
      size={collapsed ? 'sm' : 'lg'}
      block={!collapsed}
      data-match-add-to-video=""
      disabled={addDisabled}
      {...(addDisabledReason === undefined
        ? {}
        : { disabledReason: addDisabledReason })}
      onClick={() => addToVideo.onAdd?.(selection ?? {})}
    >
      {addLabel ?? <Trans>加入作品</Trans>}
    </Button>
  );

  return (
    <Inspector
      title={title}
      label={label}
      collapsed={collapsed}
      openLabel={<Trans>详情</Trans>}
      {...(summary === undefined ? {} : { summary })}
      /* Docked, the action leads the footer and the seconds sit under it.
         Folded, the same action rides the summary strip — §8: 主动作在任何宽度
         下保持可见，不进溢出菜单 — and the seconds go into the drawer footer
         with it, where there is room for them. */
      summaryActions={add}
      footer={
        <>
          {collapsed ? null : add}
          {secondaryActions === undefined ? null : (
            <div className="flex items-center gap-2.5">{secondaryActions}</div>
          )}
        </>
      }
    >
      {children}
    </Inspector>
  );
}
