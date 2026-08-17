/**
 * Design system, layer 1 of 3 — InputGroup.
 *
 * shadcn's InputGroup: a box that owns the border, with the input and its
 * addons laid out inside it.
 *
 * The reference draws nine of these — the search fields of 资料库 / 会话抽屉 /
 * 证据检索 / 玩家目录 / 任务详情 / 恢复 / 合成, and the 「秒」 unit on the two
 * roll fields of the shot inspector. `Input` used to carry them as `leading`
 * and `trailing` props that absolutely positioned a glyph over the input's own
 * padding, with a hard-coded 30.6px inset to keep the caret clear of it.
 *
 * Three things that bought, and each of them is why this replaced it:
 *
 *   · The inset was a constant. An addon wider than 30.6px — 「毫秒」, a two
 *     character unit, a small button — ran under the text.
 *   · `pointer-events: none` was mandatory, because the glyph sat on top of
 *     the input. An addon can be a button here.
 *   · The border belonged to the input, so an addon could never sit *outside*
 *     it. `align="block-end"` (a hint under the field, inside the same box) is
 *     drawable now and was not.
 *
 * The group carries the border and the focus ring; the input inside it is
 * borderless and transparent, which is the same trade shadcn makes. base.css's
 * rule that no primitive may drop the `:focus-visible` ring still holds — the
 * ring moves to the group through `focus-within`.
 */

import type { ComponentPropsWithoutRef, Ref } from 'react';

import { CONTROL_HEIGHT_CLASS, CONTROL_TEXT_CLASS, type ControlSize } from './controlSize';
import { cn } from '../cn';

export interface InputGroupProps extends Omit<ComponentPropsWithoutRef<'div'>, 'className'> {
  size?: ControlSize;
  /** Paint the box on `--color-bg` instead of leaving it transparent. */
  ground?: 'transparent' | 'bg';
  invalid?: boolean;
  className?: string;
}

const GROUP_CLASS =
  'flex w-full min-w-0 items-center gap-2 border px-3 ' +
  'hover:not-focus-within:border-[color-mix(in_srgb,var(--color-text)_45%,transparent)] ' +
  'focus-within:border-accent ' +
  'has-[input:disabled]:opacity-45';

export function InputGroup({
  size = 'sm',
  ground = 'transparent',
  invalid = false,
  className,
  ...rest
}: InputGroupProps) {
  return (
    <div
      {...rest}
      data-input-group=""
      className={cn(
        GROUP_CLASS,
        CONTROL_HEIGHT_CLASS[size],
        CONTROL_TEXT_CLASS[size],
        invalid ? 'border-fail' : 'border-divider',
        ground === 'bg' ? 'bg-bg' : 'bg-transparent',
        className,
      )}
    />
  );
}

export type InputGroupAddonAlign = 'inline-start' | 'inline-end';

export interface InputGroupAddonProps extends Omit<ComponentPropsWithoutRef<'div'>, 'className'> {
  align?: InputGroupAddonAlign;
  className?: string;
}

/**
 * An icon, a unit, a shortcut hint. Decorative by default — the field it sits
 * in already has a name, and a magnifier read out as 「搜索」 beside a box
 * labelled 「搜索」 is noise. An addon that is a control passes
 * `aria-hidden={false}` and labels itself.
 */
export function InputGroupAddon({
  align = 'inline-start',
  className,
  'aria-hidden': ariaHidden = true,
  ...rest
}: InputGroupAddonProps) {
  return (
    <div
      {...rest}
      aria-hidden={ariaHidden}
      data-align={align}
      className={cn(
        'flex flex-none items-center gap-1.5 text-neutral-600 [&_svg]:size-[14px]',
        align === 'inline-end' && 'order-last',
        className,
      )}
    />
  );
}

export interface InputGroupInputProps
  extends Omit<ComponentPropsWithoutRef<'input'>, 'className' | 'size'> {
  className?: string;
  ref?: Ref<HTMLInputElement>;
}

/**
 * The input inside a group. Borderless and unpadded: the group draws both, and
 * two borders around one field is exactly the seam this component removes.
 */
export function InputGroupInput({ className, ref, ...rest }: InputGroupInputProps) {
  return (
    <input
      {...rest}
      ref={ref}
      className={cn(
        'min-w-0 flex-1 border-0 bg-transparent leading-normal caret-accent outline-none',
        'placeholder:text-neutral-600 disabled:cursor-not-allowed',
        className,
      )}
    />
  );
}

export type InputGroupTextProps = ComponentPropsWithoutRef<'span'>;

/** A unit or a label inside the box — 「秒」, 「%」. */
export function InputGroupText({ className, ...rest }: InputGroupTextProps) {
  return <span {...rest} className={cn('flex-none text-neutral-600', className)} />;
}
