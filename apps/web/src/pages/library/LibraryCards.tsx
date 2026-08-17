/*
 * pages/library — the card half, `?view=card`.
 *
 * 「补齐 · 暗色与其余页面」 draws it: a three-column grid, each card carrying the
 * match name and the score on one baseline, 「Mirage · 08-14 · 24 回合」 under it,
 * the status tags, and a summary line. The selected card takes the accent
 * border and the accent-100 ground the table's active row takes. The artboard's
 * own caption is kept as the view's hint: 「适合几十场以内的个人资料库；大库仍
 * 建议用表格」.
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
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';

import { EmptyState, Pagination } from '../../design/data';
import { Notice, StatusDot } from '../../design/feedback';
import { Button, cn, Tag } from '../../design/primitives';
import type { Paginated } from '../../shared/desktop/dto';
import type { DemoSummary } from '../../shared/desktop/viewModels';
import {
  demoStatusMeta,
  formatMatchDate,
  formatRounds,
  formatScore,
  EMPTY_CELL,
} from './libraryFormat';
import { LIBRARY_PAGE_SIZE } from './libraryQuery';
import type { ReactNode } from 'react';

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
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <p className="mb-3 text-xs text-neutral-600">
          <Trans>适合几十场以内的个人资料库；大库仍建议用表格</Trans>
        </p>

        {error === null ? null : (
          <Notice
            className="mb-3"
            tone="danger"
            action={{ label: <Trans>重试</Trans>, onAction: onRetry }}
          >
            {error}
          </Notice>
        )}

        {loading ? (
          <p className="text-sm text-neutral-600">
            <Trans>正在读取资料库</Trans>
          </p>
        ) : null}

        {!loading && error === null && rows.length === 0 ? (
          <EmptyState
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
        ) : null}

        {/* The grid's accessible name is what tells a screen-reader user which
            of the two §7 views they are in; the table's equivalent is
            `DataTable`'s visually hidden `<caption>`. */}
        <ul
          aria-label={t`Demo 资料库 · 卡片视图`}
          className="grid grid-cols-[repeat(auto-fill,minmax(var(--w-panel),1fr))] gap-3"
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
      </div>

      <Pagination
        page={currentPage}
        pageSize={LIBRARY_PAGE_SIZE}
        total={total}
        onPageChange={onPageChange}
      />
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
  const { i18n } = useLingui();
  const status = demoStatusMeta(demo.lifecycle_status);
  const score = formatScore(demo);

  return (
    <button
      type="button"
      data-demo-card={demo.id}
      aria-current={active ? 'true' : undefined}
      aria-label={t`打开 ${demo.display_name} 的详情`}
      onClick={onActivate}
      className={cn(
        'flex w-full flex-col gap-2 border p-3 text-left',
        active ? 'border-accent bg-accent-100' : 'border-divider hover:bg-surface',
      )}
    >
      <span className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate font-heading text-lg">{demo.display_name}</span>
        <span
          className={cn(
            'flex-none font-mono text-sm tabular-nums',
            score === EMPTY_CELL ? 'text-neutral-600' : active ? 'text-accent-800' : null,
          )}
        >
          {score}
        </span>
      </span>

      <span className="text-xs text-neutral-700">
        {demo.map_name}
        {' · '}
        {formatMatchDate(demo.match_date)}
        {demo.total_rounds > 0 ? (
          <>
            {' · '}
            <Trans>{formatRounds(demo.total_rounds)} 回合</Trans>
          </>
        ) : null}
      </span>

      <span className="flex items-center gap-2">
        {status.tone === 'accent' || status.tone === 'neutral' ? (
          <Tag tone={status.tone}>{i18n._(status.label)}</Tag>
        ) : (
          <span
            className={cn(
              'inline-flex items-center gap-2 text-xs',
              status.tone === 'fail' && 'text-fail-text',
            )}
          >
            <StatusDot status={status.tone === 'fail' ? 'fail' : 'running'} size="sm" />
            {i18n._(status.label)}
          </span>
        )}
      </span>
    </button>
  );
}
