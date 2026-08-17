/**
 * Design system, layer 1 of 3 — Seg (segmented control).
 *
 * The most repeated control in the design reference: 23 groups and 59 options,
 * carrying view switching, camera perspective, quality strategy, floor,
 * playback speed, tone, and the 2a / 2b / 2c Agent modes.
 *
 * Industry builds it out of a `.seg` box and `.seg-opt` labels wrapping hidden
 * radios, which is why arrow-key navigation, roving focus and form semantics
 * come for free — the group is a real radio group, not a row of buttons with
 * `aria-*` bolted on.
 *
 * Two layouts, both drawn in the reference:
 *   natural  `<div class="seg" style="height:32px">`            — 15 groups
 *   fill     `<div class="seg" style="height:32px;width:100%">` plus
 *            `style="flex:1;justify-content:center"` on every option — 8 groups
 * `fill` is the pair, not two independent props: the reference never widens
 * the box without also spreading the options, and never spreads the options
 * inside a box that has not been widened.
 *
 * Type size is pinned to 13px (--text-sm) for every height. Industry's
 * `.seg-opt` declares it once and not one of the 23 groups overrides it — a
 * taller seg is a taller target, not a louder label.
 */

import type { ReactNode, Ref } from 'react';

import { CONTROL_HEIGHT_CLASS, type ControlSize } from './controlSize';
import { cn } from '../cn';

export interface SegOption<Value extends string> {
  value: Value;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegProps<Value extends string> {
  /** Radio group name. Must be unique in the document. */
  name: string;
  value: Value;
  options: readonly SegOption<Value>[];
  onChange?: (value: Value) => void;
  size?: ControlSize;
  /** Stretch to the container and split the width evenly between options. */
  fill?: boolean;
  /** Accessible name of the group. One of this or `aria-labelledby` is required. */
  'aria-label'?: string;
  'aria-labelledby'?: string;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/** Industry's `.seg`: hairline box, square corners, options clipped to it. */
const GROUP_CLASS = 'inline-flex overflow-hidden border border-divider';

/**
 * Industry's `.seg-opt`: 13px, 12px inline padding (3.5× the 3.4px `--spacing`
 * base = 11.9px), 6px gap for an option that carries an icon.
 */
const OPTION_CLASS =
  'inline-flex items-center gap-2 whitespace-nowrap px-[calc(var(--spacing)*3.5)] text-sm leading-tight ' +
  'cursor-pointer select-none ' +
  'has-[:checked]:bg-accent has-[:checked]:text-bg ' +
  'not-has-[:checked]:hover:bg-[color-mix(in_srgb,var(--color-text)_7%,transparent)] ' +
  'has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-45 ' +
  'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:-outline-offset-2';

/**
 * Industry hides the radio rather than restyling it, so the checked and
 * focused states can be expressed on the label. `sr-only` is not used: it
 * leaves the input 1px and clickable, which would put a dead pixel in the
 * middle of the option.
 */
const INPUT_CLASS = 'pointer-events-none absolute size-0 opacity-0';

export function Seg<Value extends string>({
  name,
  value,
  options,
  onChange,
  size = 'sm',
  fill = false,
  className,
  ref,
  ...aria
}: SegProps<Value>) {
  return (
    <div
      {...aria}
      ref={ref}
      role="radiogroup"
      className={cn(GROUP_CLASS, CONTROL_HEIGHT_CLASS[size], fill && 'flex w-full', className)}
    >
      {options.map((option, index) => (
        <label
          key={option.value}
          className={cn(
            OPTION_CLASS,
            /* Industry's `.seg-opt + .seg-opt` divider, resolved here because
               a sibling combinator cannot be written as a utility. */
            index > 0 && 'border-l border-divider',
            fill && 'flex-1 justify-center',
          )}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            disabled={option.disabled ?? false}
            className={INPUT_CLASS}
            onChange={() => onChange?.(option.value)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}
