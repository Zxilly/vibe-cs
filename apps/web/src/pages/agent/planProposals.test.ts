/*
 * `unit` project — the session's proposals, projected onto the plan
 * (§4.5.3 rule ③).
 *
 * The composition is the thing under test. `markStale` already has its own
 * sixteen tests in `domain/agent/planRevision.test.ts`; what is pinned here is
 * that the panel applies the user's decisions **before** it, that a decided
 * change is therefore never re-marked, and that a proposal about another plan
 * never reaches this panel at all.
 *
 * The decision half comes from `conversationModel.ts` — one implementation for
 * both columns (invariant 6) — so what these tests exercise is that this
 * projection *fits* it: the same key, the same order, the same answers. The key
 * being byte-identical to block A's is pinned against `collectProposals` rather
 * than against a literal, because a template that only looks the same is what
 * produced two answers on one screen.
 */

import { describe, expect, it } from 'vitest';

import { PLAN_PROPOSAL, USER_ENTRY } from '../../domain/agent/agentFixtures.testing';
import type { AgentSession, AgentSessionEntry } from '../../shared/desktop/dto';

import {
  changeDecisionKey,
  collectProposals,
  pendingTotal,
  resolveChangeSet,
  type ChangeDecision,
} from './conversationModel';
import { SESSION, SESSION_WITHOUT_PROPOSALS, sessionBasedOn } from './planFixtures.testing';
import { readPlanProposals } from './planProposals';

function decisions(entries: readonly [string, ChangeDecision][]): Map<string, ChangeDecision> {
  return new Map(entries);
}

describe('readPlanProposals', () => {
  it('finds this plan’s change sets in the assistant entries', () => {
    const proposals = readPlanProposals(SESSION, 'P-118');

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.changeSet.changes).toHaveLength(3);
    expect(proposals[0]?.changeSet.basedOnRevision).toBe(6);
  });

  it('is empty without a session or without a plan', () => {
    expect(readPlanProposals(undefined, 'P-118')).toEqual([]);
    expect(readPlanProposals(SESSION, null)).toEqual([]);
  });

  it('leaves out a proposal about a different plan', () => {
    expect(readPlanProposals(SESSION, 'P-999')).toEqual([]);
  });

  it('leaves out a proposal whose payload is not a change set', () => {
    expect(readPlanProposals(SESSION_WITHOUT_PROPOSALS, 'P-118')).toEqual([]);

    const unreadable: AgentSession = {
      ...SESSION,
      entries: [
        {
          kind: 'assistant',
          id: 'entry-x',
          at: '2026-08-15T09:45:00.000Z',
          content: '',
          tool_calls: [],
          proposals: [{ ...PLAN_PROPOSAL, payload: '一段话' }],
        },
      ],
    };
    expect(readPlanProposals(unreadable, 'P-118')).toEqual([]);
  });

  it('gives two proposals of one entry different keys', () => {
    const twice: AgentSessionEntry = {
      kind: 'assistant',
      id: 'entry-2',
      at: '2026-08-15T09:45:00.000Z',
      content: '',
      tool_calls: [],
      proposals: [
        PLAN_PROPOSAL,
        { ...PLAN_PROPOSAL, proposal_id: '00000000-0000-4000-8000-0000000000a4' },
      ],
    };
    const proposals = readPlanProposals({ ...SESSION, entries: [USER_ENTRY, twice] }, 'P-118');

    expect(proposals.map((proposal) => proposal.key)).toEqual([
      'entry-2#00000000-0000-4000-8000-0000000000a2',
      'entry-2#00000000-0000-4000-8000-0000000000a4',
    ]);
  });
});

describe('the key the panel files a decision under', () => {
  it('is the same string block A files it under — one decision, two columns', () => {
    // Invariant 6. The two projections index into `entry.proposals` untouched,
    // so the same proposal has the same key on both sides; a decision made in
    // the transcript is therefore *found* by the panel rather than shadowed.
    const proposals = readPlanProposals(SESSION, 'P-118');
    const slots = collectProposals(SESSION.entries);

    expect(proposals.map((proposal) => proposal.key)).toEqual(slots.map((slot) => slot.key));

    const proposal = proposals[0];
    const slot = slots[0];
    const change = proposal?.changeSet.changes[0];
    if (proposal === undefined || slot === undefined || change === undefined) {
      throw new Error('fixture lost its proposal');
    }
    expect(changeDecisionKey(proposal.key, change.id)).toBe(
      changeDecisionKey(slot.key, change.id),
    );
  });

  it('separates the same change id in two proposals', () => {
    const twice: AgentSessionEntry = {
      kind: 'assistant',
      id: 'entry-2',
      at: '2026-08-15T09:45:00.000Z',
      content: '',
      tool_calls: [],
      proposals: [
        PLAN_PROPOSAL,
        { ...PLAN_PROPOSAL, proposal_id: '00000000-0000-4000-8000-0000000000a5' },
      ],
    };
    const [first, second] = readPlanProposals({ ...SESSION, entries: [twice] }, 'P-118');
    const change = first?.changeSet.changes[0];

    expect(first && change && changeDecisionKey(first.key, change.id)).not.toBe(
      second && change && changeDecisionKey(second.key, change.id),
    );
  });
});

describe('the decisions, overlaid on this projection', () => {
  const [proposal] = readPlanProposals(SESSION, 'P-118');

  it('returns the same object when nothing was decided', () => {
    // No revision to compare against, so the decisions are the only overlay —
    // and an overlay of nothing must not allocate a second change set.
    expect(proposal && resolveChangeSet(proposal, new Map(), null)).toBe(proposal?.changeSet);
  });

  it('writes the decision onto the one card it names', () => {
    if (proposal === undefined) throw new Error('fixture lost its proposal');
    const first = proposal.changeSet.changes[0];
    if (first === undefined) throw new Error('fixture lost its change');

    const set = resolveChangeSet(
      proposal,
      decisions([[changeDecisionKey(proposal.key, first.id), 'rejected']]),
      null,
    );

    expect(set?.changes.map((change) => change.state)).toEqual(['rejected', 'pending', 'pending']);
  });
});

describe('resolveChangeSet — decisions first, staleness second', () => {
  const [proposal] = readPlanProposals(SESSION, 'P-118');

  it('marks every undecided change stale once the plan moved past its base', () => {
    if (proposal === undefined) throw new Error('fixture lost its proposal');

    const set = resolveChangeSet(proposal, new Map(), 7);
    expect(set?.changes.map((change) => change.state)).toEqual(['stale', 'stale', 'stale']);
  });

  it('leaves an accepted change accepted — 「已接受过的变更不受影响」', () => {
    if (proposal === undefined) throw new Error('fixture lost its proposal');
    const first = proposal.changeSet.changes[0];
    if (first === undefined) throw new Error('fixture lost its change');

    const set = resolveChangeSet(
      proposal,
      decisions([[changeDecisionKey(proposal.key, first.id), 'accepted']]),
      7,
    );

    expect(set?.changes[0]?.state).toBe('accepted');
    expect(set?.changes[1]?.state).toBe('stale');
  });

  it('leaves a rejected change rejected rather than re-marking it stale', () => {
    if (proposal === undefined) throw new Error('fixture lost its proposal');
    const second = proposal.changeSet.changes[1];
    if (second === undefined) throw new Error('fixture lost its change');

    const set = resolveChangeSet(
      proposal,
      decisions([[changeDecisionKey(proposal.key, second.id), 'rejected']]),
      7,
    );

    expect(set?.changes[1]?.state).toBe('rejected');
  });

  it('keeps every card pending while the base and the plan agree', () => {
    const [current] = readPlanProposals(sessionBasedOn(7), 'P-118');
    if (current === undefined) throw new Error('fixture lost its proposal');

    expect(resolveChangeSet(current, new Map(), 7)?.changes.map((change) => change.state)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('never loses a change: an expired card is still a card', () => {
    if (proposal === undefined) throw new Error('fixture lost its proposal');

    const set = resolveChangeSet(proposal, new Map(), 7);
    expect(set?.changes).toHaveLength(proposal.changeSet.changes.length);
    expect(set?.changes[0]?.rationale).toBe(proposal.changeSet.changes[0]?.rationale);
  });
});

describe('what the panel counts as still waiting', () => {
  it('counts nothing once every card has expired — pressing 接受 cannot help', () => {
    const proposals = readPlanProposals(SESSION, 'P-118');
    const sets = proposals.map((proposal) => resolveChangeSet(proposal, new Map(), 7));

    expect(pendingTotal(sets)).toBe(0);
  });

  it('counts what is still open against the current revision', () => {
    const proposals = readPlanProposals(sessionBasedOn(7), 'P-118');
    const proposal = proposals[0];
    const first = proposal?.changeSet.changes[0];
    if (proposal === undefined || first === undefined) {
      throw new Error('fixture lost its proposal');
    }

    expect(pendingTotal(proposals.map((item) => resolveChangeSet(item, new Map(), 7)))).toBe(3);

    const accepted = decisions([[changeDecisionKey(proposal.key, first.id), 'accepted']]);
    expect(pendingTotal(proposals.map((item) => resolveChangeSet(item, accepted, 7)))).toBe(2);
  });
});
