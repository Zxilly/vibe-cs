/*
 * Test-only harness for the phase 3a pages.
 *
 * Three things every one of these tests needs and `src/test/render.tsx` does
 * not provide on its own:
 *
 *   a router      the pages read `?view=` and `:taskId`, and render `RouteLink`
 *   a client      `DesktopClientProvider`, so no test touches the real IPC
 *                 bridge (there is no Tauri host under vitest anyway)
 * Lives under `test/` so `lingui.config.ts` keeps its strings out of the
 * catalogue and vitest does not mistake it for a suite.
 */

import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { RenderResult } from '@testing-library/react';

import { DesktopClientProvider, type DesktopClient } from '../../../data/desktopClient';
import { NativeShellProvider, type NativeShell } from '../../../data/nativeShell';
import { renderInteractive } from '../../../test/render';

export interface RenderPageOptions {
  /** The page under test. */
  readonly element: ReactElement;
  /** Only the methods the page calls need to be present. */
  readonly client: Record<string, unknown>;
  /** The address, and the route pattern it should match. */
  readonly route?: string | undefined;
  readonly pattern?: string | undefined;
  readonly shell?: NativeShell | undefined;
}

export function renderPage({
  element,
  client,
  route = '/',
  pattern = '*',
  shell,
}: RenderPageOptions): RenderResult {
  const body = (
    <DesktopClientProvider client={client as unknown as DesktopClient}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path={pattern} element={element} />
        </Routes>
      </MemoryRouter>
    </DesktopClientProvider>
  );
  return renderInteractive(
    shell === undefined ? body : <NativeShellProvider shell={shell}>{body}</NativeShellProvider>,
  );
}
