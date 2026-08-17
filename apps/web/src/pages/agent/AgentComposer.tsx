/*
 * pages/agent — block A's instruction bar.
 *
 * The bottom strip of every Agent artboard: 07's 「继续和 Agent 说」, 2a's
 * command line with its four chips, 2b's 「对这个镜头说」. One component, because
 * they differ only in copy — which `conversationModel.AGENT_MODE_COMPOSER`
 * holds per mode — and in what the sentence beside the button says.
 *
 * ── It does not know how to send ──────────────────────────────────────────
 *
 * `onSend` is the caller's. The block above it calls `props.chat.send`, and the
 * shell wraps that with `editNotifier.flush('send-message')` so the model reads
 * a manual edit before the question about it (invariant 5). Nothing here
 * touches the notifier: a composer that remembered to flush would be the second
 * place that has to, and the first one to forget.
 *
 * ── ⌘↵ sends, ↵ does not ─────────────────────────────────────────────────
 *
 * The 手动编辑 artboard prints 「Esc 放弃 · ⌘↵ 保存」 on its shot editor, and the
 * instruction box is multi-line on every board (「第 3 个镜头前面留 1 秒」 is one
 * line, 「把 02 压到 3 秒，然后……」 is not). A plain Enter that sent would make
 * the second sentence impossible to type, so Enter inserts a newline and
 * Ctrl/⌘+Enter sends — the arrangement every multi-line composer uses.
 *
 * ── 停止 is not 撤销 ──────────────────────────────────────────────────────
 *
 * While a reply is streaming the primary action becomes 停止, which calls
 * `cancel`. `data/sessions.ts` does not write a cancelled reply into the
 * session — half an answer stored as the Agent's word would be read back as the
 * Agent's word — so the button stops a reply, it does not undo one.
 */

import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';

import { Button, Textarea, cn } from '../../design/primitives';
import { AGENT_MODE_COMPOSER } from './conversationModel';
import type { AgentMode } from './agentContract';

export interface AgentComposerProps {
  readonly mode: AgentMode;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Called with the trimmed text; never called with an empty one. */
  readonly onSend: (message: string) => void;
  readonly streaming: boolean;
  readonly onCancel: () => void;
  /** Why the message cannot be sent — no session, no service, already busy. */
  readonly disabledReason?: string | undefined;
  /**
   * The line to the left of the button. 2b puts the shot's scope there
   * (「只影响这一个镜头」); the 手动编辑 board puts §4.5.3 ②'s own sentence there.
   */
  readonly hint?: ReactNode | undefined;
  readonly inputRef?: RefObject<HTMLTextAreaElement | null> | undefined;
  readonly className?: string | undefined;
}

export function AgentComposer({
  mode,
  value,
  onChange,
  onSend,
  streaming,
  onCancel,
  disabledReason,
  hint,
  inputRef,
  className,
}: AgentComposerProps) {
  const { i18n } = useLingui();
  const copy = AGENT_MODE_COMPOSER[mode];

  const message = value.trim();
  const blocked = disabledReason !== undefined;
  /* An empty box is not an error, so it disables the button without a written
     reason: 「不隐藏、不静默失败」 is about actions that *look* available, and a
     send with nothing to send is not one. */
  const canSend = !blocked && message !== '';

  const submit = () => {
    if (!canSend) return;
    onSend(message);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    submit();
  };

  return (
    <div
      data-agent-composer={mode}
      className={cn('flex flex-none flex-col gap-2 border-t border-divider p-3.5', className)}
    >
      {copy.suggestions.length === 0 ? null : (
        <div data-composer-suggestions="" className="flex flex-wrap gap-2">
          {copy.suggestions.map((suggestion) => {
            const text = i18n._(suggestion);
            return (
              <Button
                key={text}
                variant="ghost"
                size="sm"
                onClick={() => onChange(value.trim() === '' ? text : `${value.trim()} ${text}`)}
                {...(blocked ? { disabled: true, disabledReason } : {})}
              >
                {text}
              </Button>
            );
          })}
        </div>
      )}

      <Textarea
        ref={inputRef}
        rows={2}
        resize="none"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={i18n._(copy.placeholder)}
        aria-label={i18n._(copy.placeholder)}
        className="min-h-16"
        {...(blocked ? { disabled: true, title: disabledReason } : {})}
      />

      <div className="flex flex-wrap items-center gap-2">
        {hint === undefined ? null : (
          <span data-composer-hint="" className="min-w-0 flex-1 text-xs text-neutral-600">
            {hint}
          </span>
        )}
        <span className="ml-auto flex flex-none items-center gap-2">
          {streaming ? (
            <Button size="sm" data-composer-cancel="" onClick={onCancel}>
              <Trans>停止</Trans>
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            data-composer-send=""
            onClick={submit}
            {...(canSend
              ? {}
              : { disabled: true, ...(disabledReason === undefined ? {} : { disabledReason }) })}
          >
            {i18n._(copy.sendLabel)}
          </Button>
        </span>
      </div>
    </div>
  );
}
