/**
 * Design system, layer 1 of 3 — the pure half of `DataTable`.
 *
 * Sorting, checkbox selection, column configuration and page slicing are plain
 * functions over plain data so they can be asserted in the `unit` project
 * (spec §6.2) without a React tree, and so a page can drive the same rules from
 * a URL or a store without re-implementing them.
 *
 * Two design-reference readings are encoded here and are easy to get backwards:
 *
 *   · Checkbox selection and the highlighted row are **different states**. In
 *     「02 Demo 资料库」three rows carry a checked box ("已选 3 场") while only
 *     one of them is painted accent-100 with an inset left edge — that one is
 *     the row the Inspector is showing. `DataTable` calls the second one the
 *     *active* row; nothing here conflates them.
 *   · Selection is capped. The same artboard writes "已选 3 场 · 上限 12 场"
 *     and 「06 玩家目录」writes "已选 2 名 · 比较上限 2 名", so a limit is part
 *     of the model rather than a page-level afterthought.
 */

/* ── sorting ─────────────────────────────────────────────────────────────── */

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  readonly columnId: string;
  readonly direction: SortDirection;
}

/**
 * The three-step cycle a sortable header runs through: unsorted → ascending →
 * descending → unsorted. Returning to unsorted matters because 「05 证据检索」
 * states its own default ordering ("排序：时间倒序"); a two-step cycle would
 * make that default unreachable once the user has touched a header.
 */
export function nextSortState(current: SortState | null, columnId: string): SortState | null {
  if (current === null || current.columnId !== columnId) return { columnId, direction: 'asc' };
  if (current.direction === 'asc') return { columnId, direction: 'desc' };
  return null;
}

/** The `aria-sort` value for a header cell. */
export function ariaSortFor(current: SortState | null, columnId: string): 'ascending' | 'descending' | 'none' {
  if (current === null || current.columnId !== columnId) return 'none';
  return current.direction === 'asc' ? 'ascending' : 'descending';
}

/* ── column configuration ────────────────────────────────────────────────── */

/** The subset of a column definition the pure layer needs. */
export interface ColumnConfigEntry {
  readonly id: string;
  /** Accessible header name, used as the dialog label when there is no override. */
  readonly headerLabel?: string | undefined;
  /** Column-configuration label; falls back to `headerLabel`, then `id`. */
  readonly configLabel?: string | undefined;
  /** `false` keeps the column out of the 列配置 dialog and always visible. */
  readonly hideable?: boolean | undefined;
}

/**
 * The columns left after the 列配置 dialog has hidden some. A column with
 * `hideable: false` survives regardless — the identity column and the row
 * action column are not offered in the dialog the reference draws (地图 /
 * 回合数 / 文件大小 / 校验值 are, 比赛 is not).
 */
export function visibleColumns<T extends ColumnConfigEntry>(
  columns: readonly T[],
  hidden: ReadonlySet<string> = new Set(),
): readonly T[] {
  return columns.filter((column) => column.hideable === false || !hidden.has(column.id));
}

/** The rows of the 列配置 dialog: every column the user is allowed to hide. */
export function columnConfigOptions<T extends ColumnConfigEntry>(
  columns: readonly T[],
  hidden: ReadonlySet<string> = new Set(),
): readonly { readonly id: string; readonly label: string; readonly visible: boolean }[] {
  return columns
    .filter((column) => column.hideable !== false)
    .map((column) => ({
      id: column.id,
      label: column.configLabel ?? column.headerLabel ?? column.id,
      visible: !hidden.has(column.id),
    }));
}

/** Flips one column's visibility, returning a new hidden set. */
export function toggleColumn(hidden: ReadonlySet<string>, columnId: string): Set<string> {
  const next = new Set(hidden);
  if (!next.delete(columnId)) next.add(columnId);
  return next;
}

/* ── selection ───────────────────────────────────────────────────────────── */

export interface SelectionOptions {
  /** "上限 12 场" / "比较上限 2 名". Omitted means uncapped. */
  readonly limit?: number | undefined;
}

/**
 * Adds or removes one row. At the cap, adding is a no-op and the *same* set
 * instance comes back, so a caller can tell "nothing happened" by identity and
 * skip a state write. Removing always works — a cap must never trap the user.
 */
export function toggleSelection(
  selected: ReadonlySet<string>,
  rowId: string,
  { limit }: SelectionOptions = {},
): Set<string> | ReadonlySet<string> {
  if (selected.has(rowId)) {
    const next = new Set(selected);
    next.delete(rowId);
    return next;
  }
  if (limit !== undefined && selected.size >= limit) return selected;
  return new Set(selected).add(rowId);
}

/**
 * Whether an unselected row's checkbox has to be disabled. Spec §8 forbids
 * hiding a blocked action: the box stays visible and disabled, and the
 * selection bar states the cap in words.
 */
export function isSelectionBlocked(
  selected: ReadonlySet<string>,
  rowId: string,
  { limit }: SelectionOptions = {},
): boolean {
  if (limit === undefined) return false;
  return !selected.has(rowId) && selected.size >= limit;
}

export type HeaderSelectionState = 'none' | 'some' | 'all';

/** Tri-state for the select-all box: unchecked, indeterminate, checked. */
export function headerSelectionState(
  rowIds: readonly string[],
  selected: ReadonlySet<string>,
): HeaderSelectionState {
  if (rowIds.length === 0) return 'none';
  const hit = rowIds.filter((id) => selected.has(id)).length;
  if (hit === 0) return 'none';
  return hit === rowIds.length ? 'all' : 'some';
}

/**
 * Select-all / clear-all over the rows currently on screen. Rows selected on
 * another page are left alone — pagination must not silently drop a selection
 * the user cannot see (spec §15.4 wants stable pages, not surprising ones).
 */
export function toggleAllSelection(rowIds: readonly string[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  if (headerSelectionState(rowIds, selected) === 'all') {
    for (const id of rowIds) next.delete(id);
    return next;
  }
  for (const id of rowIds) next.add(id);
  return next;
}

/* ── paging ──────────────────────────────────────────────────────────────── */

/**
 * Spec §15.4 asks large tables to be windowed *or* stably paged; this round
 * pages, so no virtual-scroll dependency enters the tree.
 */
export function pageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Keeps a page number inside `1..pageCount`, so a shrinking result set cannot strand the view. */
export function clampPage(page: number, total: number, pageSize: number): number {
  const last = pageCount(total, pageSize);
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(Math.trunc(page), 1), last);
}

/** The rows of one page. `page` is 1-based, matching what the bar shows. */
export function pageSlice<T>(rows: readonly T[], page: number, pageSize: number): readonly T[] {
  if (pageSize <= 0) return rows;
  const safe = clampPage(page, rows.length, pageSize);
  const start = (safe - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

export interface PageRange {
  /** 1-based index of the first row on the page; 0 when there are no rows. */
  readonly from: number;
  /** 1-based index of the last row on the page; 0 when there are no rows. */
  readonly to: number;
}

/** The "第 21–40 条" span of the current page. */
export function pageRange(total: number, page: number, pageSize: number): PageRange {
  if (total <= 0 || pageSize <= 0) return { from: 0, to: 0 };
  const safe = clampPage(page, total, pageSize);
  const from = (safe - 1) * pageSize + 1;
  return { from, to: Math.min(safe * pageSize, total) };
}
