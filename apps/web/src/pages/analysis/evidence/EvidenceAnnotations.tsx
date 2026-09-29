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
 * The Inspector block sits inside one match, so it never has to say which. This
 * list spans every match — the empty state promises 「跨比赛可检索」 — so each
 * row starts with the match and the map, the way the results rows do, before
 * the tick and the round.
 *
 * A row is selectable the way a results row is: a real button carrying the
 * body, `aria-current` on the current one, and the selection written to the
 * URL by the page so the Inspector beside the list describes the same note.
 * 「标记已处理」 / 「重新打开」 flips `review_state` through the page's mutation
 * and 「定位」 opens the match workspace on the note's evidence.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { Pagination } from '../../../design/data';
import { Alert } from '../../../design/feedback';
import { Button, Badge, cn } from '../../../design/primitives';
import { EvidenceRowSkeleton } from '../../../domain/match';
import type { EvidenceAnnotation } from '../../../shared/desktop/dto';
import { EVIDENCE_PAGE_SIZE } from './evidenceSearchParams';

export interface EvidenceAnnotationsProps {
  readonly rows: readonly EvidenceAnnotation[];
  readonly total: number;
  readonly page: number;
  readonly onPageChange: (page: number) => void;
  /** The note the Inspector is describing. */
  readonly activeId: string;
  readonly onSelect: (annotation: EvidenceAnnotation) => void;
  readonly onOpen: (annotation: EvidenceAnnotation) => void;
  /** 「标记已处理」 on an open note, 「重新打开」 on a resolved one. */
  readonly onToggleReviewState: (annotation: EvidenceAnnotation) => void;
  readonly togglePending?: boolean | undefined;
  readonly loading?: boolean | undefined;
  readonly error?: { readonly message: string; readonly onRetry: () => void } | undefined;
  readonly empty?: ReactNode | undefined;
}

/** The results row's selected plate, so the two faces of the page agree. */
const SELECTED_CLASS = 'bg-accent-100 shadow-[inset_2px_0_0_var(--color-accent)]';

export function EvidenceAnnotations({
  rows,
  total,
  page,
  onPageChange,
  activeId,
  onSelect,
  onOpen,
  onToggleReviewState,
  togglePending = false,
  loading = false,
  error,
  empty,
}: EvidenceAnnotationsProps) {
  if (error !== undefined) {
    return (
      <div data-evidence-annotations="error" className="p-6">
        <Alert
          variant="danger"
          action={{ label: <Trans>重试</Trans>, onAction: error.onRetry }}
          detail={<Trans>注释没有被改动，重试是安全的。</Trans>}
        >
          <Trans>注释没能读出来：{error.message}</Trans>
        </Alert>
      </div>
    );
  }

  if (loading) {
    return (
      <div data-evidence-annotations="loading" className="min-h-0 flex-1 overflow-y-auto">
        {Array.from({ length: 6 }, (_, index) => (
          <EvidenceRowSkeleton key={index} density="default" />
        ))}
        <p role="status" aria-busy="true" className="sr-only"><Trans>正在读取注释</Trans></p>
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
        {rows.map((annotation) => {
          const selected = annotation.id === activeId;
          const resolved = annotation.review_state === 'resolved';
          return (
            <li
              key={annotation.id}
              className={cn(
                'flex flex-col gap-2 border-b border-divider px-6 py-3',
                selected ? SELECTED_CLASS : 'hover:bg-surface',
              )}
              data-annotation={annotation.id}
              aria-current={selected ? true : undefined}
            >
              <button
                type="button"
                data-annotation-select=""
                aria-pressed={selected}
                onClick={() => onSelect(annotation)}
                className="flex w-full flex-col gap-1 text-left"
              >
                <span className="flex min-w-0 items-center gap-2 text-xs text-neutral-600">
                  <span className="truncate">{annotation.demo_display_name}</span>
                  <span className="flex-none">·</span>
                  <span className="truncate">{annotation.map_name}</span>
                </span>
                <span className="flex flex-wrap items-baseline gap-2.5">
                  <span className="text-xs text-neutral-600">
                    <Trans>第 {annotation.round} 回合</Trans>
                  </span>
                  <span className="flex-1" aria-hidden="true" />
                  <Badge variant={resolved ? 'neutral' : 'outline'}>
                    {resolved ? <Trans>已处理</Trans> : <Trans>待处理</Trans>}
                  </Badge>
                </span>
                <span className="max-w-full break-words text-sm leading-relaxed">{annotation.body}</span>
              </button>
              <div className="flex flex-wrap items-center gap-2">
                {annotation.tags.map((tag) => (
                  <Badge key={tag} variant="neutral">
                    {tag}
                  </Badge>
                ))}
                <div className="flex-1" aria-hidden="true" />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={togglePending}
                  onClick={() => onToggleReviewState(annotation)}
                >
                  {resolved ? <Trans>重新打开</Trans> : <Trans>标记已处理</Trans>}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => onOpen(annotation)}>
                  <Trans>定位</Trans>
                </Button>
              </div>
            </li>
          );
        })}
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
