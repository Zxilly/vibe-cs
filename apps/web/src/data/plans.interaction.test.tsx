/*
 * `interaction` project — the plan writes, their invalidation chain, and the
 * one rule that is proved by what is *not* called.
 *
 * §4.5.3 rule ①: 「录制只由一次显式确认启动。接受变更不触发录制，手动编辑不触发
 * 录制，切换会话不触发录制。」 The client stub here is a recording proxy: every
 * method the hooks reach is logged, and the assertion is that none of them can
 * start anything.
 */

import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AgentPlan, AgentPlanShot } from '../shared/desktop/dto';
import type { DesktopClientStub } from './desktopClient';
import { isRevisionConflict, useAgentPlan, useApplyAgentPlanEdit, useRestoreAgentPlanBaseline } from './plans';
import { useAgentObjectSessions, useAgentSessionList } from './sessions';
import { countingStub, renderDataHook } from './test/renderDataHook';

const SHOT: AgentPlanShot = {
  id: 'shot-2',
  title: '跟随突破',
  kind: 'tracking',
  view: 'observer',
  start_tick: 148_812,
  end_tick: 149_132,
  duration_seconds: 5,
  rationale: '沿他的真实移动轴从中路跟到 A 大道',
  evidence_refs: [],
  risks: [],
  source: 'user',
  removed_by: null,
  params: null,
};

function plan(revision: number): AgentPlan {
  return {
    id: 'P-118',
    title: 'Kael Mirage 1v3',
    status: 'awaiting_confirmation',
    revision,
    shots: [SHOT],
    origin: [],
    agent_baseline: { revision: 1, captured_at: '2026-08-15T09:02:00.000Z', shots: [SHOT] },
    created_at: '2026-08-15T09:02:00.000Z',
    updated_at: '2026-08-15T09:47:00.000Z',
  };
}

const EDIT = {
  plan_id: 'P-118',
  expected_revision: 6,
  status: 'awaiting_confirmation' as const,
  shots: [SHOT],
  origin: { session_id: 'S-1', session_title: 'Kael 的 1v3', summary: '1 处改动' },
  changes: [
    { shot: 2, op: 'updated' as const, field: 'duration', from: '8.5s', to: '5.0s' },
  ],
  note: null,
};

describe('useApplyAgentPlanEdit', () => {
  it('refreshes the plan, its 改动来源 and the session that got the notice', async () => {
    const read = countingStub(plan(6));
    const sessions = countingStub({ items: [], total: 0 });
    const origin = countingStub([]);
    const edit = countingStub(plan(7));
    const client: DesktopClientStub = {
      getAgentPlan: read.call,
      listAgentSessions: sessions.call,
      listAgentObjectSessions: origin.call,
      applyAgentPlanEdit: edit.call,
    };

    const { result } = renderDataHook(
      () => ({
        plan: useAgentPlan('P-118'),
        sessions: useAgentSessionList(),
        origin: useAgentObjectSessions('plan', 'P-118'),
        edit: useApplyAgentPlanEdit(),
      }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.plan.isSuccess).toBe(true);
      expect(result.current.sessions.isSuccess).toBe(true);
      expect(result.current.origin.isSuccess).toBe(true);
    });
    const before = {
      plan: read.calls(),
      sessions: sessions.calls(),
      origin: origin.calls(),
    };

    await act(async () => {
      await result.current.edit.mutateAsync(EDIT);
    });

    await waitFor(() => {
      expect(read.calls()).toBeGreaterThan(before.plan);
      expect(sessions.calls()).toBeGreaterThan(before.sessions);
      expect(origin.calls()).toBeGreaterThan(before.origin);
    });
  });

  it('keeps the new revision even when the refetch that follows it fails', async () => {
    /* The write answers with the plan it produced, so the cache is set from it
       directly as well as invalidated. Without that, a flaky refetch would
       leave the panel looking at revision 6 while its next edit went out with
       `expected_revision: 6` and 409'd immediately. */
    let reads = 0;
    const client: DesktopClientStub = {
      getAgentPlan: () => {
        reads += 1;
        if (reads === 1) return Promise.resolve(plan(6));
        return Promise.reject(new Error('本地服务未连接'));
      },
      applyAgentPlanEdit: () => Promise.resolve(plan(7)),
    };

    const { result } = renderDataHook(
      () => ({ plan: useAgentPlan('P-118'), edit: useApplyAgentPlanEdit() }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.plan.data?.revision).toBe(6);
    });

    await act(async () => {
      await result.current.edit.mutateAsync(EDIT);
    });

    await waitFor(() => {
      expect(result.current.plan.data?.revision).toBe(7);
    });
    // The refetch really did run, and really did fail.
    expect(reads).toBeGreaterThan(1);
    expect(result.current.plan.isError).toBe(true);
  });

  it('sends the whole shot array and the conditional revision, unchanged', async () => {
    const edit = countingStub(plan(7));
    const { result } = renderDataHook(() => useApplyAgentPlanEdit(), {
      client: { applyAgentPlanEdit: edit.call } satisfies DesktopClientStub,
    });

    await act(async () => {
      await result.current.mutateAsync(EDIT);
    });

    expect(edit.lastArgs()).toEqual([EDIT]);
  });

  it('names a 409 as a revision conflict rather than a generic failure', async () => {
    const edit = countingStub(plan(7));
    edit.fail(Object.assign(new Error('方案已被改动'), { status: 409, code: 'REVISION_CONFLICT' }));
    const { result } = renderDataHook(() => useApplyAgentPlanEdit(), {
      client: { applyAgentPlanEdit: edit.call } satisfies DesktopClientStub,
    });

    await act(async () => {
      await result.current.mutateAsync(EDIT).catch(() => undefined);
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(isRevisionConflict(result.current.error)).toBe(true);
    expect(isRevisionConflict(new Error('服务未连接'))).toBe(false);
  });
});

describe('useRestoreAgentPlanBaseline', () => {
  it('is an ordinary conditional edit — same invalidation, same cache write', async () => {
    const read = countingStub(plan(7));
    const restore = countingStub(plan(8));
    const client: DesktopClientStub = {
      getAgentPlan: read.call,
      restoreAgentPlanBaseline: restore.call,
    };

    const { result } = renderDataHook(
      () => ({ plan: useAgentPlan('P-118'), restore: useRestoreAgentPlanBaseline() }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.plan.data?.revision).toBe(7);
    });
    // What the refetch triggered by the restore will answer.
    read.succeed(plan(8));

    await act(async () => {
      await result.current.restore.mutateAsync({
        plan_id: 'P-118',
        expected_revision: 7,
        origin: { session_id: 'S-1', session_title: 'Kael 的 1v3', summary: '还原为 Agent 版本' },
        note: null,
      });
    });

    await waitFor(() => {
      expect(result.current.plan.data?.revision).toBe(8);
    });
  });
});

describe('§4.5.3 rule ①: nothing in this layer can start a recording', () => {
  /**
   * Anything whose name suggests it makes the game run or a file appear. The
   * check is on the *name* on purpose: a future hook that reaches for one of
   * these is caught by this test before it is caught by a user whose CS2
   * launched because they dragged a shot handle.
   */
  const RECORDING_METHOD = /record|execute|capture|render|export/iu;

  it('accepting a change and editing a plan call nothing that records', async () => {
    const reached: string[] = [];
    const client = new Proxy(
      {
        getAgentPlan: () => Promise.resolve(plan(6)),
        applyAgentPlanEdit: () => Promise.resolve(plan(7)),
        listAgentSessions: () => Promise.resolve({ items: [], total: 0 }),
        listAgentObjectSessions: () => Promise.resolve([]),
      },
      {
        get(target, property, receiver) {
          if (typeof property === 'string') reached.push(property);
          return Reflect.get(target, property, receiver) as unknown;
        },
      },
    ) as DesktopClientStub;

    const { result } = renderDataHook(
      () => ({ plan: useAgentPlan('P-118'), edit: useApplyAgentPlanEdit() }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.plan.isSuccess).toBe(true);
    });

    // Accepting a change *is* a plan edit — that is the whole point of the
    // rule: the accept button writes shots, it does not queue a job.
    await act(async () => {
      await result.current.edit.mutateAsync(EDIT);
    });

    expect(reached.length).toBeGreaterThan(0);
    expect(reached.filter((name) => RECORDING_METHOD.test(name))).toEqual([]);
  });
});
