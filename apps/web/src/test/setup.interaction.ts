import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// `globals` is off, so Testing Library's own auto-cleanup hook never registers.
// Unmount explicitly instead, otherwise trees leak across tests and focus
// assertions start reading the previous test's DOM.
afterEach(() => {
  cleanup();
});
