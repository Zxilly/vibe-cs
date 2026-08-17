/**
 * Design system, layer 1 of 3 — Input.
 *
 * shadcn's Input over Industry's `.input`, retuned to what the design
 * reference draws. The reference mocks text inputs as static boxes, so the
 * shape is read off those:
 *
 *   height   32px on the settings and dialog fields, 26–28px in the command
 *            palette and session drawer — all of which §3.3 raises to
 *            `--h-ctl-sm` (32); 34 on the top-bar filters
 *   border   `1px solid var(--color-divider)`, and
 *            `1px solid var(--color-accent)` on the focused / edited box
 *   padding  `0 10px` (3× the 3.4px `--spacing` base = 10.2px)
 *   type     13px in dialogs and drawers, 14px in the shot inspector
 *   ground   transparent over the surrounding panel, except in the session
 *            drawer where the row sits on `--color-surface-chrome` and the box
 *            takes `var(--color-bg)` to separate itself
 *
 * Industry's `background: var(--color-surface)` is dropped for that last
 * reason: the reference paints the box from the ground it sits on, and a fixed
 * surface fill would be wrong in more places than it is right. Callers that
 * need the drawer treatment pass `ground="bg"`.
 *
 * The bordered box is the `<input>` itself rather than a wrapper, so the
 * `:focus-visible` ring base.css defines lands outside the border — base.css
 * is explicit that no primitive may remove that ring.
 *
 * ── Adornments live in `InputGroup` ───────────────────────────────────────
 *
 * This used to carry `leading` and `trailing` props that absolutely positioned
 * a glyph over the box's own padding. shadcn splits that into `InputGroup`,
 * and so does this: an addon is a sibling with a layout of its own, which is
 * the only version that can also hold a button or a unit that the caret must
 * not run under. See `./InputGroup`.
 */

import type { InputHTMLAttributes, Ref } from 'react';

import { CONTROL_HEIGHT_CLASS, CONTROL_TEXT_CLASS, type ControlSize } from './controlSize';
import { cn } from '../cn';

export type InputType = 'text' | 'search' | 'email' | 'password' | 'url' | 'tel' | 'number';

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'size' | 'type' | 'children'> {
  size?: ControlSize;
  type?: InputType;
  /** Paint the box on `--color-bg` instead of leaving it transparent. */
  ground?: 'transparent' | 'bg';
  /** Tabular data — tick numbers, checksums, paths. */
  mono?: boolean;
  invalid?: boolean;
  className?: string;
  ref?: Ref<HTMLInputElement>;
}

export const INPUT_BASE_CLASS =
  'w-full min-w-0 border leading-normal caret-accent ' +
  'placeholder:text-neutral-600 ' +
  'px-3 ' +
  'hover:not-disabled:not-focus:border-[color-mix(in_srgb,var(--color-text)_45%,transparent)] ' +
  'focus:border-accent ' +
  'disabled:opacity-45';

export function Input({
  size = 'sm',
  type = 'text',
  ground = 'transparent',
  mono = false,
  invalid = false,
  className,
  ref,
  ...rest
}: InputProps) {
  return (
    <input
      {...rest}
      ref={ref}
      type={type}
      {...(invalid ? { 'aria-invalid': true } : {})}
      className={cn(
        INPUT_BASE_CLASS,
        CONTROL_HEIGHT_CLASS[size],
        CONTROL_TEXT_CLASS[size],
        invalid ? 'border-fail' : 'border-divider',
        ground === 'bg' ? 'bg-bg' : 'bg-transparent',
        mono && 'font-mono',
        className,
      )}
    />
  );
}
