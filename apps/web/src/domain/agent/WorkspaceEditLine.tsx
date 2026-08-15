/*
 * Domain layer, 2 of 3 — agent/WorkspaceEditLine.
 *
 * The third entry kind, and the one that is **not** a bubble:
 *
 *   ── ✎ 09:47 你在方案上做了 2 处改动，Agent 已知悉   查看发给 Agent 的内容 ──
 *
 * §4.5.2 fixes every part of that: 「通知不进入对话气泡流，默认渲染为一行系统灰
 * 字，可展开查看原文——对用户是可见的，只是不打扰」. So it is a single grey line
 * between two hairlines, with a disclosure that reveals the typed notice
 * itself. It is drawn here rather than found in a chat library because a chat
 * library has bubbles and nothing else — §1's second reason for ruling
 * `@assistant-ui/react` out.
 *
 * ── Decisions ─────────────────────────────────────────────────────────────
 *
 * **The disclosure state is local.** It is a display toggle, not a fact about
 * the workspace: nothing else on the page changes when the JSON is open, and
 * nobody has to persist it. `MatchContextBar` made the same call for its
 * details panel. A caller that needs it open on first paint passes
 * `defaultExpanded`.
 *
 * **The line names the object kind, not the id.** 「你在方案上做了…」 —
 * `AGENT_OBJECT_KIND[notice.object.kind].label`, total over the union so a new
 * object kind cannot render as a blank. The id is in the expanded JSON, where a
 * reader who wants 「plan#P-118」 will look for it.
 *
 * **「你」 is not an assumption.** `WorkspaceEditNotice.by` is the literal type
 * `'user'` on the wire — the notice exists precisely because a *person* edited
 * something. §4.5.3 ② is why: the Agent never rolls a user's edit back, so
 * there is no other author this line could have.
 *
 * **The JSON scrolls sideways inside its own box.** A tick value or a long
 * 「note」 must not widen the transcript column.
 */

import { msg } from '@lingui/core/macro';
import { Plural, Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { ChevronDown, PencilLine } from 'lucide-react';
import { useId, useState } from 'react';

import { Button, cx } from '../../design/primitives';
import type { WorkspaceEditNotice } from '../../shared/desktop/dto';

import { formatAgentTime } from './agentClock';
import { formatWorkspaceEditNotice, workspaceEditChangeCount } from './editNotice';
import { AGENT_OBJECT_KIND } from './types';

export interface WorkspaceEditLineProps {
  readonly notice: WorkspaceEditNotice;
  /**
   * The entry's own timestamp. `notice.at` is when the edit happened and is
   * what the JSON carries; they are normally the same instant, and when they
   * are not it is the entry that says where the line sits in the transcript.
   */
  readonly at?: string | undefined;
  readonly defaultExpanded?: boolean | undefined;
  readonly timeZone?: string | undefined;
  readonly className?: string | undefined;
}

const RULE_CLASS = 'h-px bg-divider';
const ORIGINAL_LABEL = msg`这条通知的原文（不是聊天消息，模型看到的就是这段）`;

export function WorkspaceEditLine({
  notice,
  at,
  defaultExpanded = false,
  timeZone,
  className,
}: WorkspaceEditLineProps) {
  const { i18n } = useLingui();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const panelId = useId();

  const stamp = at ?? notice.at;
  const count = workspaceEditChangeCount(notice);
  const kindLabel = i18n._(AGENT_OBJECT_KIND[notice.object.kind].label);
  const zone = timeZone === undefined ? {} : { timeZone };

  return (
    <div
      data-workspace-edit-line={notice.object.id}
      data-expanded={expanded}
      className={cx('flex flex-col gap-2', className)}
    >
      <p className="flex min-w-0 flex-wrap items-center gap-2.5 py-1 text-xs text-neutral-600">
        <span aria-hidden="true" className={cx('w-3.5 flex-none', RULE_CLASS)} />
        <PencilLine size={13} strokeWidth={1.5} aria-hidden="true" className="flex-none" />
        <time dateTime={stamp} className="flex-none font-mono">
          {formatAgentTime(stamp, zone)}
        </time>
        <span className="min-w-0">
          <Trans>
            你在{kindLabel}上做了 <Plural value={count} other="# 处改动" />，Agent 已知悉
          </Trans>
        </span>

        <Button
          variant="ghost"
          size="sm"
          data-workspace-edit-toggle=""
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((open) => !open)}
          className="flex-none"
        >
          <ChevronDown
            size={12}
            strokeWidth={1.5}
            aria-hidden="true"
            className={expanded ? 'rotate-180' : undefined}
          />
          {expanded ? <Trans>收起</Trans> : <Trans>查看发给 Agent 的内容</Trans>}
        </Button>

        <span aria-hidden="true" className={cx('min-w-3.5 flex-1', RULE_CLASS)} />
      </p>

      {expanded ? (
        <div
          id={panelId}
          data-workspace-edit-original=""
          className="border border-dashed border-neutral-500 bg-neutral-100"
        >
          <p className="border-b border-dashed border-neutral-400 px-3 py-2 text-xs text-neutral-700">
            {i18n._(ORIGINAL_LABEL)}
          </p>
          {/* The typed notice, serialised. Scrolls inside its own box so a long
              note cannot widen the transcript column. */}
          <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-neutral-800">
            {formatWorkspaceEditNotice(notice)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
