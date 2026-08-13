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

export function evidenceSearchQueryFromParameters(parameters: URLSearchParams): EvidenceSearchQuery {
  const query: EvidenceSearchQuery = {};
  const boundedText = (key: string) => {
    const value = parameters.get(key)?.trim() ?? '';
    return value ? value.slice(0, 128) : undefined;
  };
  const q = boundedText('q');
  if (q) query.q = q;
  const eventFamily = parameters.get('event_family');
  if (eventFamily && eventFamilies.has(eventFamily as EvidenceSearchEventFamily)) {
    query.event_family = eventFamily as EvidenceSearchEventFamily;
  }
  for (const key of ['actor', 'victim', 'weapon', 'map', 'source', 'match_date_from', 'match_date_to', 'demo_id'] as const) {
    const value = boundedText(key);
    if (value) query[key] = value;
  }
  const sourceKind = parameters.get('source_kind');
  if (sourceKind === 'event' || sourceKind === 'highlight') query.source_kind = sourceKind;
  const headshot = parameters.get('headshot');
  if (headshot === 'true' || headshot === 'false') query.headshot = headshot === 'true';
  const boundedInteger = (key: string, minimum: number, maximum: number) => {
    const raw = parameters.get(key)?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : undefined;
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
): string {
  const parameters = new URLSearchParams({
    demo: item.demo_id,
    tab,
    round: String(item.round),
    tick: String(item.tick),
    evidence: item.evidence_id,
  });
  if (item.actor_id) parameters.set('player', item.actor_id);
  return `/analysis?${parameters.toString()}`;
}

export type VisibleEvidenceAttribute = 'headshot' | 'penetrated';

export function visibleEvidenceAttributes(item: EvidenceSearchItem): VisibleEvidenceAttribute[] {
  return [
    item.headshot ? 'headshot' : null,
    item.penetrated ? 'penetrated' : null,
  ].filter((value): value is VisibleEvidenceAttribute => value !== null);
}
