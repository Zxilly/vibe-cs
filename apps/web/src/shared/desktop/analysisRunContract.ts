import type {
  AnalysisRun,
  AnalysisRunDetail,
  AnalysisRunEvent,
  AnalysisRunEventCode,
  AnalysisRunStage,
  AnalysisRunStatus,
} from './dto';

const runKeys = [
  'id', 'demo_id', 'input_sha256', 'input_size', 'status', 'stage', 'error',
  'created_at', 'updated_at',
] as const;
const eventKeys = ['run_id', 'sequence', 'stage', 'message_code', 'detail', 'created_at'] as const;
const detailKeys = ['run', 'events', 'result_available'] as const;
const statuses = new Set<AnalysisRunStatus>(['queued', 'running', 'completed', 'failed', 'interrupted']);
const stages = new Set<AnalysisRunStage>([
  'validating_input', 'parser_queued', 'parser_running', 'verifying_input_after_parse',
  'projecting', 'completed', 'failed', 'interrupted',
]);
const eventCodes = new Set<AnalysisRunEventCode>([
  'input_validation_started', 'input_verified', 'parser_started',
  'input_revalidation_started', 'projection_started', 'completed', 'failed', 'interrupted',
]);
const maximumEvents = 32;
const maximumDetailCharacters = 2_000;
const sha256Pattern = /^[0-9a-f]{64}$/;
const eventStage: Record<AnalysisRunEventCode, AnalysisRunStage> = {
  input_validation_started: 'validating_input',
  input_verified: 'parser_queued',
  parser_started: 'parser_running',
  input_revalidation_started: 'verifying_input_after_parse',
  projection_started: 'projecting',
  completed: 'completed',
  failed: 'failed',
  interrupted: 'interrupted',
};

function invalid(): never {
  throw new Error('Analysis run response does not match the current contract.');
}

function recordWithExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function nullableString(value: unknown): value is string | null {
  return value === null
    || (typeof value === 'string' && Array.from(value).length <= maximumDetailCharacters);
}

function canFollow(previous: AnalysisRunStage, next: AnalysisRunStage): boolean {
  if (next === 'failed' || next === 'interrupted') {
    return previous !== 'completed' && previous !== 'failed' && previous !== 'interrupted';
  }
  return (
    (previous === 'validating_input' && next === 'parser_queued')
    || (previous === 'parser_queued' && next === 'parser_running')
    || (previous === 'parser_running' && next === 'verifying_input_after_parse')
    || (previous === 'verifying_input_after_parse' && next === 'projecting')
    || (previous === 'projecting' && next === 'completed')
  );
}

function statusForStage(stage: AnalysisRunStage): AnalysisRunStatus {
  if (stage === 'validating_input' || stage === 'parser_queued') return 'queued';
  if (stage === 'parser_running' || stage === 'verifying_input_after_parse' || stage === 'projecting') return 'running';
  return stage;
}

export function parseAnalysisRun(value: unknown): AnalysisRun {
  if (!recordWithExactKeys(value, runKeys)) return invalid();
  const status = value.status;
  const stage = value.stage;
  if (
    typeof value.id !== 'string'
    || typeof value.demo_id !== 'string'
    || !(value.input_sha256 === null || (typeof value.input_sha256 === 'string' && sha256Pattern.test(value.input_sha256)))
    || !(value.input_size === null || (Number.isSafeInteger(value.input_size) && Number(value.input_size) >= 0))
    || typeof status !== 'string'
    || !statuses.has(status as AnalysisRunStatus)
    || typeof stage !== 'string'
    || !stages.has(stage as AnalysisRunStage)
    || statusForStage(stage as AnalysisRunStage) !== status
    || !nullableString(value.error)
    || typeof value.created_at !== 'string'
    || typeof value.updated_at !== 'string'
  ) return invalid();
  const fingerprintBound = value.input_sha256 !== null && value.input_size !== null;
  const expectsFingerprint = [
    'parser_queued', 'parser_running', 'verifying_input_after_parse', 'projecting', 'completed',
  ].includes(stage as AnalysisRunStage);
  const expectsError = status === 'failed' || status === 'interrupted';
  if (
    (value.input_sha256 === null) !== (value.input_size === null)
    || (expectsFingerprint && !fingerprintBound)
    || expectsError !== (typeof value.error === 'string' && value.error.length > 0)
  ) return invalid();
  return value as AnalysisRun;
}

function parseAnalysisRunEvent(value: unknown, runId: string): AnalysisRunEvent {
  if (!recordWithExactKeys(value, eventKeys)) return invalid();
  if (
    value.run_id !== runId
    || !Number.isSafeInteger(value.sequence)
    || Number(value.sequence) < 0
    || typeof value.stage !== 'string'
    || !stages.has(value.stage as AnalysisRunStage)
    || typeof value.message_code !== 'string'
    || !eventCodes.has(value.message_code as AnalysisRunEventCode)
    || eventStage[value.message_code as AnalysisRunEventCode] !== value.stage
    || !nullableString(value.detail)
    || typeof value.created_at !== 'string'
  ) return invalid();
  return value as AnalysisRunEvent;
}

export function parseAnalysisRunDetail(value: unknown): AnalysisRunDetail {
  if (!recordWithExactKeys(value, detailKeys) || !Array.isArray(value.events)) return invalid();
  const run = parseAnalysisRun(value.run);
  if (
    value.events.length < 1
    || value.events.length > maximumEvents
    || typeof value.result_available !== 'boolean'
    || (value.result_available && run.status !== 'completed')
  ) return invalid();
  const events = value.events.map((event) => parseAnalysisRunEvent(event, run.id));
  if (
    events.some((event, index) => event.sequence !== index)
    || events[0]?.message_code !== 'input_validation_started'
    || events.at(-1)?.stage !== run.stage
    || events.slice(1).some((event, index) => !canFollow(events[index]!.stage, event.stage))
  ) return invalid();
  return { run, events, result_available: value.result_available };
}
