import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { msg } from './shared/i18n';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

import { createAppRouter } from './app/router';
import { queryClient } from './data/queryClient';
import './styles/index.css';

// Activate the source locale synchronously so the first paint already has an
// active i18n instance. Macros carry their zh-CN source string, so an empty
// catalog renders the authored copy. Loading a compiled catalog (and therefore
// switching to en-US) is async and lands with the language switcher.
i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });

const root = document.getElementById('root');

if (!root) {
  throw new Error(msg("m0707"));
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
