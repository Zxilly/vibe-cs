/**
 * data layer — §4.5.4, the 5-second merge window for manual plan edits.
 *
 * 「5 秒内的连续编辑合并成一条，避免刷屏」. The merging has to happen on the
 * client because the intermediate states only exist here: dragging a shot
 * handle or holding the arrow key on a duration field produces dozens of
 * values, and the backend sees none of them.
 *
 * ## What one flush actually calls
 *
 * `applyAgentPlanEdit` — and nothing else. §10 deviation 5 settled it: the
 * merged `changes` array *is* the `workspace_edit` notice, and the notice is
 * written in the same transaction that stores the shots and bumps the revision
 * (see `data/plans.ts`). There is no separate notify command, and looking for
 * one would re-open the question of who owns the revision number, which §4.6
 * gap 6 says must be the server.
 *
 * That has a consequence worth stating plainly, because the plan panel has to
 * live with it: **between two flushes the plan on screen is ahead of the
 * server.** The panel holds the edited shots locally, the revision does not
 * move, and proposals do not go stale until the flush lands. This is the honest
 * arrangement — the alternative, one PATCH per keystroke, would bump the
 * revision dozens of times and expire the Agent's proposals mid-drag.
 *
 * ## The flush occasions
 *
 * 「漏掉任何一个都会丢通知」. `EDIT_FLUSH_REASONS` is the whole list, each with
 * a test:
 *
 *   `window`         the 5 seconds elapsed
 *   `send-message`   before the user's next message reaches the Agent, so the
 *                    model reads the edit before the question about it
 *   `switch-session` the notice belongs to the session it was made in
 *   `switch-plan`    likewise for the object; a pending buffer is never carried
 *                    from one plan to another
 *   `restore`        「还原为 Agent 版本」 replaces the whole array, so the
 *                    buffered notice must land first — and be readable as what
 *                    it was: borrowing `switch-plan` for it put a reason in the
 *                    log that names something that did not happen
 *   `leave-page`     `pagehide` — navigating away inside the shell
 *   `unmount`        the component tree goes away
 *   `confirm-video`  before 「确认并生成视频」, so the recording is planned from
 *                    what the user last saw
 *   `before-unload`  the window closes
 *
 * ## Two halves, so the timing is testable
 *
 * `mergeEditChanges` and `createEditNotifier` are framework-free and take an
 * injected scheduler, so `editNotifier.test.ts` drives the window by hand in
 * the `unit` project and never sleeps five real seconds.
 * `useEditNotifier` is the thin React wrapper that owns the listeners.
 *
 * ## One instance per page
 *
 * The occasions above span all three blocks of `/agent` — the composer sends,
 * the plan panel edits, the drawer switches sessions. Three instances would
 * each hold a partial buffer and flush a partial notice, so the page shell owns
 * exactly one and passes it down (`pages/agent/agentContract.ts`).
 */

import { useCallback, useEffect, useRef } from 'react';

import type { AgentPlanShot, WorkspaceEditChange } from '../shared/desktop/dto';

/** §4.5.4's window. Exported so the settings copy and the tests share it. */
export const EDIT_MERGE_WINDOW_MS = 5_000;

export type EditFlushReason =
  | 'window'
  | 'send-message'
  | 'switch-session'
  | 'switch-plan'
  | 'restore'
  | 'leave-page'
  | 'unmount'
  | 'confirm-video'
  | 'before-unload';

/** The complete list, walked by the tests so a new occasion cannot be added
 *  without one. */
export const EDIT_FLUSH_REASONS: readonly EditFlushReason[] = [
  'window',
  'send-message',
  'switch-session',
  'switch-plan',
  'restore',
  'leave-page',
  'unmount',
  'confirm-video',
  'before-unload',
];

/**
 * One edit the user just made.
 *
 * `shots` is the **whole plan after this edit**, not a delta: `AgentPlanEdit`
 * takes the full array, so the notifier keeps the latest snapshot rather than
 * trying to replay diffs onto a plan it does not own.
 */
export interface PlanEditRecord {
  readonly planId: string;
  readonly change: WorkspaceEditChange;
  readonly shots: readonly AgentPlanShot[];
  /** 「起手那段留给建立镜头交代」 — the user's own note, if the field was used. */
  readonly note?: string | null;
  readonly proposalBaseRevision?: number | null | undefined;
}

/** What a flush hands to `commit`. */
export interface PendingPlanEdit {
  readonly planId: string;
  readonly changes: readonly WorkspaceEditChange[];
  readonly shots: readonly AgentPlanShot[];
  readonly note: string | null;
  readonly proposalBaseRevision: number | null;
  /** When the window opened, for a panel that wants to show 「5 秒后通知」. */
  readonly openedAt: number;
}

/**
 * Merges one edit into the buffer.
 *
 * Dedupe key is `shot + field`, exactly as §4.5.4 says. For a repeated key the
 * result keeps **the first `from` and the last `to`** — the user dragged 8.5 →
 * 6.0 → 5.0 and the Agent should read 8.5 → 5.0, not three lines. The `op` of
 * the newest edit wins, because it describes what the field ended up being.
 *
 * A field dragged back to where it started collapses to nothing: a change whose
 * `from` equals its `to` is dropped, because telling the Agent 「你把 8.5s 改成了
 * 8.5s」 is noise it would answer. A removal, an insertion and a restore carry no
 * from/to pair, so they are always real events and never collapse.
 */
export function mergeEditChanges(
  existing: readonly WorkspaceEditChange[],
  incoming: WorkspaceEditChange,
): WorkspaceEditChange[] {
  const key = changeKey(incoming);
  const index = existing.findIndex((change) => changeKey(change) === key);

  if (index === -1) {
    return isNoOp(incoming) ? [...existing] : [...existing, incoming];
  }

  const merged: WorkspaceEditChange = {
    ...incoming,
    // The first `from` in the window is the value the Agent last knew about.
    from: existing[index]?.from ?? incoming.from,
  };

  const next = [...existing];
  if (isNoOp(merged)) {
    next.splice(index, 1);
    return next;
  }
  next[index] = merged;
  return next;
}

/**
 * §4.5.4's key: **shot and field, not op.** Editing a duration and then
 * restoring it is one line about that field, while a removal carries
 * `field: null` and so never collides with an edit to one of that shot's
 * fields.
 */
function changeKey(change: WorkspaceEditChange): string {
  return `${String(change.shot)} ${change.field ?? ''}`;
}

/**
 * A field that ends the window where it started. The `from`/`to` pair is the
 * whole test — a removal, an insertion and a restore of a deleted shot all
 * carry `null` on at least one side and therefore can never be mistaken for a
 * round trip, whatever their op says.
 */
function isNoOp(change: WorkspaceEditChange): boolean {
  return change.from !== null && change.to !== null && change.from === change.to;
}

/* ── the notifier ────────────────────────────────────────────────────────── */

/**
 * The two timing primitives, injected so tests drive them. Defaults to the
 * globals; `now` only feeds `PendingPlanEdit.openedAt`.
 */
export interface EditNotifierScheduler {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

export interface EditNotifierOptions {
  /**
   * Writes the merged edit. In the app this is
   * `useApplyAgentPlanEdit().mutateAsync` wrapped with the plan's
   * `expected_revision`, status and origin — all four of which belong to the
   * panel that holds the plan, not to a buffer.
   */
  commit: (pending: PendingPlanEdit, reason: EditFlushReason) => Promise<unknown> | unknown;
  /**
   * A failed commit. The pending edit is handed back **and is not re-queued**:
   * a 409 means the plan moved, and retrying with the same
   * `expected_revision` would loop forever. The panel decides — that is what
   * the artboard's 「基于修订 7 重算 / 逐条查看 / 全部丢弃」 dialog is for.
   */
  onError?: (error: unknown, pending: PendingPlanEdit, reason: EditFlushReason) => void;
  windowMs?: number;
  scheduler?: EditNotifierScheduler;
}

export interface EditNotifier {
  /** Buffers one edit and (re)opens the window. */
  record: (edit: PlanEditRecord) => void;
  /** Writes the buffer now. Resolves when the commit settles; a no-op when the
   *  buffer is empty, so every call site may call it unconditionally. */
  flush: (reason: EditFlushReason) => Promise<void>;
  /** What would be written right now, or `null`. Read-only. */
  peek: () => PendingPlanEdit | null;
  /** Cancels the timer. Does **not** flush — callers flush explicitly first, so
   *  that a disposal can never be mistaken for a silent write. */
  dispose: () => void;
}

const DEFAULT_SCHEDULER: EditNotifierScheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  now: () => Date.now(),
};

export function createEditNotifier(options: EditNotifierOptions): EditNotifier {
  const scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  const windowMs = options.windowMs ?? EDIT_MERGE_WINDOW_MS;

  let buffer: PendingPlanEdit | null = null;
  let handle: unknown = null;

  const clearWindow = () => {
    if (handle === null) return;
    scheduler.clearTimeout(handle);
    handle = null;
  };

  const flush = async (reason: EditFlushReason): Promise<void> => {
    clearWindow();
    const pending = buffer;
    buffer = null;
    // An empty buffer is the common case (nothing was edited), and a buffer
    // whose changes all collapsed is the honest second case: no notice.
    if (pending === null || pending.changes.length === 0) return;

    try {
      await options.commit(pending, reason);
    } catch (error) {
      options.onError?.(error, pending, reason);
    }
  };

  const record = (edit: PlanEditRecord) => {
    // A pending buffer never crosses plans: the notice names one object.
    if (buffer !== null && buffer.planId !== edit.planId) void flush('switch-plan');

    const previous = buffer;
    buffer = {
      planId: edit.planId,
      changes: mergeEditChanges(previous?.changes ?? [], edit.change),
      shots: edit.shots,
      note: edit.note ?? previous?.note ?? null,
      proposalBaseRevision:
        edit.proposalBaseRevision ?? previous?.proposalBaseRevision ?? null,
      openedAt: previous?.openedAt ?? scheduler.now(),
    };

    // The window is measured from the *first* edit, not the last: a user who
    // keeps nudging a value for a minute must still be reported within five
    // seconds, which a sliding window would never do.
    if (handle === null) {
      handle = scheduler.setTimeout(() => {
        handle = null;
        void flush('window');
      }, windowMs);
    }
  };

  return {
    record,
    flush,
    peek: () => buffer,
    dispose: clearWindow,
  };
}

/* ── the React wrapper ───────────────────────────────────────────────────── */

export interface UseEditNotifierOptions extends EditNotifierOptions {
  /** Flushed before the selection moves — the notice belongs to this session. */
  readonly sessionId: string | null;
  /** Likewise for the plan. */
  readonly planId: string | null;
}

export interface EditNotifierHandle {
  readonly record: (edit: PlanEditRecord) => void;
  readonly flush: (reason: EditFlushReason) => Promise<void>;
  readonly peek: () => PendingPlanEdit | null;
}

/**
 * One notifier for the page, with the four occasions nobody can call by hand
 * already wired: `beforeunload`, `pagehide`, a session change, a plan change,
 * and unmount. The two explicit ones — `send-message` and `confirm-video` —
 * are the caller's, because only the composer and the confirm button know when
 * they are about to happen.
 */
export function useEditNotifier(options: UseEditNotifierOptions): EditNotifierHandle {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const notifierRef = useRef<EditNotifier | null>(null);
  notifierRef.current ??= createEditNotifier({
    commit: (pending, reason) => optionsRef.current.commit(pending, reason),
    onError: (error, pending, reason) =>
      optionsRef.current.onError?.(error, pending, reason),
    ...(options.windowMs === undefined ? {} : { windowMs: options.windowMs }),
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
  });
  const notifier = notifierRef.current;

  const { sessionId, planId } = options;

  /* The window closing, and navigation inside the shell. `pagehide` rather than
     `unload`: it is the event a webview actually fires on navigation, and it
     still fires when the page is being discarded. */
  useEffect(() => {
    const onBeforeUnload = () => void notifier.flush('before-unload');
    const onPageHide = () => void notifier.flush('leave-page');
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [notifier]);

  /* Switching the session or the plan flushes what was buffered for the old
     one. Written as a comparison in the effect *body* rather than as a cleanup:
     a cleanup also runs at unmount, which would report a plain unmount as a
     session switch and make the reason meaningless in the one place that most
     needs to be readable — a lost notice is diagnosed by its reason.
     The buffer carries its own `planId`, so flushing after the id has already
     changed still names the right object. When both change at once this reports
     the session, which is the outer of the two selections. */
  const selectionRef = useRef({ sessionId, planId });
  useEffect(() => {
    const previous = selectionRef.current;
    selectionRef.current = { sessionId, planId };
    if (previous.sessionId !== sessionId) {
      void notifier.flush('switch-session');
    } else if (previous.planId !== planId) {
      void notifier.flush('switch-plan');
    }
  }, [notifier, planId, sessionId]);

  useEffect(
    () => () => {
      void notifier.flush('unmount');
      notifier.dispose();
    },
    [notifier],
  );

  const record = useCallback((edit: PlanEditRecord) => notifier.record(edit), [notifier]);
  const flush = useCallback(
    (reason: EditFlushReason) => notifier.flush(reason),
    [notifier],
  );
  const peek = useCallback(() => notifier.peek(), [notifier]);

  return { record, flush, peek };
}
