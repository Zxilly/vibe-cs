/*
 * `interaction` project — 导播预览 and 「在游戏里预览」.
 *
 * Two things are being pinned, and they are opposites:
 *
 * **The camera path is drawn from real coordinates.** `typed_plan` on the HLAE
 * proposal preview is a whole `HlaePlan`; the keyframes come out of it and go
 * onto the radar, with a heading arrow, a field-of-view wedge and a **height
 * strip** — because 「从高处降下来」 and 「贴地平移」 project onto a radar as the
 * same line, and the height axis is the only thing that separates them.
 *
 * **Nothing is drawn when there is no path.** A preview that comes back with
 * prerequisites (「这一段回放采样不足四帧」) prints them, one per row, and draws
 * no line at all.
 *
 * And the door into the game: three calls in order, behind one confirmation
 * whose copy has to say — because it is the difference from 开始录制 — that it
 * records nothing.
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { DesktopClientProvider, type DesktopClient } from '../../data/desktopClient';
import { qk } from '../../data/keys';
import { renderInteractive } from '../../test/render';
import type { AppConfig, DemoPlaybackOptions, HlaeProposalPreview, RuntimeState } from '../../shared/desktop/dto';
import { RecordingPlanWorkspace } from '../RecordingPage';
import { inGameGate } from './cameraDesk';
import {
  AGENT_PLAN,
  AGENT_PLAN_ID,
  DEMO,
  RECORDING_DEFAULTS,
  blockedCameraPreview,
  cameraPreview,
  preflight,
  recordingPlan,
} from './recordingFixtures.testing';

const CONFIG = { recording: RECORDING_DEFAULTS } as unknown as AppConfig;

interface Harness {
  readonly reached: string[];
  readonly playbackOptions: DemoPlaybackOptions[];
}

let queryClientRef: QueryClient | null = null;

function Probe() {
  queryClientRef = useQueryClient();
  return null;
}

interface MountOptions {
  readonly preview?: HlaeProposalPreview | undefined;
  readonly session?: RuntimeState['runtime_session'] | undefined;
}

function mount(options: MountOptions = {}): Harness {
  const reached: string[] = [];
  const playbackOptions: DemoPlaybackOptions[] = [];
  const record = <T,>(name: string, value: T): Promise<T> => {
    reached.push(name);
    return Promise.resolve(value);
  };

  const stub = {
    getAgentPlan: () => record('getAgentPlan', AGENT_PLAN),
    planRecordingFromAgentPlan: () => record('planRecordingFromAgentPlan', recordingPlan()),
    preflightRecordingPlan: () => record('preflightRecordingPlan', preflight()),
    executeRecordingPlan: () => record('executeRecordingPlan', {} as never),
    getConfig: () => record('getConfig', CONFIG),
    runtimeState: () =>
      record('runtimeState', {
        status: 'ready' as const,
        version: '0.1.0',
        started_at: '2026-08-16T00:00:00.000Z',
        data_dir: 'C:\\VibeCS',
        active_recording_job: null,
        runtime_session: options.session ?? 'idle',
      }),
    previewHlaeProposal: () => record('previewHlaeProposal', options.preview ?? cameraPreview()),
    exportHlaeProposal: () =>
      record('exportHlaeProposal', {
        directory: 'C:\\VibeCS\\hlae-plans\\x',
        files: ['bootstrap.cfg'],
        completion_marker: 'done.json',
        base_fingerprint: 'base',
        proposal_fingerprint: 'proposal',
        launched: false,
      }),
    playDemo: (_demoId: string, playback?: DemoPlaybackOptions) => {
      playbackOptions.push(playback ?? {});
      return record('playDemo', {} as never);
    },
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

  return { reached, playbackOptions };
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

function inGameButton(): HTMLButtonElement {
  const node = document.querySelector('[data-in-game-preview="true"]');
  if (node === null) throw new Error('no in-game preview button');
  return node as HTMLButtonElement;
}

beforeEach(() => {
  queryClientRef = null;
});

/* ── the schematic ───────────────────────────────────────────────────────── */

describe('导播预览', () => {
  it('focuses the selected shot and draws only the current heading and field of view', async () => {
    mount();
    await serviceOnline();

    await waitFor(() => {
      expect(document.querySelector('[data-layer="camera"]')).not.toBeNull();
    });
    expect(document.querySelectorAll('[data-keyframe]')).toHaveLength(4);
    expect(document.querySelector('[data-map-focus="bounded"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-role="fov-wedge"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-role="heading"]')).toHaveLength(1);
    expect(document.querySelector('[data-role="camera-start-label"]')).toBeNull();
    expect(document.querySelector('[data-role="camera-end-label"]')).toBeNull();
  });

  it('keeps the third dimension — the radar cannot carry it', async () => {
    mount();
    await serviceOnline();

    await waitFor(() => {
      expect(document.querySelector('[data-camera-height]')).not.toBeNull();
    });
    /* The fixture climbs from z −160 to 120 and settles at 40: a 280-unit span,
       which is exactly what a plan-view-only preview would have hidden. */
    expect(document.querySelector('[data-camera-height]')?.getAttribute('data-camera-height'))
      .toBe('280');
  });

  it('prints the caption the artboard prints, and says what the marker is not', async () => {
    mount();
    await serviceOnline();
    await waitFor(() => {
      expect(document.body.textContent).toContain('导播预览为相机路径示意，不是最终画质');
    });
    expect(document.body.textContent).toContain('实际会按三次曲线插值飞行');
  });

  it('prints the director’s own explanation and evidence, not a paraphrase', async () => {
    mount();
    await serviceOnline();
    await waitFor(() => {
      expect(document.querySelector('[data-director-shot="true"]')).not.toBeNull();
    });
    expect(document.body.textContent).toContain(
      'Adjacent observer shots on the same approach were merged.',
    );
    expect(document.body.textContent).toContain('round-21:entry');
    /* Two items landed in one director shot; the panel says so rather than
       drawing a preview that silently covers a neighbour. */
    expect(document.body.textContent).toContain('共 2 个片段');
  });

  it('lists the prerequisites and draws no path when the preview is not ready', async () => {
    mount({ preview: blockedCameraPreview() });
    await serviceOnline();

    await waitFor(() => {
      expect(document.querySelector('[data-camera-path="blocked"]')).not.toBeNull();
    });
    expect(document.body.textContent).toContain(
      'Only 2 usable replay frames were sampled for this window.',
    );
    expect(document.querySelector('[data-layer="camera"]')).toBeNull();
    expect(document.querySelector('[data-camera-height]')).toBeNull();
  });
});

/* ── the door into the game ──────────────────────────────────────────────── */

describe('在游戏里预览', () => {
  it('takes an explicit confirmation that says it does not record', async () => {
    const harness = mount();
    await serviceOnline();

    await waitFor(() => {
      expect(inGameButton().hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(inGameButton());

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/这不是录制/u)).toBeTruthy();
    /* Nothing has happened yet — the dialog is the gate, not a notification. */
    expect(harness.reached).not.toContain('exportHlaeProposal');
    expect(harness.reached).not.toContain('playDemo');
  });

  it('writes the bundle and then launches the Demo at the shot’s first tick', async () => {
    const harness = mount();
    await serviceOnline();
    await waitFor(() => {
      expect(inGameButton().hasAttribute('disabled')).toBe(false);
    });

    fireEvent.click(inGameButton());
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '启动游戏' }));

    await waitFor(() => {
      expect(harness.reached).toContain('playDemo');
    });
    const order = harness.reached.filter(
      (name) => name === 'previewHlaeProposal' || name === 'exportHlaeProposal' || name === 'playDemo',
    );
    expect(order.slice(-2)).toEqual(['exportHlaeProposal', 'playDemo']);
    /* The default selection is 建立地点, which starts at 148 700. */
    expect(harness.playbackOptions[0]?.start_tick).toBe(148_700);
    /* And nothing recorded. */
    expect(harness.reached).not.toContain('executeRecordingPlan');
  });

  it('prints where the bundle went, because the game does not load it by itself', async () => {
    mount();
    await serviceOnline();
    await waitFor(() => {
      expect(inGameButton().hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(inGameButton());
    const dialog = await screen.findByRole('dialog');
    /* The dialog says it, before anything happens. */
    expect(within(dialog).getByText(/本地服务不会替你加载/u)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '启动游戏' }));

    await waitFor(() => {
      expect(document.querySelector('[data-hlae-bundle="true"]')).not.toBeNull();
    });
    expect(document.body.textContent).toContain('C:\\VibeCS\\hlae-plans\\x');
    expect(document.body.textContent).toContain('游戏不会自动加载');
    /* Outside the desktop shell the directory cannot be opened; the button is
       disabled with a written reason rather than absent. */
    const open = screen.getByRole('button', { name: '打开脚本目录' });
    expect(open.hasAttribute('disabled')).toBe(true);
  });

  it('offers 停止预览 instead while the game is already replaying something', async () => {
    mount({ session: 'playback' });
    await serviceOnline();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '停止预览' })).toBeTruthy();
    });
    expect(document.querySelector('[data-in-game-preview="true"]')).toBeNull();
  });

  it('is disabled during a recording, because the service refuses one anyway', async () => {
    mount({ session: 'recording' });
    await serviceOnline();

    await waitFor(() => {
      expect(document.body.textContent).toContain('正在录制，录制期间不能再启动一次回放');
    });
  });
});

/* ── the gate, exhaustively ──────────────────────────────────────────────── */

describe('inGameGate', () => {
  const online = { blocked: false, buttonProps: { disabled: false }, suffix: undefined };
  const intent = {
    demo_id: 'demo',
    highlight_ids: ['h-1'],
    camera_style: 'tracking' as const,
    mode: 'preview' as const,
    lead_seconds: 1,
    tail_seconds: 1,
  };
  const base = {
    service: online,
    preflight: null,
    intent,
    status: 'ready' as const,
    running: false,
    recording: false,
    stage: 'idle' as const,
  };

  it('opens when the path is compiled and nothing else is using the game', () => {
    expect(inGameGate(base)).toEqual({ disabled: false });
  });

  it('says the shot has no highlight to sample from', () => {
    const answer = inGameGate({ ...base, intent: null });
    expect(answer.disabled).toBe(true);
    expect(answer.disabledReason).toContain('没有绑定高光');
  });

  it('reads the preflight’s own rows rather than probing again', () => {
    const gameMissing = inGameGate({
      ...base,
      preflight: {
        blocking: 1,
        checks: [
          { code: 'game_ready', state: 'blocked', detail: '', affected_item_ids: [] },
        ],
      },
    });
    expect(gameMissing.disabledReason).toContain('没有找到可用的 CS2');

    const captureMissing = inGameGate({
      ...base,
      preflight: {
        blocking: 1,
        checks: [
          { code: 'capture_component_ready', state: 'blocked', detail: '', affected_item_ids: [] },
        ],
      },
    });
    expect(captureMissing.disabledReason).toContain('采集组件');
  });

  it('is not blocked by a preflight *warning* — that is the whole contract', () => {
    expect(
      inGameGate({
        ...base,
        preflight: {
          blocking: 0,
          checks: [
            {
              code: 'camera_collision_unverified',
              state: 'warning',
              detail: '',
              affected_item_ids: ['item-2'],
            },
          ],
        },
      }),
    ).toEqual({ disabled: false });
  });

  it('waits for the path before offering to draw it in game', () => {
    expect(inGameGate({ ...base, status: 'loading' }).disabled).toBe(true);
    expect(inGameGate({ ...base, status: 'blocked' }).disabled).toBe(true);
  });

  it('reports the service before anything else — it is the reason nothing works', () => {
    const blocked = {
      blocked: true,
      buttonProps: { disabled: true, disabledReason: '本地服务未连接' },
      suffix: undefined,
    };
    expect(inGameGate({ ...base, service: blocked, intent: null }).disabledReason)
      .toBe('本地服务未连接');
  });
});
