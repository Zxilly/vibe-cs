import { fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { Checkbox } from './Checkbox';

function Controlled() {
  const [checked, setChecked] = useState(false);
  return (
    <Checkbox checked={checked} onChange={(event) => setChecked(event.currentTarget.checked)}>
      包含子目录
    </Checkbox>
  );
}

describe('Checkbox interaction', () => {
  it('is named by its own label and toggles on click', () => {
    const { getByRole } = renderInteractive(<Controlled />);
    const box = getByRole('checkbox', { name: '包含子目录' }) as HTMLInputElement;

    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(box.checked).toBe(true);
  });

  it('toggles when the drawn box is clicked, not only the input', () => {
    const onChange = vi.fn();
    const { getByText } = renderInteractive(<Checkbox onChange={onChange}>包含子目录</Checkbox>);

    // The label wraps everything, so the 15px square is a valid target.
    fireEvent.click(getByText('包含子目录'));
    expect(onChange).toHaveBeenCalled();
  });

  it('is keyboard reachable', () => {
    const { getByRole } = renderInteractive(<Controlled />);
    const box = getByRole('checkbox', { name: '包含子目录' }) as HTMLInputElement;

    box.focus();
    expect(document.activeElement).toBe(box);
  });

  it('sets the DOM-only indeterminate property, which no attribute can carry', () => {
    const { getByRole } = renderInteractive(<Checkbox indeterminate aria-label="全选" />);
    const box = getByRole('checkbox', { name: '全选' }) as HTMLInputElement;

    expect(box.indeterminate).toBe(true);
    expect(box.getAttribute('aria-checked')).toBe('mixed');
  });

  it('clears indeterminate when the selection resolves', () => {
    function Partial() {
      const [partial, setPartial] = useState(true);
      return (
        <>
          <Checkbox indeterminate={partial} aria-label="全选" />
          <button type="button" onClick={() => setPartial(false)}>
            解决
          </button>
        </>
      );
    }

    const { getByRole } = renderInteractive(<Partial />);
    const box = getByRole('checkbox', { name: '全选' }) as HTMLInputElement;
    expect(box.indeterminate).toBe(true);

    fireEvent.click(getByRole('button', { name: '解决' }));
    expect(box.indeterminate).toBe(false);
  });

  it('does not toggle while disabled', () => {
    const { getByRole } = renderInteractive(<Checkbox disabled aria-label="选择该行" />);
    const box = getByRole('checkbox', { name: '选择该行' }) as HTMLInputElement;

    // Asserted on the platform state, not on a handler: a synthetic
    // `fireEvent.click` bypasses the disabled gate a real click obeys, so a
    // handler assertion here would be testing jsdom rather than the component.
    expect(box.disabled).toBe(true);

    box.focus();
    expect(document.activeElement).not.toBe(box);
  });
});
