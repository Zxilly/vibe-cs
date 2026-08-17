/**
 * Design system, layer 1 of 3 — the table the whole product is built on.
 *
 * It carries 资料库 / 记分板 / 证据检索 / 玩家目录 / 高光 / 比赛历史 / 对位矩阵,
 * so every decision here is copied from an artboard rather than from table-
 * component habit:
 *
 *   row height        42px, `--h-row`. 「02 Demo 资料库」writes it on every `td`
 *                     and spec §3.4 calls it "设计稿明写的密度契约".
 *   header height     34px, `--h-thead`.
 *   active row        `background: var(--color-accent-100)` plus
 *                     `box-shadow: inset 2px 0 0 var(--color-accent)`, verbatim
 *                     from 资料库 / 证据检索 / 玩家目录.
 *   hover             Industry's `.table tbody tr:hover` is a 4% ink wash; the
 *                     nearest token is `--color-surface`, which also flips the
 *                     right way in dark (light: darker than the canvas, dark:
 *                     lighter). The active row keeps its accent instead.
 *   checkbox column   44px wide (`w-13` = 44.2px), gutter-indented, a 13px
 *                     square (`size-4` = 13.6px) filled accent when checked and
 *                     outlined neutral-400 when not.
 *   numeric columns   mono, via `TableCell variant="numeric"`.
 *
 * Two things the reference makes explicit and a generic table would get wrong:
 *
 *   · **The checked rows and the highlighted row are different sets.** 资料库
 *     shows three checked boxes ("已选 3 场") and exactly one accent-100 row.
 *     `selected` is the checkbox set; `activeRowId` is the Inspector's subject.
 *   · **No select-all box is drawn.** Both artboards with a checkbox column
 *     leave the header cell empty, and both cap the selection ("上限 12 场",
 *     "比较上限 2 名") — a select-all contradicts a cap. So the box appears only
 *     when `selectionLimit` is absent.
 *
 * Large tables page rather than virtualise (spec §15.4, this round): pass the
 * page's rows in and put `Pagination` in `footer`. No virtual-scroll dependency
 * enters the tree.
 *
 * The accent-100 bulk-action strip that follows a selection is
 * `design/layout/SelectionBar`, not this file; hand it to `footer`.
 */

import { t } from '@lingui/core/macro';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { useCallback, useRef } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

import { cn } from '../cn';
import { Checkbox } from '../primitives/Checkbox';
import { TableCell, TableHeaderCell, type TableCellAlign, type TableCellEdge, type TableCellVariant } from './TableCell';
import {
  ariaSortFor,
  headerSelectionState,
  isSelectionBlocked,
  nextSortState,
  toggleAllSelection,
  toggleSelection,
  visibleColumns,
  type SortState,
} from './tableModel';

/* ── column definition ───────────────────────────────────────────────────── */

export interface DataTableColumn<Row> {
  readonly id: string;
  /** Header content. Leave empty for the trailing row-action column. */
  readonly header?: ReactNode | undefined;
  /** Accessible name when `header` is empty or non-textual. */
  readonly headerLabel?: string | undefined;
  /** Label for the 列配置 dialog; falls back to `headerLabel`, then `id`. */
  readonly configLabel?: string | undefined;
  readonly cell: (row: Row) => ReactNode;
  readonly variant?: TableCellVariant | undefined;
  readonly align?: TableCellAlign | undefined;
  /** Any CSS length; lands on a `<col>` so the width survives an empty page. */
  readonly width?: string | undefined;
  readonly sortable?: boolean | undefined;
  /** `false` pins the column visible and keeps it out of 列配置. */
  readonly hideable?: boolean | undefined;
  readonly truncate?: boolean | undefined;
}

/* ── props ───────────────────────────────────────────────────────────────── */

export interface DataTableProps<Row> {
  /** Table name for assistive tech; rendered into a visually hidden `<caption>`. */
  readonly caption: ReactNode;
  readonly columns: readonly DataTableColumn<Row>[];
  readonly rows: readonly Row[];
  readonly rowId: (row: Row) => string;
  /** Row name for the checkbox's accessible label. */
  readonly rowLabel?: ((row: Row) => string) | undefined;

  /** Columns hidden by 列配置. */
  readonly hiddenColumns?: ReadonlySet<string> | undefined;

  readonly sort?: SortState | null | undefined;
  readonly onSortChange?: ((next: SortState | null) => void) | undefined;

  /** Adds the checkbox column. */
  readonly selectable?: boolean | undefined;
  readonly selected?: ReadonlySet<string> | undefined;
  readonly onSelectedChange?: ((next: Set<string>) => void) | undefined;
  /** "上限 12 场". Blocked checkboxes are disabled, never hidden (spec §8). */
  readonly selectionLimit?: number | undefined;

  /** The row the Inspector is showing: accent-100 ground, inset left edge. */
  readonly activeRowId?: string | null | undefined;
  readonly onRowActivate?: ((rowId: string, row: Row) => void) | undefined;

  /** Shown under the header when `rows` is empty — an `Empty`. */
  readonly empty?: ReactNode | undefined;
  /** Shown under the header while loading — a `TableSkeleton`. */
  readonly loading?: boolean | undefined;
  readonly skeleton?: ReactNode | undefined;

  /** Below the scroll area: `Pagination`, or `layout/SelectionBar`. */
  readonly footer?: ReactNode | undefined;

  readonly className?: string | undefined;
}

/* ── component ───────────────────────────────────────────────────────────── */

export function DataTable<Row>({
  caption,
  columns,
  rows,
  rowId,
  rowLabel,
  hiddenColumns,
  sort = null,
  onSortChange,
  selectable = false,
  selected,
  onSelectedChange,
  selectionLimit,
  activeRowId = null,
  onRowActivate,
  empty,
  loading = false,
  skeleton,
  footer,
  className,
}: DataTableProps<Row>) {
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  const shown = visibleColumns(columns, hiddenColumns);
  const selection = selected ?? EMPTY_SELECTION;
  const rowIds = rows.map(rowId);
  const headerState = headerSelectionState(rowIds, selection);
  const showSelectAll = selectable && onSelectedChange !== undefined && selectionLimit === undefined;
  const interactiveRows = onRowActivate !== undefined;
  // Roving tabindex: the body is one tab stop, arrows walk it from there.
  const tabStopId = activeRowId !== null && rowIds.includes(activeRowId) ? activeRowId : rowIds[0];

  const activateRow = useCallback(
    (id: string, row: Row) => {
      onRowActivate?.(id, row);
    },
    [onRowActivate],
  );

  const handleRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTableRowElement>, id: string, row: Row) => {
      if (event.key === 'Enter' || event.key === ' ') {
        // Space would scroll the pane; the focused row owns it instead.
        event.preventDefault();
        activateRow(id, row);
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;

      const found = bodyRef.current?.querySelectorAll<HTMLTableRowElement>('tr[data-row-id]');
      if (found === undefined || found.length === 0) return;
      event.preventDefault();
      const list = [...found];
      const index = list.indexOf(event.currentTarget);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const target =
        event.key === 'Home'
          ? list[0]
          : event.key === 'End'
            ? list[list.length - 1]
            : list[clampIndex(index + step, list.length)];
      target?.focus();
    },
    [activateRow],
  );

  const handleRowClick = useCallback(
    (event: MouseEvent<HTMLTableRowElement>, id: string, row: Row) => {
      // A row action ("工作区", "定位 · 加入视频") and the checkbox are their own
      // targets; clicking one must not also move the Inspector.
      if (event.target instanceof Element && event.target.closest('a,button,input,label,select,textarea') !== null) {
        return;
      }
      activateRow(id, row);
    },
    [activateRow],
  );

  const overlay = loading ? (skeleton ?? null) : rows.length === 0 ? (empty ?? null) : null;

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">{caption}</caption>
          <colgroup>
            {selectable ? <col className="w-13" /> : null}
            {shown.map((column) => (
              <col key={column.id} style={column.width === undefined ? undefined : { width: column.width }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-bg">
            <tr>
              {selectable ? (
                <TableHeaderCell edge="leading">
                  {showSelectAll ? (
                    <Checkbox
                      size="sm"
                      checked={headerState === 'all'}
                      indeterminate={headerState === 'some'}
                      data-select-all={headerState}
                      aria-label={t`全选本页`}
                      onChange={() => onSelectedChange?.(toggleAllSelection(rowIds, selection))}
                    />
                  ) : null}
                </TableHeaderCell>
              ) : null}
              {shown.map((column, index) => {
                const sortState = ariaSortFor(sort, column.id);
                const sortable = column.sortable === true && onSortChange !== undefined;
                return (
                  <TableHeaderCell
                    key={column.id}
                    edge={edgeOf(index, shown.length, selectable)}
                    align={column.align}
                    variant={column.variant}
                    aria-sort={column.sortable === true ? sortState : undefined}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        /* A header never breaks mid-label: `回合` wrapping to
                           two lines is a column that is too narrow, and it
                           should show as overflow rather than hide as a fold. */
                        className="inline-flex h-[var(--h-ctl-sm)] items-center gap-1 whitespace-nowrap hover:text-text"
                        onClick={() => onSortChange(nextSortState(sort, column.id))}
                      >
                        <span>{column.header ?? column.headerLabel}</span>
                        <SortIndicator state={sortState} />
                      </button>
                    ) : (
                      (column.header ?? headerFallback(column.headerLabel))
                    )}
                  </TableHeaderCell>
                );
              })}
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {rows.map((row) => {
              const id = rowId(row);
              const isActive = id === activeRowId;
              const blocked = isSelectionBlocked(selection, id, { limit: selectionLimit });
              return (
                <tr
                  key={id}
                  data-row-id={id}
                  data-active={isActive ? 'true' : undefined}
                  aria-current={isActive ? 'true' : undefined}
                  tabIndex={interactiveRows ? (id === tabStopId ? 0 : -1) : undefined}
                  onKeyDown={interactiveRows ? (event) => handleRowKeyDown(event, id, row) : undefined}
                  onClick={interactiveRows ? (event) => handleRowClick(event, id, row) : undefined}
                  className={cn(
                    'h-[var(--h-row)]',
                    isActive ? 'bg-accent-100 shadow-[inset_2px_0_0_var(--color-accent)]' : 'hover:bg-surface',
                    interactiveRows && 'cursor-pointer',
                  )}
                >
                  {selectable ? (
                    <TableCell edge="leading">
                      <Checkbox
                        size="sm"
                        checked={selection.has(id)}
                        disabled={blocked || onSelectedChange === undefined}
                        aria-label={rowLabel?.(row) ?? id}
                        onChange={() => {
                          const next = toggleSelection(selection, id, { limit: selectionLimit });
                          if (next !== selection) onSelectedChange?.(next as Set<string>);
                        }}
                      />
                    </TableCell>
                  ) : null}
                  {shown.map((column, index) => (
                    <TableCell
                      key={column.id}
                      variant={column.variant}
                      align={column.align}
                      truncate={column.truncate}
                      edge={edgeOf(index, shown.length, selectable)}
                    >
                      {column.cell(row)}
                    </TableCell>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {overlay}
      </div>
      {footer}
    </div>
  );
}

/* ── pieces ──────────────────────────────────────────────────────────────── */

const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();

/** The checkbox column already occupies the leading gutter when it is present. */
function edgeOf(index: number, length: number, selectable: boolean): TableCellEdge {
  const leading = index === 0 && !selectable;
  const trailing = index === length - 1;
  if (leading && trailing) return 'both';
  if (leading) return 'leading';
  if (trailing) return 'trailing';
  return 'none';
}

function headerFallback(headerLabel: string | undefined): ReactNode {
  if (headerLabel === undefined) return null;
  return <span className="sr-only">{headerLabel}</span>;
}

/**
 * Lucide at Industry's stroke width. The unsorted state still draws a glyph —
 * a header whose affordance only appears on hover cannot be found by keyboard.
 */
function SortIndicator({ state }: { state: 'ascending' | 'descending' | 'none' }) {
  const className = 'size-3 shrink-0';
  if (state === 'ascending') return <ChevronUp className={className} strokeWidth={1.5} aria-hidden="true" />;
  if (state === 'descending') return <ChevronDown className={className} strokeWidth={1.5} aria-hidden="true" />;
  return <ChevronsUpDown className={cn(className, 'text-neutral-500')} strokeWidth={1.5} aria-hidden="true" />;
}

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(index, 0), length - 1);
}
