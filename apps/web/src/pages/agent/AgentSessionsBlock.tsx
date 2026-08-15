/*
 * pages/agent — block C of 「07 Agent 创作面板」: the session drawer, 新建会话
 * 与引用, and (in `pages/settings/AiAgentSection.tsx`) 设置 · AI 与 Agent.
 *
 * `agentContract.ts` says block C has no placeholder of its own, because 「it is
 * an overlay plus a settings section, and a placeholder overlay would be a
 * dialog nobody opened」. This file is the two seams that overlay needs:
 *
 *   `agentSessionsToolbarAction`  the trigger, as a `ToolbarAction` so §8 may
 *                                 fold it into 「更多」 at narrow widths
 *   `AgentSessionsBlock`          the overlay itself
 *
 * ── Why the open state is the shell's and the drawer mounts only when open ─
 *
 * A `ToolbarAction`'s `control` is **not rendered** once §8 folds it into the
 * overflow menu (`design/layout/Toolbar`), so a drawer parked inside `control`
 * would unmount the moment the window narrowed with the drawer open. The state
 * therefore lives in the shell, the trigger goes in `actions`, and the panel is
 * mounted beside `SplitPane` — which is what the contract's note asks for.
 *
 * The panel is mounted **only while open**, rather than rendered and hidden:
 * `useAgentSessionList` would otherwise fetch the session list on every visit
 * to `/agent`, including the visits where nobody opens the drawer. §4.5.3 rule
 * ① has a quieter corollary here — a page that has not been asked to do
 * something should not be talking to the backend about it.
 */

import { Trans } from '@lingui/react/macro';
import { History } from 'lucide-react';

import type { ToolbarAction } from '../../design/layout';
import { Button } from '../../design/primitives';
import type { AgentBlockProps } from './agentContract';
import { SessionDrawer } from './SessionDrawer';

/**
 * 「会话」 on the toolbar. It carries both forms `Toolbar` needs: the control
 * while it fits, and the menu item once §8 folds it — so the drawer stays
 * reachable at 1280 as well as at 1920.
 *
 * Not gated on the service: opening the drawer is a read, the list inside it
 * shows its own failure in place, and a trigger that disabled itself would hide
 * the history the user came to read. The *writes* inside carry the gate.
 */
export function agentSessionsToolbarAction(onOpen: () => void): ToolbarAction {
  return {
    id: 'agent-sessions',
    label: <Trans>会话历史</Trans>,
    onSelect: onOpen,
    control: (
      <Button size="sm" data-agent-sessions-trigger="" onClick={onOpen}>
        <History size={14} strokeWidth={1.5} aria-hidden="true" />
        <Trans>会话历史</Trans>
      </Button>
    ),
  };
}

export interface AgentSessionsBlockProps
  extends Pick<AgentBlockProps, 'context' | 'updateContext' | 'service'> {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Test seam for the row stamps; the app leaves it to the row's default. */
  readonly now?: Date | undefined;
}

export function AgentSessionsBlock({
  open,
  onClose,
  context,
  updateContext,
  service,
  now,
}: AgentSessionsBlockProps) {
  if (!open) return null;

  return (
    <SessionDrawer
      open
      onClose={onClose}
      context={context}
      updateContext={updateContext}
      service={service}
      {...(now === undefined ? {} : { now })}
    />
  );
}
