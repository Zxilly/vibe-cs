import { fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { Checkbox } from './Checkbox';

function Controlled() {
  const [checked, setChecked] = useState(false);
  return (
    <Checkbox checked={checked} onChange={setChecked}>
      包含子目录
    </Checkbox>
  );
}

describe('Checkbox interaction', () => {
  it('is named by its own label and toggles on click', () => {
    const { getByRole } = renderInteractive(<Controlled />);
    const box = getByRole('checkbox', { name: '包含子目录' });

    expect(box.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(box);
    expect(box.getAttribute('aria-checked')).toBe('true');
  });

  it('toggles from the label as well as from the drawn box', () => {
    const onChange = vi.fn();
    const { getByText, getByRole } = renderInteractive(<Checkbox onChange={onChange}>包含子目录</Checkbox>);

    // `htmlFor` points at the box, so the text is a valid target for it.
    expect(getByText('包含子目录').getAttribute('for')).toBe(getByRole('checkbox').getAttribute('id'));

    fireEvent.click(getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('reports the next state rather than an event', () => {
    const onChange = vi.fn();
    const { getByRole } = renderInteractive(
      <Checkbox checked onChange={onChange} aria-label="选择该行" />,
    );

    fireEvent.click(getByRole('checkbox', { name: '选择该行' }));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('is keyboard reachable', () => {
    const { getByRole } = renderInteractive(<Controlled />);
    const box = getByRole('checkbox', { name: '包含子目录' });

    box.focus();
    expect(document.activeElement).toBe(box);
  });

  it('announces a partial selection as mixed', () => {
    const { getByRole } = renderInteractive(<Checkbox indeterminate aria-label="全选" />);
    const box = getByRole('checkbox', { name: '全选' });

    expect(box.getAttribute('aria-checked')).toBe('mixed');
    expect(box.getAttribute('data-state')).toBe('indeterminate');
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
    const box = getByRole('checkbox', { name: '全选' });
    expect(box.getAttribute('aria-checked')).toBe('mixed');

    fireEvent.click(getByRole('button', { name: '解决' }));
    expect(box.getAttribute('aria-checked')).toBe('false');
  });

  it('does not toggle while disabled', () => {
    const onChange = vi.fn();
    const { getByRole } = renderInteractive(
      <Checkbox disabled onChange={onChange} aria-label="选择该行" />,
    );
    const box = getByRole('checkbox', { name: '选择该行' }) as HTMLButtonElement;

    expect(box.disabled).toBe(true);
    fireEvent.click(box);
    expect(onChange).not.toHaveBeenCalled();

    box.focus();
    expect(document.activeElement).not.toBe(box);
  });
});
