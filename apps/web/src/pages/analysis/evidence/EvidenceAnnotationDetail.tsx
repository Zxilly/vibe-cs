/*
 * pages/evidence — the Inspector of the 「注释」 face.
 *
 * The 证据 face keeps an Inspector describing the current result row. On the
 * 注释 face the list is a different set — every note across every match — so
 * an Inspector still describing the first search hit was talking about the
 * wrong thing, and its 「这条证据还没有注释」 contradicted the seven notes beside
 * it. This panel describes the current *note*: the match and map it belongs
 * to, the tick and round its evidence sits at, the body, the tags and the
 * state, with the same 「在比赛工作区打开」 main action the other face carries.
 *
 * `EvidenceAnnotation` names its evidence by id, round and tick and now by
 * match and map; it does not carry the duel (actor, target, weapon), and
 * `EvidenceSearchQuery` cannot look one row up by id. So the panel says what
 * the note knows and no more — the workspace link is where the duel is.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { Empty } from '../../../design/data';
import { Inspector } from '../../../design/layout';
import { Badge, Button } from '../../../design/primitives';
import type { EvidenceAnnotation } from '../../../shared/desktop/dto';

export interface EvidenceAnnotationDetailProps {
  /** `null` while the list is empty. */
  readonly annotation: EvidenceAnnotation | null;
  readonly onOpenWorkspace: (annotation: EvidenceAnnotation) => void;
  /** 「标记已处理」 on an open note, 「重新打开」 on a resolved one. */
  readonly onToggleReviewState: (annotation: EvidenceAnnotation) => void;
  readonly togglePending?: boolean | undefined;
}

function Field({ label, children }: { readonly label: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="flex-none text-neutral-600">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  );
}

export function EvidenceAnnotationDetail({
  annotation,
  onOpenWorkspace,
  onToggleReviewState,
  togglePending = false,
}: EvidenceAnnotationDetailProps) {
  if (annotation === null) {
    return (
      <Inspector title={<Trans>注释详情</Trans>} label={t`注释详情`}>
        <Empty title={<Trans>还没有选中注释</Trans>} actions={null} />
      </Inspector>
    );
  }

  const resolved = annotation.review_state === 'resolved';

  return (
    <Inspector
      title={<Trans>注释详情</Trans>}
      label={t`注释详情`}
      summary={
        <Trans>
          {annotation.demo_display_name} · 第 {annotation.round} 回合
        </Trans>
      }
      summaryActions={
        <Button variant="primary" size="sm" onClick={() => onOpenWorkspace(annotation)}>
          <Trans>在比赛工作区打开</Trans>
        </Button>
      }
      footer={
        <>
          <Button variant="primary" size="lg" block onClick={() => onOpenWorkspace(annotation)}>
            <Trans>在比赛工作区打开</Trans>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            block
            disabled={togglePending}
            onClick={() => onToggleReviewState(annotation)}
          >
            {resolved ? <Trans>重新打开</Trans> : <Trans>标记已处理</Trans>}
          </Button>
        </>
      }
    >
      <div>
        <div className="font-heading text-xl">{annotation.demo_display_name}</div>
        <div className="mt-0.5 text-xs text-neutral-700">
          <Trans>
            {annotation.map_name} · 第 {annotation.round} 回合
          </Trans>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Field label={<Trans>状态</Trans>}>
          <Badge variant={resolved ? 'neutral' : 'outline'}>
            {resolved ? <Trans>已处理</Trans> : <Trans>待处理</Trans>}
          </Badge>
        </Field>
        <Field label={<Trans>写于</Trans>}>{annotation.created_at.slice(0, 10)}</Field>
        <Field label={<Trans>最近改动</Trans>}>{annotation.updated_at.slice(0, 10)}</Field>
      </div>

      <div className="border border-divider p-3">
        <div className="mb-2 font-heading text-xs tracking-caps text-neutral-700">
          <Trans>注释</Trans>
        </div>
        <p data-annotation-body="" className="break-words text-sm leading-normal">
          {annotation.body}
        </p>
        {annotation.tags.length === 0 ? null : (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {annotation.tags.map((tag) => (
              <Badge key={tag} variant="neutral">
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </Inspector>
  );
}
