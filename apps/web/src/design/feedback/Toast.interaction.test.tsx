import { fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { toast, Toaster } from './Toast';

afterEach(() => {
  toast.clear();
});

describe('Toast', () => {
  it('renders nothing until something is said', () => {
    const { container } = renderInteractive(<Toaster />);
    expect(container.querySelector('[data-variant]')).toBeNull();
  });

  it('shows a message raised from outside the tree', async () => {
    const { findByText } = renderInteractive(<Toaster />);

    toast.success('已复制路径');

    expect(await findByText('已复制路径')).not.toBeNull();
  });

  it('carries a second line for what was affected', async () => {
    const { findByText } = renderInteractive(<Toaster />);

    toast.error('没能打开这个目录', { description: String.raw`D:\CS2\outputs` });

    expect(await findByText('没能打开这个目录')).not.toBeNull();
    expect(await findByText(String.raw`D:\CS2\outputs`)).not.toBeNull();
  });

  /* An error is the one a reader must not miss, so it interrupts and waits
     twice as long; the rest wait for a pause in what the user is doing. */
  it('announces an error assertively and everything else politely', async () => {
    const { findByText } = renderInteractive(<Toaster />);

    toast.error('没能打开这个目录');
    toast.info('已加入队列');

    const failure = (await findByText('没能打开这个目录')).closest('[data-variant]');
    const notice = (await findByText('已加入队列')).closest('[data-variant]');

    expect(failure?.getAttribute('data-variant')).toBe('error');
    expect(notice?.getAttribute('data-variant')).toBe('info');
    // Radix spells the two apart on the live region that wraps each root.
    expect(failure?.closest('[role="region"], li, [data-radix-collection-item]')).not.toBe(
      notice?.closest('[role="region"], li, [data-radix-collection-item]'),
    );
  });

  it('closes from its own control', async () => {
    const { findByText, queryByText, container } = renderInteractive(<Toaster />);

    toast.info('已加入队列');
    await findByText('已加入队列');

    const close = container.ownerDocument.querySelector('[data-toast-close]');
    expect(close).not.toBeNull();
    if (close) fireEvent.click(close);

    await waitFor(() => {
      expect(queryByText('已加入队列')).toBeNull();
    });
  });

  /* A toast's action is a convenience, never the only way out — anything the
     user *must* do belongs in an `Alert`, which cannot disappear. */
  it('runs an optional shortcut without being the only way out', async () => {
    const onAction = vi.fn();
    const { findByText, container } = renderInteractive(<Toaster />);

    toast.success('视图已保存', { action: { label: '撤销', onAction } });
    await findByText('视图已保存');

    const action = container.ownerDocument.querySelector('[data-toast-action]');
    expect(action?.textContent).toBe('撤销');
    if (action) fireEvent.click(action);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('stacks in the order things happened', async () => {
    const { findByText, container } = renderInteractive(<Toaster />);

    toast.info('第一条');
    toast.info('第二条');
    await findByText('第二条');

    const text = container.ownerDocument.querySelector('[data-toaster]')?.textContent ?? '';
    expect(text.indexOf('第一条')).toBeLessThan(text.indexOf('第二条'));
  });

  it('empties on demand', async () => {
    const { findByText, queryByText } = renderInteractive(<Toaster />);

    toast.info('已加入队列');
    await findByText('已加入队列');

    toast.clear();
    await waitFor(() => {
      expect(queryByText('已加入队列')).toBeNull();
    });
  });
});
