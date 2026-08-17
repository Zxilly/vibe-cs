/**
 * Design system, layer 1 of 3 — Toggle.
 *
 * Not a pill switch. The design reference draws a square one, 16 times across
 * the settings artboards, always as the same three declarations:
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
 * The element is a `<button role="switch">`, which gets Space, Enter and the
 * checked state announced without a keydown handler. The reference draws a
 * `<span>`, but a span cannot be operated.
 *
 * The switch carries no label of its own: the reference always puts the title
 * and its explanatory line in the row to the left, which is a layout concern.
 * `aria-label` or `aria-labelledby` is therefore required.
 */

import type { ButtonHTMLAttributes, Ref } from 'react';

import { cx } from './cx';

export interface ToggleProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children' | 'type' | 'onChange'> {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  /**
   * A setting the product does not let the user change. Renders the
   * reference's locked treatment and blocks the click, rather than dimming a
   * control that is still operable.
   */
  locked?: boolean;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}

const TRACK_CLASS = 'relative block h-[18px] w-[34px] flex-none transition-colors disabled:opacity-45';

const KNOB_CLASS = 'absolute top-[1px] size-[16px] bg-bg';

export function Toggle({
  checked,
  onChange,
  locked = false,
  disabled = false,
  className,
  onClick,
  ref,
  ...rest
}: ToggleProps) {
  const inert = disabled || locked;

  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      {...(locked ? { 'aria-disabled': true, 'data-locked': 'true' } : {})}
      className={cx(TRACK_CLASS, checked ? 'bg-accent' : 'bg-neutral-300', className)}
      onClick={(event) => {
        onClick?.(event);
        if (inert || event.defaultPrevented) return;
        onChange?.(!checked);
      }}
    >
      <span className={cx(KNOB_CLASS, checked ? 'right-[1px]' : 'left-[1px]')} />
      {locked ? <span className="absolute inset-0 border border-accent-700" /> : null}
    </button>
  );
}
