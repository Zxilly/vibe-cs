import type { DemoMatchSource, DemoMetadata, DemoTag } from './dto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const color = /^#[0-9a-f]{6}$/;
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

function parseTag(value: unknown): DemoTag {
  if (!exact(value, ['id', 'name', 'color', 'created_at', 'updated_at'])
    || typeof value.id !== 'string' || !uuid.test(value.id)
    || typeof value.name !== 'string' || value.name.trim() !== value.name
    || [...value.name].length < 1 || [...value.name].length > 64
    || [...value.name].some((character) => /[\p{Cc}\p{Cf}]/u.test(character))
    || typeof value.color !== 'string' || !color.test(value.color)
    || !date(value.created_at) || !date(value.updated_at)) invalid();
  return value as unknown as DemoTag;
}

export function parseDemoTagCatalog(value: unknown): DemoTag[] {
  if (!Array.isArray(value) || value.length > 256) invalid();
  const tags = value.map(parseTag);
  if (new Set(tags.map((tag) => tag.id)).size !== tags.length
    || new Set(tags.map((tag) => tag.name.toLocaleLowerCase())).size !== tags.length) invalid();
  return tags;
}

export function parseDemoTag(value: unknown): DemoTag {
  return parseTag(value);
}

export function parseDemoMetadata(value: unknown, expectedDemoId: string): DemoMetadata {
  if (!exact(value, ['demo_id', 'match_source', 'comment', 'tags', 'updated_at'])
    || value.demo_id !== expectedDemoId
    || !(value.match_source === null
      || (typeof value.match_source === 'string' && sources.has(value.match_source as DemoMatchSource)))
    || typeof value.comment !== 'string' || [...value.comment].length > 4_000 || value.comment.includes('\0')
    || !Array.isArray(value.tags) || value.tags.length > 32
    || !date(value.updated_at)) invalid();
  const tags = value.tags.map(parseTag);
  if (new Set(tags.map((tag) => tag.id)).size !== tags.length) invalid();
  return { ...value, tags } as DemoMetadata;
}

export function parseDemoMetadataBatch(value: unknown, expectedDemoIds: readonly string[]): DemoMetadata[] {
  if (!Array.isArray(value) || value.length !== expectedDemoIds.length) invalid();
  return value.map((item, index) => parseDemoMetadata(item, expectedDemoIds[index] ?? ''));
}
