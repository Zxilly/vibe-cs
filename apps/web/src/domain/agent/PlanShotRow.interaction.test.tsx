import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { PlanShotRow } from './PlanShotRow';
import { SHOT_CRANE_REMOVED, SHOT_TRACKING } from './agentFixtures.testing';
import { reasonOf } from '../../test/reason';

describe('PlanShotRow selection', () => {
  it('reports the whole shot', () => {
    const onSelect = vi.fn();
    const { container } = renderInteractive(
      <PlanShotRow shot={SHOT_TRACKING} index={2} onSelect={onSelect} />,
    );

    const button = container.querySelector('[data-plan-shot-select]');
    expect(button).not.toBeNull();
    if (button !== null) fireEvent.click(button);

    expect(onSelect).toHaveBeenCalledWith(SHOT_TRACKING);
  });

  it('is a real button, so the 2b header row is keyboard-reachable', () => {
    const { container } = renderInteractive(
      <PlanShotRow shot={SHOT_TRACKING} index={2} onSelect={vi.fn()} selected />,
    );
    const button = container.querySelector('[data-plan-shot-select]');

    expect(button?.tagName).toBe('BUTTON');
    expect(button?.getAttribute('aria-pressed')).toBe('true');
  });

  it('draws no selection affordance when the list does not select', () => {
    const { container } = renderInteractive(<PlanShotRow shot={SHOT_TRACKING} index={2} />);

    expect(container.querySelector('[data-plan-shot-select]')).toBeNull();
  });
});

describe('PlanShotRow 撤销删除', () => {
  it('undoes the soft delete — a removal that cannot be taken back is a delete', () => {
    const onRestore = vi.fn();
    const { getByRole } = renderInteractive(
      <PlanShotRow shot={SHOT_CRANE_REMOVED} index={4} onRestore={onRestore} />,
    );

    fireEvent.click(getByRole('button', { name: '撤销删除' }));
    expect(onRestore).toHaveBeenCalledWith(SHOT_CRANE_REMOVED);
  });

  it('stays visible and says why when it cannot run — 不隐藏、不静默失败', () => {
    const onRestore = vi.fn();
    const { getByRole } = renderInteractive(
      <PlanShotRow
        shot={SHOT_CRANE_REMOVED}
        index={4}
        onRestore={onRestore}
        restoreDisabledReason="编辑会记入会话，请先选择或新建一条会话"
      />,
    );
    const button = getByRole('button', { name: '撤销删除' });

    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(reasonOf(button)).toContain('编辑会记入会话，请先选择或新建一条会话');

    fireEvent.click(button);
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('does not select the row when the footer button is pressed', () => {
    const onSelect = vi.fn();
    const onRestore = vi.fn();
    const { getByRole } = renderInteractive(
      <PlanShotRow shot={SHOT_CRANE_REMOVED} index={4} onSelect={onSelect} onRestore={onRestore} />,
    );

    // The footer sits outside the selecting button precisely so this holds.
    fireEvent.click(getByRole('button', { name: '撤销删除' }));
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
