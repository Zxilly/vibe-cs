/*
 * pages/match/views — the frame every one of these views is drawn in.
 *
 * 「补齐 · 比赛工作区子视图」 draws all six of its cells the same way: a bordered
 * block with a 40px head (`--h-panel-head`, §3.4) carrying a name and, on the
 * right, whatever that block can be walked into. Written once here so the nine
 * views cannot drift apart the way eighteen tabs did.
 *
 * ── The three states, once ────────────────────────────────────────────────
 *
 * Eight of the nine views read one query (`useMatchAnalysis`), so eight of them
 * have the same three states, and `useAnalysisGate` is those states:
 *
 *   loading   row-shaped `Skeleton`s. No percentage — §4.3 forbids a progress
 *             number without a real denominator, and `AnalysisRun` has none
 *             (§10.4 gap 10).
 *   404       **not an error.** `analysisIsMissing` reads the status off the
 *             `DesktopError`, and a demo that was never analysed gets
 *             `Empty preset="not-analysed"` with 「开始分析」 — the one
 *             action that fixes it — rather than a red box that hides it.
 *   failure   an in-place `Notice` with 重试. §4.1 sets `throwOnError: false`
 *             precisely so the error lands next to the thing that failed.
 *
 * 「开始分析」 needs the local service, so it carries `useServiceAction`'s
 * disabled state and its written reason plus the 「· 需要服务」 tail — 「不隐藏、
 * 不静默失败」 applies to a recovery action as much as to a toolbar.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { Empty, Skeleton } from '../../../design/data';
import { Alert } from '../../../design/feedback';
import { Button, cn } from '../../../design/primitives';
import { useStartDemoAnalysis } from '../../../data/demos';
import { dataErrorMessage } from '../../../data/errors';
import { analysisIsMissing, useMatchAnalysis } from '../../../data/match';
import { useServiceAction } from '../../../data/serviceAction';
import { CS2_TICK_RATE } from '../../../domain/match';
import type { AnalysisWorkspace } from '../../../shared/desktop/viewModels';
import { RouteLink } from '../../RouteLink';
import type { MatchViewId } from '../viewContract';

/* ── the frame ───────────────────────────────────────────────────────────── */

export interface ViewFrameProps {
  readonly view: MatchViewId;
  /** `loading` / `empty` / `error` / `ready`, for tests and for bug reports. */
  readonly state?: string | undefined;
  readonly children: ReactNode;
}

/**
 * The content column of one view.
 *
 * `min-h-0` all the way down and the scroll on the shell's `<main>`: §10.3's
 * rule is that a page never grows a second scrollbar on `body`, which
 * `base.css` has set to `overflow: hidden` — it would simply clip.
 */
export function ViewFrame({ view, state = 'ready', children }: ViewFrameProps) {
  return (
    <section
      data-match-view={view}
      data-match-view-state={state}
      className="flex min-h-0 min-w-0 flex-col gap-5 p-6"
    >
      {children}
    </section>
  );
}

export interface ViewPanelProps {
  readonly id: string;
  readonly title: ReactNode;
  /** The artboard's second line in the head — 「含人数曲线与目标事件」. */
  readonly hint?: ReactNode | undefined;
  /** Right-aligned head slot: 「查看全部 18 条」. */
  readonly actions?: ReactNode | undefined;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}

export function ViewPanel({ id, title, hint, actions, children, className }: ViewPanelProps) {
  return (
    <section data-match-panel={id} className={cn('flex min-w-0 flex-col border border-divider', className)}>
      <header className="flex min-h-[var(--h-panel-head)] flex-none flex-wrap items-center gap-3 border-b border-divider px-3.5 py-1">
        {/* `base.css` is unlayered, so its heading rule outranks a utility; the
            head's size is declared inline — still a token. */}
        <h3 className="min-w-0 truncate font-heading tracking-wide" style={{ fontSize: 'var(--text-base)' }}>
          {title}
        </h3>
        {hint === undefined ? null : <p className="min-w-0 truncate text-xs text-neutral-600">{hint}</p>}
        {actions === undefined ? null : (
          <>
            <span className="flex-1" />
            <span className="flex flex-none items-center gap-2">{actions}</span>
          </>
        )}
      </header>
      {children}
    </section>
  );
}

/**
 * 「当前 R21」.
 *
 * The §4.4 selection, printed inside the view rather than only in the context
 * bar, so a deep link that arrives with a round selected says so next to the
 * thing that is selected — and so a test can see that a view change carried the
 * selection across (`matchWorkspace.interaction.test.tsx` reads exactly this).
 */
export function SelectedRoundLine({ round }: { readonly round: number | null }) {
  if (round === null) return null;
  return (
    <p data-match-view-context="" className="flex-none text-xs text-neutral-600">
      <Trans>当前 R{round}</Trans>
    </p>
  );
}

/* ── the number strip ────────────────────────────────────────────────────── */

export interface ViewMetric {
  readonly id: string;
  readonly label: ReactNode;
  /** Already formatted. A metric with no answer is omitted, never rendered 0. */
  readonly value: ReactNode;
  /** The qualifier under the number — 「24 回合中 22 回合有击杀」. */
  readonly detail?: ReactNode | undefined;
}

/**
 * 「回合胜负 13 - 11 · 首杀差 +4 · 高光证据 18」.
 *
 * A `<dl>` because that is what it is — a list of term/value pairs — and because
 * it gives assistive technology the pairing the visual grouping carries.
 * It wraps rather than scrolls: five short pairs at 616px (the §8 fold with a
 * docked Inspector, the narrowest this column ever is) fold onto two rows.
 */
export function MetricStrip({ metrics }: { readonly metrics: readonly ViewMetric[] }) {
  if (metrics.length === 0) return null;
  return (
    <dl data-match-metrics="" className="flex flex-wrap gap-x-7 gap-y-3 px-3.5 py-3">
      {metrics.map((metric) => (
        <div key={metric.id} data-match-metric={metric.id} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs text-neutral-600">{metric.label}</dt>
          <dd className="font-mono text-lg text-accent-800">{metric.value}</dd>
          {metric.detail === undefined ? null : (
            <dd className="text-2xs text-neutral-600">{metric.detail}</dd>
          )}
        </div>
      ))}
    </dl>
  );
}

/* ── loading / empty / failed ────────────────────────────────────────────── */

/** Row-shaped placeholders. No percentage: there is no denominator (§4.3). */
export function ViewSkeleton({ rows = 5 }: { readonly rows?: number }) {
  return (
    <div data-match-view-skeleton="" className="flex flex-col gap-2 p-3.5">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-[var(--h-row)]" />
      ))}
      {/* The bars are decoration; without this line a screen-reader user would
          hear nothing while the workspace loads. */}
      <p role="status" aria-busy="true" className="sr-only">
        <Trans>正在读取比赛分析</Trans>
      </p>
    </div>
  );
}

/* ── the 404 recovery ────────────────────────────────────────────────────── */

/**
 * 「这场比赛还没有分析」 and the way out of it.
 *
 * A component rather than a branch inside `useAnalysisGate` because three of the
 * nine views (回放 / 高光 / Review) are full-bleed and cannot take the gate's
 * panel framing, but must still offer the same recovery. They had each grown a
 * bare 「回到资料库开始分析」 link, which sends the user to another page to press
 * a button this page can press itself — six views offered 「开始分析」 in place
 * and three did not. One component, so that cannot drift again.
 *
 * The primary action carries `useServiceAction`, so with the service down it is
 * disabled with the reason written on it rather than hidden.
 */
export function NotAnalysedState({ demoId }: { readonly demoId: string }) {
  const start = useStartDemoAnalysis();
  const service = useServiceAction();

  return (
    <Empty
      preset="not-analysed"
      headingLevel={4}
      className="m-3.5"
      actions={
        <>
          <Button variant="primary" {...service.buttonProps} onClick={() => start.mutate([demoId])}>
            <Trans>开始分析</Trans>
            {service.suffix}
          </Button>
          <RouteLink to="/library">
            <Trans>回到资料库</Trans>
          </RouteLink>
        </>
      }
    />
  );
}

/* ── the shared read ─────────────────────────────────────────────────────── */

export interface AnalysisGate {
  /** Present only when the view can actually draw. */
  readonly analysis: AnalysisWorkspace | undefined;
  /** Non-null when it cannot: render this instead of the view's body. */
  readonly fallback: ReactNode | null;
  /** `loading` / `empty` / `error` / `ready`, for `ViewFrame`'s `state`. */
  readonly state: string;
  /** The match's own rate, or the CS2 default — stated, never assumed silently. */
  readonly tickRate: number;
}

/**
 * The analysis document plus the three states, for a view that needs nothing
 * else. Call it unconditionally at the top of a `Body`.
 */
export function useAnalysisGate(demoId: string): AnalysisGate {
  const id = demoId === '' ? null : demoId;
  const query = useMatchAnalysis(id);

  const tickRate = query.data?.tick_rate ?? CS2_TICK_RATE;

  if (query.data !== undefined) {
    return { analysis: query.data, fallback: null, state: 'ready', tickRate };
  }

  if (query.isPending) {
    return { analysis: undefined, fallback: <ViewSkeleton />, state: 'loading', tickRate };
  }

  if (analysisIsMissing(query.error)) {
    return {
      analysis: undefined,
      state: 'empty',
      tickRate,
      fallback: <NotAnalysedState demoId={demoId} />,
    };
  }

  return {
    analysis: undefined,
    state: 'error',
    tickRate,
    fallback: (
      <div className="p-3.5">
        <Alert
          variant="danger"
          action={{ label: <Trans>重试</Trans>, onAction: () => void query.refetch() }}
          detail={<Trans>分析结果没有被改动，重试是安全的。</Trans>}
        >
          <Trans>这场比赛的分析没能打开：{dataErrorMessage(query.error) ?? ''}</Trans>
        </Alert>
      </div>
    ),
  };
}
