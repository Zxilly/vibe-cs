/*
 * Test-only harness for the phase 3a pages.
 *
 * Three things every one of these tests needs and `src/test/render.tsx` does
 * not provide on its own:
 *
 *   a router      the pages read `?view=` and `:taskId`, and render `RouteLink`
 *   a client      `DesktopClientProvider`, so no test touches the real IPC
 *                 bridge (there is no Tauri host under vitest anyway)
 *   a health cache
 *                 `pages/delivery/serviceAction.tsx` observes the entry
 *                 `app/boundary/ServiceGate` owns, and the gate is shell-level
 *                 chrome these page tests do not mount. Seeding the entry is
 *                 how a test says 「服务在线」 without a second probe — and
 *                 *not* seeding it is how a test says 「服务离线」, which is the
 *                 state the disabled-with-a-reason rule is about.
 *
 * Lives under `test/` so `lingui.config.ts` keeps its strings out of the
 * catalogue and vitest does not mistake it for a suite.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { RenderResult } from '@testing-library/react';

import { DesktopClientProvider, type DesktopClient } from '../../../data/desktopClient';
import { qk } from '../../../data/keys';
import { NativeShellProvider, type NativeShell } from '../../../data/nativeShell';
import type { ApiHealth } from '../../../shared/desktop/dto';
import { renderInteractive } from '../../../test/render';

export const HEALTHY: ApiHealth = {
  status: 'ok',
  version: '0.0.0-test',
  started_at: '2026-08-15T09:00:00.000Z',
};

export interface RenderPageOptions {
  /** The page under test. */
  readonly element: ReactElement;
  /** Only the methods the page calls need to be present. */
  readonly client: Record<string, unknown>;
  /** The address, and the route pattern it should match. */
  readonly route?: string | undefined;
  readonly pattern?: string | undefined;
  /** Omit to leave the service 「未连接」. */
  readonly health?: ApiHealth | undefined;
  readonly shell?: NativeShell | undefined;
}

export function renderPage({
  element,
  client,
  route = '/',
  pattern = '*',
  health,
  shell,
}: RenderPageOptions): RenderResult {
  const body = (
    <DesktopClientProvider client={client as unknown as DesktopClient}>
      <MemoryRouter initialEntries={[route]}>
        <SeedHealth health={health}>
          <Routes>
            <Route path={pattern} element={element} />
          </Routes>
        </SeedHealth>
      </MemoryRouter>
    </DesktopClientProvider>
  );
  return renderInteractive(
    shell === undefined ? body : <NativeShellProvider shell={shell}>{body}</NativeShellProvider>,
  );
}

/**
 * Writes the health entry before the children first render. The `useState`
 * initializer runs during this component's own render, which is before any
 * child observes the cache — an effect would run after, and the first paint
 * would show every service action disabled and then enable it, which is
 * exactly the flicker the tests are meant to catch.
 */
function SeedHealth({
  health,
  children,
}: {
  readonly health: ApiHealth | undefined;
  readonly children: ReactNode;
}) {
  const queryClient = useQueryClient();
  useState(() => {
    if (health !== undefined) queryClient.setQueryData(qk.service.health(), health);
    return null;
  });
  return <>{children}</>;
}
