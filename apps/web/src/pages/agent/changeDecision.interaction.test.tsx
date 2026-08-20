/*
 * `interaction` project — 接受 and 拒绝, with both blocks of `/agent` on screen.
 *
 * `agentConversation.interaction.test.tsx` and `planPanel.interaction.test.tsx`
 * each mount one block, which is what makes them useful and also what let the
 * two blocks ship with two answers to the same question. Everything here needs
 * *both* columns in one tree, so it mounts the whole shell against a stubbed
 * bridge.
 *
 * Two properties are pinned, and neither can be seen from a single block:
 *
 *   **接受 is one path.** Pressing 接受 in the transcript applies the change to
 *   the plan and hands the edit to the notifier — exactly what pressing it in
 *   the panel does. A card that turned 已接受 while the plan kept its old
 *   numbers was a silent no-op: the user reads 「已接受」 and nothing was
 *   accepted.
 *
 *   **There is one decision.** The same change is drawn twice — once in the
 *   transcript, once in the panel — and one press must move both. Two `useState`
 *   maps with two key shapes put 「已接受」 and 「待处理」 on one screen.
 *
 * §4.5.3 ① is not weakened by either: an accepted change becomes an ordinary
 * buffered plan edit (§4.5.4's window), never a recording, and the last test
 * here says so about the whole page's traffic.
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { DesktopClientProvider, type DesktopClient } from '../../data/desktopClient';
import { qk } from '../../data/keys';
import type { AgentPlan, AgentPlanEdit } from '../../shared/desktop/dto';
import { renderInteractive } from '../../test/render';
import { AgentWorkspace } from '../AgentPage';

import { PLAN, sessionBasedOn } from './planFixtures.testing';

/** Anything that could make the game run or a file appear. */
const RECORDING_METHOD = /record|execute|capture|render|export/iu;

interface Harness {
  readonly edits: AgentPlanEdit[];
  readonly reached: string[];
}

let queryClientRef: QueryClient | null = null;

function ClientProbe() {
  queryClientRef = useQueryClient();
  return null;
}

/**
 * The session's proposal is stamped `based_on_revision: 7`, which is the plan's
 * own revision — so every card starts `pending` rather than `stale`. The stale
 * case is `planPanel.interaction.test.tsx`'s; this file is about the press that
 * is allowed to land.
 */
function mount(url = '/agent?plan=P-118&session=session-kael&mode=changes'): Harness {
  const edits: AgentPlanEdit[] = [];
  const reached: string[] = [];
  const session = sessionBasedOn(7);
  let revision = PLAN.revision;

  const stub = {
    getAgentPlan: () => Promise.resolve<AgentPlan>({ ...PLAN, revision }),
    getAgentSession: (sessionId: string) => Promise.resolve({ ...session, id: sessionId }),
    applyAgentPlanEdit: (edit: AgentPlanEdit) => {
      edits.push(edit);
      revision += 1;
      return Promise.resolve<AgentPlan>({ ...PLAN, revision, shots: [...edit.shots] });
    },
    appendAgentSessionEntry: () => Promise.resolve(session),
    streamAgentChat: () => Promise.resolve(),
    createAgentSession: () => Promise.resolve(session),
    setAgentProposalDecision: () => Promise.resolve(session),
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
      <MemoryRouter initialEntries={[url]}>
        <ClientProbe />
        <Routes>
          <Route path="/agent" element={<AgentWorkspace />} />
        </Routes>
      </MemoryRouter>
    </DesktopClientProvider>,
  );

  return { edits, reached };
}

function block(name: 'conversation' | 'plan'): HTMLElement {
  const element = document.querySelector(`[data-agent-block="${name}"]`);
  if (element === null) throw new Error(`block ${name} is not on screen`);
  return element as HTMLElement;
}

/** The same change, as each of the two columns draws it. */
function card(name: 'conversation' | 'plan', id: string): HTMLElement {
  const element = block(name).querySelector(`[data-plan-change="${id}"]`);
  if (element === null) throw new Error(`no ${name} card ${id}`);
  return element as HTMLElement;
}

function shotRow(id: string): HTMLElement {
  const element = block('plan').querySelector(`[data-plan-shot="${id}"]`);
  if (element === null) throw new Error(`no shot row ${id}`);
  return element as HTMLElement;
}

/**
 * `ServiceGate` lives in `app/**` and is not mounted here, so nothing answers
 * the health probe and every service-backed action — 接受 included, because it
 * writes an edit — would sit disabled at 「正在连接本地服务」. Seeding the probe's
 * own key is the smallest honest stand-in (`data/serviceHealth.ts` owns the one
 * spelling of it), and the wait is for the guard to actually open rather than
 * for one microtask.
 */
async function ready(): Promise<void> {
  await waitFor(() => {
    expect(document.querySelector('[data-plan-change="change-1"]')).not.toBeNull();
  });
  await act(async () => {
    queryClientRef?.setQueryData(qk.service.health(), { status: 'ok' } as never);
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(
      within(card('plan', 'change-1')).getByRole('button', { name: '接受' }).hasAttribute('disabled'),
    ).toBe(false);
  });
}

afterEach(() => {
  queryClientRef = null;
});

describe('接受 in the transcript is the same press as 接受 in the panel', () => {
  it('applies the change to the plan rather than only colouring the card', async () => {
    mount();
    await ready();

    const accept = within(card('conversation', 'change-1')).getByRole('button', { name: '接受' });
    expect(accept.hasAttribute('disabled')).toBe(false);
    fireEvent.click(accept);

    // 「变更 1」 is 02 跟随突破, 8.5s → 3.0s. The plan panel beside the transcript
    // must be showing 3.0s, and the total must have moved with it.
    await waitFor(() => {
      expect(shotRow('shot-02').textContent).toContain('3.0s');
    });
    expect(block('plan').querySelector('[data-plan-summary]')?.textContent).toContain('36.5s');
  });

  it('hands the edit to the one notifier, which writes it on the next occasion', async () => {
    const { edits } = mount();
    await ready();

    fireEvent.click(within(card('conversation', 'change-1')).getByRole('button', { name: '接受' }));

    // Nothing is written while §4.5.4's window is open…
    expect(edits).toEqual([]);

    // …and forcing one of its occasions produces exactly the line the change is.
    await act(async () => {
      fireEvent(window, new Event('pagehide'));
    });
    await waitFor(() => {
      expect(edits).toHaveLength(1);
    });
    expect(edits[0]?.changes).toEqual([
      { shot: 2, op: 'updated', field: 'duration_seconds', from: '8.5s', to: '3.0s' },
    ]);
    expect(edits[0]?.plan_id).toBe('P-118');
    expect(edits[0]?.origin.session_id).toBe('session-kael');
  });

  it('deletes a shot from the transcript exactly as the panel would', async () => {
    const { edits } = mount();
    await ready();

    // 「变更 2」 removes 04 高潮后升起.
    fireEvent.click(within(card('conversation', 'change-2')).getByRole('button', { name: '接受' }));

    await waitFor(() => {
      expect(shotRow('shot-04').getAttribute('data-shot-state')).toBe('removed');
    });

    await act(async () => {
      fireEvent(window, new Event('pagehide'));
    });
    await waitFor(() => {
      expect(edits).toHaveLength(1);
    });
    expect(edits[0]?.changes).toEqual([
      { shot: 4, op: 'removed', field: null, from: null, to: null },
    ]);
  });
});

describe('one decision, read the same in both columns', () => {
  it('marks the panel’s card accepted when the transcript’s is pressed', async () => {
    mount();
    await ready();

    fireEvent.click(within(card('conversation', 'change-1')).getByRole('button', { name: '接受' }));

    await waitFor(() => {
      expect(card('conversation', 'change-1').getAttribute('data-change-state')).toBe('accepted');
    });
    expect(card('plan', 'change-1').getAttribute('data-change-state')).toBe('accepted');
  });

  it('marks the transcript’s card rejected when the panel’s is pressed', async () => {
    const { edits } = mount();
    await ready();

    fireEvent.click(within(card('plan', 'change-3')).getByRole('button', { name: '拒绝' }));

    await waitFor(() => {
      expect(card('plan', 'change-3').getAttribute('data-change-state')).toBe('rejected');
    });
    expect(card('conversation', 'change-3').getAttribute('data-change-state')).toBe('rejected');

    // 拒绝 decides and edits nothing — the plan is untouched on both sides.
    expect(shotRow('shot-01').getAttribute('data-shot-state')).toBeNull();
    await act(async () => {
      fireEvent(window, new Event('pagehide'));
    });
    expect(edits).toEqual([]);
  });

  it('leaves the other changes alone, in both columns', async () => {
    mount();
    await ready();

    fireEvent.click(within(card('conversation', 'change-1')).getByRole('button', { name: '接受' }));

    await waitFor(() => {
      expect(card('plan', 'change-1').getAttribute('data-change-state')).toBe('accepted');
    });
    for (const name of ['conversation', 'plan'] as const) {
      expect(card(name, 'change-2').getAttribute('data-change-state')).toBe('pending');
      expect(card(name, 'change-3').getAttribute('data-change-state')).toBe('pending');
    }
  });
});

describe('§4.5.3 ①, through the transcript’s 接受', () => {
  it('records nothing, before the window and after it', async () => {
    const { edits, reached } = mount();
    await ready();

    fireEvent.click(within(card('conversation', 'change-1')).getByRole('button', { name: '接受' }));
    expect(reached.filter((name) => RECORDING_METHOD.test(name))).toEqual([]);

    await act(async () => {
      fireEvent(window, new Event('pagehide'));
    });
    await waitFor(() => {
      expect(edits).toHaveLength(1);
    });
    // An accepted change reaches the server as `applyAgentPlanEdit` and as
    // nothing else. 「接受变更不触发录制」.
    expect(reached.filter((name) => RECORDING_METHOD.test(name))).toEqual([]);
  });
});
