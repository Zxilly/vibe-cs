/**
 * data layer — Agent plans and the server-authoritative revision
 * (spec §2 `data/plans.ts`, §4.5.1, §4.5.3, §4.5.4).
 *
 * A plan is an §4.5.1 *object*: it has its own lifecycle, it exists outside any
 * session, and it can be operated on with no Agent involved. That is why this
 * file is separate from `sessions.ts` and why the two invalidate each other
 * only in the one direction that has a cause (below).
 *
 * ## One write does four things, and that is the point
 *
 * `applyAgentPlanEdit` (PATCH /api/agent/plans/{id}) is a **conditional** write.
 * In one transaction it:
 *
 *   1. checks `expected_revision` against the stored one — 409 if behind;
 *   2. stores the new `shots`;
 *   3. bumps `revision`, which is what makes every unhandled proposal based on
 *      the old number stale (§4.5.3 rule ③, `domain/agent/planRevision.ts`);
 *   4. appends the `origin` row and writes the `workspace_edit` notice into the
 *      session.
 *
 * §10 deviation 5 settled this: **there is no separate notify route.** Sending
 * the notice on its own would mean choosing a revision number on the client,
 * and a revision the client chose is not authoritative — which is the exact
 * failure §4.6 gap 6 says the frontend cannot paper over. So the edit notifier
 * (`data/editNotifier.ts`) merges its 5-second window into the `changes` array
 * of *this* call and nothing else.
 *
 * A 409 is therefore an ordinary, expected outcome — someone else moved the
 * plan — and `isRevisionConflict` names it so the panel can refetch and replay
 * rather than show a generic failure.
 *
 * ## Invalidation, and the asymmetry with sessions
 *
 * Editing a plan invalidates **both** namespaces:
 *
 *   `qk.plans.detail(id)` / `qk.plans.all`   the shots and the revision moved
 *   `qk.sessions.ofObject('plan', id)`       the plan's 「改动来源」 gained a row
 *   `qk.sessions.all`                        the session gained an entry (the
 *                                            notice) and a ref, and its
 *                                            `updated_at` reordered the drawer
 *
 * Deleting a session invalidates **only** sessions — see `sessions.ts`. The
 * relationship is bidirectional but not symmetric, because 「删除只删对话，它改过
 * 的方案、任务、视频全部留下」.
 *
 * ## What is not here
 *
 * **Nothing that starts a recording.** §4.5.3 rule ① — 「录制只由一次显式确认
 * 启动。接受变更不触发录制，手动编辑不触发录制，切换会话不触发录制」 — is
 * enforced first by omission: this module and `sessions.ts` between them expose
 * no command that can execute a plan. Confirming a plan is a separate action on
 * a separate surface (`executeRecordingPlan`, which is not in `DesktopClient`
 * yet), and `plans.interaction.test.tsx` walks every client method these hooks
 * touch to prove none of them records anything.
 */

import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import type {
  AgentPlanCreate,
  AgentPlanEdit,
  AgentPlanQuery,
  AgentPlanRestore,
  PutAgentCompositionRequest,
} from '../shared/desktop/dto';
import { useDesktopClient } from './desktopClient';
import { toDataError } from './errors';
import { qk } from './keys';
import { resolveQueryTuning, type DataQueryTuning } from './queryTuning';
import { invalidateObjectSessions, invalidateSessions } from './sessions';

/* ── reads ───────────────────────────────────────────────────────────────── */

/**
 * The plan list — the plan switcher, and 「等待确认」 in the new-session sheet.
 * `AgentPlanSummary` carries `revision`, `shot_count` and `origin_count` but not
 * the shots, so the switcher never pays for four plans' worth of shot arrays.
 */
export function useAgentPlanList(query: AgentPlanQuery = {}, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.plans.list(query),
    queryFn: ({ signal }) => client.listAgentPlans(query, signal),
    ...resolveQueryTuning(tuning),
  });
}

/**
 * One plan with its shots, its origin trail and its immutable Agent baseline.
 *
 * This is the read *both* the page shell (for the toolbar's 「方案 #P-118 · 修订
 * 7」) and the plan panel call. TanStack deduplicates by key, so the second
 * caller costs nothing — the same arrangement the nine match views use for
 * `useMatchAnalysis`, and the reason the shell does not thread the plan through
 * props and re-render three blocks on every refetch.
 *
 * `null` disables the read: `/agent` with no `?plan=` is a real state.
 */
export function useAgentPlan(planId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.plans.detail(planId ?? ''),
    queryFn:
      planId === null
        ? skipToken
        : ({ signal }: { signal: AbortSignal }) => client.getAgentPlan(planId, signal),
    ...resolveQueryTuning(tuning, { enabled: planId !== null }),
  });
}

/**
 * One collaboration workbench read: the authoritative plan revision together
 * with per-shot recording materialization and the current compatible
 * composition. The server owns the Take/spec comparison so the renderer never
 * guesses whether edited footage is still usable.
 */
export function useAgentPlanWorkbench(planId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.plans.workbench(planId ?? ''),
    queryFn:
      planId === null
        ? skipToken
        : ({ signal }: { signal: AbortSignal }) => client.getAgentPlanWorkbench(planId, signal),
    ...resolveQueryTuning(tuning, { enabled: planId !== null }),
  });
}

export function useAgentTakes(
  planId: string | null,
  shotId?: string,
  tuning: DataQueryTuning = {},
) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.plans.takes(planId ?? '', shotId),
    queryFn:
      planId === null
        ? skipToken
        : ({ signal }: { signal: AbortSignal }) => client.listAgentTakes(planId, shotId, signal),
    ...resolveQueryTuning(tuning, { enabled: planId !== null }),
  });
}

export function useAgentComposition(planId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.plans.composition(planId ?? ''),
    queryFn:
      planId === null
        ? skipToken
        : ({ signal }: { signal: AbortSignal }) => client.getAgentComposition(planId, signal),
    ...resolveQueryTuning(tuning, { enabled: planId !== null }),
  });
}

/* ── writes ──────────────────────────────────────────────────────────────── */

/**
 * Creates a plan from an Agent proposal or from scratch.
 *
 * `origin` may be `null` — a plan created outside any session is legal, which
 * is §4.5.1's 「不用 Agent 也能完整操作」 in the contract itself. When it is
 * supplied, the session's reference list changes too, so both namespaces are
 * invalidated.
 */
export function useCreateAgentPlan() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (create: AgentPlanCreate) => client.createAgentPlan(create),
    onSuccess: (plan, create) =>
      Promise.all([
        invalidatePlans(queryClient),
        create.origin === null
          ? Promise.resolve()
          : Promise.all([
            invalidateSessions(queryClient),
            invalidateObjectSessions(queryClient, 'plan', plan.id),
          ]).then(() => undefined),
      ]).then(() => undefined),
  });
}

/**
 * **The manual-edit path.** One `AgentPlanEdit` carries the whole shot array,
 * the `expected_revision` it is conditional on, the origin row and the merged
 * `changes` that become the `workspace_edit` notice.
 *
 * §4.5.3 rule ②: nothing here asks the Agent for approval and nothing here can
 * roll a user edit back — the only rollback in the contract is
 * `restoreAgentPlanBaseline`, which the *user* triggers from 「还原为 Agent
 * 版本」.
 *
 * The response is written into the cache directly as well as invalidated: the
 * server returns the plan it just produced, and the panel needs the new
 * revision number before the refetch lands or the next edit would be sent with
 * a stale `expected_revision` and 409 immediately.
 */
export function useApplyAgentPlanEdit() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (edit: AgentPlanEdit) => client.applyAgentPlanEdit(edit),
    onSuccess: (plan) => {
      queryClient.setQueryData(qk.plans.detail(plan.id), plan);
      return invalidateAfterPlanWrite(queryClient, plan.id);
    },
  });
}

/**
 * 「还原为 Agent 版本」 (§4.6 gap 10). Conditional in exactly the same way as an
 * edit — it *is* an edit, whose new shots happen to be the baseline's — so it
 * produces an origin row and a notice like any other, and the Agent learns
 * about it through the same channel.
 */
export function useRestoreAgentPlanBaseline() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (restore: AgentPlanRestore) => client.restoreAgentPlanBaseline(restore),
    onSuccess: (plan) => {
      queryClient.setQueryData(qk.plans.detail(plan.id), plan);
      return invalidateAfterPlanWrite(queryClient, plan.id);
    },
  });
}

/**
 * 「稍后处理」 / 「现在就看」.
 *
 * `until` is computed here rather than by the service, because 「今天不再提醒」
 * means the user's *own* next midnight and only the browser knows their
 * timezone. `null` clears it.
 *
 * Not an edit, so no `expected_revision` and no conflict to handle: two tabs
 * snoozing the same plan agree, and a snooze racing a real edit does not
 * cost either of them.
 */
export function useSnoozeAgentPlan() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ planId, until }: { planId: string; until: string | null }) =>
      client.snoozeAgentPlan(planId, until),
    onSuccess: (plan) => {
      queryClient.setQueryData(qk.plans.detail(plan.id), plan);
      return invalidateAfterPlanWrite(queryClient, plan.id);
    },
  });
}

export function usePutAgentComposition(planId: string) {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (update: PutAgentCompositionRequest) =>
      client.putAgentComposition(planId, update),
    onSuccess: (composition) => {
      queryClient.setQueryData(qk.plans.composition(planId), composition);
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.plans.detail(planId) }),
        queryClient.invalidateQueries({ queryKey: qk.outputs.all }),
      ]).then(() => undefined);
    },
  });
}

export function useExportAgentComposition(planId: string) {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => client.exportAgentComposition(planId),
    onSuccess: (response) => {
      queryClient.setQueryData(qk.plans.composition(planId), response.composition);
      return queryClient.invalidateQueries({ queryKey: qk.outputs.all });
    },
  });
}

/**
 * The instant 「今天不再提醒」 means: the next local midnight.
 *
 * Local, so a plan snoozed at 23:50 is back ten minutes later — which is what
 * the words say, and is why this is not "24 hours".
 */
export function nextLocalMidnight(now = new Date()): string {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return midnight.toISOString();
}

/* ── invalidation ────────────────────────────────────────────────────────── */

/** Every plan read. A write changes the revision, which every summary prints. */
export function invalidatePlans(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.plans.all });
}

export function invalidatePlan(client: QueryClient, planId: string): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.plans.detail(planId) });
}

/**
 * The full chain a plan write causes, in one place so the three mutations
 * cannot disagree: the plan itself, the plan's 「改动来源」, and the session that
 * received the notice.
 */
export function invalidateAfterPlanWrite(client: QueryClient, planId: string): Promise<void> {
  return Promise.all([
    invalidatePlans(client),
    invalidateObjectSessions(client, 'plan', planId),
    invalidateSessions(client),
  ]).then(() => undefined);
}

/* ── the 409 ─────────────────────────────────────────────────────────────── */

/**
 * Whether a rejected plan write lost the race — someone moved the plan between
 * the read and the write.
 *
 * Worth naming because the recovery is specific and is *not* an error message:
 * refetch the plan, re-apply the user's pending edits on top of the new
 * revision, and let `markStale` recompute the proposal cards. The artboard's
 * 「基于修订 7 重算 / 逐条查看 / 全部丢弃」 dialog is what a panel offers when the
 * replay is not automatic.
 */
export function isRevisionConflict(error: unknown): boolean {
  return toDataError(error, '')?.status === 409;
}
