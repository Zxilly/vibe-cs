/**
 * Test-only harness for the `data/**` hooks.
 *
 * **No test in this layer talks to the real IPC bridge.** There is no Tauri
 * environment under vitest — `@tauri-apps/api`'s `invoke` has no host to call —
 * so every hook gets a hand-written client through `DesktopClientProvider`.
 * That is also the point of the seam: a stub is a plain object, and it is
 * typechecked against `DesktopClient`, so a stub that drifts from the real wire
 * signature fails the build rather than passing a green test over a fiction.
 *
 * Not folded into `src/test/render.tsx` because that helper is shared by every
 * layer and always mounts `I18nProvider`; these hooks render no text, and they
 * need a *handle on the QueryClient* (to invalidate and assert the refetch),
 * which `renderInteractive` does not hand back.
 *
 * Lives under `data/test/` so `lingui.config.ts` excludes it from the message
 * catalogue and vitest does not mistake it for a test file.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, type RenderHookResult } from '@testing-library/react';
import type { ReactNode } from 'react';

import { DesktopClientProvider, type DesktopClient } from '../desktopClient';

/**
 * Mirrors `createQueryClient()` except for `gcTime: 0` (drop entries the moment
 * the tree unmounts) — the §4.1 defaults are what the assertions are about, so
 * they are not softened.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 30_000,
        throwOnError: false,
        gcTime: 0,
      },
      mutations: { retry: false, throwOnError: false },
    },
  });
}

export interface RenderDataHookOptions {
  /** The stubbed bridge. Only the methods the hook under test calls need to
   *  be present; the cast is done once, here, so no test file repeats it. */
  client: Partial<DesktopClient>;
  queryClient?: QueryClient;
}

export interface RenderDataHookResult<T> extends RenderHookResult<T, void> {
  queryClient: QueryClient;
}

export function renderDataHook<T>(
  hook: () => T,
  options: RenderDataHookOptions,
): RenderDataHookResult<T> {
  const queryClient = options.queryClient ?? createTestQueryClient();
  const client = options.client as DesktopClient;

  const rendered = renderHook(hook, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <DesktopClientProvider client={client}>{children}</DesktopClientProvider>
      </QueryClientProvider>
    ),
  });

  return Object.assign(rendered, { queryClient });
}

/**
 * A stub that counts its calls and can be flipped to fail — the two things
 * every hook test needs (success, failure, and "did the invalidation actually
 * re-run the queryFn").
 */
export interface CountingStub<T> {
  /** Hand this to the stubbed client method. */
  readonly call: (...args: unknown[]) => Promise<T>;
  readonly calls: () => number;
  /** Arguments of the most recent call, for asserting the signal is forwarded. */
  readonly lastArgs: () => unknown[];
  /** After this, every call rejects with `error`. */
  readonly fail: (error: unknown) => void;
  readonly succeed: (value: T) => void;
}

export function countingStub<T>(initial: T): CountingStub<T> {
  const state: { value: T; error: unknown; calls: number; lastArgs: unknown[] } = {
    value: initial,
    error: null,
    calls: 0,
    lastArgs: [],
  };

  return {
    call: (...args: unknown[]) => {
      state.calls += 1;
      state.lastArgs = args;
      return state.error === null ? Promise.resolve(state.value) : Promise.reject(state.error);
    },
    calls: () => state.calls,
    lastArgs: () => state.lastArgs,
    fail: (error: unknown) => {
      state.error = error;
    },
    succeed: (value: T) => {
      state.value = value;
      state.error = null;
    },
  };
}
