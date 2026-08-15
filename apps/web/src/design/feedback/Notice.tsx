/*
 * Design system, layer 1 of 3 — Notice.
 *
 * 「浮层与状态规范」artboard, 「持久提示 Notice · 四态」, verbatim:
 *   "规则：Notice 常驻在页面里直到问题解决，不用 Toast 承载错误；
 *     每条都带一个主要恢复动作；四态都配图形，不只靠颜色区分。"
 *
 * Three of those are enforced by the API rather than left to the caller:
 *
 *   常驻            no timer, no auto-dismiss, no portal. A Notice is a block in
 *                   the page flow and disappears only when the page stops
 *                   rendering it — i.e. when the problem is gone.
 *   一个主要恢复动作  `action` is required. Spec §4.1 routes every query error
 *                   here (`throwOnError: false`, "错误就地渲染成 Notice"), so a
 *                   Notice with no way out would be the common case, not an edge.
 *   四态都配图形      each tone carries a differently *shaped* icon, not the same
 *                   glyph in four colours.
 *
 * The four samples on the artboard are drawn as a small square marker plus a
 * hue, and the reference's full-width failure notices (交付页, 工作台首页) add a
 * Lucide triangle-alert at 18px. A filled-vs-hollow square separates two groups,
 * not four states, so the icon is what carries the distinction here: circle-i,
 * circle-check, circle-alert and triangle-alert are four different outlines.
 * `danger` takes triangle-alert verbatim from the reference; `warning` keeps the
 * bare exclamation the reference draws for it, in its Lucide container.
 *
 * Colour still follows the artboard exactly: accent-100/300 for info and the
 * §3.1 `*-surface` / `*-border` / `*-text` triples for the other three.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export type NoticeTone = 'info' | 'success' | 'warning' | 'danger';

export interface NoticeAction {
  label: ReactNode;
  onAction: () => void;
  disabled?: boolean;
}

export interface NoticeProps {
  tone: NoticeTone;
  /** The one-line message. 「导出未完成：磁盘空间不足，已保留工程与素材」 */
  children: ReactNode;
  /** Optional second line: 影响范围, 释放多少空间后可继续, 等等. */
  detail?: ReactNode;
  /** Required — 每条都带一个主要恢复动作. */
  action: NoticeAction;
  /** Only for notices the user may legitimately acknowledge without acting. */
  onDismiss?: () => void;
  className?: string;
}

interface ToneStyle {
  readonly Icon: LucideIcon;
  readonly box: string;
  readonly icon: string;
  readonly body: string;
  /**
   * `alert` interrupts, `status` waits for a pause. The two states that mean
   * "something is wrong" interrupt; the two that mean "here is where things
   * stand" do not.
   */
  readonly role: 'alert' | 'status';
}

const TONE: Record<NoticeTone, ToneStyle> = {
  info: {
    Icon: Info,
    box: 'border-accent-300 bg-accent-100',
    icon: 'text-accent-700',
    body: 'text-text',
    role: 'status',
  },
  success: {
    Icon: CircleCheck,
    box: 'border-ok-border bg-ok-surface',
    icon: 'text-ok',
    body: 'text-text',
    role: 'status',
  },
  warning: {
    Icon: CircleAlert,
    box: 'border-warn-border bg-warn-surface',
    icon: 'text-warn',
    body: 'text-warn-text',
    role: 'alert',
  },
  danger: {
    Icon: TriangleAlert,
    box: 'border-fail-border bg-fail-surface',
    icon: 'text-fail',
    body: 'text-fail-text',
    role: 'alert',
  },
};

/**
 * The tone in words, for a reader who gets neither the hue nor the outline.
 * Rendered `sr-only` so the visual row stays exactly as drawn.
 */
function ToneWord({ tone }: { tone: NoticeTone }) {
  switch (tone) {
    case 'info':
      return <Trans>提示</Trans>;
    case 'success':
      return <Trans>成功</Trans>;
    case 'warning':
      return <Trans>警告</Trans>;
    case 'danger':
      return <Trans>错误</Trans>;
  }
}

export function Notice({ tone, children, detail, action, onDismiss, className = '' }: NoticeProps) {
  const style = TONE[tone];
  const { Icon } = style;

  return (
    <div
      role={style.role}
      data-tone={tone}
      // px-3 / py-2.5 resolve to 10.2 / 8.5px against `--spacing: 3.4px`, the
      // artboard's `padding:9px 11px`.
      className={`flex items-start gap-2.5 border px-3 py-2.5 text-sm ${style.box} ${style.body} ${className}`.trimEnd()}
    >
      <span className={`flex-none pt-px ${style.icon}`}>
        <Icon size={15} strokeWidth={1.5} aria-hidden />
      </span>
      <span className="sr-only">
        <ToneWord tone={tone} />
      </span>

      <div className="min-w-0 flex-1">
        <div>{children}</div>
        {detail === undefined ? null : (
          <div className="mt-1 text-xs leading-normal text-neutral-700">{detail}</div>
        )}
      </div>

      <button
        type="button"
        onClick={action.onAction}
        disabled={action.disabled ?? false}
        data-notice-action="primary"
        className="flex-none text-sm text-accent-700 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-45"
      >
        {action.label}
      </button>

      {onDismiss === undefined ? null : (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t`关闭提示`}
          className="flex-none text-neutral-600 hover:text-text"
        >
          <X size={14} strokeWidth={1.5} aria-hidden />
        </button>
      )}
    </div>
  );
}
