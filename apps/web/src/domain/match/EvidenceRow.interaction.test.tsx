import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { EvidenceRow } from './EvidenceRow';
import { EVIDENCE } from './matchFixtures.testing';

describe('EvidenceRow selection', () => {
  it('reports the whole evidence object, not just its id', () => {
    const onSelect = vi.fn();
    const { getByRole } = renderInteractive(<EvidenceRow evidence={EVIDENCE} onSelect={onSelect} />);

    fireEvent.click(getByRole('button', { name: /Kael/u }));
    expect(onSelect).toHaveBeenCalledWith(EVIDENCE);
  });

  it('is reachable with the keyboard, which a click handler on a div is not', () => {
    const onSelect = vi.fn();
    const { getByRole } = renderInteractive(<EvidenceRow evidence={EVIDENCE} onSelect={onSelect} />);
    const row = getByRole('button', { name: /Kael/u });

    row.focus();
    expect(document.activeElement).toBe(row);

    // The browser turns Enter and Space on a `button` into a click; asserting
    // the element type is what makes that guarantee, so this checks the type.
    expect(row.tagName).toBe('BUTTON');
    expect(row.getAttribute('type')).toBe('button');
  });

  it('draws no selection affordance when the list does not select', () => {
    const { container } = renderInteractive(<EvidenceRow evidence={EVIDENCE} />);

    expect(container.querySelector('[data-evidence-select]')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('EvidenceRow 定位', () => {
  it('seeks to this piece of evidence', () => {
    const onLocate = vi.fn();
    const { getByRole } = renderInteractive(<EvidenceRow evidence={EVIDENCE} onLocate={onLocate} />);

    fireEvent.click(getByRole('button', { name: '定位' }));
    expect(onLocate).toHaveBeenCalledWith(EVIDENCE);
  });

  it('does not also select the row when 定位 is pressed', () => {
    const onSelect = vi.fn();
    const onLocate = vi.fn();
    const { getByRole } = renderInteractive(
      <EvidenceRow evidence={EVIDENCE} onSelect={onSelect} onLocate={onLocate} />,
    );

    fireEvent.click(getByRole('button', { name: '定位' }));
    expect(onLocate).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('stays visible and says why when it cannot run — 不隐藏、不静默失败', () => {
    const onLocate = vi.fn();
    const { getByRole } = renderInteractive(
      <EvidenceRow evidence={EVIDENCE} onLocate={onLocate} locateDisabledReason="Demo 文件缺失" />,
    );

    const button = getByRole('button', { name: /定位/u });
    expect(button).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);

    // The reason reaches assistive technology, not only a tooltip.
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy!)?.textContent).toContain('Demo 文件缺失');

    fireEvent.click(button);
    expect(onLocate).not.toHaveBeenCalled();
  });
});
