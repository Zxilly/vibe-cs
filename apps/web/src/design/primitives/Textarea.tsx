/**
 * Design system, layer 1 of 3 — Textarea.
 *
 * shadcn's Textarea, sharing `Input`'s box: hairline `--color-divider`,
 * accent on focus, 3-unit inline padding, transparent over the panel it sits
 * on. The only differences a multi-line control needs are its own vertical
 * padding and a resize rule.
 *
 * `resize` is a prop rather than a fixed rule because the two callers disagree
 * for a reason. The Agent composer is a fixed two-row box inside a column that
 * is already sized (`--h-composer`), and letting the user drag it would push
 * the send button out of the panel; the shot editor's 镜头意图 is prose the
 * user may reasonably want more room for. `vertical` is the default, since a
 * horizontal resize inside a 440px inspector only ever breaks the layout.
 *
 * ── disabledReason ────────────────────────────────────────────────────────
 *
 * The same contract `Button` carries, and for the same reason: 「需要服务的动作
 * 变为禁用并写明原因，不隐藏、不静默失败」 does not stop at buttons. The Agent
 * composer's own input is disabled whenever the service is, and it was writing
 * the reason to the native `title` — which a *disabled* control never shows,
 * because it raises no pointer events. So the reason took the same two paths it
 * takes on a button: `aria-describedby` for a screen reader, a wrapping
 * `Tooltip` for a sighted mouse user.
 */

import { t } from '@lingui/core/macro';
import type { ComponentPropsWithoutRef, Ref } from 'react';
import { useId } from 'react';

import { Tooltip } from '../feedback/Tooltip';
import { cn } from '../cn';

export interface TextareaProps extends Omit<ComponentPropsWithoutRef<'textarea'>, 'className'> {
  invalid?: boolean;
  /** `none` for a box whose height its container already decides. */
  resize?: 'vertical' | 'none';
  /** Why the control is unavailable. Rendered for assistive technology and as a tooltip. */
  disabledReason?: string | undefined;
  className?: string;
  ref?: Ref<HTMLTextAreaElement> | undefined;
}

const BASE_CLASS =
  'w-full min-w-0 border px-3 py-2 text-sm leading-normal caret-accent ' +
  'placeholder:text-neutral-600 ' +
  'hover:not-disabled:not-focus:border-[color-mix(in_srgb,var(--color-text)_45%,transparent)] ' +
  'focus:border-accent disabled:cursor-not-allowed disabled:opacity-45';

export function Textarea({
  invalid = false,
  resize = 'vertical',
  disabled = false,
  disabledReason,
  className,
  ref,
  ...rest
}: TextareaProps) {
  const generatedId = useId();
  const reasonId = `${generatedId}-reason`;
  const hasReason = disabledReason !== undefined && disabledReason !== '';

  const textarea = (
    <textarea
      {...rest}
      ref={ref}
      disabled={disabled}
      {...(invalid ? { 'aria-invalid': true } : {})}
      {...(hasReason ? { 'aria-describedby': reasonId } : {})}
      className={cn(
        BASE_CLASS,
        resize === 'none' ? 'resize-none' : 'resize-y',
        invalid ? 'border-fail' : 'border-divider',
        className,
      )}
    />
  );

  if (!hasReason) return textarea;

  return (
    <>
      {/* `w-full` on the wrapper: the textarea is `w-full` and the wrapper is
          now the element the layout sizes, exactly as `Button` hands `block`
          and `grow` across. */}
      <Tooltip content={disabledReason} wrap wrapFocusable={disabled} wrapClassName="w-full">
        {textarea}
      </Tooltip>
      <span id={reasonId} className="sr-only">
        {t`暂时不能输入：${disabledReason}`}
      </span>
    </>
  );
}
