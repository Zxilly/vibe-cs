import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

import { missingRootError } from './app/boot';
import { queryClient } from './data/queryClient';
import { createAppRouter } from './routes';
// The design layer's entry point. `theme.css` opens with
// `@import 'tailwindcss'; @import './fonts.css'; @import './base.css';`, so the
// four sheets land in the one order that works — @font-face and the tokens
// before the element rules that read them — and importing them separately here
// would only duplicate the cascade. Every one of them declares its own cascade
// layer (`theme` / `base` / `components`), which is what keeps a Tailwind
// utility able to override the element reset underneath it.
import './design/theme.css';

// Activate the source locale synchronously so the first paint already has an
// active i18n instance. Macros carry their zh-CN source string, so an empty
// catalog renders the authored copy. Loading a compiled catalog (and therefore
// switching to en-US) is async and lands with the language switcher.
i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });

// Running in a plain browser, `invoke()` has no host and every screen renders
// its 「无法连接到本地服务」 card. Tauri's own `mockIPC` answers those calls from
// `dev/mockBackend.ts` instead, so `pnpm dev` is a usable place to look at the
// UI. It is a no-op under `pnpm desktop:dev` (the real bridge is already
// installed) and `import.meta.env.DEV` keeps the module out of `vite build`.
if (import.meta.env.DEV) {
  const { installMockBridge } = await import('./dev/mockBridge');
  await installMockBridge();
}

const root = document.getElementById('root');

if (!root) {
  throw missingRootError();
}

createRoot(root).render(
  <StrictMode>
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={createAppRouter()} />
      </QueryClientProvider>
    </I18nProvider>
  </StrictMode>,
);
