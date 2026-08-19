/*
 * pages/evidence — the result set of 「05 证据检索」.
 *
 * The artboard draws the results as a nine-column table. This renders them as
 * `domain/match/EvidenceRow` at `density="comfortable"` instead, which is the
 * density that component exists for — its own header says so: 「comfortable
 * 「05 证据检索」，一个 42px 的结果行」. The row already carries every column the
 * artboard prints (tick, kind glyph, 主体, 事件, 回合 on line one; 比赛 and 地图
 * on line two) and it carries them the same way in the workspace Inspector and
 * the Agent citation list, which a page-local `<table>` could not.
 *
 * ── Density (§10.3) ────────────────────────────────────────────────────────
 *
 * Two rules from the phase-2 review are load-bearing here:
 *
 *   · **The scroll happens in this container.** `overflow-y-auto` plus
 *     `min-h-0` on every ancestor, so a 20-row page never pushes a second
 *     scrollbar onto `body` (`base.css` sets `overflow: hidden` there, so it
 *     would simply clip).
 *   · **Nothing is truncated silently.** The page is 20 rows and the footer
 *     prints 「命中 N 条」 — the total, not the slice. A result set larger than
 *     one page is paged, never cut.
 *
 * ── What the row cannot say yet ────────────────────────────────────────────
 *
 * The artboard's 注释 column shows 「待处理」/「已处理」 per row.
 * `EvidenceSearchItem` carries no annotation state and there is no bulk
 * "annotations for these ids" read, so filling that column would be one query
 * per row. It is left empty here and reported as a contract gap rather than
 * faked from the annotation list, which is paged independently and would align
 * with the results only by accident.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { Pagination } from '../../design/data';
import { Alert } from '../../design/feedback';
import { Button } from '../../design/primitives';
import { EvidenceRow, EvidenceRowSkeleton, type EvidenceItem } from '../../domain/match';
import type { EvidenceSearchItem } from '../../shared/desktop/dto';
import {
  evidenceQualifiers,
  formatMatchMonthDay,
  toEvidenceIdentity,
  type EvidencePerspective,
} from './evidenceItems';
import { EVIDENCE_PAGE_SIZE } from './evidenceSearchParams';

/* ── one row ─────────────────────────────────────────────────────────────── */

/**
 * The two slots that need authored words: the qualifier tail after the weapon,
 * and the 「地图 · 日期」 second line. Everything else comes from
 * `toEvidenceIdentity`, which is pure and unit-tested.
 */
function toEvidenceItem(row: EvidenceSearchItem, perspective: EvidencePerspective): EvidenceItem {
  const qualifiers = evidenceQualifiers(row);
  const day = formatMatchMonthDay(row.match_date);

  return {
    ...toEvidenceIdentity(row, perspective),
    ...(qualifiers.length === 0
      ? {}
      : {
          description: (
            <>
              {qualifiers.map((qualifier, index) => (
                <span key={qualifier}>
                  {index > 0 ? ' · ' : null}
                  {qualifier === 'penetrated' ? <Trans>穿墙</Trans> : <Trans>爆头</Trans>}
                </span>
              ))}
            </>
          ),
        }),
    context: day === '' ? row.map_name : `${row.map_name} · ${day}`,
  };
}

/* ── props ───────────────────────────────────────────────────────────────── */

export interface EvidenceResultsProps {
  readonly rows: readonly EvidenceSearchItem[];
  readonly perspective: EvidencePerspective;
  readonly total: number;
  readonly page: number;
  readonly onPageChange: (page: number) => void;
  /** The row the Inspector is describing. */
  readonly activeId: string;
  readonly onSelect: (row: EvidenceSearchItem) => void;
  /** 「定位」 — opens the match workspace at this tick. */
  readonly onLocate: (row: EvidenceSearchItem) => void;
  /** 「加入作品」. */
  readonly onAddToVideo: (row: EvidenceSearchItem) => void;
  /** Why 「加入作品」 cannot run. Disables it and says so, per §8. */
  readonly addDisabledReason?: string | undefined;
  readonly loading?: boolean | undefined;
  /** A failed read, rendered in place — §4.1 sets `throwOnError: false`. */
  readonly error?: { readonly message: string; readonly onRetry: () => void } | undefined;
  /** Shown when `rows` is empty and nothing failed. */
  readonly empty?: ReactNode | undefined;
}

export function EvidenceResults({
  rows,
  perspective,
  total,
  page,
  onPageChange,
  activeId,
  onSelect,
  onLocate,
  onAddToVideo,
  addDisabledReason,
  loading = false,
  error,
  empty,
}: EvidenceResultsProps) {
  if (error !== undefined) {
    return (
      <div data-evidence-results="error" className="p-7">
        <Alert
          variant="danger"
          action={{ label: <Trans>重试</Trans>, onAction: error.onRetry }}
          detail={<Trans>没有任何数据被改动，可以直接重试。</Trans>}
        >
          <Trans>检索没能完成：{error.message}</Trans>
        </Alert>
      </div>
    );
  }

  if (loading) {
    return (
      <div data-evidence-results="loading" className="flex min-h-0 flex-1 flex-col">
        {/* Row-shaped placeholders, not a spinner and not a percentage —
            「加载中 · 表格骨架（不显示虚构百分比）」. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
          {Array.from({ length: 8 }, (_, index) => (
            <EvidenceRowSkeleton key={index} density="comfortable" />
          ))}
        </div>
        {/* The stage name, and only the stage name — 「加载中 · 表格骨架（不显示
            虚构百分比）」. The bars above carry `aria-hidden`, so without this
            line a screen-reader user would hear nothing at all. */}
        <p role="status" aria-busy="true" className="sr-only">
          <Trans>正在检索证据</Trans>
        </p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div data-evidence-results="empty" className="min-h-0 flex-1 overflow-y-auto">
        {empty}
      </div>
    );
  }

  return (
    <div data-evidence-results="ready" className="flex min-h-0 flex-1 flex-col">
      <ul className="min-h-0 flex-1 list-none overflow-y-auto overscroll-y-contain">
        {rows.map((row) => {
          const item = toEvidenceItem(row, perspective);
          return (
            <li key={row.evidence_id}>
              <EvidenceRow
                evidence={item}
                density="comfortable"
                selected={row.evidence_id === activeId}
                onSelect={() => onSelect(row)}
                onLocate={() => onLocate(row)}
                action={
                  <Button
                    variant="ghost"
                    size="sm"
                    {...(addDisabledReason === undefined
                      ? {}
                      : { disabled: true, disabledReason: addDisabledReason })}
                    onClick={() => onAddToVideo(row)}
                  >
                    <Trans>加入作品</Trans>
                  </Button>
                }
              />
            </li>
          );
        })}
      </ul>
      <Pagination
        page={page}
        pageSize={EVIDENCE_PAGE_SIZE}
        total={total}
        onPageChange={onPageChange}
        summary={<Trans>命中 {total} 条</Trans>}
      />
    </div>
  );
}
