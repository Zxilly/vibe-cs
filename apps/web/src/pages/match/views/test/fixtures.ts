/*
 * Test-only fixtures for 回放 / 高光 / Review.
 *
 * `pages/match/test/fixtures.ts` carries the shell's version of the artboard's
 * match — identity, score, three rounds, two highlights. These three views need
 * more of it than the shell does: rounds with their events inline, an insights
 * block with its capability flags, a decoded replay payload, positioned events
 * and a radar transform. Extending the shell's file would put a phase-3c view's
 * needs into a fixture three other agents share, so the extra shapes live here
 * and the ids agree with it (`DEMO_ID`, `kael` / `sable`).
 *
 * World coordinates are inside Mirage's overview square — the checked-in
 * calibration is `pos_x -3230 / pos_y 1713 / scale 5` over 1024px, so x and y
 * both live in roughly [-3200, 1700]. Points outside it would be *correctly*
 * dropped by `binWorldSamples`, and a fixture that silently produced an empty
 * heat map would make the tests agree with a bug.
 *
 * Under `test/` so `lingui.config.ts` keeps the Chinese in here out of the
 * catalogue and vitest does not mistake the file for a suite.
 */

import type {
  AnalysisWorkspace,
  EvidenceAnnotation,
  HeatPointRecord,
  Highlight,
  LlmReviewResult,
  Paginated,
  RadarOverviewRecord,
  ReplayFrameRecord,
  ReplayPayload,
  ReplayPlayerRecord,
  RoundSummary,
  TimelineEvent,
} from '../../../../shared/desktop/dto';

export const DEMO_ID = 'aurora-vs-meridian';
export const TICK_RATE = 64;

export const ROUND_21 = { number: 21, startTick: 148_920, endTick: 150_440 } as const;

/* ── the replay stream ───────────────────────────────────────────────────── */

function player(
  id: string,
  name: string,
  team: string,
  x: number,
  y: number,
  alive = true,
): ReplayPlayerRecord {
  return {
    id,
    name,
    team,
    position: [x, y, 64],
    yaw: 90,
    health: alive ? 78 : 0,
    armor: 100,
    alive,
    weapon: 'ak47',
    input: null,
  };
}

/** Nine frames one game second apart, walking three players across A site. */
export const REPLAY_FRAMES: readonly ReplayFrameRecord[] = Array.from({ length: 9 }, (_, index) => ({
  tick: 149_000 + index * TICK_RATE,
  players: [
    player('kael', 'Kael', 'CT', -1_200 + index * 120, -400 + index * 90),
    player('sable', 'Sable', 'T', 400 - index * 60, 900 - index * 40, index < 3),
    player('corvin', 'Corvin', 'T', -200 + index * 30, 1_100 - index * 70, index < 6),
  ],
  projectiles: [],
  bomb: null,
}));

export const REPLAY: ReplayPayload = {
  frames: [...REPLAY_FRAMES],
  fidelity: {
    mode: 'entity_snapshots',
    tick_rate: TICK_RATE,
    frame_count: REPLAY_FRAMES.length,
    positioned_event_count: 3,
    start_tick: 149_000,
    end_tick: 149_512,
  },
  cache: { state: 'hit', key: 'k', bytes: 1_024, generated_at: null, repaired: false, reason: null },
};

/* ── the analysis document ───────────────────────────────────────────────── */

function event(
  id: string,
  tick: number,
  kind: TimelineEvent['kind'],
  extra: Partial<TimelineEvent> = {},
): TimelineEvent {
  return {
    id,
    tick,
    seconds: (tick - ROUND_21.startTick) / TICK_RATE,
    kind,
    actor: null,
    target: null,
    weapon: null,
    headshot: false,
    penetrated: false,
    position: null,
    detail: null,
    ...extra,
  };
}

export const ROUND_21_EVENTS: readonly TimelineEvent[] = [
  event('e-dmg', 149_100, 'damage', { actor: 'kael', target: 'sable' }),
  event('e-kill-sable', 149_128, 'kill', {
    actor: 'kael',
    target: 'sable',
    weapon: 'ak47',
    headshot: true,
  }),
  event('e-plant', 149_256, 'bomb_plant', { actor: 'corvin' }),
  event('e-kill-corvin', 149_320, 'kill', {
    actor: 'kael',
    target: 'corvin',
    weapon: 'ak47',
    penetrated: true,
  }),
];

function round(number: number, events: readonly TimelineEvent[] = []): RoundSummary {
  const start = number === 21 ? ROUND_21.startTick : 10_000 + number * 6_000;
  return {
    number,
    winner: number % 2 === 0 ? 'B' : 'A',
    reason: 'ct_killed',
    start_tick: start,
    end_tick: number === 21 ? ROUND_21.endTick : start + 5_400,
    team_a_score: number,
    team_b_score: 0,
    events: [...events],
  };
}

function highlight(
  id: string,
  kind: Highlight['kind'],
  label: string,
  roundNumber: number,
  playerId: string,
  startTick: number,
  endTick: number,
  description: string,
): Highlight {
  return {
    id,
    label,
    category: 'clutch',
    kind,
    description,
    tags: [kind],
    victims: [],
    player_id: playerId,
    round: roundNumber,
    start_tick: startTick,
    end_tick: endTick,
    confidence: 0.9,
  };
}

export const HIGHLIGHTS: readonly Highlight[] = [
  highlight('h-21-clutch', 'clutch', '1v3 残局', 21, 'kael', 148_920, 150_440, '三杀后拆包，剩余 1.8 秒'),
  highlight('h-21-wallbang', 'wallbang', '穿墙', 21, 'kael', 149_340, 149_420, 'A 大道 18.7m'),
  highlight('h-18-multi', 'multi_kill', '四杀', 18, 'sable', 124_500, 126_010, 'B 点连续四杀'),
  highlight('h-7-noscope', 'no_scope', '盲狙', 7, 'corvin', 51_300, 51_620, '闪光中命中 AWP'),
];

export const ANALYSIS: AnalysisWorkspace = {
  demo_id: DEMO_ID,
  map_name: 'de_mirage',
  tick_rate: TICK_RATE,
  duration_seconds: 2_412,
  teams: [
    { name: 'Aurora', side: 'CT', score: 13, players: ['kael'] },
    { name: 'Meridian', side: 'T', score: 11, players: ['sable', 'corvin'] },
  ],
  players: [
    {
      id: 'kael',
      name: 'Kael',
      team: 'A',
      kills: 27,
      deaths: 14,
      assists: 5,
      headshot_rate: 0.62,
      kill_death_ratio: 1.93,
      adr: 98.4,
    },
    {
      id: 'sable',
      name: 'Sable',
      team: 'B',
      kills: 24,
      deaths: 17,
      assists: 7,
      headshot_rate: 0.58,
      kill_death_ratio: 1.41,
      adr: 91.2,
    },
    {
      id: 'corvin',
      name: 'Corvin',
      team: 'B',
      kills: 18,
      deaths: 19,
      assists: 4,
      headshot_rate: 0.44,
      kill_death_ratio: 0.95,
      adr: 74.1,
    },
  ],
  rounds: [round(7), round(18), round(21, ROUND_21_EVENTS)],
  highlights: [...HIGHLIGHTS],
  insights: {
    round_economy: [],
    player_utility: [
      {
        player_id: 'kael',
        throws: 12,
        detonations: 9,
        items: [],
        damage: 184.4,
        damage_events: 6,
        flash_events: 4,
        players_flashed: 7,
        flash_duration_seconds: 9.2,
      },
    ],
    matchups: [
      {
        player_id: 'kael',
        opponent_id: 'sable',
        kills: 5,
        deaths: 1,
        headshot_kills: 3,
        damage_dealt: 402,
        damage_taken: 118,
        damage_events: 9,
      },
    ],
    availability: {
      purchase_events: { available: false, reason: '这批 Demo 没有购买事件，经济曲线画不出来。' },
      purchase_spend: { available: false, reason: null },
      utility_events: { available: true, reason: null },
      utility_damage: { available: true, reason: null },
      flash_effects: { available: true, reason: null },
      matchups: { available: true, reason: null },
    },
  },
};

/** Same document with every derived capability switched off. */
export const ANALYSIS_WITHOUT_INSIGHTS: AnalysisWorkspace = {
  ...ANALYSIS,
  rounds: [round(7), round(18), round(21)],
  insights: {
    round_economy: [],
    player_utility: [],
    matchups: [],
    availability: {
      purchase_events: { available: false, reason: '没有购买事件。' },
      purchase_spend: { available: false, reason: null },
      utility_events: { available: false, reason: '没有道具事件。' },
      utility_damage: { available: false, reason: null },
      flash_effects: { available: false, reason: null },
      matchups: { available: false, reason: '这份解析没有逐对位归因。' },
    },
  },
};

/* ── the map reads ───────────────────────────────────────────────────────── */

function heatPoint(
  id: string,
  x: number,
  y: number,
  roundNumber: number | null,
  floor = 0,
): HeatPointRecord {
  return {
    id,
    round: roundNumber,
    tick: 149_128,
    x,
    y,
    weight: 1,
    floor,
    kind: 'death',
    player_id: 'sable',
    side: 'T',
    event_kind: 'kill',
  };
}

export const HEAT_POINTS: readonly HeatPointRecord[] = [
  heatPoint('p1', -500, 200, 21),
  heatPoint('p2', -480, 220, 21),
  heatPoint('p3', -460, 240, 21),
  heatPoint('p4', 300, -800, 21, 1),
  heatPoint('p5', 900, -1_200, 18),
  heatPoint('p6', 1_100, -1_400, null),
];

export const RADAR: RadarOverviewRecord = {
  map_name: 'de_mirage',
  transform: { pos_x: -3_230, pos_y: 1_713, scale: 5, rotate: false, zoom: null },
  image_url: null,
  image_mime: null,
  browser_displayable: false,
};

/* ── review ──────────────────────────────────────────────────────────────── */

function annotation(
  id: string,
  body: string,
  state: EvidenceAnnotation['review_state'],
): EvidenceAnnotation {
  return {
    id,
    demo_id: DEMO_ID,
    evidence_id: 'e-kill-sable',
    round: 21,
    tick: 149_128,
    body,
    tags: [],
    review_state: state,
    created_at: '2026-08-15T10:00:00.000Z',
    updated_at: '2026-08-15T10:00:00.000Z',
  };
}

export const ANNOTATIONS: Paginated<EvidenceAnnotation> = {
  items: [annotation('a-1', 'R21 的穿墙点可做教学', 'open'), annotation('a-2', 'R19 Rhea 的站位要改', 'resolved')],
  total: 2,
  page: 1,
  page_size: 20,
};

export const REVIEW_RESULT: LlmReviewResult = {
  demo_id: DEMO_ID,
  scope: 'match',
  player_id: null,
  highlight_ids: [],
  tone: 'analytical',
  commentary: 'Aurora 赢在中路的信息优势。',
  evidence_ids: ['h-21-clutch', 'e-kill-sable', 'unknown-evidence'],
  evidence_sha256: 'deadbeef',
  provider: 'openai',
  model: 'gpt-test',
  generated_at: '2026-08-16T09:00:00.000Z',
  cached: true,
};
