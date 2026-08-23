import { act, fireEvent, waitFor } from '@testing-library/react';
import { lazy, useState, type ComponentType } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { NotFound, RouteBoundary, RouteErrorElement } from './RouteBoundary';

/**
 * React logs every error a boundary catches. That is correct behaviour and it
 * would drown the run, so the two tests that throw on purpose silence it.
 */
function silenceReactErrorLog() {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
}

describe('RouteBoundary — Suspense 骨架', () => {
  it('shows the skeleton while the route loads and drops it when it arrives', async () => {
    let resolveRoute: ((module: { default: ComponentType }) => void) | undefined;
    const LazyRoute = lazy(
      () =>
        new Promise<{ default: ComponentType }>((resolve) => {
          resolveRoute = resolve;
        }),
    );

    const { getByRole, queryByRole, findByText } = renderInteractive(
      <RouteBoundary>
        <LazyRoute />
      </RouteBoundary>,
    );

    const skeleton = getByRole('status');
    expect(skeleton.getAttribute('aria-busy')).toBe('true');
    expect(skeleton.textContent).toContain('正在打开这个页面');

    await act(async () => {
      resolveRoute?.({ default: () => <p>Demo 资料库</p> });
    });

    expect(await findByText('Demo 资料库')).toBeTruthy();
    expect(queryByRole('status')).toBeNull();
  });

  it('takes a route-supplied stage name over the default', () => {
    const Never = lazy(() => new Promise<{ default: ComponentType }>(() => {}));
    const { getByRole } = renderInteractive(
      <RouteBoundary stage="正在解析回合">
        <Never />
      </RouteBoundary>,
    );
    expect(getByRole('status').textContent).toContain('正在解析回合');
  });
});

describe('RouteBoundary — 错误边界', () => {
  silenceReactErrorLog();

  /**
   * Throws for as long as `broken.value` says so. Counting renders instead
   * would be unreliable: React re-renders a failed tree synchronously after the
   * concurrent attempt, so a "fails once" component silently succeeds on the
   * recovery pass and the boundary never engages.
   */
  function ThrowingRoute({ broken }: { broken: { value: boolean } }) {
    if (broken.value) throw new Error('分析工作区加载失败');
    return <p>比赛工作区</p>;
  }

  it('catches the subtree and shows the failure card instead of a blank page', () => {
    const { getByText, queryByText } = renderInteractive(
      <RouteBoundary>
        <ThrowingRoute broken={{ value: true }} />
      </RouteBoundary>,
    );

    expect(getByText('这个页面没能打开')).toBeTruthy();
    expect(queryByText('比赛工作区')).toBeNull();
    // 「其余功能不受影响」 — the raw throw is not put in front of the user.
    expect(queryByText(/分析工作区加载失败/u)).toBeNull();
  });

  it('re-renders the subtree on 重试, in place, with no reload', async () => {
    const broken = { value: true };
    const { getByRole, findByText, queryByText } = renderInteractive(
      <RouteBoundary>
        <ThrowingRoute broken={broken} />
      </RouteBoundary>,
    );

    broken.value = false;
    fireEvent.click(getByRole('button', { name: '重试' }));

    expect(await findByText('比赛工作区')).toBeTruthy();
    expect(queryByText('这个页面没能打开')).toBeNull();
  });

  it('catches again when the retry fails again', async () => {
    const broken = { value: true };
    const { getByRole, findByText } = renderInteractive(
      <RouteBoundary>
        <ThrowingRoute broken={broken} />
      </RouteBoundary>,
    );

    fireEvent.click(getByRole('button', { name: '重试' }));
    expect(await findByText('这个页面没能打开')).toBeTruthy();

    broken.value = false;
    fireEvent.click(getByRole('button', { name: '重试' }));
    expect(await findByText('比赛工作区')).toBeTruthy();
  });

  it('clears itself when the route changes — resetKey', async () => {
    function Router() {
      const [route, setRoute] = useState('/match');
      return (
        <>
          <button type="button" onClick={() => { setRoute('/library'); }}>
            去资料库
          </button>
          <RouteBoundary resetKey={route}>
            {route === '/match' ? <ThrowingRoute broken={{ value: true }} /> : <p>Demo 资料库</p>}
          </RouteBoundary>
        </>
      );
    }

    const { getByRole, findByText, getByText } = renderInteractive(<Router />);
    expect(getByText('这个页面没能打开')).toBeTruthy();

    fireEvent.click(getByRole('button', { name: '去资料库' }));
    expect(await findByText('Demo 资料库')).toBeTruthy();
  });

  it('hands the caught error to 导出诊断 rather than rendering it', () => {
    const exported = vi.fn();
    const { getByRole } = renderInteractive(
      <RouteBoundary onExportDiagnostics={exported}>
        <ThrowingRoute broken={{ value: true }} />
      </RouteBoundary>,
    );

    fireEvent.click(getByRole('button', { name: '导出诊断' }));
    expect(exported).toHaveBeenCalledTimes(1);
    expect((exported.mock.calls[0]?.[0] as Error).message).toBe('分析工作区加载失败');
  });

  it('routes 返回工作台 through the shell when it supplies a handler', () => {
    const goHome = vi.fn();
    const { getByRole } = renderInteractive(
      <RouteBoundary onGoHome={goHome}>
        <ThrowingRoute broken={{ value: true }} />
      </RouteBoundary>,
    );

    fireEvent.click(getByRole('button', { name: '返回工作台' }));
    expect(goHome).toHaveBeenCalledTimes(1);
  });
});

describe('RouteErrorElement — the router’s errorElement slot', () => {
  silenceReactErrorLog();

  it('shows the failure card for an error thrown while rendering the route', async () => {
    function Broken(): never {
      throw new Error('路由加载失败');
    }
    const router = createMemoryRouter(
      [{ path: '/', element: <Broken />, errorElement: <RouteErrorElement /> }],
      { initialEntries: ['/'] },
    );

    const { findByText } = renderInteractive(<RouterProvider router={router} />);
    expect(await findByText('这个页面没能打开')).toBeTruthy();
  });

  it('shows 找不到这个页面, not the failure card, for a 404 the router raised', async () => {
    // A 404 only reaches `isRouteErrorResponse` when the router itself raised
    // it — a `Response` thrown from a component's render is an ordinary error.
    const router = createMemoryRouter(
      [
        {
          path: '/',
          loader: () => {
            throw new Response(null, { status: 404, statusText: 'Not Found' });
          },
          element: <p>比赛工作区</p>,
          errorElement: <RouteErrorElement />,
        },
      ],
      { initialEntries: ['/'] },
    );

    const { findByText, queryByText } = renderInteractive(<RouterProvider router={router} />);
    expect(await findByText('找不到这个页面')).toBeTruthy();
    expect(queryByText('这个页面没能打开')).toBeNull();
  });
});

describe('NotFound', () => {
  it('uses one compact classified boundary panel', () => {
    const { container } = renderInteractive(<NotFound />);
    expect(container.querySelector('[data-route-not-found]')?.textContent).toContain('ROUTE / NOT FOUND');
  });

  it('navigates home through the hash router by default', async () => {
    const { getByRole } = renderInteractive(<NotFound />);
    fireEvent.click(getByRole('button', { name: '返回工作台' }));
    await waitFor(() => {
      expect(window.location.hash).toBe('#/');
    });
  });
});
