import type { DemoMatchSource, DemoMetadata, ReviewTag } from './dto';
import { parseReviewTag, parseReviewTagCatalog } from './reviewMetadataContract';

const sources = new Set<DemoMatchSource>([
  'challengermode', 'ebot', 'esl', 'esplay', 'esportal', 'esportligaen', 'faceit',
  'fastcup', 'five_eplay', 'matchzy', 'perfect_world', 'pracc', 'renown', 'valve',
]);

function invalid(): never {
  throw new Error('Demo metadata response does not match the current contract.');
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function date(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

export function parseDemoTagCatalog(value: unknown): ReviewTag[] {
  return parseReviewTagCatalog(value);
}

export function parseDemoMetadata(value: unknown, expectedDemoId: string): DemoMetadata {
  if (!exact(value, ['demo_id', 'match_source', 'comment', 'tags', 'updated_at'])
    || value.demo_id !== expectedDemoId
    || !(value.match_source === null
      || (typeof value.match_source === 'string' && sources.has(value.match_source as DemoMatchSource)))
    || typeof value.comment !== 'string' || [...value.comment].length > 4_000 || value.comment.includes('\0')
    || !Array.isArray(value.tags) || value.tags.length > 32
    || !date(value.updated_at)) invalid();
  const tags = value.tags.map(parseReviewTag);
  if (new Set(tags.map((tag) => tag.id)).size !== tags.length) invalid();
  return { ...value, tags } as DemoMetadata;
}

export function parseDemoMetadataBatch(value: unknown, expectedDemoIds: readonly string[]): DemoMetadata[] {
  if (!Array.isArray(value) || value.length !== expectedDemoIds.length) invalid();
  return value.map((item, index) => parseDemoMetadata(item, expectedDemoIds[index] ?? ''));
}
