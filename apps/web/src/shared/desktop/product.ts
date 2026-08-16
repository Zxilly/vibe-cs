import { request } from './client';
import type { DiagnosticExport } from './generated/DiagnosticExport';
import type { ManagedLocations } from './generated/ManagedLocations';

export type UpdateInfo = {
  current_version: string;
  configured: boolean;
  manifest_url: string | null;
  policy: 'manual_check_only';
};

export type UpdateCheckResult = {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  download_url: string;
  notes: string;
  published_at: string | null;
  checked_at: string;
};

export type { ManagedLocations } from './generated/ManagedLocations';
/**
 * `contains_secrets` is `boolean`, not the literal `false` this file used to
 * assert. The service always sends false and the report is built to make that
 * true, but a generated type cannot say "always" — and a page that promises
 * 「不含密钥」 should read the flag rather than the type.
 */
export type { DiagnosticExport } from './generated/DiagnosticExport';

export const productApi = {
  updateInfo: (signal?: AbortSignal) => request<UpdateInfo>('/app/update-info', { signal }),
  checkUpdate: (signal?: AbortSignal) => request<UpdateCheckResult>('/app/check-update', {
    method: 'POST',
    timeoutMs: 12_000,
    signal,
  }),
  managedLocations: (signal?: AbortSignal) => request<ManagedLocations>('/app/managed-locations', { signal }),
  exportDiagnostics: (signal?: AbortSignal) => request<DiagnosticExport>('/app/diagnostics/export', {
    method: 'POST',
    signal,
  }),
};

