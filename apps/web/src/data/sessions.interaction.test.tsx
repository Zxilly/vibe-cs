/*
 * `interaction` project — the session writes and what each one invalidates.
 *
 * The load-bearing one is a *negative*: deleting a session must not touch the
 * plans it edited. 「删除只删对话，它改过的方案、任务、视频全部留下」 (§4.5.1).
 * No real IPC; see `data/test/renderDataHook.tsx`.
 */

import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type {
  AgentObjectRef,
  AgentObjectSessionRef,
  AgentSession,
  AgentSessionPage,
  AgentSessionSummary,
} from '../shared/desktop/dto';
import type { DesktopClientStub } from './desktopClient';
import { useAgentPlan } from './plans';
import {
  retentionOptionId,
  useAgentObjectSessions,
  useAgentSession,
  useAgentSessionList,
  useAppendAgentSessionEntry,
  useDeleteAgentSession,
  useRenameAgentSession,
  useTouchAgentObjectRef,
} from './sessions';
import { countingStub, renderDataHook } from './test/renderDataHook';

const REF: AgentObjectRef = {
  kind: 'plan',
  id: 'P-118',
  label: '方案 #P-118',
  touched_at: '2026-08-15T09:24:00.000Z',
  touch_count: 2,
  summary: '改过 2 次',
  status: 'awaiting_confirmation',
};

const SUMMARY: AgentSessionSummary = {
  id: 'S-1',
  title: 'Kael 的 1v3',
  created_at: '2026-08-15T09:02:00.000Z',
  updated_at: '2026-08-15T09:47:00.000Z',
  entry_count: 6,
  refs: [REF],
};

const PAGE: AgentSessionPage = { items: [SUMMARY], total: 14 };

const SESSION: AgentSession = {
  id: 'S-1',
  title: 'Kael 的 1v3',
  created_at: '2026-08-15T09:02:00.000Z',
  updated_at: '2026-08-15T09:47:00.000Z',
  entries: [{ kind: 'user', id: 'e-1', at: '2026-08-15T09:02:00.000Z', content: '把它压到 30 秒以内' }],
  refs: [REF],
};

const OBJECT_SESSIONS: AgentObjectSessionRef[] = [
  {
    session_id: 'S-1',
    session_title: 'Kael 的 1v3',
    kind: 'plan',
    id: 'P-118',
    label: '方案 #P-118',
    touched_at: '2026-08-15T09:24:00.000Z',
    touch_count: 2,
    summary: '镜头 02 由 Dolly 改为 Tracking',
    status: 'awaiting_confirmation',
  },
];

const PLAN = {
  id: 'P-118',
  title: 'Kael Mirage 1v3',
  status: 'awaiting_confirmation' as const,
  revision: 7,
  shots: [],
  origin: [],
  agent_baseline: { revision: 1, captured_at: '2026-08-15T09:02:00.000Z', shots: [] },
  created_at: '2026-08-15T09:02:00.000Z',
  updated_at: '2026-08-15T09:47:00.000Z',
};

describe('the drawer list', () => {
  it('prints the server total, not the page length', async () => {
    const list = countingStub(PAGE);
    const { result } = renderDataHook(() => useAgentSessionList({ limit: 1 }), {
      client: { listAgentSessions: list.call } satisfies DesktopClientStub,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.total).toBe(14);
    expect(result.current.data?.items).toHaveLength(1);
  });

  it('does not ask for a session before one is selected', async () => {
    const detail = countingStub(SESSION);
    const { result } = renderDataHook(() => useAgentSession(null), {
      client: { getAgentSession: detail.call } satisfies DesktopClientStub,
    });

    await waitFor(() => {
      expect(result.current.fetchStatus).toBe('idle');
    });
    expect(detail.calls()).toBe(0);
  });
});

describe('useDeleteAgentSession', () => {
  it('refreshes the session list', async () => {
    const list = countingStub(PAGE);
    const remove = countingStub(undefined);
    const client: DesktopClientStub = {
      listAgentSessions: list.call,
      deleteAgentSession: remove.call,
    };

    const { result } = renderDataHook(
      () => ({ list: useAgentSessionList(), remove: useDeleteAgentSession() }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.list.isSuccess).toBe(true);
    });
    const before = list.calls();

    await act(async () => {
      await result.current.remove.mutateAsync('S-1');
    });

    await waitFor(() => {
      expect(list.calls()).toBeGreaterThan(before);
    });
  });

  it('leaves the plans that session edited completely alone', async () => {
    const plan = countingStub(PLAN);
    const objectSessions = countingStub(OBJECT_SESSIONS);
    const remove = countingStub(undefined);
    const client: DesktopClientStub = {
      getAgentPlan: plan.call,
      listAgentObjectSessions: objectSessions.call,
      deleteAgentSession: remove.call,
    };

    const { result } = renderDataHook(
      () => ({
        plan: useAgentPlan('P-118'),
        origin: useAgentObjectSessions('plan', 'P-118'),
        remove: useDeleteAgentSession(),
      }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.plan.isSuccess).toBe(true);
      expect(result.current.origin.isSuccess).toBe(true);
    });
    const planCalls = plan.calls();

    await act(async () => {
      await result.current.remove.mutateAsync('S-1');
    });
    // Let any invalidation that was going to happen happen.
    await act(async () => {
      await Promise.resolve();
    });

    // 「删除只删对话」: the plan is not refetched, because nothing about it moved.
    expect(plan.calls()).toBe(planCalls);
    // The reverse index *is* refreshed — a deleted session leaves its reference
    // behind with a null title, and that row lives under `qk.sessions.*`.
    await waitFor(() => {
      expect(objectSessions.calls()).toBeGreaterThan(1);
    });
  });
});

describe('the rest of the session writes', () => {
  it('renaming refreshes the list, because the title is printed on every row', async () => {
    const list = countingStub(PAGE);
    const rename = countingStub(SESSION);
    const client: DesktopClientStub = {
      listAgentSessions: list.call,
      renameAgentSession: rename.call,
    };

    const { result } = renderDataHook(
      () => ({ list: useAgentSessionList(), rename: useRenameAgentSession() }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.list.isSuccess).toBe(true);
    });
    const before = list.calls();

    await act(async () => {
      await result.current.rename.mutateAsync({ sessionId: 'S-1', title: 'Kael 的 1v3' });
    });

    expect(rename.lastArgs()).toEqual(['S-1', 'Kael 的 1v3']);
    await waitFor(() => {
      expect(list.calls()).toBeGreaterThan(before);
    });
  });

  it('appending an entry refreshes the transcript', async () => {
    const detail = countingStub(SESSION);
    const append = countingStub(SESSION.entries[0]!);
    const client: DesktopClientStub = {
      getAgentSession: detail.call,
      appendAgentSessionEntry: append.call,
    };

    const { result } = renderDataHook(
      () => ({ session: useAgentSession('S-1'), append: useAppendAgentSessionEntry() }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.session.isSuccess).toBe(true);
    });
    const before = detail.calls();

    await act(async () => {
      await result.current.append.mutateAsync({
        sessionId: 'S-1',
        draft: { kind: 'user', content: '把它压到 30 秒以内' },
      });
    });

    await waitFor(() => {
      expect(detail.calls()).toBeGreaterThan(before);
    });
  });

  it('touching an object refreshes both directions of the reference', async () => {
    const detail = countingStub(SESSION);
    const objectSessions = countingStub(OBJECT_SESSIONS);
    const touch = countingStub(REF);
    const client: DesktopClientStub = {
      getAgentSession: detail.call,
      listAgentObjectSessions: objectSessions.call,
      touchAgentObjectRef: touch.call,
    };

    const { result } = renderDataHook(
      () => ({
        session: useAgentSession('S-1'),
        origin: useAgentObjectSessions('plan', 'P-118'),
        touch: useTouchAgentObjectRef(),
      }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.session.isSuccess).toBe(true);
      expect(result.current.origin.isSuccess).toBe(true);
    });
    const sessionCalls = detail.calls();
    const objectCalls = objectSessions.calls();

    await act(async () => {
      await result.current.touch.mutateAsync({
        sessionId: 'S-1',
        touch: {
          kind: 'plan',
          id: 'P-118',
          label: '方案 #P-118',
          summary: '引用',
          status: 'awaiting_confirmation',
        },
      });
    });

    await waitFor(() => {
      expect(detail.calls()).toBeGreaterThan(sessionCalls);
      expect(objectSessions.calls()).toBeGreaterThan(objectCalls);
    });
  });
});

describe('retentionOptionId', () => {
  it('flattens the tagged union into one comparable option id', () => {
    expect(retentionOptionId({ mode: 'all' })).toBe('all');
    expect(retentionOptionId({ mode: 'none' })).toBe('none');
    expect(retentionOptionId({ mode: 'recent_count', count: 50 })).toBe('recent_count:50');
    expect(retentionOptionId({ mode: 'max_age_days', days: 30 })).toBe('max_age_days:30');
  });
});
