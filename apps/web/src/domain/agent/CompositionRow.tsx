/*
 * Domain layer, 2 of 3 — agent/CompositionRow.
 *
 * One slot of 2c's 合成结果 panel:
 *
 *   02   跟随突破 · 3.0s            [换来源]
 *        来自 Take B · 压缩版
 *
 * §4.5.2's `Composition { shotSlot → { takeId, shotId } }` in one row: the slot
 * number, what currently fills it, and which take that came from. The same
 * caveat as `TakeCard` applies — there is no `Composition` on the wire
 * (`agentContract.ts` gap 8) — so every value arrives as a prop and the source
 * is a rendered node rather than a take id this component resolves.
 *
 * 「换来源」 is a link on the artboard and a `Button` here: it opens a picker,
 * which is an action, and an action that only a pointer can reach is an action
 * half the users cannot take.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { Button, cx } from '../../design/primitives';

export interface CompositionRowProps {
  /** One-based slot number — the 「02」 the panel and the strip share. */
  readonly index: number;
  /** 「跟随突破 · 3.0s」. */
  readonly label: ReactNode;
  /** 「来自 Take B · 压缩版」. Omitted when the slot is still empty. */
  readonly source?: ReactNode | undefined;
  /** Highlighted — the artboard marks the slot taken from another take. */
  readonly emphasis?: boolean | undefined;
  readonly onChangeSource?: (() => void) | undefined;
  readonly changeSourceDisabledReason?: string | undefined;
  readonly className?: string | undefined;
}

export function CompositionRow({
  index,
  label,
  source,
  emphasis = false,
  onChangeSource,
  changeSourceDisabledReason,
  className,
}: CompositionRowProps) {
  return (
    <article
      data-composition-slot={index}
      {...(emphasis ? { 'data-composition-emphasis': 'true' } : {})}
      className={cx(
        'flex items-center gap-3 border p-3 text-sm',
        emphasis ? 'border-accent bg-accent-100' : 'border-divider',
        className,
      )}
    >
      <span className="flex-none font-mono text-2xs text-neutral-600">{String(index).padStart(2, '0')}</span>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="min-w-0 truncate">{label}</span>
        {source === undefined ? null : (
          <span data-composition-source="" className="min-w-0 truncate text-xs text-neutral-600">
            {source}
          </span>
        )}
      </div>

      {onChangeSource === undefined ? null : (
        <Button
          variant="ghost"
          size="sm"
          data-composition-change=""
          className="flex-none"
          onClick={onChangeSource}
          {...(changeSourceDisabledReason === undefined
            ? {}
            : { disabled: true, disabledReason: changeSourceDisabledReason })}
        >
          <Trans>换来源</Trans>
        </Button>
      )}
    </article>
  );
}
