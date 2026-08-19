/*
 * `interaction` project — the whole `/agent` page, with a stubbed bridge: when a
 * manual edit actually reaches the server (§4.5.4), and the one thing that must
 * never happen while it does (§4.5.3 rule ①).
 *
 * `data/editNotifier.interaction.test.tsx` already drives the notifier directly.
 * What it cannot see is whether the *panel* is wired to it — whether pressing
 * 保存改动 in the shot card ends up as an `applyAgentPlanEdit`, and whether each
 * of §4.5.4's occasions still lands once there is a router, a query client and
 * two other blocks in the tree. That is this file.
 *
 * 「漏掉任何一个都会丢通知」, so each occasion is its own test. The clock is
 * faked; nothing here sleeps five real seconds.
 *
 * ── The occasion that cannot be reached, and is reported rather than faked ──
 *
 * `confirm-video` is wired on the toolbar's 「确认并生成视频」, which is disabled
 * for as long as an `AgentPlan` carries no Demo (`agentContract.ts`, gap 1). A
 * disabled button fires no click, so there is no honest way to exercise that
 * path from the page yet; the last test below pins what *is* true — that the
 * button is inert and that pressing it records nothing.
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DesktopClientProvider, type DesktopClient } from '../../data/desktopClient';
import { EDIT_MERGE_WINDOW_MS } from '../../data/editNotifier';
import { qk } from '../../data/keys';
import { renderInteractive } from '../../test/render';
import type { AgentPlan, AgentPlanEdit } from '../../shared/desktop/dto';
import { AgentWorkspace } from '../AgentPage';

import { PLAN, SESSION } from './planFixtures.testing';

/** Anything that could make the game run or a file appear. */
const RECORDING_METHOD = /record|execute|capture|render|export/iu;

interface Harness {
  readonly edits: AgentPlanEdit[];
  readonly reached: string[];
  readonly unmount: () => void;
  readonly navigate: () => NavigateFunction;
}

let navigateRef: NavigateFunction | null = null;
let queryClientRef: QueryClient | null = null;

function NavigationProbe() {
  navigateRef = useNavigate();
  queryClientRef = useQueryClient();
  return null;
}

/**
 * `ServiceGate` lives in `app/**` and is not mounted here, so nothing answers
 * the health probe and every service-backed action — 编辑 included — would sit
 * disabled at 「正在连接本地服务」. Seeding the probe's own key is the smallest
 * honest stand-in; there is no second spelling of it (`data/serviceHealth.ts`).
 */
async function serviceOnline(): Promise<void> {
  await act(async () => {
    queryClientRef?.setQueryData(qk.service.health(), { status: 'ok' } as never);
    await Promise.resolve();
  });
  // The probe's observer notifies on its own schedule; wait for the edit guard
  // to actually open rather than assuming one microtask was enough.
  await waitFor(() => {
    expect(
      within(shotCard('shot-02')).getByRole('button', { name: '编辑' }).hasAttribute('disabled'),
    ).toBe(false);
  });
}

interface MountOptions {
  readonly url?: string;
  /** Rejects every `applyAgentPlanEdit` with this, for the two failure tests. */
  readonly failEdit?: unknown;
}

function mount(options: MountOptions | string = {}): Harness {
  const settings: MountOptions = typeof options === 'string' ? { url: options } : options;
  const url = settings.url ?? '/agent?plan=P-118&session=session-kael';
  const edits: AgentPlanEdit[] = [];
  const reached: string[] = [];
  let revision = PLAN.revision;

  const stub = {
    getAgentPlan: () => Promise.resolve<AgentPlan>({ ...PLAN, revision }),
    getAgentSession: (sessionId: string) => Promise.resolve({ ...SESSION, id: sessionId }),
    applyAgentPlanEdit: (edit: AgentPlanEdit) => {
      edits.push(edit);
      if (settings.failEdit !== undefined) return Promise.reject(settings.failEdit);
      revision += 1;
      return Promise.resolve<AgentPlan>({ ...PLAN, revision, shots: [...edit.shots] });
    },
    appendAgentSessionEntry: () => Promise.resolve(SESSION),
    streamAgentChat: () => Promise.resolve(),
    createAgentSession: () => Promise.resolve(SESSION),
    health: () => Promise.resolve({ status: 'ok' }),
  };

  const client = new Proxy(stub, {
    get(target, property, receiver) {
      if (typeof property === 'string') reached.push(property);
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as unknown as DesktopClient;

  const view = renderInteractive(
    <DesktopClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <NavigationProbe />
        <Routes>
          <Route path="/agent" element={<AgentWorkspace />} />
        </Routes>
      </MemoryRouter>
    </DesktopClientProvider>,
  );

  return {
    edits,
    reached,
    unmount: view.unmount,
    navigate: () => {
      if (navigateRef === null) throw new Error('the router never mounted');
      return navigateRef;
    },
  };
}

function shotCard(id: string): HTMLElement {
  const card = document.querySelector(`[data-plan-shot="${id}"]`);
  if (card === null) throw new Error(`no shot card ${id}`);
  return card as HTMLElement;
}

/** Waits for the panel to draw, brings the service up and opens 02's card. */
async function openEditor(): Promise<void> {
  await waitFor(() => {
    expect(document.querySelector('[data-plan-shot="shot-02"]')).not.toBeNull();
  });
  await serviceOnline();
  fireEvent.click(within(shotCard('shot-02')).getByRole('button', { name: '编辑' }));
}

/** Types a duration and saves. Synchronous, so it works under fake timers. */
function saveDuration(seconds: string): void {
  fireEvent.change(screen.getByLabelText('时长'), { target: { value: seconds } });
  fireEvent.click(screen.getByRole('button', { name: '保存改动' }));
}

async function editShot(seconds = '5'): Promise<void> {
  await openEditor();
  saveDuration(seconds);
}

/**
 * The five-second window, driven by hand.
 *
 * Only `setTimeout` and `clearTimeout` are faked, and only while the buffer is
 * open: `waitFor` polls on real timers, and faking the whole clock around it
 * would deadlock the poll rather than advance it. The switch has to happen
 * *before* the edit is recorded — a timeout scheduled on the real clock is not
 * moved by a fake one installed afterwards, which is the trap this helper
 * exists to keep out of the individual tests.
 */
async function throughTheWindow(record: () => void): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    record();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EDIT_MERGE_WINDOW_MS);
    });
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => {
  navigateRef = null;
  queryClientRef = null;
  vi.useRealTimers();
});

describe('the edit reaches the server, once, and only on an occasion', () => {
  it('writes nothing while the window is open', async () => {
    const { edits } = mount();
    await editShot();

    expect(edits).toEqual([]);
    // §4.5.4: the plan on screen is ahead of the server on purpose.
    expect(screen.getByText('你改过')).toBeTruthy();
  });

  it('writes when the five seconds elapse, as one merged notice', async () => {
    const { edits } = mount();
    await openEditor();

    await throughTheWindow(() => {
      saveDuration('5');
    });

    await waitFor(() => {
      expect(edits).toHaveLength(1);
    });
    expect(edits[0]?.plan_id).toBe('P-118');
    expect(edits[0]?.expected_revision).toBe(7);
    expect(edits[0]?.changes).toEqual([
      { shot: 2, op: 'updated', field: 'duration_seconds', from: '8.5s', to: '5.0s' },
    ]);
    expect(edits[0]?.shots).toHaveLength(PLAN.shots.length);
    expect(edits[0]?.origin.session_id).toBe('session-kael');
  });

  it('merges two edits inside one window into one write', async () => {
    const { edits } = mount();
    await openEditor();

    await throughTheWindow(() => {
      saveDuration('5');
      fireEvent.click(within(shotCard('shot-02')).getByRole('button', { name: '编辑' }));
      saveDuration('4');
    });

    await waitFor(() => {
      expect(edits).toHaveLength(1);
    });
    // The first `from` and the last `to`: 8.5 → 4.0, not two lines.
    expect(edits[0]?.changes).toEqual([
      { shot: 2, op: 'updated', field: 'duration_seconds', from: '8.5s', to: '4.0s' },
    ]);
  });

  it('writes when the session changes — the notice belongs to where it was made', async () => {
    const { edits } = mount();
    await editShot();

    await act(async () => {
      // 改动来源's 「打开这条会话」 is the panel's own way of doing this.
      fireEvent.click(screen.getByRole('button', { name: '打开这条对话' }));
    });

    await waitFor(() => {
      expect(edits).toHaveLength(1);
    });
    expect(edits[0]?.origin.session_id).toBe('session-kael');
  });

  it('writes when the plan changes — a buffer never crosses objects', async () => {
    const { edits, navigate } = mount();
    await editShot();

    await act(async () => {
      navigate()('/agent?plan=P-200&session=session-kael');
    });

    await waitFor(() => {
      expect(edits).toHaveLength(1);
    });
    expect(edits[0]?.plan_id).toBe('P-118');
  });

  it('writes when the page is navigated away from', async () => {
    const { edits } = mount();
    await editShot();

    await act(async () => {
      fireEvent(window, new Event('pagehide'));
    });

    await waitFor(() => {
      expect(edits).toHaveLength(1);
    });
  });

  it('writes when the window is closing', async () => {
    const { edits } = mount();
    await editShot();

    await act(async () => {
      fireEvent(window, new Event('beforeunload'));
    });

    await waitFor(() => {
      expect(edits).toHaveLength(1);
    });
  });

  it('writes when the tree goes away', async () => {
    const { edits, unmount } = mount();
    await editShot();

    await act(async () => {
      unmount();
    });

    await waitFor(() => {
      expect(edits).toHaveLength(1);
    });
  });

  it('writes before the message that asks the Agent to recompute', async () => {
    const { edits, reached } = mount();
    await editShot();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /基于第 7 版重算/u }));
    });

    await waitFor(() => {
      expect(edits).toHaveLength(1);
    });
    // The notice is written before the question that depends on it.
    expect(reached.indexOf('applyAgentPlanEdit')).toBeLessThan(
      reached.indexOf('appendAgentSessionEntry'),
    );
  });
});

/*
 * A flush that fails is the one thing the notifier deliberately does *not*
 * handle: the pending edit is handed back and never re-queued, because a 409
 * replayed with the same `expected_revision` would loop. So the shell has to
 * render it, and these two pin that it does — the whole point being that the
 * shots on screen are still the edited ones while the plan is not.
 */
describe('a merged edit that does not reach the plan', () => {
  function failureNotice(): HTMLElement {
    const element = document.querySelector('[data-agent-edit-failure]');
    if (element === null) throw new Error('the failed flush was not reported');
    return element as HTMLElement;
  }

  it('says so in place, and offers to read the plan again', async () => {
    mount({ failEdit: { message: '写入被拒绝', status: 500 } });
    await openEditor();

    await throughTheWindow(() => {
      saveDuration('5');
    });

    await waitFor(() => {
      expect(failureNotice().getAttribute('data-agent-edit-failure')).toBe('failed');
    });
    expect(screen.getByText(/这次改动没能写进方案/u)).toBeTruthy();
    expect(screen.getByText(/写入被拒绝/u)).toBeTruthy();
    // The part the user cannot see for themselves.
    expect(screen.getByText('屏幕上的改动还没有写进方案。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新读取剪辑单' })).toBeTruthy();
  });

  it('offers 「基于第 N 版重算」 when the plan moved under the edit', async () => {
    mount({ failEdit: { message: '修订冲突', status: 409 } });
    await openEditor();

    await throughTheWindow(() => {
      saveDuration('5');
    });

    await waitFor(() => {
      expect(failureNotice().getAttribute('data-agent-edit-failure')).toBe('conflict');
    });
    // 409 is not a failed write, it is a write about a plan that moved — so the
    // way out is the recompute the artboard already draws, not a retry.
    expect(screen.getByText('方案在这期间被改过了，这次改动没有写进方案。')).toBeTruthy();
    // Scoped to the notice: the panel's stale banner offers the same recovery
    // for the *proposals*, and this assertion is about the failed write.
    expect(within(failureNotice()).getByRole('button', { name: /基于第 7 版重算/u })).toBeTruthy();
  });

  it('is silent when the write lands', async () => {
    mount();
    await openEditor();

    await throughTheWindow(() => {
      saveDuration('5');
    });

    await waitFor(() => {
      expect(document.querySelector('[data-shot-source="user"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-agent-edit-failure]')).toBeNull();
  });
});

describe('§4.5.3 rule ①, through the panel', () => {
  it('a manual edit records nothing, before the window and after it', async () => {
    const { reached } = mount();
    await openEditor();

    await throughTheWindow(() => {
      saveDuration('5');
    });
    expect(reached.filter((name) => RECORDING_METHOD.test(name))).toEqual([]);

    await waitFor(() => {
      expect(reached).toContain('applyAgentPlanEdit');
    });
    expect(reached.filter((name) => RECORDING_METHOD.test(name))).toEqual([]);
  });

  it('deleting and restoring a shot records nothing', async () => {
    const { reached } = mount();
    await waitFor(() => {
      expect(document.querySelector('[data-plan-shot="shot-04"]')).not.toBeNull();
    });
    await serviceOnline();

    fireEvent.click(within(shotCard('shot-04')).getByRole('button', { name: '删除' }));
    fireEvent.click(within(shotCard('shot-04')).getByRole('button', { name: '撤销删除' }));

    expect(reached.filter((name) => RECORDING_METHOD.test(name))).toEqual([]);
  });

  it('「确认并生成视频」 stays inert, so the one confirmation cannot fire yet', async () => {
    const { edits, reached } = mount();
    await editShot();

    const confirm = screen.getByRole('button', { name: /确认并生成视频/u });
    expect(confirm.hasAttribute('disabled')).toBe(true);

    await act(async () => {
      fireEvent.click(confirm);
    });

    expect(edits).toEqual([]);
    expect(reached.filter((name) => RECORDING_METHOD.test(name))).toEqual([]);
  });
});
