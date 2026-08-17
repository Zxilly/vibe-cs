/**
 * Design system, layer 1 of 3 — TextInput.
 *
 * Industry's `.input`, retuned to what the design reference draws. The
 * reference mocks text inputs as static boxes, so the shape is read off those:
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
 * is explicit that no primitive may remove that ring. A leading or trailing
 * adornment is therefore absolutely positioned over the input's own padding,
 * not laid out as a flex sibling.
 */

import type { InputHTMLAttributes, ReactNode, Ref } from 'react';

import { CONTROL_HEIGHT_CLASS, CONTROL_TEXT_CLASS, type ControlSize } from './controlSize';
import { cn } from '../cn';

export type TextInputType = 'text' | 'search' | 'email' | 'password' | 'url' | 'tel' | 'number';

export interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'size' | 'type' | 'children'> {
  size?: ControlSize;
  type?: TextInputType;
  /** Paint the box on `--color-bg` instead of leaving it transparent. */
  ground?: 'transparent' | 'bg';
  /** Tabular data — tick numbers, checksums, paths. */
  mono?: boolean;
  invalid?: boolean;
  /** Icon at the start of the box. Decorative; never announced. */
  leading?: ReactNode;
  /** Adornment at the end of the box — a unit, a shortcut hint. Decorative. */
  trailing?: ReactNode;
  className?: string;
  ref?: Ref<HTMLInputElement>;
}

const BASE_CLASS =
  'w-full min-w-0 border leading-normal caret-accent ' +
  'placeholder:text-neutral-600 ' +
  'px-3 ' +
  'hover:not-disabled:not-focus:border-[color-mix(in_srgb,var(--color-text)_45%,transparent)] ' +
  'focus:border-accent ' +
  'disabled:opacity-45';

/**
 * 30.6px (9× --spacing) clears the reference's 14px icon plus its 10px inset
 * and a 6px gap. Applied as inline padding on the side that carries the
 * adornment, so the caret never runs under it.
 */
const LEADING_PAD_CLASS = 'pl-9';
const TRAILING_PAD_CLASS = 'pr-9';

const ADORNMENT_CLASS =
  'pointer-events-none absolute inset-y-0 flex items-center text-neutral-600 [&_svg]:size-[14px]';

export function TextInput({
  size = 'sm',
  type = 'text',
  ground = 'transparent',
  mono = false,
  invalid = false,
  leading,
  trailing,
  className,
  ref,
  ...rest
}: TextInputProps) {
  const input = (
    <input
      {...rest}
      ref={ref}
      type={type}
      {...(invalid ? { 'aria-invalid': true } : {})}
      className={cn(
        BASE_CLASS,
        CONTROL_HEIGHT_CLASS[size],
        CONTROL_TEXT_CLASS[size],
        invalid ? 'border-fail' : 'border-divider',
        ground === 'bg' ? 'bg-bg' : 'bg-transparent',
        mono && 'font-mono',
        leading !== undefined && LEADING_PAD_CLASS,
        trailing !== undefined && TRAILING_PAD_CLASS,
        className,
      )}
    />
  );

  if (leading === undefined && trailing === undefined) return input;

  return (
    <span className="relative flex w-full items-center">
      {leading === undefined ? null : (
        <span className={cn(ADORNMENT_CLASS, 'left-3')} aria-hidden="true">
          {leading}
        </span>
      )}
      {input}
      {trailing === undefined ? null : (
        <span className={cn(ADORNMENT_CLASS, 'right-3')} aria-hidden="true">
          {trailing}
        </span>
      )}
    </span>
  );
}
