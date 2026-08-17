/**
 * Design system, layer 1 of 3 — loading placeholders.
 *
 * 「补齐 · 规范与状态」draws the table skeleton as its own cell and annotates it
 * twice, and both annotations are load-bearing:
 *
 *   "加载中 · 表格骨架（不显示虚构百分比）"
 *   "有真实分母时才用进度条，否则只给阶段名"
 *
 * So this module has **no `progress` prop and no percentage anywhere**. There is
 * nothing to pass a fabricated number into. When a real denominator exists the
 * page reaches for `design/feedback/ProgressBar` instead; while a table is
 * loading, all that can honestly be shown is the stage name, and `stage` is the
 * only text slot here.
 *
 * The bars are the artboard's: a 12px lead-in at 40% width, then 10px rows at
 * 100 / 92 / 96 / 88 percent, all on `--color-neutral-200`. `h-3` is 10.2px and
 * `h-3.5` is 11.9px on the §3.6 spacing base, so the sizes stay tokenised.
 */

import { t } from '@lingui/core/macro';
import type { ReactNode } from 'react';

import { cn } from '../cn';

export interface SkeletonProps {
  /** Any CSS width; the artboard's rows are percentages of the pane. */
  readonly width?: string | undefined;
  readonly className?: string | undefined;
}

/** One bar. `animate-pulse` is neutralised by the reduced-motion rules in base.css. */
export function Skeleton({ width, className }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      style={width === undefined ? undefined : { width }}
      className={cn('block h-3 animate-pulse bg-neutral-200', className)}
    />
  );
}

/** The row widths of the artboard, cycled so any row count keeps the same rhythm. */
const ROW_WIDTHS = ['100%', '92%', '96%', '88%'] as const;

export interface TableSkeletonProps {
  /** Placeholder rows. The artboard draws four. */
  readonly rows?: number | undefined;
  /**
   * The stage name, e.g. 「正在解析回合」. The only text this component shows —
   * see the module note on why there is no percentage.
   */
  readonly stage?: ReactNode | undefined;
  readonly className?: string | undefined;
}

export function TableSkeleton({ rows = 4, stage, className }: TableSkeletonProps) {
  const count = Math.max(0, Math.trunc(rows));

  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t`加载中`}
      className={cn('flex flex-col gap-3 border border-divider p-4', className)}
    >
      {/* The header bar of the artboard: shorter and one step taller than a row. */}
      <Skeleton width="40%" className="h-3.5" />
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} width={ROW_WIDTHS[index % ROW_WIDTHS.length]} />
      ))}
      {stage === undefined ? null : <p className="mt-auto text-xs text-neutral-600">{stage}</p>}
    </div>
  );
}
