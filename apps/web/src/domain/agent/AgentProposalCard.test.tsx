import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { AgentProposalCard } from './AgentProposalCard';
import { PLAN_PROPOSAL } from './agentFixtures.testing';
import { readPlanChangeSet } from './types';

const CHANGE_SET = readPlanChangeSet(PLAN_PROPOSAL);

describe('AgentProposalCard', () => {
  it('prints the proposal’s title and the server’s own word for its kind', () => {
    const html = renderMarkup(<AgentProposalCard proposal={PLAN_PROPOSAL} changeSet={CHANGE_SET} />);

    expect(html).toContain('把它压到 30 秒以内');
    // `kind` is free text on the wire; it is printed, not mapped to a closed set.
    expect(html).toContain('plan_change');
    expect(html).toContain('data-agent-proposal="plan_change"');
  });

  it('shows both halves of the revision comparison, not just the verdict', () => {
    const html = renderMarkup(
      <AgentProposalCard proposal={PLAN_PROPOSAL} changeSet={CHANGE_SET} currentRevision={7} />,
    );

    expect(html).toContain('基于第 6 版');
    expect(html).toContain('当前第 7 版');
  });

  it('counts only the changes that still need a decision', () => {
    const html = renderMarkup(
      <AgentProposalCard proposal={PLAN_PROPOSAL} changeSet={CHANGE_SET} currentRevision={6} />,
    );

    expect(html).toContain('data-proposal-pending');
    expect(html).toContain('3 项变更待处理');
  });

  it('marks the whole proposal 「已过期」 when its base is behind the plan', () => {
    const html = renderMarkup(
      <AgentProposalCard proposal={PLAN_PROPOSAL} changeSet={CHANGE_SET} currentRevision={7} />,
    );

    expect(html).toContain('data-proposal-state="stale"');
    expect(html).toContain('已过期');
  });

  it('does not call a proposal expired when it is current', () => {
    const html = renderMarkup(
      <AgentProposalCard proposal={PLAN_PROPOSAL} changeSet={CHANGE_SET} currentRevision={6} />,
    );

    expect(html).not.toContain('data-proposal-state="stale"');
  });

  it('says nothing about staleness when nobody said what the revision is', () => {
    const html = renderMarkup(<AgentProposalCard proposal={PLAN_PROPOSAL} changeSet={CHANGE_SET} />);

    expect(html).not.toContain('data-proposal-state');
    expect(html).not.toContain('当前第');
  });

  it('prints the title alone for a payload it does not recognise', () => {
    const unknown = { ...PLAN_PROPOSAL, payload: { totally: 'else' } };
    const html = renderMarkup(<AgentProposalCard proposal={unknown} changeSet={readPlanChangeSet(unknown)} />);

    expect(html).toContain('把它压到 30 秒以内');
    // No cards, and no apology either.
    expect(html).not.toContain('data-proposal-pending');
    expect(html).not.toContain('data-plan-change');
  });

  it('omits the revision line for a proposal that carries no revision', () => {
    const loose = { ...PLAN_PROPOSAL, plan_id: null, based_on_revision: null };
    const html = renderMarkup(<AgentProposalCard proposal={loose} changeSet={readPlanChangeSet(loose)} />);

    expect(html).not.toContain('data-proposal-revision');
  });

  it('wraps whatever the panel puts inside it', () => {
    const html = renderMarkup(
      <AgentProposalCard proposal={PLAN_PROPOSAL} changeSet={CHANGE_SET}>
        <span>三条变更卡</span>
      </AgentProposalCard>,
    );

    expect(html).toContain('三条变更卡');
  });
});
