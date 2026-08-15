/*
 * `markup` project — what block A renders.
 *
 * The bubbles, the change cards and the version cards are `domain/agent`
 * components with their own tests, so what is asserted here is what *this*
 * block decides: which shape the address asked for, which entries become
 * bubbles and which do not, which changes a shape shows, and whether an
 * expired card is still readable.
 */

import { describe, expect, it, vi } from 'vitest';

import { useAgentPlan, useAgentPlanList } from '../../data/plans';
import { useAgentSession, useCreateAgentSession } from '../../data/sessions';
import {
  EDIT_ENTRY,
  PLAN_PROPOSAL,
  PLAN_SHOTS,
  USER_ENTRY,
} from '../../domain/agent/agentFixtures.testing';
import type { AgentPlan, AgentSession, AgentSessionEntry } from '../../shared/desktop/dto';
import { AgentConversationBlock } from './AgentConversationBlock';
import {
  blockProps,
  chatStub,
  markupBlock,
  mutationResult,
  queryResult,
  serviceStub,
  type BlockPropsOverrides,
} from './test/conversationHarness';

vi.mock('../../data/plans', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../data/plans')>();
  return { ...actual, useAgentPlan: vi.fn(), useAgentPlanList: vi.fn() };
});

vi.mock('../../data/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../data/sessions')>();
  return { ...actual, useAgentSession: vi.fn(), useCreateAgentSession: vi.fn() };
});

/* ── fixtures ────────────────────────────────────────────────────────────── */

const ANSWER: AgentSessionEntry = {
  kind: 'assistant',
  id: 'entry-2',
  at: '2026-08-15T09:45:00.000Z',
  content: '给了三条变更：镜头 02 缩短到 3 秒、删除镜头 04、删除镜头 01。',
  tool_calls: [],
  proposals: [PLAN_PROPOSAL],
};

function planFixture(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: 'P-118',
    title: 'Kael · Mirage 1v3 残局',
    status: 'awaiting_confirmation',
    /* The proposal is `based_on_revision: 6`, so this is the current case and
       the stale case is one number away. */
    revision: 6,
    shots: [...PLAN_SHOTS],
    origin: [],
    agent_baseline: { revision: 1, captured_at: '2026-08-15T09:02:00.000Z', shots: [...PLAN_SHOTS] },
    created_at: '2026-08-15T09:02:00.000Z',
    updated_at: '2026-08-15T09:47:00.000Z',
    ...overrides,
  };
}

function sessionFixture(entries: readonly AgentSessionEntry[]): AgentSession {
  return {
    id: 'S-1',
    title: 'Kael 的 1v3',
    created_at: '2026-08-15T09:02:00.000Z',
    updated_at: '2026-08-15T09:47:00.000Z',
    entries: [...entries],
    refs: [],
  };
}

interface Scene {
  readonly plan?: AgentPlan | undefined;
  /** `?plan=` is absent — a real state of `/agent`, not a loading one. */
  readonly noPlan?: boolean | undefined;
  readonly planPending?: boolean | undefined;
  readonly session?: AgentSession | undefined;
  readonly sessionPending?: boolean | undefined;
  readonly sessionError?: unknown;
}

function stage(scene: Scene = {}) {
  vi.mocked(useAgentPlan).mockReturnValue(
    queryResult(
      scene.planPending === true || scene.noPlan === true
        ? undefined
        : (scene.plan ?? planFixture()),
      { isPending: scene.planPending ?? false },
    ) as never,
  );
  vi.mocked(useAgentPlanList).mockReturnValue(queryResult([]) as never);
  vi.mocked(useAgentSession).mockReturnValue(
    queryResult(
      scene.sessionPending === true || scene.sessionError !== undefined
        ? undefined
        : (scene.session ?? sessionFixture([USER_ENTRY, ANSWER, EDIT_ENTRY])),
      {
        isPending: scene.sessionPending ?? false,
        ...(scene.sessionError === undefined ? {} : { error: scene.sessionError }),
      },
    ) as never,
  );
  vi.mocked(useCreateAgentSession).mockReturnValue(mutationResult() as never);
}

function at(overrides: BlockPropsOverrides = {}, scene: Scene = {}): string {
  stage(scene);
  return markupBlock(<AgentConversationBlock {...blockProps(overrides)} />);
}

/* ── the shape switch ────────────────────────────────────────────────────── */

describe('the three shapes', () => {
  it('offers all three and marks the one the address asked for', () => {
    const html = at({ context: { mode: 'inline' } });

    expect(html).toContain('变更列表');
    expect(html).toContain('就地编辑');
    expect(html).toContain('候选镜头');
    expect(html).toContain('data-agent-mode="inline"');
  });

  it('draws a different head per shape', () => {
    expect(at({ context: { mode: 'changes' } })).toContain('data-agent-mode-head="changes"');
    expect(at({ context: { mode: 'inline' } })).toContain('data-agent-mode-head="inline"');
    expect(at({ context: { mode: 'takes' } })).toContain('data-agent-mode-head="takes"');
  });

  it('keeps the conversation in every shape, so a notice is never hidden by one', () => {
    for (const mode of ['changes', 'inline', 'takes'] as const) {
      const html = at({ context: { mode } });
      expect(html).toContain('data-workspace-edit-line=');
      expect(html).toContain('data-agent-composer=');
    }
  });

  it('prints the shape’s own one-line explanation, and folds it away when narrow', () => {
    expect(at()).toContain('每次回应都是一次可逐条接受或拒绝的变更');
    expect(at({ collapsed: true })).not.toContain('每次回应都是一次可逐条接受或拒绝的变更');
  });
});

/* ── the transcript ──────────────────────────────────────────────────────── */

describe('the transcript', () => {
  it('draws the two bubble kinds as bubbles and the edit notice as neither', () => {
    const html = at();

    expect(html).toContain('data-agent-bubble="user"');
    expect(html).toContain('data-agent-bubble="assistant"');
    // §4.5.2: 「通知不进入对话气泡流」.
    expect(html).not.toContain('data-agent-bubble="workspace_edit"');
    expect(html).toContain('data-workspace-edit-line="P-118"');
  });

  it('says there is no session rather than showing an empty log', () => {
    const html = at({ context: { session: null } });

    expect(html).toContain('data-agent-transcript-state="no-session"');
    expect(html).toContain('还没有选择会话');
    expect(html).toContain('新建会话');
  });

  it('shows bars, not a percentage, while the session is loading', () => {
    const html = at({}, { sessionPending: true });

    expect(html).toContain('data-agent-transcript-state="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toMatch(/\d+\s*%\s*</u);
  });

  it('puts a failed read next to the thing that failed, with a retry', () => {
    const html = at({}, { sessionError: new Error('连接被拒绝') });

    expect(html).toContain('data-agent-transcript-state="error"');
    expect(html).toContain('读不到这条会话');
    expect(html).toContain('重试');
  });

  it('offers a way to start when the session is empty', () => {
    const html = at({}, { session: sessionFixture([]) });

    expect(html).toContain('这条会话还没有对话');
    expect(html).toContain('写第一条指令');
  });

  it('draws the reply that is still arriving, without a timestamp', () => {
    const html = at({ chat: chatStub({ streaming: true, draft: '我把第 2 个镜头' }) });

    expect(html).toContain('data-bubble-state="streaming"');
    expect(html).toContain('我把第 2 个镜头');
  });
});

/* ── the change cards ────────────────────────────────────────────────────── */

describe('proposals', () => {
  it('draws one card per change, named after the shot it targets', () => {
    const html = at();

    expect(html).toContain('data-plan-change="change-1"');
    expect(html).toContain('02 跟随突破');
    expect(html).toContain('只保留从中路进入 A 大道的一段');
  });

  it('counts what is waiting, and prints the plan it is measured against', () => {
    const html = at();

    expect(html).toContain('3 项变更待处理');
    expect(html).toContain('修订 6');
  });

  it('says the changes cannot be judged when no plan is selected', () => {
    const html = at({ context: { plan: null } }, { noPlan: true });

    expect(html).toContain('没有选中方案，无法判断这些变更是否仍然成立');
  });

  it('states that accepting does not record, and that a decision is not stored', () => {
    const html = at();

    expect(html).toContain('接受变更不会启动录制');
    expect(html).toContain('你的接受与拒绝暂时只保存在本页');
  });

  it('prints the instruction the proposal answered when the title does not', () => {
    const html = at(
      {},
      {
        session: sessionFixture([
          USER_ENTRY,
          { ...ANSWER, proposals: [{ ...PLAN_PROPOSAL, title: '三条变更' }] },
        ]),
      },
    );

    expect(html).toContain('data-proposal-prompt=');
    expect(html).toContain('把它压到 30 秒以内');
  });
});

describe('§4.5.3 ③ — the revision decides whether a proposal still holds', () => {
  const stale = { plan: planFixture({ revision: 7 }) };

  it('dims an expired card, disables 接受 and labels it', () => {
    const html = at({}, stale);

    expect(html).toContain('data-change-state="stale"');
    expect(html).toContain('opacity-55');
    expect(html).toContain('已过期');
    expect(html).toContain('disabled');
  });

  it('leaves the expired card fully readable — 过期不等于错误', () => {
    const html = at({}, stale);

    expect(html).toContain('02 跟随突破');
    expect(html).toContain('8.5s');
    expect(html).toContain('3.0s');
    expect(html).toContain('只保留从中路进入 A 大道的一段');
    expect(html).toContain('结尾会变硬，建议给 03 加 0.5 秒后留白');
  });

  it('reports the expired ones apart from the ones still waiting', () => {
    const html = at({}, stale);

    expect(html).toContain('没有待处理的变更');
    expect(html).toContain('3 项已过期');
  });

  it('is not expired when the plan is at the revision the proposal was built on', () => {
    expect(at()).not.toContain('data-change-state="stale"');
  });
});

/* ── inline (2b) ─────────────────────────────────────────────────────────── */

describe('就地编辑', () => {
  it('lists the plan’s shots to attach the conversation to', () => {
    const html = at({ context: { mode: 'inline' } });

    expect(html).toContain('data-plan-shot="shot-02"');
    expect(html).toContain('data-density="compact"');
  });

  it('asks for a plan, with the plans the backend has, when none is selected', () => {
    const html = at({ context: { mode: 'inline', plan: null } }, { noPlan: true });

    expect(html).toContain('就地编辑需要一个方案');
  });

  it('scopes the composer to the whole plan until a shot is picked', () => {
    const html = at({ context: { mode: 'inline' } });

    expect(html).toContain('手动编辑不会打断 Agent，也不需要它批准');
  });
});

/* ── takes (2c) ──────────────────────────────────────────────────────────── */

describe('候选镜头', () => {
  it('compares the two versions the wire actually has', () => {
    const html = at({ context: { mode: 'takes' } });

    expect(html).toContain('data-take-card=');
    expect(html).toContain('Agent 版本');
    expect(html).toContain('当前');
    expect(html).toContain('修订 1');
    expect(html).toContain('修订 6');
  });

  it('says the branch model is missing instead of inventing takes', () => {
    const html = at({ context: { mode: 'takes' } });

    expect(html).toContain('后端还没有 Take 模型');
    expect(html).not.toContain('Take A');
    // No composition panel: `Composition` has no wire type either.
    expect(html).not.toContain('data-composition-slot=');
    expect(html).not.toContain('data-take-use=');
  });

  it('shows one version when the plan has not moved off the Agent’s', () => {
    const html = at({ context: { mode: 'takes' } }, { plan: planFixture({ revision: 1 }) });

    expect(html).toContain('这个方案还没有偏离 Agent 版本');
  });
});

/* ── the composer ────────────────────────────────────────────────────────── */

describe('the instruction bar', () => {
  it('uses each shape’s own placeholder and chips', () => {
    expect(at()).toContain('给方案下一条指令');
    expect(at()).toContain('压到 30 秒');
    expect(at({ context: { mode: 'inline' } })).toContain('对选中的镜头说');
    // 2c's own bar is 「再生成一条 take」, which needs a model nobody has.
    expect(at({ context: { mode: 'takes' } })).not.toContain('data-composer-suggestions=');
  });

  it('disables sending with a written reason when there is no session', () => {
    const html = at({ context: { session: null } });

    expect(html).toContain('先选择或新建一条会话');
  });

  it('disables sending with the service’s own reason when the service is down', () => {
    const html = at({ service: serviceStub(true) });

    expect(html).toContain('本地服务未连接');
  });

  it('offers 停止 only while a reply is arriving', () => {
    expect(at()).not.toContain('data-composer-cancel=');
    expect(at({ chat: chatStub({ streaming: true, draft: '…' }) })).toContain('data-composer-cancel=');
  });

  it('surfaces a failed reply in place, with a retry', () => {
    const html = at({ chat: chatStub({ error: '模型没有响应' }) });

    expect(html).toContain('这次回答没有完成');
    expect(html).toContain('模型没有响应');
  });
});
