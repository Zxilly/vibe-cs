/**
 * Shell layer 3 — ServiceGate: the global degradation contract for the local
 * service.
 *
 * The artboard 「补齐 · 壳层规格」draws the offline shell in full — a title bar
 * whose dot goes hollow brick red, a persistent banner under it, read-only rows
 * still legible, and the two actions that need the service disabled with the
 * reason spelled onto the label (「导入 Demo · 需要服务」). Its footnote is the
 * whole specification:
 *
 *   "降级规则：需要服务的动作变为禁用并写明原因，不隐藏、不静默失败；只读内容
 *    照常可用；顶栏状态点从绿变为空心砖红；重连成功后横幅收起，被禁用的动作
 *    恢复，不需要刷新页面。"
 *
 * Shape: one provider, one hook, three components. Pages never probe and never
 * branch on a `source` union of their own — they call `useServiceAction()` and
 * hand what it returns to `Button`, which already accepts `disabledReason`
 * (`design/primitives/Button`, added in phase 0 for exactly this rule).
 *
 * Presentational and connected pieces are separate on purpose: `…Marker` and
 * `…Banner` take their state as props so the `markup` project can render every
 * state statically, while `…Notice` reads the context. There is no `…Indicator`
 * — `AppShell` calls `useService()` once for the title bar and passes the
 * status to `ServiceStatusMarker`, so the dot has one subscription and one
 * implementation.
 *
 * Data path: `@tanstack/react-query` over `data/health`'s `probeServiceHealth`,
 * read-only — spec §4.1 puts every server read in `data/**`. The QueryClient
 * comes from context (`useQueryClient`) rather than the singleton in
 * `data/queryClient.ts`, so a test tree gets its own cache.
 */

import { Trans } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';

import { probeServiceHealth } from '../../data/health';
import { Notice, StatusDot, type StatusDotStatus } from '../../design/feedback';
import { cn } from '../../design/primitives';
import type { ApiHealth } from '../../shared/desktop/dto';
import {
  SERVICE_HEALTH_KEY,
  serviceErrorMessage,
  servicePollIntervalMs,
  serviceStatusOf,
  shouldRefreshAfterRecovery,
  isServiceDegraded,
  type ServiceStatus,
} from '../../data/serviceHealth';

/* ── the contract pages consume ──────────────────────────────────────────── */

export interface ServiceState {
  readonly status: ServiceStatus;
  /** `status === 'online'`, the only state in which service-backed actions run. */
  readonly online: boolean;
  readonly offline: boolean;
  /** The service answered but reported `degraded`. Nothing is disabled. */
  readonly degraded: boolean;
  readonly version: string | null;
  /** The last probe failure, when it carried a readable message. */
  readonly error: string | null;
  /** A probe is in flight — the 「重新连接」 button's busy state. */
  readonly reconnecting: boolean;
  readonly reconnect: () => void;
}

const ServiceContext = createContext<ServiceState | null>(null);

export interface ServiceGateProps {
  children: ReactNode;
  /**
   * The health probe. Defaults to `data/health`'s `probeServiceHealth`; tests
   * pass their own.
   */
  probe?: (signal?: AbortSignal) => Promise<ApiHealth>;
  /**
   * Background polling. On in the app — it is what makes recovery automatic.
   * Tests turn it off and drive `reconnect()` by hand so no timer outlives the
   * assertion.
   */
  poll?: boolean;
}

export function ServiceGate({ children, probe = probeServiceHealth, poll = true }: ServiceGateProps) {
  const client = useQueryClient();

  const query = useQuery({
    queryKey: SERVICE_HEALTH_KEY,
    queryFn: ({ signal }) => probe(signal),
    // The §4.1 defaults are right for data and wrong for a heartbeat: a probe
    // whose answer is 30s old tells you nothing about whether the service is up
    // *now*, and one retry is the difference between "offline" and "offline in
    // a moment". Both are overridden here and nowhere else.
    retry: false,
    staleTime: 0,
    refetchInterval: poll
      ? (entry) =>
          servicePollIntervalMs(
            serviceStatusOf({ data: entry.state.data, error: entry.state.error }),
          )
      : false,
    refetchIntervalInBackground: false,
  });

  const status = serviceStatusOf({ data: query.data, error: query.error });
  const { refetch } = query;

  /* 「重连成功后……不需要刷新页面」. Every query that failed while the service was
     down is still holding its error; marking the whole cache stale re-runs the
     active ones and leaves the rest to refetch when they next mount. The probe
     itself is excluded — invalidating it here would re-enter this effect. */
  const previousStatus = useRef<ServiceStatus>(status);
  useEffect(() => {
    const before = previousStatus.current;
    previousStatus.current = status;
    if (!shouldRefreshAfterRecovery(before, status)) return;
    void client.invalidateQueries({
      predicate: (entry) => entry.queryKey[0] !== SERVICE_HEALTH_KEY[0],
    });
  }, [client, status]);

  const reconnect = useCallback(() => {
    void refetch();
  }, [refetch]);

  const value = useMemo<ServiceState>(
    () => ({
      status,
      online: status === 'online',
      offline: status === 'offline',
      degraded: isServiceDegraded(query.data),
      version: query.data?.version ?? null,
      error: serviceErrorMessage(query.error),
      reconnecting: query.isFetching,
      reconnect,
    }),
    [status, query.data, query.error, query.isFetching, reconnect],
  );

  return <ServiceContext.Provider value={value}>{children}</ServiceContext.Provider>;
}

/** Throws outside the provider: a page that silently assumed "online" would
 *  enable actions the service cannot serve, which is the failure mode the
 *  artboard's rule exists to prevent. */
export function useService(): ServiceState {
  const value = use(ServiceContext);
  if (value === null) {
    throw new Error('useService() 必须在 <ServiceGate> 内使用');
  }
  return value;
}

/*
 * `useServiceAction` and its two types live in `data/serviceAction` — pages
 * call them and §2.1 rule 3 keeps pages out of `app/**`. Re-exported here
 * because this module published the name first; the implementation reads the
 * very query this gate owns, so there is still exactly one derivation.
 */
export {
  serviceActionState,
  useServiceAction,
  useServiceStatus,
  type ServiceActionButtonProps,
  type ServiceActionState,
} from '../../data/serviceAction';

/* ── the title-bar marker ────────────────────────────────────────────────── */

/**
 * 「顶栏状态点从绿变为空心砖红」. `StatusDot` already encodes fill as meaning —
 * filled for what is happening, hollow for what is not — so `ok` and `fail`
 * give the artboard's transition without any colour written here.
 */
const MARKER: Record<ServiceStatus, { dot: StatusDotStatus; tone: string | null }> = {
  checking: { dot: 'idle', tone: null },
  online: { dot: 'ok', tone: null },
  offline: { dot: 'fail', tone: 'text-fail-text' },
};

export interface ServiceStatusMarkerProps {
  status: ServiceStatus;
  className?: string | undefined;
}

export function ServiceStatusMarker({ status, className }: ServiceStatusMarkerProps) {
  const marker = MARKER[status];

  return (
    <span
      role="status"
      data-service-status={status}
      className={cn('inline-flex items-center gap-2 text-xs', marker.tone, className)}
    >
      <StatusDot status={marker.dot} size="sm" />
      {status === 'online' ? <Trans>本地服务在线</Trans> : null}
      {status === 'offline' ? <Trans>本地服务未连接</Trans> : null}
      {status === 'checking' ? <Trans>正在连接本地服务</Trans> : null}
    </span>
  );
}

/* There is deliberately no gate-wired wrapper around the marker. `AppShell`
   already calls `useService()` for the title bar and passes the status down, so
   a `ServiceStatusIndicator` would be a second subscription rendering the same
   dot — the duplication this round set out to remove. */

/* ── the offline banner ──────────────────────────────────────────────────── */

export interface ServiceOfflineBannerProps {
  onReconnect: () => void;
  reconnecting?: boolean | undefined;
  /** Appended to the artboard's second line when the probe reported a reason. */
  detail?: ReactNode | undefined;
  className?: string | undefined;
}

/**
 * The artboard's banner, verbatim. `Notice` is the design system's persistent
 * message — 「Notice 常驻在页面里直到问题解决，不用 Toast 承载错误」 — and it
 * already carries the required single recovery action, so nothing is rebuilt
 * here. The one visual difference from the drawing: the artboard renders
 * 「重新连接」 as a bordered secondary button, `Notice` renders its action as an
 * accent text button. Consistency across every notice in the app wins over the
 * one-off.
 */
export function ServiceOfflineBanner({
  onReconnect,
  reconnecting = false,
  detail,
  className,
}: ServiceOfflineBannerProps) {
  return (
    <Notice
      tone="danger"
      className={cn('border-x-0 border-t-0', className)}
      detail={
        <>
          <Trans>已导入的比赛和已生成的视频仍可浏览。正在进行的任务会在服务恢复后自动接续状态。</Trans>
          {detail === undefined ? null : <> {detail}</>}
        </>
      }
      action={{
        label: reconnecting ? <Trans>正在重连</Trans> : <Trans>重新连接</Trans>,
        onAction: onReconnect,
        disabled: reconnecting,
      }}
    >
      <Trans>本地服务未连接，分析、录制和导出暂时无法开始</Trans>
    </Notice>
  );
}

/**
 * The banner, wired to the gate. Renders nothing while the service answers, so
 * the shell can mount it unconditionally under the title bar and 「重连成功后
 * 横幅收起」 falls out of the state rather than out of a page's branch.
 *
 * `checking` shows nothing either: a banner that flashes on every cold start
 * would train the user to ignore it.
 */
export function ServiceOfflineNotice({ className }: { className?: string | undefined }) {
  const { status, error, reconnecting, reconnect } = useService();
  if (status !== 'offline') return null;

  return (
    <ServiceOfflineBanner
      onReconnect={reconnect}
      reconnecting={reconnecting}
      detail={error ?? undefined}
      className={className}
    />
  );
}

/**
 * The in-row replacement the artboard draws where a link would be on a row that
 * needs the service (「未分析」 rows, dimmed, with 「需要服务」 in place of
 * 「工作区」). One component so twelve pages do not each write the two
 * characters and pick their own grey.
 */
export function ServiceRequiredHint({ className }: { className?: string | undefined }) {
  return (
    <span className={cn('text-sm text-neutral-600', className)}>
      <Trans>需要服务</Trans>
    </span>
  );
}

/** The dimming the artboard applies to those rows (`opacity:.5`). */
export const SERVICE_REQUIRED_ROW_CLASS = 'opacity-50';
