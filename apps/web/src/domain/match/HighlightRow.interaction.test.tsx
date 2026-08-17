import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { HighlightRow } from './HighlightRow';
import { HIGHLIGHT } from './matchFixtures.testing';

describe('HighlightRow multi-select', () => {
  it('reports the new state and the candidate — the input of 「已选 2 条」', () => {
    const onSelectedChange = vi.fn();
    const { getByRole } = renderInteractive(
      <HighlightRow highlight={HIGHLIGHT} selected={false} onSelectedChange={onSelectedChange} />,
    );

    fireEvent.click(getByRole('checkbox', { name: '选择这条高光' }));
    expect(onSelectedChange).toHaveBeenCalledWith(true, HIGHLIGHT);
  });

  it('is controlled: unchecking a selected row reports false', () => {
    const onSelectedChange = vi.fn();
    const { getByRole } = renderInteractive(
      <HighlightRow highlight={HIGHLIGHT} selected onSelectedChange={onSelectedChange} />,
    );

    const box = getByRole('checkbox', { name: '选择这条高光' });
    expect(box.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(box);
    expect(onSelectedChange).toHaveBeenCalledWith(false, HIGHLIGHT);
  });

  it('keeps no copy of the selection — the list owns it', () => {
    const { getByRole, rerender } = renderInteractive(
      <HighlightRow highlight={HIGHLIGHT} selected={false} onSelectedChange={() => {}} />,
    );

    fireEvent.click(getByRole('checkbox', { name: '选择这条高光' }));
    expect(getByRole('checkbox', { name: '选择这条高光' }).getAttribute('aria-checked')).toBe('false');

    rerender(<HighlightRow highlight={HIGHLIGHT} selected onSelectedChange={() => {}} />);
    expect(getByRole('checkbox', { name: '选择这条高光' }).getAttribute('aria-checked')).toBe('true');
  });

  it('reaches the checkbox with the keyboard', () => {
    const { getByRole } = renderInteractive(
      <HighlightRow highlight={HIGHLIGHT} selected={false} onSelectedChange={() => {}} />,
    );

    const box = getByRole('checkbox', { name: '选择这条高光' });
    box.focus();
    expect(document.activeElement).toBe(box);
  });

  it('does not throw when a checkbox is drawn with no handler behind it', () => {
    const { getByRole } = renderInteractive(<HighlightRow highlight={HIGHLIGHT} selected={false} />);

    expect(() => fireEvent.click(getByRole('checkbox', { name: '选择这条高光' }))).not.toThrow();
  });
});

describe('HighlightRow action', () => {
  it('runs the page-supplied 加入视频 without touching the selection', () => {
    const onAdd = vi.fn();
    const onSelectedChange = vi.fn();
    const { getByRole } = renderInteractive(
      <HighlightRow
        highlight={HIGHLIGHT}
        selected={false}
        onSelectedChange={onSelectedChange}
        action={
          <button type="button" onClick={onAdd}>
            加入视频
          </button>
        }
      />,
    );

    fireEvent.click(getByRole('button', { name: '加入视频' }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onSelectedChange).not.toHaveBeenCalled();
  });
});
