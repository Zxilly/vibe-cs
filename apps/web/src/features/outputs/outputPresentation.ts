import { msg } from '../../shared/i18n';
import type {
  JobStatus,
  OutputAvailability,
  OutputItem,
  OutputKind,
  OutputReference,
} from '../../shared/desktop/dto';

export const terminalOutputStatuses = new Set<JobStatus>(['completed', 'failed', 'cancelled']);

const statusLabels: Record<JobStatus, string> = {
  queued: msg("m0662"),
  preparing: msg("m0250"),
  running: msg("m0408"),
  cancelling: msg("m0845"),
  completed: msg("m0510"),
  failed: msg("m0425"),
  cancelled: msg("m0504"),
};

const availabilityLabels: Record<OutputAvailability, string> = {
  present: msg("m0688"),
  missing: msg("m0689"),
  unsafe: msg("m1168"),
};

export function outputStatusLabel(status: JobStatus): string {
  return statusLabels[status];
}

export function outputAvailabilityLabel(availability: OutputAvailability): string {
  return availabilityLabels[availability];
}

export function outputStatusTone(status: JobStatus): 'neutral' | 'success' | 'warning' | 'danger' | 'blue' {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'cancelled') return 'neutral';
  if (status === 'cancelling') return 'warning';
  return 'blue';
}

export function outputAvailabilityTone(
  availability: OutputAvailability,
): 'success' | 'warning' | 'danger' {
  if (availability === 'present') return 'success';
  if (availability === 'missing') return 'warning';
  return 'danger';
}

export function outputReferenceKey(reference: OutputReference): string {
  return `${reference.kind}:${reference.id}`;
}

export function outputItemKey(item: Pick<OutputItem, 'output_kind' | 'id'>): string {
  return outputReferenceKey({ kind: item.output_kind, id: item.id });
}

export function outputReferenceFromKey(key: string): OutputReference | null {
  const separator = key.indexOf(':');
  if (separator <= 0 || separator === key.length - 1) return null;
  const kind = key.slice(0, separator);
  if (kind !== 'recording' && kind !== 'export') return null;
  return { kind, id: key.slice(separator + 1) };
}

export function outputKindLabel(kind: OutputKind): string {
  return kind === 'recording' ? msg("m0604") : msg("m0933");
}

export function formatOutputBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (const candidate of units.slice(1)) {
    if (value < 1024) break;
    value /= 1024;
    unit = candidate;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${unit}`;
}

export function canRevealOutput(item: OutputItem): boolean {
  return item.availability === 'present' && Boolean(item.path.trim());
}
