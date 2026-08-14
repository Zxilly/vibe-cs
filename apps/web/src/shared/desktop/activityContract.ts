import type {
  ActivityAction,
  ActivityFeed,
  ActivityItem,
  ActivityKind,
  ActivityStatus,
} from './dto';

const itemKeys = [
  'id', 'kind', 'subtype', 'job_id', 'context_id', 'subject', 'status', 'stage',
  'progress_percent', 'completed_units', 'total_units', 'unit', 'error',
  'created_at', 'updated_at', 'available_actions',
] as const;
const feedKeys = ['items', 'total', 'page', 'page_size', 'summary'] as const;
const summaryKeys = ['total', 'active', 'failed', 'completed', 'cancelled'] as const;
const kinds = new Set<ActivityKind>(['recording', 'export', 'download', 'analysis']);
const statuses = new Set<ActivityStatus>([
  'queued', 'preparing', 'running', 'cancelling', 'completed', 'failed', 'cancelled',
  'downloading', 'decompressing', 'importing', 'analyzing',
]);
const actions = new Set<ActivityAction>([
  'cancel', 'retry_analysis', 'retry_download', 'retry_recording', 'open_analysis',
  'open_library', 'open_match_history', 'open_outputs',
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const analysisStages = new Set([
  'validating_input', 'parser_queued', 'parser_running', 'verifying_input_after_parse',
  'projecting', 'completed', 'failed', 'interrupted', 'cancelled',
]);
const actionsByKind: Record<ActivityKind, ReadonlySet<ActivityAction>> = {
  recording: new Set(['cancel', 'retry_recording', 'open_outputs']),
  export: new Set(['cancel', 'open_outputs']),
  download: new Set(['cancel', 'retry_download', 'open_match_history']),
  analysis: new Set(['cancel', 'retry_analysis', 'open_analysis', 'open_library']),
};
const recordingStageUnits: Readonly<Record<string, number>> = {
  'recording.stage.launching': 1,
  'recording.stage.seeking': 2,
  'recording.stage.capturing': 3,
  'recording.stage.stabilizing': 4,
  'recording.stage.encoding': 5,
};

function invalid(): never {
  throw new Error('Activity response does not match the current contract.');
}

function recordWithExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function nullableNonnegativeInteger(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function actionsExactly(actual: ActivityAction[], expected: readonly ActivityAction[]): boolean {
  return actual.length === expected.length && actual.every((action, index) => action === expected[index]);
}

export function parseActivityItem(value: unknown): ActivityItem {
  if (!recordWithExactKeys(value, itemKeys)) return invalid();
  if (
    typeof value.id !== 'string'
    || typeof value.kind !== 'string'
    || !kinds.has(value.kind as ActivityKind)
    || !nullableString(value.subtype)
    || !nullableString(value.job_id)
    || !nullableString(value.context_id)
    || !nullableString(value.subject)
    || typeof value.status !== 'string'
    || !statuses.has(value.status as ActivityStatus)
    || !nullableString(value.stage)
    || !nullableNonnegativeInteger(value.progress_percent)
    || (typeof value.progress_percent === 'number' && value.progress_percent > 100)
    || !nullableNonnegativeInteger(value.completed_units)
    || !nullableNonnegativeInteger(value.total_units)
    || !(value.unit === null || value.unit === 'bytes' || value.unit === 'stages')
    || !nullableString(value.error)
    || typeof value.created_at !== 'string'
    || typeof value.updated_at !== 'string'
    || !Array.isArray(value.available_actions)
    || value.available_actions.some((action) => typeof action !== 'string' || !actions.has(action as ActivityAction))
  ) return invalid();
  const kind = value.kind as ActivityKind;
  const status = value.status as ActivityStatus;
  const availableActions = value.available_actions as ActivityAction[];
  if (
    typeof value.job_id !== 'string'
    || !uuidPattern.test(value.job_id)
    || value.id !== `${value.kind}:${value.job_id}`
    || (value.unit === null) !== (value.completed_units === null)
    || (value.unit === null && value.total_units !== null)
    || (value.unit === 'stages' && value.total_units === null)
    || (
      typeof value.completed_units === 'number'
      && typeof value.total_units === 'number'
      && value.completed_units > value.total_units
    )
    || new Set(availableActions).size !== availableActions.length
    || availableActions.some((action) => !actionsByKind[kind].has(action))
  ) return invalid();
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  if (kind === 'recording') {
    const expectedUnits = value.stage === null ? undefined : recordingStageUnits[value.stage];
    if (
      value.subtype !== null
      || value.progress_percent !== null
      || (
        expectedUnits === undefined
          ? value.completed_units !== null || value.total_units !== null || value.unit !== null
          : value.completed_units !== expectedUnits || value.total_units !== 5 || value.unit !== 'stages'
      )
    ) return invalid();
    const actionSetIsCurrent = terminal
      ? actionsExactly(availableActions, ['open_outputs'])
        || (
          (status === 'failed' || status === 'cancelled')
          && actionsExactly(availableActions, ['retry_recording', 'open_outputs'])
        )
      : actionsExactly(availableActions, ['cancel', 'open_outputs']);
    if (!actionSetIsCurrent) return invalid();
  }
  if (
    kind === 'export'
    && (
      typeof value.subtype !== 'string'
      || value.stage !== null
      || value.completed_units !== null
      || value.total_units !== null
      || value.unit !== null
    )
  ) return invalid();
  if (
    kind === 'export'
    && !actionsExactly(
      availableActions,
      terminal ? ['open_outputs'] : ['cancel', 'open_outputs'],
    )
  ) return invalid();
  if (kind === 'download') {
    const expectedProgress = typeof value.total_units === 'number' && value.total_units > 0
      ? Number(
        (BigInt(Math.min(value.completed_units as number, value.total_units)) * 100n
          + BigInt(value.total_units) / 2n)
        / BigInt(value.total_units),
      )
      : null;
    if (
      value.subtype !== null
      || value.stage !== null
      || typeof value.completed_units !== 'number'
      || value.unit !== 'bytes'
      || value.progress_percent !== expectedProgress
    ) return invalid();
    const actionSetIsCurrent = terminal
      ? actionsExactly(availableActions, ['open_match_history'])
        || (
          (status === 'failed' || status === 'cancelled')
          && actionsExactly(availableActions, ['retry_download', 'open_match_history'])
        )
      : actionsExactly(availableActions, ['cancel', 'open_match_history']);
    if (!actionSetIsCurrent) return invalid();
  }
  if (kind === 'analysis') {
    const expectedStatus = value.stage === 'validating_input' || value.stage === 'parser_queued'
      ? 'queued'
      : value.stage === 'parser_running'
        || value.stage === 'verifying_input_after_parse'
        || value.stage === 'projecting'
        ? 'running'
        : value.stage === 'completed'
          ? 'completed'
          : value.stage === 'cancelled'
            ? 'cancelled'
            : 'failed';
    if (
      value.subtype !== null
      || typeof value.stage !== 'string'
      || !analysisStages.has(value.stage)
      || value.status !== expectedStatus
      || value.progress_percent !== null
      || value.completed_units !== null
      || value.total_units !== null
      || value.unit !== null
      || (status === 'cancelled' && value.error !== null)
    ) return invalid();
    const actionSetIsCurrent = status === 'completed'
      ? actionsExactly(availableActions, ['open_analysis', 'open_library'])
        || actionsExactly(availableActions, ['open_library'])
      : status === 'failed'
        ? actionsExactly(availableActions, ['retry_analysis', 'open_library'])
          || actionsExactly(availableActions, ['open_library'])
        : status === 'cancelled'
          ? actionsExactly(availableActions, ['retry_analysis', 'open_library'])
            || actionsExactly(availableActions, ['open_library'])
          : actionsExactly(availableActions, ['cancel', 'open_library']);
    if (!actionSetIsCurrent) return invalid();
  }
  return value as ActivityItem;
}

export function parseActivityFeed(value: unknown): ActivityFeed {
  if (!recordWithExactKeys(value, feedKeys) || !Array.isArray(value.items)) return invalid();
  if (
    !Number.isSafeInteger(value.total)
    || Number(value.total) < 0
    || !Number.isSafeInteger(value.page)
    || Number(value.page) < 1
    || !Number.isSafeInteger(value.page_size)
    || Number(value.page_size) < 1
    || Number(value.page_size) > 100
    || !recordWithExactKeys(value.summary, summaryKeys)
  ) return invalid();
  const summary = value.summary;
  if (summaryKeys.some((key) => !Number.isSafeInteger(summary[key]) || Number(summary[key]) < 0)) {
    return invalid();
  }
  const items = value.items.map(parseActivityItem);
  const summaryTotal = Number(summary.total);
  if (
    items.length > Number(value.page_size)
    || items.length > Number(value.total)
    || new Set(items.map((item) => item.id)).size !== items.length
    || Number(value.total) > summaryTotal
    || Number(summary.active) + Number(summary.failed) + Number(summary.completed)
      + Number(summary.cancelled) !== summaryTotal
  ) return invalid();
  return {
    items,
    total: Number(value.total),
    page: Number(value.page),
    page_size: Number(value.page_size),
    summary: summary as ActivityFeed['summary'],
  };
}
