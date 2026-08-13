import type { EvidenceAnnotation, EvidenceAnnotationQuery } from '../../shared/desktop/dto';

export type EvidenceAnnotationIndexParameterResult = {
  status: 'ready';
  query: EvidenceAnnotationQuery;
} | {
  status: 'invalid';
  error: string;
};

const annotationIndexKeys = new Set(['view', 'q', 'tag', 'state', 'page', 'page_size']);

function invalid(error: string): EvidenceAnnotationIndexParameterResult {
  return { status: 'invalid', error };
}

function exactOptionalText(
  parameters: URLSearchParams,
  key: 'q' | 'tag',
  maximum: number,
): string | EvidenceAnnotationIndexParameterResult | undefined {
  const values = parameters.getAll(key);
  if (values.length === 0) return undefined;
  const [rawValue] = values;
  if (values.length !== 1 || rawValue === undefined) {
    return invalid(`Parameter "${key}" must appear exactly once.`);
  }
  const value = rawValue.trim();
  if (value.length === 0 || Array.from(value).length > maximum) {
    return invalid(`Parameter "${key}" must contain 1 to ${maximum} characters.`);
  }
  return value;
}

function exactOptionalInteger(
  parameters: URLSearchParams,
  key: 'page' | 'page_size',
  maximum: number,
): number | EvidenceAnnotationIndexParameterResult | undefined {
  const values = parameters.getAll(key);
  if (values.length === 0) return undefined;
  const [rawValue] = values;
  if (values.length !== 1 || rawValue === undefined) {
    return invalid(`Parameter "${key}" must appear exactly once.`);
  }
  if (!/^[1-9]\d*$/.test(rawValue)) {
    return invalid(`Parameter "${key}" must be a positive integer.`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value > maximum) {
    return invalid(`Parameter "${key}" must not exceed ${maximum}.`);
  }
  return value;
}

export function readEvidenceAnnotationIndexParameters(
  parameters: URLSearchParams,
): EvidenceAnnotationIndexParameterResult {
  for (const key of parameters.keys()) {
    if (!annotationIndexKeys.has(key)) return invalid(`Unknown annotation index parameter "${key}".`);
  }
  const views = parameters.getAll('view');
  const [view] = views;
  if (views.length !== 1 || view !== 'annotations') {
    return invalid('Parameter "view" must be exactly "annotations".');
  }

  const query: EvidenceAnnotationQuery = {};
  const q = exactOptionalText(parameters, 'q', 256);
  const tag = exactOptionalText(parameters, 'tag', 64);
  const page = exactOptionalInteger(parameters, 'page', 100_000);
  const pageSize = exactOptionalInteger(parameters, 'page_size', 100);
  for (const value of [q, tag, page, pageSize]) {
    if (typeof value === 'object') return value;
  }

  if (typeof q === 'string') query.q = q;
  if (typeof tag === 'string') query.tag = tag;
  if (typeof page === 'number') query.page = page;
  if (typeof pageSize === 'number') query.page_size = pageSize;

  const states = parameters.getAll('state');
  if (states.length > 1) return invalid('Parameter "state" must appear at most once.');
  const [annotationState] = states;
  if (annotationState !== undefined) {
    if (annotationState !== 'open' && annotationState !== 'resolved') {
      return invalid('Parameter "state" must be "open" or "resolved".');
    }
    query.state = annotationState;
  }

  return { status: 'ready', query };
}

export function evidenceAnnotationIndexParameters(
  query: EvidenceAnnotationQuery,
): URLSearchParams {
  const parameters = new URLSearchParams({ view: 'annotations' });
  const appendText = (key: 'q' | 'tag', value: string | undefined) => {
    const normalized = value?.trim();
    if (normalized) parameters.set(key, normalized);
  };
  appendText('q', query.q);
  appendText('tag', query.tag);
  if (query.state !== undefined) parameters.set('state', query.state);
  if (query.page !== undefined) parameters.set('page', String(query.page));
  if (query.page_size !== undefined) parameters.set('page_size', String(query.page_size));
  return parameters;
}

export function evidenceAnnotationAnalysisHref(
  annotation: EvidenceAnnotation,
  tab: 'rounds' | 'replay',
): string {
  return `/analysis?${new URLSearchParams({
    demo: annotation.demo_id,
    tab,
    round: String(annotation.round),
    tick: String(annotation.tick),
    evidence: annotation.evidence_id,
  }).toString()}`;
}
