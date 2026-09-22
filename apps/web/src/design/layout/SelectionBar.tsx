/*
 * Design system, layer 1 of 3 — layout.
 *
 * The bulk-action strip at the foot of a table.
 *
 * Reference: 02 Demo 资料库 — an accent-100 plane carrying 「已选 3 场 · 上限 12
 * 场」 in accent-800 at 14px, then the secondary actions and 「分析选中的 3 场」
 * flush right at `--h-ctl-sm`. The same strip recurs on 05 证据检索 and in the
 * 暗色 artboard.
 *
 * `--h-bar` is the minimum height. Summary and actions wrap in narrow panels,
 * keeping both the selection count and the primary action visible.
 *
 * The count is a live region. Selection changes come from clicks far away
 * (a header checkbox, shift-range, 「全选」), and a screen reader user needs to
 * hear how many rows are now in play without hunting for the strip. `<output>`
 * is `role="status"`, i.e. `aria-live="polite"` — announced at the next pause,
 * never interrupting.
 */

import type { ReactNode } from 'react';

import { cn } from '../cn';

export interface SelectionBarProps {
  /** 「已选 3 场 · 上限 12 场」 — announced whenever it changes. */
  summary: ReactNode;
  /** Secondary actions. */
  children?: ReactNode;
  /** The strip's main action, flush right. */
  primary?: ReactNode;
  className?: string | undefined;
}

export function SelectionBar({ summary, children, primary, className }: SelectionBarProps) {
  return (
    <div
      data-selection-bar
      className={cn(
        'flex min-h-[var(--h-bar)] flex-none flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-divider bg-accent-100 px-6 py-2',
        className,
      )}
    >
      <output data-selection-summary className="mr-auto text-sm font-medium text-accent-800">
        {summary}
      </output>
      {children !== undefined && children !== null ? (
        <div data-selection-actions className="flex flex-wrap items-center gap-2">
          {children}
        </div>
      ) : null}
      {primary !== undefined && primary !== null ? (
        <div data-selection-primary className="ml-auto flex flex-none items-center gap-2">
          {primary}
        </div>
      ) : null}
    </div>
  );
}
