/**
 * Design system, layer 1 of 3 — primitives barrel.
 *
 * The nine controls spec §2 names, plus the two internals they share. Pages
 * and domain components import from here; nothing outside `design/` should
 * ever need a deep path into this directory.
 */

export { Button, type ButtonProps, type ButtonVariant } from './Button';
export { Checkbox, type CheckboxProps, type CheckboxSize } from './Checkbox';
export { Field, type FieldControlProps, type FieldProps } from './Field';
export { Link, type LinkProps, type LinkSize } from './Link';
export { Seg, type SegOption, type SegProps } from './Seg';
export { Slider, type SliderProps } from './Slider';
export { Badge, badgeVariants, type BadgeProps, type BadgeSize, type BadgeVariant } from './Badge';
export { Input, INPUT_BASE_CLASS, type InputProps, type InputType } from './Input';
export {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
  type InputGroupAddonAlign,
  type InputGroupAddonProps,
  type InputGroupInputProps,
  type InputGroupProps,
  type InputGroupTextProps,
} from './InputGroup';
export { Toggle, type ToggleProps } from './Toggle';

export {
  CONTROL_HEIGHT_CLASS,
  CONTROL_PADDING_CLASS,
  CONTROL_SIZES,
  CONTROL_SQUARE_CLASS,
  CONTROL_TEXT_CLASS,
  type ControlSize,
} from './controlSize';
export { cn, type ClassValue } from '../cn';
export { Kbd, KbdGroup, type KbdProps, type KbdGroupProps } from './Kbd';
export { NativeSelect, type NativeSelectProps } from './NativeSelect';
export { Textarea, type TextareaProps } from './Textarea';
