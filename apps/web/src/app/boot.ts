/*
 * App shell — the boot invariant `main.tsx` checks before it mounts.
 *
 * Why the message lives here and not next to the check: `src/main.tsx` is
 * outside every root that Lingui owns, and `shared/i18n/coverage.test.tsx`
 * fails the build on any Han character found outside those roots (it is the
 * last guard on the hand-rolled catalog, and phase 4 deletes it together with
 * `shared/i18n`). A `t` macro in `main.tsx` would put the authored zh-CN source
 * string into that file. Keeping the copy in `app/**` — which the guard exempts
 * because Lingui owns it — lets `main.tsx` stay a five-line composition root
 * and still speak the product's language.
 *
 * It is a function rather than a constant on purpose: `t` resolves against the
 * active catalog at call time, and at module-evaluation time `i18n` has not
 * been activated yet.
 */

import { t } from '@lingui/core/macro';

/**
 * Raised when `index.html` no longer carries `<div id="root">`. Nothing can be
 * rendered at that point, so this reaches the user only through the webview's
 * console — but it is still the product speaking, so it is still translated.
 */
export function missingRootError(): Error {
  return new Error(t`页面根节点 #root 不存在，应用无法启动`);
}
