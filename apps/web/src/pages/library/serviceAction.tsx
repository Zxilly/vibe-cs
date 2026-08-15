/*
 * pages/library — the two disabled-button helpers this page needs on top of the
 * service gate.
 *
 * The gate itself is `data/serviceAction`'s `useServiceAction()`. This file used
 * to carry a second copy of that derivation, written while §2.1 rule 3 kept
 * pages out of `app/boundary`; the hook now lives in `data/**`, which pages may
 * import, so only the two helpers below are left here.
 */

import { type ServiceActionButtonProps } from '../../data/serviceAction';

export type { ServiceActionButtonProps, ServiceActionState } from '../../data/serviceAction';
export { useServiceAction as useLibraryServiceAction } from '../../data/serviceAction';

/**
 * An action the *backend* cannot perform yet, as opposed to one the service is
 * merely offline for. Same treatment — disabled, with the reason written down —
 * because 「不隐藏、不静默失败」 does not distinguish between the two, and a
 * button that quietly vanishes teaches the user the feature never existed.
 */
export function unavailableAction(reason: string): ServiceActionButtonProps {
  return { disabled: true, disabledReason: reason };
}

/**
 * The service gate plus one more reason to be disabled — a write already in
 * flight, an empty selection.
 *
 * Spreading `buttonProps` after a `disabled={busy}` would *undo* it, because an
 * online gate spreads `disabled: false`. This merges instead, and keeps the
 * `disabledReason` key absent (not `undefined`) so it satisfies `Button`'s
 * optional prop under `exactOptionalPropertyTypes`.
 */
export function alsoDisabled(
  service: ServiceActionButtonProps,
  busy: boolean,
): ServiceActionButtonProps {
  return {
    disabled: service.disabled || busy,
    ...(service.disabledReason === undefined ? {} : { disabledReason: service.disabledReason }),
  };
}
