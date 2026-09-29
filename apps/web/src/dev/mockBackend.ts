/**
 * The fixture backend behind `mockBridge.ts`.
 *
 * ## What this is, and what it is not
 *
 * It answers the routes of `shared/desktop/client.ts` with fixed sample data so
 * that `pnpm dev` in a browser renders *populated* screens. It is a stage set:
 * enough of a library, a queue, a plan and a project for every list, table,
 * card and empty state to be looked at. It is not a second implementation of
 * the service — nothing here computes, and a write is answered with the shape a
 * write returns rather than being remembered.
 *
 * Two consequences worth stating plainly:
 *
 *   · Behaviour that depends on the *server* — optimistic-concurrency 409s,
 *     progress that advances, an analysis that finishes — is not reproduced
 *     here. Verify those with `pnpm desktop:dev`.
 *   · Everything that depends on the *client* — layout, type scale, spacing,
 *     dark theme, sort, filter, keyboard, focus, i18n — is fully exercised,
 *     and that is the whole set of things a design review is about.
 *
 * ## Why the fixtures are typed
 *
 * Each one is annotated with its wire type from `shared/desktop/dto`, which is
 * generated out of Rust by ts-rs. A field the service renames or drops fails
 * `tsc` here rather than quietly rendering a blank cell — the same reason
 * `data/test/renderDataHook.tsx` typechecks its stubs. A fixture that has
 * drifted from the contract is worse than no fixture, because it looks right.
 *
 * ## Why the timestamps are frozen
 *
 * Every date below is a literal. Two screenshots taken a day apart are then
 * comparable, and 「2 分钟前」 never turns into 「3 天前」 between a change and
 * its check. It also makes the data unmistakably fake at a glance.
 */

import { applyMockPatch, mockProject, revertMockChangeGroup } from './mockProjectEdits';
import { mockReplayBinary } from './mockReplay';
import geometryFixtureUrl from './fixtures/scene3d.vmap?url';
import { PREVIEW_DELIVERY_GATE } from './projectFixtures';
import cameraFixture from './fixtures/camera-preview';
import type {
  ProjectPatch,
  ActivityFeed,
  AgentSessionPage,
  AgentSessionStorageStats,
  AgentStatus,
  AgentWorkspaceSettings,
  AppConfig,
  AvatarCacheStatus,
  DeleteOutputResult,
  DemoRecord,
  DemoPlaybackStatus,
  DemoWatchStatus,
  DetectedPaths,
  EvidenceSearchResponse,
  HlaeStatus,
  LineupDirectoryPage,
  MatchAnalysisRecord,
  MatchHistoryItem,
  MediaAsset,
  OutputPage,
  Paginated,
  PlayerDirectoryPage,
  PlayerHeatmap,
  PlayerMapPage,
  PlayerMatchPage,
  PlayerProfile,
  QuickCheckResponse,
  RecordedClipRecord,
  RecordingJob,
  CleanupMissingOutputsResult,
  CleanupStagedOutputsResult,
  RecoveryScan,
  RecoveryStatus,
  ReplayCacheStatus,
  ReviewTag,
  RuntimeState,
  StorageStatus,
  ExportJobRecord,
  EvidenceAnnotation,
  EvidenceSearchItem,
  MatchDownloadJob,
} from '../shared/desktop/dto';

/** Rejected with when no route matches — same shape as a Rust command failure. */
export class MockRouteMissing extends Error {
  readonly status = 501;
  readonly code = 'MOCK_ROUTE_MISSING';

  constructor(method: string, path: string) {
    super(`浏览器模式没有这条路由的样例数据：${method} ${path}`);
    this.name = 'MockRouteMissing';
  }
}

const NOW = '2026-08-15T09:41:00Z';
const DATA_DIR = 'C:\\Users\\demo\\AppData\\Roaming\\vibe-cs';

function paged<T>(items: readonly T[]): Paginated<T> {
  return { items: [...items], total: items.length, page: 1, page_size: 20 };
}

/* ── the demo library ─────────────────────────────────────────────────────── */

/* ── evidence ─────────────────────────────────────────────────────────────── */

/** One kill, one purchase, one round boundary and one highlight per round,
 *  spread over the three analysed demos, so 「05 证据检索」 has every row shape
 *  on its first page and the 注释 face has notes from more than one match. */
const EVIDENCE_DEMOS = [
  { id: '3f2c9a10-11d4-4a6e-9d21-6b0f1a2c3d41', name: 'NAVI vs FaZe · Mirage', map: 'de_mirage', date: '2026-08-11T18:20:00Z', players: ['s1mple', 'b1t', 'NiKo', 'ropz'] },
  { id: '5b81e4c7-22d4-4a6e-9d21-6b0f1a2c3d42', name: 'Vitality vs G2 · Inferno', map: 'de_inferno', date: '2026-08-13T15:05:00Z', players: ['ZywOo', 'apEX', 'm0NESY', 'HooXi'] },
  { id: '7d40b2f9-33d4-4a6e-9d21-6b0f1a2c3d43', name: '队内训练赛 · Ancient', map: 'de_ancient', date: '2026-08-12T12:00:00Z', players: ['Kael', 'Sable', 'Corvin', 'Ilse'] },
] as const;

const EVIDENCE_WEAPONS = ['ak47', 'usp_silencer', 'awp', 'deagle', 'm4a1_silencer', 'glock'] as const;

function evidenceRow(
  demo: (typeof EVIDENCE_DEMOS)[number],
  round: number,
  tick: number,
  sourceKind: EvidenceSearchItem['source_kind'],
  sourceId: string,
  eventType: string,
  fields: Partial<EvidenceSearchItem>,
): EvidenceSearchItem {
  const evidenceId = `demo:${demo.id}/${sourceKind}:${sourceId}`;
  return {
    evidence_id: evidenceId,
    demo_id: demo.id,
    demo_display_name: demo.name,
    map_name: demo.map,
    match_date: demo.date,
    round,
    tick,
    end_tick: tick,
    event_type: eventType,
    actor_id: null,
    actor_name: null,
    target_id: null,
    target_name: null,
    weapon: null,
    headshot: null,
    penetrated: null,
    source_kind: sourceKind,
    source_id: sourceId,
    attributes: {},
    analysis_href: `/demos/${demo.id}/analysis`,
    replay_href: `/demos/${demo.id}/replay`,
    ...fields,
  };
}

const EVIDENCE_ROWS: EvidenceSearchItem[] = EVIDENCE_DEMOS.flatMap((demo, demoIndex) =>
  Array.from({ length: 6 }, (_, index): EvidenceSearchItem[] => {
    const round = index + 1;
    const base = 3_200 + index * 7_040 + demoIndex * 100_000;
    const actor: string = demo.players[index % 4] ?? 'Kael';
    const target: string = demo.players[(index + 1) % 4] ?? 'Sable';
    const weapon: string = EVIDENCE_WEAPONS[(index + demoIndex) % EVIDENCE_WEAPONS.length] ?? 'ak47';
    const named = (name: string) => ({ id: `STEAM_${name.toUpperCase()}`, name });
    const rows: EvidenceSearchItem[] = [
      evidenceRow(demo, round, base, 'event', `round_start-${String(base)}-1`, 'round_start', {}),
      evidenceRow(demo, round, base + 320, 'event', `item_purchase-${String(base + 320)}-1`, 'purchase', {
        actor_id: named(actor).id,
        actor_name: actor,
        weapon: index % 2 === 0 ? 'Kevlar Vest' : 'Flashbang',
      }),
      evidenceRow(demo, round, base + 2_880, 'event', `player_death-${String(base + 2_880)}-1`, 'kill', {
        actor_id: named(actor).id,
        actor_name: actor,
        target_id: named(target).id,
        target_name: target,
        weapon,
        headshot: index % 3 === 0,
        penetrated: index % 4 === 1,
        attributes: { position: [-1200 + index * 90, 640 - index * 40, 64] },
      }),
    ];
    if (index % 2 === 1) {
      rows.push(
        evidenceRow(demo, round, base + 2_880, 'highlight', `hl-${String(demoIndex)}-${String(index)}`, 'multi_kill', {
          end_tick: base + 3_600,
          actor_id: named(actor).id,
          actor_name: actor,
          weapon,
        }),
      );
    }
    return rows;
  }).flat(),
);

const EVIDENCE_FAMILY_OF: Readonly<Record<string, string>> = {
  kill: 'kill',
  multi_kill: 'multi_kill',
  round_start: 'round_start',
};

function evidenceSearch(query: URLSearchParams): EvidenceSearchResponse {
  const family = query.get('event_family');
  const q = query.get('q')?.trim().toLowerCase() ?? '';
  const player = query.get('player')?.trim().toLowerCase() ?? '';
  const weapon = query.get('weapon')?.trim().toLowerCase() ?? '';
  const map = query.get('map')?.trim().toLowerCase() ?? '';
  const headshot = query.get('headshot') === 'true';
  const page = Math.max(1, Number(query.get('page') ?? '1'));
  const pageSize = Math.max(1, Number(query.get('page_size') ?? '20'));
  const hits = EVIDENCE_ROWS.filter((row) => {
    if (family !== null && EVIDENCE_FAMILY_OF[row.event_type] !== family) return false;
    if (headshot && row.headshot !== true) return false;
    if (map !== '' && row.map_name.toLowerCase() !== map) return false;
    if (weapon !== '' && row.weapon?.toLowerCase() !== weapon) return false;
    if (player !== '' && row.actor_name?.toLowerCase() !== player && row.target_name?.toLowerCase() !== player) {
      return false;
    }
    if (q !== '') {
      const text = [row.demo_display_name, row.actor_name, row.target_name, row.weapon, row.event_type]
        .join(' ')
        .toLowerCase();
      if (!text.includes(q)) return false;
    }
    return true;
  });
  return {
    items: hits.slice((page - 1) * pageSize, page * pageSize),
    total: hits.length,
    page,
    page_size: pageSize,
    availability: {
      indexed_items: EVIDENCE_ROWS.length,
      indexed_demos: EVIDENCE_DEMOS.length,
      total_analyses: EVIDENCE_DEMOS.length,
      scan_complete: true,
      match_date: { available: true, indexed_items: EVIDENCE_ROWS.length, reason: null },
      source: { available: true, indexed_items: EVIDENCE_ROWS.length, reason: null },
    },
  };
}

const EVIDENCE_ANNOTATIONS: EvidenceAnnotation[] = [
  ['s1mple 的穿墙点可以单独做一条教学。', 0, 0, 'open', ['教学']],
  ['ZywOo 这波架点太深，回防慢了半拍。', 1, 1, 'resolved', ['复盘']],
  ['Kael 的 A 点连接处穿墙，配合烟雾时机很好。', 2, 2, 'open', ['教学', '穿墙']],
  ['b1t 这颗爆头是整场的转折点。', 0, 3, 'open', []],
  ['m0NESY 的 AWP 站位值得剪进集锦。', 1, 4, 'resolved', ['集锦']],
  ['Sable 的补枪慢了，下次训练重点。', 2, 5, 'open', ['训练']],
  ['第 1 回合手枪局的经济选择可以回顾。', 0, 1, 'resolved', ['经济']],
].map(([body, demoIndex, roundIndex, state, tags], index) => {
  const demo = EVIDENCE_DEMOS[demoIndex as number] as (typeof EVIDENCE_DEMOS)[number];
  const kill = EVIDENCE_ROWS.find(
    (row) => row.demo_id === demo.id && row.round === (roundIndex as number) + 1 && row.event_type === 'kill',
  ) as EvidenceSearchItem;
  return {
    id: `ann-${String(index + 1)}`,
    demo_id: demo.id,
    demo_display_name: demo.name,
    map_name: demo.map,
    evidence_id: kill.evidence_id,
    round: kill.round,
    tick: kill.tick,
    body: body as string,
    tags: tags as string[],
    review_state: state as EvidenceAnnotation['review_state'],
    created_at: '2026-08-14T21:00:00Z',
    updated_at: '2026-08-15T09:12:00Z',
  };
});


const DEMOS: DemoRecord[] = [
  {
    id: '3f2c9a10-11d4-4a6e-9d21-6b0f1a2c3d41',
    path: 'D:\\CS2\\demos\\navi-vs-faze-mirage.dem',
    file_name: 'navi-vs-faze-mirage.dem',
    display_name: 'NAVI vs FaZe · Mirage',
    source: 'local',
    status: 'ready',
    map_name: 'de_mirage',
    match_date: '2026-08-11T18:20:00Z',
    duration_seconds: 2_744,
    total_rounds: 24,
    team_a_name: 'NAVI',
    team_b_name: 'FaZe',
    team_a_score: 13,
    team_b_score: 11,
    players: ['s1mple', 'b1t', 'Aleksib', 'jL', 'iM'],
    remark: '半场落后 3 分后连下五局。',
    content_sha256: 'b1f0c9a2e4d7',
    file_size: 214_884_352,
    created_at: '2026-08-11T19:02:00Z',
    updated_at: '2026-08-14T10:15:00Z',
  },
  {
    id: '5b81e4c7-22d4-4a6e-9d21-6b0f1a2c3d42',
    path: 'D:\\CS2\\demos\\vitality-vs-g2-inferno.dem',
    file_name: 'vitality-vs-g2-inferno.dem',
    display_name: 'Vitality vs G2 · Inferno',
    source: 'watch',
    status: 'analyzing',
    map_name: 'de_inferno',
    match_date: '2026-08-13T15:05:00Z',
    duration_seconds: 3_120,
    total_rounds: 26,
    team_a_name: 'Vitality',
    team_b_name: 'G2',
    team_a_score: 14,
    team_b_score: 12,
    players: ['ZywOo', 'apEX', 'flameZ', 'mezii', 'NiKo'],
    remark: '',
    content_sha256: '7c33ab910de5',
    file_size: 248_512_000,
    created_at: '2026-08-13T15:58:00Z',
    updated_at: '2026-08-15T09:12:00Z',
  },
  {
    id: '7d40b2f9-33d4-4a6e-9d21-6b0f1a2c3d43',
    path: 'D:\\CS2\\demos\\scrim-ancient-0812.dem',
    file_name: 'scrim-ancient-0812.dem',
    display_name: '队内训练赛 · Ancient',
    source: 'upload',
    status: 'ready',
    map_name: 'de_ancient',
    match_date: '2026-08-12T12:00:00Z',
    duration_seconds: 1_980,
    total_rounds: 18,
    team_a_name: null,
    team_b_name: null,
    team_a_score: 10,
    team_b_score: 8,
    players: ['s1mple', 'b1t', 'Aleksib'],
    remark: 'B 点默认下包点位复盘。',
    content_sha256: '2ee4180fbc77',
    file_size: 158_334_976,
    created_at: '2026-08-12T12:44:00Z',
    updated_at: '2026-08-12T12:44:00Z',
  },
  {
    id: '9a17c5e2-44d4-4a6e-9d21-6b0f1a2c3d44',
    path: 'E:\\replays\\faceit-nuke-0809.dem',
    file_name: 'faceit-nuke-0809.dem',
    display_name: 'FACEIT 排位 · Nuke',
    source: 'local',
    status: 'failed',
    map_name: 'de_nuke',
    match_date: '2026-08-09T21:35:00Z',
    duration_seconds: null,
    total_rounds: null,
    team_a_name: null,
    team_b_name: null,
    team_a_score: null,
    team_b_score: null,
    players: [],
    remark: '',
    content_sha256: null,
    file_size: 96_468_992,
    created_at: '2026-08-09T22:10:00Z',
    updated_at: '2026-08-10T08:02:00Z',
  },
  {
    id: 'c6e2f80b-55d4-4a6e-9d21-6b0f1a2c3d45',
    path: 'E:\\replays\\premier-dust2-0805.dem',
    file_name: 'premier-dust2-0805.dem',
    display_name: 'Premier · Dust II',
    source: 'local',
    status: 'discovered',
    map_name: 'de_dust2',
    match_date: '2026-08-05T20:10:00Z',
    duration_seconds: null,
    total_rounds: null,
    team_a_name: null,
    team_b_name: null,
    team_a_score: null,
    team_b_score: null,
    players: [],
    remark: '',
    content_sha256: null,
    file_size: 187_301_888,
    created_at: '2026-08-05T20:58:00Z',
    updated_at: '2026-08-05T20:58:00Z',
  },
];

const REVIEW_TAGS: ReviewTag[] = [
  { id: 'tag-entry', name: '突破', color: '#3d6b8c', created_at: NOW, updated_at: NOW },
  { id: 'tag-clutch', name: '残局', color: '#a8622c', created_at: NOW, updated_at: NOW },
  { id: 'tag-utility', name: '道具', color: '#4f7a4a', created_at: NOW, updated_at: NOW },
];

/* ── activities, outputs ──────────────────────────────────────────────────── */

/*
 * `parseActivityFeed` is the strictest checker in the client: the job id has to
 * be a UUID, `id` has to be `kind:job_id`, and each kind has its own rule about
 * which of `stage` / `progress_percent` / units may be set at all. Fixtures
 * that only *look* right are rejected the same way a drifted service would be,
 * which is the point — these four rows are a live test of that parser.
 */
const RECORDING_JOB = 'aa111111-1111-4111-8111-111111111111';
const ANALYSIS_RUN = 'bb222222-2222-4222-8222-222222222222';
const EXPORT_JOB = 'cc333333-3333-4333-8333-333333333333';
const DOWNLOAD_JOB = 'dd444444-4444-4444-8444-444444444444';

const ACTIVITIES: ActivityFeed = {
  items: [
    {
      id: `recording:${RECORDING_JOB}`,
      kind: 'recording',
      subtype: null,
      job_id: RECORDING_JOB,
      context_id: 'plan-1',
      subject: 'Mirage 残局集锦 · 6 镜头',
      status: 'running',
      /* One of the five `recording.stage.*` keys, and `completed_units` is that
         stage's index — the parser checks the pairing, not just the range. */
      stage: 'recording.stage.capturing',
      progress_percent: null,
      completed_units: 3,
      total_units: 5,
      unit: 'stages',
      error: null,
      failure: null,
      created_at: '2026-08-15T09:30:00Z',
      updated_at: '2026-08-15T09:40:00Z',
      available_actions: ['cancel', 'open_outputs'],
    },
    {
      id: `analysis:${ANALYSIS_RUN}`,
      kind: 'analysis',
      subtype: null,
      job_id: ANALYSIS_RUN,
      context_id: '5b81e4c7-22d4-4a6e-9d21-6b0f1a2c3d42',
      subject: 'Vitality vs G2 · Inferno',
      status: 'running',
      stage: 'parser_running',
      progress_percent: null,
      completed_units: null,
      total_units: null,
      unit: null,
      error: null,
      failure: null,
      created_at: '2026-08-15T09:05:00Z',
      updated_at: '2026-08-15T09:39:00Z',
      available_actions: ['cancel', 'open_library'],
    },
    {
      id: `export:${EXPORT_JOB}`,
      kind: 'export',
      subtype: 'montage',
      job_id: EXPORT_JOB,
      context_id: 'proj-highlights',
      subject: '八月集锦 · r3',
      status: 'completed',
      stage: null,
      progress_percent: 100,
      completed_units: null,
      total_units: null,
      unit: null,
      error: null,
      failure: null,
      created_at: '2026-08-14T22:02:00Z',
      updated_at: '2026-08-14T22:19:00Z',
      available_actions: ['open_outputs'],
    },
    {
      id: `download:${DOWNLOAD_JOB}`,
      kind: 'download',
      subtype: null,
      job_id: DOWNLOAD_JOB,
      context_id: 'match-9921',
      subject: 'Premier · Dust II',
      status: 'failed',
      stage: null,
      /* The parser recomputes this from the byte counts and rejects anything
         else, so it is written as the rounded quotient rather than guessed. */
      progress_percent: 34,
      completed_units: 63_963_136,
      total_units: 187_301_888,
      unit: 'bytes',
      error: 'Valve 回放服务器超时（3 次重试后放弃）。',
      failure: { code: 'timeout', retryable: true },
      created_at: '2026-08-14T19:40:00Z',
      updated_at: '2026-08-14T19:52:00Z',
      available_actions: ['retry_download', 'open_match_history'],
    },
  ],
  total: 4,
  page: 1,
  page_size: 20,
  summary: { total: 4, active: 2, failed: 1, completed: 1, cancelled: 0 },
};

const EXPORT_JOB_DETAIL: ExportJobRecord = {
  kind: 'montage',
  job: {
    id: EXPORT_JOB,
    project_id: 'proj-highlights',
    project_revision: 3,
    range_start_seconds: 0,
    range_end_seconds: 184,
    status: 'completed',
    progress: 1,
    output_path: `${DATA_DIR}\\outputs\\august-highlights-v3.mp4`,
    error: null,
    error_code: null,
    created_at: '2026-08-14T22:02:00Z',
    updated_at: '2026-08-14T22:19:00Z',
  },
};

const RECORDING_JOB_DETAIL: RecordingJob = {
  id: RECORDING_JOB,
  retry_of: null,
  status: 'running',
  current_index: 1,
  progress: 1 / 3,
  message: 'recording.stage.capturing',
  error_code: null,
  items: [
    recordingRequest('mock-shot-1', '建立地点', 148_700, 148_812),
    recordingRequest('mock-shot-2', '跟随突破', 148_812, 149_356),
    recordingRequest('mock-shot-3', '选手 POV · 三杀', 148_920, 150_440),
  ],
  outputs: [{
    id: 'mock-recorded-clip-1',
    path: `${DATA_DIR}\\recordings\\mock-recorded-clip-1.mp4`,
    title: '建立地点',
    duration_seconds: 8,
    demo_id: 'demo-aurora-mirage',
    player_name: 'Kael',
    category: 'recording',
    tags: [],
    metadata: {},
    created_at: '2026-08-15T09:34:00Z',
  }],
  created_at: '2026-08-15T09:30:00Z',
  updated_at: '2026-08-15T09:40:00Z',
};

function recordingRequest(id: string, title: string, startTick: number, endTick: number): RecordingJob['items'][number] {
  return {
    id,
    demo_id: 'demo-aurora-mirage',
    highlight_id: `highlight-${id}`,
    player_id: '76561198000000001',
    title,
    start_tick: startTick,
    end_tick: endTick,
    pre_roll_seconds: 1.5,
    post_roll_seconds: 1,
    victim_pov: false,
    camera_style: 'static',
    presentation: null,
  };
}

const OUTPUTS: OutputPage = {
  items: [
    {
      id: 'out-620',
      output_kind: 'export',
      media_kind: 'video',
      title: '八月集锦 v3',
      status: 'completed',
      progress: 100,
      path: `${DATA_DIR}\\outputs\\august-highlights-v3.mp4`,
      file_name: 'august-highlights-v3.mp4',
      availability: 'present',
      managed: true,
      mutable: true,
      size_bytes: 486_539_264,
      media: null,
      project_id: 'proj-highlights',
      project_revision: 12,
      demo_id: null,
      error: null,
      created_at: '2026-08-14T22:19:00Z',
      updated_at: '2026-08-14T22:19:00Z',
    },
    {
      id: 'out-604',
      output_kind: 'recording',
      media_kind: 'video',
      title: 'Mirage · 第 19 回合 1v3',
      status: 'completed',
      progress: 100,
      path: `${DATA_DIR}\\recordings\\mirage-r19-clutch.mp4`,
      file_name: 'mirage-r19-clutch.mp4',
      availability: 'present',
      managed: true,
      mutable: true,
      size_bytes: 92_274_688,
      media: null,
      project_id: null,
      project_revision: null,
      demo_id: '3f2c9a10-11d4-4a6e-9d21-6b0f1a2c3d41',
      error: null,
      created_at: '2026-08-13T11:02:00Z',
      updated_at: '2026-08-13T11:02:00Z',
    },
    {
      id: 'out-588',
      output_kind: 'recording',
      media_kind: 'video',
      title: 'Ancient · B 点默认下包',
      status: 'completed',
      progress: 100,
      path: 'E:\\已移动\\ancient-default-b.mp4',
      file_name: 'ancient-default-b.mp4',
      availability: 'missing',
      managed: false,
      mutable: false,
      size_bytes: null,
      media: null,
      project_id: null,
      project_revision: null,
      demo_id: '7d40b2f9-33d4-4a6e-9d21-6b0f1a2c3d43',
      error: null,
      created_at: '2026-08-12T16:41:00Z',
      updated_at: '2026-08-15T08:00:00Z',
    },
    {
      id: 'out-571',
      output_kind: 'export',
      media_kind: 'video',
      title: '战术板 · Inferno 香蕉道推进',
      status: 'failed',
      progress: 78,
      path: `${DATA_DIR}\\outputs\\inferno-banana.mp4`,
      file_name: 'inferno-banana.mp4',
      availability: 'missing',
      managed: true,
      mutable: true,
      size_bytes: null,
      media: null,
      project_id: 'proj-tactics',
      project_revision: 7,
      demo_id: null,
      error: '编码器在第 4 段返回 0xC0000005。',
      created_at: '2026-08-11T09:20:00Z',
      updated_at: '2026-08-11T09:33:00Z',
    },
  ],
  total: 4,
  page: 1,
  page_size: 20,
  scan_limited: false,
};

/** What a failed export left in the quarantine directory. */
const STAGED = { files: 3, bytes: 1_262_000_000 };

/* ── players ──────────────────────────────────────────────────────────────── */

function player(
  steamId: string,
  name: string,
  team: string,
  aliases: readonly string[],
  stats: { matches: number; kills: number; deaths: number; assists: number; headshots: number; adr: number; kd: number },
): PlayerDirectoryPage['items'][number] {
  return {
    steam_id: steamId,
    name,
    /* `aliases_total` may exceed the page but never fall below it, and zero on
       one side has to mean zero on the other — `parseDirectoryItem` checks both
       and this fixture used to fail the second. */
    aliases: [...aliases],
    aliases_total: aliases.length,
    last_team: team,
    last_match_date: '2026-08-13T15:05:00Z',
    last_cataloged_at: '2026-08-13T15:58:00Z',
    stats: {
      matches: stats.matches,
      kills: stats.kills,
      deaths: stats.deaths,
      assists: stats.assists,
      headshots: stats.headshots,
      damage: Math.round(stats.adr * stats.matches * 24),
      average_adr: stats.adr,
      average_kill_death_ratio: stats.kd,
    },
    /* Anything other than `available` has to say *why* — a null reason beside a
       null profile is the shape the parser rejects. */
    steam: {
      state: 'unavailable',
      persona_name: null,
      real_name: null,
      profile_url: null,
      country_code: null,
      persona_state: null,
      last_logoff: null,
      created_at: null,
      avatar_url: null,
      reason: '浏览器模式没有 Steam Web API 凭据。',
    },
  };
}

const PLAYERS: PlayerDirectoryPage = {
  items: [
    player('76561197960266729', 's1mple', 'NAVI', ['s1mple-', 'seized'], { matches: 12, kills: 291, deaths: 208, assists: 54, headshots: 141, adr: 91.3, kd: 1.40 }),
    player('76561197960266730', 'ropz', 'FaZe', [], { matches: 11, kills: 244, deaths: 201, assists: 61, headshots: 120, adr: 78.4, kd: 1.21 }),
    player('76561197960266731', 'ZywOo', 'Vitality', ['zywoo'], { matches: 10, kills: 252, deaths: 178, assists: 44, headshots: 108, adr: 88.1, kd: 1.42 }),
    player('76561197960266732', 'NiKo', 'G2', [], { matches: 10, kills: 231, deaths: 195, assists: 49, headshots: 117, adr: 79.6, kd: 1.18 }),
    player('76561197960266733', 'b1t', 'NAVI', [], { matches: 12, kills: 238, deaths: 214, assists: 58, headshots: 129, adr: 74.2, kd: 1.11 }),
  ],
  total: 5,
  page: 1,
  page_size: 20,
  coverage: { projected_demos: 3, total_analyses: 3, projection_complete: true },
};

const COVERAGE = PLAYERS.coverage;

function playerMatches(steamId: string): PlayerMatchPage {
  const rows = DEMOS.filter((demo) => demo.status === 'ready').map((demo, index) => ({
    demo_id: demo.id,
    demo_name: demo.display_name,
    map_name: demo.map_name,
    match_date: demo.match_date,
    cataloged_at: demo.created_at,
    team: index % 2 === 0 ? 'A' : 'B',
    kills: 24 - index * 3,
    deaths: 17 + index,
    assists: 5 + index,
    headshots: 12 - index,
    damage: 2_180 - index * 140,
    adr: 90.8 - index * 5.4,
    kill_death_ratio: 1.41 - index * 0.12,
  }));
  return { steam_id: steamId, items: rows, total: rows.length, page: 1, page_size: 20, coverage: COVERAGE };
}

function playerMaps(steamId: string): PlayerMapPage {
  const rows = ['de_mirage', 'de_inferno', 'de_ancient'].map((mapName, index) => ({
    map_name: mapName,
    stats: {
      matches: 5 - index,
      kills: 118 - index * 24,
      deaths: 92 - index * 18,
      assists: 21 - index * 4,
      headshots: 57 - index * 11,
      damage: 9_640 - index * 1_900,
      average_adr: 89.4 - index * 6.2,
      average_kill_death_ratio: 1.38 - index * 0.11,
    },
  }));
  return { steam_id: steamId, items: rows, total: rows.length, page: 1, page_size: 20, coverage: COVERAGE };
}

/**
 * A scatter for the player heatmap.
 *
 * `parsePlayerHeatmap` is the other strict checker: each point's two hrefs must
 * be `/analysis?` with exactly six parameters that agree with the point's own
 * demo, round, tick, evidence id and player. Building the pair from the point
 * rather than writing it out is the only way to keep that true.
 */
function playerHeatmap(steamId: string, mapName: string): PlayerHeatmap {
  const demoId = (DEMOS[0] as DemoRecord).id;
  const points = Array.from({ length: 36 }, (_unused, index) => {
    const round = (index % 18) + 1;
    const tick = 12_000 + index * 3_100;
    const kind = index % 3 === 0 ? ('deaths' as const) : ('kills' as const);
    const evidenceId = `demo:${demoId}/event:${kind}-${index}`;
    const parameters = new URLSearchParams({
      demo: demoId,
      round: String(round),
      tick: String(tick),
      evidence: evidenceId,
      player: steamId,
      tab: 'rounds',
    });
    const replay = new URLSearchParams(parameters);
    replay.set('tab', 'replay');
    return {
      demo_id: demoId,
      evidence_id: evidenceId,
      round,
      tick,
      kind,
      /* A ring plus a diagonal, so a blank canvas and a broken projection are
         told apart at a glance. */
      x: Math.round(Math.cos(index) * 900 + (index - 18) * 22),
      y: Math.round(Math.sin(index) * 900 - (index - 18) * 17),
      floor: 0,
      analysis_href: `/analysis?${parameters.toString()}`,
      replay_href: `/analysis?${replay.toString()}`,
    };
  });
  return {
    steam_id: steamId,
    map_name: mapName,
    points,
    total: points.length,
    maximum_points: 5_000,
    complete: true,
    coverage: COVERAGE,
  };
}

/* ── one analysed match ───────────────────────────────────────────────────── */

/**
 * Built rather than written out: 24 rounds and ten players is more literal than
 * anyone can read, and every field of it is derived from three facts (the map,
 * the score, the roster). The generator makes the *shape* honest, which is what
 * the workspace's tables, timeline and radar are being looked at for.
 */
function analysisOf(demoId: string): MatchAnalysisRecord {
  const source = DEMOS.find((demo) => demo.id === demoId) ?? (DEMOS[0] as DemoRecord);
  const teamA = ['s1mple', 'b1t', 'Aleksib', 'jL', 'iM'];
  const teamB = ['ropz', 'karrigan', 'rain', 'frozen', 'broky'];
  const tickRate = 64;
  const roundCount = source.total_rounds ?? 24;
  const targetA = source.team_a_score ?? 13;
  const aWinsLast = targetA > (source.team_b_score ?? 11);
  const aBeforeLast = targetA - Number(aWinsLast);
  let scoreA = 0;
  let scoreB = 0;
  const rounds = Array.from({ length: roundCount }, (_unused, index) => {
    const number = index + 1;
    const aWins = index === roundCount - 1 ? aWinsLast : Math.floor((index + 1) * aBeforeLast / (roundCount - 1)) > Math.floor(index * aBeforeLast / (roundCount - 1));
    if (aWins) scoreA += 1; else scoreB += 1;
    return {
      number,
      start_tick: 10_000 + index * 7_400,
      end_tick: 10_000 + index * 7_400 + 6_100,
      winner: aWins ? 'A' : 'B',
      reason: aWins ? 'elimination' : 'bomb_defused',
      team_a_score: scoreA,
      team_b_score: scoreB,
      events: [],
    };
  });
  const stats = (name: string, index: number, side: 'A' | 'B') => ({
    steam_id: `7656119796026${6729 + index}`,
    spectator_slot: index + 1,
    name,
    team: side,
    kills: 24 - index * 2,
    deaths: 15 + index,
    assists: 6 - Math.floor(index / 2),
    headshots: 12 - index,
    damage: 2_140 - index * 120,
    adr: 89.2 - index * 5.1,
    kill_death_ratio: Number(((24 - index * 2) / (15 + index)).toFixed(2)),
    score: 62 - index * 4,
  });
  return {
    demo_id: source.id,
    map_name: source.map_name ?? 'de_mirage',
    tick_rate: tickRate,
    duration_seconds: source.duration_seconds ?? 2_744,
    verified_total_ticks: (source.duration_seconds ?? 2_744) * tickRate,
    teams: [
      { name: source.team_a_name ?? 'A 队', side: 'A', score: source.team_a_score ?? 13, players: teamA },
      { name: source.team_b_name ?? 'B 队', side: 'B', score: source.team_b_score ?? 11, players: teamB },
    ],
    players: [
      ...teamA.map((name, index) => stats(name, index, 'A')),
      ...teamB.map((name, index) => stats(name, index + 5, 'B')),
    ],
    rounds,
    highlights: [
      {
        id: 'hl-1',
        player_id: '76561197960266729',
        round: 19,
        start_tick: 143_200,
        end_tick: 145_600,
        kind: 'clutch',
        title: '第 19 回合 1v3',
        description: '连续三次开镜命中，最后一枪穿墙。',
        score: 0.94,
        tags: ['残局', 'AWP'],
        victims: ['ropz', 'rain', 'broky'],
      },
      {
        id: 'hl-2',
        player_id: '76561197960266733',
        round: 7,
        start_tick: 55_400,
        end_tick: 57_100,
        kind: 'multi_kill',
        title: '第 7 回合 4 杀',
        description: 'A 大道闪光后强攻，四杀开局。',
        score: 0.81,
        tags: ['突破'],
        victims: ['karrigan', 'frozen', 'broky', 'rain'],
      },
    ],
    insights: {
      round_economy: rounds.map((round, index) => ({
        round: round.number, freeze_end_tick: round.start_tick + 960,
        team_equipment: [
          { team: 'A', buy_type: index % 12 === 0 ? 'pistol' : (['full_buy', 'semi_buy', 'full_buy', 'full_buy', 'eco', 'full_buy'] as const)[index % 6]!, side: index < 12 ? 'T' : 'CT', equipment_value: index % 12 === 0 ? 3_500 : [24_200, 8_600, 26_400, 22_500, 4_200, 25_800][index % 6]! },
          { team: 'B', buy_type: index % 12 === 0 ? 'pistol' : (['full_buy', 'full_buy', 'force_buy', 'semi_buy', 'full_buy', 'full_buy'] as const)[index % 6]!, side: index < 12 ? 'CT' : 'T', equipment_value: index % 12 === 0 ? 3_600 : [23_800, 25_200, 7_400, 21_800, 26_600, 24_200][index % 6]! },
        ],
        teams: ['CT', 'T'].map((team) => ({ team, purchase_count: 10, items: [], spend: 15_000 })),
        unattributed_purchase_count: 0,
      })),
      player_utility: [],
      matchups: [],
      availability: {
        purchase_events: { available: true, reason: null },
        purchase_spend: { available: true, reason: null },
        utility_events: { available: false, reason: '浏览器模式没有采样这份数据。' },
        utility_damage: { available: false, reason: '浏览器模式没有采样这份数据。' },
        flash_effects: { available: false, reason: '浏览器模式没有采样这份数据。' },
        matchups: { available: false, reason: '浏览器模式没有采样这份数据。' },
      },
    },
  };
}

/* ── match history ────────────────────────────────────────────────────────── */

const MATCH_HISTORY: MatchHistoryItem[] = [
  {
    id: 'mh-1',
    steam_id: '76561197960266729',
    match_id: 'match-9921',
    outcome_id: 'outcome-9921',
    token: 4_412_887,
    map_name: 'de_dust2',
    played_at: '2026-08-05T20:10:00Z',
    score: '13 : 9',
    result: 'win',
    demo_status: 'failed',
    demo_id: null,
    last_error: 'Valve 回放服务器超时。',
    synced_at: '2026-08-14T19:52:00Z',
    updated_at: '2026-08-14T19:52:00Z',
  },
  {
    id: 'mh-2',
    steam_id: '76561197960266729',
    match_id: 'match-9908',
    outcome_id: 'outcome-9908',
    token: 4_412_101,
    map_name: 'de_mirage',
    played_at: '2026-08-11T18:20:00Z',
    score: '13 : 11',
    result: 'win',
    demo_status: 'downloaded',
    demo_id: '3f2c9a10-11d4-4a6e-9d21-6b0f1a2c3d41',
    last_error: null,
    synced_at: '2026-08-14T19:52:00Z',
    updated_at: '2026-08-14T19:52:00Z',
  },
  {
    id: 'mh-3',
    steam_id: '76561197960266729',
    match_id: 'match-9884',
    outcome_id: 'outcome-9884',
    token: 4_411_540,
    map_name: 'de_anubis',
    played_at: '2026-08-02T19:44:00Z',
    score: '7 : 13',
    result: 'loss',
    demo_status: 'available',
    demo_id: null,
    last_error: null,
    synced_at: '2026-08-14T19:52:00Z',
    updated_at: '2026-08-14T19:52:00Z',
  },
];

/* ── the Agent workspace ──────────────────────────────────────────────────── */

const AGENT_STATUS: AgentStatus = {
  runtimeAvailable: true,
  configured: true,
  provider: 'anthropic',
  model: 'claude-opus-5',
  streaming: true,
};

const AGENT_SESSIONS: AgentSessionPage = {
  items: [
    {
      id: 'sess-1',
      title: 'Mirage 残局集锦',
      created_at: '2026-08-14T20:02:00Z',
      updated_at: '2026-08-15T09:20:00Z',
      entry_count: 12,
    },
    {
      id: 'sess-2',
      title: 'Inferno 香蕉道复盘',
      created_at: '2026-08-13T16:40:00Z',
      updated_at: '2026-08-13T18:11:00Z',
      entry_count: 7,
    },
  ],
  total: 2,
};

const AGENT_SETTINGS: AgentWorkspaceSettings = {
  session_retention: { mode: 'recent_count', count: 50 },
  show_evidence_reads: false,
  default_video_seconds: 180,
  default_camera_style: 'pov',
  commentary_tone: 'professional',
};

const AGENT_STORAGE: AgentSessionStorageStats = {
  session_count: 2,
  entry_count: 19,
  conversation_bytes: 184_320,
  oldest_session_at: '2026-08-13T16:40:00Z',
  newest_session_at: '2026-08-14T20:02:00Z',
};

/* ── recording, editing, media ────────────────────────────────────────────── */

const MEDIA_ASSETS: MediaAsset[] = [
  {
    id: 'asset-1',
    project_id: 'proj-highlights',
    path: `${DATA_DIR}\\recordings\\mirage-r19-clutch.mp4`,
    name: 'mirage-r19-clutch.mp4',
    kind: 'video',
    duration_seconds: 18.4,
    width: 1920,
    height: 1080,
    file_size: 92_274_688,
    has_audio: true,
    proxy_path: null,
    proxy_status: { status: 'not_requested' },
    waveform: null,
    metadata_status: { status: 'ready' },
    markers: [],
    created_at: '2026-08-13T11:02:00Z',
  },
  {
    id: 'asset-2',
    project_id: 'proj-highlights',
    path: `${DATA_DIR}\\media\\bed-120bpm.wav`,
    name: 'bed-120bpm.wav',
    kind: 'audio',
    duration_seconds: 124.0,
    width: null,
    height: null,
    file_size: 21_872_640,
    has_audio: true,
    proxy_path: null,
    proxy_status: { status: 'not_requested' },
    waveform: null,
    metadata_status: { status: 'ready' },
    markers: [],
    created_at: '2026-08-10T09:12:00Z',
  },
];

const RECORDED_CLIPS: RecordedClipRecord[] = [
  {
    id: 'clip-1',
    title: 'Mirage · 第 19 回合 1v3',
    path: `${DATA_DIR}\\recordings\\mirage-r19-clutch.mp4`,
    player_name: 's1mple',
    map_name: 'de_mirage',
    duration_seconds: 18.4,
    created_at: '2026-08-13T11:02:00Z',
    stream_url: '/api/recorded-clips/clip-1/stream',
    demo_id: '3f2c9a10-11d4-4a6e-9d21-6b0f1a2c3d41',
    category: 'clutch',
    tags: ['残局'],
    metadata: null,
  },
];

/* ── settings ─────────────────────────────────────────────────────────────── */

const CONFIG: AppConfig = {
  theme: 'system',
  update_manifest_url: '',
  demo_watch_paths: ['D:\\CS2\\demos'],
  locale: 'zh-CN',
  data_dir: DATA_DIR,
  cs2_path: 'D:\\Steam\\steamapps\\common\\Counter-Strike Global Offensive',
  steam_path: 'D:\\Steam',
  steam: {
    steam_id: '76561197960266729',
    web_api_key: '',
    authentication_code: '',
    known_share_code: '',
    maximum_results: 50,
  },
  steam_has_web_api_key: true,
  steam_has_authentication_code: true,
  steam_has_share_code: true,
  llm: {
    provider: 'anthropic',
    model: 'claude-opus-5',
    base_url: '',
    api_key: '',
    prompt: '',
    parameter_style: 'openai',
    parameters: {},
  },
  llm_has_api_key: true,
  clear_llm_api_key: false,
  recording: {
    pre_roll_seconds: 3,
    post_roll_seconds: 2,
    resolution: '1920x1080',
    fps: 60,
    show_radar: true,
    camera_fov: 90,
    viewmodel_fov: 68,
    flash_alpha: 0.4,
    show_hud: true,
    voice: 'all_players',
  },
};

const HLAE: HlaeStatus = {
  available: true,
  executable: `${DATA_DIR}\\tools\\hlae\\HLAE.exe`,
  source2_hook: `${DATA_DIR}\\tools\\hlae\\AfxHookSource2.dll`,
  source: 'managed',
  managed_release: {
    version: '2.152.0',
    archive_sha256: 'a91d2f4c8e0b5537',
    signing_fingerprint: '9F3C 20A1 77BD',
    prepared: true,
  },
  messages: [],
  cs2_executable: 'D:\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe',
  launch_profile_ready: true,
  automatic_launch_enabled: false,
  safety_boundary: {
    insecure_mode_required: true,
    vac_servers_prohibited: true,
    demo_playback_only: true,
  },
};

/* ── the route table ──────────────────────────────────────────────────────── */

type Handler = (context: {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}) => unknown;

/**
 * `[method, template, handler]`, first match wins.
 *
 * The template is the path with `:name` in place of a segment the caller fills
 * in, which is the shape the routes are written as in `client.ts`. Order
 * matters only where a literal segment and a parameter could both match
 * (`/analysis-runs/active` before `/analysis-runs/:id`), and those are placed
 * accordingly.
 */
const ROUTES: Array<[string, string, Handler]> = [
  ['GET', '/source-assets/map-geometry', () => ({ files: GEOMETRY_CACHE.size, bytes: [...GEOMETRY_CACHE.values()].reduce((sum, bytes) => sum + bytes, 0) })],
  ['DELETE', '/source-assets/map-geometry', () => { GEOMETRY_CACHE.clear(); return undefined; }],
  /* setup and runtime */
  ['GET', '/app/runtime-state', () => ({
    version: '0.1.0-dev',
    data_dir: DATA_DIR,
    active_recording_job: 'job-771',
    runtime_session: 'recording',
  } satisfies RuntimeState)],
  ['GET', '/config/quick-check', () => ({
    checked_at: NOW,
    checks: [
      { kind: 'game', state: 'ready', label: 'Counter-Strike 2', detail: 'D:\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe' },
      { kind: 'hlae', state: 'ready', label: 'HLAE', detail: '托管版本 2.152.0，已校验签名。' },
      { kind: 'encoder', state: 'missing', label: 'NVENC 编码器', detail: '未检测到可用的硬件编码器，将回退到软件编码。', action_path: '/settings' },
    ],
  } satisfies QuickCheckResponse)],
  ['GET', '/config', () => CONFIG],
  ['PUT', '/config', ({ body }) => ({ ...CONFIG, ...(body as Partial<AppConfig>) })],
  ['POST', '/config/detect-paths', () => ({
    cs2_path: CONFIG.cs2_path,
    steam_path: CONFIG.steam_path,
  } satisfies DetectedPaths)],
  ['GET', '/storage/status', () => ({
    data_dir: DATA_DIR,
    directory_bytes: 18_339_020_800,
    filesystem_total_bytes: 1_000_204_886_016,
    filesystem_available_bytes: 412_316_860_416,
    file_count: 1_284,
    directory_count: 47,
    scan_complete: true,
    checked_at: NOW,
  } satisfies StorageStatus)],
  ['GET', '/config-backup/status', () => ({
    recovery_required: false,
    affected_files: [],
  } satisfies RecoveryStatus)],
  ['POST', '/config-backup/restore', () => ({ recovery_required: false, affected_files: [] } satisfies RecoveryStatus)],
  ['POST', '/app/diagnostics/export', () => ({ path: `${DATA_DIR}\\diagnostics\\2026-08-15.zip` })],

  /* the demo library */
  ['GET', '/demos/compact', ({ query }) => {
    const search = (query.get('search') ?? '').trim().toLocaleLowerCase();
    const map = query.get('map_name');
    const status = query.get('status');
    const items = DEMOS.filter((demo) => {
      if (search && !demo.display_name.toLocaleLowerCase().includes(search)
        && !demo.file_name.toLocaleLowerCase().includes(search)) return false;
      if (map && demo.map_name !== map) return false;
      if (status && demo.status !== status) return false;
      return true;
    });
    return paged(items);
  }],
  ['GET', '/demos/maps', () =>
    [...new Set(DEMOS.map((demo) => demo.map_name).filter((name): name is string => name !== null))].sort()],
  ['GET', '/demos/watch/status', () => ({
    running: true,
    roots: [{ path: 'D:\\CS2\\demos', state: 'watching', message: null }],
    last_scan_at: '2026-08-15T08:56:00Z',
    last_event_at: '2026-08-13T15:58:00Z',
    last_error: null,
    imported: 3,
    updated: 1,
    missing: 0,
  } satisfies DemoWatchStatus)],
  ['POST', '/demos/watch/rescan', () => ({
    running: true,
    roots: [{ path: 'D:\\CS2\\demos', state: 'watching', message: null }],
    last_scan_at: NOW,
    last_event_at: '2026-08-13T15:58:00Z',
    last_error: null,
    imported: 3,
    updated: 1,
    missing: 0,
  } satisfies DemoWatchStatus)],
  ['GET', '/demos/:id', ({ params }) => DEMOS.find((demo) => demo.id === params.id) ?? DEMOS[0]],
  ['GET', '/demos/:id/analysis', ({ params }) => analysisOf(params.id ?? '')],
  ['GET', '/demos/:id/heatmap', () => []],
  ['GET', '/review-tags', () => REVIEW_TAGS],

  /* activity, outputs */
  ['GET', '/activities', ({ query }) => {
    const projectId = query.get('project_id');
    const state = query.get('state');
    const scoped = ACTIVITIES.items.filter((item) => projectId === null || item.context_id === projectId);
    const filtered = scoped.filter((item) => state === null || (state === 'active'
      ? !['completed', 'failed', 'cancelled'].includes(item.status) : item.status === state));
    const page = Math.max(1, Number(query.get('page') ?? 1));
    const pageSize = Math.max(1, Number(query.get('page_size') ?? 20));
    return { ...ACTIVITIES, items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, page_size: pageSize };
  }],
  ['GET', '/activities/:kind/:id', ({ params }) =>
    ACTIVITIES.items.find((item) => item.id === `${params.kind}:${params.id}`) ?? ACTIVITIES.items[0]],
  /* Deleting answers with the service's own result shape, so the page prints
     what happened to the file rather than reading `null` as a warning. */
  ['DELETE', '/outputs/:kind/:id', ({ params, query }) => {
    const index = OUTPUTS.items.findIndex((item) => item.output_kind === params.kind && item.id === params.id);
    const [removed] = index === -1 ? [] : OUTPUTS.items.splice(index, 1);
    const deleteFile = query.get('delete_file') === 'true';
    const fileDeleted = deleteFile && removed?.managed === true && removed.availability === 'present';
    return {
      id: params.id ?? '',
      output_kind: (params.kind === 'recording' ? 'recording' : 'export'),
      record_deleted: removed !== undefined,
      file_deleted: fileDeleted,
      file_action: fileDeleted ? 'managed_file_deleted' : deleteFile ? 'external_file_preserved' : 'record_only',
      warning: null,
    } satisfies DeleteOutputResult;
  }],
  /* 恢复中心 reads the counts before offering either cleanup, and the two
     cleanups answer with what they removed so the page's report and the next
     scan agree: the staged files are gone, the missing records are gone. */
  ['GET', '/outputs/recovery-scan', () => ({
    staged: { files: STAGED.files, bytes: STAGED.bytes, scan_limited: false },
    missing: {
      records: OUTPUTS.items.filter((item) => item.availability === 'missing').length,
      scan_limited: false,
    },
  } satisfies RecoveryScan)],
  ['POST', '/outputs/cleanup-staged', () => {
    const deleted = STAGED.files;
    STAGED.files = 0;
    STAGED.bytes = 0;
    return { inspected: deleted, deleted, failed: 0, scan_limited: false } satisfies CleanupStagedOutputsResult;
  }],
  ['POST', '/outputs/cleanup-missing', () => {
    const inspected = OUTPUTS.items.length;
    const kept = OUTPUTS.items.filter((item) => item.availability !== 'missing');
    const deleted = inspected - kept.length;
    OUTPUTS.items.splice(0, OUTPUTS.items.length, ...kept);
    return { inspected, deleted, scan_limited: false } satisfies CleanupMissingOutputsResult;
  }],
  ['GET', '/outputs', ({ query }) => {
    const items = OUTPUTS.items.filter((item) =>
      (!query.has('project_id') || item.project_id === query.get('project_id'))
      && (!query.has('kind') || item.output_kind === query.get('kind'))
      && (!query.has('status') || item.status === query.get('status')));
    const page = Math.max(1, Number(query.get('page') ?? 1));
    const pageSize = Math.max(1, Number(query.get('page_size') ?? 20));
    return { ...OUTPUTS, items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, page_size: pageSize };
  }],

  /* players, lineups, history */
  ['GET', '/players', () => PLAYERS],
  /* `/players/compare` is a literal that would otherwise be eaten by
     `/players/:steamId`, so it is written first. */
  ['GET', '/players/compare', ({ query }) => {
    const [first, second] = PLAYERS.items as [PlayerDirectoryPage['items'][number], PlayerDirectoryPage['items'][number]];
    const left = PLAYERS.items.find((item) => item.steam_id === query.get('left')) ?? first;
    const right = PLAYERS.items.find((item) => item.steam_id === query.get('right')) ?? second;
    return { players: [left, right], coverage: COVERAGE };
  }],
  ['GET', '/players/:steamId', ({ params }) => ({
    player: PLAYERS.items.find((item) => item.steam_id === params.steamId)
      ?? (PLAYERS.items[0] as PlayerDirectoryPage['items'][number]),
    coverage: COVERAGE,
  } satisfies PlayerProfile)],
  ['GET', '/players/:steamId/matches', ({ params }) => playerMatches(params.steamId ?? '')],
  ['GET', '/players/:steamId/maps', ({ params }) => playerMaps(params.steamId ?? '')],
  ['GET', '/players/:steamId/heatmap', ({ params, query }) =>
    playerHeatmap(params.steamId ?? '', query.get('map') ?? 'de_mirage')],
  ['GET', '/lineups', () => ({
    items: [], total: 0, page: 1, page_size: 20,
    coverage: { evaluated_demos: 3, verified_demos: 3, total_analyses: 3, projection_complete: true },
  } satisfies LineupDirectoryPage)],
  ['GET', '/match-history/matches', () => paged(MATCH_HISTORY)],
  ['GET', '/match-history/downloads/active', () => [] as MatchDownloadJob[]],

  /* evidence */
  ['GET', '/evidence/search', ({ query }) => evidenceSearch(query)],
  ['GET', '/evidence/annotations', ({ query }) => {
    const evidenceId = query.get('evidence_id');
    const demoId = query.get('demo_id');
    return paged(EVIDENCE_ANNOTATIONS.filter((note) =>
      (evidenceId === null || note.evidence_id === evidenceId)
      && (demoId === null || note.demo_id === demoId)));
  }],

  /* the Agent workspace */
  ['GET', '/agent/sessions', () => AGENT_SESSIONS],
  ['GET', '/agent/workspace/settings', () => AGENT_SETTINGS],
  ['PUT', '/agent/workspace/settings', ({ body }) => ({ ...AGENT_SETTINGS, ...(body as Partial<AgentWorkspaceSettings>) })],
  ['GET', '/agent/workspace/storage', () => AGENT_STORAGE],

  /* recording */
  ['GET', '/playback/status', () => ({
    executable_available: true,
    executable: HLAE.cs2_executable,
    gsi_installed: true,
    gsi_fresh: false,
    gsi_sequence: 0,
    gsi_received_at: null,
    map_name: null,
    map_phase: null,
    player_name: null,
    player_activity: null,
    ready_to_launch: true,
    gsi_ready: false,
    warnings: [],
  } as unknown as DemoPlaybackStatus)],
  ['GET', '/hlae/status', () => HLAE],
  ['GET', '/recording/jobs/:id', () => RECORDING_JOB_DETAIL],
  ['POST', '/recording/jobs/:id/cancel', () => ({ ...RECORDING_JOB_DETAIL, status: 'cancelling' as const })],

  /* editing and delivery */
  ['GET', '/projects', () => [mockProject()]],
  ['GET', '/projects/:id', () => mockProject()],
  ['POST', '/projects/:id/clips/:clip/camera-preview', ({ params, body }) => {
    const clip = mockProject().document.tracks.flatMap((track) => track.clips).find((clip) => clip.id === params['clip']);
    const pov = clip?.capture_intent?.camera_style === 'pov';
    return { projectId: params['id'], clipId: params['clip'], revision: (body as { revision: number }).revision,
      preview: { ...cameraFixture.preview, plan: pov ? null : cameraFixture.preview.plan },
      inspection: pov ? null : cameraFixture.inspection,
    };
  }],
  ['PATCH', '/projects/:id', ({ body }) => applyMockPatch(body as ProjectPatch)],
  ['POST', '/projects/:id/change-groups/:group/revert', ({ params, body }) =>
    revertMockChangeGroup(params['group'] ?? '', (body as { expected_revision: number }).expected_revision)],
  ['GET', '/projects/:id/delivery-gate', () => ({ ...PREVIEW_DELIVERY_GATE, revision: mockProject().revision })],
  ['GET', '/projects/:id/change-groups', () => []],
  ['GET', '/projects/:id/edit-lease', () => null],
  ['GET', '/projects/:id/render-previews', () => []],
  ['GET', '/projects/:id/nested-sequences', () => []],
  ['GET', '/editor/presets', () => ({ items: [] })],
  ['GET', '/media/assets', () => ({ items: MEDIA_ASSETS })],
  ['GET', '/recorded-clips', () => paged(RECORDED_CLIPS)],
  ['GET', '/exports', () => ({ items: [] as ExportJobRecord[] })],
  ['GET', '/exports/:id', () => EXPORT_JOB_DETAIL],

  /* caches */
  ['GET', '/avatar-cache', () => ({
    entries: 128, bytes: 4_194_304, maximum_entries: 2_000, maximum_bytes: 134_217_728,
    scan_complete: true, checked_at: NOW,
  } satisfies AvatarCacheStatus)],
  ['GET', '/replay-cache', () => ({
    entries: 12, bytes: 671_088_640, maximum_entries: 64, maximum_bytes: 8_589_934_592,
    scan_complete: true, checked_at: NOW,
  } satisfies ReplayCacheStatus)],
];

/** Matches one template against a path, returning its parameters or null. */
function match(template: string, path: string): Record<string, string> | null {
  const wanted = template.split('/');
  const given = path.split('/');
  if (wanted.length !== given.length) return null;
  const params: Record<string, string> = {};
  for (const [index, segment] of wanted.entries()) {
    const actual = given[index] ?? '';
    if (segment.startsWith(':')) {
      params[segment.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (segment !== actual) return null;
  }
  return params;
}

export async function handleRoute(method: string, target: string, body: unknown): Promise<unknown> {
  const [path = '', search = ''] = target.split('?');
  const query = new URLSearchParams(search);
  for (const [routeMethod, template, handler] of ROUTES) {
    if (routeMethod !== method) continue;
    const params = match(template, path);
    if (params) return handler({ params, query, body });
  }

  /* Writes this file has no opinion about are answered rather than rejected:
     a PATCH that 404s would put an error card on a page whose *read* is fine,
     and the read is what a design review is looking at. Reads are not given
     the same benefit — there is no honest empty answer for a read, and the
     missing fixture has to be visible. */
  if (method !== 'GET') return body ?? null;

  const missing = new MockRouteMissing(method, path);
  // eslint-disable-next-line no-console
  console.warn(`[mock bridge] 缺少样例数据：${method} ${path} — 在 src/dev/mockBackend.ts 的 ROUTES 里补一条。`);
  throw { status: missing.status, code: missing.code, message: missing.message };
}

/** The handful of Tauri commands that are not `desktop_call`. */
export async function handleCommand(command: string, args: unknown): Promise<unknown> {
  switch (command) {
    case 'agent_status':
      return AGENT_STATUS;
    case 'agent_cancel':
      return true;
    case 'desktop_binary': {
      const path = (args as { path?: unknown } | undefined)?.path;
      const map = typeof path === 'string' ? /^\/source-assets\/map-geometry\/([^/]+)$/u.exec(path)?.[1] : undefined;
      if (map !== undefined) {
        const response = await fetch(geometryFixtureUrl);
        if (!response.ok) throw new Error('Development geometry fixture is unavailable');
        const bytes = await response.arrayBuffer();
        GEOMETRY_CACHE.set(decodeURIComponent(map), bytes.byteLength);
        return bytes;
      }
      if (typeof path === 'string' && path === `/analysis-runs/${cameraFixture.preview.replay.producerRunId}/replay.bin`) {
        const preview = cameraFixture.preview;
        return mockReplayBinary({ tick_rate: preview.tickRate,
          rounds: [{ number: 1, start_tick: preview.startTick, end_tick: preview.endTick }],
          highlights: [{ start_tick: preview.startTick, end_tick: preview.endTick }],
          players: [{ steam_id: preview.playerId, name: 'Target', team: 'A', position: [0, 0, 0] }],
        });
      }
      const demoId = typeof path === 'string' ? /^\/demos\/([^/]+)\/replay\.bin$/u.exec(path)?.[1] : undefined;
      return demoId === undefined ? new ArrayBuffer(0) : mockReplayBinary(analysisOf(decodeURIComponent(demoId)));
    }
    default:
      break;
  }

  /* The dialog / fs / opener plugins. Answering `null` is 「用户取消了」, which
     every call site already handles, so a browser session never hangs on a
     picker that cannot open. */
  if (command.startsWith('plugin:')) return null;

  // eslint-disable-next-line no-console
  console.warn(`[mock bridge] 未实现的命令：${command}`, args);
  throw {
    status: 501,
    code: 'MOCK_COMMAND_MISSING',
    message: `浏览器模式没有实现命令 ${command}。`,
  };
}

// Original synthetic floor, wall and boxes. Generated through the production
// Rust VPK -> PHYS -> VMAP path; no game assets are distributed with the mock.
const GEOMETRY_CACHE = new Map<string, number>();
