/*
 * pages/recording — the contract the four blocks of 「08 录制计划与镜头预览」 are
 * built against (spec §7 `/recording/:taskId?`, §4.3, §4.5.3, phase 3f).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  READ THIS FIRST if you are filling in one of the four blocks
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `RecordingPage` is the shell. It owns the address, the plan lease, the one
 * selected shot and the one 「开始录制」, and it renders four blocks that each
 * get the same `RecordingBlockProps`:
 *
 *   A  片段列表（左列）    the ordered shots, drag to reorder, 「＋ 从高光添加
 *                          片段」, and the line 「相邻镜头会在导播预览中合并。修改
 *                          任何片段都会让当前预览计划失效」
 *   B  导播预览（中列）    the camera-path schematic, the transport, and the
 *                          caption 「导播预览为相机路径示意，不是最终画质」
 *   C  录制前校验（中列下） the eight check rows and 「开始录制 4 个片段」
 *   D  片段属性（右列）    the inspector: 镜头类型 / 视角 / 前后留白 / 画面 /
 *                          画面元素 / 存为预设 / 应用到全部
 *
 * Replace the placeholder in `RecordingPage.tsx` with your block's component
 * and put the component under `pages/recording/`. **Keep `RecordingPage`'s
 * named export** — `src/routes.tsx` imports it and that seam is frozen.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  What `:taskId` is — settled, do not re-litigate
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **`:taskId` is an Agent plan id, not a recording task id.**
 *
 * The board's top bar reads 「Kael_Mirage_1v3 · 4 个片段 · 42 秒 · 来自方案
 * #P-118」 with a 「返回方案」 door beside it, and the whole surface — shot list,
 * director preview, pre-recording checks, 开始录制 — describes **a plan that has
 * not been recorded yet**. A task that is already running has its own
 * first-class address, `/delivery/task/:taskId` (§7), with the stage log and
 * the retry notice on it. Building a second task detail here would be two
 * screens for one object, and they would drift.
 *
 * So:
 *
 *   `/recording`            the recordable plans, plus recent recording tasks.
 *                           A task row links to `/delivery/task/:id`; it does
 *                           not open here.
 *   `/recording/<planId>`   the board above, in full.
 *   「返回方案」              `/agent?plan=<planId>` — `agentPlanHandoff(planId)`.
 *   「开始录制」 succeeds     `/delivery/task/<jobId>`.
 *
 * (The old comment at the top of `RecordingPage.tsx` said the parametrised
 * address was 「a single recording task」. It was wrong; it has been replaced
 * with this reasoning.)
 *
 * ── hook → block ──────────────────────────────────────────────────────────
 *
 *   data/recording.ts
 *     usePlanRecordingFromAgentPlan   shell   「来自方案」's door
 *     usePlanRecording                shell   the hand-assembled queue door
 *     usePlanRecordingRetry           shell   arriving from 「重试录制」
 *     useRecordingPlanExpiry          shell   the 5-minute lease clock
 *     isRecordingPlanLost             shell   the two 409 codes afterwards
 *     agentPlanRecordingRefusal       shell   the two 422 codes before
 *     useRecordingPreflight           C       the check list, keyed on the shots
 *     confirmRecordingStart           C       the one confirmation (invariant 1)
 *     useExecuteRecordingPlan         C       the one execute (invariant 1)
 *     useCancelRecordingJob / useAbortRecording  — **not on this page.** A
 *                                     running recording is `/delivery/task/:id`.
 *     useRecordingShotPresets + the three writes   D  「存为预设」
 *     useDemoPlaybackStatus / usePreviewCameraPath / useExportCameraPath /
 *     usePreflightDemoPlayback / useStartDemoPlayback / useStopDemoPlayback
 *                                     C       the recovery offer behind the
 *                                             `camera_collision_unverified` row
 *
 *   data/plans.ts        useAgentPlan (the shell's 「来自方案 #P-118」 subject),
 *                        useAgentPlanList (bare `/recording`'s plan list)
 *   data/tasks.ts        useTaskFeed (bare `/recording`'s recent tasks)
 *   data/config.ts       useAppConfig — the six presentation defaults a shot
 *                        with `presentation: null` follows. **Block D needs
 *                        this**; see `resolveShotPresentation`.
 *   data/nativeShell.ts  useNativeShell — 「打开输出目录」 and nothing else here
 *   data/serviceAction   `props.service`, derived once by the shell
 *
 *   domain/task          RECORDING stage vocabulary, StatusDot
 *   domain/media         Transport (block B's ◀ ▶ ▶| and 00:13.1 / 00:42.0)
 *   domain/map           the radar the camera path is drawn over
 *
 * ── the invariants ────────────────────────────────────────────────────────
 *
 * **1. There is exactly one 「开始录制」, and it is the only thing on this page
 * that can start a recording.** (§4.5.3 rule ①)
 *
 * It lives in block C, under the check list, because that is the only place
 * `blocking` is known. The top bar's 「开始录制」 on the artboard is the *same*
 * button — the shell may render `props.start` in the toolbar as well, but it
 * renders the value the shell holds, it does not build a second one. 3e's
 * lesson is exact and worth repeating: one action implemented twice in two
 * columns, and one of the two copies was a no-op that only coloured itself.
 *
 * The data layer enforces the same rule from below: `useExecuteRecordingPlan`
 * demands a `RecordingStartConfirmation`, a branded value only
 * `confirmRecordingStart` can produce, so no query, effect or retry can reach
 * the command. A block must not call `confirmRecordingStart` — the shell hands
 * you `props.start`.
 *
 * **2. The selected shot is page state.** Block A's list, block B's preview and
 * block D's inspector are one selection: the board draws 「02 跟随突破」
 * highlighted in the list, previewed in the middle and open on the right, all
 * at once. Two `useState`s would produce two selections on one screen — the
 * same failure as 3e's duplicated decision map. The shell holds `selectedShotId`
 * and hands down `props.selection`.
 *
 * **3. Editing a shot invalidates the plan *and* the check list, in that
 * order.** 「修改任何片段都会让当前预览计划失效，需要重新生成预览」 is not copy:
 * a per-shot `presentation` feeds the sha256 the plan lease is bound to. So an
 * edit sets `props.plan.dirty`, which disables 开始录制 with the reason 「片段已
 * 修改，需要重新生成预览计划」, and `useRecordingPreflight`'s `signature`
 * argument (`recordingShotSignature`) makes the previous check list vanish
 * rather than go quietly stale. **Never re-plan automatically** — a silent
 * re-plan swaps the director's merge result under a preview the user is
 * reading, so what they confirm is not what they saw.
 *
 * **4. `blocking > 0` disables 开始录制; a warning never does.** That is the
 * entire contract of `RecordingPreflight` (dto.ts). Do not add a condition of
 * your own on top of a warning row, and do not soften a blocked one.
 *
 * ── the eight check rows, read correctly ──────────────────────────────────
 *
 * `RecordingPreflightCode` is a closed set of eight and the board draws all
 * eight. `PREFLIGHT_CHECK` below is their label table. Two rules for rendering
 * them:
 *
 * · **`detail` is English fact — print it, do not translate it.** It carries
 *   the parts a code cannot: 「剩余 218 GB」's byte count, an HLAE version, a
 *   file name. Put a Chinese label beside it saying what it is.
 *
 * · **`camera_collision_unverified` does not mean a collision was found.** It
 *   reports that these shots' coordinates *cannot be checked against map
 *   geometry until they have been previewed in game*. It is a `warning` with
 *   the observer shots listed in `affected_item_ids` when the plan has any, an
 *   `ok` when every shot is POV, and it is **never `blocked`**. The board's
 *   「碰撞几何未知（影响 1 个镜头）」 is the right wording; 「检测到碰撞」 is not.
 *
 * ── per-shot presentation, read correctly ─────────────────────────────────
 *
 * · **`presentation: null` means 「跟随全局默认」, not 「关掉」.** Block D must
 *   render the two differently — a followed default is the global value shown
 *   as inherited, with a way to detach; an override is the shot's own value,
 *   with a way to reset. `resolveShotPresentation` returns both halves.
 *
 * · **`camera_fov` and `viewmodel_fov` are POV-only.** A non-POV shot that
 *   sends a non-neutral value is **rejected with 400** — the backend refuses
 *   rather than ignoring, because 「界面提供了一个不起作用的滑块」 is the worse
 *   failure. Block D disables the two fields for an observer shot **and writes
 *   the reason**: 「观察者镜头的视野由相机路径逐帧决定，也没有持枪视野」. The
 *   other four (闪光 / HUD / 雷达 / 语音) apply to both. `presentationFieldsFor`
 *   is the table.
 *
 * · **闪光强度 is `flash_alpha / 255`, and the direction is *not* inverted.**
 *   Worth stating because the compiler downstream inverts it: `flash_alpha` is
 *   *remaining* flash, and `crates/hlae/src/scene_presentation.rs` emits
 *   `mirv_noflash (1 - alpha/255)`. Its own test pins the mapping — 「40%
 *   remaining flash alpha is 60% suppression」, `flash_alpha: 102` →
 *   `mirv_noflash 0.6`. So the board's 「闪光强度 40%」 is `flash_alpha` 102,
 *   and `flashAlphaToPercent` / `percentToFlashAlpha` below are the two
 *   directions, unit-tested for the round trip.
 *
 * ── the second door: from a highlight to `/agent` ─────────────────────────
 *
 * §10.6 settled the address and phase 3f-be supplied the payload. 「用 Agent 制
 * 作视频」 now creates the plan and navigates:
 *
 *     const plan = await createPlan.mutateAsync({ title, status: 'draft',
 *                                                 shots, origin: null });
 *     navigate(agentPlanHandoff(plan.id));
 *
 * with every shot carrying `recording: { demo_id, player_id, highlight_id,
 * victim_pov, pre_roll_seconds, post_roll_seconds, presentation }`
 * (`AgentShotRecording`). That binding is what `POST /api/agent/plans/{id}/
 * recording-plan` needs, and it is why the note at the foot of
 * `pages/agent/agentHandoff.ts` — 「`AgentPlanShot` 没有 demo_id，所以确认并生成
 * 视频只能禁用」 — is out of date and must be rewritten.
 *
 * A highlight with no `demo_id` cannot be bound. **Disable the action and say
 * why**; do not create a plan whose shots are unbound and hand it over, because
 * the receiving page can then only refuse it (422 `agent_plan_shots_unbound`).
 * `agentPlanShotsNeedingBinding` is how *this* page finds the same shots when
 * the refusal happens anyway.
 *
 * ── backend gaps found while writing this contract ────────────────────────
 *
 *  1. **The 422 body's `shots` array never reaches the renderer.** The desktop
 *     bridge flattens every error body to `{status, code, message}`
 *     (`bridge.rs`, `DesktopCommandError::from_problem`); the route documents
 *     this itself. The page reads the same fact from the plan it already holds
 *     — `recording === null` is an unbound shot — and uses `code` for the
 *     sentence. Not worked around, just handled.
 *  2. **A plan lease is not addressable.** `plan_id` cannot be re-fetched;
 *     `GET /api/recording/plans/{id}` does not exist. A reload of
 *     `/recording/<planId>` therefore re-plans from the Agent plan, which is
 *     correct here (the plan id in the address is the *Agent* plan) but means
 *     an in-flight lease cannot survive a reload.
 *  3. **No per-shot preview frame.** The director preview is a camera-path
 *     schematic drawn from `DirectorPlan`, and the board says so
 *     (「不是最终画质」). Nothing renders a shot to an image; the only way to see
 *     it is the in-game preview.
 *  4. **`DirectorShot` has no link back to a single `RecordingRequest`** — it
 *     carries `source_item_ids`, plural, because adjacent shots merge. A
 *     selected shot maps to *at most one* director shot and a director shot may
 *     cover several; `directorShotForItem` does that lookup honestly rather
 *     than assuming a bijection.
 *  5. **No 「应用到全部」 on the wire.** It is N independent shot edits performed
 *     locally and re-planned once, not one atomic call — so a partial failure
 *     is impossible only because there is no call to fail.
 *
 * ── house rules ───────────────────────────────────────────────────────────
 *
 * Three states always: Skeleton while loading (**never an invented
 * percentage**), EmptyState with a real recovery action, an in-place Notice
 * with a retry on failure. A field the backend does not have is omitted, never
 * rendered as `0`. Service-backed actions use `props.service`. §8 folding uses
 * `props.collapsed`, and **the main action stays visible at every width** — it
 * never goes into an overflow menu. Run `node scripts/check-web-layers.mjs`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure below this line, so `recordingContract.test.ts` covers it in the `unit`
 * project with no DOM and no router.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { ComponentType } from 'react';

import type { ServiceActionState } from '../../data/serviceAction';
import type { RecordingPreflightGate, RecordingStartConfirmation } from '../../data/recording';
import type {
  AgentPlan,
  AgentPlanShot,
  AppConfig,
  DirectorPlan,
  DirectorShot,
  RecordingPlanResponse,
  RecordingPreflightCode,
  RecordingPresentation,
  RecordingRequest,
  RecordingVoicePolicy,
} from '../../shared/desktop/dto';

/* ── the address ─────────────────────────────────────────────────────────── */

/**
 * `/recording` or `/recording/<agentPlanId>`.
 *
 * A path segment rather than a query parameter because §7's table says so, and
 * because a plan is the page's subject rather than a filter on it.
 */
export function recordingHref(agentPlanId: string | null): string {
  return agentPlanId === null ? '/recording' : `/recording/${encodeURIComponent(agentPlanId)}`;
}

/** Where 「开始录制」 lands. A running recording is a task, and a task has its
 *  own address (§7) — this page does not grow a second one. */
export function recordingTaskHref(jobId: string): string {
  return `/delivery/task/${encodeURIComponent(jobId)}`;
}

/* ── flash: the one conversion that is easy to get backwards ─────────────── */

/** The CS2 scale `flash_alpha` is expressed in. */
export const FLASH_ALPHA_MAX = 255;

/**
 * 「闪光强度 40%」 from a `flash_alpha` of 102.
 *
 * `flash_alpha` is the **remaining** flash — full value means the flashbang is
 * fully rendered — so the percentage is a plain `alpha / 255`, *not* an
 * inversion. The inversion happens one layer further down, where
 * `crates/hlae/src/scene_presentation.rs` emits `mirv_noflash (1 - alpha/255)`;
 * that is the console command's convention, not this field's.
 *
 * Rounded to whole percent, because that is what the control shows. Out-of-range
 * input is clamped rather than rejected: a slider cannot produce one, but a
 * stored value from an older build could.
 */
export function flashAlphaToPercent(flashAlpha: number): number {
  if (!Number.isFinite(flashAlpha)) return 100;
  const clamped = Math.min(FLASH_ALPHA_MAX, Math.max(0, flashAlpha));
  return Math.round((clamped / FLASH_ALPHA_MAX) * 100);
}

/**
 * The other direction. Answers an integer in `0..=255`, because the wire field
 * is a `u8` and a fractional alpha is rejected by the deserializer.
 */
export function percentToFlashAlpha(percent: number): number {
  if (!Number.isFinite(percent)) return FLASH_ALPHA_MAX;
  const clamped = Math.min(100, Math.max(0, percent));
  return Math.round((clamped / 100) * FLASH_ALPHA_MAX);
}

/* ── presentation: the six controls, and which of them apply ─────────────── */

/** `crates/domain/src/recording.rs`, mirrored. A non-POV shot must send these. */
export const NEUTRAL_CAMERA_FOV = 90;
export const NEUTRAL_VIEWMODEL_FOV = 68;
export const CAMERA_FOV_RANGE = { min: 60, max: 140 } as const;
export const VIEWMODEL_FOV_RANGE = { min: 54, max: 68 } as const;

export type CameraStyle = RecordingRequest['camera_style'];

/** The one style that draws a first-person view. Everything else is a camera
 *  path with a per-keyframe field of view and no viewmodel at all. */
export function isPovStyle(style: CameraStyle): boolean {
  return style === 'pov';
}

export type PresentationField =
  | 'camera_fov'
  | 'viewmodel_fov'
  | 'flash_alpha'
  | 'show_hud'
  | 'show_radar'
  | 'voice';

export interface PresentationFieldState {
  readonly editable: boolean;
  /** Why not, when not. Rendered beside the disabled control — 「禁用并写明
   *  原因」 applies to a field as much as to a button. */
  readonly disabledReason?: MessageDescriptor;
}

/**
 * Which of the six controls block D may offer for a given camera style.
 *
 * Not a boolean the caller derives: the reason is part of the answer, and a
 * page that computed `style !== 'pov'` itself would have to write the sentence
 * again — differently — in two places.
 */
export function presentationFieldsFor(
  style: CameraStyle,
): Readonly<Record<PresentationField, PresentationFieldState>> {
  const povOnly: PresentationFieldState = isPovStyle(style)
    ? { editable: true }
    : {
      editable: false,
      disabledReason: msg`观察者镜头的视野由相机路径逐帧决定，也不会绘制持枪画面`,
    };

  return {
    camera_fov: povOnly,
    viewmodel_fov: povOnly,
    flash_alpha: { editable: true },
    show_hud: { editable: true },
    show_radar: { editable: true },
    voice: { editable: true },
  };
}

export type RecordingDefaults = AppConfig['recording'];

/**
 * The global defaults a shot with `presentation: null` follows.
 *
 * `AppConfig.recording` still carries voice as two booleans while the wire type
 * carries the three-member enum, so the mapping is spelled here — mirrored
 * exactly from `crates/runtime/src/hlae_recording.rs`: mute wins, then isolate,
 * then everyone. The fourth combination (both set) cannot be stored — config
 * validation rejects it — so it needs no branch of its own beyond mute winning.
 */
export function globalPresentationDefaults(
  defaults: RecordingDefaults,
): RecordingPresentation {
  const voice: RecordingVoicePolicy = defaults.mute_voice
    ? 'muted'
    : defaults.isolate_target_voice
      ? 'target_only'
      : 'all_players';

  return {
    camera_fov: defaults.camera_fov,
    viewmodel_fov: defaults.viewmodel_fov,
    flash_alpha: defaults.flash_alpha,
    show_hud: defaults.show_hud,
    show_radar: defaults.show_radar,
    voice,
  };
}

export interface ResolvedPresentation {
  /** What will actually be recorded. */
  readonly value: RecordingPresentation;
  /**
   * `false` when the shot carries no presentation of its own — the values above
   * came from `AppConfig.recording` and will keep tracking it.
   *
   * This is the distinction the artboard's controls must show. 「用户从没碰过
   * 这些控件」 and 「用户把它们设成了刚好等于今天的全局默认」 are different
   * states with different futures, and the wire keeps them apart with `null`
   * precisely so the interface can too.
   */
  readonly overridden: boolean;
}

/** Expands `presentation ?? global`, and says which of the two it was. */
export function resolveShotPresentation(
  presentation: RecordingPresentation | null | undefined,
  defaults: RecordingDefaults,
): ResolvedPresentation {
  if (presentation === null || presentation === undefined) {
    return { value: globalPresentationDefaults(defaults), overridden: false };
  }
  return { value: presentation, overridden: true };
}

/**
 * Forces the two POV-only fields back to neutral for a non-POV shot.
 *
 * Call this before sending, every time. The backend answers 400 for a
 * non-neutral field of view on an observer shot, and the failure it produces —
 * a rejected plan with an English validation message — is much worse than the
 * silent normalisation it replaces, because the offending value came from a
 * control the interface had already disabled.
 */
export function presentationForStyle(
  presentation: RecordingPresentation,
  style: CameraStyle,
): RecordingPresentation {
  if (isPovStyle(style)) return presentation;
  return {
    ...presentation,
    camera_fov: NEUTRAL_CAMERA_FOV,
    viewmodel_fov: NEUTRAL_VIEWMODEL_FOV,
  };
}

/* ── the preflight signature ─────────────────────────────────────────────── */

/**
 * A stable summary of the shots a check list was run against.
 *
 * Handed to `useRecordingPreflight(planId, signature)`, whose held answer
 * disappears the moment this string changes. Every field that can change what a
 * check measures is in it — the order (the director merges adjacent shots), the
 * Demo, the tick window, the camera style (which decides whether
 * `camera_collision_unverified` has anything to say) and the whole presentation
 * (which feeds the plan lease's own sha256).
 *
 * Deliberately not `JSON.stringify(items)`: key order in a decoded object is
 * stable in practice but not by contract, and a signature that changes when
 * nothing did would re-probe the disk for free.
 */
export function recordingShotSignature(items: readonly RecordingRequest[]): string {
  return items
    .map((item) => {
      const p = item.presentation;
      const presentation = p === null || p === undefined
        ? '-'
        : [p.camera_fov, p.viewmodel_fov, p.flash_alpha, p.show_hud, p.show_radar, p.voice].join(',');
      return [
        item.id,
        item.demo_id,
        item.player_id,
        item.start_tick,
        item.end_tick,
        item.pre_roll_seconds,
        item.post_roll_seconds,
        item.victim_pov,
        item.camera_style,
        presentation,
      ].join('|');
    })
    .join('\n');
}

/* ── director shots ──────────────────────────────────────────────────────── */

/**
 * The director shot a plan item ended up inside, or `null`.
 *
 * `DirectorShot.source_item_ids` is plural because 「相邻镜头会在导播预览中合
 * 并」: several items can share one director shot, and an item that was dropped
 * has none. So this is a lookup, not an index — block B must be able to say
 * 「这个片段与上一个合并了」 instead of drawing an empty preview.
 */
export function directorShotForItem(
  director: DirectorPlan,
  itemId: string,
): DirectorShot | null {
  return director.shots.find((shot) => shot.source_item_ids.includes(itemId)) ?? null;
}

/** How many plan items the director folded into one shot. `1` is the normal
 *  case; anything larger is what the merge notice is about. */
export function mergedItemCount(shot: DirectorShot): number {
  return shot.source_item_ids.length;
}

/* ── the Agent plan's unbound shots ──────────────────────────────────────── */

/**
 * The shots that keep an Agent plan from becoming a recording queue.
 *
 * This is the client-side half of the 422 whose body the bridge flattens: a
 * live shot (`removed_by === null`) with `recording === null` is exactly what
 * the server refuses on. Soft-removed shots are excluded here for the same
 * reason the server excludes them — a removal that stays undoable must not
 * block a recording of what is left.
 *
 * Returns the shots themselves, not ids: the page marks cards and needs titles.
 */
export function agentPlanShotsNeedingBinding(plan: AgentPlan): AgentPlanShot[] {
  return plan.shots.filter(
    (shot) => shot.removed_by === null && (shot.recording === null || shot.recording === undefined),
  );
}

/** Whether any shot survives removal at all — the other 422
 *  (`agent_plan_not_recordable`). */
export function agentPlanHasRecordableShot(plan: AgentPlan): boolean {
  return plan.shots.some((shot) => shot.removed_by === null);
}

/* ── the eight checks ────────────────────────────────────────────────────── */

export interface PreflightCheckMeta {
  readonly label: MessageDescriptor;
  /**
   * One line saying what the row is measuring, for the cases where the label
   * alone is a term of art. Shown under the label, never instead of `detail`.
   */
  readonly hint: MessageDescriptor;
}

/**
 * The closed set of eight, labelled once.
 *
 * No `context` tag: none of these phrases collides with an existing catalogue
 * entry, and a context group opened for a table that does not fork only splits
 * translations that should move together. If one of these words later gains a
 * second meaning elsewhere, tag **this whole table** then, not the one member.
 *
 * `camera_collision_unverified`'s wording is load-bearing — see the module
 * note. It reports an unknown, not a detected collision.
 */
export const PREFLIGHT_CHECK: Readonly<Record<RecordingPreflightCode, PreflightCheckMeta>> = {
  game_ready: {
    label: msg`CS2 已就绪`,
    hint: msg`找到了可用的游戏程序，录制会以离线模式启动它`,
  },
  capture_component_ready: {
    label: msg`采集组件已准备`,
    hint: msg`受管的采集组件已下载并通过校验`,
  },
  demo_content_matches: {
    label: msg`Demo 内容一致`,
    hint: msg`每一份 Demo 都还和分析时的内容相同`,
  },
  output_directory_writable: {
    label: msg`输出目录可写`,
    hint: msg`输出目录能写入，且剩余空间够这次录制`,
  },
  spectator_evidence_complete: {
    label: msg`观察者证据完整`,
    hint: msg`每个选手 POV 镜头都能在解析结果里找到对应的观察位`,
  },
  encoder_available: {
    label: msg`编码器可用`,
    hint: msg`系统里注册了录制需要的视频与音频编码器`,
  },
  tick_range_within_demo: {
    label: msg`tick 区间在 Demo 范围内`,
    hint: msg`每个片段的时间窗口都落在 Demo 自身的长度里`,
  },
  camera_collision_unverified: {
    label: msg`碰撞几何未知`,
    hint: msg`运动镜头的坐标要进游戏预览之后才能与地图几何核对，这里只是提醒，不会拦住录制`,
  },
};

/* ── what every block receives ───────────────────────────────────────────── */

/** The pair `Button` understands. Same shape the other pages use. */
export interface RecordingGuardedAction {
  readonly disabled: boolean;
  readonly disabledReason?: string;
}

/**
 * The one selection. See invariant 2.
 *
 * `shotId` is a `RecordingRequest.id` — which, for a plan built from an Agent
 * plan, is also the `AgentPlanShot.id` it came from (the server reuses the shot
 * identity so a queue item stays traceable to the card on screen).
 */
export interface RecordingSelection {
  readonly shotId: string | null;
  readonly select: (shotId: string | null) => void;
}

/**
 * The plan lease as the shell holds it.
 *
 * `dirty` is invariant 3: the shots on screen have been edited since this lease
 * was minted, so the lease no longer describes them. It is *not* the same as
 * `expired` — a fresh lease can be dirty and a clean one can expire — and the
 * two produce different sentences and different recovery actions.
 */
export interface RecordingPlanState {
  readonly plan: RecordingPlanResponse | null;
  /** The shots as edited, which is what block A and D render. Equal to
   *  `plan.items` until the first edit. */
  readonly items: readonly RecordingRequest[];
  readonly loading: boolean;
  readonly error: unknown;
  /** Edited since the lease was minted. Disables 开始录制 with a written reason
   *  and voids the check list. */
  readonly dirty: boolean;
  /** The five-minute lease ran out. */
  readonly expired: boolean;
  /** Milliseconds left, for the countdown. `null` when there is no plan. */
  readonly remainingMs: number | null;
  /** 「重新生成预览计划」. The only way a new lease is minted — never automatic. */
  readonly replan: () => void;
  /** Records an edit to one shot. Sets `dirty`; writes nothing to the service. */
  readonly editShot: (shotId: string, patch: Partial<RecordingRequest>) => void;
  /** 「应用到全部」 — the same patch onto every shot, as N local edits. There is
   *  no server call behind it (gap 5). */
  readonly editEveryShot: (patch: Partial<RecordingRequest>) => void;
  /** Reorder, for block A's 拖动可排序. */
  readonly reorder: (from: number, to: number) => void;
  readonly removeShot: (shotId: string) => void;
}

/**
 * 「开始录制」, held by the shell. See invariant 1.
 *
 * A block renders `action` and calls `start()`; **no block calls
 * `confirmRecordingStart` or `useExecuteRecordingPlan`**. `start` is what runs
 * after the confirmation dialog resolves, and the shell is the only thing that
 * mints the branded confirmation the data layer demands.
 */
export interface RecordingStartDesk {
  readonly action: RecordingGuardedAction;
  /** Label suffix, e.g. 「开始录制 4 个片段」's count. `null` when there is no
   *  plan to count. */
  readonly shotCount: number | null;
  readonly starting: boolean;
  readonly error: unknown;
  /** Runs the execute. Takes the acknowledgement the dialog collected. */
  readonly start: (offlineInsecureAcknowledged: boolean) => void;
}

/**
 * Handed to every block. Small on purpose:
 *
 *   *No plan document beyond `props.plan`.* Blocks do not fetch a lease — there
 *   is only one and it is a mutation result, so it cannot be deduplicated by a
 *   key the way `useAgentPlan` can.
 *
 *   *No per-block preflight.* One `RecordingPreflightGate`, because `canStart`
 *   is a page-level answer and two gates would probe the disk twice and
 *   disagree.
 */
export interface RecordingBlockProps {
  /** The Agent plan this recording plan came from. `null` on the bare
   *  `/recording` list, which renders no blocks. */
  readonly agentPlanId: string | null;
  readonly plan: RecordingPlanState;
  readonly selection: RecordingSelection;
  /** The one check list. See invariant 4. */
  readonly preflight: RecordingPreflightGate;
  /** The one 开始录制. See invariant 1. */
  readonly start: RecordingStartDesk;
  /** 「不隐藏、不静默失败」, derived once. */
  readonly service: ServiceActionState;
  /** The §8 observation, made once by the shell. */
  readonly collapsed: boolean;
}

export type RecordingBlock = ComponentType<RecordingBlockProps>;

/* Types only, so the module stays free of anything the `unit` project would
   need a DOM for. `RecordingStartConfirmation` appears here purely to state
   that it exists and that the shell — not a block — is the thing that mints
   one. */
export type { RecordingStartConfirmation };
