import { Trans } from '@lingui/react/macro';
import { fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { renderInteractive } from '../../test/render';
import { Drawer } from './Drawer';
import { overlayActionClass } from './actionButton';

/** A table row that opens the annotation drawer — the artboard's own trigger. */
function EvidenceRow() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => { setOpen(true); }}>
        <Trans>证据详情</Trans>
      </button>
      <Drawer
        open={open}
        title={<Trans>证据注释</Trans>}
        onClose={() => { setOpen(false); }}
        footer={
          <button type="button" className={overlayActionClass('primary')}>
            <Trans>保存</Trans>
          </button>
        }
      >
        <textarea defaultValue="这堵墙的穿点可以单独做一条教学。" />
      </Drawer>
    </>
  );
}

describe('Drawer focus contract', () => {
  it('moves focus into the drawer when it opens', () => {
    const { getByRole } = renderInteractive(<EvidenceRow />);
    fireEvent.click(getByRole('button', { name: '证据详情' }));

    const drawer = getByRole('dialog');
    expect(drawer.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(getByRole('button', { name: '关闭抽屉' }));
  });

  it('closes on Escape', () => {
    const { getByRole, queryByRole } = renderInteractive(<EvidenceRow />);
    fireEvent.click(getByRole('button', { name: '证据详情' }));
    expect(queryByRole('dialog')).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(queryByRole('dialog')).toBeNull();
  });

  it('returns focus to the trigger row after closing — 焦点回到触发行', () => {
    const { getByRole } = renderInteractive(<EvidenceRow />);
    const trigger = getByRole('button', { name: '证据详情' });
    trigger.focus();
    fireEvent.click(trigger);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
  });

  it('closes from its own close button as well', () => {
    const { getByRole, queryByRole } = renderInteractive(<EvidenceRow />);
    const trigger = getByRole('button', { name: '证据详情' });
    trigger.focus();
    fireEvent.click(trigger);

    fireEvent.click(getByRole('button', { name: '关闭抽屉' }));
    expect(queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('cycles Tab through its own controls, editable body included', () => {
    const { getByRole } = renderInteractive(<EvidenceRow />);
    fireEvent.click(getByRole('button', { name: '证据详情' }));

    const close = getByRole('button', { name: '关闭抽屉' });
    const save = getByRole('button', { name: '保存' });
    const textarea = getByRole('textbox');

    expect(document.activeElement).toBe(close);

    save.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(save);

    // 非阻断编辑: the body is a real form control, not a read-only detail pane.
    textarea.focus();
    expect(getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('leaves the page behind interactive — no scrim intercepts the pointer', () => {
    const { getByRole, container } = renderInteractive(<EvidenceRow />);
    fireEvent.click(getByRole('button', { name: '证据详情' }));

    expect(container.querySelector('[data-overlay="dialog-backdrop"]')).toBeNull();
    const drawer = getByRole('dialog');
    expect(drawer.getAttribute('aria-modal')).toBeNull();
  });
});
