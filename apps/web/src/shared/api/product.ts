import { request } from './client';

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

export type ManagedLocations = {
  data: string;
  logs: string;
  recordings: string;
  exports: string;
  diagnostics: string;
  desktop_open_supported: boolean;
};

export type DiagnosticExport = {
  path: string;
  created_at: string;
  contains_secrets: false;
};

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

