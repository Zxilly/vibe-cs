/**
 * Design system, layer 1 of 3 — NativeSelect.
 *
 * shadcn's Native Select: a real `<select>` wearing the system's control
 * geometry, rather than the Radix listbox its `Select` builds.
 *
 * Both are on offer upstream and the native one is right here. Every place the
 * product needs a list — 镜头类型 (seven members, more than a `Seg` can carry in
 * a 440px inspector), 分辨率 / 帧率 in the export panel, 片段转场 in 快速合辑 — is
 * a short, static, keyboard-driven choice inside a desktop window. A native
 * select gets the platform's own popup, its typeahead, and its behaviour at
 * 200% zoom for free; a Radix listbox would re-implement all of it and then
 * have to be kept portal-safe inside a Drawer. The moment one of these lists
 * needs grouping, icons or search, it should become `Select` instead — and that
 * is a different component, not a prop on this one.
 *
 * `ShotEditForm`, `ExportBlock`, `ShotInspectorBlock` and `PackagingBlock` each
 * had their own copy of these classes, and the last two carried a comment
 * saying 「the design system has no listbox」 — written before this file existed
 * and never revisited. They are the same classes, so they live here.
 *
 * `color-scheme` on `:root` (base.css) is what makes the popup itself follow
 * the theme; nothing here has to paint it.
 */

import type { ComponentPropsWithoutRef, Ref } from 'react';

import { CONTROL_HEIGHT_CLASS, CONTROL_TEXT_CLASS, type ControlSize } from './controlSize';
import { cn } from '../cn';

export interface NativeSelectProps
  extends Omit<ComponentPropsWithoutRef<'select'>, 'className' | 'size'> {
  size?: ControlSize;
  invalid?: boolean;
  className?: string;
  ref?: Ref<HTMLSelectElement>;
}

const BASE_CLASS =
  'w-full min-w-0 border bg-bg px-2 leading-normal text-text ' +
  'hover:not-disabled:not-focus:border-[color-mix(in_srgb,var(--color-text)_45%,transparent)] ' +
  'focus:border-accent disabled:cursor-not-allowed disabled:opacity-45';

export function NativeSelect({
  size = 'sm',
  invalid = false,
  className,
  ref,
  ...rest
}: NativeSelectProps) {
  return (
    <select
      {...rest}
      ref={ref}
      {...(invalid ? { 'aria-invalid': true } : {})}
      className={cn(
        BASE_CLASS,
        CONTROL_HEIGHT_CLASS[size],
        CONTROL_TEXT_CLASS[size],
        invalid ? 'border-fail' : 'border-divider',
        className,
      )}
    />
  );
}
