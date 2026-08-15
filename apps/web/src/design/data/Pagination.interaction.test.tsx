import { fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { Pagination } from './Pagination';

describe('Pagination', () => {
  it('steps forward and back', () => {
    const onPageChange = vi.fn();
    const { getByLabelText } = renderInteractive(
      <Pagination page={3} pageSize={20} total={248} onPageChange={onPageChange} />,
    );

    fireEvent.click(getByLabelText('下一页'));
    expect(onPageChange).toHaveBeenLastCalledWith(4);

    fireEvent.click(getByLabelText('上一页'));
    expect(onPageChange).toHaveBeenLastCalledWith(2);
  });

  it('jumps to a numbered page', () => {
    const onPageChange = vi.fn();
    const { getByLabelText } = renderInteractive(
      <Pagination page={1} pageSize={20} total={248} onPageChange={onPageChange} />,
    );

    fireEvent.click(getByLabelText('第 4 页'));
    expect(onPageChange).toHaveBeenCalledWith(4);
  });

  it('cannot step past either end', () => {
    const onPageChange = vi.fn();
    const { getByLabelText, rerender } = renderInteractive(
      <Pagination page={1} pageSize={20} total={41} onPageChange={onPageChange} />,
    );

    const previous = getByLabelText('上一页') as HTMLButtonElement;
    expect(previous.disabled).toBe(true);
    fireEvent.click(previous);
    expect(onPageChange).not.toHaveBeenCalled();

    rerender(<Pagination page={3} pageSize={20} total={41} onPageChange={onPageChange} />);
    const next = getByLabelText('下一页') as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    fireEvent.click(next);
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it('is reachable by keyboard: every control is a real button in tab order', () => {
    const { getByLabelText } = renderInteractive(
      <Pagination page={5} pageSize={20} total={248} onPageChange={() => {}} />,
    );

    const next = getByLabelText('下一页');
    next.focus();
    expect(document.activeElement).toBe(next);
    expect(next.tagName).toBe('BUTTON');
    expect(next.hasAttribute('tabindex')).toBe(false);
  });

  it('keeps the bar the same width as the user walks it', () => {
    function Harness() {
      const [page, setPage] = useState(1);
      return <Pagination page={page} pageSize={20} total={248} onPageChange={setPage} />;
    }

    const { getByLabelText, container } = renderInteractive(<Harness />);
    const slots = () => container.querySelectorAll('nav > div > *').length;

    const first = slots();
    for (let step = 0; step < 6; step += 1) fireEvent.click(getByLabelText('下一页'));
    expect(slots()).toBe(first);
    // And the walk actually moved.
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('7');
  });
});
