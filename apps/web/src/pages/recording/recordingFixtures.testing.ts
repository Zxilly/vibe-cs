/*
 * pages/recording — one set of fixtures for 「08」's markup and interaction
 * tests.
 *
 * Not a `.test.` file, so nothing here runs on its own; it exists because the
 * four blocks are tested separately and a second spelling of the same plan
 * would let two tests disagree about what the page is looking at. The shape is
 * the artboard's: four shots, one of them POV, one carrying a risk, on Mirage.
 *
 * Every value is the wire's, not a presentation model: these objects go into a
 * `DesktopClientProvider` stub and come back out through the real hooks.
 */

import type {
  AgentPlan,
  AgentPlanShot,
  AppConfig,
  DirectorPlan,
  HlaeProposalPreview,
  RecordingPlanResponse,
  RecordingPreflight,
} from '../../shared/desktop/dto';
import type { DemoSummary } from '../../shared/desktop/viewModels';
import type { RecordingShot } from './recordingContract';

export const DEMO_ID = '0d1f0a2c-0000-4000-8000-000000000001';
export const AGENT_PLAN_ID = 'P-118';
export const PLAN_LEASE_ID = 'lease-1';

export const RECORDING_DEFAULTS: AppConfig['recording'] = {
  pre_roll_seconds: 1.5,
  post_roll_seconds: 1,
  resolution: '1920x1080',
  fps: 60,
  show_radar: true,
  show_hud: true,
  voice: 'all_players',
  camera_fov: 90,
  viewmodel_fov: 68,
  flash_alpha: 255,
};

export function recordingItem(overrides: Partial<RecordingShot> = {}): RecordingShot {
  return {
    id: 'item-1',
    demo_id: DEMO_ID,
    highlight_id: 'h-1',
    player_id: '76561198000000001',
    title: '建立地点',
    start_tick: 148_700,
    end_tick: 148_812,
    pre_roll_seconds: 1.5,
    post_roll_seconds: 1,
    victim_pov: false,
    camera_style: 'static',
    presentation: null,
    ...overrides,
  };
}

/** The artboard's four: 建立地点 / 跟随突破 / 选手 POV · 三杀 / 高潮后升起. */
export const ITEMS: readonly RecordingShot[] = [
  recordingItem({ id: 'item-1', title: '建立地点', camera_style: 'static' }),
  recordingItem({
    id: 'item-2',
    title: '跟随突破',
    camera_style: 'tracking',
    start_tick: 148_812,
    end_tick: 149_356,
  }),
  recordingItem({
    id: 'item-3',
    title: '选手 POV · 三杀',
    camera_style: 'pov',
    start_tick: 148_920,
    end_tick: 150_440,
    highlight_id: 'h-3',
  }),
  recordingItem({
    id: 'item-4',
    title: '高潮后升起',
    camera_style: 'crane',
    start_tick: 150_440,
    end_tick: 150_856,
    highlight_id: 'h-4',
  }),
];

export const DIRECTOR: DirectorPlan = {
  shots: [
    {
      demo_id: DEMO_ID,
      source_item_ids: ['item-1', 'item-2'],
      player_id: '76561198000000001',
      kind: 'player',
      start_tick: 148_700,
      end_tick: 149_356,
      score: 0.82,
      evidence: ['round-21:entry', 'round-21:wallbang'],
      explanation: 'Adjacent observer shots on the same approach were merged.',
    },
    {
      demo_id: DEMO_ID,
      source_item_ids: ['item-3'],
      player_id: '76561198000000001',
      kind: 'player',
      start_tick: 148_920,
      end_tick: 150_440,
      score: 0.94,
      evidence: ['round-21:triple'],
      explanation: 'The triple kill is the payoff, so it runs uncut in first person.',
    },
  ],
  warnings: [],
  source_item_count: 4,
  merged_item_count: 2,
  victim_reaction_count: 0,
  unresolved_victim_requests: 0,
};

export function recordingPlan(
  overrides: Partial<RecordingPlanResponse> = {},
): RecordingPlanResponse {
  return {
    plan_id: PLAN_LEASE_ID,
    /* Far enough ahead that the lease clock never expires mid-test. */
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    active_items: 4,
    disabled_items: 0,
    estimated_seconds: 42,
    warnings: ['Duration estimate unavailable for 1 shot.'],
    items: [...ITEMS],
    director: DIRECTOR,
    ...overrides,
  };
}

/** All eight rows, the way the artboard draws them: seven ok, one warning. */
export function preflight(overrides: Partial<RecordingPreflight> = {}): RecordingPreflight {
  return {
    blocking: 0,
    checks: [
      { code: 'game_ready', state: 'ok', detail: 'cs2.exe 1.40.7.2', affected_item_ids: [] },
      {
        code: 'capture_component_ready',
        state: 'ok',
        detail: 'HLAE 2.176.1 verified',
        affected_item_ids: [],
      },
      { code: 'demo_content_matches', state: 'ok', detail: '', affected_item_ids: [] },
      {
        code: 'output_directory_writable',
        state: 'ok',
        detail: '218 GB free',
        affected_item_ids: [],
      },
      { code: 'spectator_evidence_complete', state: 'ok', detail: '', affected_item_ids: [] },
      { code: 'encoder_available', state: 'ok', detail: 'H.264 / AAC', affected_item_ids: [] },
      { code: 'tick_range_within_demo', state: 'ok', detail: '', affected_item_ids: [] },
      {
        code: 'camera_collision_unverified',
        state: 'warning',
        detail: '3 observer shots',
        affected_item_ids: ['item-2'],
      },
    ],
    ...overrides,
  };
}

/** One row blocked, so 开始录制 must be disabled. */
export function blockedPreflight(): RecordingPreflight {
  const base = preflight();
  return {
    blocking: 1,
    checks: base.checks.map((check) =>
      check.code === 'output_directory_writable'
        ? { ...check, state: 'blocked' as const, detail: '2 GB free, 14 GB required' }
        : check,
    ),
  };
}

function planShot(overrides: Partial<AgentPlanShot> = {}): AgentPlanShot {
  return {
    id: 'item-1',
    title: '建立地点',
    kind: 'static',
    view: 'observer',
    start_tick: 148_700,
    end_tick: 148_812,
    duration_seconds: 1.75,
    rationale: '',
    evidence_refs: [],
    risks: [],
    source: 'agent',
    removed_by: null,
    params: {},
    recording: {
      demo_id: DEMO_ID,
      player_id: '76561198000000001',
      highlight_id: 'h-1',
      victim_pov: false,
      pre_roll_seconds: 1.5,
      post_roll_seconds: 1,
      presentation: null,
    },
    ...overrides,
  };
}

export const AGENT_PLAN: AgentPlan = {
  id: AGENT_PLAN_ID,
  title: 'Kael_Mirage_1v3',
  status: 'awaiting_confirmation',
  revision: 7,
  shots: [
    planShot({ id: 'item-1' }),
    planShot({
      id: 'item-2',
      title: '跟随突破',
      kind: 'tracking',
      start_tick: 148_812,
      end_tick: 149_356,
      duration_seconds: 8.5,
      risks: ['穿墙风险已知悉'],
    }),
    planShot({
      id: 'item-3',
      title: '选手 POV · 三杀',
      kind: 'pov',
      view: 'player_pov',
      start_tick: 148_920,
      end_tick: 150_440,
      duration_seconds: 23.75,
    }),
    planShot({
      id: 'item-4',
      title: '高潮后升起',
      kind: 'crane',
      start_tick: 150_440,
      end_tick: 150_856,
      duration_seconds: 6.5,
    }),
  ],
  origin: [],
  agent_baseline: { revision: 1, captured_at: '2026-08-15T09:02:00.000Z', shots: [] },
  created_at: '2026-08-15T09:02:00.000Z',
  updated_at: '2026-08-15T09:47:00.000Z',
};

/** A plan whose shots carry no binding — the 422 the page has to explain. */
export const UNBOUND_PLAN: AgentPlan = {
  ...AGENT_PLAN,
  shots: AGENT_PLAN.shots.map((shot) => ({ ...shot, recording: null })),
};

/** `getDemo` answers a `DemoSummary`; `map_name` on it is what the director
 *  preview projects the camera path onto. */
export const DEMO: DemoSummary = {
  id: DEMO_ID,
  path: 'D:\\CS2\\demos\\aurora.dem',
  filename: 'aurora.dem',
  display_name: 'aurora',
  map_name: 'de_mirage',
  match_date: '2026-08-14T20:00:00.000Z',
  cataloged_at: '2026-08-14T21:00:00.000Z',
  duration_seconds: 2400,
  total_rounds: 24,
  score_team_a: null,
  score_team_b: null,
  team_a_name: null,
  team_b_name: null,
  status: 'ready',
  lifecycle_status: 'ready',
  players: [],
  source: 'local',
  remark: '',
  updated_at: '2026-08-14T21:00:00.000Z',
};

/** A compiled camera path: four keyframes that climb and then drop. */
export function cameraPreview(
  overrides: Partial<HlaeProposalPreview> = {},
): HlaeProposalPreview {
  return {
    proposal_revision: 1,
    ready: true,
    prerequisites: [],
    base_fingerprint: 'base',
    proposal_fingerprint: 'proposal',
    confirmation_token: 'token',
    typed_plan: {
      mode: 'preview',
      tickRate: 64,
      shots: [
        {
          id: 'shot-a',
          startTick: 148_812,
          endTick: 149_356,
          positionInterpolation: 'cubic',
          rotationInterpolation: 'sphericalCubic',
          keyframes: [
            { tick: 148_812, position: { x: -1000, y: -500, z: -160 }, rotation: { pitch: 0, yaw: 45, roll: 0 }, fov: 90 },
            { tick: 148_960, position: { x: -600, y: -200, z: -40 }, rotation: { pitch: 0, yaw: 90, roll: 0 }, fov: 90 },
            { tick: 149_180, position: { x: -200, y: 200, z: 120 }, rotation: { pitch: 0, yaw: 132, roll: 0 }, fov: 100 },
            { tick: 149_356, position: { x: 200, y: 600, z: 40 }, rotation: { pitch: 0, yaw: 180, roll: 0 }, fov: 100 },
          ],
        },
      ],
    },
    compiled_preview: null,
    notices: ['Preview mode draws the camera path and records nothing.'],
    installation_status: null,
    ...overrides,
  };
}

/** Not ready: the sampler could not find four usable frames. */
export function blockedCameraPreview(): HlaeProposalPreview {
  return cameraPreview({
    ready: false,
    base_fingerprint: null,
    proposal_fingerprint: null,
    confirmation_token: null,
    typed_plan: null,
    prerequisites: [
      {
        code: 'insufficient_replay_frames',
        message: 'Only 2 usable replay frames were sampled for this window.',
      },
    ],
  });
}
