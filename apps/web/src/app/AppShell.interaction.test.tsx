/*
 * `interaction` project — the shell's live behaviour.
 *
 * Four things a static render cannot show:
 *   · the §8 fold happening *in response to* the viewport, not to a prop
 *   · Ctrl K reaching the palette from anywhere in the shell
 *   · what the Agent rail's expand affordance does at each width
 *
 * The viewport is moved with `design/layout/collapse.testing`'s stub: jsdom's
 * own `matchMedia` always answers `false` and never fires a change, so without
 * it the breakpoint is unreachable and 「窗口变窄时自动收起」 would be untested.
 */

import { act, fireEvent, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DesktopClientProvider, type DesktopClient, type DesktopClientStub } from '../data/desktopClient';
import { COLLAPSE_BREAKPOINT_PX, COLLAPSE_MEDIA_QUERY } from '../design/layout';
import { stubMatchMedia, type MatchMediaStub } from '../design/layout/collapse.testing';
import type { Project } from '../shared/desktop/dto';
import { renderInteractive } from '../test/render';
import { AppShell } from './AppShell';
import { resetShellStore, useShellStore } from './shell';

/** The reader's own work, as the palette's 作品 group will list it. */
const COLOGNE: Project = {
  id: '80000000-0000-4000-8000-000000000042',
  name: 'NiKo · Cologne BO5 · 3分钟',
  revision: 12,
  document: {
    width: 1920, height: 1080, fps: 60, duration_seconds: 0, story_track_id: 'track-1',
    tracks: [], markers: [],
    settings: { source_demo_ids: [], ripple_sequence_markers: true, use_media_proxies: false },
  },
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-10T00:00:00Z',
};

function shellRouter(initial = '/library', client?: DesktopClientStub) {
  const shell = <AppShell adapter={null} />;
  return createMemoryRouter(
    [
      {
        path: '/',
        element: client === undefined
          ? shell
          : <DesktopClientProvider client={client as DesktopClient}>{shell}</DesktopClientProvider>,
        children: [
          { index: true, element: <span data-page="home">工作台内容</span> },
          { path: 'library', element: <span data-page="library">资料库内容</span> },
          { path: 'players', element: <span data-page="players">玩家内容</span> },
          { path: 'evidence', element: <span data-page="evidence">证据内容</span> },
          { path: 'tasks', element: <span data-page="tasks">任务内容</span> },
          { path: 'projects/:projectId', element: <span data-page="project">作品内容</span> },
          { path: 'delivery', element: <span data-page="delivery">成品内容</span> },
        ],
      },
    ],
    { initialEntries: [initial] },
  );
}

let media: MatchMediaStub | null = null;

beforeEach(() => {
  resetShellStore();
  useShellStore.getState().completeOnboarding();
});

afterEach(() => {
  media?.restore();
  media = null;
});

describe('AppShell — the §8 fold', () => {
  it('folds at 1100px and states the query it listens to', () => {
    expect(COLLAPSE_BREAKPOINT_PX).toBe(1100);
    // Inclusive: the artboard is drawn *at* 1100 × 700 and shows the fold.
    expect(COLLAPSE_MEDIA_QUERY).toBe('(max-width: 1100px)');
  });

  it('collapses the rail when the window crosses the breakpoint, without a prop', async () => {
    media = stubMatchMedia(false);
    const { container } = renderInteractive(<RouterProvider router={shellRouter()} />);

    const shell = () => container.querySelector('[data-app-shell]');
    const nav = () => container.querySelector('[data-shell-nav]');

    expect(shell()?.getAttribute('data-shell-folded')).toBe('false');
    expect(nav()?.getAttribute('data-shell-nav')).toBe('expanded');

    act(() => {
      media?.setMatches(true);
    });

    expect(shell()?.getAttribute('data-shell-folded')).toBe('true');
    expect(nav()?.getAttribute('data-shell-nav')).toBe('collapsed');
  });

  it('keeps the rail collapsed below the breakpoint even when the preference says otherwise', async () => {
    media = stubMatchMedia(true);
    const { container } = renderInteractive(<RouterProvider router={shellRouter()} />);

    const toggle = container.querySelector<HTMLButtonElement>('[data-nav-toggle]');
    expect(toggle?.disabled).toBe(true);
    // 「不隐藏、不静默失败」 — the toggle stays visible and says why it cannot run.
    expect(toggle?.getAttribute('aria-describedby')).not.toBeNull();
    expect(container.querySelector('[data-shell-nav]')?.getAttribute('data-shell-nav')).toBe('collapsed');
  });

  it('lets the rail toggle through while the window is wide, preference and all', () => {
    media = stubMatchMedia(false);
    const { container } = renderInteractive(<RouterProvider router={shellRouter()} />);

    const nav = () => container.querySelector('[data-shell-nav]')?.getAttribute('data-shell-nav');
    expect(nav()).toBe('expanded');

    // `AppShell` resolves the state itself and hands it down, so a store change
    // has to travel back up through it — this is the wiring that breaks silently.
    fireEvent.click(container.querySelector('[data-nav-toggle]') as HTMLElement);
    expect(nav()).toBe('collapsed');
    expect(container.querySelector('[data-shell-titlebar]')?.getAttribute('data-shell-titlebar')).toBe(
      'nav-collapsed',
    );

    fireEvent.click(container.querySelector('[data-nav-toggle]') as HTMLElement);
    expect(nav()).toBe('expanded');
  });

  it('goes back to the expanded rail when the window grows again', async () => {
    media = stubMatchMedia(true);
    const { container } = renderInteractive(<RouterProvider router={shellRouter()} />);

    act(() => {
      media?.setMatches(false);
    });

    expect(container.querySelector('[data-shell-nav]')?.getAttribute('data-shell-nav')).toBe('expanded');
  });
});

describe('AppShell — the retired Agent column', () => {
  it('does not mount the right-edge rail even while the window is wide', async () => {
    media = stubMatchMedia(false);
    const { container } = renderInteractive(<RouterProvider router={shellRouter()} />);

    expect(container.querySelector('[data-agent-rail]')).toBeNull();
    expect(container.querySelector('[data-agent-rail-toggle]')).toBeNull();
  });

  it('keeps the project Agent entry in the folded rail without restoring the right column', async () => {
    media = stubMatchMedia(true);
    const { container } = renderInteractive(<RouterProvider router={shellRouter()} />);

    // The 1100 × 700 board has no right column at all.
    expect(container.querySelector('[data-agent-rail]')).toBeNull();

    expect(container.querySelector('[data-nav-item="agent"]')).toBeNull();
    expect(container.querySelector('[data-nav-item="projects"]')).not.toBeNull();
  });
});

describe('AppShell — Ctrl K', () => {
  it('lets keyboard users bypass window chrome and navigation', () => {
    media = stubMatchMedia(false);
    const { getByRole } = renderInteractive(<RouterProvider router={shellRouter()} />);
    const skip = getByRole('link', { name: '跳到主要内容' });
    skip.focus();
    fireEvent.click(skip);
    expect(document.activeElement).toBe(getByRole('main'));
    expect(getByRole('main').textContent).toContain('资料库内容');
  });

  it('opens the command palette from anywhere in the shell and Esc closes it', async () => {
    media = stubMatchMedia(false);
    renderInteractive(<RouterProvider router={shellRouter()} />);

    expect(document.querySelector('[data-overlay="command-palette"]')).toBeNull();

    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(document.querySelector('[data-overlay="command-palette"]')).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('[data-overlay="command-palette"]')).toBeNull();
  });

  it('opens from the title bar field as well', async () => {
    media = stubMatchMedia(false);
    const { container } = renderInteractive(<RouterProvider router={shellRouter()} />);

    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-titlebar-command]') as HTMLElement);

    expect(document.querySelector('[data-overlay="command-palette"]')).not.toBeNull();
  });

  it('navigates when a page command is run', async () => {
    media = stubMatchMedia(false);
    const router = shellRouter();
    const { container } = renderInteractive(<RouterProvider router={router} />);

    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-titlebar-command]') as HTMLElement);
    const search = document.querySelector('input[role="combobox"]') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'Agent' } });
    // 「回车执行首条」 — the artboard's own contract for the palette.
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(router.state.location.pathname).toBe('/projects/new');
    expect(router.state.location.search).toBe('?step=shotlist');
    expect(document.querySelector('[data-overlay="command-palette"]')).toBeNull();
  });

  it('finds the reader’s own objects — a project typed by name opens its workspace', async () => {
    media = stubMatchMedia(false);
    const empty = { items: [], total: 0, page: 1, page_size: 8 };
    const router = shellRouter('/library', {
      listProjects: () => Promise.resolve([COLOGNE]),
      listDemos: () => Promise.resolve(empty),
      listPlayers: () => Promise.resolve({
        ...empty,
        coverage: { projected_demos: 0, total_analyses: 0, projection_complete: true },
      }),
      listActivities: () => Promise.resolve({
        items: [], total: 0, page: 1, page_size: 50,
        summary: { total: 0, active: 0, failed: 0, completed: 0, cancelled: 0 },
      }),
    });
    const { container } = renderInteractive(<RouterProvider router={router} />);

    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-titlebar-command]') as HTMLElement);
    const search = document.querySelector('input[role="combobox"]') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'Cologne' } });

    const row = await waitFor(() => {
      const found = document.querySelector(`[data-command-id="project.${COLOGNE.id}"]`);
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(row.textContent).toContain('NiKo · Cologne BO5 · 3分钟');

    fireEvent.keyDown(search, { key: 'Enter' });
    expect(router.state.location.pathname).toBe(`/projects/${COLOGNE.id}`);
  });
});

describe('AppShell — route viewport', () => {
  it('replaces the page plane for a different destination but keeps it for query-only changes', async () => {
    media = stubMatchMedia(false);
    const router = shellRouter();
    const { container } = renderInteractive(<RouterProvider router={router} />);
    const first = container.querySelector('[data-route-viewport]');

    await act(async () => {
      await router.navigate('/delivery');
    });
    const destination = container.querySelector('[data-route-viewport]');
    expect(destination).not.toBe(first);
    expect(destination?.getAttribute('data-route-path')).toBe('/delivery');

    await act(async () => {
      await router.navigate('/delivery?view=outputs');
    });
    expect(container.querySelector('[data-route-viewport]')).toBe(destination);
  });
});

describe('AppShell — work modes', () => {
  it('does not hold a first run behind a mode dialog', () => {
    media = stubMatchMedia(false);
    useShellStore.setState({ onboardingComplete: false });
    const { container, queryByRole } = renderInteractive(<RouterProvider router={shellRouter('/')} />);

    expect(queryByRole('dialog')).toBeNull();
    expect(container.querySelector('[data-page="home"]')).not.toBeNull();
  });

  it('switches from editing to analysis and back without the route effect overriding the choice', async () => {
    media = stubMatchMedia(false);
    const router = shellRouter('/');
    const { getByRole, queryByText } = renderInteractive(<RouterProvider router={router} />);

    expect(queryByText('作品')).not.toBeNull();
    expect(queryByText('选手目录')).toBeNull();

    fireEvent.pointerDown(getByRole('button', { name: /切换工作模式/u }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(getByRole('menuitemradio', { name: /^分析模式/u }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/library'));
    expect(queryByText('选手目录')).not.toBeNull();
    expect(queryByText('证据检索')).not.toBeNull();
    expect(queryByText('作品')).toBeNull();

    fireEvent.pointerDown(getByRole('button', { name: /切换工作模式/u }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(getByRole('menuitemradio', { name: /^剪辑模式/u }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(useShellStore.getState().mode).toBe('edit');
    expect(queryByText('作品')).not.toBeNull();
    expect(queryByText('选手目录')).toBeNull();
  });

  it('opens analysis deep links in analysis mode without a wrong-nav frame', () => {
    media = stubMatchMedia(false);
    const { queryAllByText, queryByText } = renderInteractive(
      <RouterProvider router={shellRouter('/players')} />,
    );

    expect(queryAllByText('选手目录').length).toBeGreaterThan(0);
    expect(queryByText('作品')).toBeNull();
  });
});

describe('AppShell — background activity', () => {
  it('opens from the title-bar bell and Esc closes the accessible drawer', async () => {
    media = stubMatchMedia(false);
    const { container } = renderInteractive(<RouterProvider router={shellRouter()} />);

    fireEvent.click(container.querySelector('[data-titlebar-activity]') as HTMLElement);
    expect(document.querySelector('[data-overlay="drawer"]')).not.toBeNull();
    expect(document.querySelector('[data-overlay="drawer"]')?.getAttribute('aria-labelledby')).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.querySelector('[data-overlay="drawer"]')).toBeNull());
  });

  it('opens the task center without switching the analysis mode or forcing a drawer', async () => {
    media = stubMatchMedia(false);
    useShellStore.setState({ mode: 'analysis' });
    const router = shellRouter('/tasks');
    renderInteractive(<RouterProvider router={router} />);
    expect(router.state.location.pathname).toBe('/tasks');
    expect(useShellStore.getState().mode).toBe('analysis');
    expect(document.querySelector('[data-overlay="drawer"]')).toBeNull();
  });
});
