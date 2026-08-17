/*
 * pages/library — the table half of 「02 Demo 资料库」.
 *
 * `design/data`'s `DataTable` does the drawing; this file is the wiring plus
 * the three states the brief requires of every page:
 *
 *   loading  `TableSkeleton` — bars, no invented percentage
 *   empty    `EmptyState`, preset `no-matches` or `no-hits` depending on
 *            whether a filter is what emptied it. Both carry a real recovery
 *            action, which is why `EmptyState.actions` is a required prop.
 *   error    a `Notice` in place, with 重试 — never a Toast (「补齐 · 规范与
 *            状态」: 「不用 Toast 承载错误」)
 *
 * ## Paging, and why the footer count is not decoration
 *
 * §10.3: 「248 行资料库分页后表里 20 行且页脚印『共 248 条』」, and 「静默截断是
 * bug」. `Pagination` prints 「共 248 条 · 第 1–20 条」 off `total`, which is the
 * *server's* count, not `rows.length` — a page that printed the length of what
 * it received would say 「共 20 条」 and be exactly the silent truncation the
 * rule is about.
 *
 * The selection bar replaces the pager while rows are selected, which is what
 * the artboard draws (it shows the accent strip, not both). The count is still
 * reachable: the toolbar's meta line carries 「248 场」.
 */

import { t } from '@lingui/core/macro';
import { Plural, Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import {
  DataTable,
  EmptyState,
  Pagination,
  TableSkeleton,
  type DataTableColumn,
  type SortState,
} from '../../design/data';
import { Alert } from '../../design/feedback';
import { Button } from '../../design/primitives';
import type { Paginated } from '../../shared/desktop/dto';
import type { DemoSummary } from '../../shared/desktop/viewModels';
import { DEMO_SELECTION_LIMIT, LIBRARY_PAGE_SIZE } from './libraryQuery';

export interface LibraryTableProps {
  readonly columns: readonly DataTableColumn<DemoSummary>[];
  readonly page: Paginated<DemoSummary> | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;

  readonly hiddenColumns: ReadonlySet<string>;
  readonly sort: SortState | null;
  readonly onSortChange: (next: SortState | null) => void;

  readonly selected: ReadonlySet<string>;
  readonly onSelectedChange: (next: Set<string>) => void;

  readonly activeDemoId: string | null;
  readonly onRowActivate: (demo: DemoSummary) => void;

  readonly currentPage: number;
  readonly onPageChange: (page: number) => void;

  /** Whether a filter is what emptied the table — picks the empty state. */
  readonly filtered: boolean;
  readonly onClearFilters: () => void;
  readonly emptyActions: ReactNode;
  /** `SelectionBar`, rendered instead of the pager while rows are selected. */
  readonly selectionBar: ReactNode;
}

export function LibraryTable({
  columns,
  page,
  loading,
  error,
  onRetry,
  hiddenColumns,
  sort,
  onSortChange,
  selected,
  onSelectedChange,
  activeDemoId,
  onRowActivate,
  currentPage,
  onPageChange,
  filtered,
  onClearFilters,
  emptyActions,
  selectionBar,
}: LibraryTableProps) {
  const rows = page?.items ?? [];
  const total = page?.total ?? 0;

  return (
    <div data-library-table className="flex min-h-0 min-w-0 flex-1 flex-col">
      {error === null ? null : (
        <Alert
          className="m-4"
          variant="danger"
          action={{ label: <Trans>重试</Trans>, onAction: onRetry }}
          detail={<Trans>已导入的比赛仍在本地，重试通常就能恢复列表。</Trans>}
        >
          {error}
        </Alert>
      )}

      <DataTable<DemoSummary>
        className="min-h-0 flex-1"
        caption={<Trans>Demo 资料库 · 表格视图</Trans>}
        columns={columns}
        rows={rows}
        rowId={(demo) => demo.id}
        rowLabel={(demo) => t`选择 ${demo.display_name}`}
        hiddenColumns={hiddenColumns}
        sort={sort}
        onSortChange={onSortChange}
        selectable
        selected={selected}
        onSelectedChange={onSelectedChange}
        selectionLimit={DEMO_SELECTION_LIMIT}
        activeRowId={activeDemoId}
        onRowActivate={(_id, demo) => {
          onRowActivate(demo);
        }}
        loading={loading}
        skeleton={<TableSkeleton rows={8} stage={<Trans>正在读取资料库</Trans>} />}
        empty={
          error !== null ? null : (
            <EmptyState
              className="m-7"
              preset={filtered ? 'no-hits' : 'no-matches'}
              actions={
                filtered ? (
                  <Button size="sm" onClick={onClearFilters}>
                    <Trans>清空条件</Trans>
                  </Button>
                ) : (
                  emptyActions
                )
              }
            />
          )
        }
        footer={
          selected.size > 0 ? (
            selectionBar
          ) : (
            <Pagination
              page={currentPage}
              pageSize={LIBRARY_PAGE_SIZE}
              total={total}
              onPageChange={onPageChange}
              summary={<Plural value={total} other="共 # 条" />}
            />
          )
        }
      />
    </div>
  );
}
