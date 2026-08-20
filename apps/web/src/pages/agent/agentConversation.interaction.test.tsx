/*
 * `interaction` project — block A's behaviour, with the queries mocked.
 *
 * What needs a DOM and cannot be reached from `conversationModel.test.ts`: that
 * a decision reaches the card, that it *survives a shape switch*, that picking
 * a shot narrows the change list and the composer, and that the instruction bar
 * sends what the user typed and stops what the Agent is saying.
 *
 * The 「录制只由一次显式确认启动」 assertions are not here — with the hooks
 * mocked there is no client to observe, and an assertion that nothing was
 * called on nothing is not an assertion. They live in
 * `agentConversationLive.interaction.test.tsx`, against a real bridge stub.
 */

import { fireEvent, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useAgentPlan, useAgentPlanList } from '../../data/plans';
import { useAgentSession, useCreateAgentSession } from '../../data/sessions';
import { PLAN_PROPOSAL, PLAN_SHOTS, USER_ENTRY } from '../../domain/agent/agentFixtures.testing';
import type { AgentPlan, AgentSession, AgentSessionEntry } from '../../shared/desktop/dto';
import { AgentConversationBlock } from './AgentConversationBlock';
import {
  patchAgentContext,
  type AgentContextPatch,
  type AgentRouteContext,
} from './agentContract';
import { ChangeDeskHost } from './test/changeDeskHost';
import {
  blockProps,
  chatStub,
  editNotifierStub,
  mutationResult,
  queryResult,
  renderBlock,
} from './test/conversationHarness';

vi.mock('../../data/plans', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../data/plans')>();
  return { ...actual, useAgentPlan: vi.fn(), useAgentPlanList: vi.fn() };
});

vi.mock('../../data/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../data/sessions')>();
  return { ...actual, useAgentSession: vi.fn(), useCreateAgentSession: vi.fn() };
});

const ANSWER: AgentSessionEntry = {
  kind: 'assistant',
  id: 'entry-2',
  at: '2026-08-15T09:45:00.000Z',
  content: '给了三条变更。',
  tool_calls: [],
  proposals: [PLAN_PROPOSAL],
};

const PLAN: AgentPlan = {
  id: 'P-118',
  title: 'Kael · Mirage 1v3 残局',
  status: 'awaiting_confirmation',
  revision: 6,
  shots: [...PLAN_SHOTS],
  origin: [],
  agent_baseline: { revision: 1, captured_at: '2026-08-15T09:02:00.000Z', shots: [...PLAN_SHOTS] },
  created_at: '2026-08-15T09:02:00.000Z',
  updated_at: '2026-08-15T09:47:00.000Z',
};

const SESSION: AgentSession = {
  id: 'S-1',
  title: 'Kael 的 1v3',
  created_at: '2026-08-15T09:02:00.000Z',
  updated_at: '2026-08-15T09:47:00.000Z',
  entries: [USER_ENTRY, ANSWER],
  refs: [],
};

function stage() {
  vi.mocked(useAgentPlan).mockReturnValue(queryResult(PLAN) as never);
  vi.mocked(useAgentPlanList).mockReturnValue(queryResult([]) as never);
  vi.mocked(useAgentSession).mockReturnValue(queryResult(SESSION) as never);
  vi.mocked(useCreateAgentSession).mockReturnValue(mutationResult() as never);
}

/**
 * The shell, reduced to the two things it does for this block: own the address,
 * and own the change desk. The desk is the real `useAgentChangeDesk`
 * (`ChangeDeskHost`), because 接受 is not a colour change — it applies the
 * change to the plan and records the edit, and a stub would hide both.
 */
function Controlled({
  initial,
  onPatch,
  chat,
}: {
  readonly initial: AgentRouteContext;
  readonly onPatch?: ((patch: AgentContextPatch) => void) | undefined;
  readonly chat?: ReturnType<typeof chatStub> | undefined;
}) {
  const [context, setContext] = useState(initial);
  const [notifier] = useState(editNotifierStub);
  return (
    <ChangeDeskHost planId={context.plan} shots={PLAN.shots} editNotifier={notifier}>
      {(changes) => (
        <AgentConversationBlock
          {...blockProps({
            context,
            changes,
            editNotifier: notifier,
            ...(chat === undefined ? {} : { chat }),
            updateContext: (patch) => {
              onPatch?.(patch);
              setContext((current) => patchAgentContext(current, patch));
            },
          })}
        />
      )}
    </ChangeDeskHost>
  );
}

const CHANGES: AgentRouteContext = { plan: 'P-118', session: 'S-1', mode: 'changes' };

function card(id: string): HTMLElement {
  const element = document.querySelector(`[data-plan-change="${id}"]`);
  if (element === null) throw new Error(`no change card ${id}`);
  return element as HTMLElement;
}

/* ── decisions ───────────────────────────────────────────────────────────── */

describe('accepting and rejecting a change', () => {
  it('records the decision on the card the user clicked, and only that one', () => {
    stage();
    renderBlock(<Controlled initial={CHANGES} />);

    fireEvent.click(within(card('change-1')).getByRole('button', { name: '接受' }));

    expect(card('change-1').getAttribute('data-change-state')).toBe('accepted');
    expect(card('change-2').getAttribute('data-change-state')).toBe('pending');
  });

  it('turns a rejected card into 撤销拒绝, and takes the rejection back', () => {
    stage();
    renderBlock(<Controlled initial={CHANGES} />);

    fireEvent.click(within(card('change-2')).getByRole('button', { name: '拒绝' }));
    expect(card('change-2').getAttribute('data-change-state')).toBe('rejected');

    fireEvent.click(within(card('change-2')).getByRole('button', { name: '撤销拒绝' }));
    expect(card('change-2').getAttribute('data-change-state')).toBe('accepted');
  });

  it('counts down 「N 项变更待处理」 as decisions are made', () => {
    stage();
    renderBlock(<Controlled initial={CHANGES} />);

    // The proposal card prints the same count for its own changes, so this
    // reads the head deliberately: it is the whole-session total.
    const head = () => within(document.querySelector('[data-agent-mode-head="changes"]')!);

    expect(head().getByText('3 项变更待处理')).toBeTruthy();
    fireEvent.click(within(card('change-1')).getByRole('button', { name: '接受' }));
    expect(head().getByText('2 项变更待处理')).toBeTruthy();
  });
});

/* ── the shape switch ────────────────────────────────────────────────────── */

describe('switching shape', () => {
  it('changes only the mode — the plan and the session are untouched', () => {
    stage();
    const onPatch = vi.fn();
    renderBlock(<Controlled initial={CHANGES} onPatch={onPatch} />);

    fireEvent.click(screen.getByRole('radio', { name: '就地编辑' }));

    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenCalledWith({ mode: 'inline' });
  });

  it('keeps the decisions the user already made', () => {
    stage();
    renderBlock(<Controlled initial={CHANGES} />);

    fireEvent.click(within(card('change-1')).getByRole('button', { name: '接受' }));
    fireEvent.click(screen.getByRole('radio', { name: '版本比较' }));
    fireEvent.click(screen.getByRole('radio', { name: '修改列表' }));

    // A decision that vanished because the user looked at another shape would
    // be data loss the user caused by navigating.
    expect(card('change-1').getAttribute('data-change-state')).toBe('accepted');
  });

  it('keeps the shot the user picked', () => {
    stage();
    renderBlock(<Controlled initial={{ ...CHANGES, mode: 'inline' }} />);

    fireEvent.click(within(shot('shot-02')).getByRole('button', { name: /跟随突破/u }));
    expect(screen.getByText(/只影响这一个镜头/u)).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: '修改列表' }));
    fireEvent.click(screen.getByRole('radio', { name: '就地编辑' }));

    expect(screen.getByText(/只影响这一个镜头/u)).toBeTruthy();
  });
});

function shot(id: string): HTMLElement {
  const element = document.querySelector(`[data-plan-shot="${id}"]`);
  if (element === null) throw new Error(`no shot row ${id}`);
  return element as HTMLElement;
}

/* ── inline (2b) ─────────────────────────────────────────────────────────── */

describe('就地编辑 attaches the conversation to one shot', () => {
  it('narrows the change cards to the selected shot', () => {
    stage();
    renderBlock(<Controlled initial={{ ...CHANGES, mode: 'inline' }} />);

    expect(document.querySelectorAll('[data-plan-change]')).toHaveLength(3);

    fireEvent.click(within(shot('shot-02')).getByRole('button', { name: /跟随突破/u }));

    const remaining = [...document.querySelectorAll('[data-plan-change]')].map((element) =>
      element.getAttribute('data-plan-change'),
    );
    expect(remaining).toEqual(['change-1']);
  });

  it('says so when the proposal does not touch the selected shot', () => {
    stage();
    renderBlock(<Controlled initial={{ ...CHANGES, mode: 'inline' }} />);

    fireEvent.click(within(shot('shot-03')).getByRole('button', { name: /选手 POV/u }));

    expect(screen.getByText('这条提议没有涉及选中的镜头。')).toBeTruthy();
    expect(document.querySelectorAll('[data-plan-change]')).toHaveLength(0);
  });

  it('clears the filter when the selected shot is clicked again', () => {
    stage();
    renderBlock(<Controlled initial={{ ...CHANGES, mode: 'inline' }} />);

    const select = within(shot('shot-02')).getByRole('button', { name: /跟随突破/u });
    fireEvent.click(select);
    fireEvent.click(select);

    expect(document.querySelectorAll('[data-plan-change]')).toHaveLength(3);
  });

  it('leaves the filter behind when the shape is not 就地编辑', () => {
    stage();
    renderBlock(<Controlled initial={{ ...CHANGES, mode: 'inline' }} />);

    fireEvent.click(within(shot('shot-02')).getByRole('button', { name: /跟随突破/u }));
    fireEvent.click(screen.getByRole('radio', { name: '修改列表' }));

    expect(document.querySelectorAll('[data-plan-change]')).toHaveLength(3);
  });
});

/* ── the instruction bar ─────────────────────────────────────────────────── */

describe('the instruction bar', () => {
  it('sends what was typed, and empties the box', () => {
    stage();
    const chat = chatStub();
    renderBlock(<Controlled initial={CHANGES} chat={chat} />);

    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: '  把它压到 30 秒以内  ' } });
    fireEvent.click(screen.getByRole('button', { name: '生成变更' }));

    expect(chat.send).toHaveBeenCalledWith({ message: '把它压到 30 秒以内', sessionId: 'S-1' });
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it('sends on ⌘↵ but not on a plain ↵, so a second line stays typable', () => {
    stage();
    const chat = chatStub();
    renderBlock(<Controlled initial={CHANGES} chat={chat} />);

    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: '02 再短一点' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(chat.send).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(chat.send).toHaveBeenCalledTimes(1);
  });

  it('refuses to send an empty box, without inventing a reason for it', () => {
    stage();
    const chat = chatStub();
    renderBlock(<Controlled initial={CHANGES} chat={chat} />);

    const send = screen.getByRole('button', { name: '生成变更' });
    expect(send.hasAttribute('disabled')).toBe(true);
    fireEvent.click(send);
    expect(chat.send).not.toHaveBeenCalled();
  });

  it('drops a chip into the box rather than sending it', () => {
    stage();
    const chat = chatStub();
    renderBlock(<Controlled initial={CHANGES} chat={chat} />);

    fireEvent.click(screen.getByRole('button', { name: '压到 30 秒' }));

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('压到 30 秒');
    expect(chat.send).not.toHaveBeenCalled();
  });

  it('stops a reply that is arriving, and does not send anything to do it', () => {
    stage();
    const chat = chatStub({ streaming: true, draft: '我把第 2 个' });
    renderBlock(<Controlled initial={CHANGES} chat={chat} />);

    fireEvent.click(screen.getByRole('button', { name: '停止' }));

    expect(chat.cancel).toHaveBeenCalledTimes(1);
    expect(chat.send).not.toHaveBeenCalled();
  });

  it('retries the message that failed, not an empty one', () => {
    stage();
    const chat = chatStub({ error: '模型没有响应' });
    renderBlock(<Controlled initial={CHANGES} chat={chat} />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '压到 30 秒' } });
    fireEvent.click(screen.getByRole('button', { name: '生成变更' }));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(chat.send).toHaveBeenCalledTimes(2);
    expect(chat.send).toHaveBeenLastCalledWith({ message: '压到 30 秒' });
  });
});
