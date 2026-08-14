import type {
  PlayerReviewMetadata,
  ReviewTag,
  RoundReviewMetadata,
} from './dto';
import { isCanonicalSteamId } from './playerContract';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const color = /^#[0-9a-f]{6}$/;
const sha256 = /^[0-9a-f]{64}$/;

function invalid(): never {
  throw new Error('Review metadata response does not match the current contract.');
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function date(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const instant = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
  const calendarValid = instant.getUTCFullYear() === year
    && instant.getUTCMonth() === month! - 1
    && instant.getUTCDate() === day
    && instant.getUTCHours() === hour
    && instant.getUTCMinutes() === minute
    && instant.getUTCSeconds() === second;
  const offsetValid = match[7] === 'Z'
    || (Number(match[8]) <= 23 && Number(match[9]) <= 59);
  return calendarValid && offsetValid && Number.isFinite(Date.parse(value));
}

function comment(value: unknown): value is string {
  return typeof value === 'string' && [...value].length <= 4_000 && !value.includes('\0');
}

export function parseReviewTag(value: unknown): ReviewTag {
  if (!exact(value, ['id', 'name', 'color', 'created_at', 'updated_at'])
    || typeof value.id !== 'string' || !uuid.test(value.id)
    || typeof value.name !== 'string' || value.name.trim() !== value.name
    || [...value.name].length < 1 || [...value.name].length > 64
    || [...value.name].some((character) => /[\p{Cc}\p{Cf}]/u.test(character))
    || typeof value.color !== 'string' || !color.test(value.color)
    || !date(value.created_at) || !date(value.updated_at)) invalid();
  return value as unknown as ReviewTag;
}

export function parseReviewTagCatalog(value: unknown): ReviewTag[] {
  if (!Array.isArray(value) || value.length > 256) invalid();
  const tags = value.map(parseReviewTag);
  if (new Set(tags.map((tag) => tag.id)).size !== tags.length
    || new Set(tags.map((tag) => tag.name.toLocaleLowerCase())).size !== tags.length) invalid();
  return tags;
}

function parseAssignedTags(value: unknown): ReviewTag[] {
  if (!Array.isArray(value) || value.length > 32) invalid();
  const tags = value.map(parseReviewTag);
  if (new Set(tags.map((tag) => tag.id)).size !== tags.length) invalid();
  return tags;
}

export function parsePlayerReviewMetadata(
  value: unknown,
  expectedSteamId: string,
): PlayerReviewMetadata {
  if (!exact(value, ['steam_id', 'comment', 'tags', 'updated_at'])
    || !isCanonicalSteamId(expectedSteamId)
    || value.steam_id !== expectedSteamId
    || !comment(value.comment)
    || !date(value.updated_at)) invalid();
  return { ...value, tags: parseAssignedTags(value.tags) } as PlayerReviewMetadata;
}

export function parseRoundReviewMetadata(
  value: unknown,
  expectedDemoId: string,
  expectedRound: number,
): RoundReviewMetadata {
  if (!exact(value, ['demo_id', 'source_sha256', 'round', 'comment', 'tags', 'updated_at'])
    || typeof expectedDemoId !== 'string' || !uuid.test(expectedDemoId)
    || value.demo_id !== expectedDemoId
    || typeof value.source_sha256 !== 'string' || !sha256.test(value.source_sha256)
    || !Number.isSafeInteger(expectedRound) || expectedRound < 1
    || value.round !== expectedRound
    || !comment(value.comment)
    || !date(value.updated_at)) invalid();
  return { ...value, tags: parseAssignedTags(value.tags) } as RoundReviewMetadata;
}
