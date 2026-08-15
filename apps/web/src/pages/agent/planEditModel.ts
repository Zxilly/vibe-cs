/*
 * pages/agent — the manual edit, as arithmetic (§4.5.3 rule ②, §4.5.4).
 *
 * Everything the plan panel does to a shot lives here, as pure functions over
 * `AgentPlanShot[]`, so the rules can be pinned in the `unit` project without a
 * DOM, a router or a query client.
 *
 * ── The three things this file exists to keep true ────────────────────────
 *
 * **1. A manual edit is never pending approval.** There is no `approved` flag,
 * no `proposed` shot and no reviewer anywhere below. An edit produces a new
 * `AgentPlanShot` whose `source` is `'user'` and that is the whole of it — the
 * badge the reader sees is `AGENT_PLAN_AUTHOR.user.sourceBadge` (「你改过」), and
 * §4.5.3 ② is kept by there being nothing else to render.
 *
 * **2. A delete is a soft delete.** `removed_by: 'user'` and the shot keeps its
 * place, its number and its text; `restoreShot` puts it back. The artboard draws
 * it as a dashed card with 「撤销删除」 for exactly this reason: a soft delete you
 * cannot undo is a delete.
 *
 * **3. The whole array travels.** `AgentPlanEdit.shots` is the entire plan, so
 * every function here returns the full array rather than a delta. That is also
 * why `params` (typed `unknown` on the wire) is carried through by spreading the
 * shot instead of rebuilding it field by field — a rebuild is where an unknown
 * payload gets silently dropped.
 *
 * ── What a change line says ──────────────────────────────────────────────
 *
 * `WorkspaceEditChange.field` is free text on the wire, and the notice is read
 * by a model. So the field names here are the **dto's own** (`duration_seconds`,
 * `start_tick`), not the artboard's prose abbreviation (`duration`): the model
 * that reads the notice is the one that will later be asked about
 * `AgentPlanShot`, and one spelling for one field is worth more than matching a
 * mock-up's shorthand.
 *
 * `from` / `to` are the *rendered* values (「8.5s」 → 「5.0s」, 「Dolly」 →
 * 「Tracking」), because the notice is prose for a reader as much as a record —
 * that much the artboard does settle. The two enum labels cannot be produced
 * from a pure module (they are `MessageDescriptor`s), so they arrive through
 * `ShotLabelSource`; the panel passes `i18n._`.
 *
 * ── One decision that is a backend gap, not a choice ─────────────────────
 *
 * 时长 and the tick range are edited **independently**, because `AgentPlan`
 * carries no tick rate and nothing here may invent one. The artboard's edit
 * dialog shows a duration change and an end-tick change together; a client that
 * derived one from the other would be guessing at 64 vs 128 tick and writing the
 * guess into the plan. Reported in the panel's blockers.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

import { AGENT_PLAN_AUTHOR, formatShotDuration, formatTickCount } from '../../domain/agent';
import type { AgentShotKind } from '../../domain/agent';
import type {
  AgentPlanShot,
  AgentShotView,
  WorkspaceEditChange,
} from '../../shared/desktop/dto';

/* ── the draft ───────────────────────────────────────────────────────────── */

/**
 * The editable fields, in the order the artboard's dialog lays them out.
 *
 * `note` is on the list but is not a shot field: it becomes `AgentPlanEdit.note`
 * — the artboard's 「起手那段留给建立镜头交代」, which appears in the notice's
 * JSON and nowhere in the plan. It therefore never produces a change line.
 */
export const SHOT_DRAFT_FIELDS = [
  'title',
  'kind',
  'view',
  'duration',
  'startTick',
  'endTick',
  'rationale',
] as const;

export type ShotDraftField = (typeof SHOT_DRAFT_FIELDS)[number];

/**
 * The dto field each draft field writes, which is also what the notice calls it.
 * A total `Record`, so a new draft field cannot be added without naming the
 * column it edits.
 */
export const SHOT_WIRE_FIELD: Readonly<Record<ShotDraftField, string>> = {
  title: 'title',
  kind: 'kind',
  view: 'view',
  duration: 'duration_seconds',
  startTick: 'start_tick',
  endTick: 'end_tick',
  rationale: 'rationale',
};

/**
 * A shot being edited. Numbers are held as **strings**: an input that reformats
 * 「5.」 into 「5」 while the user is still typing the decimal is an input that
 * cannot be typed into. Parsing and validation happen at the edges.
 */
export interface ShotDraft {
  readonly title: string;
  readonly kind: AgentShotKind;
  readonly view: AgentShotView;
  readonly duration: string;
  readonly startTick: string;
  readonly endTick: string;
  readonly rationale: string;
  /** 「说明 · 会一起发给 Agent」 → `AgentPlanEdit.note`. Not a shot field. */
  readonly note: string;
}

export function readShotDraft(shot: AgentPlanShot): ShotDraft {
  return {
    title: shot.title,
    kind: shot.kind,
    view: shot.view,
    duration: formatNumberInput(shot.duration_seconds),
    startTick: String(shot.start_tick),
    endTick: String(shot.end_tick),
    rationale: shot.rationale,
    note: '',
  };
}

/** `5` rather than `5.0` — the field is for typing in, not for reading off. */
function formatNumberInput(value: number): string {
  return Number.isFinite(value) ? String(value) : '';
}

/* ── validation ──────────────────────────────────────────────────────────── */

export type ShotDraftErrors = Partial<Record<ShotDraftField, MessageDescriptor>>;

/**
 * What is wrong with the draft, per field.
 *
 * Deliberately narrow: it rejects only what the *wire* cannot hold (a title the
 * plan cannot show, a negative length, a tick that is not a whole number, a
 * range that runs backwards). It does not police whether a 0.2-second shot is a
 * good idea — that is the user's judgement, and §4.5.3 ② means nothing here gets
 * to overrule it.
 */
export function validateShotDraft(draft: ShotDraft): ShotDraftErrors {
  const errors: Record<string, MessageDescriptor> = {};

  if (draft.title.trim() === '') errors['title'] = msg`镜头需要一个标题`;

  const duration = readNumber(draft.duration);
  if (duration === null || duration < 0) {
    errors['duration'] = msg`时长要写成一个不小于 0 的秒数`;
  }

  const startTick = readInteger(draft.startTick);
  if (startTick === null || startTick < 0) {
    errors['startTick'] = msg`起始 tick 要写成一个不小于 0 的整数`;
  }

  const endTick = readInteger(draft.endTick);
  if (endTick === null || endTick < 0) {
    errors['endTick'] = msg`结束 tick 要写成一个不小于 0 的整数`;
  } else if (startTick !== null && endTick < startTick) {
    errors['endTick'] = msg`结束 tick 不能早于起始 tick`;
  }

  return errors;
}

export function draftIsValid(draft: ShotDraft): boolean {
  return Object.keys(validateShotDraft(draft)).length === 0;
}

/**
 * Accepts `'5'`, `'5.'`, `'  5.5 '`; rejects `''`, `'abc'`, `'5px'`, `'NaN'`.
 * `Number('')` is `0`, which is why the empty string is checked first.
 */
function readNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function readInteger(raw: string): number | null {
  const value = readNumber(raw);
  return value === null || !Number.isInteger(value) ? null : value;
}

/* ── applying a draft ────────────────────────────────────────────────────── */

/**
 * The shot the draft describes.
 *
 * `source: 'user'` is the only status this ever writes. Spread-then-override so
 * `params`, `evidence_refs`, `risks` and `removed_by` survive untouched — an
 * edit to the duration must not quietly clear the risk the Agent attached.
 *
 * Returns `null` for an invalid draft rather than writing a `NaN` into the plan.
 */
export function applyShotDraft(shot: AgentPlanShot, draft: ShotDraft): AgentPlanShot | null {
  if (!draftIsValid(draft)) return null;

  const duration = readNumber(draft.duration);
  const startTick = readInteger(draft.startTick);
  const endTick = readInteger(draft.endTick);
  if (duration === null || startTick === null || endTick === null) return null;

  return {
    ...shot,
    title: draft.title.trim(),
    kind: draft.kind,
    view: draft.view,
    duration_seconds: duration,
    start_tick: startTick,
    end_tick: endTick,
    rationale: draft.rationale,
    source: 'user',
  };
}

/* ── the change lines ────────────────────────────────────────────────────── */

/**
 * How the two enum values are spelled in the notice. The panel passes
 * `i18n._`-backed readers; a test passes the identity of its own choosing.
 */
export interface ShotLabelSource {
  readonly kind: (kind: AgentShotKind) => string;
  readonly view: (view: AgentShotView) => string;
}

/**
 * One `WorkspaceEditChange` per field the draft actually moved.
 *
 * Numbers are compared **parsed**, so retyping 「8.50」 over 「8.5」 produces no
 * line: `data/editNotifier.ts` already drops a round trip inside its window, and
 * this drops a non-edit before it ever gets there. Both matter — telling the
 * Agent 「你把 8.5s 改成了 8.5s」 is noise it will answer.
 *
 * `shot` is the one-based position, which is what the strip, the shot cards and
 * the artboard's JSON all use to name a shot.
 */
export function draftChanges(
  shot: AgentPlanShot,
  draft: ShotDraft,
  position: number,
  labels: ShotLabelSource,
): WorkspaceEditChange[] {
  const changes: WorkspaceEditChange[] = [];

  const push = (field: ShotDraftField, from: string, to: string) => {
    changes.push({ shot: position, op: 'updated', field: SHOT_WIRE_FIELD[field], from, to });
  };

  const title = draft.title.trim();
  if (title !== shot.title) push('title', shot.title, title);

  if (draft.kind !== shot.kind) push('kind', labels.kind(shot.kind), labels.kind(draft.kind));

  if (draft.view !== shot.view) push('view', labels.view(shot.view), labels.view(draft.view));

  const duration = readNumber(draft.duration);
  if (duration !== null && duration !== shot.duration_seconds) {
    push('duration', formatShotDuration(shot.duration_seconds), formatShotDuration(duration));
  }

  const startTick = readInteger(draft.startTick);
  if (startTick !== null && startTick !== shot.start_tick) {
    push('startTick', formatTickCount(shot.start_tick), formatTickCount(startTick));
  }

  const endTick = readInteger(draft.endTick);
  if (endTick !== null && endTick !== shot.end_tick) {
    push('endTick', formatTickCount(shot.end_tick), formatTickCount(endTick));
  }

  if (draft.rationale !== shot.rationale) push('rationale', shot.rationale, draft.rationale);

  return changes;
}

/* ── the list operations ─────────────────────────────────────────────────── */

/** One edit: the plan as it now stands, plus the lines that describe the move. */
export interface ShotEditResult {
  readonly shots: readonly AgentPlanShot[];
  readonly changes: readonly WorkspaceEditChange[];
}

/**
 * The shot's one-based number, counting **removed shots too**.
 *
 * The artboard keeps 04 numbered 04 after it is deleted, and the strip keeps its
 * width; renumbering on delete would silently rewrite what 「镜头 02」 refers to
 * in every notice already sitting in the session.
 */
export function shotPosition(shots: readonly AgentPlanShot[], shotId: string): number {
  const index = shots.findIndex((shot) => shot.id === shotId);
  return index === -1 ? 0 : index + 1;
}

/** Replaces one shot by id. Returns the same array when the id is not there. */
export function replaceShot(
  shots: readonly AgentPlanShot[],
  next: AgentPlanShot,
): readonly AgentPlanShot[] {
  const index = shots.findIndex((shot) => shot.id === next.id);
  if (index === -1) return shots;
  const result = [...shots];
  result[index] = next;
  return result;
}

/**
 * Saves a draft over a shot. `null` when the draft is invalid, when the id is
 * unknown, or when **nothing actually changed** — a save that moved nothing must
 * not open a notification window, or every 放弃-by-way-of-保存 would reach the
 * Agent as an edit.
 */
export function saveShotDraft(
  shots: readonly AgentPlanShot[],
  shotId: string,
  draft: ShotDraft,
  labels: ShotLabelSource,
): ShotEditResult | null {
  const shot = shots.find((candidate) => candidate.id === shotId);
  if (shot === undefined) return null;

  const position = shotPosition(shots, shotId);
  const changes = draftChanges(shot, draft, position, labels);
  if (changes.length === 0) return null;

  const next = applyShotDraft(shot, draft);
  if (next === null) return null;

  return { shots: replaceShot(shots, next), changes };
}

/**
 * The soft delete. `removed_by: 'user'`, everything else untouched, so the card
 * stays readable and 「撤销删除」 has something to restore.
 *
 * `null` when the shot is unknown or already removed — pressing 删除 twice is
 * one delete, not two notices.
 */
export function removeShot(shots: readonly AgentPlanShot[], shotId: string): ShotEditResult | null {
  const shot = shots.find((candidate) => candidate.id === shotId);
  if (shot === undefined || shot.removed_by !== null) return null;

  const next: AgentPlanShot = { ...shot, removed_by: 'user' };
  return {
    shots: replaceShot(shots, next),
    /* A removal names no field: `data/editNotifier.ts` keys its merge window on
       `shot + field`, and a `null` field is what keeps a delete from colliding
       with an edit to one of that shot's fields. */
    changes: [{ shot: shotPosition(shots, shotId), op: 'removed', field: null, from: null, to: null }],
  };
}

/** 「撤销删除」. `null` when the shot is unknown or was not removed. */
export function restoreShot(shots: readonly AgentPlanShot[], shotId: string): ShotEditResult | null {
  const shot = shots.find((candidate) => candidate.id === shotId);
  if (shot === undefined || shot.removed_by === null) return null;

  const next: AgentPlanShot = { ...shot, removed_by: null };
  return {
    shots: replaceShot(shots, next),
    changes: [{ shot: shotPosition(shots, shotId), op: 'restored', field: null, from: null, to: null }],
  };
}

/* ── what the head counts ────────────────────────────────────────────────── */

/**
 * 「你改过 2 处」 — how many shots carry the user's hand, whether that hand
 * edited them or removed them.
 *
 * Counted over shots rather than over edits, because the count is a property of
 * the plan on screen: it survives a reload, while a tally of edits would not.
 */
export function userTouchedCount(shots: readonly AgentPlanShot[]): number {
  return shots.filter((shot) => shot.source === 'user' || shot.removed_by === 'user').length;
}

/** Whether anything on screen differs from what the Agent produced. */
export function planHasUserEdits(shots: readonly AgentPlanShot[]): boolean {
  return userTouchedCount(shots) > 0;
}

/**
 * The badge a shot's source gets. Re-exported through a function rather than
 * inlined at the call sites so 「你改过」 has one origin, which is what makes
 * 「never 待批准」 checkable by reading one table.
 */
export function shotSourceBadge(shot: AgentPlanShot): MessageDescriptor {
  return AGENT_PLAN_AUTHOR[shot.source].sourceBadge;
}
