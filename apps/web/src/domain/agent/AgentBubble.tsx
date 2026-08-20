/*
 * Domain layer, 2 of 3 — agent/AgentBubble.
 *
 * The two entry kinds that *are* bubbles. `AGENT_ENTRY_KIND[kind].bubble` is
 * the record of which those are, and the third — `workspace_edit` — is
 * deliberately not this component: §4.5.2 says 「通知不进入对话气泡流，默认渲染
 * 为一行系统灰字」, so it is `WorkspaceEditLine`. That split is one of the two
 * reasons §1 rules out `@assistant-ui/react`, which is why it is drawn here by
 * hand and not looked for in a library.
 *
 *   user       right-aligned, accent frame on the accent plate, 78% max width
 *   assistant  left, hairline frame, 82%, and it may carry three more things:
 *              its tool calls (as an `AgentWorkTrail`), whatever the page puts
 *              inside it (proposal cards), and a row of inline actions
 *              (「不用」「加上」 on the 手动编辑 artboard)
 *
 * ── Tool calls print their names and nothing else ─────────────────────────
 *
 * `AgentSessionToolCall` is `{ name, input: unknown, output: unknown }`. The
 * name is the only typed thing in it, so the trail is built from names — no
 * attempt to render `input` as 「读取了第 21 回合」, which is exactly the kind of
 * guess `agentContract.ts` gap 7 warns about. A caller that *can* label them
 * better passes `steps` and this component uses those instead.
 *
 * ── Streaming ─────────────────────────────────────────────────────────────
 *
 * `streaming` marks a bubble whose text is still arriving: it gets `aria-busy`,
 * a caret, and **no timestamp**, because the entry it will become does not
 * exist yet. `data/sessions.ts` keeps the in-flight text out of the query cache
 * for its own reasons; this is the other end of that decision.
 */

import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import type { ReactNode } from 'react';

import { Button, cn } from '../../design/primitives';
import { Skeleton } from '../../design/data';
import type { AgentSessionEntry } from '../../shared/desktop/dto';

import { AgentWorkTrail, type AgentWorkStep } from './AgentWorkTrail';
import { formatAgentTime } from './agentClock';
import { AGENT_ENTRY_KIND } from './types';

/** The three arms of `AgentSessionEntry`, named so callers can narrow once. */
export type AgentUserEntry = Extract<AgentSessionEntry, { kind: 'user' }>;
export type AgentAssistantEntry = Extract<AgentSessionEntry, { kind: 'assistant' }>;
export type AgentWorkspaceEditEntry = Extract<AgentSessionEntry, { kind: 'workspace_edit' }>;

/** 「不用」/「加上」 — an action the Agent offered inside its own message. */
export interface AgentInlineAction {
  readonly id: string;
  readonly label: ReactNode;
  readonly onAction: () => void;
  /** The one the sentence recommends. At most one per row, like a dialog. */
  readonly primary?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly disabledReason?: string | undefined;
}

export interface AgentBubbleProps {
  readonly entry: AgentUserEntry | AgentAssistantEntry;
  /** Replaces the entry's tool calls when the caller can label them properly. */
  readonly steps?: readonly AgentWorkStep[] | undefined;
  /** Proposal cards and anything else the page draws under the text. */
  readonly children?: ReactNode | undefined;
  readonly actions?: readonly AgentInlineAction[] | undefined;
  /** The text is still arriving. No timestamp, and the bubble is marked busy. */
  readonly streaming?: boolean | undefined;
  readonly timeZone?: string | undefined;
  readonly className?: string | undefined;
}

export function AgentBubble({
  entry,
  steps,
  children,
  actions,
  streaming = false,
  timeZone,
  className,
}: AgentBubbleProps) {
  const { i18n } = useLingui();

  const meta = AGENT_ENTRY_KIND[entry.kind];
  const mine = entry.kind === 'user';
  const turnStatus = entry.kind === 'assistant' ? (entry.status ?? 'completed') : 'completed';
  const trail =
    steps ??
    (entry.kind === 'assistant'
      ? entry.tool_calls.map((call, position) => ({
          id: `${call.name}-${String(position)}`,
          /* The server's own identifier, in the mono face because it is one. */
          label: <span className="font-mono text-xs">{call.name}</span>,
        }))
      : []);

  return (
    <article
      data-agent-bubble={entry.kind}
      data-entry={entry.id}
      {...(streaming || turnStatus === 'pending' || turnStatus === 'streaming'
        ? { 'aria-busy': true }
        : {})}
      {...(streaming
        ? { 'data-bubble-state': 'streaming' }
        : turnStatus === 'completed' ? {} : { 'data-bubble-state': turnStatus })}
      className={cn(
        'flex min-w-0 flex-col gap-2 border p-3 text-sm leading-normal',
        // One `max-w` per branch: two arbitrary values of the same utility would
        // race in the generated stylesheet rather than the class attribute.
        mine ? 'ml-auto max-w-[78%] border-accent bg-accent-100' : 'max-w-[82%] border-divider',
        className,
      )}
    >
      <p className="flex items-center gap-2 text-2xs text-neutral-600">
        <span>{i18n._(meta.label)}</span>
        {streaming || entry.at === '' ? null : (
          <time dateTime={entry.at} className="font-mono">
            {formatAgentTime(entry.at, timeZone === undefined ? {} : { timeZone })}
          </time>
        )}
      </p>

      {entry.content === '' && (streaming || turnStatus === 'pending' || turnStatus === 'streaming') ? (
        <Skeleton width="62%" />
      ) : entry.kind === 'assistant' && turnStatus === 'failed' ? (
        <p data-bubble-content="" className="min-w-0 text-fail-text">
          {entry.error ?? i18n._(TURN_FAILED)}
        </p>
      ) : entry.kind === 'assistant' && turnStatus === 'cancelled' ? (
        <p data-bubble-content="" className="min-w-0 text-neutral-600">
          {i18n._(TURN_CANCELLED)}
        </p>
      ) : (
        <p data-bubble-content="" className="min-w-0 whitespace-pre-wrap">
          {entry.content}
          {streaming ? (
            <span aria-hidden="true" className="ml-0.5 inline-block w-1.5 animate-pulse bg-accent align-baseline">
              &nbsp;
            </span>
          ) : null}
        </p>
      )}

      {trail.length === 0 ? null : (
        <AgentWorkTrail steps={trail} label={i18n._(TOOL_CALL_LABEL)} className="mt-1" />
      )}

      {children === undefined ? null : <div className="flex flex-col gap-2">{children}</div>}

      {actions === undefined || actions.length === 0 ? null : (
        <div data-bubble-actions="" className="flex flex-wrap items-center gap-2">
          {actions.map((action) => (
            <Button
              key={action.id}
              size="sm"
              variant={action.primary === true ? 'primary' : 'secondary'}
              onClick={action.onAction}
              {...(action.disabled === true
                ? {
                    disabled: true,
                    ...(action.disabledReason === undefined ? {} : { disabledReason: action.disabledReason }),
                  }
                : {})}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </article>
  );
}

const TOOL_CALL_LABEL = msg`Agent 读取的内容`;
const TURN_FAILED = msg`这次回答失败了`;
const TURN_CANCELLED = msg`这次回答已停止`;
