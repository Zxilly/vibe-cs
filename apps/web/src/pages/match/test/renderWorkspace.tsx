/*
 * Test-only harness for the match workspace.
 *
 * A router (the page reads `:demoId` and four query parameters), a stubbed IPC
 * bridge (no test in this layer touches the real one — there is no Tauri host
 * under vitest) and a way to read the address back, which is the whole point of
 * §4.4: an assertion about a selection is an assertion about the URL.
 */

import type { RenderResult } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactElement } from 'react';

import { DesktopClientProvider, type DesktopClient } from '../../../data/desktopClient';
import { renderInteractive } from '../../../test/render';
import { renderMarkup } from '../../../test/render';
import { MatchWorkspacePage } from '../../MatchWorkspacePage';
import { DEMO_ID } from './fixtures';

/** A bridge that never answers, which keeps the page in its first paint. */
export const PENDING: Partial<DesktopClient> = {
  getDemo: () => new Promise(() => undefined),
  getAnalysis: () => new Promise(() => undefined),
};

function tree(client: Partial<DesktopClient>, url: string, extra?: ReactElement) {
  return (
    <DesktopClientProvider client={client as DesktopClient}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/match/:demoId"
            element={
              <>
                <MatchWorkspacePage />
                {extra}
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </DesktopClientProvider>
  );
}

export function markupAt(url: string, client: Partial<DesktopClient> = PENDING): string {
  return renderMarkup(tree(client, url));
}

/** Prints the current address so a test can assert on it as text. */
export function AddressProbe() {
  const location = useLocation();
  return <output data-address="">{`${location.pathname}${location.search}`}</output>;
}

export interface RenderWorkspaceOptions {
  readonly url?: string | undefined;
  readonly client?: Partial<DesktopClient> | undefined;
}

export function renderWorkspace({
  url = `/match/${DEMO_ID}`,
  client = PENDING,
}: RenderWorkspaceOptions = {}): RenderResult {
  return renderInteractive(tree(client, url, <AddressProbe />));
}
