/**
 * Design system, layer 1 of 3 — Slider.
 *
 * The design reference draws it as a wireframe object, not a native range:
 *
 *   track  `height:4px;background:var(--color-neutral-300);position:relative`
 *   fill   `width:<pct>%;height:4px;background:var(--color-accent)`
 *   thumb  `position:absolute;left:<pct>%;top:-5px;
 *          width:14px;height:14px;background:var(--color-accent)` — a square,
 *          which is the whole reason this cannot be a restyled `<input
 *          type=range>` without vendor pseudo-element rules
 *
 * So the visual is drawn from those three spans and a real `<input
 * type="range">` is laid transparently over them. That keeps pointer drag,
 * Home / End / arrow keys, step arithmetic and the `slider` role native —
 * a hand-rolled `role="slider"` div would have to reimplement all of it — and
 * the ring base.css defines still lands on the input.
 *
 * The reference offsets the thumb by `top:-5px` and leaves it hanging past the
 * right edge at 100%. Here it is inset instead (`translateX(-pct%)`), so the
 * thumb stays inside the track at both ends; at 0 and 100 that is the only
 * visible difference from the reference, and a thumb that overhangs its track
 * is a bug in the mock rather than a decision.
 *
 * The numeric readout beside the track (「5」「0.65」「中 · 3.2m」) belongs to
 * the row that owns the slider, not to the slider; `valueText` feeds the same
 * string to assistive technology.
 */

import type { InputHTMLAttributes, Ref } from 'react';

import { cn } from '../cn';

export interface SliderProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'className' | 'children' | 'type' | 'value' | 'onChange' | 'min' | 'max' | 'step' | 'size'
  > {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (value: number) => void;
  /** Human reading of the value — becomes `aria-valuetext`. */
  valueText?: string;
  className?: string;
  ref?: Ref<HTMLInputElement>;
}

const TRACK_CLASS = 'h-[4px] w-full bg-neutral-300';
const FILL_CLASS = 'pointer-events-none absolute left-0 h-[4px] bg-accent';
const THUMB_CLASS = 'pointer-events-none absolute size-[14px] bg-accent';

/** Clamped so a value outside [min, max] cannot push the thumb off the track. */
export function sliderPercent(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || max <= min) return 0;
  const ratio = (value - min) / (max - min);
  return Math.min(100, Math.max(0, ratio * 100));
}

export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  valueText,
  disabled = false,
  className,
  ref,
  ...rest
}: SliderProps) {
  const percent = sliderPercent(value, min, max);

  return (
    <span className={cn('relative flex h-[14px] w-full items-center', disabled && 'opacity-45', className)}>
      <span className={TRACK_CLASS} />
      <span className={FILL_CLASS} style={{ width: `${percent}%` }} />
      <span className={THUMB_CLASS} style={{ left: `${percent}%`, transform: `translateX(-${percent}%)` }} />
      <input
        {...rest}
        ref={ref}
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        {...(valueText === undefined ? {} : { 'aria-valuetext': valueText })}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        onChange={(event) => onChange?.(Number(event.currentTarget.value))}
      />
    </span>
  );
}
