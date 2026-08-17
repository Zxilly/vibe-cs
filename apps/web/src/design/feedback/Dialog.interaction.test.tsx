import { Trans } from '@lingui/react/macro';
import { act, fireEvent, waitFor } from '@testing-library/react';
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

  it('returns focus to the trigger after closing', async () => {
    const { getByRole } = renderInteractive(<DeleteRecords />);
    const trigger = getByRole('button', { name: '删除' });
    trigger.focus();
    fireEvent.click(trigger);

    fireEvent.keyDown(document, { key: 'Escape' });
    /* Radix restores focus after the unmount settles, so that a component
       tearing down alongside the dialog cannot steal it back. */
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  it('traps focus inside the dialog', () => {
    const { getByRole, getAllByRole } = renderInteractive(<DeleteRecords />);
    const trigger = getByRole('button', { name: '删除' });
    fireEvent.click(trigger);

    const dialog = getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);

    /* Asserted by pulling focus out rather than by a synthetic Tab: Tab does
       not move focus in jsdom, and Radix's scope watches where focus actually
       lands rather than intercepting the key. Focusing the trigger behind the
       dialog is what a Tab out of the panel would amount to. */
    trigger.focus();
    expect(document.activeElement).not.toBe(trigger);
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Both actions stay reachable inside it.
    const confirm = getAllByRole('button', { name: '删除' }).find(
      (button) => button.dataset['dialogAction'] === 'confirm',
    );
    confirm?.focus();
    expect(document.activeElement).toBe(confirm);
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

  it('dismisses on a press outside the panel but not on one inside it', async () => {
    const { getByRole, queryByRole } = renderInteractive(<DeleteRecords />);
    fireEvent.click(getByRole('button', { name: '删除' }));

    /* Radix arms the outside-press listener on a zero-delay timeout, so that
       the very press which opened the overlay cannot also dismiss it. */
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    fireEvent.pointerDown(getByRole('dialog'));
    expect(queryByRole('dialog')).not.toBeNull();

    /* `document`, not the render container: the overlay is portalled to the
       body. And a whole press, not a bare click — Radix decides on the
       `pointerdown`, which is what makes the case above work: a text selection
       that starts inside the panel and is released outside does not take the
       dialog with it. */
    const backdrop = document.querySelector('[data-overlay="dialog-backdrop"]');
    expect(backdrop).not.toBeNull();
    if (backdrop) {
      fireEvent.pointerDown(backdrop);
      fireEvent.click(backdrop);
    }
    expect(queryByRole('dialog')).toBeNull();
  });
});
