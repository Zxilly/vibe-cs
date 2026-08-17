import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { TakeCard, type TakeShotPick } from './TakeCard';
import { PLAN_SHOTS } from './agentFixtures.testing';
import { reasonOf } from '../../test/reason';

function picks(onToggle?: (shot: (typeof PLAN_SHOTS)[number]) => void): readonly TakeShotPick[] {
  return PLAN_SHOTS.map((shot, index) => ({
    shot,
    index: index + 1,
    picked: index === 1,
    ...(onToggle === undefined ? {} : { onToggle }),
  }));
}

describe('TakeCard shot picking', () => {
  it('reports the shot the composition should take from this take', () => {
    const onToggle = vi.fn();
    const { getByRole } = renderInteractive(<TakeCard label="Take B" shots={picks(onToggle)} />);

    fireEvent.click(getByRole('checkbox', { name: /建立地点/u }));
    expect(onToggle).toHaveBeenCalledWith(PLAN_SHOTS[0]);
  });

  it('leaves the boxes inert when the take cannot be composed from', () => {
    const { getAllByRole } = renderInteractive(<TakeCard label="Take A" shots={picks()} />);

    for (const box of getAllByRole('checkbox')) {
      expect((box as HTMLInputElement).disabled).toBe(true);
    }
  });
});

describe('TakeCard actions', () => {
  it('previews and selects the whole take through the caller', () => {
    const onPreview = vi.fn();
    const onUseWhole = vi.fn();
    const { getByRole } = renderInteractive(
      <TakeCard label="Take B" shots={picks()} onPreview={onPreview} onUseWhole={onUseWhole} />,
    );

    fireEvent.click(getByRole('button', { name: '预览' }));
    expect(onPreview).toHaveBeenCalledTimes(1);

    fireEvent.click(getByRole('button', { name: '整条选用' }));
    expect(onUseWhole).toHaveBeenCalledTimes(1);
  });

  it('stays visible and says why when preview has nothing behind it', () => {
    const onPreview = vi.fn();
    const { getByRole } = renderInteractive(
      <TakeCard
        label="Take B"
        shots={picks()}
        onPreview={onPreview}
        previewDisabledReason="这一版还不能渲染镜头预览"
      />,
    );
    const button = getByRole('button', { name: '预览' }) as HTMLButtonElement;

    expect(button.disabled).toBe(true);
    expect(reasonOf(button)).toContain('这一版还不能渲染镜头预览');
    fireEvent.click(button);
    expect(onPreview).not.toHaveBeenCalled();
  });

  it('never starts a recording — selecting a take is not confirming one', () => {
    // §4.5.3 ①: this component has no client and no mutation; the only thing
    // 「整条选用」 can do is call back.
    const onUseWhole = vi.fn();
    const { getByRole } = renderInteractive(
      <TakeCard label="Take B" shots={picks()} onUseWhole={onUseWhole} />,
    );

    fireEvent.click(getByRole('button', { name: '整条选用' }));
    expect(onUseWhole).toHaveBeenCalledTimes(1);
  });
});
