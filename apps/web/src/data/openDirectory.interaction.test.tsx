import { fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { NativeShellProvider, useOpenDirectory, type NativeShell } from './nativeShell';
import { toast, Toaster } from '../design/feedback';
import { renderInteractive } from '../test/render';

afterEach(() => {
  toast.clear();
});

function shellThatAnswers(opened: boolean): NativeShell {
  return {
    available: true,
    openDirectory: () => Promise.resolve(opened),
  } as unknown as NativeShell;
}

function Harness({ shell }: { readonly shell: NativeShell }) {
  return (
    <NativeShellProvider shell={shell}>
      <Open />
      <Toaster />
    </NativeShellProvider>
  );
}

function Open() {
  const openDirectory = useOpenDirectory();
  return (
    <button type="button" onClick={() => openDirectory('D:\CS2\outputs')}>
      打开目录
    </button>
  );
}

describe('useOpenDirectory', () => {
  /* 「不隐藏、不静默失败」. `openDirectory` returns a boolean and every call site
     used to drop it, so a folder that did not open said nothing at all. */
  it('says so when the shell could not open the folder', async () => {
    const { getByRole, findByText } = renderInteractive(<Harness shell={shellThatAnswers(false)} />);

    fireEvent.click(getByRole('button', { name: '打开目录' }));

    expect(await findByText('没能打开这个目录')).not.toBeNull();
    // The path, because 「没能打开」 without one is not actionable.
    expect(await findByText('D:\CS2\outputs')).not.toBeNull();
  });

  it('says nothing when it worked', async () => {
    const { getByRole, queryByText } = renderInteractive(<Harness shell={shellThatAnswers(true)} />);

    fireEvent.click(getByRole('button', { name: '打开目录' }));

    await waitFor(() => {
      expect(queryByText('没能打开这个目录')).toBeNull();
    });
  });
});
