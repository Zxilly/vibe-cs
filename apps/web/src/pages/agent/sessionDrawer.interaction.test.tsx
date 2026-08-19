/*
 * `interaction` project — 会话抽屉 and 新建会话与引用 against a stubbed bridge.
 *
 * Three of these are contracts rather than behaviour, and they are the reason
 * this file exists:
 *
 *   · the search is the **server's** (`AgentSessionQuery.q`), not a filter over
 *     the page that is already loaded;
 *   · deleting a session must not refetch a plan — 「删除只删对话」 (§4.5.1),
 *     and the *absence* of that refetch is the only way to check it;
 *   · nothing in this overlay can start a recording (§4.5.3 rule ①), which is
 *     asserted by recording every property name the drawer touches on the
 *     client and matching it against the family of methods that could run the
 *     game or write a file.
 *
 * No real IPC: every client is a hand-built object behind `DesktopClientProvider`.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { DesktopClientProvider, type DesktopClient } from '../../data/desktopClient';
import { useAgentPlan } from '../../data/plans';
import type { ServiceActionState } from '../../data/serviceAction';
import type {
  AgentObjectRef,
  AgentPlan,
  AgentSessionPage,
  AgentSessionQuery,
  AgentSessionSummary,
  AgentWorkspaceReferences,
} from '../../shared/desktop/dto';
import { renderInteractive } from '../../test/render';
import type { AgentContextPatch, AgentRouteContext } from './agentContract';
import { SessionDrawer } from './SessionDrawer';

/** Anything that could make the game run or a file appear. */
const RECORDING_METHOD = /record|execute|capture|render|export/iu;

const READY: ServiceActionState = { blocked: false, buttonProps: { disabled: false }, suffix: undefined };

const PLAN_REF: AgentObjectRef = {
  kind: 'plan',
  id: 'P-118',
  label: '方案 #P-118',
  touched_at: '2026-08-15T09:24:00.000Z',
  touch_count: 2,
  summary: '镜头 02 由 Dolly 改为 Tracking',
  status: '等待确认',
};

const TASK_REF: AgentObjectRef = {
  kind: 'recording_task',
  id: 'A-2481',
  label: '录制任务 #A-2481',
  touched_at: '2026-08-15T09:30:00.000Z',
  touch_count: 1,
  summary: '排入队列',
  status: '运行中',
};

const KAEL: AgentSessionSummary = {
  id: 'S-1',
  title: 'Kael 的 1v3',
  created_at: '2026-08-15T09:02:00.000Z',
  updated_at: '2026-08-15T09:47:00.000Z',
  entry_count: 18,
  refs: [PLAN_REF, TASK_REF],
};

const RHEA: AgentSessionSummary = {
  id: 'S-2',
  title: 'Rhea 双杀合集',
  created_at: '2026-08-14T09:02:00.000Z',
  updated_at: '2026-08-14T09:02:00.000Z',
  entry_count: 4,
  refs: [],
};

const PLAN: AgentPlan = {
  id: 'P-118',
  title: 'Kael Mirage 1v3',
  status: 'awaiting_confirmation',
  revision: 7,
  shots: [],
  origin: [],
  agent_baseline: { revision: 1, captured_at: '2026-08-15T09:02:00.000Z', shots: [] },
  created_at: '2026-08-15T09:02:00.000Z',
  updated_at: '2026-08-15T09:47:00.000Z',
};

const WORKSPACE: AgentWorkspaceReferences = {
  pending_plans: [
    {
      kind: 'plan',
      id: 'P-118',
      label: '方案 · Kael Mirage 1v3',
      status: '等待确认',
      progress_percent: null,
      item_count: 4,
      error: null,
      updated_at: '2026-08-15T09:41:00.000Z',
    },
  ],
  running_recording_tasks: [
    {
      kind: 'recording_task',
      id: 'A-2483',
      label: '录制任务 · Rhea 双杀',
      status: '运行中 2/6',
      progress_percent: 33,
      item_count: 6,
      error: null,
      updated_at: '2026-08-15T09:40:00.000Z',
    },
  ],
  edit_projects: [],
  failed_outputs: [],
};

const CONTEXT: AgentRouteContext = { plan: 'P-118', session: 'S-1', mode: 'changes' };

interface Harness {
  readonly patches: AgentContextPatch[];
  readonly queries: AgentSessionQuery[];
  readonly reached: string[];
  readonly planCalls: () => number;
  readonly listCalls: () => number;
  readonly onClose: ReturnType<typeof vi.fn>;
  readonly stub: Record<string, unknown>;
}

/**
 * The drawer plus a probe that holds `qk.plans.detail('P-118')` in the same
 * cache. The probe is what makes the negative assertion possible: if a delete
 * invalidated plans, the probe would refetch and `planCalls()` would move.
 */
function PlanProbe() {
  const plan = useAgentPlan('P-118');
  return <span data-plan-revision={plan.data?.revision ?? ''} />;
}

function renderDrawer(
  options: { pages?: AgentSessionPage[]; context?: AgentRouteContext; now?: Date | null } = {},
): Harness {
  const patches: AgentContextPatch[] = [];
  const queries: AgentSessionQuery[] = [];
  const reached: string[] = [];
  const onClose = vi.fn();

  let planCalls = 0;
  let listCalls = 0;
  const pages = options.pages ?? [{ items: [KAEL, RHEA], total: 14 }];

  const stub: Record<string, unknown> = {
    listAgentSessions: (query: AgentSessionQuery) => {
      queries.push(query);
      listCalls += 1;
      const matched = pages.find((page) =>
        query.q === undefined ? true : page.items.some((item) => item.title.includes(query.q ?? '')),
      );
      return Promise.resolve(matched ?? { items: [], total: 0 });
    },
    getAgentPlan: () => {
      planCalls += 1;
      return Promise.resolve(PLAN);
    },
    listAgentWorkspaceReferences: () => Promise.resolve(WORKSPACE),
    renameAgentSession: (id: string, title: string) => Promise.resolve({ ...KAEL, id, title, entries: [], refs: [] }),
    deleteAgentSession: () => Promise.resolve(undefined),
    createAgentSession: (title: string) =>
      Promise.resolve({
        id: 'S-new',
        title,
        created_at: '2026-08-15T09:41:00.000Z',
        updated_at: '2026-08-15T09:41:00.000Z',
        entries: [],
        refs: [],
      }),
    touchAgentObjectRef: () => Promise.resolve(PLAN_REF),
    health: () => Promise.resolve({ status: 'ok' }),
  };

  const client = new Proxy(stub, {
    get(target, property, receiver) {
      if (typeof property === 'string') reached.push(property);
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as unknown as DesktopClient;

  renderInteractive(
    <DesktopClientProvider client={client}>
      <MemoryRouter initialEntries={['/agent']}>
        <Routes>
          <Route
            path="/agent"
            element={
              <>
                <PlanProbe />
                <SessionDrawer
                  open
                  onClose={onClose}
                  context={options.context ?? CONTEXT}
                  updateContext={(patch) => patches.push(patch)}
                  service={READY}
                  {...(options.now === null
                    ? {}
                    : { now: options.now ?? new Date('2026-08-15T10:00:00.000Z') })}
                />
              </>
            }
          />
          <Route path="/delivery/task/:taskId" element={<p>任务详情占位</p>} />
        </Routes>
      </MemoryRouter>
    </DesktopClientProvider>,
  );

  return {
    patches,
    queries,
    reached,
    onClose,
    stub,
    planCalls: () => planCalls,
    listCalls: () => listCalls,
  };
}

describe('the list', () => {
  it('prints the server’s total, not the number of rows it got', async () => {
    renderDrawer({ pages: [{ items: [KAEL], total: 14 }] });
    expect(await screen.findByText(/共 14 条/u)).toBeTruthy();
  });

  it('draws every session with the objects it touched under it', async () => {
    renderDrawer();
    expect(await screen.findByText('Kael 的 1v3')).toBeTruthy();
    expect(screen.getByText(/共 18 条对话/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: /方案 #P-118/u })).toBeTruthy();
    expect(screen.getByRole('button', { name: /录制任务 #A-2481/u })).toBeTruthy();
  });

  it('stamps a session touched today with the time, without being told the date', async () => {
    /* `AgentSessionRow` falls back to 「08-15」 when nobody hands it a 「今天」,
       so the drawer reads the clock itself. Rendered *without* `now` on
       purpose — this is the one place that catches the page forgetting to. */
    renderDrawer({
      pages: [{ items: [{ ...KAEL, updated_at: new Date().toISOString() }], total: 1 }],
      now: null,
    });

    const row = (await screen.findByText('Kael 的 1v3')).closest('[data-agent-session]');
    expect(row?.getAttribute('data-stamp')).toBe('time');
  });

  it('marks the session the address names as 当前', async () => {
    const { patches } = renderDrawer();
    const row = await screen.findByText('Kael 的 1v3');
    expect(row.closest('[data-agent-session]')?.getAttribute('aria-current')).toBe('true');
    expect(patches).toEqual([]);
  });
});

describe('the search', () => {
  it('asks the server, instead of filtering the page it already has', async () => {
    const { queries } = renderDrawer({
      pages: [
        { items: [KAEL, RHEA], total: 14 },
        { items: [RHEA], total: 1 },
      ],
    });

    await screen.findByText('Kael 的 1v3');
    fireEvent.change(screen.getByLabelText('搜索会话、Demo 或选手'), { target: { value: 'Rhea' } });

    await waitFor(
      () => {
        expect(queries.some((query) => query.q === 'Rhea')).toBe(true);
      },
      { timeout: 3000 },
    );
  });

  it('sends no `q` at all while the box is empty', async () => {
    const { queries } = renderDrawer();
    await screen.findByText('Kael 的 1v3');
    expect(queries.every((query) => query.q === undefined)).toBe(true);
  });
});

describe('opening things', () => {
  it('selecting a session patches only `?session=`, and closes the overlay', async () => {
    const { patches, onClose } = renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: /Rhea 双杀合集/u }));

    expect(patches).toEqual([{ session: 'S-2' }]);
    expect(onClose).toHaveBeenCalled();
  });

  it('a plan chip stays on this page — it is a patch, not a navigation', async () => {
    const { patches } = renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: /方案 #P-118/u }));

    expect(patches).toEqual([{ plan: 'P-118' }]);
  });

  it('a recording-task chip leaves for its §7 route', async () => {
    const { patches } = renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: /录制任务 #A-2481/u }));

    expect(patches).toEqual([]);
    expect(await screen.findByText('任务详情占位')).toBeTruthy();
  });
});

describe('重命名', () => {
  it('writes the new title through renameAgentSession', async () => {
    const renamed: Array<{ id: string; title: string }> = [];
    const harness = renderDrawer();
    harness.stub['renameAgentSession'] = (id: string, title: string) => {
      renamed.push({ id, title });
      return Promise.resolve({ ...KAEL, id, title, entries: [], refs: [] });
    };

    await screen.findByText('Kael 的 1v3');
    const row = screen.getByText('Kael 的 1v3').closest('[data-agent-session]');
    fireEvent.click(row?.querySelector('[data-session-rename]') as HTMLElement);

    fireEvent.change(screen.getByLabelText('会话的新名称'), { target: { value: 'Kael 的 1v3 · 决赛' } });
    fireEvent.click(row?.querySelector('[data-session-rename-save]') as HTMLElement);

    await waitFor(() => {
      expect(renamed).toEqual([{ id: 'S-1', title: 'Kael 的 1v3 · 决赛' }]);
    });
  });
});

describe('删除会话 (§4.5.1)', () => {
  it('says in the confirmation that the plans, tasks and videos stay', async () => {
    renderDrawer();
    await screen.findByText('Kael 的 1v3');
    const row = screen.getByText('Kael 的 1v3').closest('[data-agent-session]');
    fireEvent.click(row?.querySelector('[data-session-delete]') as HTMLElement);

    expect(screen.getByText('删除这条对话？')).toBeTruthy();
    expect(screen.getByText(/不会动它改过的方案、录制任务和已生成的视频/u)).toBeTruthy();
  });

  it('refreshes the session list and leaves the plan cache alone', async () => {
    const removed: string[] = [];
    const harness = renderDrawer();
    harness.stub['deleteAgentSession'] = (id: string) => {
      removed.push(id);
      return Promise.resolve(undefined);
    };

    await screen.findByText('Kael 的 1v3');
    await waitFor(() => {
      expect(harness.planCalls()).toBe(1);
    });
    const listBefore = harness.listCalls();

    const row = screen.getByText('Kael 的 1v3').closest('[data-agent-session]');
    fireEvent.click(row?.querySelector('[data-session-delete]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-dialog-action="confirm"]') as HTMLElement);

    await waitFor(() => {
      expect(removed).toEqual(['S-1']);
    });
    // 「删除只删对话」: the session namespace refetches…
    await waitFor(() => {
      expect(harness.listCalls()).toBeGreaterThan(listBefore);
    });
    // …and the plan it edited is not even re-read.
    expect(harness.planCalls()).toBe(1);
  });

  it('drops the deleted session out of the address', async () => {
    const harness = renderDrawer();
    await screen.findByText('Kael 的 1v3');

    const row = screen.getByText('Kael 的 1v3').closest('[data-agent-session]');
    fireEvent.click(row?.querySelector('[data-session-delete]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-dialog-action="confirm"]') as HTMLElement);

    await waitFor(() => {
      expect(harness.patches).toEqual([{ session: null }]);
    });
  });
});

describe('新建会话与引用', () => {
  it('lists what the workspace is doing, grouped, with the pending plan first', async () => {
    renderDrawer();
    fireEvent.click(await screen.findByText('新建对话'));

    expect(await screen.findByText('方案 · Kael Mirage 1v3')).toBeTruthy();
    expect(screen.getByText('录制任务 · Rhea 双杀')).toBeTruthy();
    expect(screen.getByText('等待确认的方案')).toBeTruthy();
  });

  it('creates the session, records each 引用, and takes over the picked plan', async () => {
    const created: string[] = [];
    const touched: Array<{ sessionId: string; id: string }> = [];
    const harness = renderDrawer();
    harness.stub['createAgentSession'] = (title: string) => {
      created.push(title);
      return Promise.resolve({
        id: 'S-new',
        title,
        created_at: '2026-08-15T09:41:00.000Z',
        updated_at: '2026-08-15T09:41:00.000Z',
        entries: [],
        refs: [],
      });
    };
    harness.stub['touchAgentObjectRef'] = (sessionId: string, touch: { id: string }) => {
      touched.push({ sessionId, id: touch.id });
      return Promise.resolve(PLAN_REF);
    };

    fireEvent.click(await screen.findByText('新建对话'));
    await screen.findByText('方案 · Kael Mirage 1v3');

    const planRow = document.querySelector('[data-agent-reference="P-118"]');
    fireEvent.click(planRow?.querySelector('[data-reference-action]') as HTMLElement);
    // 「已引用 ✓」 is the state of a picked row, exactly as the artboard draws it.
    expect(planRow?.getAttribute('data-referenced')).toBe('true');

    fireEvent.change(screen.getByLabelText('对话名称'), { target: { value: '接管 P-118' } });
    fireEvent.click(document.querySelector('[data-new-session-submit]') as HTMLElement);

    await waitFor(() => {
      expect(created).toEqual(['接管 P-118']);
    });
    await waitFor(() => {
      expect(touched).toEqual([{ sessionId: 'S-new', id: 'P-118' }]);
    });
    // 「新建一条会话……可以直接接管当前那个」 — one patch, both parameters.
    await waitFor(() => {
      expect(harness.patches).toEqual([{ session: 'S-new', plan: 'P-118' }]);
    });
  });

  it('with nothing picked, names only the session so the plan on screen survives', async () => {
    const harness = renderDrawer();
    fireEvent.click(await screen.findByText('新建对话'));
    await screen.findByText('方案 · Kael Mirage 1v3');

    fireEvent.click(document.querySelector('[data-new-session-submit]') as HTMLElement);

    await waitFor(() => {
      expect(harness.patches).toEqual([{ session: 'S-new' }]);
    });
  });
});

describe('§4.5.3 rule ①, inside the overlay', () => {
  it('touches no method that could start a recording, even after a full run', async () => {
    const harness = renderDrawer();

    await screen.findByText('Kael 的 1v3');
    fireEvent.click(screen.getByText('新建对话'));
    await screen.findByText('方案 · Kael Mirage 1v3');
    const planRow = document.querySelector('[data-agent-reference="P-118"]');
    fireEvent.click(planRow?.querySelector('[data-reference-action]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-new-session-submit]') as HTMLElement);

    await waitFor(() => {
      expect(harness.patches.length).toBeGreaterThan(0);
    });
    expect(harness.reached.filter((name) => RECORDING_METHOD.test(name))).toEqual([]);
  });
});
