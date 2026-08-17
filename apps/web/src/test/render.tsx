import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const SOURCE_LOCALE = 'zh-CN';

/**
 * Activate the source locale with an empty catalog. Macros bake the authored
 * zh-CN string into their output, so a missing catalog entry falls back to it —
 * which means tests never depend on `lingui compile` having run.
 */
function activateSourceLocale(): void {
  i18n.loadAndActivate({ locale: SOURCE_LOCALE, messages: {} });
}

/**
 * Fresh client per render: `gcTime: 0` drops cache entries as soon as the tree
 * unmounts, `retry: false` keeps a failing query from hanging the test.
 */
function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        staleTime: 0,
        refetchOnWindowFocus: false,
        throwOnError: false,
      },
      mutations: {
        retry: false,
        throwOnError: false,
      },
    },
  });
}

function TestProviders({ client, children }: { client: QueryClient; children: ReactNode }) {
  return (
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </I18nProvider>
  );
}

/** For the `markup` project: structure and aria assertions. */
export function renderMarkup(ui: ReactElement): string {
  activateSourceLocale();
  return renderToStaticMarkup(<TestProviders client={createTestQueryClient()}>{ui}</TestProviders>);
}

/**
 * `renderMarkup` for a component that portals.
 *
 * `react-dom/server` has no portal: `createPortal` throws under
 * `renderToStaticMarkup`, which is why the pre-Radix `Dialog` was a plain
 * `position: fixed` div and said so in its header. Radix puts every overlay
 * through one, so a structural test of an overlay has to mount for real and
 * read the document back.
 *
 * Returns the whole of `body`, not the render container: the portal is a
 * sibling of the container, so a caller that only looked at the container
 * would see an empty string and read it as 「没渲染」.
 */
export function renderMarkupDom(ui: ReactElement): string {
  activateSourceLocale();
  const client = createTestQueryClient();
  render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => <TestProviders client={client}>{children}</TestProviders>,
  });
  return document.body.innerHTML;
}

/** For the `interaction` project (jsdom env): focus, keyboard, overlays. */
export function renderInteractive(ui: ReactElement): RenderResult {
  activateSourceLocale();
  const client = createTestQueryClient();
  return render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => <TestProviders client={client}>{children}</TestProviders>,
  });
}
