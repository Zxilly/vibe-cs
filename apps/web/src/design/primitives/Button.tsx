/**
 * Design system, layer 1 of 3 — Button.
 *
 * Industry's `.btn` semantics, with the modifiers the design reference
 * actually uses:
 *
 *   variant   primary   `.btn-primary`  — accent fill, 59 occurrences
 *             secondary `.btn-secondary` — hairline outline, 126 occurrences
 *             ghost     `.btn-ghost`    — borderless accent text
 *             danger    the reference writes it as `class="btn btn-primary"`
 *                       with `background` and `border-color` overridden to the
 *                       literal §3.1 records as `--color-fail`, on the 「删除」
 *                       action of the delete dialog; a state colour that is
 *                       reached by overriding a variant is a missing variant
 *   icon      `.btn-icon` — square, no inline padding (`width:32px;height:32px`)
 *   block     `.btn-block` — full width (`btn btn-primary btn-block`)
 *   grow      `flex:1`, which the reference puts on 22 buttons that share a row
 *
 * `icon` and `block` are modifiers, not variants: every occurrence in the
 * reference stacks them on top of a primary or secondary base, and collapsing
 * them into the variant axis would make `btn btn-secondary btn-icon`
 * unexpressible.
 *
 * Sizes come from `./controlSize` — the four steps of §3.3, no 28 and no 30.
 *
 * Disabled actions carry a reason. Spec §4.1 and the shell artboard's
 * degradation rule — 「需要服务的动作变为禁用并写明原因，不隐藏、不静默失败」 —
 * make that a contract, so `disabledReason` is a first-class prop that reaches
 * assistive technology through `aria-describedby`, not just a tooltip.
 */

import { t } from '@lingui/core/macro';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { useId } from 'react';

import {
  CONTROL_HEIGHT_CLASS,
  CONTROL_PADDING_CLASS,
  CONTROL_SQUARE_CLASS,
  CONTROL_TEXT_CLASS,
  type ControlSize,
} from './controlSize';
import { cn } from '../cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type'> {
  variant?: ButtonVariant;
  size?: ControlSize;
  /** Square, label-less action. Requires `aria-label`. */
  icon?: boolean;
  /** Full-width action (`.btn-block`). */
  block?: boolean;
  /** `flex:1` — an equal share of a button row. */
  grow?: boolean;
  /** Why the action is unavailable. Rendered for assistive technology and as a tooltip. */
  disabledReason?: string;
  type?: 'button' | 'submit' | 'reset';
  className?: string;
  children?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * Industry's `.btn`: heading family, tight leading, hairline border, square
 * corners (`--radius-*` is 0 system-wide, §3.6). The border is declared on
 * every variant — including ghost, where it is transparent — so switching
 * variant never changes the box size.
 */
const BASE_CLASS =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap border font-heading ' +
  '[font-weight:var(--font-heading-weight)] leading-tight transition-colors ' +
  'disabled:opacity-45 aria-disabled:opacity-45';

const VARIANT_CLASS: Readonly<Record<ButtonVariant, string>> = {
  /* Industry: accent fill, `color: var(--color-bg)`; hover/active step down
     the accent ramp, which inverts in dark so the steps stay in the same
     direction. */
  primary: 'border-accent bg-accent text-bg hover:not-disabled:bg-accent-600 active:not-disabled:bg-accent-700',
  /* Industry: divider border, ink wash on hover. */
  secondary:
    'border-divider text-text ' +
    'hover:not-disabled:bg-[color-mix(in_srgb,var(--color-text)_7%,transparent)] ' +
    'active:not-disabled:bg-[color-mix(in_srgb,var(--color-text)_14%,transparent)]',
  /* Industry paints ghost with the flat `--color-accent`; base.css already
     established that the flat accent only reaches 4.4:1 on the dark canvas and
     that `--color-accent-700` is the reversal table's 「可点击的钢蓝」, so text
     on the page ground uses the ramp step instead. */
  ghost:
    'border-transparent text-accent-700 ' +
    'hover:not-disabled:bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] ' +
    'active:not-disabled:bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)]',
  /* The delete dialog's primary action. Hover darkens toward the ink rather
     than toward black, so the step survives the dark theme. */
  danger:
    'border-fail bg-fail text-bg ' +
    'hover:not-disabled:bg-[color-mix(in_oklab,var(--color-fail)_82%,var(--color-text))] ' +
    'active:not-disabled:bg-[color-mix(in_oklab,var(--color-fail)_68%,var(--color-text))]',
};

/** Ghost keeps Industry's tighter inline padding; icon has none at all. */
const GHOST_PADDING_CLASS = 'px-1';

export function Button({
  variant = 'secondary',
  size = 'md',
  icon = false,
  block = false,
  grow = false,
  disabled = false,
  disabledReason,
  type = 'button',
  className,
  children,
  ref,
  ...rest
}: ButtonProps) {
  const generatedId = useId();
  const reasonId = `${generatedId}-reason`;
  const hasReason = disabledReason !== undefined && disabledReason !== '';

  const padding = icon ? 'px-0' : variant === 'ghost' ? GHOST_PADDING_CLASS : CONTROL_PADDING_CLASS[size];

  const button = (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled}
      {...(hasReason ? { title: disabledReason, 'aria-describedby': reasonId } : {})}
      className={cn(
        BASE_CLASS,
        VARIANT_CLASS[variant],
        CONTROL_HEIGHT_CLASS[size],
        CONTROL_TEXT_CLASS[size],
        padding,
        icon && CONTROL_SQUARE_CLASS[size],
        icon && 'flex-none',
        block && 'w-full',
        grow && 'flex-1',
        className,
      )}
    >
      {children}
    </button>
  );

  if (!hasReason) return button;

  /* `sr-only` is out of flow (position: absolute), so the extra node never
     becomes a flex item of the surrounding row. It sits outside the button on
     purpose: text inside it would join the accessible *name*, and the reason
     is a description. */
  return (
    <>
      {button}
      <span id={reasonId} className="sr-only">
        {t`此动作当前不可用：${disabledReason}`}
      </span>
    </>
  );
}
