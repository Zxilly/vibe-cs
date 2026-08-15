/*
 * pages/evidence — the address bar is the search form (spec §4.4).
 *
 * 「05 证据检索」 draws the query as a row of conditions that stay on screen —
 * 「选手：Kael」「条件：穿墙」「近 30 天」 — and the whole point of the page is that
 * a hit can be handed to someone else. §4.4 makes the rule general: 「URL 是唯一
 * 真值 …… 证据可深链、后退可用」. So there is no `useState` holding a filter on
 * this page. Every condition is a query parameter, the browser's back button
 * walks the search history for free, and a link pasted into a message opens the
 * same result set.
 *
 * This module is the whole translation, both ways, and it is pure so
 * `evidenceSearchParams.test.ts` can exhaust it in the `unit` project.
 *
 * ── The event-family filter does not match the artboard, on purpose ────────
 *
 * The artboard's segmented control reads 击杀 · 死亡 · 回合 · 目标事件 · 道具 —
 * which is `domain/match`'s `EVIDENCE_KINDS`, the vocabulary of a *row*. The
 * index's filter is `EvidenceSearchEventFamily` and has four different members
 * (`kill`, `multi_kill`, `objective`, `round_start`): no 死亡 and no 道具, and a
 * 多杀 the artboard does not draw. Offering the artboard's five would mean two
 * of them silently returning nothing, so the control offers what the index can
 * actually answer, plus 「全部」. The divergence is reported as a contract gap
 * rather than papered over here.
 */

import type { EvidenceSearchEventFamily, EvidenceSearchQuery } from '../../shared/desktop/dto';
import { pickQueryValue } from '../routeQuery';

/* ── the two faces of the page ───────────────────────────────────────────── */

export const EVIDENCE_VIEWS = ['evidence', 'annotations'] as const;
export type EvidenceView = (typeof EVIDENCE_VIEWS)[number];

/* ── the event family ────────────────────────────────────────────────────── */

/** `all` is the absence of the filter, spelled so the segmented control has a
 *  member for it. It is never sent to the service. */
export const EVIDENCE_FAMILIES = ['all', 'kill', 'multi_kill', 'objective', 'round_start'] as const;
export type EvidenceFamily = (typeof EVIDENCE_FAMILIES)[number];

/* ── the state ───────────────────────────────────────────────────────────── */

/**
 * Everything the address bar carries. Strings are already trimmed; an absent
 * condition is `''` rather than `undefined` so a form can bind to it without a
 * null check and so the round trip through the URL is total.
 */
export interface EvidenceSearchState {
  readonly view: EvidenceView;
  readonly family: EvidenceFamily;
  /** Free text — the artboard's 「Kael 的穿墙击杀」 box. */
  readonly q: string;
  /** 「选手：Kael」. Matches either side of a duel; the index has `player`. */
  readonly player: string;
  /** 「＋ 武器」 */
  readonly weapon: string;
  /** 「＋ 地图」 */
  readonly map: string;
  /** Headshots only. `false` is the absence of the filter, not "no headshots". */
  readonly headshot: boolean;
  /** `YYYY-MM-DD`, inclusive. 「近 30 天」 writes `from` and leaves `to` empty. */
  readonly from: string;
  readonly to: string;
  /** 1-based, matching what `design/data/Pagination` shows. */
  readonly page: number;
  /** The row the Inspector is describing. Deep-linkable — this is the field
   *  that makes 「把这条证据发给别人」 work at all. */
  readonly evidenceId: string;
}

export const EMPTY_EVIDENCE_SEARCH: EvidenceSearchState = {
  view: 'evidence',
  family: 'all',
  q: '',
  player: '',
  weapon: '',
  map: '',
  headshot: false,
  from: '',
  to: '',
  page: 1,
  evidenceId: '',
};

/** Rows per page. 20 keeps the results list inside one 1100 × 700 screen with
 *  the 42px comfortable row (`--h-row`), which is what §10.3 measured the
 *  library table at. */
export const EVIDENCE_PAGE_SIZE = 20;

/* ── URL → state ─────────────────────────────────────────────────────────── */

/** Anything with `get`, so this takes a `URLSearchParams` or react-router's. */
export interface ReadableParams {
  get(name: string): string | null;
}

export function readEvidenceSearch(params: ReadableParams): EvidenceSearchState {
  return {
    view: pickQueryValue(params.get('view'), EVIDENCE_VIEWS, 'evidence'),
    family: pickQueryValue(params.get('family'), EVIDENCE_FAMILIES, 'all'),
    q: text(params.get('q')),
    player: text(params.get('player')),
    weapon: text(params.get('weapon')),
    map: text(params.get('map')),
    headshot: params.get('headshot') === '1',
    from: date(params.get('from')),
    to: date(params.get('to')),
    page: pageNumber(params.get('page')),
    evidenceId: text(params.get('evidence')),
  };
}

/* ── state → URL ─────────────────────────────────────────────────────────── */

/**
 * Only the parameters that differ from the default are written, so a bare
 * `/evidence` stays bare and the link a user copies is as short as what they
 * actually chose. Ordering is fixed (not object order) so two equal states
 * always produce the same string — otherwise every render would look like a
 * navigation to react-router.
 */
export function writeEvidenceSearch(state: EvidenceSearchState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.view !== 'evidence') params.set('view', state.view);
  if (state.family !== 'all') params.set('family', state.family);
  if (state.q !== '') params.set('q', state.q);
  if (state.player !== '') params.set('player', state.player);
  if (state.weapon !== '') params.set('weapon', state.weapon);
  if (state.map !== '') params.set('map', state.map);
  if (state.headshot) params.set('headshot', '1');
  if (state.from !== '') params.set('from', state.from);
  if (state.to !== '') params.set('to', state.to);
  if (state.page > 1) params.set('page', String(state.page));
  if (state.evidenceId !== '') params.set('evidence', state.evidenceId);
  return params;
}

/* ── state → the IPC query ───────────────────────────────────────────────── */

/**
 * The `EvidenceSearchQuery` the service is asked for.
 *
 * Absent conditions are *omitted* rather than set to `undefined`: the workspace
 * compiles with `exactOptionalPropertyTypes`, and — more to the point —
 * TanStack hashes the query object into the cache key, where `{ q: undefined }`
 * and `{}` are two different entries for one search (`data/keys.ts` says so in
 * its own words).
 *
 * `page` and `page_size` are always present, because they always apply.
 */
export function toEvidenceQuery(state: EvidenceSearchState): EvidenceSearchQuery {
  const query: EvidenceSearchQuery = {
    page: state.page,
    page_size: EVIDENCE_PAGE_SIZE,
  };
  if (state.family !== 'all') {
    return {
      ...query,
      ...conditions(state),
      event_family: state.family satisfies EvidenceSearchEventFamily,
    };
  }
  return { ...query, ...conditions(state) };
}

function conditions(state: EvidenceSearchState): EvidenceSearchQuery {
  return {
    ...(state.q === '' ? {} : { q: state.q }),
    ...(state.player === '' ? {} : { player: state.player }),
    ...(state.weapon === '' ? {} : { weapon: state.weapon }),
    ...(state.map === '' ? {} : { map: state.map }),
    ...(state.headshot ? { headshot: true } : {}),
    ...(state.from === '' ? {} : { match_date_from: state.from }),
    ...(state.to === '' ? {} : { match_date_to: state.to }),
  };
}

/* ── what the user actually asked for ────────────────────────────────────── */

/** One condition chip: which field it came from and what it says. */
export interface EvidenceCondition {
  /** The `EvidenceSearchState` field, so removing a chip is a keyed update. */
  readonly field: 'family' | 'q' | 'player' | 'weapon' | 'map' | 'headshot' | 'from' | 'to';
  readonly value: string;
}

/**
 * The active conditions, in the order the artboard draws them. Used twice: to
 * paint the chip row, and to tell an empty result set 「你搜的是这些」 instead of
 * apologising — an empty state that cannot name the query cannot suggest what
 * to relax.
 */
export function activeConditions(state: EvidenceSearchState): readonly EvidenceCondition[] {
  const list: EvidenceCondition[] = [];
  if (state.family !== 'all') list.push({ field: 'family', value: state.family });
  if (state.q !== '') list.push({ field: 'q', value: state.q });
  if (state.player !== '') list.push({ field: 'player', value: state.player });
  if (state.weapon !== '') list.push({ field: 'weapon', value: state.weapon });
  if (state.map !== '') list.push({ field: 'map', value: state.map });
  if (state.headshot) list.push({ field: 'headshot', value: '1' });
  if (state.from !== '') list.push({ field: 'from', value: state.from });
  if (state.to !== '') list.push({ field: 'to', value: state.to });
  return list;
}

/**
 * Clearing one chip. Everything else survives, and the page returns to 1 —
 * staying on page 7 of a result set that just got wider shows a slice nobody
 * asked for.
 */
export function withoutCondition(
  state: EvidenceSearchState,
  field: EvidenceCondition['field'],
): EvidenceSearchState {
  const cleared: EvidenceSearchState =
    field === 'family'
      ? { ...state, family: 'all' }
      : field === 'headshot'
        ? { ...state, headshot: false }
        : { ...state, [field]: '' };
  return { ...cleared, page: 1, evidenceId: '' };
}

/** 「清空条件」 — the view and nothing else survives, because the view is which
 *  page you are on rather than what you searched for. */
export function clearedConditions(state: EvidenceSearchState): EvidenceSearchState {
  return { ...EMPTY_EVIDENCE_SEARCH, view: state.view };
}

/* ── the date chip ───────────────────────────────────────────────────────── */

/** 「近 30 天」, as the artboard writes it. */
export const RECENT_WINDOW_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/**
 * `YYYY-MM-DD`, `days` before `now`, in UTC.
 *
 * UTC rather than local time because the value goes on a URL that is meant to
 * be shareable, and a boundary that moves with the reader's timezone would make
 * the same link return different rows in Berlin and in Shanghai.
 */
export function isoDaysAgo(now: Date, days: number): string {
  const stamp = new Date(now.getTime() - days * MS_PER_DAY);
  return stamp.toISOString().slice(0, 10);
}

/* ── parsing ─────────────────────────────────────────────────────────────── */

function text(value: string | null): string {
  return value === null ? '' : value.trim();
}

/** `YYYY-MM-DD` or nothing. A half-typed date is dropped rather than sent —
 *  the service would reject it and the page would blame the user's query. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function date(value: string | null): string {
  const trimmed = text(value);
  return ISO_DATE.test(trimmed) ? trimmed : '';
}

function pageNumber(value: string | null): number {
  if (value === null) return 1;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed;
}
