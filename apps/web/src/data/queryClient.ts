import { QueryClient } from '@tanstack/react-query';

/**
 * Desktop defaults differ from the browser defaults TanStack ships with:
 *
 * - `refetchOnWindowFocus: false` — a desktop window is focused and blurred
 *   constantly; the default would fire IPC round-trips the user never asked for.
 * - `retry: false` — Tauri IPC failures are deterministic (service not started,
 *   path missing). Retrying only delays showing the error. Individual queries
 *   may opt back in.
 * - `staleTime: 30_000` — local data changes through explicit user actions, so
 *   aggressive freshness buys nothing.
 * - `throwOnError: false` — errors render in place as a Notice; the design
 *   forbids carrying errors in toasts and we do not want an ErrorBoundary to
 *   swallow the whole route.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 30_000,
        throwOnError: false,
      },
    },
  });
}

export const queryClient = createQueryClient();
