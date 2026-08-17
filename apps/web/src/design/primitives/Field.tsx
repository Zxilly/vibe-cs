/**
 * Design system, layer 1 of 3 — Field.
 *
 * Industry's `.field`: a block label above a control. The design reference
 * uses it 23 times — 「镜头类型」「时长」「起始 tick」「结束 tick」 in the shot
 * inspector, the settings forms — always as
 * `<div class="field" style="width:…"><label>…</label><control/></div>`,
 * i.e. the wrapper owns the label and the width, and the control owns its own
 * height.
 *
 * Label, hint and error are wired to the control rather than merely placed
 * near it. Because the control is the caller's, `children` may be a function
 * that receives the ids to apply — a render prop is the only way a wrapper can
 * hand `id` and `aria-describedby` to a child it did not create.
 *
 *     <Field label={<Trans>时长</Trans>} hint={…}>
 *       {(control) => <TextInput {...control} />}
 *     </Field>
 *
 * Passing plain children stays legal for the reference's read-only cases,
 * where the control is a static box with nothing to describe.
 */

import * as LabelPrimitive from '@radix-ui/react-label';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { useId } from 'react';

import { cn } from '../cn';

/** The attributes a Field expects its control to spread. */
export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
}

export interface FieldProps {
  label: ReactNode;
  /** Supporting copy under the control. Suppressed while `error` is present. */
  hint?: ReactNode;
  /** Validation message. Replaces the hint and marks the control invalid. */
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode | ((control: FieldControlProps) => ReactNode);
}

/**
 * Industry's `.field > label`: 12px (--text-xs), 5px below (1.5× the 3.4px
 * `--spacing` base = 5.1px). The colour is Industry's ink-at-70%, which
 * theme.css records as the light value of `--color-neutral-700`; taking the
 * token instead of the mix keeps it legible after the ramp inverts in dark.
 */
const LABEL_CLASS = 'block text-xs leading-normal text-neutral-700 mb-[calc(var(--spacing)*1.5)]';

/** The reference's supporting line: 12px, muted, 3px below (1× --spacing). */
const HINT_CLASS = 'text-xs leading-normal text-neutral-600 mt-1';

const ERROR_CLASS = 'text-xs leading-normal text-fail-text mt-1';

export function Field({ label, hint, error, required = false, className, children }: FieldProps) {
  const generatedId = useId();
  const controlId = `${generatedId}-control`;
  const messageId = `${generatedId}-message`;

  const hasError = error !== undefined && error !== null && error !== false;
  const hasHint = !hasError && hint !== undefined && hint !== null && hint !== false;
  const hasMessage = hasError || hasHint;

  const control: FieldControlProps = {
    id: controlId,
    ...(hasMessage ? { 'aria-describedby': messageId } : {}),
    ...(hasError ? { 'aria-invalid': true as const } : {}),
  };

  return (
    <div className={cn('flex flex-col', className)}>
      {/* shadcn's Label — Radix's — rather than a bare `<label>`: it stops the
          double-click that selects a label's text from also selecting into the
          control beside it, which on these forms means a stray drag over
          「起始 tick」 highlighting the number the user was about to type. */}
      <LabelPrimitive.Root htmlFor={controlId} className={LABEL_CLASS}>
        {label}
        {required ? (
          <>
            <span aria-hidden="true">*</span>
            <span className="sr-only">
              <Trans>必填</Trans>
            </span>
          </>
        ) : null}
      </LabelPrimitive.Root>

      {typeof children === 'function' ? children(control) : children}

      {hasError ? (
        <p id={messageId} className={ERROR_CLASS} role="alert">
          {error}
        </p>
      ) : hasHint ? (
        <p id={messageId} className={HINT_CLASS}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
