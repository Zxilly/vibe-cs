/*
 * pages/library — turning a `DemoSummary` into the cells 「02 Demo 资料库」
 * draws.
 *
 * Pure and node-tested, for the usual reason: a date that renders 「08-14
 * 20:11」 on the artboard and 「2026/8/14 下午8:11」 in the app is a bug nobody
 * finds by reading the page component.
 *
 * ## Two places where the wire cannot answer what the artboard asks
 *
 * `normalizeDemo` (`shared/desktop/client.ts`) is the whole of what a library
 * row knows, and it drops `file_size` and `content_sha256` on the floor while
 * `DemoRecord.status` has no 「已分析 / 未分析」 in it at all. So:
 *
 *   · the status column speaks the wire's own vocabulary (已就绪 / 分析中 /
 *     文件缺失 …) rather than the artboard's 已分析 / 未分析. Labelling a
 *     `ready` record 「已分析」 would be a claim this layer cannot check.
 *   · 「大小」 and 「校验」 are not rendered as empty cells. An always-empty
 *     field is worse than an absent one.
 *
 * Both gaps are reported rather than papered over.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

import { formatTimecode } from '../../design/timeline';
import type { DemoLifecycleStatus } from '../../shared/desktop/dto';
import type { DemoSummary } from '../../shared/desktop/viewModels';

/** What a cell shows when the record simply has no value for it. */
export const EMPTY_CELL = '—';

/* ── dates and durations ─────────────────────────────────────────────────── */

/**
 * 「08-14 20:11」 — the artboard's mono date column, month-day and 24h clock.
 *
 * Formatted by hand rather than with `Intl.DateTimeFormat`: the reference's
 * column is a fixed-width mono field, and `Intl` changes both the separator and
 * the field order with the app locale (§5 ships zh-CN and en-US), which would
 * make the column jitter between the two languages.
 */
export function formatMatchDate(iso: string | null): string {
  const at = parseDate(iso);
  if (at === null) return EMPTY_CELL;
  return `${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

/** The same instant with its year, for the Inspector's 「导入时间」. */
export function formatDateTime(iso: string | null): string {
  const at = parseDate(iso);
  if (at === null) return EMPTY_CELL;
  return `${String(at.getFullYear())}-${formatMatchDate(iso)}`;
}

function parseDate(iso: string | null): Date | null {
  if (iso === null || iso === '') return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 「41:02」 — `mm:ss`, or `h:mm:ss` past the hour.
 *
 * `design/timeline`'s `formatTimecode` is that function already (it is what
 * `domain/match`'s `formatTickClock` is built on); a demo's length arrives in
 * seconds rather than ticks, so it is fed directly.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return EMPTY_CELL;
  return formatTimecode(seconds);
}

/** 「13 : 11」, or 「—」 while the match has no score yet. */
export function formatScore(demo: DemoSummary): string {
  const { score_team_a: a, score_team_b: b } = demo;
  if (a === null || b === null) return EMPTY_CELL;
  return `${String(a)} : ${String(b)}`;
}

/** 「24」, or 「—」 — a round count of zero is 「not known yet」, not zero rounds. */
export function formatRounds(rounds: number): string {
  return rounds > 0 ? String(rounds) : EMPTY_CELL;
}

/* ── the file ────────────────────────────────────────────────────────────── */

/**
 * The directory a demo sits in — the Inspector's 「位置」 (「D:\CS2\demos\」).
 * Both separators are handled because the same catalogue is read on Windows and
 * on a POSIX dev box.
 */
export function formatFileLocation(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (cut < 0) return EMPTY_CELL;
  return path.slice(0, cut + 1);
}

/* ── status ──────────────────────────────────────────────────────────────── */

export type DemoStatusTone = 'accent' | 'neutral' | 'running' | 'fail';

export interface DemoStatusMeta {
  readonly label: MessageDescriptor;
  readonly tone: DemoStatusTone;
}

/**
 * `DemoRecord.status`, in words, with the tone the artboard paints it in.
 *
 * `missing` is the artboard's 「文件缺失」 row — brick red, and the one row whose
 * action is 「重新定位」 rather than 「工作区」. `analyzing` is its 「分析中」 row,
 * but *without* the drawn 「62%」: `AnalysisRun` carries a stage and no
 * denominator, and §4.3 is explicit that the front end does not simulate
 * progress.
 */
const DEMO_STATUS_META: Readonly<Record<DemoLifecycleStatus, DemoStatusMeta>> = {
  discovered: { label: msg`待索引`, tone: 'neutral' },
  indexing: { label: msg`索引中`, tone: 'running' },
  ready: { label: msg`已就绪`, tone: 'accent' },
  analyzing: { label: msg`分析中`, tone: 'running' },
  failed: { label: msg`索引失败`, tone: 'fail' },
  missing: { label: msg`文件缺失`, tone: 'fail' },
};

export function demoStatusMeta(status: DemoLifecycleStatus): DemoStatusMeta {
  return DEMO_STATUS_META[status];
}

/** Whether the file behind the record is gone — the 「重新定位」 row. */
export function isDemoFileMissing(demo: DemoSummary): boolean {
  return demo.lifecycle_status === 'missing';
}

/** Whether the workspace can be opened, or only 「分析」 offered. */
export function isDemoAnalysable(demo: DemoSummary): boolean {
  return demo.lifecycle_status === 'ready';
}

/* ── source ──────────────────────────────────────────────────────────────── */

/**
 * 「来源」.
 *
 * The artboard prints 「Steam」 and 「本地目录」; the wire's `DemoSummary.source`
 * is `watch | upload | local`, which is *how the file arrived*, not which
 * platform played it. The platform lives on `DemoMetadata.match_source`, which
 * a list row does not carry. So the column says what it actually knows.
 */
const DEMO_SOURCE_LABEL = {
  watch: msg`监听目录`,
  upload: msg`已导入`,
  local: msg`本地文件`,
} as const;

export function demoSourceLabel(source: DemoSummary['source']): MessageDescriptor {
  return DEMO_SOURCE_LABEL[source];
}

/* ── deleting ────────────────────────────────────────────────────────────── */

export interface DeletePartition {
  /** Copied into the app's own storage — deleting stages the file for rollback. */
  readonly managed: readonly string[];
  /** Referenced where it lies — deleting drops the record and nothing else. */
  readonly external: readonly string[];
}

/**
 * The two halves the delete dialog states: 「其中 2 条是受管文件，会进入可回滚
 * 暂存，24 小时后清除；1 条是外部文件，只移除记录。」
 *
 * `source === 'upload'` is the managed set: an uploaded demo was copied into
 * the data directory, while `watch` and `local` records point at a file the
 * user owns somewhere else. That is an inference from `normalizeDemo` — the
 * wire has no `managed` flag — and it is reported as a gap rather than hidden
 * in this function.
 */
export function partitionForDelete(demos: readonly DemoSummary[]): DeletePartition {
  const managed: string[] = [];
  const external: string[] = [];
  for (const demo of demos) {
    (demo.source === 'upload' ? managed : external).push(demo.id);
  }
  return { managed, external };
}
