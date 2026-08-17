/*
 * `interaction` project — 「08」 with a stubbed bridge.
 *
 * Five behaviours, and every one of them is a rule that a static render cannot
 * see and a reviewer cannot check by reading:
 *
 *   1. **An edit voids the check list.** 「修改任何片段都会让当前预览计划失效」 is
 *      not copy: a per-shot `presentation` feeds the sha256 the plan lease is
 *      bound to, so a `blocking: 0` measured against different shots is a number
 *      that means nothing. It has to *disappear*, not go quietly stale.
 *   2. **`blocking > 0` disables 开始录制**, and so does an unreachable service —
 *      with a written reason in both cases.
 *   3. **Nothing else on this page can start a recording.** Asserted by counting
 *      `executeRecordingPlan` calls across a session that touches every other
 *      control on the page.
 *   4. **An observer shot's two fields of view are disabled**, because the
 *      backend answers 400 for a non-neutral value there rather than ignoring
 *      it — 「界面提供了一个不起作用的滑块」 is the worse failure.
 *   5. **The lease is minted once.** A re-plan swaps the director's merge result
 *      under a preview the user is reading, so it only ever happens on purpose.
 *
 * The bridge stub records every method it is asked for, so 「nothing recorded」
 * is asserted against the whole surface rather than against one spy.
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { DesktopClientProvider, type DesktopClient } from '../../data/desktopClient';
import { qk } from '../../data/keys';
import { renderInteractive } from '../../test/render';
import type {
  AppConfig,
  RecordingPreflight,
  RecordingShotPresetDraft,
} from '../../shared/desktop/dto';
import { RecordingPage } from '../RecordingPage';
import {
  AGENT_PLAN,
  AGENT_PLAN_ID,
  DEMO,
  PLAN_LEASE_ID,
  RECORDING_DEFAULTS,
  blockedPreflight,
  cameraPreview,
  preflight,
  recordingPlan,
} from './recordingFixtures.testing';

/** Anything that could put a file on disk or a process on the machine. */
const CONFIG = {
  locale: 'zh-CN',
  theme: 'system',
  update_manifest_url: '',
  data_dir: 'C:\\VibeCS',
  demo_watch_paths: [],
  cs2_path: '',
  steam_path: '',
  steam: {
    steam_id: '',
    web_api_key: '',
    authentication_code: '',
    known_share_code: '',
    maximum_results: 20,
  },
  steam_has_web_api_key: false,
  steam_has_authentication_code: false,
  steam_has_share_code: false,
  llm: { provider: '', model: '', base_url: '', api_key: '', prompt: '' },
  llm_has_api_key: false,
  clear_llm_api_key: false,
  recording: RECORDING_DEFAULTS,
} as unknown as AppConfig;

interface Harness {
  readonly reached: string[];
  readonly executed: string[];
  readonly planned: string[];
  readonly presets: RecordingShotPresetDraft[];
}

let queryClientRef: QueryClient | null = null;
let locationRef = '';

function Probe() {
  queryClientRef = useQueryClient();
  const location = useLocation();
  locationRef = `${location.pathname}${location.search}`;
  return null;
}

interface MountOptions {
  readonly preflightResult?: RecordingPreflight | undefined;
}

function mount(options: MountOptions = {}): Harness {
  const reached: string[] = [];
  const executed: string[] = [];
  const planned: string[] = [];
  const presets: RecordingShotPresetDraft[] = [];

  const record = <T,>(name: string, value: T): Promise<T> => {
    reached.push(name);
    return Promise.resolve(value);
  };

  const stub = {
    getAgentPlan: () => record('getAgentPlan', AGENT_PLAN),
    planRecordingFromAgentPlan: (planId: string) => {
      planned.push(planId);
      return record('planRecordingFromAgentPlan', recordingPlan());
    },
    preflightRecordingPlan: () =>
      record('preflightRecordingPlan', options.preflightResult ?? preflight()),
    executeRecordingPlan: (planId: string) => {
      executed.push(planId);
      return record('executeRecordingPlan', { job_id: 'job-7', status: 'queued' as const });
    },
    getConfig: () => record('getConfig', CONFIG),
    runtimeState: () =>
      record('runtimeState', {
        status: 'ready' as const,
        version: '0.1.0',
        started_at: '2026-08-16T00:00:00.000Z',
        data_dir: 'C:\\VibeCS',
        active_recording_job: null,
        runtime_session: 'idle' as const,
      }),
    previewHlaeProposal: () => record('previewHlaeProposal', cameraPreview()),
    exportHlaeProposal: () =>
      record('exportHlaeProposal', {
        directory: 'C:\\VibeCS\\hlae-plans\\x',
        files: [],
        completion_marker: 'done.json',
        base_fingerprint: 'base',
        proposal_fingerprint: 'proposal',
        launched: false,
      }),
    playDemo: () => record('playDemo', {} as never),
    stopPlayback: () => record('stopPlayback', {} as never),
    getDemo: () => record('getDemo', DEMO),
    getRadarOverview: () =>
      record('getRadarOverview', {
        map_name: 'de_mirage',
        transform: { pos_x: -3230, pos_y: 1713, scale: 5, rotate: false, zoom: null },
        image_url: null,
        image_mime: null,
        browser_displayable: false,
      }),
    listRecordingShotPresets: () => record('listRecordingShotPresets', { items: [] } as never),
    createRecordingShotPreset: (draft: RecordingShotPresetDraft) => {
      presets.push(draft);
      return record('createRecordingShotPreset', {
        ...draft,
        id: 'preset-1',
        created_at: '2026-08-16T00:00:00.000Z',
        updated_at: '2026-08-16T00:00:00.000Z',
      });
    },
    listActivities: () => record('listActivities', { items: [], total: 0, page: 1, page_size: 8, summary: { total: 0, active: 0, failed: 0, completed: 0, cancelled: 0 } } as never),
    listAgentPlans: () => record('listAgentPlans', [] as never),
  } satisfies Partial<DesktopClient>;

  renderInteractive(
    <DesktopClientProvider client={stub as unknown as DesktopClient}>
      <MemoryRouter initialEntries={[`/recording/${AGENT_PLAN_ID}`]}>
        <Probe />
        <Routes>
          <Route path="/recording/:taskId?" element={<RecordingPage />} />
          <Route path="/delivery/task/:taskId" element={<div>任务详情占位</div>} />
        </Routes>
      </MemoryRouter>
    </DesktopClientProvider>,
  );

  return { reached, executed, planned, presets };
}

/** `ServiceGate` is `app/**` and is not mounted here; seeding its own key is the
 *  smallest honest stand-in, and it is what starts the plan mint. */
async function serviceOnline(): Promise<void> {
  await act(async () => {
    queryClientRef?.setQueryData(qk.service.health(), { status: 'ok' } as never);
    await Promise.resolve();
  });
  /* The mint runs in an effect gated on the service, so the list appearing is
     the signal that the lease landed. Waiting on the container rather than on a
     row's text: a row prints 「02 跟随突破」 as one node, and an exact-text query
     for the title alone would never match. */
  await waitFor(() => {
    expect(document.querySelector('[data-shot-list="ready"]')).not.toBeNull();
  });
}

function shotRow(id: string): HTMLElement {
  const node = document.querySelector(`[data-shot="${id}"]`);
  if (node === null) throw new Error(`no shot row ${id}`);
  return node as HTMLElement;
}

function startButton(): HTMLButtonElement {
  const node = document.querySelector('[data-recording-start="true"]');
  if (node === null) throw new Error('no start button');
  return node as HTMLButtonElement;
}

async function runPreflight(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /运行录制前校验/u }));
  await waitFor(() => {
    expect(document.querySelector('[data-preflight-checks]')).not.toBeNull();
  });
}

beforeEach(() => {
  queryClientRef = null;
  locationRef = '';
});

/* ── 1. an edit voids the check list ─────────────────────────────────────── */

describe('修改任何片段都会让当前预览计划失效', () => {
  it('drops the previous check list rather than leaving a stale verdict on screen', async () => {
    mount();
    await serviceOnline();
    await runPreflight();

    expect(document.querySelector('[data-check="game_ready"]')).not.toBeNull();
    expect(startButton().hasAttribute('disabled')).toBe(false);

    /* One presentation edit — the smallest one there is. */
    fireEvent.click(screen.getByRole('switch', { name: 'HUD' }));

    await waitFor(() => {
      expect(document.querySelector('[data-preflight-checks]')).toBeNull();
    });
    expect(screen.getByText(/片段改过之后需要重新生成预览计划/u)).toBeTruthy();
  });

  it('disables 开始录制 with the edit as the reason, not the check list', async () => {
    mount();
    await serviceOnline();
    await runPreflight();
    fireEvent.click(screen.getByRole('switch', { name: '雷达' }));

    await waitFor(() => {
      expect(startButton().hasAttribute('disabled')).toBe(true);
    });
    expect(document.body.textContent).toContain('片段已修改，需要重新生成预览计划');
  });

  it('says so in the shot list too, beside the way out', async () => {
    mount();
    await serviceOnline();
    fireEvent.click(screen.getByRole('switch', { name: 'HUD' }));

    await waitFor(() => {
      expect(document.querySelector('[data-shot-list-dirty="true"]')).not.toBeNull();
    });
    expect(screen.getAllByRole('button', { name: /重新生成预览计划/u }).length).toBeGreaterThan(0);
  });
});

/* ── 2. what disables 开始录制 ───────────────────────────────────────────── */

describe('开始录制', () => {
  it('is disabled until a check list has been run against these shots', async () => {
    mount();
    await serviceOnline();
    expect(startButton().hasAttribute('disabled')).toBe(true);
    expect(document.body.textContent).toContain('先运行录制前校验');
  });

  it('is disabled while `blocking > 0`, and names the check list as the reason', async () => {
    mount({ preflightResult: blockedPreflight() });
    await serviceOnline();
    await runPreflight();

    expect(document.querySelector('[data-check-state="blocked"]')).not.toBeNull();
    expect(startButton().hasAttribute('disabled')).toBe(true);
    expect(document.body.textContent).toContain('录制前校验有阻塞项');
  });

  it('is not disabled by a warning — that is the whole contract', async () => {
    mount();
    await serviceOnline();
    await runPreflight();

    /* The fixture's `camera_collision_unverified` row is a warning and names a
       shot; it must not gate anything. */
    expect(document.querySelector('[data-check="camera_collision_unverified"]')).not.toBeNull();
    expect(startButton().hasAttribute('disabled')).toBe(false);
  });

  it('is disabled with a written reason while the local service is unreachable', () => {
    mount();
    const button = startButton();
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(document.body.textContent).toContain('正在连接本地服务');
  });

  it('takes one explicit confirmation, and the acknowledgement is required', async () => {
    const harness = mount();
    await serviceOnline();
    await runPreflight();

    fireEvent.click(startButton());
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: '开始录制' });
    /* No acknowledgement yet: the confirm is inert, so the dialog cannot be
       walked through with two Enters. */
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(confirm);
    expect(harness.executed).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: '开始录制' }));

    await waitFor(() => {
      expect(harness.executed).toEqual([PLAN_LEASE_ID]);
    });
  });

  it('hands a started recording to the task address it already has', async () => {
    mount();
    await serviceOnline();
    await runPreflight();

    fireEvent.click(startButton());
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: '开始录制' }));

    await waitFor(() => {
      expect(locationRef).toBe('/delivery/task/job-7');
    });
  });
});

/* ── 3. §4.5.3 rule ① ────────────────────────────────────────────────────── */

describe('nothing else on this page starts a recording', () => {
  it('has exactly one control that can, and it fires exactly once', async () => {
    const harness = mount();
    await serviceOnline();
    await runPreflight();

    expect(document.querySelectorAll('[data-recording-start="true"]')).toHaveLength(1);

    fireEvent.click(startButton());
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: '开始录制' }));

    await waitFor(() => {
      expect(harness.executed).toHaveLength(1);
    });
    expect(harness.reached.filter((name) => name === 'executeRecordingPlan')).toHaveLength(1);
  });

  it('reaches no recording command while the page is merely being read', async () => {
    const harness = mount();
    await serviceOnline();
    await runPreflight();

    /* Select every shot, open the preset list, and reorder — the whole page
       short of the one button. */
    fireEvent.click(shotRow('item-3'));
    fireEvent.click(shotRow('item-2'));
    fireEvent.keyDown(shotRow('item-2'), { key: 'ArrowDown', altKey: true });
    fireEvent.click(screen.getByRole('button', { name: /从预设应用/u }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(harness.executed).toHaveLength(0);
    expect(harness.reached).not.toContain('exportHlaeProposal');
    expect(harness.reached).not.toContain('playDemo');
  });
});

/* ── 4. the POV-only fields ──────────────────────────────────────────────── */

describe('视野 FOV / 持枪视野', () => {
  it('are disabled for an observer shot, with the backend’s reason written out', async () => {
    mount();
    await serviceOnline();

    /* The default selection is 建立地点, a `static` shot. Radix draws a slider
       thumb as a span, so 「disabled」 is `data-disabled`, not a property. */
    const cameraFov = screen.getByRole('slider', { name: '视野 FOV' });
    const viewmodelFov = screen.getByRole('slider', { name: '持枪视野' });
    expect(cameraFov.hasAttribute('data-disabled')).toBe(true);
    expect(viewmodelFov.hasAttribute('data-disabled')).toBe(true);
    expect(document.body.textContent).toContain('观察者镜头的视野由相机路径逐帧决定');
  });

  it('are enabled for a POV shot', async () => {
    mount();
    await serviceOnline();
    fireEvent.click(shotRow('item-3'));

    await waitFor(() => {
      expect(screen.getByRole('slider', { name: '视野 FOV' }).hasAttribute('data-disabled')).toBe(false);
    });
    expect(screen.getByRole('slider', { name: '持枪视野' }).hasAttribute('data-disabled')).toBe(false);
  });

  it('keeps 闪光强度 editable for both kinds of shot', async () => {
    mount();
    await serviceOnline();
    expect(screen.getByRole('slider', { name: '闪光强度' }).hasAttribute('data-disabled')).toBe(false);
  });

  it('reads 闪光强度 as remaining flash — 255 is 100%, not 0%', async () => {
    mount();
    await serviceOnline();
    const flash = screen.getByRole('slider', { name: '闪光强度' });
    expect(flash.getAttribute('aria-valuenow')).toBe('100');
  });
});

/* ── 5. the lease ────────────────────────────────────────────────────────── */

describe('the plan lease', () => {
  it('is minted once for the address and never re-minted on its own', async () => {
    const harness = mount();
    await serviceOnline();
    await runPreflight();
    fireEvent.click(shotRow('item-3'));
    fireEvent.click(screen.getByRole('switch', { name: 'HUD' }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(harness.planned).toEqual([AGENT_PLAN_ID]);
  });

  it('re-mints only when the user asks', async () => {
    const harness = mount();
    await serviceOnline();
    fireEvent.click(screen.getByRole('switch', { name: 'HUD' }));

    const replan = await screen.findByRole('button', { name: '重新生成预览计划' });
    fireEvent.click(replan);

    await waitFor(() => {
      expect(harness.planned).toEqual([AGENT_PLAN_ID, AGENT_PLAN_ID]);
    });
    await waitFor(() => {
      expect(document.querySelector('[data-shot-list-dirty="true"]')).toBeNull();
    });
  });
});

/* ── the shot list ───────────────────────────────────────────────────────── */

describe('片段列表', () => {
  it('reorders with the keyboard, not only with a pointer', async () => {
    mount();
    await serviceOnline();

    const order = (): string[] =>
      [...document.querySelectorAll('[data-shot]')].map((node) => node.getAttribute('data-shot') ?? '');
    expect(order()).toEqual(['item-1', 'item-2', 'item-3', 'item-4']);

    fireEvent.keyDown(shotRow('item-1'), { key: 'ArrowDown', altKey: true });
    await waitFor(() => {
      expect(order()).toEqual(['item-2', 'item-1', 'item-3', 'item-4']);
    });
  });

  it('does not wrap a row round the end', async () => {
    mount();
    await serviceOnline();
    const order = (): string[] =>
      [...document.querySelectorAll('[data-shot]')].map((node) => node.getAttribute('data-shot') ?? '');

    fireEvent.keyDown(shotRow('item-1'), { key: 'ArrowUp', altKey: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(order()).toEqual(['item-1', 'item-2', 'item-3', 'item-4']);
  });

  it('moves the selection with the plain arrow keys', async () => {
    mount();
    await serviceOnline();
    fireEvent.keyDown(shotRow('item-1'), { key: 'ArrowDown' });

    await waitFor(() => {
      expect(shotRow('item-2').getAttribute('data-selected')).toBe('true');
    });
  });
});

/* ── the check rows point back at shots ──────────────────────────────────── */

describe('affected_item_ids', () => {
  it('selects the shot a warning names', async () => {
    mount();
    await serviceOnline();
    await runPreflight();
    fireEvent.click(shotRow('item-3'));

    fireEvent.click(screen.getByRole('button', { name: /影响 1 个片段/u }));
    await waitFor(() => {
      expect(shotRow('item-2').getAttribute('data-selected')).toBe('true');
    });
  });
});
