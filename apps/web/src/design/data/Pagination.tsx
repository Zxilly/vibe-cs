/**
 * Design system, layer 1 of 3 — the pager under a `DataTable`.
 *
 * The reference draws no pager: every table artboard fits on one screen. What
 * it does draw is the *shape* of a bar under a table — 46px / 52px, one hairline
 * on top, a count on the left, controls on the right (the selection bars of
 * 资料库 / 证据检索 / 玩家目录) — and the copy pattern for a result count
 * ("命中 47 条 · 排序：时间倒序" on 「05 证据检索」). This bar follows both.
 *
 * Spec §15.4 asks large tables to be windowed or *stably* paged, and this round
 * pages. Stability is `paginationModel.paginationRange`: the number of slots is
 * constant, so walking the pages never reflows the bar.
 *
 * Controls are `--h-ctl-sm` (32px), the §3.3 floor — the artboards' 30px
 * secondary buttons are exactly what §3.3 raises.
 */

import { t } from '@lingui/core/macro';
import { Plural, Trans } from '@lingui/react/macro';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { cx } from './cx';
import { paginationRange } from './paginationModel';
import { clampPage, pageCount as pageCountOf, pageRange } from './tableModel';

export interface PaginationProps {
  /** 1-based, matching what the bar shows. */
  readonly page: number;
  readonly pageSize: number;
  /** Rows across every page, not on this one. */
  readonly total: number;
  readonly onPageChange: (page: number) => void;
  /** Page buttons kept either side of the current page. */
  readonly siblings?: number | undefined;
  /** Replaces "共 N 条" when the page has a unit ("命中 47 条"). */
  readonly summary?: ReactNode | undefined;
  readonly className?: string | undefined;
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  siblings = 1,
  summary,
  className,
}: PaginationProps) {
  const count = pageCountOf(total, pageSize);
  const current = clampPage(page, total, pageSize);
  const { from, to } = pageRange(total, current, pageSize);
  const slots = paginationRange(current, count, { siblings });

  return (
    <nav
      aria-label={t`分页`}
      className={cx(
        'flex h-[var(--h-bar)] flex-none items-center gap-3 border-t border-divider px-6',
        className,
      )}
    >
      <span className="text-xs text-neutral-600">
        {summary ?? <Plural value={total} other="共 # 条" />}
        {total > 0 ? (
          <>
            {' · '}
            <Trans>
              第 {from}–{to} 条
            </Trans>
          </>
        ) : null}
      </span>
      <div className="flex-1" />
      <div className="flex items-center gap-1">
        <StepButton
          label={t`上一页`}
          disabled={current <= 1}
          onClick={() => onPageChange(current - 1)}
          icon={<ChevronLeft className="size-4" strokeWidth={1.5} aria-hidden="true" />}
        />
        {slots.map((slot, index) =>
          slot === 'ellipsis' ? (
            // The two ellipses have no identity of their own; the slot index is
            // the only stable key, and the run length never changes anyway.
            <span key={`ellipsis-${index}`} aria-hidden="true" className="px-2 text-xs text-neutral-500">
              …
            </span>
          ) : (
            <button
              key={slot}
              type="button"
              aria-label={t`第 ${slot} 页`}
              aria-current={slot === current ? 'page' : undefined}
              onClick={() => onPageChange(slot)}
              className={cx(
                'inline-flex h-[var(--h-ctl-sm)] min-w-[var(--h-ctl-sm)] items-center justify-center border px-2 text-sm tabular-nums',
                slot === current
                  ? 'border-accent bg-accent-100 text-accent-800'
                  : 'border-transparent hover:bg-surface',
              )}
            >
              {slot}
            </button>
          ),
        )}
        <StepButton
          label={t`下一页`}
          disabled={current >= count}
          onClick={() => onPageChange(current + 1)}
          icon={<ChevronRight className="size-4" strokeWidth={1.5} aria-hidden="true" />}
        />
      </div>
    </nav>
  );
}

/**
 * Prev / next. Disabled rather than removed at the ends: spec §8 forbids an
 * action that silently disappears, and a control that vanishes also moves every
 * button beside it.
 */
function StepButton({
  label,
  disabled,
  onClick,
  icon,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly icon: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-[var(--h-ctl-sm)] items-center justify-center border border-divider hover:bg-surface disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
    >
      {icon}
    </button>
  );
}
