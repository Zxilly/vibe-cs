/**
 * Shell layer 3 — RouteBoundary: the three states a route can be in that are
 * not "the page".
 *
 * 「补齐 · 规范与状态」draws them in one grid, 空 · 加载 · 错误, every cell
 * 172px tall:
 *
 *   loading   a table skeleton, annotated twice —
 *             「加载中 · 表格骨架（不显示虚构百分比）」 and
 *             「有真实分母时才用进度条，否则只给阶段名」
 *   error     a fail-bordered card — 「这个页面没能打开 /
 *             其余功能不受影响。你可以返回工作台，或把这次错误导出给开发者。」
 *             with 返回工作台 and 导出诊断
 *
 * Both are already components: `design/data/Skeleton` refuses to hold a
 * percentage by construction, and `design/data/Empty` ships the error
 * card's copy as its `error` preset. This module composes them and adds the
 * only thing the design layer cannot know — where the error came from and how
 * to try again.
 *
 * Deliberate additions to the artboard, both narrow:
 *
 *   · 重试. The card as drawn offers no way back into the page; the state
 *     machine board draws 失败与恢复 as a first-class edge, and a boundary you
 *     cannot leave without a reload is not a recovery. It is the first action
 *     and resets the boundary in place — no reload, no lost shell state.
 *   · 找不到这个页面. The reference has no 404 board (there is no reachable
 *     404 in the drawn IA). Rather than invent chrome for it, `NotFound`
 *     reuses `Empty` in its empty tone, so a bad hash link lands on the
 *     same shape as an empty table instead of on a failure card — a route that
 *     does not exist is not a malfunction.
 *
 * This replaced `app/RouteError.tsx`, which was deleted once the shell was
 * reassembled and the new router started pointing at `RouteErrorElement`.
 */

import { Trans } from '@lingui/react/macro';
import { Component, Suspense, type ReactNode } from 'react';
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';

import { EMPTY_MIN_HEIGHT_CLASS, TableSkeleton } from '../../design/data';
import { Page, Toolbar } from '../../design/layout';
import { Button, cn } from '../../design/primitives';

/**
 * The 172px state box now belongs to the design layer: `Empty` applies it
 * to itself and exports the class, so the loading skeleton standing in the same
 * slot can hold the same box without repeating the number. Re-exported under
 * the old name because callers of this module named it.
 */
export { EMPTY_MIN_HEIGHT_CLASS as ROUTE_STATE_MIN_HEIGHT_CLASS };

/** Hash routing (§1.1) — assigning the hash navigates without a reload. */
function goHome(): void {
  window.location.hash = '#/';
}

/* ── loading ─────────────────────────────────────────────────────────────── */

export interface RouteLoadingProps {
  /**
   * The stage name. The only text the skeleton shows, and the reason there is
   * no percentage prop anywhere in this file.
   */
  stage?: ReactNode | undefined;
  rows?: number | undefined;
  className?: string | undefined;
}

export function RouteLoading({ stage, rows = 4, className }: RouteLoadingProps) {
  return (
    <Page
      toolbar={
        <Toolbar
          leading={<span aria-hidden="true" className="block h-3.5 w-28 animate-pulse bg-neutral-200" />}
        />
      }
    >
      <TableSkeleton
        panel
        rows={rows}
        stage={stage ?? <Trans>正在打开这个页面</Trans>}
        className={cn(EMPTY_MIN_HEIGHT_CLASS, 'm-7', className)}
      />
    </Page>
  );
}

/* ── error ───────────────────────────────────────────────────────────────── */

export interface RouteErrorStateProps {
  /** Passed through to `onExportDiagnostics`; never rendered — the card's copy
   *  is fixed, and a raw stack in the page helps nobody who can read it. */
  error?: unknown;
  /** Omitted only where retrying is impossible. */
  onRetry?: (() => void) | undefined;
  onGoHome?: (() => void) | undefined;
  /** 「导出诊断」 renders only when the shell can actually export one. */
  onExportDiagnostics?: ((error: unknown) => void) | undefined;
  className?: string | undefined;
}

export function RouteErrorState({
  error,
  onRetry,
  onGoHome,
  onExportDiagnostics,
  className,
}: RouteErrorStateProps) {
  return (
    <section
      aria-labelledby="route-failed-title"
      data-route-failed=""
      data-tone="error"
      className={cn('mx-auto mt-20 w-[calc(100%-3.5rem)] max-w-[39rem] border border-fail-border bg-bg', className)}
    >
      <div className="border-b border-fail-border px-4 py-3 font-mono text-2xs tracking-wide text-fail-text">
        ROUTE <span className="text-fail">/</span> FAILED
      </div>
      <div className={cn(EMPTY_MIN_HEIGHT_CLASS, 'flex flex-col items-center justify-center gap-3 p-7 text-center')}>
        <h3 id="route-failed-title" className="font-heading text-xl text-fail-text">
          <Trans>这个页面没能打开</Trans>
        </h3>
        <p className="max-w-[46ch] text-sm leading-normal text-neutral-800">
          <Trans>其他页面仍可使用。返回工作台，或导出这次错误的诊断信息。</Trans>
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2.5 border-t border-divider pt-3">
          {onRetry === undefined ? null : (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              <Trans>重试</Trans>
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={onGoHome ?? goHome}>
            <Trans>返回工作台</Trans>
          </Button>
          {onExportDiagnostics === undefined ? null : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onExportDiagnostics(error);
              }}
            >
              <Trans>导出诊断</Trans>
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

/* ── not found ───────────────────────────────────────────────────────────── */

export function NotFound({
  onGoHome,
  className,
}: {
  onGoHome?: (() => void) | undefined;
  className?: string | undefined;
}) {
  return (
    <section
      aria-labelledby="route-not-found-title"
      data-route-not-found=""
      data-tone="empty"
      className={cn('mx-auto mt-20 w-[calc(100%-3.5rem)] max-w-[35rem] border border-divider bg-bg', className)}
    >
      <div className="border-b border-divider px-4 py-3 font-mono text-2xs tracking-wide text-neutral-600">
        ROUTE <span className="text-accent-700">/</span> NOT FOUND
      </div>
      <div className="flex min-h-[11rem] flex-col items-center justify-center gap-3 p-7 text-center">
        <h3 id="route-not-found-title" className="font-heading text-xl">
          <Trans>找不到这个页面</Trans>
        </h3>
        <p className="text-sm text-neutral-700">
          <Trans>这个地址不存在。其余功能不受影响。</Trans>
        </p>
        <Button variant="primary" size="sm" onClick={onGoHome ?? goHome}>
          <Trans>返回工作台</Trans>
        </Button>
      </div>
    </section>
  );
}

/* ── the boundary ────────────────────────────────────────────────────────── */

export interface RouteBoundaryProps {
  children: ReactNode;
  /** Replaces the default skeleton where a route knows a better placeholder. */
  fallback?: ReactNode | undefined;
  /** Stage name for the default skeleton. */
  stage?: ReactNode | undefined;
  onGoHome?: (() => void) | undefined;
  onExportDiagnostics?: ((error: unknown) => void) | undefined;
  /**
   * Changing this clears a caught error. The shell passes the route key, so
   * navigating away from a broken route is itself a recovery — without it the
   * boundary would keep showing the failure card over the new page.
   */
  resetKey?: string | number | undefined;
}

interface RouteBoundaryState {
  /** Boxed, because a thrown value may legitimately be `null` or `undefined`. */
  caught: { value: unknown } | null;
}

/**
 * Catches anything the subtree throws while rendering, including a rejected
 * `lazy()` import — which arrives here through Suspense rather than through the
 * router, since the routes use `element:` and not `lazy:`.
 *
 * Suspense sits *inside* the boundary: a fallback that could itself be replaced
 * by an error card would be a boundary that only works while nothing is
 * loading.
 */
export class RouteBoundary extends Component<RouteBoundaryProps, RouteBoundaryState> {
  override state: RouteBoundaryState = { caught: null };

  static getDerivedStateFromError(error: unknown): RouteBoundaryState {
    return { caught: { value: error } };
  }

  override componentDidUpdate(previous: RouteBoundaryProps): void {
    if (previous.resetKey !== this.props.resetKey && this.state.caught !== null) {
      this.setState({ caught: null });
    }
  }

  private readonly retry = (): void => {
    this.setState({ caught: null });
  };

  override render(): ReactNode {
    const { children, fallback, stage, onGoHome, onExportDiagnostics } = this.props;
    const { caught } = this.state;

    if (caught !== null) {
      return (
        <RouteErrorState
          error={caught.value}
          onRetry={this.retry}
          onGoHome={onGoHome}
          onExportDiagnostics={onExportDiagnostics}
        />
      );
    }

    return <Suspense fallback={fallback ?? <RouteLoading stage={stage} />}>{children}</Suspense>;
  }
}

/* ── the router's own slot ───────────────────────────────────────────────── */

/**
 * For `errorElement`. A router error has already unmounted the route, so there
 * is no subtree to re-render — the only honest retry is a reload, which is what
 * `app/RouteError.tsx` did too. A 404 `Response` routes to `NotFound` instead
 * of the failure card, for the reason given at the top of this file.
 */
export function RouteErrorElement({
  onGoHome,
  onExportDiagnostics,
}: {
  onGoHome?: (() => void) | undefined;
  onExportDiagnostics?: ((error: unknown) => void) | undefined;
}) {
  const error = useRouteError();

  if (isRouteErrorResponse(error) && error.status === 404) {
    return <NotFound onGoHome={onGoHome} />;
  }

  return (
    <RouteErrorState
      error={error}
      onRetry={() => {
        window.location.reload();
      }}
      onGoHome={onGoHome}
      onExportDiagnostics={onExportDiagnostics}
    />
  );
}
