/**
 * Design system, layer 1 of 3 — Toggle.
 *
 * shadcn's Switch — Radix `SwitchPrimitive` — wearing the shape the design
 * reference draws. Radix owns the behaviour: the `switch` role, `aria-checked`,
 * Space and Enter, the `data-state` attribute the classes below hang off, and
 * the hidden form input that appears only inside a `<form>`. This file owns
 * nothing but the geometry and the tokens.
 *
 * ── The shape ─────────────────────────────────────────────────────────────
 *
 * Not a pill switch. The reference draws a square one, 16 times across the
 * settings artboards, always as the same three declarations:
 *
 *   track  `width:34px;height:18px;background:var(--color-accent)` when on,
 *          `var(--color-neutral-300)` when off
 *   knob   `position:absolute;top:1px;width:16px;height:16px;
 *          background:var(--color-bg)`, pinned `right:1px` on, `left:1px` off
 *   locked an extra `position:absolute;inset:0;
 *          border:1px solid var(--color-accent-700)` — the 「不可关闭」 switch
 *          of 设置 · 行为边界, drawn on and unreachable because spec §4.5.3
 *          rule ① makes 「录制只由一次显式确认启动」 a rule of the system, not
 *          a preference
 *
 * The four literal geometry values are the component's own shape; §3 defines
 * no token for them and inventing one would imply a family that does not
 * exist. Every colour is a token.
 *
 * ── locked is not disabled ────────────────────────────────────────────────
 *
 * A disabled switch is dimmed and drops out of the tab order, and this one
 * must do neither: it states a rule the user is entitled to read, at full
 * strength, with the keyboard. So `locked` sets `aria-disabled` and swallows
 * the change rather than reaching for Radix's `disabled`, which would do both
 * of the things this switch must not do.
 *
 * The switch carries no label of its own: the reference always puts the title
 * and its explanatory line in the row to the left, which is a layout concern.
 * `aria-label` or `aria-labelledby` is therefore required.
 */

import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '../cn';

export interface ToggleProps
  extends Omit<
    ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>,
    'className' | 'children' | 'checked' | 'onChange' | 'onCheckedChange' | 'asChild'
  > {
  checked: boolean;
  onChange?: ((checked: boolean) => void) | undefined;
  /**
   * A setting the product does not let the user change. Renders the
   * reference's locked treatment and blocks the change, rather than dimming a
   * control that is still operable.
   */
  locked?: boolean;
  className?: string;
}

const TRACK_CLASS =
  'relative block h-[18px] w-[34px] flex-none transition-colors ' +
  'data-[state=checked]:bg-accent data-[state=unchecked]:bg-neutral-300 ' +
  'disabled:opacity-45';

const KNOB_CLASS =
  'absolute top-[1px] size-[16px] bg-bg ' +
  'data-[state=checked]:right-[1px] data-[state=unchecked]:left-[1px]';

export function Toggle({ checked, onChange, locked = false, className, ...rest }: ToggleProps) {
  return (
    <SwitchPrimitive.Root
      {...rest}
      checked={checked}
      {...(locked ? { 'aria-disabled': true, 'data-locked': 'true' } : {})}
      className={cn(TRACK_CLASS, className)}
      onCheckedChange={(next) => {
        if (locked) return;
        onChange?.(next);
      }}
    >
      <SwitchPrimitive.Thumb className={KNOB_CLASS} />
      {locked ? <span className="pointer-events-none absolute inset-0 border border-accent-700" /> : null}
    </SwitchPrimitive.Root>
  );
}
