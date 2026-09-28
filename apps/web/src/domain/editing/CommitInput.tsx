import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { Input, Textarea, type InputProps } from '../../design/primitives';

/**
 * What a committed text did: a reason when it cannot be committed, `true`
 * when it became one Human Edit, `false` when it matched the Editing Document.
 */
export type CommitResult = string | boolean;

/**
 * Inspector text entry that writes the Editing Document only on a completed
 * gesture: blur or Enter commits, Escape restores the canonical value, and the
 * characters typed in between stay local. An invalid entry stays in the field,
 * marked with its reason, while the document keeps the last good value.
 */
export function CommitInput({
  value,
  onCommit,
  multiline = false,
  ...props
}: Omit<InputProps, 'value' | 'defaultValue' | 'onChange' | 'onBlur' | 'onKeyDown' | 'invalid'> & {
  readonly value: string | number;
  readonly onCommit: (text: string) => CommitResult;
  /** Enter inserts a line; Ctrl/Cmd+Enter or blur commits. */
  readonly multiline?: boolean;
}) {
  const committed = String(value);
  // `base` pins the edit to the value it started from, so a committed edit
  // keeps showing until the Editing Document answers with its replacement.
  const [edit, setEdit] = useState<{ readonly text: string; readonly base: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const editing = edit !== null && edit.base === committed;
  const settle = () => {
    if (!editing) return;
    if (edit.text === committed) {
      setEdit(null);
      setError(null);
      return;
    }
    const result = onCommit(edit.text);
    if (typeof result === 'string') {
      setError(result);
      return;
    }
    setError(null);
    if (!result) setEdit(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setEdit(null);
      setError(null);
    } else if (event.key === 'Enter' && (!multiline || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      settle();
    }
  };
  const shown = editing ? edit.text : committed;
  const invalid = editing && error !== null;
  const describedBy = invalid ? { 'aria-describedby': errorId } : {};
  return (
    <>
      {multiline ? (
        <Textarea
          rows={4}
          {...(props.maxLength === undefined ? {} : { maxLength: props.maxLength })}
          {...(props['aria-label'] === undefined ? {} : { 'aria-label': props['aria-label'] })}
          {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
          {...describedBy}
          invalid={invalid}
          value={shown}
          onChange={(event) => { setEdit({ text: event.currentTarget.value, base: committed }); setError(null); }}
          onBlur={settle}
          onKeyDown={onKeyDown}
        />
      ) : (
        <Input
          {...props}
          {...describedBy}
          invalid={invalid}
          value={shown}
          onChange={(event) => { setEdit({ text: event.currentTarget.value, base: committed }); setError(null); }}
          onBlur={settle}
          onKeyDown={onKeyDown}
        />
      )}
      {invalid ? <span id={errorId} role="alert" className="col-span-full text-xs text-fail-text">{error}</span> : null}
    </>
  );
}

/**
 * Native colour well committed on its `change` event — when the picker closes —
 * rather than on every `input` event React reports while the user drags.
 */
export function CommitColorInput({
  value,
  onCommit,
  label,
  disabled,
}: {
  readonly value: string;
  readonly onCommit: (color: string) => void;
  readonly label: string;
  readonly disabled: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current!.value = value;
  }, [value]);
  useEffect(() => {
    const input = ref.current!;
    const listener = () => onCommit(input.value.toUpperCase());
    input.addEventListener('change', listener);
    return () => input.removeEventListener('change', listener);
  }, [onCommit]);
  return <input ref={ref} type="color" aria-label={label} disabled={disabled} defaultValue={value} />;
}
