/*
 * `interaction` project — 片段属性's three destructive-ish actions and the one
 * distinction the wire exists to carry.
 *
 *   跟随全局默认 vs 这个片段自己的  `presentation: null` means 「follow the global
 *                                  defaults」, not 「off」. Touching any of the six
 *                                  controls detaches the shot — there is no
 *                                  partial write, the field is one object — and
 *                                  「改回全局默认」 is the way back.
 *   存为预设                        writes to `/api/recording/shot-presets` and the
 *                                  saved preset can be applied back onto a shot.
 *                                  A preset carries no Demo, player or tick
 *                                  window, which is what makes that safe.
 *   应用到全部                      rewrites every shot at once and has no undo on
 *                                  the wire (there is no wire call at all), so it
 *                                  is confirmed first.
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { DesktopClientProvider, type DesktopClient } from '../../data/desktopClient';
import { qk } from '../../data/keys';
import { renderInteractive } from '../../test/render';
import type {
  AppConfig,
  RecordingShotPreset,
  RecordingShotPresetDraft,
} from '../../shared/desktop/dto';
import { RecordingPlanWorkspace } from '../RecordingPage';
import {
  AGENT_PLAN,
  AGENT_PLAN_ID,
  DEMO,
  RECORDING_DEFAULTS,
  cameraPreview,
  preflight,
  recordingPlan,
} from './recordingFixtures.testing';

const CONFIG = { recording: RECORDING_DEFAULTS } as unknown as AppConfig;

const SAVED_PRESET: RecordingShotPreset = {
  id: 'preset-1',
  name: '我的 POV 参数',
  camera_style: 'pov',
  victim_pov: false,
  pre_roll_seconds: 2.5,
  post_roll_seconds: 0.5,
  presentation: {
    camera_fov: 120,
    viewmodel_fov: 54,
    flash_alpha: 102,
    show_hud: false,
    show_radar: false,
    voice: 'muted',
  },
  created_at: '2026-08-16T00:00:00.000Z',
  updated_at: '2026-08-16T00:00:00.000Z',
};

interface Harness {
  readonly drafts: RecordingShotPresetDraft[];
}

let queryClientRef: QueryClient | null = null;

function Probe() {
  queryClientRef = useQueryClient();
  return null;
}

function mount(options: { readonly presets?: readonly RecordingShotPreset[] } = {}): Harness {
  const drafts: RecordingShotPresetDraft[] = [];

  const stub = {
    getAgentPlan: () => Promise.resolve(AGENT_PLAN),
    planRecordingFromAgentPlan: () => Promise.resolve(recordingPlan()),
    preflightRecordingPlan: () => Promise.resolve(preflight()),
    executeRecordingPlan: () => Promise.resolve({} as never),
    getConfig: () => Promise.resolve(CONFIG),
    runtimeState: () =>
      Promise.resolve({
        status: 'ready' as const,
        version: '0.1.0',
        started_at: '2026-08-16T00:00:00.000Z',
        data_dir: 'C:\\VibeCS',
        active_recording_job: null,
        runtime_session: 'idle' as const,
      }),
    previewHlaeProposal: () => Promise.resolve(cameraPreview()),
    getDemo: () => Promise.resolve(DEMO),
    getRadarOverview: () =>
      Promise.resolve({
        map_name: 'de_mirage',
        transform: null,
        image_url: null,
        image_mime: null,
        browser_displayable: false,
      }),
    listRecordingShotPresets: () =>
      Promise.resolve({ items: [...(options.presets ?? [])] } as never),
    createRecordingShotPreset: (draft: RecordingShotPresetDraft) => {
      drafts.push(draft);
      return Promise.resolve({
        ...draft,
        id: 'preset-new',
        created_at: '2026-08-16T00:00:00.000Z',
        updated_at: '2026-08-16T00:00:00.000Z',
      });
    },
  } satisfies Partial<DesktopClient>;

  renderInteractive(
    <DesktopClientProvider client={stub as unknown as DesktopClient}>
      <MemoryRouter initialEntries={[`/recording/${AGENT_PLAN_ID}`]}>
        <Probe />
        <Routes>
          <Route path="/recording/:taskId?" element={<RecordingPlanWorkspace agentPlanId={AGENT_PLAN_ID} />} />
        </Routes>
      </MemoryRouter>
    </DesktopClientProvider>,
  );

  return { drafts };
}

async function serviceOnline(): Promise<void> {
  await act(async () => {
    queryClientRef?.setQueryData(qk.service.health(), { status: 'ok' } as never);
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(document.querySelector('[data-shot-list="ready"]')).not.toBeNull();
  });
}

function shotRow(id: string): HTMLElement {
  const node = document.querySelector(`[data-shot="${id}"]`);
  if (node === null) throw new Error(`no shot row ${id}`);
  return node as HTMLElement;
}

beforeEach(() => {
  queryClientRef = null;
});

/* ── 跟随全局默认 ────────────────────────────────────────────────────────── */

describe('presentation: null', () => {
  it('reads as 「跟随全局默认」 rather than as 「关掉」', async () => {
    mount();
    await serviceOnline();
    expect(document.querySelector('[data-presentation="inherited"]')).not.toBeNull();
    /* The values on screen are the config's, and both switches are on because
       the *defaults* are on — not because a shot said so. */
    expect((screen.getByRole('switch', { name: 'HUD' }) as HTMLElement).getAttribute('aria-checked'))
      .toBe('true');
  });

  it('detaches the shot on the first touch, and offers the way back', async () => {
    mount();
    await serviceOnline();
    fireEvent.click(screen.getByRole('switch', { name: '雷达' }));

    await waitFor(() => {
      expect(document.querySelector('[data-presentation="overridden"]')).not.toBeNull();
    });
    expect(screen.getByRole('switch', { name: '雷达' }).getAttribute('aria-checked')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: '改回全局默认' }));
    await waitFor(() => {
      expect(document.querySelector('[data-presentation="inherited"]')).not.toBeNull();
    });
    expect(screen.getByRole('switch', { name: '雷达' }).getAttribute('aria-checked')).toBe('true');
  });
});

/* ── 存为预设 ────────────────────────────────────────────────────────────── */

describe('存为预设', () => {
  it('names the preset, spells out what it holds, and refuses an empty name', async () => {
    const harness = mount();
    await serviceOnline();
    fireEvent.click(screen.getByRole('button', { name: /存为预设/u }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/包含视野、HUD、雷达、语音与前后留白/u)).toBeTruthy();
    expect(within(dialog).getByText(/不包含 Demo、选手与 tick 区间/u)).toBeTruthy();

    const save = within(dialog).getByRole('button', { name: '保存' });
    expect(save.hasAttribute('disabled')).toBe(true);

    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: '我的 POV 参数' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(harness.drafts).toHaveLength(1);
    });
    const draft = harness.drafts[0] as RecordingShotPresetDraft & Record<string, unknown>;
    expect(draft.name).toBe('我的 POV 参数');
    /* The presentation is frozen concrete — a preset that meant 「whatever the
       global default is that day」 would change under its own name. */
    expect(draft.presentation.camera_fov).toBe(RECORDING_DEFAULTS.camera_fov);
    for (const forbidden of ['demo_id', 'player_id', 'start_tick', 'end_tick', 'title']) {
      expect(draft[forbidden]).toBeUndefined();
    }
  });

  it('applies a saved preset back onto the selected shot', async () => {
    mount({ presets: [SAVED_PRESET] });
    await serviceOnline();
    fireEvent.click(screen.getByRole('button', { name: /从预设应用/u }));

    const apply = await screen.findByRole('button', { name: '我的 POV 参数' });
    fireEvent.click(apply);

    await waitFor(() => {
      /* The preset's style is POV, so the two fields of view become editable —
         which is the visible proof the whole patch landed, not just its name. */
      expect(screen.getByRole('slider', { name: '视野 FOV' }).hasAttribute('data-disabled')).toBe(false);
    });
    expect(screen.getByRole('slider', { name: '视野 FOV' }).getAttribute('aria-valuenow')).toBe('120');
    expect(screen.getByRole('switch', { name: 'HUD' }).getAttribute('aria-checked')).toBe('false');
  });

  it('says there are none rather than showing an empty box', async () => {
    mount({ presets: [] });
    await serviceOnline();
    fireEvent.click(screen.getByRole('button', { name: /从预设应用/u }));
    await waitFor(() => {
      expect(document.body.textContent).toContain('还没有保存过预设');
    });
  });
});

/* ── 应用到全部 ─────────────────────────────────────────────────────────── */

describe('应用到全部', () => {
  it('asks first, and says what will and will not change', async () => {
    mount();
    await serviceOnline();
    fireEvent.click(screen.getByRole('button', { name: '应用到全部' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/4 个片段的镜头类型、视角、前后留白与画面参数/u)).toBeTruthy();
    expect(within(dialog).getByText(/Demo、选手与 tick 区间不会被改动/u)).toBeTruthy();
  });

  it('changes nothing when the confirmation is dismissed', async () => {
    mount();
    await serviceOnline();
    fireEvent.click(shotRow('item-3'));
    await waitFor(() => {
      expect(shotRow('item-3').getAttribute('data-selected')).toBe('true');
    });

    fireEvent.click(screen.getByRole('button', { name: '应用到全部' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));

    await act(async () => {
      await Promise.resolve();
    });
    /* 建立地点 is still a `static` shot, so it still reads 观察者. */
    expect(shotRow('item-1').textContent).toContain('固定机位');
    expect(document.querySelector('[data-shot-list-dirty="true"]')).toBeNull();
  });

  it('rewrites every shot once confirmed, and voids the plan by doing so', async () => {
    mount();
    await serviceOnline();
    /* Open on the POV shot, then push it onto the other three. */
    fireEvent.click(shotRow('item-3'));
    await waitFor(() => {
      expect(shotRow('item-3').getAttribute('data-selected')).toBe('true');
    });

    fireEvent.click(screen.getByRole('button', { name: '应用到全部' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '应用到全部' }));

    await waitFor(() => {
      expect(shotRow('item-1').textContent).toContain('选手 POV');
    });
    expect(shotRow('item-4').textContent).toContain('选手 POV');
    expect(document.querySelector('[data-shot-list-dirty="true"]')).not.toBeNull();
  });
});
