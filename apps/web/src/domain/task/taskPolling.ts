/*
 * pages/delivery — how often a task surface asks the service again.
 *
 * Spec §10.3 deviation 6 left this open on purpose: 「每个 hook 加 pollMs 选项、
 * **默认不轮询**，节奏留给页面——首页两行任务、交付页任务记录、任务详情三处密度
 * 不同，不该由 data 层统一决定。阶段 3a 必须拍数」. This file is that decision.
 *
 * ── Why polling at all ─────────────────────────────────────────────────────
 *
 * §4.7's audit found one streaming command in the whole IPC surface
 * (`agent_chat`); there is no task event channel. A running task therefore
 * changes without anything telling the UI, and §4.1's defaults set no refetch
 * interval. Until an event channel exists, the feed is polled.
 *
 * ── The three numbers ──────────────────────────────────────────────────────
 *
 * Each is one request per interval, over local IPC, against a SQLite-backed
 * service on the same machine. What separates them is how much of the answer is
 * on screen and how closely the user is watching it.
 *
 *   DETAIL  2 s   `/delivery/task/:taskId` is one record with its stage bar and
 *                 its 阶段日志 — the user opened it to watch. The recording
 *                 pipeline's stages are seconds long (「片段 1 采集完成 · 3.0
 *                 秒」 on 「补齐 · 规范与状态」), so a slower interval would skip
 *                 stages entirely and the bar would jump.
 *   FEED    5 s   `/delivery?view=tasks` is up to 50 records (`TASK_RECORD_COUNT`,
 *                 the 「最近 50 条」 retention default). One request either way,
 *                 but nobody reads 50 rows for a stage transition — they read
 *                 them for 完成 / 失败, which arrive whole. 5 s is also the
 *                 cadence the shell already uses for its own background probe
 *                 while it is trying to reconnect (`SERVICE_POLL_OFFLINE_MS`),
 *                 so the two do not beat against each other at odd multiples.
 *   DIGEST  10 s  the workbench's 进行中 rail is two rows on a landing page. It
 *                 is a glance, not a watch; the page it links to is where the
 *                 watching happens.
 *
 * ── Stopping ──────────────────────────────────────────────────────────────
 *
 * All three stop completely when nothing is running. This is implemented, not
 * promised: the numbers below are passed as `pollWhileActiveMs`, and
 * `data/tasks.ts` turns that into an interval **function** which reads the
 * query's own last answer through `feedHasActiveTask` / `activityIsActive`.
 * The moment a response contains nothing in flight the interval becomes
 * `false` and no further request is made. Because the condition is evaluated
 * against the cached answer rather than against a number the page recomputes,
 * the two cannot fall out of step.
 *
 * Nothing is lost by stopping. A task only starts because something in this app
 * started it, and every one of those writes invalidates `qk.tasks.all` (see
 * `data/tasks.ts`), so an idle feed cannot go stale on its own. What an idle
 * feed cannot notice is a task started by *another* window over the same data
 * directory — which is also what §4.7 says has no channel to report it, and a
 * 5 s poll that runs forever would not fix the same problem for the 99 % of the
 * time nothing is running.
 */

/** The workbench's 进行中 rail — a glance. */
export const TASK_POLL_DIGEST_MS = 10_000;

/** 交付 › 任务记录 — up to 50 rows. */
export const TASK_POLL_FEED_MS = 5_000;

/** 任务详情与阶段日志 — one record, watched. */
export const TASK_POLL_DETAIL_MS = 2_000;

/**
 * The three cadences in one table, ordered from the loosest to the tightest.
 * Exported so a test can assert the ordering rather than the numbers: if the
 * digest ever polls faster than the detail page, something has been copied from
 * the wrong constant.
 */
export const TASK_POLL_MS = {
  digest: TASK_POLL_DIGEST_MS,
  feed: TASK_POLL_FEED_MS,
  detail: TASK_POLL_DETAIL_MS,
} as const;
