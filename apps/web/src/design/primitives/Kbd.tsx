/**
 * Design system, layer 1 of 3 — Kbd.
 *
 * shadcn's Kbd and KbdGroup, in the box the design reference draws: a hairline
 * `--color-divider` outline, 11px (--text-2xs), 1.5 units of inline padding,
 * square like everything else (§3.6 puts every radius at 0).
 *
 * The reference prints key names in five places — the命令面板 header 「ESC 关闭」
 * and its ↵ chips, the title bar's 「CTRL K」, and 「Esc 放弃 · ⌘↵ 保存」 on the
 * shot editor — and each of them had grown its own copy of the same four
 * utilities. This is that box, once.
 *
 * ── Key names are not copy ────────────────────────────────────────────────
 *
 * `ESC`, `CTRL K`, `↵` are the same characters in every locale, so they do not
 * go through the i18n macros; the *verb* beside them does. That is why this
 * component takes a `children` of literal key text and nothing else, and why
 * every caller pairs it with a `<Trans>` for the action.
 *
 * `aria-hidden` is the default. A key chip printed beside a control duplicates
 * the control's own accessible name — 「关闭抽屉」 already says what Esc does —
 * and read out on its own it is noise. A caller announcing a shortcut that has
 * no other label passes `aria-hidden={false}`.
 */

import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '../cn';

const KBD_CLASS =
  'inline-flex flex-none items-center justify-center border border-divider px-1.5 ' +
  'font-mono text-2xs leading-tight text-neutral-600';

export type KbdProps = ComponentPropsWithoutRef<'kbd'>;

export function Kbd({ className, 'aria-hidden': ariaHidden = true, ...rest }: KbdProps) {
  return <kbd {...rest} aria-hidden={ariaHidden} className={cn(KBD_CLASS, className)} />;
}

export type KbdGroupProps = ComponentPropsWithoutRef<'span'>;

/** Several keys pressed together — 「⌘」「↵」. */
export function KbdGroup({ className, ...rest }: KbdGroupProps) {
  return <span {...rest} className={cn('inline-flex items-center gap-1', className)} />;
}
