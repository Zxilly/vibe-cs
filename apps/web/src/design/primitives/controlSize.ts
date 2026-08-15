/**
 * Design system, layer 1 of 3 — the four control sizes of spec §3.3.
 *
 * The design reference draws eight control heights (28 / 30 / 32 / 34 / 36 /
 * 38 / 40 / 42). §3.3 raises the floor to 32px and merges them into four, with
 * no exceptions, so this module is the only place a primitive may learn how
 * tall it is. Nothing here is a literal: every entry dereferences a
 * `--h-ctl-*` token declared in `../theme.css`.
 *
 * The width map exists for square controls (Industry's `.btn-icon`, drawn in
 * the reference as `width:32px;height:32px`) — a square reads its side from
 * the same token as its height rather than growing a size scale of its own.
 *
 * Type sizes are read off the reference rather than interpolated:
 *   sm   the merged 28 / 30 buttons carry `font-size:13px` in ~102
 *        declarations against ~41 that leave the class default, so the small
 *        step keeps 13px (--text-sm)
 *   md   Industry's own `.btn` size, 14px (--text-base); the 34 / 36 buttons
 *        never override it
 *   lg   likewise 14px — the 38 / 40 buttons are taller, not louder
 *   hero `height:42px;font-size:15px;padding-inline:22px`, the only place the
 *        reference enlarges the label (--text-md)
 */

export type ControlSize = 'sm' | 'md' | 'lg' | 'hero';

export const CONTROL_SIZES: readonly ControlSize[] = ['sm', 'md', 'lg', 'hero'];

/** Height utility per size. §3.3: 32 / 34 / 38 / 42. */
export const CONTROL_HEIGHT_CLASS: Readonly<Record<ControlSize, string>> = {
  sm: 'h-[var(--h-ctl-sm)]',
  md: 'h-[var(--h-ctl-md)]',
  lg: 'h-[var(--h-ctl-lg)]',
  hero: 'h-[var(--h-ctl-hero)]',
};

/** Side utility for square controls — same token as the height. */
export const CONTROL_SQUARE_CLASS: Readonly<Record<ControlSize, string>> = {
  sm: 'w-[var(--h-ctl-sm)]',
  md: 'w-[var(--h-ctl-md)]',
  lg: 'w-[var(--h-ctl-lg)]',
  hero: 'w-[var(--h-ctl-hero)]',
};

/** Type step per size, from the `--text-*` scale of §3.2. */
export const CONTROL_TEXT_CLASS: Readonly<Record<ControlSize, string>> = {
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-base',
  hero: 'text-md',
};

/**
 * Inline padding per size, expressed as multiples of `--spacing` (3.4px, the
 * Industry 0.85× density base of §3.6):
 *   3.6× = 12.24px, Industry's own `calc(var(--space-3) * 1.2)`
 *   6.5× = 22.1px,  the reference's `padding-inline:22px` on the hero action
 */
export const CONTROL_PADDING_CLASS: Readonly<Record<ControlSize, string>> = {
  sm: 'px-[calc(var(--spacing)*3.6)]',
  md: 'px-[calc(var(--spacing)*3.6)]',
  lg: 'px-[calc(var(--spacing)*3.6)]',
  hero: 'px-[calc(var(--spacing)*6.5)]',
};
