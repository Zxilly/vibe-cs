/*
 * Domain layer, 2 of 3 — agent/AgentTranscript.
 *
 * The conversation, in order: bubbles for `user` and `assistant`, a grey line
 * for `workspace_edit`. The dispatch reads `AGENT_ENTRY_KIND[kind].bubble`
 * rather than testing the kind, so the one record of 「哪一种不是气泡」 stays the
 * only record of it.
 *
 * ── Why a list component and not three loose pieces ───────────────────────
 *
 * Because of where the scrollbar goes. A real session runs to dozens of
 * entries inside a 700px window (`domain/density.test.tsx`'s premise), and the
 * page's rule is 「横向滚动必须发生在容器内部」 — vertically the same: this list
 * owns `min-h-0` + `overflow-y-auto`, so a long transcript scrolls inside its
 * column instead of pushing the composer off the bottom of the shell. Three
 * loose components would leave that to each of the three page blocks, and one
 * of them would forget.
 *
 * ── Extras arrive as a render function, not as state ──────────────────────
 *
 * Proposal cards, inline actions and better tool-call labels all depend on
 * things only the page has (the parsed change set, the plan revision, the
 * mutations). They are therefore asked for per entry rather than looked up
 * here: this component still knows nothing and fetches nothing.
 */

import type { ReactNode } from 'react';

import { cn } from '../../design/primitives';
import type { AgentSessionEntry } from '../../shared/desktop/dto';

import { AgentBubble, type AgentInlineAction } from './AgentBubble';
import type { AgentWorkStep } from './AgentWorkTrail';
import { WorkspaceEditLine } from './WorkspaceEditLine';
import { AGENT_ENTRY_KIND } from './types';

/** What the page wants added to one assistant bubble. All parts optional. */
export interface AgentEntryExtras {
  readonly children?: ReactNode | undefined;
  readonly actions?: readonly AgentInlineAction[] | undefined;
  readonly steps?: readonly AgentWorkStep[] | undefined;
}

export interface AgentTranscriptProps {
  readonly entries: readonly AgentSessionEntry[];
  /** Per-entry proposal cards / actions. Called for every entry, bubble or not. */
  readonly renderExtras?: ((entry: AgentSessionEntry) => AgentEntryExtras | undefined) | undefined;
  /**
   * The reply still arriving, which is not an entry yet — `data/sessions.ts`
   * keeps in-flight text out of the cache, so it comes in beside the entries.
   */
  readonly streamingContent?: string | undefined;
  /** Drawn when there are no entries: the caller's `EmptyState`. */
  readonly empty?: ReactNode | undefined;
  /** Accessible name of the log — 「会话 · Kael 的 1v3」. */
  readonly label: string;
  readonly timeZone?: string | undefined;
  readonly className?: string | undefined;
}

export function AgentTranscript({
  entries,
  renderExtras,
  streamingContent,
  empty,
  label,
  timeZone,
  className,
}: AgentTranscriptProps) {
  if (entries.length === 0 && streamingContent === undefined) {
    return (
      <div data-agent-transcript="empty" className={cn('flex min-h-0 flex-1 flex-col', className)}>
        {empty}
      </div>
    );
  }

  return (
    <div
      data-agent-transcript=""
      aria-label={label}
      role="log"
      className={cn('flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto', className)}
    >
      {entries.map((entry) => {
        if (!AGENT_ENTRY_KIND[entry.kind].bubble) {
          /* Narrowed by the record, then by the discriminant so TypeScript can
             see it too — the record is the rule, the check is the proof. */
          return entry.kind === 'workspace_edit' ? (
            <WorkspaceEditLine
              key={entry.id}
              notice={entry.notice}
              at={entry.at}
              {...(timeZone === undefined ? {} : { timeZone })}
            />
          ) : null;
        }

        if (entry.kind === 'workspace_edit') return null;
        const extras = renderExtras?.(entry);

        return (
          <AgentBubble
            key={entry.id}
            entry={entry}
            {...(timeZone === undefined ? {} : { timeZone })}
            {...(extras?.steps === undefined ? {} : { steps: extras.steps })}
            {...(extras?.actions === undefined ? {} : { actions: extras.actions })}
          >
            {extras?.children}
          </AgentBubble>
        );
      })}

      {streamingContent === undefined ? null : (
        <AgentBubble
          streaming
          entry={{ kind: 'assistant', id: 'streaming', at: '', content: streamingContent, tool_calls: [], proposals: [] }}
          {...(timeZone === undefined ? {} : { timeZone })}
        />
      )}
    </div>
  );
}
