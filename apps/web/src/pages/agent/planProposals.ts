/*
 * pages/agent — the session's proposals, seen from the plan (§4.5.3 rule ③).
 *
 * The Agent's changes live in the *session*: an `assistant` entry carries
 * `proposals`, and a proposal that is about a plan carries `plan_id` and
 * `based_on_revision`. The plan panel is the surface that has to act on them, so
 * this module is the projection — session in, this plan's change sets out —
 * kept pure so it can be pinned without a session query.
 *
 * ── What is here, and what deliberately is not ───────────────────────────
 *
 * Only the projection. The **decision model is not duplicated here**: the key,
 * the map, and the decisions-then-`markStale` composition all live once, in
 * `conversationModel.ts`, and this file's `PlanProposal` satisfies that file's
 * `DecidableProposal` so the panel calls the same `changeDecisionKey` and the
 * same `resolveChangeSet` block A calls. A second copy is how one change came to
 * read 已接受 in the panel and 待处理 in the transcript on one screen; the two
 * copies also spelled the key differently (`#` against `:`), so even merging the
 * maps would not have merged the answers.
 *
 *   1. `readPlanProposals`   session → this plan's change sets, oldest first
 *   2. `resolveChangeSet`    decisions, then the revision — `conversationModel`
 *
 * ── Where the decisions live, and why that is a gap and not a design ──────
 *
 * In the page shell's own state, lost on reload: no route records an accept or a
 * reject (`agentContract.ts`, gap 3). Nothing here writes to storage to paper
 * over that — a local record of 「我拒绝过这条」 that the server does not share
 * would disagree with every other window the moment there are two.
 */

import { readPlanChangeSet, type PlanChangeSet } from '../../domain/agent';
import type { AgentSession, AgentSessionEntry } from '../../shared/desktop/dto';

import type { DecidableProposal } from './conversationModel';

/**
 * One proposal of one session entry, already parsed into change cards.
 *
 * `key` is `${entryId}#${proposalId}` — the **same string** block A's `ProposalSlot`
 * carries for the same proposal. That equality
 * is the whole mechanism behind one decision map; `planProposals.test.ts` pins
 * it against `collectProposals` rather than trusting the two templates to stay
 * in step.
 */
export interface PlanProposal extends DecidableProposal {
  readonly key: string;
  readonly entryId: string;
  readonly at: string;
  /** Narrower than `DecidableProposal`'s: an unparsed proposal never gets here. */
  readonly changeSet: PlanChangeSet;
}

/**
 * Every change set in this session that is about this plan, oldest first — the
 * order the entries are in, which is the order they were said.
 *
 * A proposal that is not about a plan, or whose payload `readPlanChangeSet`
 * does not recognise, is **left out entirely** rather than rendered as an empty
 * card: the transcript still shows it as an ordinary proposal (block A), and a
 * card with no changes in the plan panel would claim the Agent proposed
 * something to the plan when it did not.
 */
export function readPlanProposals(
  session: AgentSession | undefined,
  planId: string | null,
): readonly PlanProposal[] {
  if (session === undefined || planId === null) return [];

  const proposals: PlanProposal[] = [];
  for (const entry of session.entries) {
    if (!isAssistant(entry)) continue;
    for (const raw of entry.proposals) {
      const changeSet = readPlanChangeSet(raw);
      if (changeSet === null || changeSet.planId !== planId) continue;
      proposals.push({
        key: `${entry.id}#${raw.proposal_id}`,
        entryId: entry.id,
        at: entry.at,
        changeSet,
      });
    }
  }
  return proposals;
}

function isAssistant(
  entry: AgentSessionEntry,
): entry is Extract<AgentSessionEntry, { kind: 'assistant' }> {
  return entry.kind === 'assistant';
}
