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
 */

import type { ComponentPropsWithoutRef, Ref } from 'react';

import { cn } from '../cn';

export interface TextareaProps extends Omit<ComponentPropsWithoutRef<'textarea'>, 'className'> {
  invalid?: boolean;
  /** `none` for a box whose height its container already decides. */
  resize?: 'vertical' | 'none';
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
  className,
  ref,
  ...rest
}: TextareaProps) {
  return (
    <textarea
      {...rest}
      ref={ref}
      {...(invalid ? { 'aria-invalid': true } : {})}
      className={cn(
        BASE_CLASS,
        resize === 'none' ? 'resize-none' : 'resize-y',
        invalid ? 'border-fail' : 'border-divider',
        className,
      )}
    />
  );
}
