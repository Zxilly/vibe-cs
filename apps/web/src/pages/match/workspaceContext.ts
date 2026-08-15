/*
 * pages/match — the §4.4 workspace context, read from and written to the URL.
 *
 * 「URL 是唯一真值」. The five parameters — `view` / `round` / `player` / `tick`
 * / `evidence` — are the whole state of the workspace, and nothing here is
 * mirrored into React state. That is what makes 「定位」 from `/evidence` a plain
 * link (`EvidencePage` already builds one), the back button meaningful, and a
 * pasted address reproduce a selection exactly.
 *
 * Pure, so `workspaceContext.test.ts` runs it in the `unit` project with no DOM
 * and no router.
 *
 * ── Why the parsers are strict and the fallbacks are silent ────────────────
 *
 * `pages/routeQuery.ts` states the rule for `?view=` and this file follows it
 * for the other four: an unreadable value falls back rather than rendering
 * nothing. A hand-edited `?round=abc` is a navigation, not an error — the
 * workspace opens on the match with no round selected, which is a state it has
 * anyway. What it must not do is pass `NaN` down to a component that will then
 * ask for round `NaN` of the analysis.
 *
 * ── Why changing the round drops the tick and the evidence ─────────────────
 *
 * Those three are not independent. `evidence` names one tick-level fact, and a
 * fact belongs to exactly one round; `tick` is the playhead, and a playhead
 * from round 21 is meaningless once round 7 is selected. Keeping them would put
 * the Inspector and the round strip on different rounds — the reference draws
 * them as one selection (「选中：第 21 回合」 above 「回合内证据」), so the
 * invariant is enforced here, once, rather than in nine views.
 *
 * Changing the *view* clears nothing. That is the entire point of §7's single
 * address: 「回合 21 · 选手 Kael」 survives the walk from 概览 to 对位 to 回放.
 */

import { pickQueryValue } from '../routeQuery';
import { MATCH_VIEW_IDS, type MatchViewId } from './viewContract';

/** The query-string names, spelled once. §7 fixes all five. */
export const MATCH_PARAM = {
  view: 'view',
  round: 'round',
  player: 'player',
  tick: 'tick',
  evidence: 'evidence',
} as const;

/** §7's default face of the workspace. */
export const DEFAULT_MATCH_VIEW: MatchViewId = 'overview';

/**
 * Everything the workspace knows about what the user is looking at.
 *
 * `null` is 「没有选中」 and is a legitimate, common state — the workspace opens
 * this way. It is never a stand-in for 「加载中」.
 */
export interface MatchWorkspaceContext {
  readonly view: MatchViewId;
  /** 1-based round number, as the product counts them. */
  readonly round: number | null;
  /** The focused player's id, as the analysis spells it. */
  readonly player: string | null;
  /** The playhead. Absent means 「回合开头」, which only the view can resolve. */
  readonly tick: number | null;
  /** `EvidenceSearchItem.evidence_id` of the selected fact. */
  readonly evidence: string | null;
}

/**
 * A change to the context. A field left out is unchanged; a field set to `null`
 * is cleared. Those are two different requests, which is why this is not
 * `Partial<MatchWorkspaceContext>` with `undefined` doing double duty.
 */
export interface MatchContextPatch {
  readonly view?: MatchViewId | undefined;
  readonly round?: number | null | undefined;
  readonly player?: string | null | undefined;
  readonly tick?: number | null | undefined;
  readonly evidence?: string | null | undefined;
}

/* ── reading ─────────────────────────────────────────────────────────────── */

export function readWorkspaceContext(params: URLSearchParams): MatchWorkspaceContext {
  return {
    view: pickQueryValue(params.get(MATCH_PARAM.view), MATCH_VIEW_IDS, DEFAULT_MATCH_VIEW),
    round: readPositiveInteger(params.get(MATCH_PARAM.round)),
    player: readIdentifier(params.get(MATCH_PARAM.player)),
    tick: readTick(params.get(MATCH_PARAM.tick)),
    evidence: readIdentifier(params.get(MATCH_PARAM.evidence)),
  };
}

/** Rounds are 1-based; `?round=0` is as unreadable as `?round=x`. */
function readPositiveInteger(raw: string | null): number | null {
  const value = readInteger(raw);
  return value === null || value < 1 ? null : value;
}

/** Tick 0 is the first tick of the demo and is a real address. */
function readTick(raw: string | null): number | null {
  const value = readInteger(raw);
  return value === null || value < 0 ? null : value;
}

function readInteger(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  // `Number('')` is 0 and `Number('12abc')` is NaN; only a whole decimal
  // number is accepted, so neither slips through as a selection.
  if (!/^-?\d+$/u.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

function readIdentifier(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/* ── writing ─────────────────────────────────────────────────────────────── */

/**
 * The context as a query string. Absent selections are omitted rather than
 * written empty, so 「概览，什么都没选」 is `?view=overview` and not four empty
 * parameters that make the address look busier than the state is.
 *
 * `view` is always written, including the default: the address bar is the thing
 * users copy, and a link that omits the view silently depends on the default
 * never changing.
 */
export function writeWorkspaceContext(context: MatchWorkspaceContext): URLSearchParams {
  const params = new URLSearchParams();
  params.set(MATCH_PARAM.view, context.view);
  if (context.round !== null) params.set(MATCH_PARAM.round, String(context.round));
  if (context.player !== null) params.set(MATCH_PARAM.player, context.player);
  if (context.tick !== null) params.set(MATCH_PARAM.tick, String(context.tick));
  if (context.evidence !== null) params.set(MATCH_PARAM.evidence, context.evidence);
  return params;
}

/**
 * Applies a patch, enforcing the one invariant the three selections have:
 * moving to a different round drops a tick and an evidence id the patch did not
 * itself supply. See the header for why.
 *
 * Selecting the round that is already selected changes nothing — re-clicking
 * the current round must not throw the playhead away.
 */
export function patchWorkspaceContext(
  context: MatchWorkspaceContext,
  patch: MatchContextPatch,
): MatchWorkspaceContext {
  const roundChanged = patch.round !== undefined && patch.round !== context.round;

  return {
    view: patch.view ?? context.view,
    round: patch.round === undefined ? context.round : patch.round,
    player: patch.player === undefined ? context.player : patch.player,
    tick: patch.tick === undefined ? (roundChanged ? null : context.tick) : patch.tick,
    evidence:
      patch.evidence === undefined ? (roundChanged ? null : context.evidence) : patch.evidence,
  };
}

/**
 * A shareable address for a workspace state — what the command palette, the
 * Agent's 「定位」 and a crumb all need.
 *
 * The demo id is encoded because §7 made it a path segment and ids come from
 * the file system.
 */
export function matchWorkspaceHref(demoId: string, context: MatchWorkspaceContext): string {
  return `/match/${encodeURIComponent(demoId)}?${writeWorkspaceContext(context).toString()}`;
}
