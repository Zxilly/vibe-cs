/**
 * Design system, layer 1 of 3 — Checkbox.
 *
 * Industry's `.radio` structure — a `<label>` wrapping a visually hidden
 * `<input>` and a drawn box — but square rather than round: `.radio .dot` is
 * the one place in the system that keeps a radius (§3.6), and the design
 * reference never draws a round checkbox.
 *
 * What the reference draws, 44 times:
 *
 *   md  `width:15px;height:15px;border:1px solid var(--color-neutral-400)`
 *       and, checked,
 *       `border:1px solid var(--color-accent);background:var(--color-accent)`
 *       — the shot lists and selection lists, beside 14px labels
 *   sm  the same at 13px — the leading column of the library and evidence
 *       tables, where the row is 40–42px and the box must not out-weigh the
 *       text
 *
 * There is no tick glyph in either: the reference marks a checked box with a
 * solid accent fill and nothing inside it.
 *
 * Indeterminate is not in the reference, because no artboard draws a
 * partially selected table. It is here anyway — a select-all header cell over
 * a partial selection has no honest two-state representation — and is drawn as
 * the fill plus a bar in the ground colour.
 */

import type { InputHTMLAttributes, ReactNode, Ref } from 'react';
import { useEffect, useRef } from 'react';

import { cx } from './cx';

export type CheckboxSize = 'sm' | 'md';

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'children' | 'type' | 'size'> {
  /** `sm` = 13px (table rows), `md` = 15px (lists). */
  size?: CheckboxSize;
  /** Neither checked nor unchecked — a partial selection. */
  indeterminate?: boolean;
  /** Visible label. Omit for a bare box, which then needs `aria-label`. */
  children?: ReactNode;
  className?: string;
  ref?: Ref<HTMLInputElement>;
}

const BOX_SIZE_CLASS: Readonly<Record<CheckboxSize, string>> = {
  sm: 'size-[13px]',
  md: 'size-[15px]',
};

const BOX_CLASS =
  'grid flex-none place-items-center border border-neutral-400 ' +
  'peer-checked:border-accent peer-checked:bg-accent ' +
  'peer-indeterminate:border-accent peer-indeterminate:bg-accent ' +
  'peer-disabled:opacity-45 ' +
  'peer-focus-visible:outline-2 peer-focus-visible:outline-accent peer-focus-visible:outline-offset-2';

/**
 * Industry hides the input with `position:absolute;opacity:0;width:0;height:0;
 * pointer-events:none` rather than `sr-only`, which would leave a 1px
 * clickable node in the middle of the box.
 */
const INPUT_CLASS = 'peer pointer-events-none absolute size-0 opacity-0';

export function Checkbox({
  size = 'md',
  indeterminate = false,
  disabled = false,
  className,
  children,
  ref,
  ...rest
}: CheckboxProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  /* `indeterminate` is a DOM property with no attribute, so React cannot set
     it declaratively. */
  useEffect(() => {
    if (inputRef.current !== null) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label
      className={cx(
        'inline-flex items-center gap-3 text-base leading-normal',
        disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
        className,
      )}
    >
      <input
        {...rest}
        ref={(node) => {
          inputRef.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref !== null && ref !== undefined) ref.current = node;
        }}
        type="checkbox"
        disabled={disabled}
        {...(indeterminate ? { 'aria-checked': 'mixed' as const } : {})}
        className={INPUT_CLASS}
      />
      <span className={cx(BOX_CLASS, BOX_SIZE_CLASS[size])}>
        {indeterminate ? <span className="h-[1px] w-[7px] bg-bg" /> : null}
      </span>
      {children}
    </label>
  );
}
