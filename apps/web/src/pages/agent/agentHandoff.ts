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
 * ── The one thing this does not fix ───────────────────────────────────────
 *
 * `AgentPlan` carries no Demo and `AgentPlanShot` no `demo_id` / `player_id`
 * (contract gap 1). A plan built from N highlights therefore cannot say which
 * Demo those highlights came from, and so cannot be turned into a
 * `RecordingQueueRequest` — 「确认并生成视频」 stays disabled on it, with the
 * reason the shell already prints. The address is settled; the payload is not,
 * and that is a backend gap rather than something a query parameter can carry.
 */

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
