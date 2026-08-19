/*
 * `interaction` project — the `/agent` shell against a stubbed bridge.
 *
 * Two things are pinned here that no unit test can reach: that the address is
 * what the shell asks the backend about (§4.4's rule applied to §7's three
 * parameters), and §4.5.3 rule ① at the page level — 「切换会话不触发录制」.
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams, useSearchParams } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentWorkspace } from '../AgentPage';
import { DesktopClientProvider, type DesktopClient } from '../../data/desktopClient';
import { qk } from '../../data/keys';
import type {
  AgentPlan,
  AgentPlanShot,
  AgentSession,
  AgentShotRecording,
} from '../../shared/desktop/dto';
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

const BOUND: AgentShotRecording = {
  demo_id: 'D-1',
  player_id: '76561198000000001',
  highlight_id: null,
  victim_pov: false,
  pre_roll_seconds: 1,
  post_roll_seconds: 1,
  presentation: null,
};

function shot(id: string, recording: AgentShotRecording | null): AgentPlanShot {
  return {
    id,
    title: id,
    kind: 'pov',
    view: 'player_pov',
    start_tick: 1000,
    end_tick: 1640,
    duration_seconds: 10,
    rationale: '',
    evidence_refs: [],
    risks: [],
    source: 'agent',
    removed_by: null,
    params: null,
    recording,
  };
}

/** Anything that could make the game run or a file appear. */
const RECORDING_METHOD = /record|execute|capture|render|export/iu;

/** Stands in for the project recording step so the handover is observable without
 *  mounting the recording page and its own bridge calls. */
function RecordingLanding() {
  const { projectId } = useParams<{ projectId?: string }>();
  const [params] = useSearchParams();
  return <p data-testid="recording-landing">{projectId ?? ''}|{params.get('step')}|{params.get('prepare')}</p>;
}

let queryClientRef: QueryClient | null = null;

function QueryProbe() {
  queryClientRef = useQueryClient();
  return null;
}

afterEach(() => {
  queryClientRef = null;
});

/**
 * `ServiceGate` lives in `app/**` and is not mounted here, so nothing answers
 * the health probe and every service-backed action would sit disabled behind
 * 「正在连接本地服务」 — including the one these tests are about. Seeding the
 * probe's cache entry is how the other Agent interaction tests open that gate.
 */
async function serviceOnline(): Promise<void> {
  await act(async () => {
    queryClientRef?.setQueryData(qk.service.health(), { status: 'ok' } as never);
    await Promise.resolve();
  });
}

function harness(url: string, plan?: Partial<AgentPlan>) {
  const reached: string[] = [];
  const planIds: string[] = [];
  const sessionIds: string[] = [];

  const stub = {
    getAgentPlan: (planId: string) => {
      planIds.push(planId);
      return Promise.resolve({ ...PLAN, ...plan });
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
        <QueryProbe />
        <Routes>
          <Route path="/agent" element={<AgentWorkspace />} />
          <Route path="/projects/:projectId" element={<RecordingLanding />} />
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

  it('refuses 「确认并生成视频」 for a plan with nothing left to record', async () => {
    // `PLAN.shots` is empty — the client-side half of `agent_plan_not_recordable`.
    const { reached } = harness('/agent?plan=P-118&session=S-1');
    await serviceOnline();

    const confirm = await screen.findByRole('button', { name: /确认并生成视频/u });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    // Twice on purpose: `Button` puts the reason in `title` and again in the
    // `aria-describedby` span, which is the 「不隐藏、不静默失败」 arrangement.
    expect(await screen.findAllByText(/没有可以录制的内容/u)).not.toHaveLength(0);

    fireEvent.click(confirm);

    expect(reached.filter((name) => RECORDING_METHOD.test(name))).toEqual([]);
  });

  it('refuses it, and counts, while a shot is still unbound', async () => {
    const { reached } = harness('/agent?plan=P-118&session=S-1', {
      shots: [shot('shot-01', BOUND), shot('shot-02', null)],
    });
    await serviceOnline();

    const confirm = await screen.findByRole('button', { name: /确认并生成视频/u });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(await screen.findAllByText(/还有 1 个镜头没有绑定/u)).not.toHaveLength(0);

    fireEvent.click(confirm);

    expect(reached.filter((name) => RECORDING_METHOD.test(name))).toEqual([]);
  });

  it('ignores a soft-removed unbound shot, the way the server does', async () => {
    const { reached } = harness('/agent?plan=P-118&session=S-1', {
      shots: [shot('shot-01', BOUND), { ...shot('shot-02', null), removed_by: 'user' }],
    });
    await serviceOnline();

    /* Re-queried inside the wait rather than held: a button that gains or
       loses its 「为什么不能点」 gains or loses the tooltip wrapper with it, so
       the node captured before the transition is not the node after it. */
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /确认并生成视频/u }).hasAttribute('disabled'),
      ).toBe(false);
    });
    expect(reached.filter((name) => RECORDING_METHOD.test(name))).toEqual([]);
  });

  /*
   * The seam phase 3f-be opened. Confirming does **not** record — §4.5.3 rule ①
   * keeps 开始录制 on 「08」, under the check list — so what this pins is that the
   * address changes and that nothing on the way there queued a job.
   */
  it('hands a bound plan to its project recording step without recording anything', async () => {
    const { reached } = harness('/agent?plan=P-118&session=S-1', {
      shots: [shot('shot-01', BOUND)],
    });
    await serviceOnline();

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /确认并生成视频/u }).hasAttribute('disabled'),
      ).toBe(false);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /确认并生成视频/u }));
    });

    const landing = await screen.findByTestId('recording-landing');
    expect(landing.textContent).toBe('plan:P-118|record|1');
    expect(reached.filter((name) => RECORDING_METHOD.test(name))).toEqual([]);
  });
});
