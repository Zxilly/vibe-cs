/*
 * Design system, layer 1 of 3 — layout.
 *
 * A content column beside a fixed-width companion column.
 *
 * Reference: 11 输出与任务记录 — the output grid takes the remaining width and
 * 「任务记录」 sits in a 520px column (`--w-split`, the widest §3.5 step, drawn
 * exactly once and only here). The same shape with a narrower companion is how
 * 09 快速合辑 and 10 多轨编辑器 place their 340px clip / property panels
 * (`--w-panel`), and how the workspace places its 190px view rail
 * (`--w-subnav`, `side="start"`).
 *
 * Every width comes from the §3.5 table; there is no free-form pixel prop and
 * no drag handle. The reference draws no resizer anywhere, and the six merged
 * steps exist precisely so panel widths stay comparable across pages.
 *
 * `min-w-0` on the content column is not decoration: without it a wide table
 * or a long monospace path pushes the flex item past its basis and the
 * companion column gets squeezed off-screen.
 */

import type { ReactNode } from 'react';

import { cn } from '../cn';

export type SplitPaneWidth = 'split' | 'panel' | 'inspector' | 'inspector-wide' | 'subnav';

export interface SplitPaneProps {
  /** The content column. */
  children: ReactNode;
  /** The fixed-width companion column. */
  aside: ReactNode;
  /** Accessible name of the companion column. */
  asideLabel: string;
  asideWidth?: SplitPaneWidth | undefined;
  /** Which side the companion sits on. Default `end`. */
  asideSide?: 'start' | 'end' | undefined;
  className?: string | undefined;
}

const WIDTH_CLASS: Record<SplitPaneWidth, string> = {
  split: 'w-[var(--w-split)]',
  panel: 'w-[var(--w-panel)]',
  inspector: 'w-[var(--w-inspector)]',
  'inspector-wide': 'w-[var(--w-inspector-wide)]',
  subnav: 'w-[var(--w-subnav)]',
};

export function SplitPane({
  children,
  aside,
  asideLabel,
  asideWidth = 'split',
  asideSide = 'end',
  className,
}: SplitPaneProps) {
  const companion = (
    <aside
      aria-label={asideLabel}
      data-split-aside={asideSide}
      className={cn(
        'flex min-h-0 flex-none flex-col',
        WIDTH_CLASS[asideWidth],
        asideSide === 'end' ? 'border-l border-divider' : 'border-r border-divider',
      )}
    >
      {aside}
    </aside>
  );

  return (
    <div data-split-pane className={cn('flex min-h-0 min-w-0 flex-1', className)}>
      {asideSide === 'start' ? companion : null}
      <div data-split-content className="flex min-h-0 min-w-0 flex-1 flex-col">
        {children}
      </div>
      {asideSide === 'end' ? companion : null}
    </div>
  );
}
