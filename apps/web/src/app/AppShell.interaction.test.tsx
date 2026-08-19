/*
 * `interaction` project — the shell's live behaviour.
 *
 * Four things a static render cannot show:
 *   · the §8 fold happening *in response to* the viewport, not to a prop
 *   · Ctrl K reaching the palette from anywhere in the shell
 *   · the offline banner arriving and clearing on its own
 *   · what the Agent rail's expand affordance does at each width
 *
 * The viewport is moved with `design/layout/collapse.testing`'s stub: jsdom's
 * own `matchMedia` always answers `false` and never fires a change, so without
 * it the breakpoint is unreachable and 「窗口变窄时自动收起」 would be untested.
 */

import { act, fireEvent, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { COLLAPSE_BREAKPOINT_PX, COLLAPSE_MEDIA_QUERY } from '../design/layout';
import { stubMatchMedia, type MatchMediaStub } from '../design/layout/collapse.testing';
import type { ApiHealth } from '../shared/desktop/dto';
import { renderInteractive } from '../test/render';
import { AppShell } from './AppShell';
import { resetShellStore } from './shell';

function pendingProbe(): Promise<ApiHealth> {
  return new Promise<ApiHealth>(() => {});
}

function offlineProbe(): Promise<ApiHealth> {
  return Promise.reject(new Error('本地服务未启动'));
}

function shellRouter(
  probe: () => Promise<ApiHealth>,
  initial = '/library',
) {
  return createMemoryRouter(
    [
      {
        path: '/',
        element: <AppShell adapter={null} probe={probe} poll={false} />,
        children: [
          { index: true, element: <span data-page="home">工作台内容</span> },
          { path: 'library', element: <span data-page="library">资料库内容</span> },
          { path: 'agent', element: <span data-page="agent">创作内容</span> },
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
    const { container } = renderInteractive(<RouterProvider router={shellRouter(pendingProbe)} />);

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
    const { container } = renderInteractive(<RouterProvider router={shellRouter(pendingProbe)} />);

    const toggle = container.querySelector<HTMLButtonElement>('[data-nav-toggle]');
    expect(toggle?.disabled).toBe(true);
    // 「不隐藏、不静默失败」 — the toggle stays visible and says why it cannot run.
    expect(toggle?.getAttribute('aria-describedby')).not.toBeNull();
    expect(container.querySelector('[data-shell-nav]')?.getAttribute('data-shell-nav')).toBe('collapsed');
  });

  it('lets the rail toggle through while the window is wide, preference and all', () => {
    media = stubMatchMedia(false);
    const { container } = renderInteractive(<RouterProvider router={shellRouter(pendingProbe)} />);

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
    const { container } = renderInteractive(<RouterProvider router={shellRouter(pendingProbe)} />);

    act(() => {
      media?.setMatches(false);
    });

    expect(container.querySelector('[data-shell-nav]')?.getAttribute('data-shell-nav')).toBe('expanded');
  });
});

describe('AppShell — the Agent column at each width', () => {
  it('opens the 380px panel in place while the window is wide enough', async () => {
    media = stubMatchMedia(false);
    const { container } = renderInteractive(<RouterProvider router={shellRouter(pendingProbe)} />);

    const expand = container.querySelector<HTMLButtonElement>('[data-agent-rail-toggle="expand"]');
    expect(expand).not.toBeNull();

    if (expand !== null) fireEvent.click(expand);

    expect(container.querySelector('[data-agent-rail]')?.getAttribute('data-agent-rail')).toBe('expanded');
  });

  it('drops the column once folded and hands the Agent back to the icon rail', async () => {
    media = stubMatchMedia(true);
    const router = shellRouter(pendingProbe);
    const { container } = renderInteractive(<RouterProvider router={router} />);

    // The 1100 × 700 board has no right column at all.
    expect(container.querySelector('[data-agent-rail]')).toBeNull();

    // …and the entry point is still one click away, from the icon rail.
    const entry = container.querySelector<HTMLElement>('[data-nav-item="agent"]');
    expect(entry).not.toBeNull();
    if (entry !== null) fireEvent.click(entry);

    expect(router.state.location.pathname).toBe('/agent');
  });
});

describe('AppShell — Ctrl K', () => {
  it('opens the command palette from anywhere in the shell and Esc closes it', async () => {
    media = stubMatchMedia(false);
    renderInteractive(<RouterProvider router={shellRouter(pendingProbe)} />);

    expect(document.querySelector('[data-overlay="command-palette"]')).toBeNull();

    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(document.querySelector('[data-overlay="command-palette"]')).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('[data-overlay="command-palette"]')).toBeNull();
  });

  it('opens from the title bar field as well', async () => {
    media = stubMatchMedia(false);
    const { container } = renderInteractive(<RouterProvider router={shellRouter(pendingProbe)} />);

    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-titlebar-command]') as HTMLElement);

    expect(document.querySelector('[data-overlay="command-palette"]')).not.toBeNull();
  });

  it('navigates when a page command is run', async () => {
    media = stubMatchMedia(false);
    const router = shellRouter(pendingProbe);
    const { container } = renderInteractive(<RouterProvider router={router} />);

    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-titlebar-command]') as HTMLElement);
    const search = document.querySelector('input[role="combobox"]') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'Agent' } });
    // 「回车执行首条」 — the artboard's own contract for the palette.
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(router.state.location.pathname).toBe('/agent');
    expect(document.querySelector('[data-overlay="command-palette"]')).toBeNull();
  });
});

describe('AppShell — background activity', () => {
  it('opens from the title-bar bell and Esc closes the accessible drawer', async () => {
    media = stubMatchMedia(false);
    const { container } = renderInteractive(<RouterProvider router={shellRouter(pendingProbe)} />);

    fireEvent.click(container.querySelector('[data-titlebar-activity]') as HTMLElement);
    expect(document.querySelector('[data-overlay="drawer"]')).not.toBeNull();
    expect(document.querySelector('[data-overlay="drawer"]')?.getAttribute('aria-labelledby')).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.querySelector('[data-overlay="drawer"]')).toBeNull());
  });

  it('redirects the legacy tasks query to finished files and opens the drawer', async () => {
    media = stubMatchMedia(false);
    const router = shellRouter(pendingProbe, '/delivery?view=tasks');
    renderInteractive(<RouterProvider router={router} />);

    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(router.state.location.pathname).toBe('/delivery');
    expect(document.querySelector('[data-overlay="drawer"]')).not.toBeNull();
  });
});

describe('AppShell — the offline banner', () => {
  it('appears under the title bar when the probe fails, with the title bar dot following it', async () => {
    media = stubMatchMedia(false);
    const { container, findByRole } = renderInteractive(
      <RouterProvider router={shellRouter(offlineProbe)} />,
    );

    const banner = await findByRole('alert');
    expect(banner.textContent).toContain('本地服务未连接，分析、录制和导出暂时无法开始');

    await expect
      .poll(() => container.querySelector('[data-titlebar-service]')?.getAttribute('data-titlebar-service'))
      .toBe('offline');

    // It is a band between the bar and the row, not a floating toast.
    const bands = [...container.querySelectorAll('[data-shell-titlebar], [role="alert"], [data-shell-row]')];
    expect(bands.indexOf(banner)).toBe(1);
    // And it is in the flow, so the row below it moves down rather than being
    // covered — nothing in the shell positions it.
    expect(banner.closest('[data-shell-row]')).toBeNull();
  });

  it('shows nothing while the first probe is still in flight', () => {
    media = stubMatchMedia(false);
    const { queryByRole } = renderInteractive(<RouterProvider router={shellRouter(pendingProbe)} />);

    expect(queryByRole('alert')).toBeNull();
  });
});
