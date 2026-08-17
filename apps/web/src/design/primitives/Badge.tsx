/**
 * Design system, layer 1 of 3 — Badge.
 *
 * shadcn's Badge over Industry's `.tag`, restricted to the tones the design
 * reference actually draws plus Industry's own accent-2:
 *
 *   accent    66 occurrences — 「已分析」「等待确认」「合并」, the state a row is in
 *   neutral   63 occurrences — 「已过期」「未下载 11」, counts and inert states
 *   outline   24 occurrences — 「待处理」 and the 「＋ 选手」 context chips
 *   accent-2  Industry defines it; the reference never uses it, kept so a
 *             second categorical hue exists without a page inventing one
 *   count     the small tally beside a nav entry — 「3」 on 会话, on the Agent
 *             rail, on a folded view. Four files had grown their own copy of
 *             its four utilities before it was a variant
 *
 * Status tones (ok / warn / fail) are deliberately absent: the reference draws
 * every success / warning / failure as a Notice or a StatusDot, never as a
 * badge, and a tone nobody asked for is a tone nobody checked.
 *
 * ── Two sizes, because the count chip is not the state chip ───────────────
 *
 * Industry's `.tag` is 3px / 10px of padding, which is right for a word and
 * far too wide for a single digit next to a nav label. `sm` is the count
 * chip's own box — no vertical padding, half the inline padding — and it is a
 * size rather than part of the `count` variant so that a short neutral tally
 * can use it too.
 *
 * ── asChild ───────────────────────────────────────────────────────────────
 *
 * The 「＋ 添加上下文」 chips do something, and a chip that does something has to
 * be a button rather than a span with a handler. shadcn's answer is `asChild`,
 * and it is the one taken here: the caller writes the element it means, and
 * the badge lends it the box. That also leaves the door open for a chip that
 * is a link, which `as="span" | "button"` had closed.
 */

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentPropsWithoutRef, ReactNode, Ref } from 'react';

import { cn } from '../cn';

export type BadgeVariant = 'accent' | 'accent-2' | 'neutral' | 'outline' | 'count';
export type BadgeSize = 'md' | 'sm';

/**
 * Industry's `.tag`: 11px (--text-2xs), 0.02em tracking, 3px / 10px padding.
 * 3px and 10px are 0.9× and 3× the `--spacing` base (3.4px) — 3.06px and
 * 10.2px — so both come off the scale rather than being written down.
 * Corners are square: `--radius-*` is 0 system-wide (§3.6).
 *
 * Every variant declares a border so switching one never changes the box size.
 */
export const badgeVariants = cva(
  'inline-flex items-center whitespace-nowrap text-2xs leading-tight tracking-[0.02em]',
  {
    variants: {
      variant: {
        /* Industry pairs step 100 with step 800 of the same ramp. Both ramps
           invert in dark (theme.css), so the pairing survives the theme
           without a rule. */
        accent: 'border border-transparent bg-accent-100 text-accent-800',
        'accent-2': 'border border-transparent bg-accent-2-100 text-accent-2-800',
        neutral: 'border border-transparent bg-neutral-100 text-neutral-800',
        /* Industry outlines with the flat accent. The border may keep it; the
           label moves to `--color-accent-700`, the reversal table's clickable
           steel blue, for the same contrast reason base.css gives for `a`. */
        outline: 'border border-accent text-accent-700',
        /* The tally chip: a lighter hairline than `outline`, so a count beside
           a nav label reads as an annotation rather than as an action. */
        count: 'border border-accent-300 text-accent-700',
      },
      size: {
        md: 'px-3 py-[calc(var(--spacing)*0.9)]',
        sm: 'px-1.5',
      },
    },
    defaultVariants: { variant: 'neutral', size: 'md' },
  },
);

export interface BadgeProps
  extends Omit<ComponentPropsWithoutRef<'span'>, 'className' | 'children'>,
    VariantProps<typeof badgeVariants> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  /** Render the child element instead of a `<span>`, keeping this box. */
  asChild?: boolean;
  className?: string;
  children?: ReactNode;
  ref?: Ref<HTMLSpanElement>;
}

export function Badge({
  variant = 'neutral',
  size = 'md',
  asChild = false,
  className,
  children,
  ref,
  ...rest
}: BadgeProps) {
  const Root = asChild ? Slot : 'span';

  return (
    <Root {...rest} ref={ref} className={cn(badgeVariants({ variant, size }), className)}>
      {children}
    </Root>
  );
}
