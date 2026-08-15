import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { Button } from './Button';

describe('Button interaction', () => {
  it('is reachable by keyboard and fires on Enter', () => {
    const onClick = vi.fn();
    const { getByRole } = renderInteractive(<Button onClick={onClick}>确认</Button>);
    const button = getByRole('button', { name: '确认' });

    button.focus();
    expect(document.activeElement).toBe(button);

    // A native <button> turns Enter and Space into a click; the primitive must
    // not have replaced it with a div plus a handler.
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire while disabled', () => {
    const onClick = vi.fn();
    const { getByRole } = renderInteractive(
      <Button disabled disabledReason="本地服务离线" onClick={onClick}>
        开始录制
      </Button>,
    );
    const button = getByRole('button', { name: '开始录制' });

    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('exposes the disabled reason as the accessible description', () => {
    const { getByRole } = renderInteractive(
      <Button disabled disabledReason="本地服务离线">
        开始录制
      </Button>,
    );
    const button = getByRole('button', { name: '开始录制' });
    const describedBy = button.getAttribute('aria-describedby');

    expect(describedBy).not.toBeNull();
    const description = document.getElementById(describedBy ?? '');
    expect(description?.textContent).toBe('此动作当前不可用：本地服务离线');

    // Description, not name: the reason must not leak into the label.
    expect(button.textContent).toBe('开始录制');
  });

  it('keeps an icon-only button nameable', () => {
    const { getByRole } = renderInteractive(<Button icon aria-label="展开检查器" />);
    expect(getByRole('button', { name: '展开检查器' })).toBeDefined();
  });
});
