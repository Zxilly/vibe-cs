import { fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { Field } from './Field';
import { Input } from './Input';
import { InputGroup, InputGroupAddon, InputGroupInput } from './InputGroup';

function Controlled() {
  const [value, setValue] = useState('');
  return (
    <Input aria-label="搜索" value={value} onChange={(event) => setValue(event.currentTarget.value)} />
  );
}

describe('Input interaction', () => {
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
    const { getByRole } = renderInteractive(<Input aria-label="搜索" disabled onChange={onChange} />);
    const input = getByRole('textbox', { name: '搜索' }) as HTMLInputElement;

    expect(input.disabled).toBe(true);
    input.focus();
    expect(document.activeElement).not.toBe(input);
  });

  it('is named and described by its Field, not by a nearby label', () => {
    const { getByRole, getByText } = renderInteractive(
      <Field label="时长" hint="不超过 30 秒">
        {(control) => <Input {...control} />}
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
        {(control) => <Input {...control} />}
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
      <InputGroup>
        <InputGroupAddon>
          <svg data-testid="icon" />
        </InputGroupAddon>
        <InputGroupInput aria-label="搜索" />
      </InputGroup>,
    );
    const input = getByRole('textbox', { name: '搜索' });
    // The magnifier says nothing the field's own name does not.
    expect(input.getAttribute('aria-label')).toBe('搜索');
    expect(document.querySelector('[data-align]')?.getAttribute('aria-hidden')).toBe('true');
  });
});
