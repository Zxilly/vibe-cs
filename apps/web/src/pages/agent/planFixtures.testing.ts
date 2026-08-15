/*
 * pages/agent — the fixtures block B's tests share.
 *
 * Built on `domain/agent/agentFixtures.testing.ts` rather than beside it: the
 * shots, the proposal and the notice are already the artboard's own numbers
 * there, and a second 方案 #P-118 with slightly different seconds is how two
 * suites start disagreeing about what the reference says. What is added here is
 * only what a *page* needs and a component does not — the `AgentPlan` envelope
 * (revision, origin trail, baseline) and an `AgentSession` carrying the proposal.
 *
 * No Lingui macros, for the reason the domain fixture file gives: this path is
 * not excluded from extraction, so a macro here would ship fixture copy in the
 * catalogue.
 */

import {
  ASSISTANT_ENTRY,
  PLAN_PROPOSAL,
  PLAN_SHOTS,
  USER_ENTRY,
} from '../../domain/agent/agentFixtures.testing';
import type {
  AgentPlan,
  AgentPlanOrigin,
  AgentSession,
  AgentSessionEntry,
  AgentSessionProposal,
} from '../../shared/desktop/dto';

/**
 * `AgentSessionEntry` is a union, so spreading the shared fixture would widen
 * back to it and lose `proposals`. Narrowed once, here.
 */
const ASSISTANT = ASSISTANT_ENTRY as Extract<AgentSessionEntry, { kind: 'assistant' }>;

/** 「09:47 你在方案上做了 2 处改动」, as the trail records it. */
export const ORIGIN_KAEL: AgentPlanOrigin = {
  at: '2026-08-15T09:47:12.000Z',
  session_id: 'session-kael',
  session_title: 'Kael 的 1v3',
  summary: '在 2 个镜头上做了 3 处改动',
};

export const ORIGIN_EARLIER: AgentPlanOrigin = {
  at: '2026-08-15T09:24:00.000Z',
  session_id: 'session-mirage',
  session_title: 'Mirage 残局重做',
  summary: '镜头 02 由 Dolly 改为 Tracking',
};

/** 方案 #P-118 at 修订 7 — the number the artboard prints in the head. */
export const PLAN: AgentPlan = {
  id: 'P-118',
  title: 'Kael · Mirage 1v3 残局',
  status: 'awaiting_confirmation',
  revision: 7,
  shots: [...PLAN_SHOTS],
  origin: [ORIGIN_EARLIER, ORIGIN_KAEL],
  agent_baseline: {
    revision: 1,
    captured_at: '2026-08-15T09:02:00.000Z',
    shots: [...PLAN_SHOTS],
  },
  created_at: '2026-08-15T09:02:00.000Z',
  updated_at: '2026-08-15T09:47:12.000Z',
};

export function planAt(revision: number, overrides: Partial<AgentPlan> = {}): AgentPlan {
  return { ...PLAN, revision, ...overrides };
}

/**
 * 会话 · Kael 的 1v3, carrying the 2a proposal. `basedOnRevision` is 6 in the
 * fixture, so against `PLAN` (revision 7) every unhandled change is stale —
 * which is exactly the artboard's 修订冲突 panel and the state §4.5.3 ③ is about.
 */
export const SESSION: AgentSession = {
  id: 'session-kael',
  title: 'Kael 的 1v3',
  created_at: '2026-08-15T09:02:00.000Z',
  updated_at: '2026-08-15T09:47:12.000Z',
  entries: [USER_ENTRY, { ...ASSISTANT, proposals: [PLAN_PROPOSAL] }],
  refs: [],
};

/** The same session with the proposal recomputed against a given revision. */
export function sessionBasedOn(revision: number): AgentSession {
  const proposal: AgentSessionProposal = { ...PLAN_PROPOSAL, based_on_revision: revision };
  return {
    ...SESSION,
    entries: [USER_ENTRY, { ...ASSISTANT, proposals: [proposal] }],
  };
}

/** A session with no proposals at all — the panel's 本次变更 block disappears. */
export const SESSION_WITHOUT_PROPOSALS: AgentSession = {
  ...SESSION,
  entries: [USER_ENTRY, ASSISTANT_ENTRY],
};
