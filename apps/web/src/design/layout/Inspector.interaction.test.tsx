import { Trans } from '@lingui/react/macro';
import { act, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { stubMatchMedia, type MatchMediaStub } from './collapse.testing';
import { Inspector } from './Inspector';

let media: MatchMediaStub | null = null;

afterEach(() => {
  media?.restore();
  media = null;
});

function panel(open?: boolean) {
  return (
    <Inspector
      title={<Trans>选中：第 21 回合</Trans>}
      label="选中：第 21 回合"
      summary={<Trans>选中 R21 · 1v3 残局</Trans>}
      openLabel={<Trans>证据详情</Trans>}
      summaryActions={
        <button type="button">
          <Trans>加入视频</Trans>
        </button>
      }
      footer={
        <button type="button">
          <Trans>把这个回合加入视频</Trans>
        </button>
      }
      {...(open === undefined ? {} : { defaultOpen: open })}
    >
      <button type="button">
        <Trans>2D 回放</Trans>
      </button>
    </Inspector>
  );
}

describe('Inspector across the §8 breakpoint', () => {
  it('leaves the docked panel for the strip when the window folds', () => {
    media = stubMatchMedia(false);
    const stub = media;
    const { container } = renderInteractive(panel());

    expect(container.querySelector('[data-inspector]')?.getAttribute('data-inspector')).toBe(
      'docked',
    );

    act(() => {
      stub.setMatches(true);
    });

    expect(container.querySelector('[data-inspector]')?.getAttribute('data-inspector')).toBe(
      'summary',
    );
    // §8: the main action is still on screen after the fold.
    expect(container.querySelector('[data-inspector-summary-actions]')?.textContent).toBe(
      '加入视频',
    );
  });

  it('moves focus into the drawer when it opens', () => {
    media = stubMatchMedia(true);
    const { getByRole, container } = renderInteractive(panel());

    fireEvent.click(getByRole('button', { name: '证据详情' }));

    const dialog = getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(container.querySelector('[data-inspector-trigger]')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('closes on Esc and puts focus back on the trigger', () => {
    media = stubMatchMedia(true);
    const { getByRole, queryByRole } = renderInteractive(panel());

    const trigger = getByRole('button', { name: '证据详情' });
    fireEvent.click(trigger);
    fireEvent.keyDown(getByRole('dialog'), { key: 'Escape' });

    expect(queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(getByRole('button', { name: '证据详情' }));
  });

  it('closes from the ✕ control and from the scrim', () => {
    media = stubMatchMedia(true);
    const { getByRole, queryByRole, container } = renderInteractive(panel());

    fireEvent.click(getByRole('button', { name: '证据详情' }));
    fireEvent.click(getByRole('button', { name: '关闭' }));
    expect(queryByRole('dialog')).toBeNull();

    fireEvent.click(getByRole('button', { name: '证据详情' }));
    fireEvent.click(container.querySelector('[data-inspector-scrim]') as HTMLElement);
    expect(queryByRole('dialog')).toBeNull();
  });

  it('traps Tab inside the drawer', () => {
    media = stubMatchMedia(true);
    const { getByRole } = renderInteractive(panel());

    fireEvent.click(getByRole('button', { name: '证据详情' }));
    const dialog = getByRole('dialog');
    const stops = [...dialog.querySelectorAll<HTMLElement>('button')];
    const first = stops[0] as HTMLElement;
    const last = stops[stops.length - 1] as HTMLElement;

    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('reports drawer state to a controlling page', () => {
    media = stubMatchMedia(true);
    const onOpenChange = vi.fn();
    const { getByRole, queryByRole } = renderInteractive(
      <Inspector
        title={<Trans>选中：第 21 回合</Trans>}
        label="选中：第 21 回合"
        openLabel={<Trans>证据详情</Trans>}
        open={false}
        onOpenChange={onOpenChange}
      >
        <p>
          <Trans>回合内证据</Trans>
        </p>
      </Inspector>,
    );

    fireEvent.click(getByRole('button', { name: '证据详情' }));

    expect(onOpenChange).toHaveBeenCalledWith(true);
    // Controlled: the page decides, so nothing opened on its own.
    expect(queryByRole('dialog')).toBeNull();
  });
});
