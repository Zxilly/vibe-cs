import { fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { Field } from './Field';
import { TextInput } from './TextInput';

function Controlled() {
  const [value, setValue] = useState('');
  return (
    <TextInput aria-label="搜索" value={value} onChange={(event) => setValue(event.currentTarget.value)} />
  );
}

describe('TextInput interaction', () => {
  it('is focusable and reports what was typed', () => {
    const { getByRole } = renderInteractive(<Controlled />);
    const input = getByRole('textbox', { name: '搜索' }) as HTMLInputElement;

    input.focus();
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: 'Aurora' } });
    expect(input.value).toBe('Aurora');
  });

  it('does not accept input while disabled', () => {
    const onChange = vi.fn();
    const { getByRole } = renderInteractive(<TextInput aria-label="搜索" disabled onChange={onChange} />);
    const input = getByRole('textbox', { name: '搜索' }) as HTMLInputElement;

    expect(input.disabled).toBe(true);
    input.focus();
    expect(document.activeElement).not.toBe(input);
  });

  it('is named and described by its Field, not by a nearby label', () => {
    const { getByRole, getByText } = renderInteractive(
      <Field label="时长" hint="不超过 30 秒">
        {(control) => <TextInput {...control} />}
      </Field>,
    );

    const input = getByRole('textbox', { name: '时长' });
    const hintId = input.getAttribute('aria-describedby');
    expect(hintId).not.toBeNull();
    expect(document.getElementById(hintId ?? '')).toBe(getByText('不超过 30 秒'));
  });

  it('announces the error and stops announcing the hint', () => {
    const { getByRole, queryByText } = renderInteractive(
      <Field label="时长" hint="不超过 30 秒" error="必须是正数">
        {(control) => <TextInput {...control} />}
      </Field>,
    );

    const input = getByRole('textbox', { name: '时长' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(queryByText('不超过 30 秒')).toBeNull();

    const errorId = input.getAttribute('aria-describedby');
    expect(document.getElementById(errorId ?? '')?.getAttribute('role')).toBe('alert');
  });

  it('keeps a decorative adornment out of the accessibility tree', () => {
    const { getByRole } = renderInteractive(
      <TextInput aria-label="搜索" leading={<svg data-testid="icon" />} />,
    );
    const input = getByRole('textbox', { name: '搜索' });
    expect(input.getAttribute('aria-label')).toBe('搜索');
  });
});
