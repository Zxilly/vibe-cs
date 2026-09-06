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

/** Shared Figma Button variants; state changes never change the box size. */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap border font-heading ' +
    'font-medium transition-colors ' +
    'disabled:opacity-45 aria-disabled:opacity-45',
  {
    variants: {
      variant: {
        primary:
          'border-accent bg-accent text-on-accent hover:not-disabled:bg-accent-600 active:not-disabled:bg-accent-700',
        secondary:
          'border-divider text-text ' +
          'hover:not-disabled:bg-action-hover ' +
          'active:not-disabled:bg-action-pressed',
        ghost:
          'border-transparent text-neutral-700 ' +
          'hover:not-disabled:bg-action-hover ' +
          'active:not-disabled:bg-action-pressed',
        danger:
          'border-fail bg-fail text-on-accent ' +
          'hover:not-disabled:bg-danger-hover ' +
          'active:not-disabled:bg-danger-pressed',
      },
      size: {
        sm: cn(CONTROL_HEIGHT_CLASS.sm, CONTROL_TEXT_CLASS.sm),
        md: cn(CONTROL_HEIGHT_CLASS.md, CONTROL_TEXT_CLASS.md),
        lg: cn(CONTROL_HEIGHT_CLASS.lg, CONTROL_TEXT_CLASS.lg),
        hero: cn(CONTROL_HEIGHT_CLASS.hero, CONTROL_TEXT_CLASS.hero, 'leading-6'),
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
      { icon: false, variant: 'ghost', class: 'px-3' },
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
        {t`暂时不能执行：${disabledReason}`}
      </span>
    </>
  );
}
