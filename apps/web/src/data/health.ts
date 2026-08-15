/**
 * data layer — the local-service health probe (spec §4.1 「离线降级」).
 *
 * `app/boundary/ServiceGate` owns the *subscription*: one query, one provider,
 * one poll cadence, and the recovery invalidation that follows from it. What
 * lived in the wrong layer was the call itself — `ServiceGate` imported
 * `commands.health`, which §4.1 reserves for `data/**`. This file is that call,
 * and `ServiceGate`'s default `probe` now points at it.
 *
 * There is deliberately **no `useServiceHealth()` hook here.** A second
 * `useQuery` on `qk.service.health()` would be a second observer on the gate's
 * entry with different options (the gate overrides `staleTime` to 0 and drives
 * `refetchInterval` off the current status), and observers with conflicting
 * intervals on one key produce a refetch cadence nobody chose. Anything that
 * needs the status reads `useService()` from the shell, which is already the
 * shape pages consume — see `ServiceGate`'s own note about not shipping a
 * second `ServiceStatusIndicator`.
 */

import type { QueryClient } from '@tanstack/react-query';

import { commands } from '../shared/desktop/client';
import type { ApiHealth } from '../shared/desktop/dto';
import { qk } from './keys';

/** The key the gate subscribes on. Same array shape as
 *  `app/boundary/serviceHealth`'s `SERVICE_HEALTH_KEY`, pinned by
 *  `keys.test.ts`. */
export const serviceHealthKey = qk.service.health;

/**
 * One probe. Signature matches `ServiceGateProps['probe']` exactly — the
 * `signal` is forwarded so an unmounting gate aborts its in-flight request
 * rather than resolving into a dead tree.
 *
 * Not routed through `useDesktopClient()` because the gate calls it outside
 * React's data flow (as a default prop value), and because the gate already
 * accepts an injected probe: every `ServiceGate` test passes its own.
 */
export function probeServiceHealth(signal?: AbortSignal): Promise<ApiHealth> {
  return commands.health(signal);
}

/**
 * Force the next probe to be a fresh call. Not used by the gate — it calls
 * `refetch()` on its own query for 「重新连接」 — but a settings page that just
 * changed the service configuration has no other handle on it.
 */
export function invalidateServiceHealth(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.service.health() });
}
