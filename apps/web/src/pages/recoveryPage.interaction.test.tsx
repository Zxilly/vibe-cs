/*
 * Interaction tests for 恢复中心.
 *
 * Every action on this page destroys or overwrites something, so what is
 * asserted is the pair that makes it usable: **nothing happens without a
 * confirmation**, and **each card says what it will not touch**. The second is
 * not decoration — a user who has reached this page is worried about losing
 * work, and 「清理」 with no scope attached is unpressable.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { RecoveryStatus } from '../shared/desktop/dto';
import { HEALTHY, renderPage } from './delivery/test/renderPage';
import { RecoveryPage } from './RecoveryPage';

const CLEAN: RecoveryStatus = { recovery_required: false, affected_files: [] };

const DAMAGED: RecoveryStatus = {
  recovery_required: true,
  reason: '配置文件解析失败',
  backup_created_at: '2026-08-15T22:10:00.000Z',
  affected_files: ['D:\\CS2\\config.json'],
};

function render(overrides: Record<string, unknown> = {}, options: { readonly offline?: boolean } = {}) {
  const client: Record<string, unknown> = {
    recoveryStatus: () => Promise.resolve(CLEAN),
    recoverConfiguration: () => Promise.resolve(CLEAN),
    cleanupStagedOutputs: () =>
      Promise.resolve({ inspected: 4, deleted: 3, failed: 0, scan_limited: false }),
    cleanupMissingOutputs: () => Promise.resolve({ inspected: 9, deleted: 2, scan_limited: false }),
    ...overrides,
  };
  renderPage({
    element: <RecoveryPage />,
    client,
    ...(options.offline === true ? { health: undefined } : { health: HEALTHY }),
  });
}

const confirm = () => document.querySelector('[data-dialog-action="confirm"]') as HTMLElement;

describe('what the page says before anything is pressed', () => {
  it('says the configuration is fine when it is, rather than staying silent', async () => {
    render();
    await waitFor(() => {
      expect(document.body.textContent).toContain('配置文件正常，不需要恢复');
    });
    // …and the restore is refused, with that as its reason.
    const button = document.querySelector('[data-recovery-action="config"]');
    expect(button?.hasAttribute('disabled')).toBe(true);
  });

  it('names the damage and the affected files when there is some', async () => {
    render({ recoveryStatus: () => Promise.resolve(DAMAGED) });
    await waitFor(() => {
      expect(document.querySelector('[data-recovery-required]')).not.toBeNull();
    });
    expect(document.body.textContent).toContain('配置文件解析失败');
    expect(document.body.textContent).toContain('D:\\CS2\\config.json');
  });

  it('states what each action will not touch', async () => {
    render();
    await waitFor(() => {
      expect(document.body.textContent).toContain('不会动');
    });
    // The one that matters most: cleaning stale records cannot delete a file.
    expect(document.body.textContent).toContain('不会动：任何还在磁盘上的文件');
    expect(document.body.textContent).toContain('不会动：Demo、录制结果');
  });
});

describe('every action takes a confirmation', () => {
  it('does not clean staged outputs until confirmed', async () => {
    const cleanupStagedOutputs = vi.fn(() =>
      Promise.resolve({ inspected: 4, deleted: 3, failed: 0, scan_limited: false }),
    );
    render({ cleanupStagedOutputs });
    await waitFor(() => {
      expect(document.querySelector('[data-recovery-action="staged"]')).not.toBeNull();
    });

    fireEvent.click(document.querySelector('[data-recovery-action="staged"]') as HTMLElement);
    expect(cleanupStagedOutputs).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('清理未完成的暂存输出？');

    fireEvent.click(confirm());
    await waitFor(() => expect(cleanupStagedOutputs).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/已清理 3 个暂存文件/u)).toBeTruthy();
  });

  it('does not restore the configuration until confirmed', async () => {
    const recoverConfiguration = vi.fn(() => Promise.resolve(DAMAGED));
    render({ recoveryStatus: () => Promise.resolve(DAMAGED), recoverConfiguration });
    await waitFor(() => {
      expect(document.querySelector('[data-recovery-required]')).not.toBeNull();
    });

    fireEvent.click(document.querySelector('[data-recovery-action="config"]') as HTMLElement);
    expect(recoverConfiguration).not.toHaveBeenCalled();
    // The dialog says what is lost, not just what is done.
    expect(document.body.textContent).toContain('备份之后做过的设置改动会丢失');

    fireEvent.click(confirm());
    await waitFor(() => expect(recoverConfiguration).toHaveBeenCalledTimes(1));
  });

  it('sweeps every output kind, unlike the library’s own cleanup', async () => {
    const cleanupMissingOutputs = vi.fn(() =>
      Promise.resolve({ inspected: 9, deleted: 2, scan_limited: false }),
    );
    render({ cleanupMissingOutputs });
    await waitFor(() => {
      expect(document.querySelector('[data-recovery-action="missing"]')).not.toBeNull();
    });

    fireEvent.click(document.querySelector('[data-recovery-action="missing"]') as HTMLElement);
    fireEvent.click(confirm());

    await waitFor(() => expect(cleanupMissingOutputs).toHaveBeenCalledWith(undefined));
  });
});

describe('what a cleanup reports', () => {
  it('says how many it could not delete rather than only the successes', async () => {
    // A cleanup that left three locked files has not cleaned up, and reporting
    // only `deleted` would have the user pressing the button again.
    render({
      cleanupStagedOutputs: () =>
        Promise.resolve({ inspected: 7, deleted: 4, failed: 3, scan_limited: false }),
    });
    await waitFor(() => {
      expect(document.querySelector('[data-recovery-action="staged"]')).not.toBeNull();
    });

    fireEvent.click(document.querySelector('[data-recovery-action="staged"]') as HTMLElement);
    fireEvent.click(confirm());

    await waitFor(() => {
      expect(document.querySelector('[data-recovery-result]')?.textContent).toContain('3 个删不掉');
    });
  });

  it('says the sweep was partial rather than implying it finished', async () => {
    render({
      cleanupMissingOutputs: () => Promise.resolve({ inspected: 9, deleted: 2, scan_limited: true }),
    });
    await waitFor(() => {
      expect(document.querySelector('[data-recovery-action="missing"]')).not.toBeNull();
    });

    fireEvent.click(document.querySelector('[data-recovery-action="missing"]') as HTMLElement);
    fireEvent.click(confirm());

    await waitFor(() => {
      expect(document.body.textContent).toContain('只扫描了一部分');
    });
  });

  it('says nothing needed cleaning rather than nothing at all', async () => {
    render({
      cleanupStagedOutputs: () =>
        Promise.resolve({ inspected: 0, deleted: 0, failed: 0, scan_limited: false }),
    });
    await waitFor(() => {
      expect(document.querySelector('[data-recovery-action="staged"]')).not.toBeNull();
    });

    fireEvent.click(document.querySelector('[data-recovery-action="staged"]') as HTMLElement);
    fireEvent.click(confirm());

    await waitFor(() => {
      expect(document.body.textContent).toContain('没有需要清理的暂存文件');
    });
  });
});

describe('offline', () => {
  it('disables every action with the service’s own reason', async () => {
    render({}, { offline: true });
    await waitFor(() => {
      expect(document.querySelector('[data-recovery-action="staged"]')).not.toBeNull();
    });
    for (const action of ['staged', 'missing']) {
      expect(
        document.querySelector(`[data-recovery-action="${action}"]`)?.hasAttribute('disabled'),
      ).toBe(true);
    }
  });
});
