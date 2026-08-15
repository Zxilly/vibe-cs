/*
 * data layer — 「需要服务的动作变为禁用并写明原因，不隐藏、不静默失败」.
 *
 * This lives in `data/` and not in `app/boundary/` beside `ServiceGate`, even
 * though the gate owns the probe, because of who needs it. §2.1 rule 3 forbids
 * `pages/**` from importing `app/**`, and this hook is called by page bodies —
 * a library import button, a delivery retry, an evidence annotation. Phase 3
 * ran into that wall and two page directories each grew their own copy of this
 * derivation; folding them here removes both, and `app/boundary` re-exports the
 * name it already published so its own callers do not change.
 *
 * It is a *reader*, never an owner. The key is `qk.service.health()` — the same
 * factory call `ServiceGate` subscribes with, not a second literal — and the
 * fetcher is `skipToken`, so this observer can never start a request. That
 * matters: a second `useQuery` on that key carrying its own `retry` /
 * `staleTime` / `refetchInterval` would hand the heartbeat a cadence nobody
 * chose, which is exactly what `data/health.ts` warns against. Everything about
 * when to probe stays in the gate.
 *
 * `checking` blocks as well as `offline`. Enabling a button before the first
 * probe lands trades a written reason for a silent failure, and the artboard's
 * sentence forbids both.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { skipToken, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { qk } from './keys';
import { serviceActionBlocked, serviceStatusOf, type ServiceStatus } from './serviceHealth';
import type { ApiHealth } from '../shared/desktop/dto';

/**
 * Spreadable onto `design/primitives/Button`. `disabledReason` is *absent*
 * rather than `undefined` when the service is up — the workspace compiles with
 * `exactOptionalPropertyTypes`, so an explicit `undefined` would not satisfy
 * Button's optional prop.
 */
export interface ServiceActionButtonProps {
  readonly disabled: boolean;
  readonly disabledReason?: string;
}

export interface ServiceActionState {
  readonly blocked: boolean;
  /** 「禁用并写明原因」, in the two props Button already understands. */
  readonly buttonProps: ServiceActionButtonProps;
  /**
   * The label tail the artboard appends to a blocked action
   * (「导入 Demo · 需要服务」). `undefined` while the service is up, so
   * `{label}{suffix}` needs no branch at the call site.
   */
  readonly suffix: ReactNode | undefined;
}

/** The gate's current answer, read without subscribing to a fetch. */
export function useServiceStatus(): ServiceStatus {
  const probe = useQuery<ApiHealth>({ queryKey: qk.service.health(), queryFn: skipToken });
  return serviceStatusOf({ data: probe.data, error: probe.error });
}

/** Turns a status into the two props and the label tail. Pure — no hooks. */
export function serviceActionState(status: ServiceStatus): ServiceActionState {
  if (!serviceActionBlocked(status)) {
    return { blocked: false, buttonProps: { disabled: false }, suffix: undefined };
  }

  return {
    blocked: true,
    buttonProps: {
      disabled: true,
      disabledReason:
        status === 'checking'
          ? t`正在连接本地服务，稍后即可使用`
          : t`本地服务未连接，恢复后无需刷新页面即可继续`,
    },
    suffix: (
      <>
        {' '}
        <Trans>· 需要服务</Trans>
      </>
    ),
  };
}

/**
 * Everything a service-backed action needs, in one call:
 *
 *   const service = useServiceAction();
 *   <Button {...service.buttonProps}>
 *     <Trans>导入 Demo</Trans>{service.suffix}
 *   </Button>
 */
export function useServiceAction(): ServiceActionState {
  return serviceActionState(useServiceStatus());
}
