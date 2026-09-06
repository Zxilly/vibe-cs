

export type ControlSize = 'sm' | 'md' | 'lg' | 'hero';

export const CONTROL_SIZES: readonly ControlSize[] = ['sm', 'md', 'lg', 'hero'];


export const CONTROL_HEIGHT_CLASS: Readonly<Record<ControlSize, string>> = {
  sm: 'h-[var(--h-ctl-sm)]',
  md: 'h-[var(--h-ctl-md)]',
  lg: 'h-[var(--h-ctl-lg)]',
  hero: 'h-[var(--h-ctl-hero)]',
};


export const CONTROL_SQUARE_CLASS: Readonly<Record<ControlSize, string>> = {
  sm: 'w-[var(--h-ctl-sm)]',
  md: 'w-[var(--h-ctl-md)]',
  lg: 'w-[var(--h-ctl-lg)]',
  hero: 'w-[var(--h-ctl-hero)]',
};


export const CONTROL_TEXT_CLASS: Readonly<Record<ControlSize, string>> = {
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-base',
  hero: 'text-md',
};


export const CONTROL_PADDING_CLASS: Readonly<Record<ControlSize, string>> = {
  sm: 'px-3',
  md: 'px-3',
  lg: 'px-3',
  hero: 'px-6',
};
