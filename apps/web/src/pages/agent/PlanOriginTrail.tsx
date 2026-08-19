/*
 * pages/agent — 「改动来源」: which sessions moved this plan, and what each did.
 *
 * §4.5.1's reverse direction, read off the plan itself. `AgentPlan.origin` is a
 * row *per edit* — 「09:47 · Kael 的 1v3 · 在 2 个镜头上做了 3 处改动」 — which is
 * what 「分别改了什么」 asks for; `useAgentObjectSessions` answers the coarser
 * question 「哪几条会话碰过它」, one row per session, and is the drawer's read.
 * Using the plan's own trail here costs no second request and says more, so the
 * hook stays where the reverse index is actually needed.
 *
 * `session_title` is captured at edit time (dto.ts says so), which is the whole
 * point: 「删除只删对话，它改过的方案留下」, and a trail that lost its names when
 * a session was deleted would make that promise unreadable. Opening the row is
 * still offered — the session may be gone, and a 404 that says so is better than
 * a link this page decided to hide.
 *
 * Newest first. The wire already promises that order; sorting again is two
 * lines and removes a way for the panel to be wrong about the one thing this
 * block is for.
 */

import { Trans } from '@lingui/react/macro';
import type { AgentPlanOrigin } from '../../shared/desktop/dto';

import { Button } from '../../design/primitives';
import { formatAgentTime } from '../../domain/agent';

export interface PlanOriginTrailProps {
  readonly origins: readonly AgentPlanOrigin[];
  /** `?session=`, so the row the user is already in says 当前 instead of 打开. */
  readonly currentSessionId: string | null;
  readonly onOpenSession: (sessionId: string) => void;
}

export function PlanOriginTrail({
  origins,
  currentSessionId,
  onOpenSession,
}: PlanOriginTrailProps) {
  if (origins.length === 0) {
    return (
      <p data-plan-origin-empty="" className="text-xs text-neutral-600">
        <Trans>这份方案还没有被任何会话改动过。</Trans>
      </p>
    );
  }

  const ordered = [...origins].sort((left, right) => right.at.localeCompare(left.at));

  return (
    <ol data-plan-origin-trail="" className="flex flex-col">
      {ordered.map((origin, index) => {
        const current = origin.session_id === currentSessionId;
        return (
          <li
            // `at` alone is not unique — two edits can land in the same second —
            // and the trail never reorders, so the position completes the key.
            key={`${origin.at}:${origin.session_id}:${String(index)}`}
            data-plan-origin={origin.session_id}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-divider py-2 last:border-b-0"
          >
            <span className="flex-none font-mono text-xs text-neutral-600">
              {formatAgentTime(origin.at)}
            </span>
            <span className="min-w-0 truncate text-sm">{origin.session_title}</span>
            {current ? (
              <span className="flex-none text-2xs text-accent-800">
                <Trans>当前</Trans>
              </span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="flex-none"
                onClick={() => {
                  onOpenSession(origin.session_id);
                }}
              >
                <Trans>打开这条对话</Trans>
              </Button>
            )}
            <p className="w-full text-xs leading-normal text-neutral-700">{origin.summary}</p>
          </li>
        );
      })}
    </ol>
  );
}
