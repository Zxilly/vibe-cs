/*
 * Domain layer, 2 of 3 — agent/AgentProposalCard.
 *
 * The frame around one proposal: its title, what kind it is, the revision it
 * was computed against, and — as children — whatever the panel draws inside it
 * (`PlanChangeCard`s, or the page's own 修订冲突 `Notice`).
 *
 * ── Why the parse result is a prop and not a fetch ────────────────────────
 *
 * `AgentSessionProposal.payload` is `unknown` on the wire, so
 * `readPlanChangeSet` may return `null` — 「这条提议不是方案变更，或者它的 payload
 * 不是我们认识的形状」. The header must render either way, so the parse happens
 * at the call site and the result arrives here:
 *
 *   changeSet: a set   header plus the caller's cards
 *   changeSet: null    **the title alone**. No cards, no placeholder row, no
 *                      「无法解析」 apology — an unrecognised proposal is still a
 *                      thing the Agent said, and printing its title is the whole
 *                      of what can honestly be shown.
 *
 * ── The 「已过期」 chip ────────────────────────────────────────────────────
 *
 * `changeSetIsStale` is `planRevision.ts`'s function, called with the revision
 * the caller has on screen. The chip is a *word*, per §6.2, and it sits beside
 * the revision numbers so the reader can see both halves of the comparison
 * rather than being told the conclusion. The individual cards dim themselves;
 * the frame does not, because the frame's own title is not expired.
 *
 * `proposal.kind` is free text on the wire (see `types.ts`) and is printed as
 * the server wrote it — no mapping to a closed set, because there is no closed
 * set to map to.
 */

import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { Badge, cn } from '../../design/primitives';
import type { AgentSessionProposal } from '../../shared/desktop/dto';

import { changeSetIsStale, pendingChangeCount } from './planRevision';
import { PLAN_CHANGE_STATE, type PlanChangeSet } from './types';

export interface AgentProposalCardProps {
  readonly proposal: AgentSessionProposal;
  /** `readPlanChangeSet(proposal)`. `null` means 「只印标题」 — see the header. */
  readonly changeSet?: PlanChangeSet | null | undefined;
  /** The plan revision on screen. Without it nothing can be called expired. */
  readonly currentRevision?: number | undefined;
  /** The change cards, or the caller's conflict notice. */
  readonly children?: ReactNode | undefined;
  readonly className?: string | undefined;
}

export function AgentProposalCard({
  proposal,
  changeSet,
  currentRevision,
  children,
  className,
}: AgentProposalCardProps) {
  const { i18n } = useLingui();

  const set = changeSet ?? null;
  const stale = set !== null && currentRevision !== undefined && changeSetIsStale(set, currentRevision);
  const pending = set === null ? 0 : pendingChangeCount(set);

  /* Not framed, though the name says card: this is the *group* a batch of
     `PlanChangeCard`s arrives in, and each of those is framed. Two nested sets
     of registration marks read as noise rather than as structure — the frame
     marks the object you act on, and here that is the change. */
  return (
    <section
      data-agent-proposal={proposal.kind}
      {...(stale ? { 'data-proposal-state': 'stale' } : {})}
      className={cn('flex flex-col gap-2 border border-divider p-3', className)}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h4 className="min-w-0 flex-1 truncate font-heading text-base leading-tight font-normal">
          {proposal.title}
        </h4>
        {/* Server's own word for the kind. Free text, printed, not mapped. */}
        <Badge variant="neutral" className="flex-none">
          {proposal.kind}
        </Badge>
        {stale ? (
          <Badge data-proposal-stale="" variant="outline" className="flex-none">
            {i18n._(PLAN_CHANGE_STATE.stale.label)}
          </Badge>
        ) : null}
      </div>

      {proposal.based_on_revision === null ? null : (
        <p data-proposal-revision="" className="flex flex-wrap items-center gap-3 text-xs text-neutral-600">
          <span className="font-mono">
            <Trans>基于第 {proposal.based_on_revision} 版</Trans>
          </span>
          {currentRevision === undefined ? null : (
            <span className="font-mono">
              <Trans>当前第 {currentRevision} 版</Trans>
            </span>
          )}
          {pending === 0 ? null : (
            <span data-proposal-pending="">
              <Trans>{pending} 项变更待处理</Trans>
            </span>
          )}
        </p>
      )}

      {children === undefined ? null : <div className="flex flex-col gap-2">{children}</div>}
    </section>
  );
}
