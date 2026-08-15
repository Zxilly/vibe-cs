/*
 * `markup` project — what the plan panel draws.
 *
 * The shot cards, the strip and the change cards are `domain/agent` components
 * with their own tests, so what is asserted here is what *this block* decides:
 * which sections exist, what the head counts, that the three states are all
 * three, and — the two that matter most — that an expired change is still
 * readable and that nothing on the panel is waiting for the Agent's approval.
 */

import { describe, expect, it, vi } from 'vitest';

import { useAgentPlan, useRestoreAgentPlanBaseline } from '../../data/plans';
import { useAgentSession } from '../../data/sessions';
import {
  SHOT_CRANE_REMOVED,
  SHOT_TRACKING_EDITED,
} from '../../domain/agent/agentFixtures.testing';
import type { AgentPlan } from '../../shared/desktop/dto';

import { PlanPanel } from './PlanPanel';
import { PLAN, SESSION, SESSION_WITHOUT_PROPOSALS, sessionBasedOn } from './planFixtures.testing';
import {
  CONFIRM_REASON,
  blockProps,
  markupPanel,
  mutationResult,
  queryResult,
} from './test/renderPlanPanel';

vi.mock('../../data/plans', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../data/plans')>();
  return { ...actual, useAgentPlan: vi.fn(), useRestoreAgentPlanBaseline: vi.fn() };
});

vi.mock('../../data/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../data/sessions')>();
  return { ...actual, useAgentSession: vi.fn() };
});

interface Stubs {
  readonly plan?: AgentPlan | undefined;
  readonly planPending?: boolean | undefined;
  readonly planError?: unknown;
  readonly session?: unknown;
}

function stub(overrides: Stubs = {}) {
  vi.mocked(useAgentPlan).mockReturnValue(
    queryResult(overrides.planPending === true ? undefined : (overrides.plan ?? PLAN), {
      isPending: overrides.planPending ?? false,
      ...(overrides.planError === undefined ? {} : { error: overrides.planError }),
    }) as never,
  );
  vi.mocked(useAgentSession).mockReturnValue(
    queryResult(overrides.session === undefined ? SESSION : overrides.session) as never,
  );
  vi.mocked(useRestoreAgentPlanBaseline).mockReturnValue(mutationResult() as never);
}

describe('the head', () => {
  it('prints the revision the server gave it, and the plan’s status', () => {
    stub();
    const html = markupPanel(<PlanPanel {...blockProps()} />);

    expect(html).toContain('data-plan-revision="7"');
    expect(html).toContain('修订 7');
    expect(html).toContain('等待确认');
  });

  it('counts the plan: length, shots, and how much of it the user touched', () => {
    stub({
      plan: { ...PLAN, shots: [PLAN.shots[0]!, SHOT_TRACKING_EDITED, PLAN.shots[2]!, SHOT_CRANE_REMOVED] },
    });
    const html = markupPanel(<PlanPanel {...blockProps()} />);

    // 3.0 + 5.0 + 24.0, with 04 removed and therefore not part of what records.
    expect(html).toContain('32.0s');
    expect(html).toContain('3 个镜头');
    expect(html).toContain('data-plan-touched="2"');
  });

  it('says nothing about edits on a plan the Agent alone wrote', () => {
    stub();
    expect(markupPanel(<PlanPanel {...blockProps()} />)).not.toContain('data-plan-touched');
  });

  it('offers 还原为 Agent 版本, and disables it with a reason when editing is blocked', () => {
    stub();
    const html = markupPanel(
      <PlanPanel {...blockProps({ edit: { disabled: true, disabledReason: '先选择一条会话' } })} />,
    );

    expect(html).toContain('还原为 Agent 版本');
    expect(html).toContain('先选择一条会话');
  });
});

describe('the shots', () => {
  it('draws one card per shot, removed ones included and still readable', () => {
    stub({ plan: { ...PLAN, shots: [PLAN.shots[0]!, SHOT_CRANE_REMOVED] } });
    const html = markupPanel(<PlanPanel {...blockProps()} />);

    expect(html).toContain('data-plan-shot="shot-01"');
    expect(html).toContain('data-plan-shot="shot-04"');
    expect(html).toContain('data-shot-state="removed"');
    // 「你删除的」 with 撤销删除 beside it — a soft delete that stays undoable.
    expect(html).toContain('你删除的');
    expect(html).toContain('撤销删除');
    expect(html).toContain(SHOT_CRANE_REMOVED.rationale);
  });

  it('badges a shot the user edited 「你改过」 and never 「待批准」', () => {
    stub({ plan: { ...PLAN, shots: [SHOT_TRACKING_EDITED] } });
    const html = markupPanel(<PlanPanel {...blockProps()} />);

    expect(html).toContain('data-shot-source="user"');
    expect(html).toContain('你改过');
    for (const word of ['待批准', '等待批准', '待审核', '等待 Agent']) {
      expect(html).not.toContain(word);
    }
  });

  it('drops to the compact density when §8 folded the shell', () => {
    stub();
    const html = markupPanel(<PlanPanel {...blockProps({ collapsed: true })} />);

    expect(html).toContain('data-density="compact"');
    expect(html).not.toContain('data-plan-strip-ruler');
  });
});

describe('the change cards', () => {
  it('lists this plan’s proposal with the revision it was computed against', () => {
    stub();
    const html = markupPanel(<PlanPanel {...blockProps()} />);

    expect(html).toContain('本次变更');
    expect(html).toContain('基于修订 6');
    expect(html).toContain('把它压到 30 秒以内');
  });

  it('expires every unhandled card once the plan moved past the base', () => {
    stub();
    const html = markupPanel(<PlanPanel {...blockProps()} />);

    expect(html).toContain('已过期');
    expect(html).toContain('opacity-55');
    expect(html).toContain('data-plan-stale-notice');
    expect(html).toContain('基于修订 7 重算');
  });

  it('keeps an expired card fully legible — 过期不等于错误', () => {
    stub();
    const html = markupPanel(<PlanPanel {...blockProps()} />);

    expect(html).toContain('只保留从中路进入 A 大道的一段');
    expect(html).toContain('8.5s');
    expect(html).toContain('3.0s');
    expect(html).toContain('结尾会变硬，建议给 03 加 0.5 秒后留白');
  });

  it('shows no expiry banner while the base and the plan agree', () => {
    stub({ session: sessionBasedOn(7) });
    const html = markupPanel(<PlanPanel {...blockProps()} />);

    expect(html).not.toContain('data-plan-stale-notice');
    expect(html).not.toContain('已过期');
  });

  it('says why 接受 is dead on a change whose payload carries nothing to apply', () => {
    stub({ session: sessionBasedOn(7) });
    const html = markupPanel(<PlanPanel {...blockProps()} />);

    // 变更 3 deletes 01, which is applicable; the two deletes and the shorten
    // all are, so the panel offers 接受 rather than a written excuse here.
    expect(html).toContain('接受');
  });

  it('draws no 本次变更 section at all when the session proposed nothing', () => {
    stub({ session: SESSION_WITHOUT_PROPOSALS });
    expect(markupPanel(<PlanPanel {...blockProps()} />)).not.toContain('本次变更');
  });
});

describe('改动来源', () => {
  it('lists every session that moved the plan, newest first, with what it did', () => {
    stub();
    const html = markupPanel(<PlanPanel {...blockProps()} />);

    expect(html).toContain('改动来源');
    expect(html).toContain('在 2 个镜头上做了 3 处改动');
    expect(html).toContain('镜头 02 由 Dolly 改为 Tracking');
    expect(html.indexOf('data-plan-origin="session-kael"')).toBeLessThan(
      html.indexOf('data-plan-origin="session-mirage"'),
    );
  });

  it('marks the session the address already names instead of offering to open it', () => {
    stub();
    const html = markupPanel(<PlanPanel {...blockProps()} />);
    expect(html).toContain('当前');
  });

  it('says so plainly when nothing has touched the plan yet', () => {
    stub({ plan: { ...PLAN, origin: [] } });
    expect(markupPanel(<PlanPanel {...blockProps()} />)).toContain('data-plan-origin-empty');
  });
});

describe('the footer, and rule ①', () => {
  it('points at the one confirmation rather than growing a second one', () => {
    stub();
    const html = markupPanel(<PlanPanel {...blockProps()} />);

    expect(html).toContain('顶栏的「确认并生成视频」');
    expect(html).toContain('data-plan-confirm-reason');
    expect(html).toContain(CONFIRM_REASON);
  });

  it('has no button of its own that could start a recording', () => {
    stub();
    const html = markupPanel(<PlanPanel {...blockProps()} />);

    for (const word of ['开始录制', '立即录制', '生成视频">', '导出']) {
      expect(html).not.toContain(word);
    }
  });
});

describe('the three states', () => {
  it('draws bars, and no invented percentage, while the plan loads', () => {
    stub({ planPending: true });
    const html = markupPanel(<PlanPanel {...blockProps()} />);

    expect(html).toContain('data-plan-panel-skeleton');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toMatch(/\d+%<\//u);
  });

  it('says what is empty and how to leave, with no plan in the address', () => {
    stub();
    const html = markupPanel(<PlanPanel {...blockProps({ context: { plan: null } })} />);

    expect(html).toContain('还没有选中方案');
    expect(html).toContain('返回工作台');
  });

  it('puts the failure next to the thing that failed, with a retry', () => {
    stub({ planError: new Error('读不到'), plan: undefined });
    vi.mocked(useAgentPlan).mockReturnValue(
      queryResult(undefined, { error: new Error('读不到') }) as never,
    );
    const html = markupPanel(<PlanPanel {...blockProps()} />);

    expect(html).toContain('这份方案没能打开');
    expect(html).toContain('重试');
  });

  it('offers the empty plan a way forward instead of an empty list', () => {
    stub({ plan: { ...PLAN, shots: [] } });
    const html = markupPanel(<PlanPanel {...blockProps()} />);

    expect(html).toContain('这份方案还没有镜头');
    expect(html).not.toContain('data-plan-strip');
  });
});
