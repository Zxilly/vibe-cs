/*
 * pages/match/views — turning `AnalysisWorkspace.highlights` into the rows
 * 高光 draws.
 *
 * Pure, React-free, `unit` project. The rename from wire to presentation model
 * is `domain/match/types.ts`'s contract; what needs an argument is the *kind*
 * mapping, because the two vocabularies are not the same size.
 *
 * ── The two vocabularies ───────────────────────────────────────────────────
 *
 * The wire (`AnalysisHighlightRecord.kind`) has ten members:
 *
 *   multi_kill  clutch  one_tap  wallbang  no_scope  knife  taser  defuse
 *   fail  timeline
 *
 * `domain/match/matchEnums`'s `HighlightKind` has nine, and they are the type
 * filter the artboard draws (残局 / 多杀 / 穿墙 / 爆头 / 赛点 / 经济翻盘, plus
 * 盲狙 and 首杀 which the same list draws as rows). Five of them line up
 * exactly. The rest:
 *
 *   one_tap → headshot   a one-shot kill is 爆头 in the product's words, and
 *                        the chip is the only thing the mapping drives — the
 *                        row itself prints `Highlight.label`, which is the
 *                        analyser's own phrasing (「1v3 残局」, 「四杀」).
 *   knife / taser / defuse / fail / timeline → other
 *                        There is no member for any of them and this phase may
 *                        not add one to `domain/**`. They keep their wire label
 *                        on the row and gather under 其他 in the filter, which
 *                        is a coarser filter, not a wrong row. Reported.
 *
 * Three members of `HighlightKind` — `opening-kill`, `match-point`,
 * `eco-comeback` — have no wire kind at all. The counts below are computed from
 * the data, so their chips simply never appear rather than showing 「赛点 0」.
 */

import { HIGHLIGHT_KINDS, type HighlightCandidate, type HighlightKind } from '../../../domain/match';
import type { AnalysisWorkspace, Highlight } from '../../../shared/desktop/viewModels';

/** See the module note for every line of this table. */
export const HIGHLIGHT_WIRE_KIND: Readonly<Record<Highlight['kind'], HighlightKind>> = {
  multi_kill: 'multi-kill',
  clutch: 'clutch',
  one_tap: 'headshot',
  wallbang: 'wallbang',
  no_scope: 'no-scope',
  knife: 'other',
  taser: 'other',
  defuse: 'other',
  fail: 'other',
  timeline: 'other',
};

export const HIGHLIGHT_PAGE_SIZE = 50;

const HAS_HAN = /\p{Script=Han}/u;

function localizedHighlightLabel(highlight: Highlight): string {
  const source = highlight.label.trim();
  if (HAS_HAN.test(source)) return source;
  switch (highlight.kind) {
    case 'multi_kill': return highlight.victims.length >= 2 ? `${highlight.victims.length}杀连段` : '多杀连段';
    case 'clutch': return '残局';
    case 'one_tap': return '一发击杀';
    case 'wallbang': return '穿墙击杀';
    case 'no_scope': return '盲狙击杀';
    case 'knife': return '刀杀';
    case 'taser': return '电击枪击杀';
    case 'defuse': return '拆弹';
    case 'fail': return '未完成机会';
    case 'timeline': return '比赛时间线片段';
  }
}

function localizedHighlightDescription(
  highlight: Highlight,
  subject: string,
  playerNames: ReadonlyMap<string, string>,
): string {
  const source = highlight.description.trim();
  if (source === '' || HAS_HAN.test(source)) return source;
  const victim = playerNames.get(highlight.victims[0] ?? '') ?? '对手';
  switch (highlight.kind) {
    case 'multi_kill': return `${subject} 在短时间内连续击杀 ${Math.max(2, highlight.victims.length)} 人`;
    case 'clutch': return `${subject} 的残局机会`;
    case 'one_tap': return `${subject} 一发击杀 ${victim}`;
    case 'wallbang': return `${subject} 穿墙击杀 ${victim}`;
    case 'no_scope': return `${subject} 盲狙击杀 ${victim}`;
    case 'knife': return `${subject} 使用刀击杀 ${victim}`;
    case 'taser': return `${subject} 使用电击枪击杀 ${victim}`;
    case 'defuse': return `${subject} 完成拆弹`;
    case 'fail': return `${subject} 的机会没有转化为回合胜利`;
    case 'timeline': return `${subject} 的单次比赛事件`;
  }
}

/**
 * Wire highlight → row.
 *
 * `subject` is the player's *name* when the analysis knows it and the raw id
 * when it does not: an id is ugly and true, and an empty subject column would
 * hide which player the clip is of. `tags` and `victims` travel on the wire but
 * are not passed on — the artboard's table has no tag column, and the wire tags
 * are analyser slugs (`clutch`) rather than words a reader was meant to see.
 */
export function toHighlightCandidate(
  highlight: Highlight,
  playerNames: ReadonlyMap<string, string>,
  tickRate: number | undefined,
): HighlightCandidate {
  const subject = playerNames.get(highlight.player_id) ?? '未知选手';
  const label = localizedHighlightLabel(highlight);
  const description = localizedHighlightDescription(highlight, subject, playerNames);

  return {
    id: highlight.id,
    kind: HIGHLIGHT_WIRE_KIND[highlight.kind],
    playerId: highlight.player_id,
    round: highlight.round,
    startTick: highlight.start_tick,
    endTick: highlight.end_tick,
    ...(label === '' ? {} : { label }),
    ...(description === '' ? {} : { description }),
    ...(subject === '' ? {} : { subject }),
    ...(tickRate === undefined ? {} : { tickRate }),
  };
}

/** Name lookup for `toHighlightCandidate`, built once per analysis document. */
export function playerNameIndex(analysis: AnalysisWorkspace | undefined): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  if (analysis === undefined) return index;
  for (const player of analysis.players) index.set(player.id, player.name);
  return index;
}

/**
 * Every highlight of the match, newest round first.
 *
 * The artboard's list runs 21, 21, 19, 18, 13, 11, 7 — descending by round,
 * because the interesting end of a match is the end of it. Within one round the
 * order is chronological, which is the only order two moments of the same round
 * can be read in.
 */
export function matchHighlights(
  analysis: AnalysisWorkspace | undefined,
): readonly HighlightCandidate[] {
  if (analysis === undefined) return [];
  const names = playerNameIndex(analysis);
  const rows = analysis.highlights.map((highlight) =>
    toHighlightCandidate(highlight, names, analysis.tick_rate),
  );
  return [...rows].sort((a, b) => (a.round === b.round ? a.startTick - b.startTick : b.round - a.round));
}

/* ── the type filter ─────────────────────────────────────────────────────── */

export interface HighlightKindCount {
  readonly kind: HighlightKind;
  readonly count: number;
}

/**
 * How many of each kind are present, in `HIGHLIGHT_KINDS` order.
 *
 * Kinds with no rows are left out entirely. A chip that reads 「赛点 0」 is a
 * filter that can only ever produce an empty list, and the artboard's own chip
 * row prints a count beside every word precisely because the count is the
 * point.
 */
export function highlightKindCounts(
  highlights: readonly HighlightCandidate[],
): readonly HighlightKindCount[] {
  const counts = new Map<HighlightKind, number>();
  for (const highlight of highlights) {
    counts.set(highlight.kind, (counts.get(highlight.kind) ?? 0) + 1);
  }
  const rows: HighlightKindCount[] = [];
  for (const kind of HIGHLIGHT_KINDS) {
    const count = counts.get(kind);
    if (count !== undefined && count > 0) rows.push({ kind, count });
  }
  return rows;
}

/** `null` is 「全部」. An unknown kind yields nothing rather than everything. */
export function filterHighlights(
  highlights: readonly HighlightCandidate[],
  kind: HighlightKind | null,
): readonly HighlightCandidate[] {
  if (kind === null) return highlights;
  return highlights.filter((highlight) => highlight.kind === kind);
}

/** One bounded DOM window of the filtered result. */
export function highlightPage<T>(
  highlights: readonly T[],
  page: number,
  pageSize = HIGHLIGHT_PAGE_SIZE,
): readonly T[] {
  const safeSize = Math.max(1, Math.floor(pageSize));
  const safePage = Math.max(1, Math.floor(page));
  const start = (safePage - 1) * safeSize;
  return highlights.slice(start, start + safeSize);
}

/* ── selection ───────────────────────────────────────────────────────────── */

/**
 * The row the address points at.
 *
 * A highlight is addressed as 「its round, at its first tick」 rather than
 * through `?evidence=`: §4.4 gives `evidence` the meaning
 * `EvidenceSearchItem.evidence_id`, and a highlight id is a different
 * namespace. Round plus start tick is already in the address, already survives
 * a copy, and is what every other view means by 「定位」.
 */
export function currentHighlightId(
  highlights: readonly HighlightCandidate[],
  round: number | null,
  tick: number | null,
): string | null {
  if (round === null || tick === null) return null;
  const match = highlights.find(
    (highlight) => highlight.round === round && highlight.startTick === tick,
  );
  return match?.id ?? null;
}

/** Toggling one row of the batch selection. Returns a new set. */
export function toggleSelected(
  selected: ReadonlySet<string>,
  id: string,
  next: boolean,
): ReadonlySet<string> {
  const copy = new Set(selected);
  if (next) copy.add(id);
  else copy.delete(id);
  return copy;
}

/**
 * The batch selection, narrowed to rows that still exist.
 *
 * Changing the type filter must not silently keep proposing rows the user can
 * no longer see: the count on the selection strip has to mean the rows on
 * screen, or 「已选 2 条」 is a claim about something invisible.
 */
export function visibleSelection(
  selected: ReadonlySet<string>,
  visible: readonly HighlightCandidate[],
): readonly HighlightCandidate[] {
  return visible.filter((highlight) => selected.has(highlight.id));
}
