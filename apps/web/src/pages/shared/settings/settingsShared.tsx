/*
 * pages/settings — the pieces all five sections are built from.
 *
 * `AiAgentSection` landed first and grew its own `Block` and switch row; the
 * four sections 3g adds would each have grown a fourth and fifth copy. These
 * are those shapes, extracted once — not a component library, just the three
 * repetitions that were about to happen.
 *
 * Explain consequences when a setting needs them. Self-explanatory labels and
 * diagnostic readouts do not need a mandatory second line.
 */

import type { ReactNode } from 'react';

import { Toggle } from '../../../design/primitives';

export interface SettingsBlockProps {
  /** Stable deep-link target used by `/settings?section=…&item=…`. */
  readonly id?: string | undefined;
  readonly title: ReactNode;
  /** The paragraph under the heading — what this whole block decides. */
  readonly description?: ReactNode | undefined;
  /**
   * Block-level actions, drawn beside the heading. For a block that is one
   * form with one save — 模型 — rather than rows that each write themselves.
   */
  readonly actions?: ReactNode | undefined;
  /** Diagnostic readouts use a stable title rail; editable forms stay stacked. */
  readonly layout?: 'stacked' | 'split' | undefined;
  readonly children: ReactNode;
}

export function SettingsBlock({
  id,
  title,
  description,
  actions,
  layout = 'stacked',
  children,
}: SettingsBlockProps) {
  const identity = {
    ...(id === undefined ? {} : { id: `setting-${id}`, 'data-setting-item': id }),
    ...(id === undefined ? {} : { tabIndex: -1 }),
  };
  const heading = (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 className="text-base font-medium">{title}</h2>
        {description === undefined ? null : (
          <p className="max-w-prose text-sm leading-relaxed text-neutral-600">{description}</p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex flex-none flex-wrap items-center gap-2" data-settings-actions="">
          {actions}
        </div>
      )}
    </div>
  );

  if (layout === 'split') {
    return (
      <section
        data-settings-block=""
        data-settings-layout="split"
        {...identity}
        className="mb-4 grid grid-cols-1 border border-divider bg-bg last:mb-0 lg:grid-cols-[15rem_minmax(0,1fr)]"
      >
        <div className="border-b border-divider px-5 py-4 lg:border-r lg:border-b-0">{heading}</div>
        <div className="flex min-w-0 flex-col gap-4 px-5 py-4">{children}</div>
      </section>
    );
  }

  return (
    <section
      data-settings-block=""
      data-settings-layout="stacked"
      {...identity}
      className="mb-4 flex flex-col gap-4 border border-divider bg-bg px-5 py-4 last:mb-0"
    >
      {heading}
      {children}
    </section>
  );
}

export interface SettingsRowProps {
  readonly label: ReactNode;
  /** Optional consequence or guidance beyond what the label already says. */
  readonly hint?: ReactNode;
  /** The control, the readout, or both. */
  readonly children?: ReactNode | undefined;
  /**
   * Written under the row when the control is unavailable. The design system's
   * `Button` carries its own `disabledReason`; a `Seg`, a `Toggle` or a plain
   * readout does not, so the reason goes here instead of nowhere.
   */
  readonly disabledReason?: string | undefined;
}

/**
 * Label and hint on the left, the control on the right.
 *
 * The text column takes two shares of the width and the control column one,
 * never less than what the control needs: a hint is a sentence someone has to
 * read, and at a 1:2 split it wrapped at 300px with a wide blank between it
 * and a lone button. A slider or an input still gets a third of the row; a
 * wide `Seg` grows its column to fit and the text gives way.
 */
export function SettingsRow({ label, hint, children, disabledReason }: SettingsRowProps) {
  return (
    <div data-settings-row="" className="flex flex-wrap items-start gap-x-8 gap-y-3">
      <div className="min-w-0 basis-64 flex-[2]">
        <p className="text-base">{label}</p>
        {hint == null ? null : <p className="mt-1 max-w-prose text-sm leading-relaxed text-neutral-600">{hint}</p>}
        {disabledReason === undefined ? null : (
          <p className="mt-1 text-xs leading-normal text-warn" data-disabled-reason="">
            {disabledReason}
          </p>
        )}
      </div>
      {children === undefined ? null : (
        <div className="flex min-w-0 max-w-full flex-1 basis-56 flex-wrap justify-end gap-2">{children}</div>
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
  readonly disabled?: boolean | undefined;
  /**
   * A rule the product states rather than a preference it stores — see
   * `Toggle`'s `locked`. The switch stays readable and reachable, and the hint
   * is where the reason for the lock is written.
   */
  readonly locked?: boolean | undefined;
  readonly disabledReason?: string | undefined;
  readonly onChange?: ((next: boolean) => void) | undefined;
}

export function SettingsSwitch({
  label,
  hint,
  name,
  ariaLabel,
  checked,
  disabled = false,
  locked = false,
  disabledReason,
  onChange,
}: SettingsSwitchProps) {
  const switchId = `setting-${name}`;
  const hintId = `${switchId}-hint`;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3.5">
        <div className="min-w-0 flex-1">
          {/* A real label: the 34×18 switch is a small target, and the title
              beside it is the one people actually aim for. */}
          <label htmlFor={switchId} className="block text-base">
            {label}
          </label>
          <p id={hintId} className="mt-1 max-w-prose text-sm leading-relaxed text-neutral-600">
            {hint}
          </p>
        </div>
        <Toggle
          id={switchId}
          checked={checked}
          disabled={disabled}
          locked={locked}
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
