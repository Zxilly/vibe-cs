/*
 * pages/library — the card half, `?view=card`.
 *
 * 「补齐 · 暗色与其余页面」 draws it: a three-column grid, each card carrying the
 * match name and the score on one baseline, 「Mirage · 08-14 · 24 回合」 under it,
 * the status tags, and a summary line. The selected card takes the accent
 * border and the accent-100 ground the table's active row takes.
 *
 * Three of the drawn card's lines cannot be filled from `DemoSummary` and are
 * therefore absent rather than faked: 「Kael 27-14 · 7 条高光」 needs per-player
 * stats and a highlight count, and 「分析中 62%」 needs a denominator
 * `AnalysisRun` does not have (§4.3: 前端不模拟进度). What the card does show —
 * name, score, map, date, rounds, status — is on the wire.
 *
 * Density: the grid is `auto-fill` at a `--w-panel` minimum, so it is three
 * columns at 1920 and one or two at the 996px fold, and the *page body* scrolls
 * — the grid never grows its own horizontal scrollbar (§10.3: 横向滚动必须发生
 * 在容器内部).
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

import { Pagination, Skeleton } from '../../../design/data';
import { Alert } from '../../../design/feedback';
import { cn } from '../../../design/primitives';
import type { Paginated } from '../../../shared/desktop/dto';
import type { DemoSummary } from '../../../shared/desktop/viewModels';
import { DemoStatusMark } from './DemoStatusMark';
import { LibraryEmpty } from './LibraryEmpty';
import {
  formatMapName,
  formatMatchDate,
  formatRounds,
  formatScore,
  EMPTY_CELL,
} from './libraryFormat';
import { LIBRARY_PAGE_SIZE } from './libraryQuery';
import type { ReactNode } from 'react';
import { CARD_LIST_GAP_CLASS, Blueprint } from '../../../design/layout';

export interface LibraryCardsProps {
  readonly page: Paginated<DemoSummary> | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly activeDemoId: string | null;
  readonly onActivate: (demo: DemoSummary) => void;
  readonly currentPage: number;
  readonly onPageChange: (nextPage: number) => void;
  readonly filtered: boolean;
  readonly onClearFilters: () => void;
  readonly emptyActions: ReactNode;
}

export function LibraryCards({
  page,
  loading,
  error,
  onRetry,
  activeDemoId,
  onActivate,
  currentPage,
  onPageChange,
  filtered,
  onClearFilters,
  emptyActions,
}: LibraryCardsProps) {
  const rows = page?.items ?? [];
  const total = page?.total ?? 0;

  return (
    <div data-library-cards className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {error === null ? null : (
          <Alert
            className="mb-3"
            variant="danger"
            action={{ label: <Trans>重试</Trans>, onAction: onRetry }}
          >
            {error}
          </Alert>
        )}

        {loading ? (
          <div
            data-library-cards-loading
            role="region"
            aria-label={t`Demo 资料库 · 卡片视图`}
            aria-busy="true"
            className="flex flex-col gap-3"
          >
            <p role="status" className="text-xs text-neutral-600">
              <Trans>正在读取资料库</Trans>
            </p>
            <div
              aria-hidden="true"
              className={cn(
                'grid grid-cols-[repeat(auto-fill,minmax(min(100%,var(--w-panel)),1fr))]',
                CARD_LIST_GAP_CLASS,
              )}
            >
              {CARD_SKELETON_WIDTHS.map((titleWidth, index) => (
                <DemoCardSkeleton key={index} titleWidth={titleWidth} />
              ))}
            </div>
          </div>
        ) : null}

        {!loading && error === null && rows.length === 0 ? (
          <LibraryEmpty filtered={filtered} onClearFilters={onClearFilters} emptyActions={emptyActions} />
        ) : null}

        {/* The grid's accessible name is what tells a screen-reader user which
            of the two §7 views they are in; the table's equivalent is
            `DataTable`'s visually hidden `<caption>`. */}
        {loading ? null : (
          <ul
            aria-label={t`Demo 资料库 · 卡片视图`}
            className={cn('grid grid-cols-[repeat(auto-fill,minmax(min(100%,var(--w-panel)),1fr))]', CARD_LIST_GAP_CLASS)}
          >
            {rows.map((demo) => (
              <li key={demo.id}>
                <DemoCard
                  demo={demo}
                  active={demo.id === activeDemoId}
                  onActivate={() => {
                    onActivate(demo);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <Pagination
        page={currentPage}
        pageSize={LIBRARY_PAGE_SIZE}
        total={total}
        loading={loading}
        onPageChange={onPageChange}
      />
    </div>
  );
}

const CARD_SKELETON_WIDTHS = ['64%', '56%', '70%', '58%', '66%', '52%'] as const;

function DemoCardSkeleton({ titleWidth }: { titleWidth: string }) {
  return (
    <div
      data-demo-card-skeleton
      className="flex w-full flex-col gap-2.5 rounded-lg border border-divider bg-bg p-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <Skeleton width={titleWidth} className="h-4" />
        <Skeleton width="3.5rem" className="h-3.5 flex-none" />
      </div>
      <div className="flex items-center gap-2">
        <Skeleton width="74%" />
      </div>
      <div className="flex items-center gap-2 pt-0.5">
        <Skeleton width="4.5rem" className="h-5 rounded-sm" />
      </div>
    </div>
  );
}

function DemoCard({
  demo,
  active,
  onActivate,
}: {
  demo: DemoSummary;
  active: boolean;
  onActivate: () => void;
}) {
  const score = formatScore(demo);
  const mapLabel = formatMapName(demo.map_name);

  return (
    <Blueprint
      as="button"
      data-demo-card={demo.id}
      aria-current={active ? 'true' : undefined}
      aria-label={t`打开 ${demo.display_name} 的详情`}
      onClick={onActivate}
      className={cn(
        'flex w-full flex-col gap-2.5 rounded-lg border p-4 text-left transition-colors',
        active
          ? 'border-accent bg-accent-100'
          : 'border-divider bg-bg hover:border-neutral-500 hover:bg-neutral-100',
      )}
    >
      <span className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate font-heading text-base font-medium text-text" title={demo.display_name}>
          {demo.display_name}
        </span>
        <span
          className={cn(
            'flex-none font-mono text-sm font-medium tabular-nums',
            score === EMPTY_CELL ? 'text-neutral-600' : active ? 'text-accent-800' : 'text-text',
          )}
        >
          {score}
        </span>
      </span>

      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs tabular-nums text-neutral-600">
        <span className="font-medium text-neutral-700" title={demo.map_name}>{mapLabel}</span>
        <span>·</span>
        <span>{formatMatchDate(demo.match_date)}</span>
        {demo.total_rounds > 0 ? (
          <>
            <span>·</span>
            <span><Trans>{formatRounds(demo.total_rounds)} 回合</Trans></span>
          </>
        ) : null}
      </span>

      <span className="flex items-center gap-2 pt-0.5">
        <DemoStatusMark demo={demo} />
      </span>
    </Blueprint>
  );
}
