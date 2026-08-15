/*
 * Domain layer, 2 of 3 — agent/, the text behind 「查看发给 Agent 的内容」.
 *
 * §4.5.2 and the 手动编辑 artboard both insist the edit notice is **typed, not
 * prose**, and the artboard prints its expanded form verbatim:
 *
 *   {
 *     "type": "workspace_edit",
 *     "object": "plan#P-118",
 *     "revision": 7,
 *     "by": "user",
 *     "at": "2026-08-15T09:47:12+08:00",
 *     "changes": [
 *       { "shot": 2, "field": "duration", "from": "8.5s", "to": "5.0s" },
 *       { "shot": 4, "op": "removed" }
 *     ],
 *     "note": "起手那段留给建立镜头交代"
 *   }
 *
 * ── One honest caveat, stated where it can be read ────────────────────────
 *
 * The wire does not carry the string the model was given. `WorkspaceEditNotice`
 * is a typed record, and what this file produces is **that record, serialised
 * here**. Key order and indentation are therefore ours; every value is the
 * server's. Nothing is added: a `field` / `from` / `to` that is `null` is left
 * out of the line rather than printed as `null`, which is the same rule the
 * cards follow, and it is also what makes the second line above 「shot 4,
 * removed」 rather than a row of nulls.
 *
 * If the backend later returns the exact prompt fragment, this function is the
 * one place that changes. Reported as a gap rather than papered over — see the
 * phase report.
 *
 * Pure, and in the `unit` project: this is a serialiser, and a serialiser whose
 * only test is 「the panel looked right」 is a serialiser nobody has read.
 */

import type {
  AgentObjectLocator,
  WorkspaceEditChange,
  WorkspaceEditNotice,
} from '../../shared/desktop/dto';

/** 「plan#P-118」 — how the notice names the object it is about. */
export function workspaceEditObjectLabel(object: AgentObjectLocator): string {
  return `${object.kind}#${object.id}`;
}

/**
 * How many edits the line reports — 「你在方案上做了 2 处改动」.
 *
 * One `WorkspaceEditChange` is one edit, already merged by
 * `data/editNotifier.ts`'s 5-second window (§4.5.4), so this is a length and
 * not a re-count. It exists so the line and the JSON cannot disagree.
 */
export function workspaceEditChangeCount(notice: WorkspaceEditNotice): number {
  return notice.changes.length;
}

/** One change, with its absent fields absent rather than null. */
function changeRecord(change: WorkspaceEditChange): Record<string, unknown> {
  const record: Record<string, unknown> = { shot: change.shot, op: change.op };
  if (change.field !== null) record['field'] = change.field;
  if (change.from !== null) record['from'] = change.from;
  if (change.to !== null) record['to'] = change.to;
  return record;
}

/**
 * The notice as the expanded panel prints it. Two-space indent, the artboard's
 * key order, `note` present only when there is one.
 */
export function formatWorkspaceEditNotice(notice: WorkspaceEditNotice): string {
  const record: Record<string, unknown> = {
    type: 'workspace_edit',
    object: workspaceEditObjectLabel(notice.object),
    revision: notice.revision,
    by: notice.by,
    at: notice.at,
    changes: notice.changes.map(changeRecord),
  };
  if (notice.note !== null) record['note'] = notice.note;

  return JSON.stringify(record, null, 2);
}
