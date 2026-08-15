import { Trans } from '@lingui/react/macro';
import { fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { Dialog } from './Dialog';

/**
 * A trigger plus the dialog it opens — the only way to observe 「关闭后焦点归位」,
 * which needs somewhere for focus to return to.
 */
function DeleteRecords({ onConfirm = () => {} }: { onConfirm?: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => { setOpen(true); }}>
        <Trans>删除</Trans>
      </button>
      <Dialog
        open={open}
        tone="destructive"
        title={<Trans>删除 3 条记录？</Trans>}
        confirmLabel={<Trans>删除</Trans>}
        onConfirm={onConfirm}
        onClose={() => { setOpen(false); }}
      >
        <Trans>其中 2 条是受管文件，会进入可回滚暂存。</Trans>
      </Dialog>
    </>
  );
}

describe('Dialog focus contract', () => {
  it('moves focus into the dialog when it opens', () => {
    const { getByRole, getAllByRole } = renderInteractive(<DeleteRecords />);
    fireEvent.click(getByRole('button', { name: '删除' }));

    const dialog = getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    // First focusable inside is 取消, per the artboard's fixed 取消 / 主动作 order.
    expect(document.activeElement).toBe(getAllByRole('button', { name: '取消' })[0]);
  });

  it('closes on Escape', () => {
    const { getByRole, queryByRole } = renderInteractive(<DeleteRecords />);
    fireEvent.click(getByRole('button', { name: '删除' }));
    expect(queryByRole('dialog')).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(queryByRole('dialog')).toBeNull();
  });

  it('returns focus to the trigger after closing', () => {
    const { getByRole } = renderInteractive(<DeleteRecords />);
    const trigger = getByRole('button', { name: '删除' });
    trigger.focus();
    fireEvent.click(trigger);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
  });

  it('traps Tab inside the dialog', () => {
    const { getByRole } = renderInteractive(<DeleteRecords />);
    fireEvent.click(getByRole('button', { name: '删除' }));

    const dialog = getByRole('dialog');
    const focusable = Array.from(dialog.querySelectorAll('button'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    expect(first).not.toBe(last);

    last?.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    // Whatever the cycle does, it never lands outside the panel — the trigger
    // behind the dialog stays unreachable by keyboard.
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('runs the action only when the confirm button is pressed', () => {
    const onConfirm = vi.fn();
    const { getByRole, getAllByRole } = renderInteractive(<DeleteRecords onConfirm={onConfirm} />);
    fireEvent.click(getByRole('button', { name: '删除' }));

    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();

    const confirm = getAllByRole('button', { name: '删除' }).find(
      (button) => button.dataset['dialogAction'] === 'confirm',
    );
    expect(confirm).toBeDefined();
    confirm?.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('dismisses on a click outside the panel but not on one inside it', () => {
    const { getByRole, queryByRole, container } = renderInteractive(<DeleteRecords />);
    fireEvent.click(getByRole('button', { name: '删除' }));

    fireEvent.click(getByRole('dialog'));
    expect(queryByRole('dialog')).not.toBeNull();

    const backdrop = container.querySelector('[data-overlay="dialog-backdrop"]');
    expect(backdrop).not.toBeNull();
    if (backdrop) fireEvent.click(backdrop);
    expect(queryByRole('dialog')).toBeNull();
  });
});
