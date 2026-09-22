import { fireEvent, within } from '@testing-library/react';
import { useState } from 'react';
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
  function Harness() {
    const [current, setCurrent] = useState(editTool);
    return <TimelineToolStrip
      editTool={current}
      canRazorTool
      canRippleTool
      canSlipTool
      canRollTool={false}
      canRateTool
      canSlideTool
      onChangeTool={(tool) => {
        onChangeTool(tool);
        setCurrent(tool);
      }}
    />;
  }
  const view = renderInteractive(<Harness />);
  return { ...view, onChangeTool };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TimelineToolStrip', () => {
  it('keeps common tools visible and promotes an advanced tool once chosen', () => {
    const { getByRole, queryByRole, onChangeTool } = renderStrip();

    for (const name of ALL_TOOLS.slice(0, 3)) getByRole('button', { name });
    for (const name of ALL_TOOLS.slice(3)) expect(queryByRole('button', { name })).toBeNull();

    fireEvent.pointerDown(getByRole('button', { name: '高级工具' }), { button: 0, ctrlKey: false });
    fireEvent.click(getByRole('menuitem', { name: '剃刀工具 (C)' }));
    expect(onChangeTool).toHaveBeenCalledWith('razor');
    expect(getByRole('button', { name: '剃刀工具 (C)' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(getByRole('button', { name: '选择工具 (V)' }));
    expect(onChangeTool).toHaveBeenLastCalledWith('selection');
    expect(queryByRole('button', { name: '剃刀工具 (C)' })).toBeNull();
  });

  it('preserves the active tool in a short rail and explains unavailable advanced tools', () => {
    layOutRail(120);
    const { getByRole, queryByRole, onChangeTool } = renderStrip('rate');

    getByRole('button', { name: '选择工具 (V)' });
    expect(getByRole('button', { name: '比率伸缩工具 (R)' }).getAttribute('aria-pressed')).toBe('true');
    expect(queryByRole('button', { name: '手形工具 (H)' })).toBeNull();

    fireEvent.pointerDown(getByRole('button', { name: '高级工具' }), { button: 0, ctrlKey: false });
    const items = within(getByRole('menu')).getAllByRole('menuitem');
    expect(items).toHaveLength(9);
    const rolling = getByRole('menuitem', { name: /滚动编辑工具 \(N\)/u });
    expect(rolling.getAttribute('aria-disabled')).toBe('true');
    expect(rolling.textContent).toContain('没有可滚动编辑的未锁定相邻片段');
    fireEvent.click(getByRole('menuitem', { name: '滑动工具 (U)' }));
    expect(onChangeTool).toHaveBeenCalledWith('slide');
    expect(getByRole('button', { name: '滑动工具 (U)' }).getAttribute('aria-pressed')).toBe('true');
  });
});
