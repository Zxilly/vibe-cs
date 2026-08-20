/*
 * `interaction` project — block A against the real query layer and a stubbed
 * bridge, mounted inside the real `/agent` shell.
 *
 * Two things can only be seen from here.
 *
 * **The end-to-end 修订冲突 timing** (「补齐 · 手动编辑与编辑感知」's third panel):
 * the Agent is generating against revision 6, the user edits the plan to
 * revision 7 while the reply is still arriving, and the proposal that lands is
 * expired the moment it appears. Every hop is real — the user entry is written
 * before the request, `useAgentChatStream` stamps `based_on_revision` from what
 * it read when 发送 was pressed, the plan query moves under it, and
 * `markStale` compares the two on the next render. Mocking any of those would
 * be testing the mock.
 *
 * **§4.5.3 rule ① at the block level.** The client is a `Proxy` that records
 * every method name the page touches, so 「接受变更不触发录制」 and 「切换会话不
 * 触发录制」 are assertions about the whole page's traffic rather than about one
 * handler that happens not to call one function.
 */

import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useQueryClient } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { DesktopClientProvider, type DesktopClient } from '../../data/desktopClient';
import { qk } from '../../data/keys';
import { PLAN_PROPOSAL, PLAN_SHOTS, USER_ENTRY } from '../../domain/agent/agentFixtures.testing';
import type {
  AgentEvent,
  AgentPlan,
  AgentSession,
  AgentSessionEntry,
  AgentSessionEntryDraft,
} from '../../shared/desktop/dto';
import { AgentWorkspace } from '../AgentPage';
import { renderInteractive } from '../../test/render';

/** Anything that could make the game run or a file appear. */
const RECORDING_METHOD = /record|execute|capture|render|export/iu;

function planFixture(revision: number): AgentPlan {
  return {
    id: 'P-118',
    title: 'Kael · Mirage 1v3 残局',
    status: 'awaiting_confirmation',
    revision,
    shots: [...PLAN_SHOTS],
    origin: [],
    agent_baseline: { revision: 1, captured_at: '2026-08-15T09:02:00.000Z', shots: [...PLAN_SHOTS] },
    created_at: '2026-08-15T09:02:00.000Z',
    updated_at: '2026-08-15T09:47:00.000Z',
  };
}

interface Bridge {
  readonly client: DesktopClient;
  readonly reached: string[];
  /** Mutated by the test to stand in for a manual edit landing on the server. */
  setPlanRevision: (revision: number) => void;
  /** Feeds the open stream one event. */
  emit: (event: AgentEvent) => void;
  /** Resolves the open `streamAgentChat` call. */
  finish: () => void;
  readonly cancelled: string[];
  readonly inputs: unknown[];
}

function bridge(entries: readonly AgentSessionEntry[]): Bridge {
  let plan = planFixture(6);
  const sessions = new Map<string, AgentSession>();
  const reached: string[] = [];
  const cancelled: string[] = [];
  const inputs: unknown[] = [];
  let onEvent: ((event: AgentEvent) => void) | null = null;
  let resolveStream: (() => void) | null = null;
  let nextEntry = 100;

  const session = (id: string): AgentSession => {
    const existing = sessions.get(id);
    if (existing !== undefined) return existing;
    const created: AgentSession = {
      id,
      title: `会话 ${id}`,
      created_at: '2026-08-15T09:02:00.000Z',
      updated_at: '2026-08-15T09:47:00.000Z',
      entries: [...entries],
      refs: [],
    };
    sessions.set(id, created);
    return created;
  };

  const stub = {
    health: () => Promise.resolve({ status: 'ok' }),
    getAgentPlan: () => Promise.resolve(plan),
    listAgentPlans: () => Promise.resolve([]),
    createAgentSession: (title: string) => Promise.resolve(session('S-auto')).then((created) => ({ ...created, title })),
    getAgentSession: (sessionId: string) => Promise.resolve(session(sessionId)),
    appendAgentSessionEntry: (sessionId: string, draft: AgentSessionEntryDraft) => {
      nextEntry += 1;
      const entry: AgentSessionEntry =
        draft.kind === 'user'
          ? { kind: 'user', id: `e-${String(nextEntry)}`, at: '2026-08-15T09:48:00.000Z', content: draft.content }
          : {
              kind: 'assistant',
              id: `e-${String(nextEntry)}`,
              at: '2026-08-15T09:49:00.000Z',
              content: draft.content,
              tool_calls: draft.tool_calls,
              proposals: draft.proposals,
            };
      const current = session(sessionId);
      sessions.set(sessionId, { ...current, entries: [...current.entries, entry] });
      return Promise.resolve(entry);
    },
    streamAgentChat: (input: unknown, handler: (event: AgentEvent) => void) => {
      inputs.push(input);
      onEvent = handler;
      return new Promise((resolve) => {
        resolveStream = () => resolve({ requestId: 'r', text: '' });
      });
    },
    cancelAgentChat: (requestId: string) => {
      cancelled.push(requestId);
      return Promise.resolve(true);
    },
  };

  const client = new Proxy(stub, {
    get(target, property, receiver) {
      if (typeof property === 'string') reached.push(property);
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as unknown as DesktopClient;

  return {
    client,
    reached,
    cancelled,
    inputs,
    setPlanRevision: (revision) => {
      plan = planFixture(revision);
    },
    emit: (event) => onEvent?.(event),
    finish: () => resolveStream?.(),
  };
}

/* ── the harness ─────────────────────────────────────────────────────────── */

let queryClient: ReturnType<typeof useQueryClient> | null = null;

function CaptureClient() {
  queryClient = useQueryClient();
  return null;
}

/** Block C owns the session drawer; this is the one thing the test needs of it. */
function SwitchSession() {
  const [params, setParams] = useSearchParams();
  return (
    <button
      type="button"
      onClick={() => {
        const next = new URLSearchParams(params);
        next.set('session', 'S-2');
        setParams(next);
      }}
    >
      换一条会话
    </button>
  );
}

function mount(
  harness: Bridge,
  url: string,
  context: { readonly projectId?: string; readonly demoId?: string } = {},
) {
  return renderInteractive(
    <DesktopClientProvider client={harness.client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/agent"
            element={
              <>
                <CaptureClient />
                <SwitchSession />
                <AgentWorkspace {...context} />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </DesktopClientProvider>,
  );
}

beforeEach(() => {
  queryClient = null;
});

describe('the first sentence starts the work', () => {
  it('creates a session and sends with Demo, work and plan context in one action', async () => {
    const harness = bridge([]);
    mount(harness, '/agent?plan=P-118&mode=changes', {
      projectId: 'plan:P-118',
      demoId: 'demo-1',
    });

    await screen.findByRole('textbox');
    await serviceOnline();
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '剪一条 40 秒、突出残局的视频' },
    });
    fireEvent.click(screen.getByRole('button', { name: '生成变更' }));

    await waitFor(() => expect(harness.reached).toContain('streamAgentChat'));
    expect(harness.reached).toContain('createAgentSession');
    expect(harness.inputs[0]).toMatchObject({
      demoId: 'demo-1',
      workspaceContext: {
        demoId: 'demo-1',
        projectId: 'plan:P-118',
        planId: 'P-118',
        planRevision: 6,
      },
    });
  });
});

/**
 * `ServiceGate` lives in `app/**` and is not mounted here, so nothing would
 * ever answer the health probe and every service-backed action would sit
 * disabled at 「正在连接本地服务」. Seeding the probe's own key is the smallest
 * honest stand-in: it is the same key `useServiceAction` reads, and no second
 * spelling of it exists (`data/serviceHealth.ts`).
 *
 * Seeding is not enough on its own. `setQueryData` hands the observer to
 * TanStack's `notifyManager`, which delivers on a task of its own, so the
 * re-render that lifts 「正在连接本地服务」 off the composer has *not* necessarily
 * happened when the `act` scope closes — `await Promise.resolve()` drains
 * microtasks and that notification is not one. A test that typed and pressed
 * 发送 straight afterwards was clicking a still-disabled button perhaps one run
 * in four, and a disabled click is silent: the request never left, and the
 * `waitFor` below sat there until the whole test timed out with no clue why.
 * So this waits for the composer to actually open, the same way
 * `planEditFlush.interaction.test.tsx` waits for the 编辑 guard.
 */
async function serviceOnline() {
  await act(async () => {
    queryClient?.setQueryData(qk.service.health(), { status: 'ok' } as never);
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(screen.getByRole('textbox').hasAttribute('disabled')).toBe(false);
  });
}

/* ── the timing §4.5.3 ③ exists for ──────────────────────────────────────── */

describe('a manual edit while the Agent is answering', () => {
  it('expires the proposal that lands, without hiding a word of it', async () => {
    const harness = bridge([USER_ENTRY]);
    mount(harness, '/agent?plan=P-118&session=S-1&mode=changes');

    await screen.findByRole('textbox');
    await serviceOnline();
    /* Queried *after* the service comes online, not before. A blocked composer
       carries its reason through a `Tooltip`, which wraps the control rather
       than borrowing it — a disabled element raises no pointer events — so the
       textarea is a different node on each side of that transition. Nothing is
       lost by it (the value lives in the parent's state, and a disabled box
       cannot have held focus); a node captured beforehand is simply detached. */
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: '把它压到 30 秒以内' } });

    const sendButton = screen.getByRole('button', { name: '生成变更' });
    /* Stated rather than assumed: a `fireEvent.click` on a disabled button is a
       no-op that no later assertion can distinguish from a request that was
       made and lost. */
    expect(sendButton.hasAttribute('disabled')).toBe(false);
    fireEvent.click(sendButton);

    // The reply starts arriving against revision 6.
    /* Three awaited hops stand between the click and the request — the user
       entry is written, the session namespace is invalidated, and the refetch
       lands — but all three are microtasks, so this is a margin for a loaded
       machine and not a budget anything is expected to spend. It stays well
       under the per-test timeout: a wait as long as the test's own budget can
       only ever report 「timed out」 instead of 「streamAgentChat 没有被调用」. */
    await waitFor(() => {
      expect(harness.reached).toContain('streamAgentChat');
    }, { timeout: 2_000 });
    await act(async () => {
      harness.emit({ type: 'textDelta', delta: '我把 02 压到 3 秒' });
      await Promise.resolve();
    });
    expect(screen.getByText(/我把 02 压到 3 秒/u)).toBeTruthy();

    // …and mid-stream the user edits the plan in the panel beside it. The write
    // is the server's; what the page sees is the plan moving to revision 7.
    harness.setPlanRevision(7);
    await act(async () => {
      await queryClient?.invalidateQueries({ queryKey: qk.plans.all });
    });

    // The proposal arrives afterwards, stamped with the revision the model was
    // answering about.
    await act(async () => {
      harness.emit({
        type: 'proposal',
        proposal: {
          kind: 'highlight_edit',
          title: '把它压到 30 秒以内',
          summary: null,
          payload: PLAN_PROPOSAL.payload,
        } as never,
      });
      harness.finish();
      await Promise.resolve();
    });

    const card = await waitFor(() => {
      const element = document.querySelector('[data-plan-change="change-1"]');
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });

    expect(card.getAttribute('data-change-state')).toBe('stale');
    expect(card.className).toContain('opacity-55');

    const accept = card.querySelector('[data-change-accept]');
    expect(accept?.hasAttribute('disabled')).toBe(true);

    // 过期不等于错误: every word of the card is still there to judge by.
    expect(card.textContent).toContain('02 跟随突破');
    expect(card.textContent).toContain('8.5s');
    expect(card.textContent).toContain('3.0s');
    expect(card.textContent).toContain('只保留从中路进入 A 大道的一段');
    expect(card.textContent).toContain('已过期');
  });
});

/* ── §4.5.3 rule ①, the front half ───────────────────────────────────────── */

describe('nothing in this block starts a recording', () => {
  it('accepting a change touches no recording command', async () => {
    const harness = bridge([
      USER_ENTRY,
      {
        kind: 'assistant',
        id: 'entry-2',
        at: '2026-08-15T09:45:00.000Z',
        content: '给了三条变更。',
        tool_calls: [],
        proposals: [PLAN_PROPOSAL],
      },
    ]);
    mount(harness, '/agent?plan=P-118&session=S-1&mode=changes');

    const card = await waitFor(() => {
      const element = document.querySelector('[data-plan-change="change-1"]');
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    /* 接受 applies the change to the plan, so it is a service-backed action and
       sits disabled until the probe answers — a disabled click is silent, and
       a test that made one would assert nothing. */
    await serviceOnline();

    const before = harness.reached.length;
    fireEvent.click(card.querySelector('[data-change-accept]') as HTMLElement);

    await waitFor(() => {
      expect(card.getAttribute('data-change-state')).toBe('accepted');
    });
    expect(harness.reached.filter((name) => RECORDING_METHOD.test(name))).toEqual([]);
    /* The edit it produced goes into §4.5.4's buffer and no further: 接受 does
       not get its own write, it waits for the merge window like every other
       edit. (That the shots really moved is
       `changeDecision.interaction.test.tsx`; here the point is the traffic.) */
    expect(harness.reached.slice(before).filter((name) => name.startsWith('applyAgent'))).toEqual([]);
  });

  it('switching session touches no recording command', async () => {
    const harness = bridge([USER_ENTRY]);
    mount(harness, '/agent?plan=P-118&session=S-1&mode=changes');

    await waitFor(() => {
      expect(harness.reached).toContain('getAgentSession');
    });

    fireEvent.click(screen.getByRole('button', { name: '换一条会话' }));

    await waitFor(() => {
      expect(harness.reached.filter((name) => name === 'getAgentSession').length).toBeGreaterThan(1);
    });
    expect(harness.reached.filter((name) => RECORDING_METHOD.test(name))).toEqual([]);
  });
});
