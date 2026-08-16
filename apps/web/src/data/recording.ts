/**
 * data layer — 「08 录制计划与镜头预览」 (spec §7 `/recording/:taskId?`, §4.3,
 * §4.5.3, phase 3f).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  Three things are decided here, and none of them is a hook signature
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ## 1. A recording plan is not a query, and starting one is not a mutation the
 *    UI may reach twice
 *
 * `POST /api/recording/plan` mints a **lease**: the server keeps the assembled
 * `RecordingRequest[]`, runs the director orchestration that merges adjacent
 * shots, and holds the result for five minutes (`RECORDING_PLAN_TTL`,
 * `crates/application/src/routes/recording.rs`). Two consequences the page can
 * feel:
 *
 *   · **It cannot be a `useQuery`.** A refetch — remount, invalidation,
 *     staleness — would mint a *second* lease with a *different* director
 *     result while the user is watching the first one's preview. The plan is a
 *     mutation result the page holds.
 *   · **It expires while the user is reading it.** 「造计划 → 校验 → 开始录制」
 *     easily outlives five minutes. `useRecordingPlanExpiry` turns the lease's
 *     `expires_at` into a boolean that ticks, and `isRecordingPlanLost` names
 *     the two 409 codes the server answers with afterwards
 *     (`recording_plan_expired`, `recording_plan_unavailable`). **Nothing here
 *     re-plans on its own**: a silent re-plan swaps the director's output, so
 *     what the user confirmed would not be what was recorded. The recovery is
 *     an action the user takes, labelled 「重新生成计划」.
 *
 * ## 2. Recording starts from exactly one explicit confirmation (§4.5.3 ①)
 *
 * `executeRecordingPlan` launches CS2, writes to disk and cannot be undone.
 * §4.5.3 rule ① — 「录制只由一次显式确认启动。接受变更不触发录制，手动编辑不触发
 * 录制，切换会话不触发录制」 — is enforced here **in the type system**, not by a
 * dialog this layer renders:
 *
 *     const confirmation = confirmRecordingStart({ planId, offlineInsecureAcknowledged });
 *     execute.mutate(confirmation);
 *
 * `RecordingStartConfirmation` carries a `unique symbol` brand, so it cannot be
 * spelled as an object literal and cannot be produced by a `select`, a
 * `queryFn`, a retry or an effect. The alternative — a hook that owns its own
 * confirmation dialog — was rejected because it would put a rendered overlay in
 * `data/**`, and because 「开始录制」's dialog copy is a page decision (「停止这次
 * 录制？」's sibling in 「补齐 · 规范与状态」).
 *
 * The mutation is the *only* call site of `client.executeRecordingPlan` in the
 * app, which is invariant 1 of `pages/recording/recordingContract.ts` seen from
 * this side.
 *
 * ## 3. Preflight is a probe, and any shot change voids it
 *
 * `POST /api/recording/plans/{id}/preflight` re-discovers CS2, re-hashes every
 * Demo, asks the OS for encoders and measures free space. It is a POST because
 * it *costs*, not because it writes — but that is enough to keep it out of the
 * query cache, where a background refetch would spin a disk on a timer.
 *
 * It is also **plan-specific and shot-specific**. The artboard states it:
 * 「修改任何片段都会让当前预览计划失效，需要重新生成预览」. That is not a
 * slogan — a per-shot `presentation` edit changes the sha256 the plan lease is
 * bound to. So `useRecordingPreflight(planId, signature)` keys its held result
 * on both, and the moment either moves the previous answer is *gone* rather
 * than stale: `blocking` from a check list run against different shots is a
 * number that means nothing.
 *
 * `blocking > 0` disables 「开始录制」. That is the whole contract
 * (`RecordingPreflight` in `dto.ts`); a `warning` never disables anything, and
 * `RecordingPlanResponse.warnings` — free text, not a check — never does
 * either, but must still be shown.
 *
 * ── what invalidates what ─────────────────────────────────────────────────
 *
 *   executeRecordingPlan   → `qk.tasks.all` **and** `qk.outputs.all`.
 *                            A recording is an activity that produces outputs;
 *                            forget the second half and 「最近输出」 stays empty
 *                            after a successful take.
 *   cancel / abort         → the same pair. 「已完成的 2 个片段会保留在输出里」
 *                            (「补齐 · 规范与状态」) — a stop *changes* the
 *                            output list, it does not leave it alone.
 *   shot preset writes     → `qk.recording.shotPresets()` only. Nothing on the
 *                            server dereferences a preset id.
 *   plan / preflight       → nothing. No server state the UI reads has moved.
 *   playDemo / stopPlayback→ `qk.recording.playback()` and `qk.config.runtime()`
 *                            (`RuntimeState.runtime_session` prints the same
 *                            fact in the shell).
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import type {
  DemoPlaybackOptions,
  HlaeProposalIntent,
  HlaeProposalPreview,
  RecordingPlanResponse,
  RecordingPreflight,
  RecordingQueueRequest,
  RecordingShotPreset,
  RecordingShotPresetDraft,
} from '../shared/desktop/dto';
import { invalidateConfig } from './config';
import { useDesktopClient } from './desktopClient';
import { toDataError } from './errors';
import { qk } from './keys';
import { invalidateOutputs } from './outputs';
import { resolveQueryTuning, type DataQueryTuning } from './queryTuning';
import { invalidateTasks } from './tasks';

/* ── the lease and its clock ─────────────────────────────────────────────── */

/**
 * `RECORDING_PLAN_TTL` from `crates/application/src/routes/recording.rs`,
 * mirrored rather than derived: the response carries an absolute `expires_at`,
 * so this constant is only needed to draw a countdown and to decide how often
 * to look at the clock. If the two ever disagree, `expires_at` wins — every
 * predicate below reads the response, never this number.
 */
export const RECORDING_PLAN_TTL_MS = 5 * 60 * 1000;

/** How often the countdown re-reads the clock. One second is enough for a
 *  five-minute lease and cheap enough not to matter. */
const EXPIRY_TICK_MS = 1_000;

export interface RecordingPlanExpiry {
  /** The one boolean the page reads. `true` also when the plan is `null`? No —
   *  no plan is not an expired plan, and the page renders a different thing for
   *  each, so this is `false` with `remainingMs: null`. */
  readonly expired: boolean;
  /** Milliseconds left, clamped at zero. `null` with no plan, or when the
   *  server sent an `expires_at` that is not a date — a broken timestamp must
   *  not be rendered as 「已过期」. */
  readonly remainingMs: number | null;
}

/**
 * `expires_at` parsed once. Exported because `recordingContract.ts` formats the
 * countdown and the two must agree about what an unparseable timestamp means.
 */
export function recordingPlanExpiresAt(plan: RecordingPlanResponse | null): number | null {
  if (plan === null) return null;
  const at = Date.parse(plan.expires_at);
  return Number.isNaN(at) ? null : at;
}

/** Pure, so the boundary is exhaustible without a timer. */
export function recordingPlanExpiry(
  plan: RecordingPlanResponse | null,
  now: number,
): RecordingPlanExpiry {
  const at = recordingPlanExpiresAt(plan);
  if (at === null) return { expired: false, remainingMs: null };
  const remainingMs = Math.max(0, at - now);
  return { expired: remainingMs === 0, remainingMs };
}

/**
 * The lease clock. Ticks only while a plan is held and has not expired yet —
 * an expired plan cannot become more expired, and a page with no plan should
 * not own a timer.
 */
export function useRecordingPlanExpiry(plan: RecordingPlanResponse | null): RecordingPlanExpiry {
  const [now, setNow] = useState(() => Date.now());
  const expiresAt = recordingPlanExpiresAt(plan);
  const running = expiresAt !== null && expiresAt > now;

  useEffect(() => {
    if (!running) return;
    const timer = globalThis.setInterval(() => setNow(Date.now()), EXPIRY_TICK_MS);
    return () => globalThis.clearInterval(timer);
  }, [running]);

  return useMemo(() => recordingPlanExpiry(plan, now), [plan, now]);
}

/**
 * Whether a rejected recording write means 「这份计划已经不在了」.
 *
 * Both codes are 409 and both recover the same way — 「重新生成计划」 — but they
 * are distinguished because the sentences differ: an expired plan was the
 * user's own five minutes, a missing one usually means the service restarted.
 */
export type RecordingPlanLoss = 'expired' | 'unavailable';

export function recordingPlanLoss(error: unknown): RecordingPlanLoss | null {
  const data = toDataError(error, '');
  if (data === null || data.status !== 409) return null;
  if (data.code === 'recording_plan_expired') return 'expired';
  if (data.code === 'recording_plan_unavailable') return 'unavailable';
  return null;
}

export function isRecordingPlanLost(error: unknown): boolean {
  return recordingPlanLoss(error) !== null;
}

/**
 * Why `POST /api/agent/plans/{id}/recording-plan` refused (422).
 *
 * **The structured body never reaches this layer.** The desktop bridge
 * (`apps/desktop/src-tauri/src/bridge.rs`, `DesktopCommandError::from_problem`)
 * flattens every error body to `{status, code, message}`, so the route's
 * `shots: [{id, title}]` array is dropped in transit — the backend says so in
 * its own doc comment. Do not go looking for it.
 *
 * The page does not need it. It is already holding the `AgentPlan`, and a shot
 * with `recording === null` **is** an unbound shot: the code decides the
 * sentence, the plan decides which cards to mark. `agentPlanShotsNeedingBinding`
 * in `pages/recording/recordingContract.ts` does that second half.
 */
export type AgentPlanRecordingRefusal = 'shots_unbound' | 'not_recordable';

export function agentPlanRecordingRefusal(error: unknown): AgentPlanRecordingRefusal | null {
  const data = toDataError(error, '');
  if (data === null || data.status !== 422) return null;
  if (data.code === 'agent_plan_shots_unbound') return 'shots_unbound';
  if (data.code === 'agent_plan_not_recordable') return 'not_recordable';
  return null;
}

/* ── building a plan ─────────────────────────────────────────────────────── */

/**
 * 「生成预览计划」 from a hand-assembled queue — the door used when the shots
 * come from the highlight list rather than from an Agent plan.
 *
 * Invalidates nothing: a lease is not a record any read in this app can see.
 */
export function usePlanRecording() {
  const client = useDesktopClient();
  return useMutation({
    mutationFn: (queue: RecordingQueueRequest): Promise<RecordingPlanResponse> =>
      client.planRecording(queue),
  });
}

/**
 * 「来自方案 #P-118」 — the same `RecordingPlanResponse`, assembled by the server
 * from an Agent plan's shots (§10.6 gap 1, closed in phase 3f-be).
 *
 * Soft-removed shots (`removed_by !== null`) are skipped server-side, so an
 * undone removal and a recording cannot disagree about what the plan contains.
 * Rejects with 422 when any surviving shot has no `recording` binding — see
 * `agentPlanRecordingRefusal`.
 */
export function usePlanRecordingFromAgentPlan() {
  const client = useDesktopClient();
  return useMutation({
    mutationFn: (planId: string): Promise<RecordingPlanResponse> =>
      client.planRecordingFromAgentPlan(planId),
  });
}

/**
 * 「重试录制」's plan half, re-exported here so 「08」 does not have to import a
 * task hook to do a recording thing.
 *
 * `data/tasks.ts` owns the delivery-page-facing name (`useRetryRecordingPlan`)
 * and both call the one command; neither invalidates anything, because
 * producing a plan changes no task.
 */
export function usePlanRecordingRetry() {
  const client = useDesktopClient();
  return useMutation({
    mutationFn: (jobId: string): Promise<RecordingPlanResponse> =>
      client.planRecordingRetry(jobId),
  });
}

/* ── the pre-recording check list ────────────────────────────────────────── */

export type RecordingPreflightStatus = 'idle' | 'running' | 'ready' | 'failed';

export interface RecordingPreflightGate {
  readonly status: RecordingPreflightStatus;
  /** The check list, or `null` when it has never been run against *these*
   *  shots. Never a stale answer — see `signature`. */
  readonly result: RecordingPreflight | null;
  readonly error: unknown;
  /**
   * **The start-recording contract, in one boolean.** `false` until a check
   * list has been run against the current shots and came back with
   * `blocking === 0`. A page never adds its own condition on top of a warning:
   * 「blocking > 0 → 禁用」 is the whole rule.
   */
  readonly canStart: boolean;
  /** Runs it. A no-op with no plan id, so a page may wire it unconditionally. */
  readonly run: () => void;
  /** Drops the held answer — for 「重新生成计划」, which produces a new plan id
   *  and therefore invalidates the answer anyway; this is for the cases where
   *  it does not. */
  readonly reset: () => void;
}

/**
 * Holds one check-list answer, and forgets it the instant it stops describing
 * what is on screen.
 *
 * `signature` is the caller's summary of the shots the plan was built from —
 * `recordingShotSignature(items)` in `pages/recording/recordingContract.ts`.
 * Passing it in rather than deriving it here is deliberate: the page is the one
 * that knows whether an edit has been made but not yet re-planned, and this
 * layer has no business deciding that a `presentation` change is material (it
 * is — it feeds the plan's own sha256 binding).
 *
 * The invalidation is **derived, not an effect**: the held answer carries the
 * key it was produced under and is simply not returned when the key moves. An
 * effect that cleared state on change would render the stale number once, and
 * once is enough to start a recording that should have been blocked.
 */
export function useRecordingPreflight(
  planId: string | null,
  signature: string,
): RecordingPreflightGate {
  const client = useDesktopClient();
  const key = `${planId ?? ''}::${signature}`;
  const [held, setHeld] = useState<HeldPreflight | null>(null);

  const mutation = useMutation({
    mutationFn: (id: string): Promise<RecordingPreflight> => client.preflightRecordingPlan(id),
  });

  /* The held answer carries the key it was produced under. A failure is scoped
     the same way a success is: a check list that failed against a different
     shot list says nothing about this one. */
  const current = held !== null && held.key === key ? held : null;
  const result = current?.result ?? null;

  const status: RecordingPreflightStatus = mutation.isPending
    ? 'running'
    : current === null
      ? 'idle'
      : result !== null
        ? 'ready'
        : 'failed';

  return {
    status,
    result,
    error: current?.error ?? null,
    canStart: result !== null && result.blocking === 0,
    run: () => {
      if (planId === null) return;
      mutation.mutate(planId, {
        /* `key` is captured at call time. If the shots moved while the probe
           was in flight the entry lands under the old key and is never read —
           which is the correct outcome, not a lost update. */
        onSuccess: (answer) => setHeld({ key, result: answer, error: null }),
        onError: (error) => setHeld({ key, result: null, error }),
      });
    },
    reset: () => {
      setHeld(null);
      mutation.reset();
    },
  };
}

interface HeldPreflight {
  readonly key: string;
  readonly result: RecordingPreflight | null;
  readonly error: unknown;
}

/* ── starting a recording ────────────────────────────────────────────────── */

declare const RECORDING_CONFIRMED: unique symbol;

/**
 * Proof that a human pressed 「开始录制」.
 *
 * The brand is the point. It is a `declare`d `unique symbol`, so the type
 * cannot be satisfied by an object literal anywhere in the codebase — the only
 * way to obtain one is `confirmRecordingStart`, and the only caller of that is
 * a click handler. A `queryFn`, a `select`, a retry callback or an effect can
 * hold a plan id and still be unable to start a recording, which is §4.5.3 rule
 * ① expressed as something a reviewer cannot forget to check.
 */
export interface RecordingStartConfirmation {
  readonly planId: string;
  /**
   * 「我知道 CS2 会以 -insecure 启动」. `executeRecordingPlan`'s second argument;
   * the service refuses without it when the launch profile needs it.
   */
  readonly offlineInsecureAcknowledged: boolean;
  /** When the human agreed. Not sent — it is here so a stale confirmation held
   *  across a re-plan is visible in a debugger rather than invisible. */
  readonly confirmedAt: number;
  readonly [RECORDING_CONFIRMED]: true;
}

export interface ConfirmRecordingStartInput {
  readonly planId: string;
  readonly offlineInsecureAcknowledged: boolean;
}

/**
 * Call this **from the confirm button of the one confirmation dialog**, never
 * anywhere else. It is a plain function rather than a hook so that it is
 * obvious it performs no I/O: it mints a value, and the mutation below is what
 * spends it.
 */
export function confirmRecordingStart(
  input: ConfirmRecordingStartInput,
): RecordingStartConfirmation {
  return {
    planId: input.planId,
    offlineInsecureAcknowledged: input.offlineInsecureAcknowledged,
    confirmedAt: Date.now(),
  } as RecordingStartConfirmation;
}

/**
 * 「开始录制 4 个片段」. **The only thing in this application that launches CS2.**
 *
 * Resolves to `RecordingExecutionResponse { job_id, status }`; the page
 * navigates to `/delivery/task/<job_id>`, which is where a running recording
 * already has a first-class address (§7). Nothing about the running job is
 * modelled here — that is `data/tasks.ts`'s surface, and a second one would
 * drift.
 *
 * Invalidates `qk.tasks.all` *and* `qk.outputs.all`. The second is not
 * optimism: `active_recording_job` moves on `RuntimeState` too, so
 * `qk.config.runtime()` goes with them.
 */
export function useExecuteRecordingPlan() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (confirmation: RecordingStartConfirmation) =>
      client.executeRecordingPlan(
        confirmation.planId,
        confirmation.offlineInsecureAcknowledged,
      ),
    onSuccess: () => invalidateAfterRecordingRuns(queryClient),
  });
}

/**
 * 「停止」 from 「停止这次录制？」 — the job-level cancel.
 *
 * Same invalidation as starting, and for the reason the dialog itself gives:
 * 「已完成的 2 个片段会保留在输出里」. A stop changes the output list.
 */
export function useCancelRecordingJob() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (jobId: string) => client.cancelRecordingJob(jobId),
    onSuccess: () => invalidateAfterRecordingRuns(queryClient),
  });
}

/**
 * The process-level stop, for the case the job-level one cannot reach: CS2 is
 * up and the job record is already gone or wedged. `POST /api/recording/abort`
 * takes no id, which is exactly why it is separate — it is 「把游戏关掉」, not
 * 「取消这个任务」, and a page must not offer it as if it were the same button.
 */
export function useAbortRecording() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => client.abortRecording(),
    onSuccess: () => invalidateAfterRecordingRuns(queryClient),
  });
}

/* ── shot presets ────────────────────────────────────────────────────────── */

/**
 * 「存为预设」's catalogue — 「我的 POV 参数 · 包含视野、HUD、雷达、语音与前后
 * 留白，应用时作为一次原子变更」 (「补齐 · 规范与状态」).
 *
 * A preset holds only shot-scoped values: no `demo_id`, no `player_id`, no tick
 * window, no title. That is a backend decision worth repeating at the call
 * site, because it is what makes 「应用到全部」 safe — applying a preset can
 * never retarget a shot at different footage.
 */
export function useRecordingShotPresets(tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.recording.shotPresets(),
    queryFn: ({ signal }) => client.listRecordingShotPresets(signal),
    ...resolveQueryTuning(tuning),
  });
}

export function useCreateRecordingShotPreset() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: RecordingShotPresetDraft): Promise<RecordingShotPreset> =>
      client.createRecordingShotPreset(draft),
    onSuccess: () => invalidateRecordingShotPresets(queryClient),
  });
}

export interface UpdateRecordingShotPresetInput {
  readonly id: string;
  readonly draft: RecordingShotPresetDraft;
}

/**
 * Whole-document replace. **There is no `expected_revision` in this group and
 * that is correct, not an oversight**: nothing on the server dereferences a
 * preset id — applying one copies its values into a shot — so there is no
 * second reader whose view could go stale. Do not invent an optimistic-
 * concurrency dance for it.
 */
export function useUpdateRecordingShotPreset() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, draft }: UpdateRecordingShotPresetInput): Promise<RecordingShotPreset> =>
      client.putRecordingShotPreset(id, draft),
    onSuccess: () => invalidateRecordingShotPresets(queryClient),
  });
}

export function useDeleteRecordingShotPreset() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.deleteRecordingShotPreset(id),
    onSuccess: () => invalidateRecordingShotPresets(queryClient),
  });
}

/* ── 「在游戏里预览」 ─────────────────────────────────────────────────────── */

/**
 * Whether CS2 is already playing something.
 *
 * Read before offering the in-game preview so the page can say 「游戏正在回放另
 * 一场 Demo」 instead of launching a second process and letting the service
 * refuse. Not polled by default — the cadence belongs to the page (§4.1 has no
 * refetch interval, `queryTuning.ts` explains why).
 */
export function useDemoPlaybackStatus(tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.recording.playback(),
    queryFn: ({ signal }) => client.playbackStatus(signal),
    ...resolveQueryTuning(tuning),
  });
}

/**
 * Compiles a camera path and reports what is missing, without writing anything.
 *
 * This is the first half of the recovery action behind the preflight's
 * `camera_collision_unverified` row. That row is honest about what it does not
 * know: 「这几个镜头的坐标在进游戏预览之前无法与地图几何核对」. It is a
 * *warning* whenever the plan has an observer shot, `ok` when every shot is POV,
 * and **never** `blocked` — so this action is an offer, never a gate.
 */
export function usePreviewCameraPath() {
  const client = useDesktopClient();
  return useMutation({
    mutationFn: (intent: HlaeProposalIntent): Promise<HlaeProposalPreview> =>
      client.previewHlaeProposal(intent),
  });
}

export interface ExportCameraPathInput {
  readonly intent: HlaeProposalIntent;
  /** The preview this export is confirming. Its three fingerprints and its
   *  token are what the server checks; a caller cannot assemble them. */
  readonly preview: HlaeProposalPreview;
}

/**
 * Writes the HLAE script files for a previewed camera path.
 *
 * Rejects rather than sending a half-built confirmation when the preview was
 * not `ready` — the server would answer 409 anyway, and failing here says which
 * of the two steps was skipped.
 *
 * Note the intent's `expected_revision: 0`: the HLAE proposal is not bound to
 * an editor project, so the confirmation's revision field has nothing to point
 * at. That is the route's own shape, not a placeholder.
 */
export function useExportCameraPath() {
  const client = useDesktopClient();

  return useMutation({
    mutationFn: ({ intent, preview }: ExportCameraPathInput) => {
      if (
        !preview.ready
        || preview.base_fingerprint === null
        || preview.proposal_fingerprint === null
        || preview.confirmation_token === null
      ) {
        return Promise.reject(
          new Error('The camera path must be previewed successfully before it can be exported.'),
        );
      }
      return client.exportHlaeProposal(intent, {
        base_fingerprint: preview.base_fingerprint,
        proposal_fingerprint: preview.proposal_fingerprint,
        confirmation_token: preview.confirmation_token,
        expected_revision: 0,
        confirm: true,
      });
    },
  });
}

export interface DemoPlaybackInput {
  readonly demoId: string;
  readonly options?: DemoPlaybackOptions | undefined;
}

/**
 * The pre-launch probe. Reports the executable, the managed copy and whether
 * GSI is installed — the same facts the preflight's `game_ready` row carries,
 * measured against one Demo instead of a whole plan.
 */
export function usePreflightDemoPlayback() {
  const client = useDesktopClient();
  return useMutation({
    mutationFn: ({ demoId, options }: DemoPlaybackInput) =>
      client.preflightDemo(demoId, options ?? {}),
  });
}

/** Launches CS2 on a Demo. Ten-minute client timeout — the game is slow to
 *  come up and a spurious abort would leave a process nobody is watching. */
export function useStartDemoPlayback() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ demoId, options }: DemoPlaybackInput) =>
      client.playDemo(demoId, options ?? {}),
    onSuccess: () => invalidatePlaybackState(queryClient),
  });
}

export function useStopDemoPlayback() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => client.stopPlayback(),
    onSuccess: () => invalidatePlaybackState(queryClient),
  });
}

/* ── invalidation ────────────────────────────────────────────────────────── */

/** Just the preset catalogue. */
export function invalidateRecordingShotPresets(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.recording.shotPresets() });
}

/**
 * The pair every recording write owes: the task feed **and** the output list.
 * Plus `config.runtime()`, which prints `active_recording_job` in the shell.
 *
 * Written once because the three mutations that need it (start, cancel, abort)
 * must not be able to disagree, and because 「录完了『最近输出』还是空的」 is
 * exactly what happens when one of them forgets the middle one.
 */
export function invalidateAfterRecordingRuns(client: QueryClient): Promise<void> {
  return Promise.all([
    invalidateTasks(client),
    invalidateOutputs(client),
    invalidateConfig(client),
  ]).then(() => undefined);
}

/** Playback status, and the runtime state that mirrors it. */
export function invalidatePlaybackState(client: QueryClient): Promise<void> {
  return Promise.all([
    client.invalidateQueries({ queryKey: qk.recording.playback() }),
    invalidateConfig(client),
  ]).then(() => undefined);
}
