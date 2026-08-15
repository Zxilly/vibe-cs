/**
 * Shell layer 3 — the local service contract, pure half.
 *
 * Everything here is a function of a query snapshot, so the rules the artboard
 * 「本地服务离线 · 全局降级」states in prose can be asserted in the `unit`
 * project without a React tree or an IPC bridge:
 *
 *   "需要服务的动作变为禁用并写明原因，不隐藏、不静默失败；只读内容照常可用；
 *    顶栏状态点从绿变为空心砖红；重连成功后横幅收起，被禁用的动作恢复，
 *    不需要刷新页面。"
 *
 * The last clause is the one that needs a rule rather than a component: the
 * shell has to notice the transition back to online *by itself* and refresh the
 * caches that failed while the service was down. `shouldRefreshAfterRecovery`
 * is that edge, and `ServiceGate` is the only thing allowed to act on it.
 *
 * Why this file exists at all: today every page re-derives its own
 * `source !== 'service'` flag (features/library, features/settings,
 * features/editor, features/montage, features/analysis — five copies of the
 * same three-state union, each with its own copy for the disabled reason).
 * The shell owns the state once; pages consume it.
 */

import { qk } from '../../data/keys';
import type { ApiHealth } from '../../shared/desktop/dto';

/**
 * The query key for the health probe. Its first segment doubles as the
 * namespace `ServiceGate` excludes when it invalidates everything else on
 * recovery — invalidating the probe from inside its own success handler would
 * loop.
 *
 * It comes from `data/keys` rather than being declared here: every other key in
 * the app is minted there, and two independent declarations that must stay
 * deep-equal is exactly the drift a key factory exists to prevent.
 */
export const SERVICE_HEALTH_KEY = qk.service.health();

/** Background probe cadence while the service answers. */
export const SERVICE_POLL_ONLINE_MS = 30_000;

/**
 * Background probe cadence while it does not. Faster, because this interval is
 * what makes 「重连成功后横幅收起」 happen without the user pressing anything —
 * the manual 「重新连接」 button only shortens the wait.
 */
export const SERVICE_POLL_OFFLINE_MS = 5_000;

/**
 * `checking` is the first probe only. Once an answer (or a failure) has landed
 * the state is definite, and a later failed refetch means `offline` even though
 * the last good payload is still in the cache — a stale `ApiHealth` is not
 * evidence that the service is up.
 */
export type ServiceStatus = 'checking' | 'online' | 'offline';

export interface ServiceQuerySnapshot {
  readonly data: ApiHealth | undefined;
  readonly error: unknown;
}

export function serviceStatusOf({ data, error }: ServiceQuerySnapshot): ServiceStatus {
  if (error !== null && error !== undefined) return 'offline';
  if (data === undefined) return 'checking';
  return 'online';
}

/**
 * `ApiHealth.status` has a second value, `degraded`: the service answers but
 * reports it is not fully well. That is not the offline case — nothing gets
 * disabled — so it is surfaced separately rather than folded into the union.
 */
export function isServiceDegraded(data: ApiHealth | undefined): boolean {
  return data?.status === 'degraded';
}

export function servicePollIntervalMs(status: ServiceStatus): number {
  return status === 'online' ? SERVICE_POLL_ONLINE_MS : SERVICE_POLL_OFFLINE_MS;
}

/**
 * 「需要服务的动作变为禁用」 — and `checking` blocks too. The five pages this
 * replaces all wrote `source !== 'service'`, which blocked during loading as
 * well, and they were right to: enabling a button before the first probe lands
 * trades a written reason for a silent failure, which the same sentence forbids.
 */
export function serviceActionBlocked(status: ServiceStatus): boolean {
  return status !== 'online';
}

/**
 * The recovery edge. Only `offline → online` refreshes: `checking → online` is
 * a cold start, where every query is either already loading or has never run,
 * and invalidating there would fire a second round of IPC for nothing.
 */
export function shouldRefreshAfterRecovery(before: ServiceStatus, after: ServiceStatus): boolean {
  return before === 'offline' && after === 'online';
}

/**
 * A message for the banner's second line when the failure carries one.
 * `DesktopError` extends `Error`, so its localized `message` comes through;
 * anything else is not shown rather than stringified into `[object Object]`.
 */
export function serviceErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message !== '') return error.message;
  return null;
}
