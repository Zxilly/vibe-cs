/**
 * Design system, layer 1 of 3 — Button.
 *
 * shadcn's Button shape — `cva` for the variants, `Slot` for `asChild` — over
 * Industry's `.btn` semantics and the modifiers the design reference uses:
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
 * unexpressible. `cva` models exactly that — one `variant` axis, one `size`
 * axis, and boolean modifiers that compose over both.
 *
 * Sizes come from `./controlSize` — the four steps of §3.3, no 28 and no 30.
 *
 * ── asChild ───────────────────────────────────────────────────────────────
 *
 * A link that is drawn as a button is a link: it has to keep `href`, so that
 * middle-click, 「在新标签页打开」 and the status bar all work. Before `asChild`
 * the only ways to draw one were to copy the class list onto an `<a>` — which
 * is how a design system starts drifting — or to make a button that calls
 * `navigate()`, which throws the URL away. `<Button asChild><a href…/></Button>`
 * keeps both halves.
 *
 * Disabled actions carry a reason. Spec §4.1 and the shell artboard's
 * degradation rule — 「需要服务的动作变为禁用并写明原因，不隐藏、不静默失败」 —
 * make that a contract, so `disabledReason` is a first-class prop, and it takes
 * two routes because neither reaches everyone: `aria-describedby` for a screen
 * reader, and a `Tooltip` for a sighted mouse user. It used to be the native
 * `title`, which on a disabled button shows nothing at all.
 */

import { t } from '@lingui/core/macro';
import { Slot as SlotPrimitive } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { useId } from 'react';

import {
  CONTROL_HEIGHT_CLASS,
  CONTROL_PADDING_CLASS,
  CONTROL_SQUARE_CLASS,
  CONTROL_TEXT_CLASS,
  type ControlSize,
} from './controlSize';
import { Tooltip } from '../feedback/Tooltip';
import { cn } from '../cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/**
 * Industry's `.btn`: heading family, tight leading, hairline border, square
 * corners (`--radius-*` is 0 system-wide, §3.6). The border is declared on
 * every variant — including ghost, where it is transparent — so switching
 * variant never changes the box size.
 */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap border font-heading ' +
    '[font-weight:var(--font-heading-weight)] leading-tight transition-colors ' +
    'disabled:opacity-45 aria-disabled:opacity-45',
  {
    variants: {
      variant: {
        /* Industry: accent fill, `color: var(--color-bg)`; hover/active step
           down the accent ramp, which inverts in dark so the steps stay in the
           same direction. */
        primary:
          'border-accent bg-accent text-bg hover:not-disabled:bg-accent-600 active:not-disabled:bg-accent-700',
        /* Industry: divider border, ink wash on hover. */
        secondary:
          'border-divider text-text ' +
          'hover:not-disabled:bg-[color-mix(in_srgb,var(--color-text)_7%,transparent)] ' +
          'active:not-disabled:bg-[color-mix(in_srgb,var(--color-text)_14%,transparent)]',
        /* Industry paints ghost with the flat `--color-accent`; base.css already
           established that the flat accent only reaches 4.4:1 on the dark canvas
           and that `--color-accent-700` is the reversal table's 「可点击的钢蓝」,
           so text on the page ground uses the ramp step instead. */
        ghost:
          'border-transparent text-accent-700 ' +
          'hover:not-disabled:bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] ' +
          'active:not-disabled:bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)]',
        /* The delete dialog's primary action. Hover darkens toward the ink
           rather than toward black, so the step survives the dark theme. */
        danger:
          'border-fail bg-fail text-bg ' +
          'hover:not-disabled:bg-[color-mix(in_oklab,var(--color-fail)_82%,var(--color-text))] ' +
          'active:not-disabled:bg-[color-mix(in_oklab,var(--color-fail)_68%,var(--color-text))]',
      },
      size: {
        sm: cn(CONTROL_HEIGHT_CLASS.sm, CONTROL_TEXT_CLASS.sm),
        md: cn(CONTROL_HEIGHT_CLASS.md, CONTROL_TEXT_CLASS.md),
        lg: cn(CONTROL_HEIGHT_CLASS.lg, CONTROL_TEXT_CLASS.lg),
        hero: cn(CONTROL_HEIGHT_CLASS.hero, CONTROL_TEXT_CLASS.hero),
      },
      /** Square, label-less action. Requires `aria-label`. */
      icon: { true: 'flex-none px-0', false: '' },
      /** Full-width action (`.btn-block`). */
      block: { true: 'w-full', false: '' },
      /** `flex:1` — an equal share of a button row. */
      grow: { true: 'flex-1', false: '' },
    },
    /* Inline padding is a function of both axes: a square has none, ghost keeps
       Industry's tighter step, and everything else takes the size's own. */
    compoundVariants: [
      { icon: false, variant: 'ghost', class: 'px-1' },
      { icon: false, variant: 'primary', size: 'sm', class: CONTROL_PADDING_CLASS.sm },
      { icon: false, variant: 'primary', size: 'md', class: CONTROL_PADDING_CLASS.md },
      { icon: false, variant: 'primary', size: 'lg', class: CONTROL_PADDING_CLASS.lg },
      { icon: false, variant: 'primary', size: 'hero', class: CONTROL_PADDING_CLASS.hero },
      { icon: false, variant: 'secondary', size: 'sm', class: CONTROL_PADDING_CLASS.sm },
      { icon: false, variant: 'secondary', size: 'md', class: CONTROL_PADDING_CLASS.md },
      { icon: false, variant: 'secondary', size: 'lg', class: CONTROL_PADDING_CLASS.lg },
      { icon: false, variant: 'secondary', size: 'hero', class: CONTROL_PADDING_CLASS.hero },
      { icon: false, variant: 'danger', size: 'sm', class: CONTROL_PADDING_CLASS.sm },
      { icon: false, variant: 'danger', size: 'md', class: CONTROL_PADDING_CLASS.md },
      { icon: false, variant: 'danger', size: 'lg', class: CONTROL_PADDING_CLASS.lg },
      { icon: false, variant: 'danger', size: 'hero', class: CONTROL_PADDING_CLASS.hero },
      { icon: true, size: 'sm', class: CONTROL_SQUARE_CLASS.sm },
      { icon: true, size: 'md', class: CONTROL_SQUARE_CLASS.md },
      { icon: true, size: 'lg', class: CONTROL_SQUARE_CLASS.lg },
      { icon: true, size: 'hero', class: CONTROL_SQUARE_CLASS.hero },
    ],
    defaultVariants: { variant: 'secondary', size: 'md', icon: false, block: false, grow: false },
  },
);

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type'>,
    Omit<VariantProps<typeof buttonVariants>, 'variant' | 'size'> {
  variant?: ButtonVariant;
  size?: ControlSize;
  /** Render the child element instead of a `<button>`, keeping these classes. */
  asChild?: boolean;
  /** Why the action is unavailable. Rendered for assistive technology and as a tooltip. */
  disabledReason?: string;
  type?: 'button' | 'submit' | 'reset';
  className?: string;
  children?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon = false,
  block = false,
  grow = false,
  asChild = false,
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

  const Root = asChild ? SlotPrimitive.Root : 'button';

  const button = (
    <Root
      {...rest}
      ref={ref}
      /* A `Slot` passes everything to the child, and `type` on an `<a>` means
         something else entirely. Only a real button gets it. */
      {...(asChild ? {} : { type })}
      disabled={disabled}
      {...(hasReason ? { 'aria-describedby': reasonId } : {})}
      className={cn(buttonVariants({ variant, size, icon, block, grow }), className)}
    >
      {/* `Slottable` marks which child becomes the borrowed element. */}
      {asChild ? <SlotPrimitive.Slottable>{children}</SlotPrimitive.Slottable> : children}
    </Root>
  );

  if (!hasReason) return button;

  /* Two paths to the same sentence, because neither reaches everyone.
     `aria-describedby` is what a screen reader reads; the tooltip is what a
     sighted mouse user sees — and it has to wrap rather than borrow the
     button, since a disabled control raises no pointer events at all. That is
     the bug the native `title` here used to hide; see `feedback/Tooltip`.

     `sr-only` is out of flow (position: absolute), so the extra node never
     becomes a flex item of the surrounding row. It sits outside the button on
     purpose: text inside it would join the accessible *name*, and the reason
     is a description. */
  return (
    <>
      {/* `wrap` is unconditional so the button keeps its identity when it
          becomes available; only the tab stop is conditional, because an
          enabled button is its own. */}
      <Tooltip
        content={disabledReason}
        wrap
        wrapFocusable={disabled}
        /* The wrapper is the flex item now, so it inherits the modifiers that
           only mean anything to a flex item. */
        wrapClassName={cn(block && 'w-full', grow && 'flex-1', icon && 'flex-none')}
      >
        {button}
      </Tooltip>
      <span id={reasonId} className="sr-only">
        {t`此动作当前不可用：${disabledReason}`}
      </span>
    </>
  );
}
