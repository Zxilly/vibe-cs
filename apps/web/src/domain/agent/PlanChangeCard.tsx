/*
 * Domain layer, 2 of 3 — agent/PlanChangeCard.
 *
 * One proposed edit, as the 2a board draws it:
 *
 *   变更 1   [缩短]                                              −5.5s
 *   02 跟随突破 · 8.5s → 3.0s
 *   只保留从中路进入 A 大道的一段，绕后的起手交给 01 的建立镜头交代。
 *   ⚠ 结尾会变硬，建议给 03 加 0.5 秒后留白
 *   [预览这条]                                    [拒绝]  [接受]
 *
 * ── §4.5.3 rule ③ is not re-derived here ──────────────────────────────────
 *
 * Whether a change is stale is `planRevision.ts`'s answer, and what an expired
 * card looks like is `PLAN_CHANGE_AFFORDANCE`'s. This component reads both and
 * decides nothing:
 *
 *   opacity      `affordance.className` — the 55% the spec names, and the only
 *                place the number lives
 *   接受         disabled by `affordance.acceptDisabled`, **with the reason
 *                attached** through `Button`'s `disabledReason`
 *   标签         `affordance.statusLabel` — 「已过期」, a word, so the dimming is
 *                never the only signal (§6.2)
 *   内容         untouched. 过期不等于错误: the body, the rationale and the
 *                warning all stay fully legible, because that is what the user
 *                judges 「值不值得让 Agent 重算」 from. There is no `hidden`
 *                anywhere in this file and none in the affordance table.
 *
 * ── Two fields the board draws that the wire does not carry ───────────────
 *
 * The card's title line is 「02 跟随突破 · 8.5s → 3.0s」: a *shot name* followed
 * by the change's own before/after. `PlanChange` has the before/after (parsed
 * out of `AgentSessionProposal.payload`) but not the name — it has
 * `targetShotId`. So the name arrives as `targetLabel`, resolved by the panel
 * that already holds the plan. Nothing is guessed from the id.
 *
 * The board also draws a two-bar before/after ratio under the title. That needs
 * the two *durations* as numbers; the payload gives `before` / `after` as free
 * text and `deltaSeconds` alone cannot reconstruct them. It is therefore not
 * drawn — an omitted graphic, not an invented one.
 */

import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { ArrowRight, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button, Badge, cn } from '../../design/primitives';

import { planChangeAffordance } from './planRevision';
import { formatSignedSeconds } from './shotFormat';
import { PLAN_CHANGE_OP, type PlanChange } from './types';
import { Blueprint } from '../../design/layout';

export interface PlanChangeCardProps {
  readonly change: PlanChange;
  /** One-based position — the card's 「变更 1」. */
  readonly index: number;
  /** The target shot's own title, resolved by the caller from `targetShotId`. */
  readonly targetLabel?: ReactNode | undefined;
  readonly onAccept?: ((change: PlanChange) => void) | undefined;
  readonly onReject?: ((change: PlanChange) => void) | undefined;
  /** 「预览这条」. Omitted entirely when there is nothing to preview. */
  readonly onPreview?: ((change: PlanChange) => void) | undefined;
  readonly previewDisabledReason?: string | undefined;
  /**
   * An extra reason 接受 cannot be taken *right now* — no session selected, the
   * local service is offline. It never overrides the affordance's own reason:
   * a stale card says why it is stale first.
   */
  readonly acceptDisabledReason?: string | undefined;
  readonly className?: string | undefined;
}

export function PlanChangeCard({
  change,
  index,
  targetLabel,
  onAccept,
  onReject,
  onPreview,
  previewDisabledReason,
  acceptDisabledReason,
  className,
}: PlanChangeCardProps) {
  const { i18n } = useLingui();

  const op = PLAN_CHANGE_OP[change.op];
  const OpIcon = op.icon;
  const affordance = planChangeAffordance(change);

  /* The affordance's reason wins: 「这条变更基于方案的旧版本」 explains why the
     button is dead better than 「请先选择会话」 does, and both being true does
     not make the second one the useful one. */
  const acceptReason =
    affordance.acceptDisabledReason === null
      ? acceptDisabledReason
      : i18n._(affordance.acceptDisabledReason);
  const acceptDisabled = affordance.acceptDisabled || acceptReason !== undefined;
  return (
    <Blueprint
      as="article"
      tabIndex={-1}
      data-plan-change={change.id}
      data-change-state={change.state}
      data-change-op={change.op}
      className={cn(
        'flex flex-col gap-2 border p-3 text-sm',
        change.state === 'pending' ? 'border-accent bg-accent-100' : 'border-divider',
        affordance.className,
        className,
      )}
    >
      {change.state === 'accepted' || change.state === 'rejected' ? (
        <span className="sr-only" role="status" aria-live="polite">
          {change.state === 'accepted' ? (
            <Trans>变更 {index} 已接受</Trans>
          ) : (
            <Trans>变更 {index} 已拒绝</Trans>
          )}
        </span>
      ) : null}
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex-none font-mono text-2xs text-neutral-600">
          <Trans>变更 {index}</Trans>
        </span>
        <Badge variant={change.state === 'pending' ? 'accent' : 'neutral'} className="flex-none gap-1">
          <OpIcon size={11} strokeWidth={1.5} aria-hidden="true" />
          {i18n._(op.label)}
        </Badge>
        {affordance.statusLabel === null ? null : (
          <Badge data-change-status="" variant="neutral" className="flex-none">
            {i18n._(affordance.statusLabel)}
          </Badge>
        )}
        {change.deltaSeconds === null ? null : (
          <span className="ml-auto flex-none font-mono text-xs">
            {formatSignedSeconds(change.deltaSeconds)}
          </span>
        )}
      </div>

      {/* 「02 跟随突破 · 8.5s → 3.0s」. Each half is optional; an absent one takes
          its separator with it rather than leaving a dangling 「 · 」. */}
      {targetLabel === undefined && change.before === null && change.after === null ? null : (
        <p data-change-title="" className="flex min-w-0 flex-wrap items-center gap-1.5">
          {targetLabel === undefined ? null : <span className="min-w-0 truncate">{targetLabel}</span>}
          {change.before === null ? null : (
            <>
              {targetLabel === undefined ? null : <span className="text-neutral-600">·</span>}
              <span className="font-mono text-xs">{change.before}</span>
            </>
          )}
          {change.after === null ? null : (
            <>
              {change.before === null ? null : (
                <ArrowRight size={12} strokeWidth={1.5} aria-hidden="true" className="text-neutral-600" />
              )}
              <span className="font-mono text-xs">{change.after}</span>
            </>
          )}
        </p>
      )}

      {change.rationale === null ? null : (
        <p className="text-xs leading-normal text-neutral-800">{change.rationale}</p>
      )}

      {change.warning === null ? null : (
        <p
          data-change-warning=""
          className="flex items-start gap-2 bg-warn-surface px-2.5 py-2 text-xs text-warn-text"
        >
          <TriangleAlert size={13} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 flex-none" />
          <span className="min-w-0">{change.warning}</span>
        </p>
      )}

      {onAccept === undefined && onReject === undefined && onPreview === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {onPreview === undefined ? null : (
            <Button
              size="sm"
              onClick={() => onPreview(change)}
              {...(previewDisabledReason === undefined
                ? {}
                : { disabled: true, disabledReason: previewDisabledReason })}
            >
              <Trans>预览这条</Trans>
            </Button>
          )}

          {/* A rejected card offers 撤销拒绝 in place of the pair: taking a
              rejection back *is* accepting it now, so it is the same callback
              and the affordance table already leaves 接受 enabled for it. */}
          {change.state === 'rejected' ? (
            onAccept === undefined ? null : (
              <Button
                size="sm"
                data-change-accept=""
                className="ml-auto"
                onClick={() => {
                  onAccept(change);
                  queueMicrotask(() => focusAfterDecision(change.id));
                }}
                {...(acceptDisabled
                  ? { disabled: true, ...(acceptReason === undefined ? {} : { disabledReason: acceptReason }) }
                  : {})}
              >
                <Trans>撤销拒绝</Trans>
              </Button>
            )
          ) : (
            <>
              {onReject === undefined ? null : (
                <Button
                  size="sm"
                  data-change-reject=""
                  className="ml-auto"
                  onClick={() => {
                    onReject(change);
                    queueMicrotask(() => focusAfterDecision(change.id));
                  }}
                  {...(affordance.rejectDisabled ? { disabled: true } : {})}
                >
                  <Trans>拒绝</Trans>
                </Button>
              )}
              {onAccept === undefined ? null : (
                <Button
                  variant="primary"
                  size="sm"
                  data-change-accept=""
                  {...(onReject === undefined ? { className: 'ml-auto' } : {})}
                  onClick={() => {
                    onAccept(change);
                    queueMicrotask(() => focusAfterDecision(change.id));
                  }}
                  {...(acceptDisabled
                    ? { disabled: true, ...(acceptReason === undefined ? {} : { disabledReason: acceptReason }) }
                    : {})}
                >
                  <Trans>接受</Trans>
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </Blueprint>
  );
}

function focusAfterDecision(changeId: string): void {
  const cards = [...document.querySelectorAll<HTMLElement>('[data-plan-change]')];
  const currentIndex = cards.findIndex((candidate) => candidate.dataset.planChange === changeId);
  const pending = cards.filter(
    (candidate) => candidate.dataset.planChange !== changeId
      && candidate.dataset.changeState === 'pending',
  );
  const next = pending.find((candidate) => cards.indexOf(candidate) > currentIndex)
    ?? pending[0]
    ?? document.querySelector<HTMLElement>('[data-agent-composer] textarea');
  next?.focus();
}
