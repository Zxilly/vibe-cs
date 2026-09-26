import { fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { Button } from '../primitives/Button';
import { Checkbox } from '../primitives/Checkbox';
import { Tooltip } from './Tooltip';

describe('Tooltip', () => {
  it('keeps checkbox selection-limit reasons stable as availability changes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    function SelectionLimit() {
      const [blocked, setBlocked] = useState(false);
      return <>
        <button type="button" onClick={() => setBlocked((value) => !value)}>切换比较上限</button>
        <Checkbox disabled={blocked} disabledReason="最多比较两名选手" aria-label="选择第三名选手" />
      </>;
    }
    try {
      const { getByRole } = renderInteractive(<SelectionLimit />);
      const checkbox = getByRole('checkbox', { name: '选择第三名选手' });
      fireEvent.click(getByRole('button', { name: '切换比较上限' }));
      expect(checkbox).toHaveProperty('disabled', true);
      const description = document.getElementById(checkbox.getAttribute('aria-describedby') ?? '');
      expect(description?.textContent).toBe('最多比较两名选手');
      fireEvent.click(getByRole('button', { name: '切换比较上限' }));
      expect(getByRole('checkbox', { name: '选择第三名选手' })).toBe(checkbox);
      expect(checkbox).toHaveProperty('disabled', false);
      expect(checkbox.hasAttribute('aria-describedby')).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('renders the child untouched when there is nothing to say', () => {
    const { getByRole, container } = renderInteractive(
      <Tooltip>
        <button type="button">导入 Demo</button>
      </Tooltip>,
    );

    expect(getByRole('button', { name: '导入 Demo' })).not.toBeNull();
    expect(container.querySelector('[data-state]')).toBeNull();
  });

  it('opens on focus and names the control it describes', async () => {
    const { getByRole, findByRole } = renderInteractive(
      <Tooltip content="本地服务未连接">
        <button type="button">导入 Demo</button>
      </Tooltip>,
    );

    fireEvent.focus(getByRole('button', { name: '导入 Demo' }));
    expect((await findByRole('tooltip')).textContent).toContain('本地服务未连接');
  });

  /* The whole reason this component exists. A disabled control raises no
     pointer events, so a tooltip hung on it never opens — and the native
     `title` this replaced never showed either. The wrapper is what the pointer
     and the keyboard actually meet. */
  it('still reaches a disabled control, through a focusable wrapper', async () => {
    const { getByRole, findByRole } = renderInteractive(
      <Button disabled disabledReason="本地服务未连接，恢复后无需刷新页面即可继续">
        导入 Demo
      </Button>,
    );

    const button = getByRole('button', { name: /导入 Demo/u }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    const wrapper = button.parentElement;
    expect(wrapper?.getAttribute('tabindex')).toBe('0');

    fireEvent.focus(wrapper as HTMLElement);
    expect((await findByRole('tooltip')).textContent).toContain('本地服务未连接');
  });

  it('does not add a tab stop around a control that can be focused itself', () => {
    const { getByRole } = renderInteractive(
      <Button disabledReason="本地服务未连接">导入 Demo</Button>,
    );

    const button = getByRole('button', { name: /导入 Demo/u });
    expect(button.parentElement?.hasAttribute('tabindex')).toBe(false);
  });

  /* The wrapper becomes the flex item the button used to be, so the modifiers
     that only mean anything to a flex item have to travel with it. */
  it('hands the flex modifiers to the wrapper it introduces', () => {
    const { getByRole } = renderInteractive(
      <Button grow disabled disabledReason="本地服务未连接">
        导入 Demo
      </Button>,
    );

    expect(getByRole('button', { name: /导入 Demo/u }).parentElement?.className).toContain('flex-1');
  });

  it('closes when focus leaves', async () => {
    const { getByRole, queryByRole, findByRole } = renderInteractive(
      <Tooltip content="本地服务未连接">
        <button type="button">导入 Demo</button>
      </Tooltip>,
    );

    const button = getByRole('button', { name: '导入 Demo' });
    fireEvent.focus(button);
    await findByRole('tooltip');

    fireEvent.blur(button);
    await waitFor(() => {
      expect(queryByRole('tooltip')).toBeNull();
    });
  });
});
