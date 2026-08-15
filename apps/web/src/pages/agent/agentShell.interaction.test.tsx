/*
 * `interaction` project — the `/agent` shell against a stubbed bridge.
 *
 * Two things are pinned here that no unit test can reach: that the address is
 * what the shell asks the backend about (§4.4's rule applied to §7's three
 * parameters), and §4.5.3 rule ① at the page level — 「切换会话不触发录制」.
 */

import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AgentPage } from '../AgentPage';
import { DesktopClientProvider, type DesktopClient } from '../../data/desktopClient';
import type { AgentPlan, AgentSession } from '../../shared/desktop/dto';
import { renderInteractive } from '../../test/render';

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

const SESSION: AgentSession = {
  id: 'S-1',
  title: 'Kael 的 1v3',
  created_at: '2026-08-15T09:02:00.000Z',
  updated_at: '2026-08-15T09:47:00.000Z',
  entries: [],
  refs: [],
};

/** Anything that could make the game run or a file appear. */
const RECORDING_METHOD = /record|execute|capture|render|export/iu;

function harness(url: string) {
  const reached: string[] = [];
  const planIds: string[] = [];
  const sessionIds: string[] = [];

  const stub = {
    getAgentPlan: (planId: string) => {
      planIds.push(planId);
      return Promise.resolve(PLAN);
    },
    getAgentSession: (sessionId: string) => {
      sessionIds.push(sessionId);
      return Promise.resolve({ ...SESSION, id: sessionId });
    },
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
        <Routes>
          <Route path="/agent" element={<AgentPage />} />
        </Routes>
      </MemoryRouter>
    </DesktopClientProvider>,
  );

  return { view, reached, planIds, sessionIds };
}

describe('the address is what the shell asks about', () => {
  it('reads the plan and the session named in the query, and nothing else', async () => {
    const { planIds, sessionIds } = harness('/agent?plan=P-118&session=S-1');

    await waitFor(() => {
      expect(planIds).toEqual(['P-118']);
      expect(sessionIds).toEqual(['S-1']);
    });
  });

  it('asks for neither when the query is bare', async () => {
    const { planIds, sessionIds } = harness('/agent');

    await act(async () => {
      await Promise.resolve();
    });
    expect(planIds).toEqual([]);
    expect(sessionIds).toEqual([]);
  });

  it('prints the plan the address names, with its revision', async () => {
    harness('/agent?plan=P-118&session=S-1');

    expect(await screen.findByText('Kael Mirage 1v3')).toBeTruthy();
    await waitFor(() => {
      // Scoped to the toolbar: block A prints the revision too, and this
      // assertion is about what the *shell* says.
      const toolbar = document.querySelector('header');
      expect(toolbar?.textContent).toMatch(/修订 7/u);
    });
  });
});

describe('§4.5.3 rule ①, at the page level', () => {
  it('opening a plan and a session records nothing', async () => {
    const { reached } = harness('/agent?plan=P-118&session=S-1');

    await waitFor(() => {
      expect(reached).toContain('getAgentPlan');
    });
    expect(reached.filter((name) => RECORDING_METHOD.test(name))).toEqual([]);
  });

  it('leaves 「确认并生成视频」 inert, and says why', async () => {
    const { reached } = harness('/agent?plan=P-118&session=S-1');

    const confirm = await screen.findByRole('button', { name: /确认并生成视频/u });
    expect(confirm.hasAttribute('disabled')).toBe(true);

    fireEvent.click(confirm);

    expect(reached.filter((name) => RECORDING_METHOD.test(name))).toEqual([]);
  });
});
