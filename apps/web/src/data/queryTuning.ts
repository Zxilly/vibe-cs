/**
 * data layer — the two knobs a caller is allowed to turn on a read.
 *
 * Spec §4.1 fixes the QueryClient defaults (`refetchOnWindowFocus: false`,
 * `retry: false`, `staleTime: 30_000`, `throwOnError: false`) and this layer
 * does not override them per hook: a page that quietly re-tunes staleness is
 * how the cache stops being predictable. Two things genuinely belong to the
 * caller, though, and neither is expressible as a default:
 *
 *   `enabled` — the read depends on a selection the user has not made yet
 *               (no demo chosen, no player chosen). Passing an id of `null`
 *               already disables a read on its own; this is for the rest.
 *   `pollMs`  — the read watches something that moves on its own. §4.1 has no
 *               refetch interval at all, which is right for library data and
 *               wrong for a running task (§4.3: 「推进由后端事件驱动」, but
 *               until an event channel exists the feed is polled). The cadence
 *               is the *page's* judgement, so no hook picks one for it, and
 *               the default stays "no polling".
 *
 * Resolving both here keeps the shape one function rather than a branch in
 * every hook, and makes the rule testable in the `unit` project.
 */

export interface DataQueryTuning {
  /** Defaults to `true`. */
  enabled?: boolean | undefined;
  /**
   * Milliseconds between background refetches. `false` (the default) polls
   * never. A non-positive or non-finite number is treated as `false` rather
   * than handed to TanStack, where `0` would mean "as fast as possible".
   */
  pollMs?: number | false | undefined;
}

export interface ResolvedQueryTuning {
  readonly enabled: boolean;
  readonly refetchInterval: number | false;
  /** Never poll a window the user is not looking at (§4.1's reasoning about
   *  desktop focus applies to intervals as much as to focus refetches). */
  readonly refetchIntervalInBackground: false;
}

/**
 * `tuning` is what the caller passed; `gate` is what the hook itself knows —
 * typically `{ enabled: id !== null }`. Both must agree for the query to run,
 * so a caller cannot enable a read the hook has no arguments for.
 */
export function resolveQueryTuning(
  tuning: DataQueryTuning = {},
  gate: { enabled?: boolean } = {},
): ResolvedQueryTuning {
  return {
    enabled: (gate.enabled ?? true) && (tuning.enabled ?? true),
    refetchInterval: normalizePollMs(tuning.pollMs),
    refetchIntervalInBackground: false,
  };
}

function normalizePollMs(pollMs: number | false | undefined): number | false {
  if (pollMs === undefined || pollMs === false) return false;
  if (!Number.isFinite(pollMs) || pollMs <= 0) return false;
  return pollMs;
}
