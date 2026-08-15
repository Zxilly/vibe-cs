/**
 * Design system, layer 1 of 3 — Tag.
 *
 * Industry's `.tag`, restricted to the three tones the design reference
 * actually draws plus Industry's own accent-2:
 *
 *   accent    66 occurrences — 「已分析」「等待确认」「合并」, the state a row is in
 *   neutral   63 occurrences — 「已过期」「未下载 11」, counts and inert states
 *   outline   24 occurrences — 「待处理」 and the 「＋ 选手」 context chips
 *   accent-2  Industry defines it; the reference never uses it, kept so a
 *             second categorical hue exists without a page inventing one
 *
 * Status tones (ok / warn / fail) are deliberately absent: the reference draws
 * every success / warning / failure as a Notice or a StatusDot, never as a
 * tag, and a tone nobody asked for is a tone nobody checked.
 *
 * The 「＋ 添加上下文」 chips are clickable, so the element is switchable —
 * a chip that does something has to be a button, not a span with a handler.
 */

import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

import { cx } from './cx';

export type TagTone = 'accent' | 'accent-2' | 'neutral' | 'outline';

export interface TagProps extends Omit<ButtonHTMLAttributes<HTMLElement>, 'className' | 'children' | 'type'> {
  /** `span` for a state label, `button` for an actionable chip. */
  as?: 'span' | 'button';
  tone?: TagTone;
  className?: string;
  children?: ReactNode;
  ref?: Ref<HTMLElement>;
}

/**
 * Industry's `.tag`: 11px (--text-2xs), 0.02em tracking, 3px / 10px padding.
 * 3px and 10px are 0.9× and 3× the `--spacing` base (3.4px) — 3.06px and
 * 10.2px — so both come off the scale rather than being written down.
 * Corners are square: `--radius-*` is 0 system-wide (§3.6).
 */
const BASE_CLASS =
  'inline-flex items-center whitespace-nowrap text-2xs leading-tight tracking-[0.02em] ' +
  'px-3 py-[calc(var(--spacing)*0.9)]';

/** Every tone declares a border so switching tone never changes the box size. */
const TONE_CLASS: Readonly<Record<TagTone, string>> = {
  /* Industry pairs step 100 with step 800 of the same ramp. Both ramps invert
     in dark (theme.css), so the pairing survives the theme without a rule. */
  accent: 'border border-transparent bg-accent-100 text-accent-800',
  'accent-2': 'border border-transparent bg-accent-2-100 text-accent-2-800',
  neutral: 'border border-transparent bg-neutral-100 text-neutral-800',
  /* Industry outlines with the flat accent. The border may keep it; the label
     moves to `--color-accent-700`, the reversal table's clickable steel blue,
     for the same contrast reason base.css gives for `a`. */
  outline: 'border border-accent text-accent-700',
};

export function Tag({ as = 'span', tone = 'neutral', className, children, ref, ...rest }: TagProps) {
  const classes = cx(BASE_CLASS, TONE_CLASS[tone], className);

  if (as === 'button') {
    return (
      <button
        {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
        ref={ref as Ref<HTMLButtonElement>}
        type="button"
        className={cx(classes, 'cursor-pointer')}
      >
        {children}
      </button>
    );
  }

  return (
    <span {...rest} ref={ref as Ref<HTMLSpanElement>} className={classes}>
      {children}
    </span>
  );
}
