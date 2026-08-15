/**
 * Design system, layer 1 of 3 — the data-display directory.
 *
 * Pages import from here, never from the files directly, so the surface stays
 * reviewable and the §2.1 layer lint has one edge to look at.
 */

export { DataTable } from './DataTable';
export type { DataTableColumn, DataTableProps } from './DataTable';

export { EmptyState } from './EmptyState';
export type { EmptyStatePreset, EmptyStateProps, EmptyStateTone } from './EmptyState';

export { Pagination } from './Pagination';
export type { PaginationProps } from './Pagination';

export { paginationRange, paginationSlotCount } from './paginationModel';
export type { PaginationRangeOptions, PaginationSlot } from './paginationModel';

export { Skeleton, TableSkeleton } from './Skeleton';
export type { SkeletonProps, TableSkeletonProps } from './Skeleton';

export { TableCell, TableHeaderCell, TABLE_BODY_CELL_CLASS, TABLE_HEADER_CELL_CLASS } from './TableCell';
export type { TableCellAlign, TableCellEdge, TableCellProps, TableCellVariant, TableHeaderCellProps } from './TableCell';

export {
  ariaSortFor,
  clampPage,
  columnConfigOptions,
  headerSelectionState,
  isSelectionBlocked,
  nextSortState,
  pageCount,
  pageRange,
  pageSlice,
  toggleAllSelection,
  toggleColumn,
  toggleSelection,
  visibleColumns,
} from './tableModel';
export type {
  ColumnConfigEntry,
  HeaderSelectionState,
  PageRange,
  SelectionOptions,
  SortDirection,
  SortState,
} from './tableModel';
