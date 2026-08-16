/*
 * pages/settings — the pieces all five sections are built from.
 *
 * `AiAgentSection` landed first and grew its own `Block` and switch row; the
 * four sections 3g adds would each have grown a fourth and fifth copy. These
 * are those shapes, extracted once — not a component library, just the three
 * repetitions that were about to happen.
 *
 * ## Why every row states 「影响：…」
 *
 * The artboard's own instruction for this page is 「每项写清『会影响什么』」, and
 * it is the whole reason the page is organised by user goal rather than by
 * config key. A row called 「保留队内」 with no second line is a word the user
 * has to guess the consequence of; with one, it is a decision they can make.
 *
 * `hint` is therefore a required prop on every row here. A row that genuinely
 * has nothing to say about its effect is a row that should not be a setting.
 */

import type { ReactNode } from 'react';

import { Toggle } from '../../design/primitives';

export interface SettingsBlockProps {
  readonly title: ReactNode;
  /** The paragraph under the heading — what this whole block decides. */
  readonly description?: ReactNode | undefined;
  readonly children: ReactNode;
}

export function SettingsBlock({ title, description, children }: SettingsBlockProps) {
  return (
    <section className="flex flex-col gap-4 border-b border-divider px-5 py-5 last:border-b-0">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium">{title}</h2>
        {description === undefined ? null : (
          <p className="text-xs leading-normal text-neutral-600">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

export interface SettingsRowProps {
  readonly label: ReactNode;
  /** 「影响：…」. Required — see the module comment. */
  readonly hint: ReactNode;
  /** The control, the readout, or both. */
  readonly children?: ReactNode | undefined;
  /**
   * Written under the row when the control is unavailable. The design system's
   * `Button` carries its own `disabledReason`; a `Seg`, a `Toggle` or a plain
   * readout does not, so the reason goes here instead of nowhere.
   */
  readonly disabledReason?: string | undefined;
}

export function SettingsRow({ label, hint, children, disabledReason }: SettingsRowProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-base">{label}</p>
        {children}
      </div>
      <p className="text-xs leading-normal text-neutral-600">{hint}</p>
      {disabledReason === undefined ? null : (
        <p className="text-xs leading-normal text-warn" data-disabled-reason="">
          {disabledReason}
        </p>
      )}
    </div>
  );
}

export interface SettingsSwitchProps {
  readonly label: ReactNode;
  readonly hint: ReactNode;
  /** Becomes `data-setting`, so a test names the switch rather than its index. */
  readonly name: string;
  readonly ariaLabel: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly disabledReason?: string | undefined;
  readonly onChange: (next: boolean) => void;
}

export function SettingsSwitch({
  label,
  hint,
  name,
  ariaLabel,
  checked,
  disabled,
  disabledReason,
  onChange,
}: SettingsSwitchProps) {
  const hintId = `setting-${name}-hint`;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3.5">
        <div className="min-w-0 flex-1">
          <p className="text-base">{label}</p>
          <p id={hintId} className="mt-1 text-xs leading-normal text-neutral-600">
            {hint}
          </p>
        </div>
        <Toggle
          checked={checked}
          disabled={disabled}
          data-setting={name}
          aria-label={ariaLabel}
          aria-describedby={hintId}
          onChange={onChange}
        />
      </div>
      {disabledReason === undefined ? null : (
        <p className="text-xs leading-normal text-warn" data-disabled-reason="">
          {disabledReason}
        </p>
      )}
    </div>
  );
}

/**
 * A path, monospaced and never truncated in the middle.
 *
 * `break-all` rather than an ellipsis: a Windows path the user is being asked
 * to verify is useless with its middle removed, and these rows exist precisely
 * so someone can check that the thing points where they think it does.
 */
export function PathReadout({ path, empty }: { readonly path: string; readonly empty: ReactNode }) {
  return path.trim() === '' ? (
    <span className="text-xs text-neutral-600">{empty}</span>
  ) : (
    <code className="break-all font-mono text-xs text-neutral-700" data-path={path}>
      {path}
    </code>
  );
}

/** `218 GB` / `4.2 MB` — the free-space and usage readouts. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
