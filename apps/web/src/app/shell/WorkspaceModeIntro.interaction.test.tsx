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
    expect(screen.getByText('挑选精彩片段，编排时间轴，录制并导出成片。')).toBeTruthy();
    expect(screen.getByText('查看比赛数据、回合事件与战术回放。')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: '新建作品' })).toBeTruthy();
  });

  it('switches to analysis, goes to its landing and completes onboarding', async () => {
    const router = mount();

    fireEvent.click(screen.getByRole('button', { name: '进入分析' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/library'));
    expect(useShellStore.getState().mode).toBe('analysis');
    expect(useShellStore.getState().onboardingComplete).toBe(true);
  });

  it('stays on the editing landing when editing is chosen', () => {
    useShellStore.setState({ mode: 'analysis' });
    const router = mount();

    fireEvent.click(screen.getByRole('button', { name: '开始剪辑' }));

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
