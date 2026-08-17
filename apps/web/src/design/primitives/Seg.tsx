/**
 * Design system, layer 1 of 3 — Seg (segmented control).
 *
 * The most repeated control in the design reference: 23 groups and 59 options,
 * carrying view switching, camera perspective, quality strategy, floor,
 * playback speed, tone, and the 2a / 2b / 2c Agent modes.
 *
 * Built on Radix `RadioGroupPrimitive`, which is the primitive a 「pick one」
 * control actually wants: `radiogroup` / `radio` roles, roving tabindex so the
 * group is one tab stop, arrow keys that move *and* select, and `data-state`
 * for the checked option. shadcn's own segmented control is a ToggleGroup, and
 * that is the wrong semantic here — a ToggleGroup is a row of pressed buttons,
 * which announces 「按下」 rather than 「三选一」 and lets zero options be
 * selected, a state none of the 23 groups can be in.
 *
 * The previous version got the same behaviour from real `<input type="radio">`
 * elements hidden under labels, and expressed every state through
 * `has-[:checked]` / `has-[:disabled]` / `has-[:focus-visible]` selectors on
 * the label. Radix carries those states as attributes instead, so the classes
 * below say what they mean.
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

import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';

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
  onChange?: ((value: Value) => void) | undefined;
  size?: ControlSize;
  /** Stretch to the container and split the width evenly between options. */
  fill?: boolean;
  /** Accessible name of the group. One of this or `aria-labelledby` is required. */
  'aria-label'?: string;
  'aria-labelledby'?: string;
  className?: string;
}

/** Industry's `.seg`: hairline box, square corners, options clipped to it. */
const GROUP_CLASS = 'inline-flex overflow-hidden border border-divider';

/**
 * Industry's `.seg-opt`: 13px, 12px inline padding (3.5× the 3.4px `--spacing`
 * base = 11.9px), 6px gap for an option that carries an icon.
 *
 * The focus ring is inset here rather than taking base.css's 2px offset: the
 * group clips its options (`overflow-hidden`), so an outset ring on the first
 * or last option would be cut in half by the box it sits in.
 */
const OPTION_CLASS =
  'inline-flex h-full items-center gap-2 whitespace-nowrap px-[calc(var(--spacing)*3.5)] text-sm leading-tight ' +
  'cursor-pointer select-none ' +
  'data-[state=checked]:bg-accent data-[state=checked]:text-bg ' +
  'data-[state=unchecked]:hover:bg-[color-mix(in_srgb,var(--color-text)_7%,transparent)] ' +
  'disabled:cursor-not-allowed disabled:opacity-45 ' +
  'focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2';

export function Seg<Value extends string>({
  name,
  value,
  options,
  onChange,
  size = 'sm',
  fill = false,
  className,
  ...aria
}: SegProps<Value>) {
  return (
    <RadioGroupPrimitive.Root
      {...aria}
      name={name}
      value={value}
      orientation="horizontal"
      className={cn(GROUP_CLASS, CONTROL_HEIGHT_CLASS[size], fill && 'flex w-full', className)}
      onValueChange={(next) => {
        /* Radix reports every activation, including one that lands on the
           option already selected — a native radio group fires no change for
           that, and 23 callers are written against the native contract. */
        if (next === value) return;
        onChange?.(next as Value);
      }}
    >
      {options.map((option, index) => (
        <RadioGroupPrimitive.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled ?? false}
          className={cn(
            OPTION_CLASS,
            /* Industry's `.seg-opt + .seg-opt` divider, resolved here because
               a sibling combinator cannot be written as a utility. */
            index > 0 && 'border-l border-divider',
            fill && 'flex-1 justify-center',
          )}
        >
          {option.label}
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  );
}
