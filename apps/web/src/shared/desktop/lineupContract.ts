import type {
  LineupDirectoryItem, LineupDirectoryPage, LineupMapItem, LineupMapPage,
  LineupProjectionCoverage,
} from './dto';
import { isCanonicalSteamId } from './playerContract';

const hex64 = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalid(): never { throw new Error('Local lineup response does not match the current contract.'); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function date(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function lineupId(value: unknown): value is string { return typeof value === 'string' && hex64.test(value); }
function members(value: unknown): value is [string, string, string, string, string] {
  return Array.isArray(value) && value.length === 5 && value.every(isCanonicalSteamId) && new Set(value).size === 5
    && [...value].sort().every((member, index) => member === value[index]);
}
function coverage(value: unknown): LineupProjectionCoverage {
  if (!exact(value, ['evaluated_demos', 'verified_demos', 'total_analyses', 'projection_complete'])
    || !count(value.evaluated_demos) || !count(value.verified_demos) || !count(value.total_analyses)
    || typeof value.projection_complete !== 'boolean' || value.verified_demos > value.evaluated_demos
    || value.evaluated_demos > value.total_analyses
    || value.projection_complete !== (value.evaluated_demos === value.total_analyses)) invalid();
  return value as LineupProjectionCoverage;
}
function item(value: unknown): LineupDirectoryItem {
  if (!exact(value, ['lineup_id', 'members', 'maps', 'wins', 'losses', 'ties', 'rounds_for', 'rounds_against'])
    || !lineupId(value.lineup_id) || !members(value.members)
    || !count(value.maps) || !count(value.wins) || !count(value.losses) || !count(value.ties)
    || !count(value.rounds_for) || !count(value.rounds_against)
    || value.maps !== value.wins + value.losses + value.ties) invalid();
  return value as unknown as LineupDirectoryItem;
}
function mapItem(value: unknown): LineupMapItem {
  if (!exact(value, ['demo_id', 'map_name', 'match_date', 'cataloged_at', 'opponent_lineup_id', 'team_slot', 'rounds_for', 'rounds_against'])
    || typeof value.demo_id !== 'string' || !uuid.test(value.demo_id)
    || !(value.map_name === null || typeof value.map_name === 'string')
    || !(value.match_date === null || date(value.match_date)) || !date(value.cataloged_at)
    || !lineupId(value.opponent_lineup_id) || (value.team_slot !== 'A' && value.team_slot !== 'B')
    || !count(value.rounds_for) || !count(value.rounds_against)) invalid();
  return value as unknown as LineupMapItem;
}
export function parseLineupDirectoryPage(value: unknown): LineupDirectoryPage {
  if (!exact(value, ['items', 'total', 'page', 'page_size', 'coverage']) || !Array.isArray(value.items)
    || !count(value.total) || !count(value.page) || !count(value.page_size) || value.page < 1 || value.page_size < 1) invalid();
  return { items: value.items.map(item), total: value.total, page: value.page, page_size: value.page_size, coverage: coverage(value.coverage) };
}
export function parseLineupMapPage(value: unknown, expectedLineupId: string): LineupMapPage {
  if (!exact(value, ['lineup_id', 'members', 'items', 'total', 'page', 'page_size', 'coverage'])
    || value.lineup_id !== expectedLineupId || !members(value.members) || !Array.isArray(value.items)
    || !count(value.total) || !count(value.page) || !count(value.page_size) || value.page < 1 || value.page_size < 1) invalid();
  return { lineup_id: value.lineup_id, members: value.members, items: value.items.map(mapItem), total: value.total,
    page: value.page, page_size: value.page_size, coverage: coverage(value.coverage) };
}
