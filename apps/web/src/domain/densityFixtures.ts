/*
 * Domain layer, 2 of 3 — the real data volumes, written down once.
 *
 * Phase 2's exit condition (spec §9 risk 6) is 「用真实数据量在 1100×700 复核」.
 * Four agents wrote `match/`, `map/`, `media/` and `task/` against artboard-sized
 * samples — two evidence rows, four clips, twenty-four rounds. This file is the
 * other half of that sentence: the counts a real session produces, each one
 * carrying where it came from, so a density test asserts against a number
 * somebody can argue with rather than against a number somebody invented.
 *
 * ── Provenance tags ────────────────────────────────────────────────────────
 *
 * Every constant below is tagged in its comment with exactly one of:
 *
 *   [画板]   printed on an artboard. `design-reference.html`, quoted verbatim,
 *            with the screen it appears on.
 *   [规则]   a CS2 rule or a Valve artefact property. Not negotiable, not ours.
 *   [推导]   arithmetic on top of a [画板] or [规则] number, with the arithmetic
 *            written out.
 *   [猜测]   nobody has measured this. It is a plausible ceiling chosen so a
 *            density test has something to push against, and it is marked so
 *            that a later measurement replaces it instead of agreeing with it.
 *
 * ── Not a component fixture ────────────────────────────────────────────────
 *
 * Nothing here is imported by a component, and nothing here goes through a
 * Lingui macro: `lingui.config.ts` excludes `*.test.*` and `**\/test\/**` from
 * extraction but not this path, so a macro here would push fixture copy into the
 * shipped catalogue. Every string is a plain literal, which renders as itself in
 * any `ReactNode` slot. The same rule `match/matchFixtures.testing.ts` follows.
 */

import type { Engagement } from './map/EngagementLayer';
import type { HeatSample } from './map/heatBinning';
import type { PlayerPath, PathSample } from './map/PathLayer';
import type { FocusedPlayer } from './match/MatchContextBar';
import type {
  EvidenceItem,
  HighlightCandidate,
  MatchPeriod,
  RoundSummary,
} from './match/types';
import type { EvidenceKind, HighlightKind, RoundEndReason, RoundWinner } from './match/matchEnums';
import type { FilmFrame, MediaClip } from './media/types';
import type { TaskLogEntry, TaskSummary } from './task/types';

/* ── the window ──────────────────────────────────────────────────────────── */

/**
 * [画板] The 「補齊 · 壳层规格」 artboard is drawn at 1100 × 700 and spec §8 names
 * the same number as the single shell breakpoint. `design/layout/collapse.ts`
 * holds it as `COLLAPSE_BREAKPOINT_PX`; it is repeated here so a fixture module
 * that a node test imports does not have to pull in a React hook file.
 */
export const FOLD_WIDTH_PX = 1100;

/**
 * [推导] What is left for page content at the fold, from
 * `match/roundTimelineLayout.ts`'s own derivation:
 *
 *     1100 window − 56 collapsed icon rail (--w-nav-collapsed)
 *          − 48 page gutters (24 each side)  =  996
 *
 * The Inspector is a drawer at this width (§8 rule 2), so it takes nothing.
 */
export const FOLD_CONTENT_WIDTH_PX = 996;

/**
 * [推导] The same subtraction with a docked 380px Inspector still in place
 * (`--w-inspector`): 996 − 380 = 616. This is *not* what §8 asks for — rule 2
 * says the Inspector folds — and it exists so a test can show what the unfolded
 * arrangement would cost.
 */
export const FOLD_CONTENT_WIDTH_WITH_DOCKED_INSPECTOR_PX = 616;

/* ── one match ───────────────────────────────────────────────────────────── */

/**
 * [规则] + [画板] MR12: first to 13, so regulation is at most 24 rounds. 「03
 * 比赛工作区」 prints 「24 回合」 and 「04」 prints 「回合 21 / 24」.
 */
export const REGULATION_ROUNDS = 24;

/**
 * [规则] CS2's default overtime is MR3 — six more rounds, first to 4 — added at
 * 12:12. 24 + 6 = 30, which is the count the brief names as the one that has to
 * fit at the fold.
 */
export const OVERTIME_ROUNDS = 30;

/**
 * [推导] Overtime repeats until somebody wins it. `roundTimelineLayout.ts` was
 * written against 「a long one runs past 50」 and its worst case is 58, i.e. five
 * overtimes plus one round of a sixth (24 + 5×6 + 4). Kept identical so the
 * strip's own arithmetic and this file cannot drift.
 */
export const LONG_OVERTIME_ROUNDS = 58;

/** [规则] 5v5. The ceiling on how many players a focus set can name. */
export const MATCH_ROSTER_SIZE = 10;

/**
 * [推导] Halves plus overtimes, as `Scoreboard` draws them: 上半 · 下半 for
 * regulation, one more per overtime. A match that reaches `LONG_OVERTIME_ROUNDS`
 * has 2 + 5 = 7 of them, but the common long case is 2 + 2.
 */
export const PERIODS_WITH_OVERTIME = 4;

/* ── evidence ────────────────────────────────────────────────────────────── */

/**
 * [画板] 「05 证据检索」 header: 「248 场比赛 · 1 284 632 条规范化证据」. Divided
 * out that is 5180 normalised facts per match — every tick-stamped event of
 * every kind, which is the corpus a query runs against, not a list anybody
 * scrolls.
 */
export const NORMALIZED_EVIDENCE_TOTAL = 1_284_632;

/** [画板] 「05 证据检索」: 「命中 47 条 · 排序：时间倒序」. One query's result set. */
export const EVIDENCE_SEARCH_HITS = 47;

/**
 * [猜测] The brief states the per-match evidence a workspace panel lists as
 * 60–200. It is consistent with the artboards — 「13 条首杀证据」, 「18 条高光证据」,
 * 「3 条比赛证据」 are all single-filter subsets of one match — but no artboard
 * prints the unfiltered per-match figure, so the upper end is a stated ceiling
 * and not a measurement.
 */
export const EVIDENCE_PER_MATCH_MIN = 60;
export const EVIDENCE_PER_MATCH_MAX = 200;

/** [画板] 「03 比赛工作区 · 高光列表」 filter row: 「全部 18」. */
export const HIGHLIGHTS_PER_MATCH = 18;

/* ── the library and the directory ───────────────────────────────────────── */

/** [画板] 「02 Demo 资料库」: 「248 场 · 3 个监听目录」; 「05」 and 「06」 repeat 248. */
export const LIBRARY_MATCH_COUNT = 248;

/** [画板] 「02 Demo 资料库」: 「3 个监听目录」. */
export const WATCHED_FOLDER_COUNT = 3;

/**
 * [画板] 「06 玩家目录」: 「312 名选手 · 来自 248 场已分析比赛」.
 *
 * The brief asks for 「40+ 人」; 312 is the artboard's own number and is the one
 * used, because 40 would let a table pass a density test that 312 fails. 40 is
 * the right order for a *roster* view, which is `MATCH_ROSTER_SIZE` × a handful
 * of matches, not for the directory.
 */
export const PLAYER_DIRECTORY_COUNT = 312;

/* ── tasks and outputs ───────────────────────────────────────────────────── */

/**
 * [画板] 「12 设置与诊断 · 保留多久」 is a segmented control whose checked option is
 * 「最近 50 条」. That is the retention default, so it is also the size of the
 * task record list a default install ever shows.
 */
export const TASK_RECORD_COUNT = 50;

/**
 * [猜测] The brief says 3–5 tasks run at once; the top of that range is used.
 * The artboards draw at most two simultaneously (「01 工作台首页」), so this is a
 * stated ceiling rather than an observation.
 */
export const CONCURRENT_TASK_COUNT = 5;

/** [画板] 「11 输出与任务记录」 header: 「34 个输出 · 218 GB 可用」. */
export const OUTPUT_COUNT = 34;

/**
 * [推导] A recording pipeline logs one line per stage per clip: six stages
 * (`recordingStages()` — 启动 · 跳转 · 采集 · 稳定 · 编码 · 发布) over a
 * 20-clip run is 120 lines. Marked derived rather than observed because no
 * artboard draws a full log; 「补齐 · 规范与状态」 draws five lines of one.
 */
export const STAGE_LOG_ENTRY_COUNT = 120;

/* ── the montage ─────────────────────────────────────────────────────────── */

/** [画板] 「09 快速合辑」 header: 「5 段素材 · 2 分 04 秒 · 上次保存 3 分钟前」. */
export const MONTAGE_CLIP_COUNT = 5;

/**
 * [猜测] A per-round highlight reel of one match. `HIGHLIGHTS_PER_MATCH` is 18
 * and a user who keeps every one of them plus a few from elsewhere lands near
 * 24; nothing measures this.
 */
export const MONTAGE_CLIP_COUNT_MAX = 24;

/** [画板] 「09 快速合辑」: 「2 分 04 秒」 = 124 seconds. */
export const MONTAGE_DURATION_SECONDS = 124;

/**
 * [推导] One thumbnail every two seconds of `MONTAGE_DURATION_SECONDS` is 62
 * cells. The interval is the choice; two seconds is what makes a 132px cell
 * (`--w-track-head`) about one screen-width per minute of footage.
 */
export const FILM_FRAME_COUNT = 62;

/* ── the map ─────────────────────────────────────────────────────────────── */

/**
 * [推导] `map/MapCanvas.tsx`'s own budget: 「heat up to ~10⁴ raw points」, which
 * matches the brief's 「热力图上万个点」. 12 000 is one cross-match death map —
 * 「覆盖 12 场比赛」 on 「04」's legend — at ~1000 deaths a match.
 */
export const HEAT_SAMPLE_COUNT = 12_000;

/**
 * [推导] Ten players × 24 rounds = 240 tracks, which is the brief's 「几百条
 * 折线」 for a whole-match path view.
 */
export const PLAYER_PATH_COUNT = 240;

/**
 * [推导] `map/PathLayer.tsx` is written against 「a 600-sample track」. At the
 * artboard's 「采样 64 tick」 that is a little under ten seconds of a round; a
 * whole round at that rate would be ~7000, which is why the page downsamples
 * before it gets here and why 600 is the number the layer names.
 */
export const PATH_SAMPLE_COUNT = 600;

/**
 * [推导] 24 rounds × 8 kills is 192; rounded to 190. 「04」 draws four duels and
 * states no total, so the multiplier is the assumption — a 5v5 round ends with
 * between five and ten deaths.
 */
export const ENGAGEMENT_COUNT = 190;

/* ── builders ────────────────────────────────────────────────────────────── */

/**
 * A full round strip. Winners alternate on a 5/3 rhythm rather than randomly so
 * that a snapshot is stable and both winner rules appear in every row of a
 * wrapped strip; every fifth round is a key round, which is the densest the
 * two-rule cell ever gets.
 */
const REASON_CYCLE: readonly RoundEndReason[] = [
  'elimination',
  'bomb-exploded',
  'bomb-defused',
  'time-expired',
  'elimination',
  'unknown',
];

export function makeRounds(count: number): readonly RoundSummary[] {
  let teamA = 0;
  let teamB = 0;
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const winner: RoundWinner = index % 8 < 5 ? 'a' : 'b';
    if (winner === 'a') teamA += 1;
    else teamB += 1;
    return {
      number,
      winner,
      reason: REASON_CYCLE[index % REASON_CYCLE.length] ?? 'unknown',
      startTick: 6000 * number,
      endTick: 6000 * number + 5200,
      teamAScore: teamA,
      teamBScore: teamB,
      ...(number % 5 === 0 ? { key: true } : {}),
    };
  });
}

/** Halves plus overtimes, in the order `Scoreboard` prints them. */
export function makePeriods(count: number): readonly MatchPeriod[] {
  return Array.from({ length: count }, (_, index) => {
    const overtime = index >= 2;
    return {
      id: `period-${String(index + 1)}`,
      label: overtime ? `加时 ${String(index - 1)}` : index === 0 ? '上半' : '下半',
      teamAScore: 6 + index,
      teamBScore: 6 + ((index + 1) % 3),
      ...(overtime ? { overtime: true } : {}),
    };
  });
}

const EVIDENCE_KIND_CYCLE: readonly EvidenceKind[] = ['kill', 'death', 'utility', 'objective', 'round'];

/**
 * Evidence rows at their worst: every optional field present, and the free-text
 * ones long enough that a row without truncation would push its neighbours off
 * the panel. A density fixture that used short strings would prove nothing.
 */
export function makeEvidence(count: number, options: { readonly rounds?: number } = {}): readonly EvidenceItem[] {
  const rounds = options.rounds ?? REGULATION_ROUNDS;
  return Array.from({ length: count }, (_, index) => ({
    id: `ev-${String(index)}`,
    tick: 6000 + index * 137,
    kind: EVIDENCE_KIND_CYCLE[index % EVIDENCE_KIND_CYCLE.length] ?? 'kill',
    actor: `Kael-${String(index % 10)}`,
    target: `Sable-${String((index + 3) % 10)}`,
    weapon: 'AK-47',
    description: '穿墙击杀 · 爆头 · 命中时处于闪盲状态',
    context: 'A 点连接处 · 距离 12.4m · 经击杀事件验证的交战轴 · 低血量 剩余 11 HP',
    round: (index % rounds) + 1,
    matchLabel: 'Aurora vs Meridian · Mirage · 2026-08-14',
    annotation: { label: index % 3 === 0 ? '已处理' : '待处理', resolved: index % 3 === 0 },
    tickRate: 64,
  }));
}

const HIGHLIGHT_KIND_CYCLE: readonly HighlightKind[] = ['clutch', 'multi-kill', 'wallbang', 'match-point'];

export function makeHighlights(count: number): readonly HighlightCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `hl-${String(index)}`,
    kind: HIGHLIGHT_KIND_CYCLE[index % HIGHLIGHT_KIND_CYCLE.length] ?? 'clutch',
    label: '1v3 残局',
    round: (index % REGULATION_ROUNDS) + 1,
    subject: `Kael-${String(index % 10)}`,
    description: '三杀后拆包，剩余 1.8 秒；进入残局时己方仅剩 1 人，由逐回合阵容真值确认',
    startTick: 148_920 + index * 900,
    endTick: 150_440 + index * 900,
    tags: ['赛点', '经济翻盘'],
    tickRate: 64,
  }));
}

/** 聚焦选手 chips. A focus set cannot exceed the roster — see `MATCH_ROSTER_SIZE`. */
export function makeFocusedPlayers(count: number): readonly FocusedPlayer[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `player-${String(index)}`,
    name: `Kael-${String(index)}`,
    ...(index === 0 ? { primary: true } : {}),
  }));
}

/** One row of 「02 Demo 资料库」 / 「06 玩家目录」, as a plain record a table maps. */
export interface DensityTableRow {
  readonly id: string;
  readonly title: string;
  readonly map: string;
  readonly playedAt: string;
  readonly durationLabel: string;
  readonly rounds: number;
  readonly source: string;
  readonly tags: string;
  readonly status: string;
}

export function makeLibraryRows(count: number): readonly DensityTableRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `demo-${String(index)}`,
    title: `Aurora vs Meridian · 第 ${String(index + 1)} 场 · 一个长到必须截断的比赛名`,
    map: 'Mirage',
    playedAt: '2026-08-14 21:35',
    durationLabel: '38 分 12 秒',
    rounds: REGULATION_ROUNDS,
    source: index % 4 === 0 ? '监听目录 · D:\\CS2\\replays' : 'Steam 比赛历史',
    tags: '排位 · 已标记 · 待复盘',
    status: index % 7 === 0 ? '未分析' : '已分析',
  }));
}

export function makePlayerRows(count: number): readonly DensityTableRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `player-${String(index)}`,
    title: `Kael-${String(index)}`,
    map: 'Mirage',
    playedAt: '2026-08-14',
    durationLabel: '18 场',
    rounds: REGULATION_ROUNDS,
    source: 'Aurora',
    tags: '狙击手 · 指挥',
    status: '已分析',
  }));
}

/* ── tasks ───────────────────────────────────────────────────────────────── */

const TASK_KIND_CYCLE = ['recording', 'analysis', 'montage', 'export', 'download'] as const;

/**
 * A task record list: `running` at the head, then a mix of terminal states, with
 * `CONCURRENT_TASK_COUNT` of them still going. Failures carry a recovery action
 * because `TaskSummary` will not compile without one.
 */
export function makeTasks(count: number, options: { readonly running?: number } = {}): readonly TaskSummary[] {
  const running = options.running ?? CONCURRENT_TASK_COUNT;
  const noop = (): void => {};

  return Array.from({ length: count }, (_, index): TaskSummary => {
    const kind = TASK_KIND_CYCLE[index % TASK_KIND_CYCLE.length] ?? 'recording';
    const base = {
      id: `#A-${String(2481 - index)}`,
      kind,
      subject: `Kael_Mirage_1v3_第 ${String(index + 1)} 版_一个会把标题挤出去的很长的目标名`,
      startedAt: '2026-08-14T09:12:00.000Z',
      durationMs: 401_000 + index * 1000,
      note: '4 个片段',
    } as const;

    if (index < running) {
      return {
        ...base,
        status: 'running',
        stage: { id: 'capture', label: '位置采样', index: 3, count: 6 },
        progress: { completed: 2, total: 6, unit: 'clips' },
      };
    }
    if (index % 9 === 0) {
      return {
        ...base,
        status: 'failed',
        failure: {
          reason: 'disk-space',
          impact: '影响范围：仅这一次导出，工程与素材已保留。释放 4.2 GB 后可重试。',
          recovery: { label: '释放空间', onAction: noop },
        },
      };
    }
    return {
      ...base,
      status: 'succeeded',
      artifacts: [{ id: `out-${String(index)}`, label: `Kael_Mirage_1v3_${String(index)}.mp4`, href: '#' }],
    };
  });
}

export function makeTaskLog(count: number): readonly TaskLogEntry[] {
  const stages = ['启动', '跳转', '采集', '稳定', '编码', '发布'] as const;
  return Array.from({ length: count }, (_, index) => ({
    id: `log-${String(index)}`,
    at: '2026-08-14T09:12:00.000Z',
    message: `${stages[index % stages.length] ?? '采集'} · 片段 ${String(Math.floor(index / stages.length) + 1)} 完成 · 3.0 秒`,
    ...(index % stages.length === 5 ? { emphasis: true } : {}),
  }));
}

/* ── media ───────────────────────────────────────────────────────────────── */

export function makeClips(count: number): readonly MediaClip[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `clip-${String(index)}`,
    title: `Mirage 1v3 残局 · 第 ${String(index + 1)} 段 · 一个长到必须截断的片段标题`,
    durationSeconds: 12 + (index % 7) * 5.5,
    subtitle: `Kael · R${String((index % REGULATION_ROUNDS) + 1)} · 拆包 · 穿墙`,
    ...(index % 11 === 10 ? { status: 'missing' as const } : {}),
  }));
}

export function makeFilmFrames(count: number, durationSeconds = MONTAGE_DURATION_SECONDS): readonly FilmFrame[] {
  const step = count <= 1 ? 0 : durationSeconds / (count - 1);
  return Array.from({ length: count }, (_, index) => ({ time: index * step }));
}

/**
 * Peaks for a full montage. One value per 1/50th of a second is what
 * `waveformPeaks.downsamplePeaks` is meant to be handed; the shape is a slow
 * beat so the envelope is not a flat band.
 */
export function makePeaks(durationSeconds = MONTAGE_DURATION_SECONDS, perSecond = 50): readonly number[] {
  const length = Math.round(durationSeconds * perSecond);
  return Array.from({ length }, (_, index) => Math.sin(index / 7) * (0.35 + 0.65 * Math.abs(Math.cos(index / 400))));
}

/* ── map ─────────────────────────────────────────────────────────────────── */

/**
 * Heat samples spread over the artwork's unit square in world units, using a
 * 1:1 calibration so a test can reason about where a sample lands. The spread
 * is deterministic (a coprime stride, not a random walk) so a bin count is
 * reproducible across runs.
 */
export function makeHeatSamples(count: number, overviewSize = 1024): readonly HeatSample[] {
  return Array.from({ length: count }, (_, index) => ({
    x: ((index * 37) % overviewSize),
    y: overviewSize - ((index * 61) % overviewSize),
    weight: 1,
  }));
}

export function makePlayerPaths(
  pathCount: number,
  sampleCount: number,
  overviewSize = 1024,
): readonly PlayerPath[] {
  return Array.from({ length: pathCount }, (_, pathIndex) => {
    const samples: PathSample[] = Array.from({ length: sampleCount }, (_, sampleIndex) => ({
      x: (pathIndex * 13 + sampleIndex * 3) % overviewSize,
      y: overviewSize - ((pathIndex * 29 + sampleIndex * 5) % overviewSize),
      tick: 6000 + sampleIndex * 64,
    }));
    return {
      playerId: `player-${String(pathIndex)}`,
      playerName: `Kael-${String(pathIndex % 10)}`,
      side: pathIndex % 2 === 0 ? ('CT' as const) : ('T' as const),
      samples,
    };
  });
}

export function makeEngagements(count: number, overviewSize = 1024): readonly Engagement[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `duel-${String(index)}`,
    tick: 6000 + index * 211,
    round: (index % REGULATION_ROUNDS) + 1,
    attacker: {
      playerId: `player-${String(index % 10)}`,
      playerName: `Kael-${String(index % 10)}`,
      x: (index * 41) % overviewSize,
      y: overviewSize - ((index * 17) % overviewSize),
      side: 'CT' as const,
    },
    victim: {
      playerId: `player-${String((index + 5) % 10)}`,
      playerName: `Sable-${String((index + 5) % 10)}`,
      x: (index * 23 + 90) % overviewSize,
      y: overviewSize - ((index * 53 + 120) % overviewSize),
      side: 'T' as const,
    },
    weapon: 'ak47',
    ...(index % 6 === 0 ? { throughWall: true } : {}),
    ...(index % 4 === 0 ? { headshot: true } : {}),
  }));
}
