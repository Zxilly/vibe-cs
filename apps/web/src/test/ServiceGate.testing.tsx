import type { ReactNode } from 'react';

import { ServiceGate } from '../app/boundary';

export function HealthyServiceGate({ children }: { readonly children: ReactNode }) {
  return (
    <ServiceGate
      probe={async () => ({ status: 'ok', version: '0.0.0-test', started_at: '2026-08-20T00:00:00Z' })}
      poll={false}
    >
      {children}
    </ServiceGate>
  );
}
