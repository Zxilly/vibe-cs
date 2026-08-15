import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { PlanStrip } from './PlanStrip';
import { PLAN_SHOTS, SHOT_TRACKING } from './agentFixtures.testing';

describe('PlanStrip selection', () => {
  it('reports the whole shot, not just the id the block is keyed by', () => {
    const onSelectShot = vi.fn();
    const { getByRole } = renderInteractive(
      <PlanStrip shots={PLAN_SHOTS} onSelectShot={onSelectShot} label="当前方案" />,
    );

    fireEvent.click(getByRole('button', { name: /跟随突破/u }));
    expect(onSelectShot).toHaveBeenCalledWith(SHOT_TRACKING);
  });

  it('is reachable from the keyboard, which a click handler on a div is not', () => {
    const { getByRole } = renderInteractive(
      <PlanStrip shots={PLAN_SHOTS} onSelectShot={vi.fn()} label="当前方案" />,
    );
    const block = getByRole('button', { name: /跟随突破/u });

    block.focus();
    expect(document.activeElement).toBe(block);
    expect(block.tagName).toBe('BUTTON');
  });

  it('says which block is the current one', () => {
    const { getByRole } = renderInteractive(
      <PlanStrip shots={PLAN_SHOTS} onSelectShot={vi.fn()} selectedShotId="shot-02" label="当前方案" />,
    );

    expect(getByRole('button', { name: /跟随突破/u }).getAttribute('aria-pressed')).toBe('true');
    expect(getByRole('button', { name: /建立地点/u }).getAttribute('aria-pressed')).toBe('false');
  });

  it('never makes the 留白 block selectable — it is not a shot', () => {
    const { getAllByRole } = renderInteractive(
      <PlanStrip shots={PLAN_SHOTS} leadSeconds={3} onSelectShot={vi.fn()} label="当前方案" />,
    );

    expect(getAllByRole('button')).toHaveLength(PLAN_SHOTS.length);
  });
});
