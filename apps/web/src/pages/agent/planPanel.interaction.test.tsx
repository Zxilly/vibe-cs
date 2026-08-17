/*
 * `interaction` project — editing a plan by hand (§4.5.3 rules ② and ③).
 *
 * Everything here is about what pressing a button does to the *notifier* and to
 * the plan on screen, with the two queries stubbed. What it deliberately never
 * asserts is that a request went out: the write is the shell's, five seconds
 * later, and `planEditFlush.interaction.test.tsx` is where that half lives.
 */

import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentPlan, useRestoreAgentPlanBaseline } from '../../data/plans';
import { useAgentSession } from '../../data/sessions';
import { SHOT_CRANE_REMOVED } from '../../domain/agent/agentFixtures.testing';
import type { AgentPlan } from '../../shared/desktop/dto';

import { PlanPanel } from './PlanPanel';
import { PLAN, SESSION, sessionBasedOn } from './planFixtures.testing';
import { ChangeDeskHost } from './test/changeDeskHost';
import {
  blockProps,
  mutationResult,
  queryResult,
  recordingNotifier,
  renderPanel,
  type RecordingNotifier,
} from './test/renderPlanPanel';
import { reasonOf } from '../../test/reason';

vi.mock('../../data/plans', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../data/plans')>();
  return { ...actual, useAgentPlan: vi.fn(), useRestoreAgentPlanBaseline: vi.fn() };
});

vi.mock('../../data/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../data/sessions')>();
  return { ...actual, useAgentSession: vi.fn() };
});

interface Harness {
  readonly notifier: RecordingNotifier;
  readonly restoreMutate: ReturnType<typeof vi.fn>;
  readonly send: ReturnType<typeof vi.fn>;
  readonly updateContext: ReturnType<typeof vi.fn>;
}

function mount(
  options: {
    readonly plan?: AgentPlan | undefined;
    readonly session?: unknown;
    readonly edit?: { disabled: boolean; disabledReason?: string } | undefined;
  } = {},
): Harness {
  const notifier = recordingNotifier();
  const restoreMutate = vi.fn();
  const send = vi.fn(() => Promise.resolve());
  const updateContext = vi.fn();
  const plan = options.plan ?? PLAN;

  vi.mocked(useAgentPlan).mockReturnValue(queryResult(plan) as never);
  vi.mocked(useAgentSession).mockReturnValue(
    queryResult(options.session === undefined ? SESSION : options.session) as never,
  );
  vi.mocked(useRestoreAgentPlanBaseline).mockReturnValue(
    mutationResult({ mutate: restoreMutate }) as never,
  );

  /* The desk is the shell's, and it is the real one: 接受 has to apply the
     change to the plan and record the edit, not tick a stub. */
  renderPanel(
    <ChangeDeskHost planId={plan.id} shots={plan.shots} editNotifier={notifier}>
      {(changes) => (
        <PlanPanel
          {...blockProps({
            editNotifier: notifier,
            changes,
            updateContext,
            chat: { send: send as never },
            ...(options.edit === undefined ? {} : { edit: options.edit }),
          })}
        />
      )}
    </ChangeDeskHost>,
  );

  return { notifier, restoreMutate, send, updateContext };
}

function shotCard(id: string): HTMLElement {
  const card = document.querySelector(`[data-plan-shot="${id}"]`);
  if (card === null) throw new Error(`no shot card ${id}`);
  return card as HTMLElement;
}

function changeCard(id: string): HTMLElement {
  const card = document.querySelector(`[data-plan-change="${id}"]`);
  if (card === null) throw new Error(`no change card ${id}`);
  return card as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('opening and leaving the edit card', () => {
  it('opens on 编辑 with the shot’s own values in the fields', () => {
    mount();
    fireEvent.click(within(shotCard('shot-02')).getByRole('button', { name: '编辑' }));

    const form = screen.getByRole('form', { name: /编辑镜头 02/u });
    expect(within(form).getByLabelText('镜头标题')).toHaveProperty('value', '跟随突破');
    expect(within(form).getByLabelText('时长')).toHaveProperty('value', '8.5');
  });

  it('closes on 放弃 without telling the Agent anything', () => {
    const { notifier } = mount();
    fireEvent.click(within(shotCard('shot-02')).getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('时长'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: '放弃' }));

    expect(screen.queryByRole('form')).toBeNull();
    expect(notifier.records).toEqual([]);
  });

  it('closes on Escape, which the card says it does', () => {
    mount();
    fireEvent.click(within(shotCard('shot-02')).getByRole('button', { name: '编辑' }));
    fireEvent.keyDown(screen.getByRole('form'), { key: 'Escape' });

    expect(screen.queryByRole('form')).toBeNull();
  });

  it('refuses to save a field the plan cannot hold, and says which', () => {
    mount();
    fireEvent.click(within(shotCard('shot-02')).getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('时长'), { target: { value: '八秒' } });

    const save = screen.getByRole('button', { name: '保存改动' });
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/时长要写成一个不小于 0 的秒数/u)).toBeTruthy();
  });
});

describe('saving an edit', () => {
  it('hands the notifier one line naming the dto field, with the whole plan', () => {
    const { notifier } = mount();
    fireEvent.click(within(shotCard('shot-02')).getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('时长'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: '保存改动' }));

    expect(notifier.records).toHaveLength(1);
    expect(notifier.records[0]?.change).toEqual({
      shot: 2,
      op: 'updated',
      field: 'duration_seconds',
      from: '8.5s',
      to: '5.0s',
    });
    expect(notifier.records[0]?.shots).toHaveLength(PLAN.shots.length);
    expect(notifier.records[0]?.planId).toBe('P-118');
  });

  it('takes effect immediately — no approval, no pending state, no flush', () => {
    const { notifier } = mount();
    fireEvent.click(within(shotCard('shot-02')).getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('时长'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: '保存改动' }));

    // §4.5.3 ②: the card comes back badged as the user's, and nothing waits.
    expect(shotCard('shot-02').querySelector('[data-shot-source="user"]')).not.toBeNull();
    expect(within(shotCard('shot-02')).getByText('你改过')).toBeTruthy();
    expect(screen.queryByText(/待批准|等待批准|待审核/u)).toBeNull();
    // §4.5.4: the notice is buffered, not written — that is the window's job.
    expect(notifier.flushes).toEqual([]);
  });

  it('carries the user’s note through as the notice’s note', () => {
    const { notifier } = mount();
    fireEvent.click(within(shotCard('shot-02')).getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('时长'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText(/这次改动的说明/u), {
      target: { value: '起手那段留给建立镜头交代' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存改动' }));

    expect(notifier.records[0]?.note).toBe('起手那段留给建立镜头交代');
  });

  it('says nothing when the save moved nothing', () => {
    const { notifier } = mount();
    fireEvent.click(within(shotCard('shot-02')).getByRole('button', { name: '编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '保存改动' }));

    expect(notifier.records).toEqual([]);
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('renders the fields read-only, with the reason, when there is no session', () => {
    mount({ edit: { disabled: true, disabledReason: '编辑会记入会话，请先选择或新建一条会话' } });

    const editButton = within(shotCard('shot-02')).getByRole('button', { name: '编辑' });
    expect(editButton.hasAttribute('disabled')).toBe(true);
    // `Button` states the reason twice — as a `title` and as a described-by
    // line — so 「不隐藏、不静默失败」 holds for pointer and reader alike.
    expect(reasonOf(editButton)).toContain('编辑会记入会话，请先选择或新建一条会话');
    expect(screen.getAllByText(/编辑会记入会话，请先选择或新建一条会话/u).length).toBeGreaterThan(0);
  });
});

describe('删除 and 撤销删除', () => {
  it('removes softly and keeps the card, its number and its text', () => {
    const { notifier } = mount();
    fireEvent.click(within(shotCard('shot-04')).getByRole('button', { name: '删除' }));

    expect(notifier.records[0]?.change).toEqual({
      shot: 4,
      op: 'removed',
      field: null,
      from: null,
      to: null,
    });
    expect(shotCard('shot-04').getAttribute('data-shot-state')).toBe('removed');
    expect(within(shotCard('shot-04')).getByText('高潮后升起')).toBeTruthy();
  });

  it('offers 撤销删除 and restores on it', () => {
    const { notifier } = mount();
    fireEvent.click(within(shotCard('shot-04')).getByRole('button', { name: '删除' }));
    fireEvent.click(within(shotCard('shot-04')).getByRole('button', { name: '撤销删除' }));

    expect(notifier.records.map((record) => record.change.op)).toEqual(['removed', 'restored']);
    expect(shotCard('shot-04').getAttribute('data-shot-state')).toBeNull();
  });

  it('restores a shot that arrived already removed from the server', () => {
    const { notifier } = mount({ plan: { ...PLAN, shots: [SHOT_CRANE_REMOVED] } });
    fireEvent.click(screen.getByRole('button', { name: '撤销删除' }));

    expect(notifier.records[0]?.change.op).toBe('restored');
  });
});

describe('the Agent’s change cards', () => {
  it('applies an accepted change as an ordinary edit, and marks the card', () => {
    const { notifier } = mount({ session: sessionBasedOn(7) });
    fireEvent.click(
      within(changeCard('change-1')).getByRole('button', { name: '接受' }),
    );

    expect(notifier.records[0]?.change).toEqual({
      shot: 2,
      op: 'updated',
      field: 'duration_seconds',
      from: '8.5s',
      to: '3.0s',
    });
    expect(changeCard('change-1').getAttribute('data-change-state')).toBe('accepted');
  });

  it('leaves the accepted shot the Agent’s work rather than stamping it 你改过', () => {
    mount({ session: sessionBasedOn(7) });
    fireEvent.click(within(changeCard('change-1')).getByRole('button', { name: '接受' }));

    expect(shotCard('shot-02').querySelector('[data-shot-source="agent"]')).not.toBeNull();
  });

  it('rejects without touching the plan', () => {
    const { notifier } = mount({ session: sessionBasedOn(7) });
    fireEvent.click(within(changeCard('change-3')).getByRole('button', { name: '拒绝' }));

    expect(notifier.records).toEqual([]);
    expect(changeCard('change-3').getAttribute('data-change-state')).toBe('rejected');
    expect(within(changeCard('change-3')).getByRole('button', { name: '撤销拒绝' })).toBeTruthy();
  });

  it('never re-marks a decided card once the revision moves past it', () => {
    // The fixture session is based on revision 6 and the plan is at 7, so every
    // undecided card is stale — but a rejection is a decision, and stands.
    mount();
    fireEvent.click(within(changeCard('change-3')).getByRole('button', { name: '拒绝' }));

    expect(changeCard('change-3').getAttribute('data-change-state')).toBe('rejected');
    expect(changeCard('change-1').getAttribute('data-change-state')).toBe('stale');
  });

  it('disables 接受 on an expired card, with the reason, and keeps the body', () => {
    const { notifier } = mount();
    const accept = within(changeCard('change-1')).getByRole('button', { name: '接受' });

    expect(accept.hasAttribute('disabled')).toBe(true);
    expect(screen.getAllByText(/基于方案的旧版本/u).length).toBeGreaterThan(0);
    expect(within(changeCard('change-1')).getByText(/只保留从中路进入 A 大道的一段/u)).toBeTruthy();

    fireEvent.click(accept);
    expect(notifier.records).toEqual([]);
  });

  it('throws every expired card away at once on 全部丢弃', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: '全部丢弃' }));

    for (const id of ['change-1', 'change-2', 'change-3']) {
      expect(changeCard(id).getAttribute('data-change-state')).toBe('rejected');
    }
  });

  it('asks the Agent to recompute against the revision the plan is actually at', () => {
    const { send } = mount();
    fireEvent.click(screen.getByRole('button', { name: /基于第 7 版重算/u }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(String((send.mock.calls[0]?.[0] as { message: string }).message)).toContain('第 7 版');
  });

  it('cannot recompute while the Agent is already speaking', () => {
    const notifier = recordingNotifier();
    vi.mocked(useAgentPlan).mockReturnValue(queryResult(PLAN) as never);
    vi.mocked(useAgentSession).mockReturnValue(queryResult(SESSION) as never);
    vi.mocked(useRestoreAgentPlanBaseline).mockReturnValue(mutationResult() as never);

    renderPanel(
      <ChangeDeskHost planId={PLAN.id} shots={PLAN.shots} editNotifier={notifier}>
        {(changes) => (
          <PlanPanel
            {...blockProps({ editNotifier: notifier, changes, chat: { streaming: true } })}
          />
        )}
      </ChangeDeskHost>,
    );

    expect(
      screen.getByRole('button', { name: /基于第 7 版重算/u }).hasAttribute('disabled'),
    ).toBe(true);
  });
});

describe('还原为 Agent 版本', () => {
  it('asks first — the confirmation is a dialog, not the button', () => {
    const { restoreMutate } = mount();
    fireEvent.click(screen.getByRole('button', { name: '还原为 Agent 版本' }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(restoreMutate).not.toHaveBeenCalled();
  });

  it('writes the pending notice out before it replaces the plan', async () => {
    const { notifier, restoreMutate } = mount();
    fireEvent.click(within(shotCard('shot-04')).getByRole('button', { name: '删除' }));
    fireEvent.click(screen.getByRole('button', { name: '还原为 Agent 版本' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '还原' }));

    await vi.waitFor(() => {
      expect(restoreMutate).toHaveBeenCalledTimes(1);
    });
    // Its own reason: a restore is not a plan switch, and the log is what a
    // lost notice is diagnosed from.
    expect(notifier.flushes).toContain('restore');
    expect(restoreMutate.mock.calls[0]?.[0]).toMatchObject({
      plan_id: 'P-118',
      expected_revision: 7,
      origin: { session_id: 'session-kael' },
    });
  });

  it('does nothing at all when the dialog is dismissed', () => {
    const { restoreMutate, notifier } = mount();
    fireEvent.click(screen.getByRole('button', { name: '还原为 Agent 版本' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));

    expect(restoreMutate).not.toHaveBeenCalled();
    expect(notifier.flushes).toEqual([]);
  });
});

describe('改动来源', () => {
  it('walks to the session that made a change without clearing the plan', () => {
    const { updateContext } = mount();
    fireEvent.click(screen.getByRole('button', { name: '打开这条会话' }));

    expect(updateContext).toHaveBeenCalledWith({ session: 'session-mirage' });
  });
});
