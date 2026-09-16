import { fireEvent, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { TimelineToolStrip } from './TimelineToolStrip';

const ALL_TOOLS = [
  '选择工具 (V)',
  '手形工具 (H)',
  '缩放工具 (Z)',
  '向前选择轨道工具 (A)',
  '向后选择轨道工具 (Shift+A)',
  '波纹编辑工具 (B)',
  '剃刀工具 (C)',
  '滑移工具 (Y)',
  '滚动编辑工具 (N)',
  '比率伸缩工具 (R)',
  '滑动工具 (U)',
];

/*
 * jsdom lays nothing out, so the rail's own box is stubbed: `clientHeight`
 * on the rail and the three style values the slot count reads from it.
 */
function layOutRail(height: number): void {
  const original = window.getComputedStyle.bind(window);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.getAttribute('aria-label') === '时间轴工具' ? height : 0;
  });
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = original(element, pseudo);
    if (!(element instanceof HTMLElement) || element.getAttribute('aria-label') !== '时间轴工具') return style;
    return {
      rowGap: '4px',
      paddingTop: '4px',
      paddingBottom: '0px',
      getPropertyValue: (name: string) => (name === '--h-ctl-sm' ? '32px' : ''),
    } as unknown as CSSStyleDeclaration;
  });
}

function renderStrip(editTool: Parameters<typeof TimelineToolStrip>[0]['editTool'] = 'selection') {
  const onChangeTool = vi.fn();
  const view = renderInteractive(
    <TimelineToolStrip
      editTool={editTool}
      canRippleTool
      canSlipTool
      canRollTool={false}
      canRateTool
      canSlideTool
      onChangeTool={onChangeTool}
    />,
  );
  return { ...view, onChangeTool };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TimelineToolStrip', () => {
  it('shows every tool while the rail has not been measured', () => {
    const { getByRole, queryByRole } = renderStrip();

    for (const name of ALL_TOOLS) getByRole('button', { name });
    expect(queryByRole('button', { name: '更多工具' })).toBeNull();
  });

  it('folds the tools past the rail height into 「更多工具」', () => {
    // The default 1440 × 900 layout: 304px holds eight 32px slots with 4px gaps.
    layOutRail(304);
    const { getByRole, queryByRole, onChangeTool } = renderStrip('rate');

    for (const name of ALL_TOOLS.slice(0, 7)) getByRole('button', { name });
    for (const name of ALL_TOOLS.slice(7)) expect(queryByRole('button', { name })).toBeNull();

    const more = getByRole('button', { name: '更多工具' });
    // The active tool lives inside the fold, so the fold carries its pressed face.
    expect(more.className).toContain('bg-accent-100');

    fireEvent.pointerDown(more, { button: 0, ctrlKey: false });
    const items = within(getByRole('menu')).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(ALL_TOOLS.slice(7));
    expect(items[1]?.getAttribute('aria-disabled')).toBe('true');
    expect(items[2]?.getAttribute('aria-current')).toBe('page');

    fireEvent.click(items[3]!);
    expect(onChangeTool).toHaveBeenCalledWith('slide');
  });
});
