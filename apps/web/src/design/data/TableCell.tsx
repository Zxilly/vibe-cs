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
 */

import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';

import { cx } from './cx';

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
  'h-[var(--h-thead)] border-b border-divider text-2xs uppercase tracking-wide text-neutral-600';

/** The body treatment: Industry's `.table td` hairline, at the §3.4 row height. */
export const TABLE_BODY_CELL_CLASS = 'border-b border-divider/60 align-middle';

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
      className={cx(
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
      className={cx(
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
