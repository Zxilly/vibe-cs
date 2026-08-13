import type {
  EvidenceSearchEventFamily,
  EvidenceSearchItem,
  EvidenceSearchQuery,
} from '../../shared/desktop/dto';

const eventFamilies = new Set<EvidenceSearchEventFamily>([
  'kill',
  'multi_kill',
  'objective',
  'round_start',
]);

const queryKeys = new Set([
  'q', 'event_family', 'actor', 'victim', 'player', 'weapon', 'map', 'source',
  'headshot', 'round', 'match_date_from', 'match_date_to', 'source_kind', 'demo_id',
  'page', 'page_size',
]);

function hasExactRfc3339(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && !Number.isNaN(Date.parse(value));
}

export function evidenceSearchQueryFromParameters(parameters: URLSearchParams): EvidenceSearchQuery {
  for (const key of new Set(parameters.keys())) {
    if (!queryKeys.has(key)) throw new Error(`Unknown evidence search parameter: ${key}`);
    if (parameters.getAll(key).length !== 1) throw new Error(`Duplicate evidence search parameter: ${key}`);
  }
  const query: EvidenceSearchQuery = {};
  const boundedText = (key: string) => {
    if (!parameters.has(key)) return undefined;
    const value = parameters.get(key)?.trim() ?? '';
    const length = [...value].length;
    if (length < 1 || length > 128) throw new Error(`Invalid evidence search parameter: ${key}`);
    return value;
  };
  const q = boundedText('q');
  if (q) query.q = q;
  const eventFamily = parameters.get('event_family');
  if (eventFamily !== null) {
    if (!eventFamilies.has(eventFamily as EvidenceSearchEventFamily)) throw new Error('Invalid evidence event family');
    query.event_family = eventFamily as EvidenceSearchEventFamily;
  }
  for (const key of ['actor', 'victim', 'player', 'weapon', 'map', 'source', 'match_date_from', 'match_date_to', 'demo_id'] as const) {
    const value = boundedText(key);
    if (value) query[key] = value;
  }
  for (const key of ['match_date_from', 'match_date_to'] as const) {
    const value = query[key];
    if (value && !hasExactRfc3339(value)) throw new Error(`Invalid evidence search parameter: ${key}`);
  }
  const sourceKind = parameters.get('source_kind');
  if (sourceKind !== null) {
    if (sourceKind !== 'event' && sourceKind !== 'highlight') throw new Error('Invalid evidence source kind');
    query.source_kind = sourceKind;
  }
  const headshot = parameters.get('headshot');
  if (headshot !== null) {
    if (headshot !== 'true' && headshot !== 'false') throw new Error('Invalid evidence headshot filter');
    query.headshot = headshot === 'true';
  }
  const boundedInteger = (key: string, minimum: number, maximum: number) => {
    if (!parameters.has(key)) return undefined;
    const raw = parameters.get(key)?.trim() ?? '';
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`Invalid evidence search parameter: ${key}`);
    }
    return value;
  };
  const round = boundedInteger('round', 1, 256);
  if (round !== undefined) query.round = round;
  const page = boundedInteger('page', 1, 100_000);
  if (page !== undefined) query.page = page;
  const pageSize = boundedInteger('page_size', 1, 100);
  if (pageSize !== undefined) query.page_size = pageSize;
  return query;
}

export function evidenceSearchParameters(query: EvidenceSearchQuery): URLSearchParams {
  const parameters = new URLSearchParams();
  const append = (key: keyof EvidenceSearchQuery, value: unknown) => {
    if (typeof value === 'string') {
      const normalized = value.trim();
      if (normalized) parameters.set(key, normalized);
      return;
    }
    if (value !== undefined) parameters.set(key, String(value));
  };
  append('q', query.q);
  append('event_family', query.event_family);
  append('actor', query.actor);
  append('victim', query.victim);
  append('player', query.player);
  append('weapon', query.weapon);
  append('map', query.map);
  append('source', query.source);
  append('headshot', query.headshot);
  append('round', query.round);
  append('match_date_from', query.match_date_from);
  append('match_date_to', query.match_date_to);
  append('source_kind', query.source_kind);
  append('demo_id', query.demo_id);
  append('page', query.page);
  append('page_size', query.page_size);
  return parameters;
}

export function evidenceSearchResultHref(
  item: EvidenceSearchItem,
  tab: 'rounds' | 'replay',
  focusedPlayerId = item.actor_id,
): string {
  const parameters = new URLSearchParams({
    demo: item.demo_id,
    tab,
    round: String(item.round),
    tick: String(item.tick),
    evidence: item.evidence_id,
  });
  if (focusedPlayerId) parameters.set('player', focusedPlayerId);
  return `/analysis?${parameters.toString()}`;
}

export type VisibleEvidenceAttribute = 'headshot' | 'penetrated';

export function visibleEvidenceAttributes(item: EvidenceSearchItem): VisibleEvidenceAttribute[] {
  return [
    item.headshot ? 'headshot' : null,
    item.penetrated ? 'penetrated' : null,
  ].filter((value): value is VisibleEvidenceAttribute => value !== null);
}
