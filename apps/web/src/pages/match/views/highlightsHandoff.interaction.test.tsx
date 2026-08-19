/*
 * `interaction` project — 「用 Agent 制作视频」, end to end from the highlight
 * list.
 *
 * §10.5 gap 18 and §10.6 between them settled that the sender creates the plan
 * and navigates to it; phase 3f-be supplied the payload that makes the plan
 * *bound*. The assertion that matters is therefore not 「it navigated」 — the
 * button did that before and it was useless — but 「the plan it created carries
 * `demo_id` on every shot」, because an unbound plan is one
 * `/recording/:planId` can only refuse (422 `agent_plan_shots_unbound`).
 *
 * The negative case matters just as much: the artboard fixtures identify a
 * player as 「kael」, which is not a SteamID64, and the backend rejects that. A
 * page that sent it anyway would produce a plan nothing could record; a page
 * that disabled the button with no reason would be a dead control. So the
 * default fixture is asserted *disabled, with a written reason*, and only the
 * SteamID64 variant is allowed through.
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DesktopClientProvider, type DesktopClient } from '../../../data/desktopClient';
import { qk } from '../../../data/keys';
import { useMatchAnalysis } from '../../../data/match';
import { renderInteractive } from '../../../test/render';
import type { AgentPlan, AgentPlanCreate } from '../../../shared/desktop/dto';
import type { AnalysisWorkspace } from '../../../shared/desktop/viewModels';
import { HighlightsView } from './HighlightsView';
import { ANALYSIS } from './test/fixtures';
import { queryResult, viewProps } from './test/renderView';
import { reasonOf } from '../../../test/reason';

vi.mock('../../../data/match', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../data/match')>();
  return { ...actual, useMatchAnalysis: vi.fn() };
});

const STEAM_IDS: Record<string, string> = {
  kael: '76561198000000001',
  sable: '76561198000000002',
  corvin: '76561198000000003',
};

/** The same match, with players the backend would actually accept. */
const BOUND_ANALYSIS: AnalysisWorkspace = {
  ...ANALYSIS,
  players: ANALYSIS.players.map((player) => ({
    ...player,
    id: STEAM_IDS[player.id] ?? player.id,
  })),
  highlights: ANALYSIS.highlights.map((highlight) => ({
    ...highlight,
    player_id: STEAM_IDS[highlight.player_id] ?? highlight.player_id,
  })),
};

let queryClientRef: QueryClient | null = null;
let locationRef: string | null = null;

function Probe() {
  queryClientRef = useQueryClient();
  locationRef = `${useLocation().pathname}${useLocation().search}`;
  return null;
}

interface Harness {
  readonly created: AgentPlanCreate[];
}

function mount(analysis: AnalysisWorkspace): Harness {
  vi.mocked(useMatchAnalysis).mockReturnValue(queryResult(analysis) as never);

  const created: AgentPlanCreate[] = [];
  const stub = {
    createAgentPlan: (create: AgentPlanCreate) => {
      created.push(create);
      const plan: AgentPlan = {
        id: 'P-901',
        title: create.title,
        status: create.status,
        revision: 1,
        shots: create.shots,
        origin: [],
        agent_baseline: { revision: 1, captured_at: '2026-08-16T00:00:00.000Z', shots: [] },
        created_at: '2026-08-16T00:00:00.000Z',
        updated_at: '2026-08-16T00:00:00.000Z',
      };
      return Promise.resolve(plan);
    },
  } satisfies Partial<DesktopClient>;

  renderInteractive(
    <DesktopClientProvider client={stub as unknown as DesktopClient}>
      <MemoryRouter initialEntries={['/match/aurora-vs-meridian?view=highlights']}>
        <Probe />
        <HighlightsView.Body {...viewProps()} />
      </MemoryRouter>
    </DesktopClientProvider>,
  );

  return { created };
}

/** `ServiceGate` lives in `app/**` and is not mounted here, so the probe has to
 *  be seeded or every service-backed action sits at 「正在连接本地服务」. */
async function serviceOnline(): Promise<void> {
  await act(async () => {
    queryClientRef?.setQueryData(qk.service.health(), { status: 'ok' } as never);
    await Promise.resolve();
  });
}

function selectFirst(count: number): void {
  const boxes = screen.getAllByRole('checkbox', { name: '选择这条高光' });
  for (let index = 0; index < count; index += 1) {
    fireEvent.click(boxes[index] as HTMLElement);
  }
}

function handoffButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '新建作品' }) as HTMLButtonElement;
}

beforeEach(() => {
  queryClientRef = null;
  locationRef = null;
  vi.mocked(useMatchAnalysis).mockReset();
});

describe('新建作品', () => {
  it('creates a plan whose every shot carries demo_id, player_id and highlight_id', async () => {
    const harness = mount(BOUND_ANALYSIS);
    await serviceOnline();
    selectFirst(2);

    await waitFor(() => {
      expect(handoffButton().hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(handoffButton());

    await waitFor(() => {
      expect(harness.created).toHaveLength(1);
    });

    const create = harness.created[0] as AgentPlanCreate;
    expect(create.shots).toHaveLength(2);
    for (const shot of create.shots) {
      expect(shot.recording?.demo_id).toBe(ANALYSIS.demo_id);
      expect(shot.recording?.player_id).toMatch(/^\d{17}$/u);
      expect(shot.recording?.highlight_id).not.toBeNull();
    }
  });

  it('hands the created plan over on §7’s own address', async () => {
    mount(BOUND_ANALYSIS);
    await serviceOnline();
    selectFirst(1);

    await waitFor(() => {
      expect(handoffButton().hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(handoffButton());

    await waitFor(() => {
      expect(locationRef).toContain('/agent');
    });
    expect(locationRef).toContain('plan=P-901');
  });

  it('creates the plan as a draft with no session — a handoff precedes any conversation', async () => {
    const harness = mount(BOUND_ANALYSIS);
    await serviceOnline();
    selectFirst(1);
    await waitFor(() => {
      expect(handoffButton().hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(handoffButton());

    await waitFor(() => {
      expect(harness.created).toHaveLength(1);
    });
    expect(harness.created[0]?.status).toBe('draft');
    expect(harness.created[0]?.origin).toBeNull();
  });

  it('disables itself — with a reason — when a player has no SteamID64', async () => {
    const harness = mount(ANALYSIS);
    await serviceOnline();
    selectFirst(1);

    const button = handoffButton();
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(reasonOf(button)).toBeTruthy();
    expect(document.body.textContent).toContain('SteamID');

    fireEvent.click(button);
    await act(async () => {
      await Promise.resolve();
    });
    /* 「建不出来就禁用并写明原因，不要跳一个空方案过去」. */
    expect(harness.created).toHaveLength(0);
    expect(locationRef).not.toContain('/agent');
  });

  it('stays disabled while the local service is unreachable', () => {
    mount(BOUND_ANALYSIS);
    selectFirst(1);
    expect(handoffButton().hasAttribute('disabled')).toBe(true);
  });
});
