/*
 * `unit` project — block A's model.
 *
 * The one thing worth stating up front: the ordering test in 「决定与修订」 is
 * §4.5.3 rule ③ itself. Everything else here exists so that ordering keeps
 * working when the file is edited.
 */

import { describe, expect, it } from 'vitest';

import {
  ASSISTANT_ENTRY,
  EDIT_ENTRY,
  PLAN_PROPOSAL,
  PLAN_SHOTS,
  USER_ENTRY,
} from '../../domain/agent/agentFixtures.testing';
import type { AgentSessionEntry, AgentSessionProposal } from '../../shared/desktop/dto';
import { AGENT_MODES } from './agentContract';
import {
  AGENT_MODE_COMPOSER,
  COMPOSER_MODES,
  NO_CHANGE_DECISIONS,
  changeDecisionKey,
  changesForShot,
  collectProposals,
  pendingTotal,
  proposalsByEntry,
  resolveChangeSet,
  shotLabelOf,
  staleTotal,
  withChangeDecision,
} from './conversationModel';

function assistantWith(
  id: string,
  proposals: readonly AgentSessionProposal[],
): AgentSessionEntry {
  return {
    kind: 'assistant',
    id,
    at: '2026-08-15T09:45:00.000Z',
    content: '',
    tool_calls: [],
    proposals: [...proposals],
  };
}

const TRANSCRIPT: readonly AgentSessionEntry[] = [
  USER_ENTRY,
  assistantWith('entry-2', [PLAN_PROPOSAL]),
  EDIT_ENTRY,
];

describe('collectProposals', () => {
  it('carries the user message the proposal answers', () => {
    const slots = collectProposals(TRANSCRIPT);

    expect(slots).toHaveLength(1);
    expect(slots[0]?.prompt).toBe('把它压到 30 秒以内');
    expect(slots[0]?.entryId).toBe('entry-2');
  });

  it('keeps the prompt across a workspace_edit line and a second answer', () => {
    const slots = collectProposals([
      USER_ENTRY,
      assistantWith('a', [PLAN_PROPOSAL]),
      EDIT_ENTRY,
      assistantWith('b', [PLAN_PROPOSAL]),
    ]);

    // 「通知不是提问」 — an edit notice does not end the question it was made
    // during, so the second answer is still an answer to the same one.
    expect(slots.map((slot) => slot.prompt)).toEqual(['把它压到 30 秒以内', '把它压到 30 秒以内']);
  });

  it('leaves the prompt null when the session opens with an answer', () => {
    expect(collectProposals([assistantWith('a', [PLAN_PROPOSAL])])[0]?.prompt).toBeNull();
  });

  it('gives two proposals of one entry distinct keys', () => {
    const slots = collectProposals([assistantWith('a', [PLAN_PROPOSAL, PLAN_PROPOSAL])]);

    expect(new Set(slots.map((slot) => slot.key)).size).toBe(2);
  });

  it('yields nothing for a transcript with no assistant proposals', () => {
    expect(collectProposals([USER_ENTRY, ASSISTANT_ENTRY, EDIT_ENTRY])).toEqual([]);
  });

  it('parses the payload once, and returns null for a shape it does not know', () => {
    const slots = collectProposals([
      assistantWith('a', [{ ...PLAN_PROPOSAL, payload: { note: 'not a change set' } }]),
    ]);

    // 「只印标题」: an unrecognised proposal is still something the Agent said.
    expect(slots[0]?.changeSet).toBeNull();
    expect(slots[0]?.proposal.title).toBe('把它压到 30 秒以内');
  });

  it('groups by entry for the transcript’s per-entry extras', () => {
    const grouped = proposalsByEntry(
      collectProposals([assistantWith('a', [PLAN_PROPOSAL]), assistantWith('b', [PLAN_PROPOSAL])]),
    );

    expect([...grouped.keys()]).toEqual(['a', 'b']);
    expect(grouped.get('a')).toHaveLength(1);
  });
});

describe('withChangeDecision', () => {
  const key = changeDecisionKey('entry-2#0', 'change-1');

  it('records a decision', () => {
    expect(withChangeDecision(NO_CHANGE_DECISIONS, key, 'accepted').get(key)).toBe('accepted');
  });

  it('returns the same map when the decision is already the one asked for', () => {
    const once = withChangeDecision(NO_CHANGE_DECISIONS, key, 'rejected');
    expect(withChangeDecision(once, key, 'rejected')).toBe(once);
  });

  it('returns the same map when clearing a decision nobody made', () => {
    expect(withChangeDecision(NO_CHANGE_DECISIONS, key, null)).toBe(NO_CHANGE_DECISIONS);
  });

  it('clears a decision', () => {
    const once = withChangeDecision(NO_CHANGE_DECISIONS, key, 'accepted');
    expect(withChangeDecision(once, key, null).has(key)).toBe(false);
  });

  it('keys on the slot as well as the change, so two proposals cannot collide', () => {
    const first = withChangeDecision(NO_CHANGE_DECISIONS, changeDecisionKey('a#0', 'c'), 'accepted');
    expect(first.has(changeDecisionKey('b#0', 'c'))).toBe(false);
  });
});

describe('决定与修订: resolveChangeSet applies decisions first, the revision second', () => {
  const slot = collectProposals(TRANSCRIPT)[0]!;

  it('leaves everything pending while the revision has not moved', () => {
    const set = resolveChangeSet(slot, NO_CHANGE_DECISIONS, 6);
    expect(set?.changes.map((change) => change.state)).toEqual(['pending', 'pending', 'pending']);
  });

  it('expires every unhandled change once the plan is ahead', () => {
    const set = resolveChangeSet(slot, NO_CHANGE_DECISIONS, 7);
    expect(set?.changes.map((change) => change.state)).toEqual(['stale', 'stale', 'stale']);
  });

  it('**does not** expire a change the user already accepted', () => {
    const decisions = withChangeDecision(
      NO_CHANGE_DECISIONS,
      changeDecisionKey(slot.key, 'change-1'),
      'accepted',
    );
    const set = resolveChangeSet(slot, decisions, 7);

    expect(set?.changes[0]?.state).toBe('accepted');
    expect(set?.changes[1]?.state).toBe('stale');
  });

  it('does not expire a change the user rejected either', () => {
    const decisions = withChangeDecision(
      NO_CHANGE_DECISIONS,
      changeDecisionKey(slot.key, 'change-3'),
      'rejected',
    );
    expect(resolveChangeSet(slot, decisions, 9)?.changes[2]?.state).toBe('rejected');
  });

  it('calls nothing expired when there is no plan on screen', () => {
    const set = resolveChangeSet(slot, NO_CHANGE_DECISIONS, null);
    expect(set?.changes.every((change) => change.state === 'pending')).toBe(true);
  });

  it('keeps the body of an expired change intact — 过期不等于错误', () => {
    const set = resolveChangeSet(slot, NO_CHANGE_DECISIONS, 7);
    const first = set?.changes[0];

    expect(first?.before).toBe('8.5s');
    expect(first?.after).toBe('3.0s');
    expect(first?.rationale).toContain('只保留从中路进入 A 大道');
    expect(first?.deltaSeconds).toBe(-5.5);
  });

  it('is null for a proposal that carries no change set', () => {
    const unparsed = collectProposals([assistantWith('a', [{ ...PLAN_PROPOSAL, payload: 7 }])])[0]!;
    expect(resolveChangeSet(unparsed, NO_CHANGE_DECISIONS, 6)).toBeNull();
  });
});

describe('changesForShot', () => {
  const changes = resolveChangeSet(collectProposals(TRANSCRIPT)[0]!, NO_CHANGE_DECISIONS, 6)!.changes;

  it('narrows to the selected shot — 2b’s 只影响这一个镜头', () => {
    expect(changesForShot(changes, 'shot-02').map((change) => change.id)).toEqual(['change-1']);
  });

  it('filters nothing when nothing is selected', () => {
    expect(changesForShot(changes, null)).toBe(changes);
  });

  it('returns an empty list rather than everything for a shot nothing touches', () => {
    expect(changesForShot(changes, 'shot-99')).toEqual([]);
  });
});

describe('pendingTotal', () => {
  const slot = collectProposals(TRANSCRIPT)[0]!;

  it('counts only the changes still waiting for a decision', () => {
    const decisions = withChangeDecision(
      NO_CHANGE_DECISIONS,
      changeDecisionKey(slot.key, 'change-1'),
      'accepted',
    );
    expect(pendingTotal([resolveChangeSet(slot, decisions, 6)])).toBe(2);
  });

  it('counts an expired change as handled — it cannot be accepted', () => {
    expect(pendingTotal([resolveChangeSet(slot, NO_CHANGE_DECISIONS, 7)])).toBe(0);
  });

  it('ignores proposals with no change set', () => {
    expect(pendingTotal([null, null])).toBe(0);
  });

  it('counts the expired ones separately, so the head does not contradict the cards', () => {
    const set = resolveChangeSet(slot, NO_CHANGE_DECISIONS, 7);
    expect(pendingTotal([set])).toBe(0);
    expect(staleTotal([set])).toBe(3);
  });

  it('counts nothing expired while the revision matches', () => {
    expect(staleTotal([resolveChangeSet(slot, NO_CHANGE_DECISIONS, 6)])).toBe(0);
  });
});

describe('shotLabelOf', () => {
  it('names the shot a change points at, with the numbering the strip uses', () => {
    expect(shotLabelOf(PLAN_SHOTS, 'shot-02')).toEqual({ number: '02', title: '跟随突破' });
  });

  it('is null for a shot the plan no longer contains, rather than a guess', () => {
    expect(shotLabelOf(PLAN_SHOTS, 'shot-99')).toBeNull();
  });
});

describe('the composer copy table', () => {
  it('covers every mode', () => {
    expect(COMPOSER_MODES).toEqual(AGENT_MODES);
    for (const mode of AGENT_MODES) {
      expect(AGENT_MODE_COMPOSER[mode].placeholder).toBeDefined();
      expect(AGENT_MODE_COMPOSER[mode].sendLabel).toBeDefined();
    }
  });

  it('gives 候选镜头 no suggestion chips, because its own bar needs a Take model', () => {
    expect(AGENT_MODE_COMPOSER.takes.suggestions).toEqual([]);
    expect(AGENT_MODE_COMPOSER.changes.suggestions.length).toBeGreaterThan(0);
  });
});
