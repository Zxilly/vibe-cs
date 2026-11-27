import { fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { renderInteractive } from '../../test/render';
import { resetShellStore, useShellStore } from './shellStore';
import { WorkspaceModeIntro } from './WorkspaceModeIntro';

function mount() {
  const router = createMemoryRouter(
    [
      { path: '/', element: <><WorkspaceModeIntro /><button type="button">新建作品</button></> },
      { path: '/library', element: <span data-page="library" /> },
    ],
    { initialEntries: ['/'] },
  );
  renderInteractive(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  resetShellStore();
});

describe('WorkspaceModeIntro', () => {
  it('offers both modes inline without blocking the workbench', () => {
    mount();

    expect(screen.getByRole('region', { name: '选择工作模式' })).toBeTruthy();
    expect(screen.getByText('选材、剪辑与导出')).toBeTruthy();
    expect(screen.getByText('比赛数据与战术回放')).toBeTruthy();
    expect(document.querySelector('[data-mode-card="edit"]')?.getAttribute('data-mode-active')).toBe('true');
    expect(document.querySelector('[data-mode-card="analysis"]')?.getAttribute('data-mode-active')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: '新建作品' })).toBeTruthy();
  });

  it('offers no action on the mode the user is already in', () => {
    mount();

    const current = document.querySelector('[data-mode-card="edit"]');
    expect(current?.querySelector('button')).toBeNull();
    expect(screen.queryByRole('button', { name: '开始剪辑' })).toBeNull();
    expect(screen.queryByRole('button', { name: '进入剪辑' })).toBeNull();
    expect(document.querySelector('[data-mode-card="analysis"] button')?.textContent).toBe('进入分析');
  });

  it('switches to analysis, goes to its landing and completes onboarding', async () => {
    const router = mount();

    fireEvent.click(screen.getByRole('button', { name: '进入分析' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/library'));
    expect(useShellStore.getState().mode).toBe('analysis');
    expect(useShellStore.getState().onboardingComplete).toBe(true);
  });

  it('switches back to editing from the analysis lens', () => {
    useShellStore.setState({ mode: 'analysis' });
    const router = mount();

    expect(screen.queryByRole('button', { name: '进入分析' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '进入剪辑' }));

    expect(router.state.location.pathname).toBe('/');
    expect(useShellStore.getState().mode).toBe('edit');
    expect(screen.queryByRole('region', { name: '选择工作模式' })).toBeNull();
  });

  it('can be dismissed without choosing a mode', () => {
    mount();

    fireEvent.click(screen.getByRole('button', { name: '不再显示' }));

    expect(useShellStore.getState().onboardingComplete).toBe(true);
    expect(useShellStore.getState().mode).toBe('edit');
    expect(screen.queryByRole('region', { name: '选择工作模式' })).toBeNull();
  });

  it('renders nothing once onboarding is complete', () => {
    useShellStore.getState().completeOnboarding();
    mount();

    expect(screen.queryByRole('region', { name: '选择工作模式' })).toBeNull();
  });
});
