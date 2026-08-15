/**
 * data layer — turning a rejected query into something a Notice can render.
 *
 * §4.1 sets `throwOnError: false`: 「错误就地渲染成 Notice（设计稿规定「不用
 * Toast 承载错误」）」. That decision only pays off if what lands in
 * `query.error` has a readable shape, and `unknown` is not one. Every read in
 * this layer rejects with `DesktopError` (`shared/desktop/client` wraps both the
 * IPC failure and the timeout), which carries the service's own localized
 * message plus the HTTP-ish status and code the routes return.
 *
 * The narrowing is structural rather than `instanceof`-only on purpose: a
 * contract parser in `shared/desktop/*Contract.ts` throws a plain `Error`, and
 * a page must still be able to show that message instead of a blank Notice.
 *
 * Pure and dependency-free, so it is asserted in the `unit` project.
 */

export interface DataError {
  /** Ready to render. Never empty — `fallback` fills in when nothing readable
   *  came back (a thrown string, a rejected `undefined`). */
  readonly message: string;
  /** The service's error code (`INVALID_DEMO_CONTRACT`, …) when it sent one. */
  readonly code: string | null;
  /** The route's status, or `0` for a transport-level failure. */
  readonly status: number | null;
}

/**
 * The message a failed read shows, or `null` when the failure carried none.
 * `null` rather than a generic string so the caller decides the wording — the
 * empty-state copy differs per page and this layer has no `Trans` of its own.
 */
export function dataErrorMessage(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (typeof error === 'string') return error === '' ? null : error;
  if (error instanceof Error) return error.message === '' ? null : error.message;

  const record = asRecord(error);
  if (record !== null && typeof record['message'] === 'string' && record['message'] !== '') {
    return record['message'];
  }
  return null;
}

/**
 * The full shape, for the places that branch on the code — 409 on a stale
 * revision (§4.5.3), `missing` outputs, an offline service. `null` when there
 * is no error at all, so `toDataError(query.error)` is directly renderable.
 */
export function toDataError(error: unknown, fallback: string): DataError | null {
  if (error === null || error === undefined) return null;

  const record = asRecord(error);
  return {
    message: dataErrorMessage(error) ?? fallback,
    code: record !== null && typeof record['code'] === 'string' ? record['code'] : null,
    status: record !== null && typeof record['status'] === 'number' ? record['status'] : null,
  };
}

/** `Error` instances are objects, so this also reaches `DesktopError`'s own
 *  `status` / `code` fields without importing the class. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as Record<string, unknown>;
}
