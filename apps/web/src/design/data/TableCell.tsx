/**
 * Design system, layer 1 of 3 — one table cell.
 *
 * Split out of `DataTable` because the reference reuses the same four cell
 * treatments in tables `DataTable` does not own (the 高级诊断 key/value table of
 * 「补齐 · 规范与状态」, the beat table of 「09 快速合辑」), and because a page
 * that hand-rolls a `<td>` is exactly how the old density debt came back.
 *
 * The four treatments, each read off the reference rather than invented:
 *
 *   text          14px, the inherited body size — 「02 Demo 资料库」比赛/地图/来源
 *   numeric       mono 13px — 日期 / 时长 / 回合 / tick / K/D / ADR, every column
 *                 the reference sets `font-family:ui-monospace` on. `tabular-nums`
 *                 is added on top so a proportional CJK fallback still lines the
 *                 digits up ("等宽数字列").
 *   meta          12px neutral-600 — the "· Aurora" team suffix, 监听中 captions
 *   numeric-meta  mono 12px neutral-600 — the 片段 index column of 「09 快速合辑」
 *
 * Padding is an edge role, not a number: the reference indents the first and
 * last cell to the page gutter (20px / 24px → `px-6`, 20.4px) and leaves the
 * middle ones on Industry's own `--space-2`.
 *
 * ── One line, always ──────────────────────────────────────────────────────
 *
 * `DataTable` pins the row to `--h-row`, so a cell that wraps does not get a
 * taller row — it gets a second line drawn over the hairline below it. Every
 * table in the reference is single-line, and 玩家目录's 档案 column was found
 * stacking 「档」 over 「案」 in exactly that way. So the nowrap is here rather
 * than at the call sites: it is a property of a cell in *this* table, not a
 * choice a column makes.
 *
 * It also fixes the sizing. `table-layout: auto` distributes width from the
 * cells' intrinsic widths, and a wrapping cell's min-content is one *word* —
 * which is one character in Chinese. Pinned to one line, min-content becomes
 * the whole label, so no column can be crushed below what it has to show, and
 * `DataTable`'s `FLEXIBLE_WIDTH` can hand the slack to the identity column
 * without starving the others.
 *
 * `truncate` already implies `white-space: nowrap`; it is the opt-in for the
 * one column that may lose characters instead of taking the width.
 */

import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';

import { cn } from '../cn';

export type TableCellVariant = 'text' | 'numeric' | 'meta' | 'numeric-meta';
export type TableCellAlign = 'start' | 'end';
export type TableCellEdge = 'none' | 'leading' | 'trailing' | 'both';

const VARIANT_CLASS: Record<TableCellVariant, string> = {
  text: 'text-base',
  numeric: 'font-mono text-sm tabular-nums',
  meta: 'text-xs text-neutral-600',
  'numeric-meta': 'font-mono text-xs tabular-nums text-neutral-600',
};

const EDGE_CLASS: Record<TableCellEdge, string> = {
  none: 'px-2',
  leading: 'pl-6 pr-2',
  trailing: 'pl-2 pr-6',
  both: 'px-6',
};

const ALIGN_CLASS: Record<TableCellAlign, string> = {
  start: 'text-left',
  end: 'text-right',
};

/**
 * The header treatment, from Industry's own `.table th`: smallest step, wide
 * tracking, upper case, muted ink, one hairline under the row.
 */
export const TABLE_HEADER_CELL_CLASS =
  'h-[var(--h-thead)] whitespace-nowrap border-b border-divider text-2xs uppercase tracking-wide text-neutral-600';

/** The body treatment: Industry's `.table td` hairline, at the §3.4 row height. */
export const TABLE_BODY_CELL_CLASS = 'whitespace-nowrap border-b border-divider/60 align-middle';

export interface TableCellOwnProps {
  readonly variant?: TableCellVariant | undefined;
  readonly align?: TableCellAlign | undefined;
  readonly edge?: TableCellEdge | undefined;
  /** Clips overflow to one line. Pass `title` too, or the text becomes unreadable. */
  readonly truncate?: boolean | undefined;
  readonly children?: ReactNode | undefined;
}

export type TableCellProps = TableCellOwnProps & Omit<TdHTMLAttributes<HTMLTableCellElement>, 'align'>;

/** A body cell. */
export function TableCell({
  variant = 'text',
  align = 'start',
  edge = 'none',
  truncate = false,
  className,
  children,
  ...rest
}: TableCellProps) {
  return (
    <td
      className={cn(
        TABLE_BODY_CELL_CLASS,
        VARIANT_CLASS[variant],
        ALIGN_CLASS[align],
        EDGE_CLASS[edge],
        truncate && 'max-w-0 truncate',
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}

export type TableHeaderCellProps = TableCellOwnProps & Omit<ThHTMLAttributes<HTMLTableCellElement>, 'align'>;

/** A header cell. `scope="col"` is the default because every table here is column-headed. */
export function TableHeaderCell({
  variant = 'text',
  align = 'start',
  edge = 'none',
  truncate = false,
  className,
  scope = 'col',
  children,
  ...rest
}: TableHeaderCellProps) {
  return (
    <th
      scope={scope}
      className={cn(
        TABLE_HEADER_CELL_CLASS,
        // The header size is its own step; a variant only decides alignment and
        // family there, so `text-*` from the body scale must not leak in.
        variant === 'numeric' || variant === 'numeric-meta' ? 'font-mono' : null,
        ALIGN_CLASS[align],
        EDGE_CLASS[edge],
        truncate && 'max-w-0 truncate',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}
