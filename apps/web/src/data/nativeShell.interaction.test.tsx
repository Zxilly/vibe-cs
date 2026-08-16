/*
 * `interaction` project — the native-shell seam.
 *
 * The point of this file is the seam itself: a page can be tested against a
 * shell that answers, and against one that cannot, without any test mocking a
 * Tauri plugin module. The second half is the one that matters — outside the
 * desktop app these actions **must** be disabled with a written reason rather
 * than silently doing nothing.
 */

import { renderHook } from '@testing-library/react';
import { i18n } from '@lingui/core';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import {
  NativeShellProvider,
  desktopNativeShell,
  unavailableNativeShell,
  useNativeShell,
  useNativeShellAction,
  type NativeShell,
} from './nativeShell';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });
});

function withShell(shell: NativeShell) {
  return ({ children }: { children: ReactNode }) => (
    <NativeShellProvider shell={shell}>{children}</NativeShellProvider>
  );
}

describe('the seam', () => {
  it('hands the injected shell to the tree below', () => {
    const chooseFile = vi.fn(() => Promise.resolve('D:\\music\\low-orbit.mp3'));
    const shell: NativeShell = { ...unavailableNativeShell, available: true, chooseFile };

    const { result } = renderHook(() => useNativeShell(), { wrapper: withShell(shell) });
    expect(result.current.available).toBe(true);
    expect(result.current.chooseFile).toBe(chooseFile);
  });

  it('defaults to the real shell, so the app mounts no provider', () => {
    const { result } = renderHook(() => useNativeShell());
    /* jsdom is not a desktop shell, so the real implementation reports itself
       unavailable — which is the honest answer, not a stub. */
    expect(result.current).toBe(desktopNativeShell);
    expect(result.current.available).toBe(false);
    expect(result.current.mediaSrc('/api/media/assets/a-1/stream')).toBeNull();
  });
});

describe('with no desktop under it', () => {
  it('answers 「nothing happened」 rather than throwing, for every picker', async () => {
    const shell = unavailableNativeShell;
    expect(shell.available).toBe(false);
    await expect(shell.chooseFile({ title: '选择音乐' })).resolves.toBeNull();
    await expect(shell.chooseFiles({ title: '选择音乐' })).resolves.toEqual([]);
    await expect(shell.chooseDirectories({ title: '选择目录' })).resolves.toEqual([]);
    await expect(
      shell.chooseSavePath({ title: '导出', defaultFileName: 'a.mp4', filters: [] }),
    ).resolves.toBeNull();
    await expect(shell.reveal('D:\\a.mp4')).resolves.toBe(false);
    await expect(shell.openDirectory('D:\\')).resolves.toBe(false);
    await expect(shell.openExternalUrl('https://example.com')).resolves.toBe(false);
    expect(shell.mediaSrc('/api/media/assets/a-1/stream')).toBeNull();
  });

  it('rejects a byte write, because there is no honest 「nothing happened」 for it', async () => {
    await expect(unavailableNativeShell.writeBytes('D:\\a.bin', new Uint8Array())).rejects.toThrow();
  });
});

describe('useNativeShellAction', () => {
  it('is enabled and silent when the shell is there', () => {
    const { result } = renderHook(() => useNativeShellAction(), {
      wrapper: withShell({ ...unavailableNativeShell, available: true }),
    });

    expect(result.current.available).toBe(true);
    expect(result.current.buttonProps.disabled).toBe(false);
    expect(result.current.buttonProps.disabledReason).toBeUndefined();
  });

  it('is disabled **with a reason** when it is not — never silently inert', () => {
    const { result } = renderHook(() => useNativeShellAction(), {
      wrapper: withShell(unavailableNativeShell),
    });

    expect(result.current.available).toBe(false);
    expect(result.current.buttonProps.disabled).toBe(true);
    expect(result.current.buttonProps.disabledReason).toBeTruthy();
  });
});

describe('mediaSrc', () => {
  it('is the only entry point, and it refuses a path the bridge would reject', () => {
    /* A shell that is "available" but whose URL builder throws is exactly what
       `desktopNativeShell` does for a path outside `/api/…`; the contract is
       that a caller gets `null` and renders its placeholder, not an exception
       inside a `src` attribute. */
    const shell: NativeShell = {
      ...unavailableNativeShell,
      available: true,
      mediaSrc: (path) =>
        path.startsWith('/api/') ? `vibe-cs-media://localhost${path.slice(4)}` : null,
    };

    const { result } = renderHook(() => useNativeShell(), { wrapper: withShell(shell) });
    expect(result.current.mediaSrc('/api/recorded-clips/c-1/stream')).toBe(
      'vibe-cs-media://localhost/recorded-clips/c-1/stream',
    );
    expect(result.current.mediaSrc('https://cdn.example.com/a.mp4')).toBeNull();
  });
});
