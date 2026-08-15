/*
 * pages/agent — the pure half of the 会话抽屉 and of 新建会话与引用
 * (spec §4.5.1, artboard 「补齐 · Agent 会话历史与设置」).
 *
 * No React, no i18n runtime, no `Date.now()`, so `sessionDrawerModel.test.ts`
 * exhausts it in the `unit` project. The four things it decides are the four
 * that would otherwise be re-derived in three components:
 *
 *   1. what the search box sends to the server, and what it does *not* send
 *   2. which four lists 「工作区里正在进行的」 is made of, and in what order
 *   3. which objects a session already references, keyed once
 *   4. where a reference chip goes when you click it
 *
 * ── 1. The search is the server's, not a filter over a page ───────────────
 *
 * `AgentSessionQuery.q` matches 「会话标题与对话正文」 on the wire and the
 * artboard's placeholder says 「搜索会话、Demo 或选手」, which is more than a
 * loaded page of `AgentSessionSummary` can answer: the summary carries no demo
 * and no player (see the gap note in `AgentSessionRow`), and the conversation
 * text is not in the list payload at all. Filtering the fetched page on the
 * client would therefore return *fewer* rows than the backend can, and would
 * quietly redefine what the box searches. So `q` always travels, and
 * `total` printed in the header is the server's count rather than
 * `items.length` — a limited page must not shrink 「共 14 条」.
 *
 * ── 4. Where a chip goes ──────────────────────────────────────────────────
 *
 * `AgentObjectKind` has four members and §7 has a route for three of them. A
 * plan is not a route at all: it is `?plan=` on the page you are already on,
 * which is why the destination is a union rather than a string — the drawer
 * has to know the difference between 「换一个方案」 (an `updateContext` patch,
 * no unmount, the session stays selected) and 「离开这一页」.
 *
 * The fourth, `output`, resolves to the 输出 list rather than to the file:
 * §7 gives `/delivery` only `?view=outputs|tasks` and no per-output address.
 * The list is the closest addressable place, and inventing `?output=` here
 * would put a parameter in the product that the route table does not have.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

import type {
  AgentObjectKind,
  AgentObjectRef,
  AgentObjectRefTouch,
  AgentSessionQuery,
  AgentWorkspaceReference,
  AgentWorkspaceReferences,
} from '../../shared/desktop/dto';

/* ── the search ──────────────────────────────────────────────────────────── */

/**
 * How many rows the drawer asks for. The header still prints the server's
 * `total`, so a workspace with more sessions than this says 「共 N 条」 with N
 * larger than the list — which is the honest reading of a first page, and the
 * reason the number and the rows come from two different fields.
 */
export const SESSION_LIST_LIMIT = 50;

/**
 * Milliseconds of quiet before a keystroke becomes a request. A query key that
 * changed on every keystroke would issue — and cache — one request per
 * character, and TanStack would keep every one of those pages alive.
 */
export const SESSION_SEARCH_DEBOUNCE_MS = 250;

/**
 * The query for a search term. An empty or whitespace-only box omits `q`
 * entirely rather than sending `''`: the two are the same list, and one key
 * for one list keeps the drawer from refetching when the user clears the box.
 */
export function sessionSearchQuery(term: string, limit: number = SESSION_LIST_LIMIT): AgentSessionQuery {
  const trimmed = term.trim();
  return trimmed === '' ? { limit } : { q: trimmed, limit };
}

/* ── 「工作区里正在进行的」 ─────────────────────────────────────────────── */

export type WorkspaceReferenceGroupId = keyof AgentWorkspaceReferences;

export interface WorkspaceReferenceGroupMeta {
  readonly id: WorkspaceReferenceGroupId;
  readonly label: MessageDescriptor;
  /**
   * The artboard paints exactly one row accent — the 等待确认 plan it is about
   * to take over (「这条会话现在可以改它，不需要重新生成」). That is a property
   * of the group, not of a row, so it is declared once here.
   */
  readonly emphasis: boolean;
}

/**
 * The four lists, in the artboard's own order: the plan you are about to take
 * over, then what is running, then what is saved, then what failed.
 *
 * `AgentWorkspaceReferences` has exactly these four fields, so the table is
 * total by construction and `sessionDrawerModel.test.ts` proves it against the
 * type.
 */
export const WORKSPACE_REFERENCE_GROUPS: readonly WorkspaceReferenceGroupMeta[] = [
  { id: 'pending_plans', label: msg`等待确认的方案`, emphasis: true },
  { id: 'running_recording_tasks', label: msg`正在跑的录制任务`, emphasis: false },
  { id: 'edit_projects', label: msg`剪辑工程`, emphasis: false },
  { id: 'failed_outputs', label: msg`失败的导出`, emphasis: false },
];

export interface WorkspaceReferenceGroup extends WorkspaceReferenceGroupMeta {
  readonly items: readonly AgentWorkspaceReference[];
}

/**
 * The groups that have something in them. An empty group is dropped rather
 * than drawn with a 「0」 — 「后端没有的字段一律省略，不要渲染 0 或空行」 applies
 * to a heading with nothing under it just as much as to a field.
 */
export function workspaceReferenceGroups(
  references: AgentWorkspaceReferences | undefined,
): readonly WorkspaceReferenceGroup[] {
  if (references === undefined) return [];

  const groups: WorkspaceReferenceGroup[] = [];
  for (const meta of WORKSPACE_REFERENCE_GROUPS) {
    const items = references[meta.id];
    if (items.length > 0) groups.push({ ...meta, items });
  }
  return groups;
}

/** How many objects the picker can offer. `0` is the sheet's empty state. */
export function workspaceReferenceCount(references: AgentWorkspaceReferences | undefined): number {
  if (references === undefined) return 0;
  return WORKSPACE_REFERENCE_GROUPS.reduce((total, meta) => total + references[meta.id].length, 0);
}

/* ── which objects are already referenced ────────────────────────────────── */

/**
 * `kind` and `id` together, because ids are only unique per kind on the wire
 * (`AgentObjectLocator` is the pair, not the id alone).
 */
export function objectRefKey(kind: AgentObjectKind, id: string): string {
  return `${kind}:${id}`;
}

/** The keys a session already holds, for 「已引用 ✓」. */
export function referencedKeys(refs: readonly AgentObjectRef[]): ReadonlySet<string> {
  return new Set(refs.map((ref) => objectRefKey(ref.kind, ref.id)));
}

/**
 * One picker row as the touch the server stores.
 *
 * `summary` is injected rather than composed here: `AgentWorkspaceReference`
 * carries no summary of its own, `AgentObjectRefTouch.summary` is not nullable,
 * and this module holds no copy. The caller passes the one sentence it writes
 * through a Lingui macro, so the string that reaches the database is authored
 * in one place and translated like everything else.
 */
export function toObjectRefTouch(
  reference: AgentWorkspaceReference,
  summary: string,
): AgentObjectRefTouch {
  return {
    kind: reference.kind,
    id: reference.id,
    label: reference.label,
    summary,
    // The server's own status sentence, carried through unchanged — it is free
    // text on both types (contract gap 9) and re-wording it here would make the
    // stored reference disagree with the row the user clicked.
    status: reference.status,
  };
}

/**
 * The plan a brand-new session should take over, given what the user picked.
 *
 * 「新建一条会话不会丢掉上下文……它可以直接接管当前那个」: picking a plan in the
 * sheet is what makes the new session's `?plan=` that plan. Groups are walked in
 * `WORKSPACE_REFERENCE_GROUPS` order, and 等待确认的方案 is the first of them, so
 * 「the first plan the user picked, as the list draws it」 needs no second
 * ordering rule. `null` when nothing picked is a plan — and then the address
 * keeps whatever plan it already had, because a patch clears nothing
 * (`agentContract.ts` invariant 4).
 */
export function selectedPlanId(
  references: AgentWorkspaceReferences | undefined,
  selection: ReadonlySet<string>,
): string | null {
  for (const group of workspaceReferenceGroups(references)) {
    for (const item of group.items) {
      if (item.kind !== 'plan') continue;
      if (selection.has(objectRefKey(item.kind, item.id))) return item.id;
    }
  }
  return null;
}

/** Every picked row, in the order the sheet drew them. */
export function selectedReferences(
  references: AgentWorkspaceReferences | undefined,
  selection: ReadonlySet<string>,
): readonly AgentWorkspaceReference[] {
  const picked: AgentWorkspaceReference[] = [];
  for (const group of workspaceReferenceGroups(references)) {
    for (const item of group.items) {
      if (selection.has(objectRefKey(item.kind, item.id))) picked.push(item);
    }
  }
  return picked;
}

/* ── where a reference goes ──────────────────────────────────────────────── */

/**
 * A plan is a patch to this page's address; the other three are routes.
 * See the file header for why `output` lands on the list.
 */
export type AgentObjectDestination =
  | { readonly kind: 'plan'; readonly planId: string }
  | { readonly kind: 'route'; readonly to: string };

export function agentObjectDestination(kind: AgentObjectKind, id: string): AgentObjectDestination {
  switch (kind) {
    case 'plan':
      return { kind: 'plan', planId: id };
    case 'recording_task':
      return { kind: 'route', to: `/delivery/task/${encodeURIComponent(id)}` };
    case 'edit_project':
      return { kind: 'route', to: `/editor/${encodeURIComponent(id)}` };
    default:
      /* §7: `/delivery?view=outputs`. There is no `/delivery/output/:id`, and
         this module does not get to add one. */
      return { kind: 'route', to: '/delivery?view=outputs' };
  }
}
