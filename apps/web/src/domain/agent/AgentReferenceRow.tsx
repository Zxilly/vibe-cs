/*
 * Domain layer, 2 of 3 — agent/AgentReferenceRow.
 *
 * One row of 「新建会话 · 工作区里正在进行的」:
 *
 *   ▪ 录制任务 · Rhea 双杀            #A-2483        [引用]
 *     运行中 2/6 · 可停止或调整未开始的片段
 *
 * The artboard's point, in its own words: 「空会话不是空白：工作区里正在进行的对
 * 象就列在这里，引用一个就能开始改它」. So the row's whole job is to state what
 * the object is and offer one verb.
 *
 * ── What is printed, and what is not ──────────────────────────────────────
 *
 * `AgentWorkspaceReference` gives `status` (free text), `progress_percent`,
 * `item_count` and `error`, all nullable but `status`.
 *
 *   status            printed as the server wrote it. `agentContract.ts` gap 9:
 *                     it is free text and mapping it onto `StatusDot`'s five
 *                     would be a guess, so there is no dot on this row.
 *   progress_percent  printed as 「62%」 when present. A real denominator, so it
 *                     is a real number — and when it is null nothing is drawn,
 *                     because §4.3 forbids a fabricated percentage.
 *   item_count        「共 6 项」 when present.
 *   error             the fail-coloured sentence, with an icon beside it so the
 *                     colour is not the only signal (§6.2).
 *
 * `已引用 ✓` replaces the button once the session holds the reference — the
 * artboard draws it as text, not as a disabled button, because it is a *state*
 * of the row rather than an action that failed.
 */

import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { Check, CircleAlert } from 'lucide-react';

import { Button, cn } from '../../design/primitives';
import { AGENT_OBJECT_KIND, type KnownWorkspaceReference } from './types';

export interface AgentReferenceRowProps {
  readonly reference: KnownWorkspaceReference;
  /** The session already references this object — 「已引用 ✓」. */
  readonly referenced?: boolean | undefined;
  readonly onReference?: ((reference: KnownWorkspaceReference) => void) | undefined;
  readonly referenceDisabledReason?: string | undefined;
  /** The 等待确认 plan the artboard highlights as the one about to be taken over. */
  readonly emphasis?: boolean | undefined;
  readonly className?: string | undefined;
}

export function AgentReferenceRow({
  reference,
  referenced = false,
  onReference,
  referenceDisabledReason,
  emphasis = false,
  className,
}: AgentReferenceRowProps) {
  const { i18n } = useLingui();

  const kind = AGENT_OBJECT_KIND[reference.kind];
  const KindIcon = kind.icon;

  return (
    <article
      data-agent-reference={reference.id}
      data-object-kind={reference.kind}
      {...(referenced ? { 'data-referenced': 'true' } : {})}
      className={cn(
        'flex items-start gap-3 border p-3 text-sm',
        emphasis ? 'border-accent bg-accent-100' : 'border-divider',
        className,
      )}
    >
      <KindIcon size={13} strokeWidth={1.5} aria-hidden="true" className="mt-1 flex-none text-neutral-700" />

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="flex min-w-0 items-baseline gap-2">
          <span className="sr-only">{i18n._(kind.label)} </span>
          <span className="min-w-0 truncate">{reference.label}</span>
          <span className="ml-auto flex-none font-mono text-xs text-neutral-600">{reference.id}</span>
        </p>

        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-neutral-700">
          {/* The server's own status sentence. Not mapped, not re-worded. */}
          <span className="min-w-0 truncate">{reference.status}</span>
          {reference.progress_percent === null ? null : (
            <span data-reference-progress="" className="flex-none font-mono">
              {reference.progress_percent}%
            </span>
          )}
          {reference.item_count === null ? null : (
            <span data-reference-count="" className="flex-none">
              <Trans>共 {reference.item_count} 项</Trans>
            </span>
          )}
        </p>

        {reference.error === null ? null : (
          <p data-reference-error="" className="flex items-start gap-1.5 text-xs text-fail-text">
            <CircleAlert size={12} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 flex-none" />
            <span className="min-w-0">{reference.error}</span>
          </p>
        )}
      </div>

      {referenced ? (
        <span data-reference-state="referenced" className="flex flex-none items-center gap-1 text-xs text-accent-800">
          <Check size={13} strokeWidth={1.5} aria-hidden="true" />
          <Trans>已引用</Trans>
        </span>
      ) : onReference === undefined ? null : (
        <Button
          size="sm"
          data-reference-action=""
          className="flex-none"
          onClick={() => onReference(reference)}
          {...(referenceDisabledReason === undefined
            ? {}
            : { disabled: true, disabledReason: referenceDisabledReason })}
        >
          <Trans>引用</Trans>
        </Button>
      )}
    </article>
  );
}
