/**
 * Design system, layer 1 of 3 — Checkbox.
 *
 * shadcn's Checkbox — Radix `CheckboxPrimitive` — in the square the design
 * reference draws. Radix owns the `checkbox` role, `aria-checked` (including
 * `mixed`), Space, and the hidden form input that appears only inside a
 * `<form>`; this file owns the box and its tokens.
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
 * solid accent fill and nothing inside it. Square, too — `.radio .dot` is the
 * one place in the system that keeps a radius (§3.6), and no artboard draws a
 * round checkbox.
 *
 * Indeterminate is not in the reference, because no artboard draws a partially
 * selected table. It is here anyway — a select-all header cell over a partial
 * selection has no honest two-state representation — and is drawn as the fill
 * plus a bar in the ground colour. Radix models it as a third value of
 * `checked`; this component keeps it a separate `indeterminate` prop, because
 * every caller already has a boolean and a union would make them all widen it.
 *
 * ── Label ─────────────────────────────────────────────────────────────────
 *
 * shadcn's pairing: a sibling `<label htmlFor>`, not a wrapping one. Radix's
 * control is a `<button>`, and a `<label>` wrapping its own control has to be
 * reasoned about twice — once for the click that lands on the label and once
 * for the one that lands on the control. The id is generated here rather than
 * asked of the caller, so a labelled box cannot be built unlabelled by
 * accident; `children` stays the whole of the API.
 */

import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import { useId, type ComponentPropsWithoutRef, type ReactNode } from 'react';

import { cn } from '../cn';

export type CheckboxSize = 'sm' | 'md';

export interface CheckboxProps
  extends Omit<
    ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>,
    'className' | 'children' | 'checked' | 'onChange' | 'onCheckedChange' | 'asChild' | 'id'
  > {
  checked?: boolean;
  /** The next state, not a change event — as `Toggle`. */
  onChange?: ((checked: boolean) => void) | undefined;
  /** `sm` = 13px (table rows), `md` = 15px (lists). */
  size?: CheckboxSize;
  /** Neither checked nor unchecked — a partial selection. */
  indeterminate?: boolean;
  /** Visible label. Omit for a bare box, which then needs `aria-label`. */
  children?: ReactNode;
  className?: string;
}

const BOX_SIZE_CLASS: Readonly<Record<CheckboxSize, string>> = {
  sm: 'size-[13px]',
  md: 'size-[15px]',
};

const BOX_CLASS =
  'grid flex-none place-items-center border border-neutral-400 ' +
  'data-[state=checked]:border-accent data-[state=checked]:bg-accent ' +
  'data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent ' +
  'disabled:cursor-not-allowed disabled:opacity-45';

export function Checkbox({
  checked = false,
  onChange,
  size = 'md',
  indeterminate = false,
  disabled = false,
  className,
  children,
  ...rest
}: CheckboxProps) {
  const id = useId();

  return (
    <span
      className={cn(
        'inline-flex items-center gap-3 text-base leading-normal',
        disabled && 'cursor-not-allowed opacity-45',
        className,
      )}
    >
      <CheckboxPrimitive.Root
        {...rest}
        id={id}
        checked={indeterminate ? 'indeterminate' : checked}
        disabled={disabled}
        className={cn(BOX_CLASS, BOX_SIZE_CLASS[size])}
        onCheckedChange={(next) => onChange?.(next === true)}
      >
        {/* Not `CheckboxPrimitive.Indicator`: it renders for the checked state
            too, and the checked state has nothing to draw — the fill is the
            mark. The bar is the indeterminate state's own glyph. */}
        {indeterminate ? <span className="h-[1px] w-[7px] bg-bg" /> : null}
      </CheckboxPrimitive.Root>
      {children === undefined ? null : (
        <label htmlFor={id} className={cn('min-w-0', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}>
          {children}
        </label>
      )}
    </span>
  );
}
