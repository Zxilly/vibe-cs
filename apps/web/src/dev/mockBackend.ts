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

import type {
  ActivityFeed,
  AgentSessionPage,
  AgentSessionStorageStats,
  AgentPlanSummary,
  AgentStatus,
  AgentThread,
  AgentWorkspaceReferences,
  AgentWorkspaceSettings,
  ApiHealth,
  AppConfig,
  AvatarCacheStatus,
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
  MontageProjectRecord,
  OutputPage,
  Paginated,
  PlayerDirectoryPage,
  PlayerHeatmap,
  PlayerMapPage,
  PlayerMatchPage,
  PlayerProfile,
  QuickCheckResponse,
  RecordedClipRecord,
  RecordingShotPreset,
  RecoveryStatus,
  ReplayCacheStatus,
  ReviewTag,
  RuntimeState,
  StorageStatus,
  EditorProject,
  ExportJobRecord,
  EvidenceAnnotation,
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
      context_id: '3f2c9a10-11d4-4a6e-9d21-6b0f1a2c3d41',
      subject: 'NAVI vs FaZe · 第 19 回合 1v3',
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
      subject: '八月集锦 v3',
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
  const rounds = Array.from({ length: source.total_rounds ?? 24 }, (_unused, index) => {
    const number = index + 1;
    const aWins = number % 3 !== 0;
    return {
      number,
      start_tick: 10_000 + index * 7_400,
      end_tick: 10_000 + index * 7_400 + 6_100,
      winner: aWins ? 'A' : 'B',
      reason: aWins ? 'elimination' : 'bomb_defused',
      team_a_score: Math.ceil(((index + 1) * 2) / 3),
      team_b_score: Math.floor((index + 1) / 3),
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
      round_economy: [],
      player_utility: [],
      matchups: [],
      availability: {
        purchase_events: { available: false, reason: '浏览器模式没有采样这份数据。' },
        purchase_spend: { available: false, reason: '浏览器模式没有采样这份数据。' },
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
      refs: [],
    },
    {
      id: 'sess-2',
      title: 'Inferno 香蕉道复盘',
      created_at: '2026-08-13T16:40:00Z',
      updated_at: '2026-08-13T18:11:00Z',
      entry_count: 7,
      refs: [],
    },
  ],
  total: 2,
};

const AGENT_PLANS: AgentPlanSummary[] = [
  {
    id: 'plan-1',
    title: 'Mirage 残局集锦 · 6 镜头',
    status: 'draft',
    revision: 4,
    shot_count: 6,
    snoozed_until: null,
    total_duration_seconds: 47,
    origin_count: 3,
    created_at: '2026-08-14T20:12:00Z',
    updated_at: '2026-08-15T09:20:00Z',
  },
  {
    id: 'plan-2',
    title: 'Inferno 香蕉道推进 · 4 镜头',
    status: 'confirmed',
    revision: 2,
    shot_count: 4,
    snoozed_until: null,
    total_duration_seconds: 32,
    origin_count: 1,
    created_at: '2026-08-13T17:02:00Z',
    updated_at: '2026-08-13T18:11:00Z',
  },
];

const AGENT_THREAD: AgentThread = {
  id: 'thread-1',
  messages: [],
  updatedAt: '2026-08-15T09:20:00Z',
};

const AGENT_REFERENCES: AgentWorkspaceReferences = {
  pending_plans: [
    {
      kind: 'plan',
      id: 'plan-1',
      label: 'Mirage 残局集锦 · 6 镜头',
      status: 'draft',
      progress_percent: null,
      item_count: 6,
      error: null,
      updated_at: '2026-08-15T09:20:00Z',
    },
  ],
  running_recording_tasks: [
    {
      kind: 'recording_task',
      id: 'job-771',
      label: 'NAVI vs FaZe · 第 19 回合 1v3',
      status: 'running',
      progress_percent: 62,
      item_count: 8,
      error: null,
      updated_at: '2026-08-15T09:40:00Z',
    },
  ],
  edit_projects: [
    {
      kind: 'edit_project',
      id: 'proj-highlights',
      label: '八月集锦',
      status: 'ready',
      progress_percent: null,
      item_count: 14,
      error: null,
      updated_at: '2026-08-14T22:19:00Z',
    },
  ],
  failed_outputs: [
    {
      kind: 'output',
      id: 'out-571',
      label: '战术板 · Inferno 香蕉道推进',
      status: 'failed',
      progress_percent: 78,
      item_count: null,
      error: '编码器在第 4 段返回 0xC0000005。',
      updated_at: '2026-08-11T09:33:00Z',
    },
  ],
};

const AGENT_SETTINGS: AgentWorkspaceSettings = {
  session_retention: { mode: 'recent_count', count: 50 },
  take_limit: 5,
  auto_attach_context: true,
  preview_before_apply: true,
  show_evidence_reads: false,
  default_video_seconds: 45,
  default_shot_view: 'observer',
  commentary_tone: 'professional',
};

const AGENT_STORAGE: AgentSessionStorageStats = {
  session_count: 2,
  entry_count: 19,
  object_ref_count: 6,
  plan_count: 2,
  plan_origin_count: 4,
  conversation_bytes: 184_320,
  plan_bytes: 40_960,
  oldest_session_at: '2026-08-13T16:40:00Z',
  newest_session_at: '2026-08-14T20:02:00Z',
};

/* ── recording, editing, media ────────────────────────────────────────────── */

const SHOT_PRESETS: RecordingShotPreset[] = [
  {
    id: 'preset-1',
    name: '标准跟随',
    camera_style: 'tracking',
    victim_pov: false,
    pre_roll_seconds: 3,
    post_roll_seconds: 2,
    presentation: {
      camera_fov: 90,
      viewmodel_fov: 68,
      flash_alpha: 0.4,
      show_hud: true,
      show_radar: true,
      voice: 'all_players',
    },
    created_at: '2026-08-01T10:00:00Z',
    updated_at: '2026-08-01T10:00:00Z',
  },
];

const EDITOR_PROJECTS: EditorProject[] = [
  {
    id: 'proj-highlights',
    name: '八月集锦',
    width: 1920,
    height: 1080,
    fps: 60,
    duration_seconds: 96.5,
    tracks: [],
    markers: [],
    settings: null,
    revision: 12,
    created_at: '2026-08-10T09:00:00Z',
    updated_at: '2026-08-14T22:19:00Z',
  },
  {
    id: 'proj-tactics',
    name: '战术板 · Inferno',
    width: 1920,
    height: 1080,
    fps: 60,
    duration_seconds: 42,
    tracks: [],
    markers: [],
    settings: null,
    revision: 3,
    created_at: '2026-08-11T08:30:00Z',
    updated_at: '2026-08-11T09:33:00Z',
  },
];

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
    created_at: '2026-08-10T09:12:00Z',
  },
];

const MONTAGE_PROJECTS: MontageProjectRecord[] = [
  {
    id: 'montage-1',
    name: '八月集锦 v3',
    clips: [],
    settings: {
      width: 1920,
      height: 1080,
      fps: 60,
      encoder: 'libx264',
      quality: 21,
      background_music: 'asset-2',
      music_volume: 0.35,
      transition_seconds: 0.4,
      intro_title: '八月集锦',
      intro_duration_seconds: 1.5,
      include_name_cards: true,
      name_card_duration_seconds: 1.2,
      outro_title: null,
      outro_duration_seconds: 2,
      branding_theme: 'broadcast',
    },
    created_at: '2026-08-10T09:00:00Z',
    updated_at: '2026-08-14T22:19:00Z',
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
  /* health, setup, runtime */
  ['GET', '/health', () => ({ status: 'ok', version: '0.1.0-dev', started_at: '2026-08-15T08:55:00Z' } satisfies ApiHealth)],
  ['GET', '/app/runtime-state', () => ({
    status: 'ok',
    version: '0.1.0-dev',
    started_at: '2026-08-15T08:55:00Z',
    data_dir: DATA_DIR,
    active_recording_job: 'job-771',
    runtime_session: 'session-dev-1',
  } satisfies RuntimeState)],
  ['GET', '/config/quick-check', () => ({
    checked_at: NOW,
    checks: [
      { kind: 'game', state: 'ready', label: 'Counter-Strike 2', detail: '已在 D:\\Steam 找到。' },
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
  ['GET', '/activities', () => ACTIVITIES],
  ['GET', '/activities/:kind/:id', ({ params }) =>
    ACTIVITIES.items.find((item) => item.id === `${params.kind}:${params.id}`) ?? ACTIVITIES.items[0]],
  ['GET', '/outputs', () => OUTPUTS],

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
  ['GET', '/evidence/search', () => ({
    items: [], total: 0, page: 1, page_size: 20,
    availability: {
      indexed_items: 0,
      indexed_demos: 3,
      total_analyses: 3,
      scan_complete: true,
      match_date: { available: true, indexed_items: 0, reason: null },
      source: { available: true, indexed_items: 0, reason: null },
    },
  } satisfies EvidenceSearchResponse)],
  ['GET', '/evidence/annotations', () => paged([] as EvidenceAnnotation[])],

  /* the Agent workspace */
  ['GET', '/agent/sessions', () => AGENT_SESSIONS],
  ['GET', '/agent/plans', () => AGENT_PLANS],
  ['GET', '/agent/workspace/referencable', () => AGENT_REFERENCES],
  ['GET', '/agent/workspace/settings', () => AGENT_SETTINGS],
  ['PUT', '/agent/workspace/settings', ({ body }) => ({ ...AGENT_SETTINGS, ...(body as Partial<AgentWorkspaceSettings>) })],
  ['GET', '/agent/workspace/storage', () => AGENT_STORAGE],

  /* recording */
  ['GET', '/recording/shot-presets', () => ({ items: SHOT_PRESETS })],
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

  /* editing and delivery */
  ['GET', '/editor/projects', () => ({ items: EDITOR_PROJECTS })],
  ['GET', '/editor/projects/:id', ({ params }) =>
    EDITOR_PROJECTS.find((project) => project.id === params.id) ?? EDITOR_PROJECTS[0]],
  ['GET', '/editor/presets', () => ({ items: [] })],
  ['GET', '/media/assets', () => ({ items: MEDIA_ASSETS })],
  ['GET', '/montage/projects', () => ({ items: MONTAGE_PROJECTS })],
  ['GET', '/montage/projects/:id', ({ params }) =>
    MONTAGE_PROJECTS.find((project) => project.id === params.id) ?? MONTAGE_PROJECTS[0]],
  ['GET', '/recorded-clips', () => paged(RECORDED_CLIPS)],
  ['GET', '/exports', () => ({ items: [] as ExportJobRecord[] })],

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
    case 'agent_thread':
      return AGENT_THREAD;
    case 'agent_cancel':
      return true;
    case 'list_hlae_bundles':
      return [];
    case 'desktop_binary':
      return new ArrayBuffer(0);
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
