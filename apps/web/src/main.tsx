import { msg } from './shared/i18n';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

import { createAppRouter } from './app/router';
import './styles/index.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error(msg("m0707"));
}

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={createAppRouter()} />
  </StrictMode>,
);
