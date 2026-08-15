/*
 * Design system, layer 1 of 3 — layout.
 *
 * The bar at the top of a page, a panel or a secondary strip.
 *
 * Drawn from the design reference, where the same bar recurs at three heights:
 *   topbar  56px  「Demo 资料库 · 248 场 · 3 个监听目录 … 导入 Demo」 (02),
 *                 and the match context bar of 03 with `--color-surface-chrome`
 *   bar     46px  the filter / context strip (11, 補齊 · 比赛工作区子视图)
 *   panel   40px  panel and Inspector headers (02, 03)
 * §3.4 merges the raw 38 / 44 / 48 panel heads into `--h-panel-head`, and the
 * 50/52px filter strips into `--h-bar`; nothing here re-derives a height.
 *
 * ── The one non-negotiable rule ──────────────────────────────────────────
 * Spec §8, last line of the 1100 × 700 artboard:
 *
 *   「主动作（加入视频、用 Agent 制作视频、确认并生成视频）在任何宽度下
 *     都保持可见，不进溢出菜单。」
 *
 * That is why `primary` is a slot of its own rather than one more entry in
 * `actions`. The two are different types and travel down different code
 * paths: `actions` is data that MAY be handed to `OverflowMenu`, `primary` is
 * a node rendered directly into the bar. There is no branch in this file that
 * can put `primary` inside the menu — the contract is structural, not a rule
 * someone has to remember. `Toolbar.interaction.test.tsx` holds it down.
 */

import { t } from '@lingui/core/macro';
import type { ReactNode } from 'react';

import { useCollapsed } from './collapse';
import { cx } from './cx';
import { OverflowMenu, type OverflowMenuItem } from './OverflowMenu';

export type ToolbarHeight = 'topbar' | 'bar' | 'panel';

export type ToolbarTitleLevel = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * A secondary action. It carries both forms it can take, because the two are
 * not interchangeable: on the bar it is whatever control the page drew
 * (a button, a segmented control, a link), inside the overflow menu it is a
 * menu item with a text label.
 */
export interface ToolbarAction {
  id: string;
  /** Rendered on the bar while the action fits. */
  control: ReactNode;
  /** Rendered as the menu item once the action folds away. */
  label: ReactNode;
  onSelect?: (() => void) | undefined;
  disabled?: boolean | undefined;
}

export interface ToolbarProps {
  title?: ReactNode;
  /** Heading level of `title`. The size comes from `height`, not from this. */
  titleLevel?: ToolbarTitleLevel | undefined;
  /** The muted line beside the title — 「248 场 · 3 个监听目录」. */
  meta?: ReactNode;
  /** Anything before the title: a back link, the map plate, the scoreline. */
  leading?: ReactNode;
  /** Free-form middle content — filters, tags, a segmented control. */
  children?: ReactNode;
  /** Secondary actions. May fold into 「更多」 once collapsed. */
  actions?: readonly ToolbarAction[] | undefined;
  /** The page's main action. Never folds. Never enters the overflow menu. */
  primary?: ReactNode;
  height?: ToolbarHeight | undefined;
  /** `chrome` paints `--color-surface-chrome`, the reference's context-bar plane. */
  tone?: 'plain' | 'chrome' | undefined;
  /** Overrides the observed §8 breakpoint. */
  collapsed?: boolean | undefined;
  /** How many `actions` stay on the bar once collapsed. Default 0. */
  inlineActionsWhenCollapsed?: number | undefined;
  /** Accessible name of the overflow menu. */
  overflowLabel?: string | undefined;
  className?: string | undefined;
}

const HEIGHT_CLASS: Record<ToolbarHeight, string> = {
  topbar: 'h-[var(--h-topbar)] gap-4 px-7',
  bar: 'h-[var(--h-bar)] gap-3 px-7',
  panel: 'h-[var(--h-panel-head)] gap-3 px-5',
};

/*
 * `base.css` is unlayered on purpose, so its `h1`–`h6` rules outrank any
 * Tailwind utility no matter the specificity. The title's size is therefore
 * declared inline — still a token, never a literal.
 */
const TITLE_FONT_SIZE: Record<ToolbarHeight, string> = {
  topbar: 'var(--text-2xl)',
  bar: 'var(--text-base)',
  panel: 'var(--text-base)',
};

const TITLE_CLASS: Record<ToolbarHeight, string> = {
  topbar: 'min-w-0 truncate',
  bar: 'min-w-0 truncate font-heading tracking-wide',
  panel: 'min-w-0 truncate font-heading tracking-wide',
};

export function Toolbar({
  title,
  titleLevel = 2,
  meta,
  leading,
  children,
  actions,
  primary,
  height = 'topbar',
  tone = 'plain',
  collapsed,
  inlineActionsWhenCollapsed = 0,
  overflowLabel,
  className,
}: ToolbarProps) {
  const isCollapsed = useCollapsed(collapsed);
  const allActions = actions ?? [];
  const inlineCount = isCollapsed
    ? Math.max(0, Math.min(inlineActionsWhenCollapsed, allActions.length))
    : allActions.length;
  const inlineActions = allActions.slice(0, inlineCount);
  const foldedActions = allActions.slice(inlineCount);

  const overflowItems: OverflowMenuItem[] = foldedActions.map((action) => ({
    id: action.id,
    label: action.label,
    onSelect: action.onSelect,
    disabled: action.disabled,
  }));

  const Heading = `h${titleLevel}` as const;

  return (
    <header
      data-toolbar
      data-toolbar-height={height}
      data-collapsed={String(isCollapsed)}
      className={cx(
        'flex flex-none items-center border-b border-divider',
        HEIGHT_CLASS[height],
        tone === 'chrome' && 'bg-surface-chrome',
        className,
      )}
    >
      {leading !== undefined && leading !== null ? (
        <div data-toolbar-leading className="flex flex-none items-center gap-3">
          {leading}
        </div>
      ) : null}

      {title !== undefined && title !== null ? (
        <Heading
          data-toolbar-title
          className={TITLE_CLASS[height]}
          style={{ fontSize: TITLE_FONT_SIZE[height] }}
        >
          {title}
        </Heading>
      ) : null}

      {meta !== undefined && meta !== null ? (
        <span data-toolbar-meta className="min-w-0 truncate text-sm text-neutral-600">
          {meta}
        </span>
      ) : null}

      {children !== undefined && children !== null ? (
        <div data-toolbar-content className="flex min-w-0 items-center gap-3">
          {children}
        </div>
      ) : null}

      {/* The reference draws the gap as an explicit flex spacer, not as
          `justify-between`, because the left group is a variable number of
          nodes and the right group must stay flush to the edge. */}
      <div className="flex-1" aria-hidden="true" />

      {inlineActions.length > 0 ? (
        <div data-toolbar-actions className="flex flex-none items-center gap-2.5">
          {inlineActions.map((action) => (
            <span key={action.id} data-toolbar-action={action.id}>
              {action.control}
            </span>
          ))}
        </div>
      ) : null}

      <OverflowMenu
        items={overflowItems}
        label={overflowLabel ?? t`更多操作`}
        align="end"
      />

      {/* Outside the overflow branch by construction — see the header note. */}
      {primary !== undefined && primary !== null ? (
        <div data-toolbar-primary className="flex flex-none items-center gap-2.5">
          {primary}
        </div>
      ) : null}
    </header>
  );
}
