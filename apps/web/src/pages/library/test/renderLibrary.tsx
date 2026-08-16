/**
 * Test-only harness for 「02 Demo 资料库」.
 *
 * `src/test/render.tsx` mounts `I18nProvider` + `QueryClientProvider` and hands
 * neither back. This page needs both handles:
 *
 *   · the **QueryClient**, to seed the cache. Under `renderToStaticMarkup` no
 *     effect runs, so nothing fetches and every query would sit in `loading`
 *     forever — a markup test that wants to assert on rows has to put the rows
 *     in the cache first, under the exact key `libraryDemoQuery` produces.
 *   · the **DesktopClient**, because no test may touch real IPC: there is no
 *     Tauri host under vitest, and `data/desktopClient.tsx` exists precisely so
 *     a stub can be injected. The stub is a plain object; anything the test
 *     does not exercise stays absent.
 *
 * The service gate is seeded the same way. `pages/library/serviceAction` reads
 * `qk.service.health()` read-only, so writing a payload there is 「服务在线」 and
 * writing nothing is 「还没连上」 — which is the blocked state every
 * service-backed button must render.
 *
 * Lives under `test/` so `lingui.config.ts` keeps its fixture Chinese out of the
 * catalogue and vitest does not mistake it for a test file.
 */

import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { DesktopClientProvider, type DesktopClient } from '../../../data/desktopClient';
import { qk } from '../../../data/keys';
import type {
  AppConfig,
  DemoMetadata,
  DemoWatchStatus,
  Paginated,
  ReviewTag,
} from '../../../shared/desktop/dto';
import type { DemoSummary } from '../../../shared/desktop/viewModels';
import { LibraryPage } from '../../LibraryPage';
import { libraryDemoQuery, readLibraryAddress } from '../libraryQuery';

/* ── fixtures ────────────────────────────────────────────────────────────── */

export const DEMO_FIXTURE: DemoSummary = {
  id: 'demo-a',
  path: 'D:\\CS2\\demos\\aurora-meridian-mirage.dem',
  filename: 'aurora-meridian-mirage.dem',
  display_name: 'Aurora vs Meridian',
  map_name: 'Mirage',
  match_date: '2026-08-14T20:11:00',
  cataloged_at: '2026-08-14T20:40:00',
  duration_seconds: 2462,
  total_rounds: 24,
  score_team_a: 13,
  score_team_b: 11,
  team_a_name: 'Aurora',
  team_b_name: 'Meridian',
  status: 'ready',
  lifecycle_status: 'ready',
  players: ['Kael'],
  source: 'upload',
  remark: '',
  updated_at: '2026-08-14T20:40:00',
};

export function makeDemo(index: number, overrides: Partial<DemoSummary> = {}): DemoSummary {
  return {
    ...DEMO_FIXTURE,
    id: `demo-${String(index)}`,
    display_name: `Aurora vs Meridian · 第 ${String(index + 1)} 场`,
    ...overrides,
  };
}

export function demoPage(
  items: readonly DemoSummary[],
  total = items.length,
  page = 1,
): Paginated<DemoSummary> {
  return { items: [...items], total, page, page_size: 20 };
}

export const WATCH_FIXTURE: DemoWatchStatus = {
  running: true,
  roots: [
    { path: 'D:\\CS2\\demos\\', state: 'watching', message: null },
    { path: 'E:\\replays\\', state: 'missing', message: '目录不存在' },
    { path: 'F:\\link\\', state: 'rejected', message: '不接受符号链接根目录' },
  ],
  last_scan_at: '2026-08-15T08:00:00',
  last_event_at: null,
  last_error: null,
  imported: 4,
  updated: 1,
  missing: 0,
};

export const TAG_FIXTURE: ReviewTag = {
  id: 'tag-1',
  name: '待剪素材',
  color: 'var(--color-accent)',
  created_at: '2026-08-01T00:00:00',
  updated_at: '2026-08-01T00:00:00',
};

export const METADATA_FIXTURE: DemoMetadata = {
  demo_id: 'demo-a',
  match_source: 'valve',
  comment: '',
  tags: [TAG_FIXTURE],
  updated_at: '2026-08-14T20:40:00',
};

/** Only the fields the page reads; the rest of `AppConfig` is not exercised. */
export const CONFIG_FIXTURE = {
  demo_watch_paths: ['D:\\CS2\\demos\\', 'E:\\replays\\', 'F:\\link\\'],
} as unknown as AppConfig;

/* ── the harness ─────────────────────────────────────────────────────────── */

export interface LibrarySeed {
  readonly demos?: Paginated<DemoSummary> | undefined;
  readonly detail?: DemoSummary | undefined;
  readonly metadata?: DemoMetadata | undefined;
  readonly watch?: DemoWatchStatus | undefined;
  readonly tags?: readonly ReviewTag[] | undefined;
  readonly config?: AppConfig | undefined;
  /** Anything at all means 「服务在线」; absent means the gate blocks. */
  readonly serviceOnline?: boolean | undefined;
}

export interface LibraryHarnessOptions {
  /** The address, e.g. `/library?view=card`. */
  readonly at?: string;
  readonly seed?: LibrarySeed;
  readonly client?: Partial<DesktopClient> & Record<string, unknown>;
  readonly queryClient?: QueryClient;
}

/**
 * Mirrors `createQueryClient()` bar `gcTime: 0`. The §4.1 defaults are part of
 * what these tests are about, so they are not softened.
 */
export function createLibraryQueryClient(): QueryClient {
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

function seedCache(queryClient: QueryClient, at: string, seed: LibrarySeed): void {
  const address = readLibraryAddress(new URLSearchParams(at.split('?')[1] ?? ''));

  if (seed.demos !== undefined) {
    queryClient.setQueryData(qk.demos.list(libraryDemoQuery(address)), seed.demos);
  }
  if (seed.detail !== undefined) {
    queryClient.setQueryData(qk.demos.detail(seed.detail.id), seed.detail);
  }
  if (seed.metadata !== undefined) {
    queryClient.setQueryData(qk.demos.metadata(seed.metadata.demo_id), seed.metadata);
  }
  if (seed.watch !== undefined) queryClient.setQueryData(qk.demos.watch(), seed.watch);
  if (seed.tags !== undefined) queryClient.setQueryData(qk.demos.reviewTags(), [...seed.tags]);
  if (seed.config !== undefined) queryClient.setQueryData(qk.config.app(), seed.config);
  if (seed.serviceOnline === true) {
    queryClient.setQueryData(qk.service.health(), { status: 'ok', version: '0.1.0' });
  }
}

function tree(queryClient: QueryClient, at: string, client: DesktopClient): ReactElement {
  return (
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <DesktopClientProvider client={client}>
          <MemoryRouter initialEntries={[at]}>
            <Routes>
              <Route path="/library" element={<LibraryPage />} />
              <Route path="/match/:demoId" element={<span data-workspace />} />
            </Routes>
          </MemoryRouter>
        </DesktopClientProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
}

function activate(): void {
  i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });
}

/** `markup` project: structure, aria, density. */
export function renderLibraryMarkup(options: LibraryHarnessOptions = {}): string {
  activate();
  const queryClient = options.queryClient ?? createLibraryQueryClient();
  const at = options.at ?? '/library';
  seedCache(queryClient, at, options.seed ?? {});
  return renderToStaticMarkup(
    tree(queryClient, at, (options.client ?? {}) as unknown as DesktopClient),
  );
}

export interface LibraryRenderResult extends RenderResult {
  readonly queryClient: QueryClient;
}

/** `interaction` project: focus, overlays, disabled states, the fold. */
export function renderLibrary(options: LibraryHarnessOptions = {}): LibraryRenderResult {
  activate();
  const queryClient = options.queryClient ?? createLibraryQueryClient();
  const at = options.at ?? '/library';
  seedCache(queryClient, at, options.seed ?? {});
  const rendered = render(tree(queryClient, at, (options.client ?? {}) as unknown as DesktopClient));
  return Object.assign(rendered, { queryClient });
}

/** A stub that records its calls — the same shape `data/test` uses. */
export interface CallRecorder<T> {
  readonly call: (...args: unknown[]) => Promise<T>;
  readonly calls: () => number;
  readonly lastArgs: () => unknown[];
  readonly fail: (error: unknown) => void;
}

export function recorder<T>(value: T): CallRecorder<T> {
  const state: { calls: number; args: unknown[]; error: unknown } = {
    calls: 0,
    args: [],
    error: null,
  };
  return {
    call: (...args: unknown[]) => {
      state.calls += 1;
      state.args = args;
      return state.error === null ? Promise.resolve(value) : Promise.reject(state.error);
    },
    calls: () => state.calls,
    lastArgs: () => state.args,
    fail: (error: unknown) => {
      state.error = error;
    },
  };
}
