/*
 * Domain layer, 2 of 3 — agent/AgentSessionRow.
 *
 * One row of the 会话抽屉, and the same row wherever a session is listed:
 *
 *   Kael 的 1v3   [当前]                                    09:02
 *   共 18 条对话
 *   [方案 #P-118 · 改过 2 次] [录制任务 #A-2481]
 *
 * The third line is the artboard's own caption for the list — 「每条下方是它触及
 * 过的对象」 — and it is `AgentSessionSummary.refs` rendered as
 * `AgentObjectRefChip`s, which is why the chip is its own component: the plan
 * detail's 改动来源 needs the identical thing pointing the other way.
 *
 * ── One artboard line this row does not draw ──────────────────────────────
 *
 * The reference's rows carry a context line — 「Aurora vs Meridian · Kael ·
 * R21」 — under the title. **There is no such field.** `AgentSessionSummary` is
 * `{ id, title, created_at, updated_at, entry_count, refs }`; the demo, the
 * player and the round are nowhere on it. So the line is omitted rather than
 * assembled out of whatever `refs` happens to contain, and the gap is reported.
 * `entry_count` — which does exist, and which tells the reader how much
 * conversation is behind the row — takes its place.
 *
 * ── The stamp ─────────────────────────────────────────────────────────────
 *
 * 「09:02」/「昨天」/「08-13」, from `agentClock.ts`. The word 「昨天」 is said here
 * because that module holds no copy; a `title` carries the time of day so the
 * relative form is never the only reading available.
 */

import { Plural, Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { Tag, cn } from '../../design/primitives';
import type { AgentObjectRef, AgentSessionSummary } from '../../shared/desktop/dto';

import { AgentObjectRefChip } from './AgentObjectRefChip';
import { readSessionStamp } from './agentClock';

/** The reference's selected row: accent plate plus a 2px rule down its edge. */
const SELECTED_CLASS = 'bg-accent-100 shadow-[inset_2px_0_0_var(--color-accent)]';

export interface AgentSessionRowProps {
  readonly session: AgentSessionSummary;
  /** The session the page is in right now — the artboard's 「当前」 tag. */
  readonly current?: boolean | undefined;
  /** Highlighted in the list. Distinct from `current`: you can browse others. */
  readonly selected?: boolean | undefined;
  readonly onOpen?: ((session: AgentSessionSummary) => void) | undefined;
  readonly onSelectRef?: ((objectRef: AgentObjectRef) => void) | undefined;
  /** 重命名 / 删除 — the drawer's per-row actions, owned by the page. */
  readonly actions?: ReactNode | undefined;
  /** The reader's 「今天」. Without it every row takes the dated form. */
  readonly now?: Date | undefined;
  readonly timeZone?: string | undefined;
  readonly className?: string | undefined;
}

export function AgentSessionRow({
  session,
  current = false,
  selected = false,
  onOpen,
  onSelectRef,
  actions,
  now,
  timeZone,
  className,
}: AgentSessionRowProps) {
  const stamp = readSessionStamp(session.updated_at, {
    ...(now === undefined ? {} : { now }),
    ...(timeZone === undefined ? {} : { timeZone }),
  });

  const heading = (
    <>
      <span className="min-w-0 truncate text-base">{session.title}</span>
      {current ? (
        <Tag data-session-current="" tone="accent" className="flex-none">
          <Trans>当前</Trans>
        </Tag>
      ) : null}
      <time
        dateTime={session.updated_at}
        title={stamp.kind === 'yesterday' ? stamp.text : undefined}
        className={cn('ml-auto flex-none text-2xs', stamp.kind === 'yesterday' ? null : 'font-mono', 'text-neutral-600')}
      >
        {stamp.kind === 'yesterday' ? <Trans>昨天</Trans> : stamp.text}
      </time>
    </>
  );

  return (
    <article
      data-agent-session={session.id}
      data-stamp={stamp.kind}
      aria-current={current ? true : undefined}
      className={cn(
        'flex flex-col gap-1.5 border-b border-divider p-3',
        selected && SELECTED_CLASS,
        className,
      )}
    >
      {onOpen === undefined ? (
        <p className="flex min-w-0 items-center gap-2">{heading}</p>
      ) : (
        <button
          type="button"
          data-session-open=""
          aria-pressed={selected}
          onClick={() => onOpen(session)}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          {heading}
        </button>
      )}

      <p className="text-xs text-neutral-600">
        <Plural value={session.entry_count} other="共 # 条对话" />
      </p>

      {session.refs.length === 0 ? null : (
        <ul data-session-refs={session.refs.length} className="flex min-w-0 flex-wrap gap-1.5">
          {session.refs.map((objectRef) => (
            <li key={`${objectRef.kind}-${objectRef.id}`} className="flex min-w-0">
              <AgentObjectRefChip
                objectRef={objectRef}
                tone={current ? 'accent' : 'neutral'}
                {...(onSelectRef === undefined ? {} : { onSelect: onSelectRef })}
              />
            </li>
          ))}
        </ul>
      )}

      {actions === undefined ? null : <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </article>
  );
}
