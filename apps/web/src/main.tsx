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
// three sheets land in the one order that works — @font-face and the tokens
// before the unlayered element rules that read them — and importing them
// separately here would only duplicate the cascade. `styles/index.css` is no
// longer referenced; the file itself goes with `features/**` in phase 4.
import './design/theme.css';

// Activate the source locale synchronously so the first paint already has an
// active i18n instance. Macros carry their zh-CN source string, so an empty
// catalog renders the authored copy. Loading a compiled catalog (and therefore
// switching to en-US) is async and lands with the language switcher.
i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });

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
