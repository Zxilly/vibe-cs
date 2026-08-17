/**
 * Design system, layer 1 of 3 — Slider.
 *
 * shadcn's Slider — Radix `SliderPrimitive` — drawn as the design reference
 * draws it:
 *
 *   track  `height:4px;background:var(--color-neutral-300)`
 *   range  `height:4px;background:var(--color-accent)`
 *   thumb  `width:14px;height:14px;background:var(--color-accent)` — a square,
 *          which is why this was never a restyled `<input type=range>` without
 *          vendor pseudo-element rules
 *
 * The reference leaves the thumb hanging past the right edge at 100%. Radix
 * insets it instead, so the thumb stays inside the track at both ends; at 0 and
 * 100 that is the only visible difference from the reference, and a thumb that
 * overhangs its track is a bug in the mock rather than a decision.
 *
 * ── Why this is not the previous native range ─────────────────────────────
 *
 * The version before this laid a transparent `<input type="range">` over three
 * drawn spans, and that bought the keyboard and the `slider` role honestly.
 * What it could not buy is a *commit*: `input[type=range]` fires `change` on
 * every step of a drag, so all three callers kept a local draft and guessed at
 * the end of the gesture with `onPointerUp` plus `onBlur` — two handlers that
 * do not agree about a drag released outside the window, and one config PUT per
 * frame whenever they disagreed.
 *
 * Radix reports the two separately, so the component does too:
 *
 *   onChange  every step, for the live readout beside the track
 *   onCommit  once, when the pointer is released or the key goes up
 *
 * ── Single thumb ──────────────────────────────────────────────────────────
 *
 * Radix models the value as an array because it supports ranges. Nothing in
 * the product is a range — six call sites, all one-handled — so the array is
 * kept inside this file rather than pushed onto every caller.
 *
 * The numeric readout beside the track (「5」「0.65」「中 · 3.2m」) belongs to
 * the row that owns the slider, not to the slider; `valueText` feeds the same
 * string to assistive technology.
 */

import { Slider as SliderPrimitive } from 'radix-ui';
import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '../cn';

export interface SliderProps
  extends Omit<
    ComponentPropsWithoutRef<typeof SliderPrimitive.Root>,
    | 'className'
    | 'children'
    | 'value'
    | 'defaultValue'
    | 'onChange'
    | 'onValueChange'
    | 'onValueCommit'
    | 'asChild'
    | 'aria-label'
  > {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** Every step of the gesture — drive the live readout from this. */
  onChange?: ((value: number) => void) | undefined;
  /** Once, at the end of the gesture — write the setting from this. */
  onCommit?: ((value: number) => void) | undefined;
  /** Human reading of the value — becomes `aria-valuetext`. */
  valueText?: string;
  /** Names the thumb, which is the element carrying the `slider` role. */
  'aria-label'?: string | undefined;
  className?: string;
}

const ROOT_CLASS = 'relative flex h-[14px] w-full touch-none select-none items-center data-[disabled]:opacity-45';
const TRACK_CLASS = 'relative h-[4px] w-full grow bg-neutral-300';
const RANGE_CLASS = 'absolute h-full bg-accent';
const THUMB_CLASS = 'block size-[14px] bg-accent disabled:cursor-not-allowed';

export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  onCommit,
  valueText,
  disabled = false,
  className,
  'aria-label': ariaLabel,
  ...rest
}: SliderProps) {
  return (
    <SliderPrimitive.Root
      {...rest}
      value={[value]}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={cn(ROOT_CLASS, className)}
      onValueChange={([next]) => {
        if (next !== undefined) onChange?.(next);
      }}
      onValueCommit={([next]) => {
        if (next !== undefined) onCommit?.(next);
      }}
    >
      <SliderPrimitive.Track className={TRACK_CLASS}>
        <SliderPrimitive.Range className={RANGE_CLASS} />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        className={THUMB_CLASS}
        {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel })}
        {...(valueText === undefined ? {} : { 'aria-valuetext': valueText })}
      />
    </SliderPrimitive.Root>
  );
}
