/*
 * pages/evidence — the second face of §7's `/evidence?view=evidence|annotations`.
 *
 * 「补齐 · 暗色与其余页面」 lists 「注释索引」 among the surfaces the reference did
 * not draw in full, so the shape is derived from the two places an annotation
 * *is* drawn: the 「05 证据检索」 Inspector block (a body line, then a row of
 * 待处理 / 教学 tags) and the results table's 注释 column (one state tag).
 * An index of those is the same block, one per row, with the evidence it hangs
 * on named so it can be opened.
 *
 * Read-only this round. `DesktopClient` exposes `listEvidenceAnnotations` and
 * not the three writes, so 「写注释」 / 「标记已处理」 are disabled with the reason
 * attached rather than hidden — §8's rule, and the same treatment the search
 * Inspector gives the same missing seam.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { Pagination } from '../../design/data';
import { Notice } from '../../design/feedback';
import { Button, Tag } from '../../design/primitives';
import { EvidenceRowSkeleton, formatTickCount } from '../../domain/match';
import type { EvidenceAnnotation } from '../../shared/desktop/dto';
import { EVIDENCE_PAGE_SIZE } from './evidenceSearchParams';

export interface EvidenceAnnotationsProps {
  readonly rows: readonly EvidenceAnnotation[];
  readonly total: number;
  readonly page: number;
  readonly onPageChange: (page: number) => void;
  readonly onOpen: (annotation: EvidenceAnnotation) => void;
  /** Why the annotation writes are unavailable. */
  readonly editDisabledReason?: string | undefined;
  readonly loading?: boolean | undefined;
  readonly error?: { readonly message: string; readonly onRetry: () => void } | undefined;
  readonly empty?: ReactNode | undefined;
}

export function EvidenceAnnotations({
  rows,
  total,
  page,
  onPageChange,
  onOpen,
  editDisabledReason,
  loading = false,
  error,
  empty,
}: EvidenceAnnotationsProps) {
  if (error !== undefined) {
    return (
      <div data-evidence-annotations="error" className="p-7">
        <Notice
          tone="danger"
          action={{ label: <Trans>重试</Trans>, onAction: error.onRetry }}
          detail={<Trans>注释没有被改动，重试是安全的。</Trans>}
        >
          <Trans>注释没能读出来：{error.message}</Trans>
        </Notice>
      </div>
    );
  }

  if (loading) {
    return (
      <div data-evidence-annotations="loading" className="min-h-0 flex-1 overflow-y-auto">
        {Array.from({ length: 6 }, (_, index) => (
          <EvidenceRowSkeleton key={index} density="default" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div data-evidence-annotations="empty" className="min-h-0 flex-1 overflow-y-auto">
        {empty}
      </div>
    );
  }

  return (
    <div data-evidence-annotations="ready" className="flex min-h-0 flex-1 flex-col">
      <ul className="min-h-0 flex-1 list-none overflow-y-auto overscroll-y-contain">
        {rows.map((annotation) => (
          <li
            key={annotation.id}
            className="flex flex-col gap-2 border-b border-divider px-7 py-3"
            data-annotation={annotation.id}
          >
            <div className="flex items-baseline gap-2.5">
              <span className="font-mono text-xs text-accent-700">
                <Trans>tick {formatTickCount(annotation.tick)}</Trans>
              </span>
              <span className="text-xs text-neutral-600">
                <Trans>第 {annotation.round} 回合</Trans>
              </span>
              <div className="flex-1" aria-hidden="true" />
              <Tag tone={annotation.review_state === 'resolved' ? 'neutral' : 'outline'}>
                {annotation.review_state === 'resolved' ? (
                  <Trans>已处理</Trans>
                ) : (
                  <Trans>待处理</Trans>
                )}
              </Tag>
            </div>
            <p className="text-sm leading-normal">{annotation.body}</p>
            <div className="flex flex-wrap items-center gap-2">
              {annotation.tags.map((tag) => (
                <Tag key={tag} tone="neutral">
                  {tag}
                </Tag>
              ))}
              <div className="flex-1" aria-hidden="true" />
              <Button
                variant="secondary"
                size="sm"
                {...(editDisabledReason === undefined
                  ? {}
                  : { disabled: true, disabledReason: editDisabledReason })}
              >
                <Trans>标记已处理</Trans>
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onOpen(annotation)}>
                <Trans>定位</Trans>
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <Pagination
        page={page}
        pageSize={EVIDENCE_PAGE_SIZE}
        total={total}
        onPageChange={onPageChange}
        summary={<Trans>共 {total} 条注释</Trans>}
      />
    </div>
  );
}
