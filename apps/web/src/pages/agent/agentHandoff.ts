/*
 * pages/agent — how another page hands work to `/agent`.
 *
 * §10.5 gap 18 left this open: 「高光页的『用 Agent 制作视频』只能
 * navigate('/agent')，带不走选中的 N 条」. Phase 3e is where it gets decided,
 * and the decision has to fit §7's three parameters — `?plan=&session=&mode=`
 * — because a fourth one would put the route table and the implementation out
 * of step, and §7 is the table.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  The decision: the parameter is `?plan=`. The sender creates the object.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 「用 Agent 制作视频」 on a selection of N highlights calls `createAgentPlan`
 * with those N as `AgentPlanShot[]` and then navigates to the plan:
 *
 *     const plan = await createPlan.mutateAsync({ title, status: 'draft',
 *                                                 shots, origin: null });
 *     navigate(agentPlanHandoff(plan.id));
 *
 * Three reasons this is the shape rather than a list of clip ids in the query:
 *
 * **A plan already is N shots.** §4.5.2 defines `AgentPlan` as an ordered list
 * of shots with a title, a status and a revision. A selection of N highlights
 * is the same object one step earlier, so the handoff needs no new type — and
 * the receiving page needs no branch for 「我是从高光页来的」.
 *
 * **A created object survives what a query parameter does not.** An address
 * carrying `?clips=a,b,c` breaks the moment the user reloads into a different
 * workspace, is meaningless to a second session, and cannot be referenced by
 * §4.5.1's bidirectional record — there is no `AgentObjectKind` for 「三条高
 * 光」. A plan id is addressable, referencable, and still there tomorrow.
 *
 * **§4.5.1 says a session takes over an object rather than owning it.** The
 * artboard is explicit: 「新建一条会话不会丢掉上下文，也不需要重新生成方案——
 * 它可以直接接管当前那个」. For a session to take an object over, the object has
 * to exist before the navigation. Creating it on the sending side is what makes
 * 「接管」 possible; creating it on arrival would make `/agent` a page that
 * silently writes to the database because you opened it.
 *
 * ── What the receiving side already does ──────────────────────────────────
 *
 * Nothing new. A freshly created plan is `draft` / `awaiting_confirmation`, so
 * it appears in `listAgentWorkspaceReferences().pending_plans`, which is the
 * first group the 新建会话 picker draws — the artboard's accent row 「等待确认
 * · #P-118 · 这条会话现在可以改它，不需要重新生成」. So the sender creates and
 * navigates, and the drawer offers to attach a session to it.
 *
 * ── The payload, which phase 3f-be supplied ───────────────────────────────
 *
 * This section used to say the opposite. Until phase 3f-be an `AgentPlanShot`
 * carried no `demo_id` / `player_id`, so a plan built from N highlights could
 * not name the footage it came from and 「确认并生成视频」 had to stay disabled
 * on it. **That is no longer true.** `AgentPlanShot.recording`
 * (`AgentShotRecording`) now carries `demo_id`, `player_id`, `highlight_id`,
 * `victim_pov`, the two roll-ins and the per-shot `presentation`, and
 * `POST /api/agent/plans/{id}/recording-plan` turns a bound plan straight into
 * the same `RecordingPlanResponse` `planRecording` produces.
 *
 * So the handoff creates a **bound** plan: `agentPlanShotFromHighlight` fills
 * `recording` for every shot, and `agentPlanDraftFromHighlights` refuses —
 * loudly, with a reason — rather than creating an unbound one. Handing over a
 * plan whose shots have no binding would produce a page that can only answer
 * 422 `agent_plan_shots_unbound`, which is a worse outcome than a disabled
 * button that says which fact is missing.
 *
 * Two of the bindings are the backend's own rules rather than preferences, and
 * both are checked here because the failure they cause is a 400 from a write
 * the user did not know they were making:
 *
 *   · `player_id` must be a canonical non-zero 17-digit SteamID64
 *     (`AgentShotRecording::normalize`). An analysis that identifies a player
 *     some other way cannot be bound.
 *   · `end_tick > start_tick`, strictly — a bound shot claims to be recordable,
 *     so `RecordingRequest::validate` is applied to it at creation time
 *     (`AgentPlanShot::normalize`), and a zero-length window that would be a
 *     legal placeholder on an unbound shot is rejected on a bound one.
 *
 * The *view* comes from the caller. `AgentShotView` is `observer | player_pov`
 * and a highlight does not say which one it wants, so something has to choose:
 * that something is 设置 · AI 与 Agent 「默认视角」, and 「08」's inspector still
 * changes it per shot. It was hard-coded to `observer` for a round, which is
 * the same decision without a way to change it.
 */

import type { AgentPlanCreate, AgentPlanShot, AgentShotView } from '../../shared/desktop/dto';
import {
  DEFAULT_AGENT_MODE,
  agentHref,
  type AgentMode,
} from './agentContract';

export interface AgentHandoffOptions {
  /**
   * Continue in an existing conversation. Omitted (the normal case for a
   * handoff from another page) the address names no session, and the drawer's
   * 新建会话 pane opens on the plan that just arrived.
   */
  readonly session?: string | null | undefined;
  readonly mode?: AgentMode | undefined;
}

/**
 * The address 「用 Agent 制作视频」 navigates to, once the sending page has
 * turned its selection into a plan.
 *
 * Written as a function rather than a documented string so the three
 * parameters stay `agentContract.ts`'s business: a caller that builds the query
 * itself is a caller that will still be building it after §7 changes.
 */
export function agentPlanHandoff(planId: string, options: AgentHandoffOptions = {}): string {
  return agentHref({
    plan: planId,
    session: options.session ?? null,
    mode: options.mode ?? DEFAULT_AGENT_MODE,
  });
}

/* ── building the plan the handoff hands over ────────────────────────────── */

/**
 * One highlight, in the shape this module needs to bind a shot to it.
 *
 * Deliberately not `Highlight` from the wire and not `HighlightCandidate` from
 * `domain/match`: the first carries eleven fields this does not use, the second
 * has dropped `player_id` and never had `demo_id`. A caller assembles these
 * facts from whatever it is holding, and the assembly is where a missing one
 * becomes visible.
 */
export interface HighlightHandoffSource {
  readonly highlightId: string;
  readonly title: string;
  /** `null` when the caller cannot say which Demo this came from. */
  readonly demoId: string | null;
  /** SteamID64. Checked, because the backend rejects anything else. */
  readonly playerId: string;
  readonly startTick: number;
  readonly endTick: number;
  /**
   * The analysis' own tick rate. `null` when it is not known; the shot then
   * carries `duration_seconds: 0`, which the backend accepts. Assuming 64 would
   * write a wrong number into stored data on every 128-tick Demo.
   */
  readonly tickRate: number | null;
  /** 「1v3 残局」 — why this moment is worth a shot. Optional. */
  readonly rationale?: string | undefined;
}

/** Why a selection cannot become a bound plan. One member per missing fact. */
export type HandoffRefusal = 'no_selection' | 'no_demo' | 'no_player' | 'empty_window';

/**
 * `AgentShotRecording::normalize`'s rule, mirrored so a button can be disabled
 * before the write instead of explained after it.
 */
export function isSteamId64(value: string): boolean {
  if (!/^\d{17}$/u.test(value)) return false;
  return Number(value) !== 0;
}

/**
 * One highlight → one bound plan shot, or `null`.
 *
 * `id` is a fresh identity rather than the highlight's own: a shot and a
 * highlight are different objects with different lifetimes — a plan may hold
 * two shots of the same moment — and plan shot identities must be unique within
 * a plan (`normalize_shots`). The highlight travels as `recording.highlight_id`,
 * which is where the backend looks for it, and as an evidence reference, which
 * is where a reader does.
 *
 * `params` is `{}` and not `null`: the backend requires a JSON object.
 */
export function agentPlanShotFromHighlight(
  source: HighlightHandoffSource,
  newId: () => string,
  view: AgentShotView,
): AgentPlanShot | null {
  if (handoffRefusalFor(source) !== null) return null;
  const demoId = source.demoId ?? '';

  const ticks = source.endTick - source.startTick;
  const rate = source.tickRate;
  const durationSeconds = rate !== null && Number.isFinite(rate) && rate > 0 ? ticks / rate : 0;

  return {
    id: newId(),
    title: source.title,
    /* The view is the caller's — 设置 · AI 与 Agent 「默认视角」. This module
       used to hard-code `observer` with a note that choosing here would be
       guessing at a creative decision it had no input for; that setting is the
       input. 「08」's inspector still changes it per shot.

       `kind` stays hard-coded: 镜头类型 has seven members chosen per shot from
       the evidence, and a single default for all of them would be a worse
       guess than the one this comment used to describe.

       `AgentShotView` has no 「受害者」 member either — that one is
       `recording.victim_pov`, and it is off. */
    kind: 'tracking',
    view,
    start_tick: source.startTick,
    end_tick: source.endTick,
    duration_seconds: durationSeconds,
    rationale: source.rationale ?? '',
    evidence_refs: [source.highlightId],
    risks: [],
    source: 'user',
    removed_by: null,
    params: {},
    recording: {
      demo_id: demoId,
      player_id: source.playerId,
      highlight_id: source.highlightId,
      victim_pov: false,
      /* A handoff has no opinion about roll-ins and must not bake today's
         config into stored data. Zero is the neutral value 「08」 then edits. */
      pre_roll_seconds: 0,
      post_roll_seconds: 0,
      /* `null` is 「跟随全局默认」, not 「关掉」 — see `RecordingPresentation`. */
      presentation: null,
    },
  };
}

/** The first fact this highlight is missing, or `null` when it can be bound. */
export function handoffRefusalFor(source: HighlightHandoffSource): HandoffRefusal | null {
  if (source.demoId === null || source.demoId === '') return 'no_demo';
  if (!isSteamId64(source.playerId)) return 'no_player';
  if (!(source.endTick > source.startTick)) return 'empty_window';
  return null;
}

export interface HighlightHandoffInput {
  readonly title: string;
  readonly highlights: readonly HighlightHandoffSource[];
  /** Injected so the builder stays pure and its test is deterministic. */
  readonly newId?: (() => string) | undefined;
}

export type HighlightHandoffDraft =
  | { readonly ok: true; readonly plan: AgentPlanCreate }
  | { readonly ok: false; readonly refusal: HandoffRefusal };

/**
 * A selection of highlights → the `AgentPlanCreate` the handoff sends.
 *
 * **All or nothing.** A selection containing one unbindable highlight is refused
 * rather than silently narrowed: creating a plan with three of the four shots
 * the user selected, and saying nothing, is the kind of quiet difference nobody
 * notices until the video is short. The refusal names the first missing fact so
 * the caller can write one sentence about it.
 *
 * `origin: null` because a handoff happens outside any conversation — §4.5.1's
 * 「不用 Agent 也能完整操作」 in the payload itself. The receiving page's 新建会话
 * pane is where a session takes the plan over.
 */
export function agentPlanDraftFromHighlights(
  input: HighlightHandoffInput,
  view: AgentShotView,
): HighlightHandoffDraft {
  if (input.highlights.length === 0) return { ok: false, refusal: 'no_selection' };

  const newId = input.newId ?? defaultShotId;
  const shots: AgentPlanShot[] = [];
  for (const source of input.highlights) {
    const refusal = handoffRefusalFor(source);
    if (refusal !== null) return { ok: false, refusal };
    const shot = agentPlanShotFromHighlight(source, newId, view);
    if (shot === null) return { ok: false, refusal: 'no_demo' };
    shots.push(shot);
  }

  return {
    ok: true,
    plan: { title: input.title, status: 'draft', shots, origin: null },
  };
}

/**
 * `crypto.randomUUID` where it exists.
 *
 * It exists in the Tauri webview and in jsdom. The fallback is only for an
 * environment without it, and it is deliberately boring: a shot id is a plan-
 * local identity, not a security boundary.
 */
function defaultShotId(): string {
  const source = globalThis.crypto;
  if (source !== undefined && typeof source.randomUUID === 'function') return source.randomUUID();
  const hex = (length: number): string =>
    Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

/*
 * The hook that spends all of this — `useAgentVideoHandoff` — lives in
 * `useAgentVideoHandoff.ts` rather than here, because this module is imported by
 * `agentHandoff.test.ts` in the `unit` project (node, no DOM) and a `useQuery`
 * three imports down would drag the whole desktop bridge into it. Everything
 * above is pure and stays that way.
 */
