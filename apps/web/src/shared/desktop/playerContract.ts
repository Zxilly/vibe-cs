import type {
  PlayerAggregateStats,
  PlayerComparison,
  PlayerDirectoryItem,
  PlayerDirectoryPage,
  PlayerMatch,
  PlayerMapItem,
  PlayerMapPage,
  PlayerMatchPage,
  PlayerProfile,
  PlayerProjectionCoverage,
  PlayerSteamProfile,
} from './dto';

const pageKeys = ['items', 'total', 'page', 'page_size', 'coverage'] as const;
const matchPageKeys = ['steam_id', ...pageKeys] as const;
const mapPageKeys = ['steam_id', ...pageKeys] as const;
const mapItemKeys = ['map_name', 'stats'] as const;
const matchKeys = [
  'demo_id', 'demo_name', 'map_name', 'match_date', 'cataloged_at', 'team',
  'kills', 'deaths', 'assists', 'headshots', 'damage', 'adr', 'kill_death_ratio',
] as const;
const coverageKeys = ['projected_demos', 'total_analyses', 'projection_complete'] as const;
const directoryItemKeys = [
  'steam_id', 'name', 'aliases', 'aliases_total', 'last_team', 'last_match_date', 'last_cataloged_at',
  'stats', 'steam',
] as const;
const statsKeys = [
  'matches', 'kills', 'deaths', 'assists', 'headshots', 'damage',
  'average_adr', 'average_kill_death_ratio',
] as const;
const steamKeys = [
  'state', 'persona_name', 'real_name', 'profile_url', 'country_code', 'persona_state',
  'last_logoff', 'created_at', 'avatar_url', 'reason',
] as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const steamIdPattern = /^[0-9]{17}$/;
const dateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const profileKeys = ['player', 'coverage'] as const;
const comparisonKeys = ['players', 'coverage'] as const;
const maximumPage = 10_000;

function invalid(): never {
  throw new Error('Player response does not match the current contract.');
}

export function isCanonicalSteamId(value: unknown): value is string {
  if (typeof value !== 'string' || !steamIdPattern.test(value)) return false;
  const steamId = BigInt(value);
  const universe = (steamId >> 56n) & 0xffn;
  const accountType = (steamId >> 52n) & 0x0fn;
  const instance = (steamId >> 32n) & 0x000f_ffffn;
  const accountId = steamId & 0xffff_ffffn;
  return universe === 1n && accountType === 1n && instance === 1n && accountId !== 0n;
}

function recordWithExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function boundedText(value: unknown, maximumCharacters: number): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && Array.from(value).length <= maximumCharacters
    && !/[\r\n\0]/u.test(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nullableNonnegativeFiniteNumber(value: unknown): value is number | null {
  return value === null || (
    typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
  );
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function dateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = dateTimePattern.exec(value);
  if (match === null || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  return month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth(year, month)
    && hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 23
    && offsetMinute <= 59;
}

function nullableDateTime(value: unknown): value is string | null {
  return value === null || dateTime(value);
}

function parseCoverage(value: unknown): PlayerProjectionCoverage {
  if (
    !recordWithExactKeys(value, coverageKeys)
    || !nonnegativeInteger(value.projected_demos)
    || !nonnegativeInteger(value.total_analyses)
    || typeof value.projection_complete !== 'boolean'
    || Number(value.projected_demos) > Number(value.total_analyses)
    || value.projection_complete !== (value.projected_demos === value.total_analyses)
  ) return invalid();
  return value as PlayerProjectionCoverage;
}

function parseMatch(value: unknown): PlayerMatch {
  if (
    !recordWithExactKeys(value, matchKeys)
    || typeof value.demo_id !== 'string'
    || !uuidPattern.test(value.demo_id)
    || typeof value.demo_name !== 'string'
    || !nullableString(value.map_name)
    || !(value.match_date === null || dateTime(value.match_date))
    || !dateTime(value.cataloged_at)
    || !nullableString(value.team)
    || !nonnegativeInteger(value.kills)
    || !nonnegativeInteger(value.deaths)
    || !nonnegativeInteger(value.assists)
    || !nonnegativeInteger(value.headshots)
    || !nonnegativeInteger(value.damage)
    || !nullableNonnegativeFiniteNumber(value.adr)
    || !nullableNonnegativeFiniteNumber(value.kill_death_ratio)
  ) return invalid();
  return value as PlayerMatch;
}

function parseAggregateStats(value: unknown): PlayerAggregateStats {
  if (
    !recordWithExactKeys(value, statsKeys)
    || !nonnegativeInteger(value.matches)
    || !nonnegativeInteger(value.kills)
    || !nonnegativeInteger(value.deaths)
    || !nonnegativeInteger(value.assists)
    || !nonnegativeInteger(value.headshots)
    || !nonnegativeInteger(value.damage)
    || !nullableNonnegativeFiniteNumber(value.average_adr)
    || !nullableNonnegativeFiniteNumber(value.average_kill_death_ratio)
  ) return invalid();
  return value as PlayerAggregateStats;
}

function parseMapItem(value: unknown): PlayerMapItem {
  if (
    !recordWithExactKeys(value, mapItemKeys)
    || !(value.map_name === null || boundedText(value.map_name, 128))
  ) return invalid();
  return {
    map_name: value.map_name,
    stats: parseAggregateStats(value.stats),
  };
}

function parseSteam(value: unknown): PlayerSteamProfile {
  if (
    !recordWithExactKeys(value, steamKeys)
    || !(value.state === 'available' || value.state === 'not_configured' || value.state === 'unavailable')
    || !nullableString(value.persona_name)
    || !nullableString(value.real_name)
    || !nullableString(value.profile_url)
    || !nullableString(value.country_code)
    || !(value.persona_state === null || (
      nonnegativeInteger(value.persona_state)
      && Number(value.persona_state) <= 255
    ))
    || !nullableDateTime(value.last_logoff)
    || !nullableDateTime(value.created_at)
    || !nullableString(value.avatar_url)
    || !nullableString(value.reason)
  ) return invalid();
  const profileFields = [
    value.persona_name,
    value.real_name,
    value.profile_url,
    value.country_code,
    value.persona_state,
    value.last_logoff,
    value.created_at,
    value.avatar_url,
  ];
  if (value.state === 'available') {
    if (
      typeof value.persona_name !== 'string'
      || value.persona_name.trim().length === 0
      || value.reason !== null
    ) return invalid();
  } else if (
    profileFields.some((field) => field !== null)
    || typeof value.reason !== 'string'
    || value.reason.trim().length === 0
  ) return invalid();
  return value as PlayerSteamProfile;
}

function parseDirectoryItem(value: unknown): PlayerDirectoryItem {
  if (
    !recordWithExactKeys(value, directoryItemKeys)
    || !isCanonicalSteamId(value.steam_id)
    || !boundedText(value.name, 128)
    || !Array.isArray(value.aliases)
    || value.aliases.some((alias) => !boundedText(alias, 128))
    || value.aliases.length > 32
    || new Set(value.aliases).size !== value.aliases.length
    || value.aliases.includes(value.name)
    || !nonnegativeInteger(value.aliases_total)
    || Number(value.aliases_total) < value.aliases.length
    || (Number(value.aliases_total) === 0) !== (value.aliases.length === 0)
    || !nullableString(value.last_team)
    || !nullableDateTime(value.last_match_date)
    || !dateTime(value.last_cataloged_at)
    || !recordWithExactKeys(value.stats, statsKeys)
  ) return invalid();
  const stats = value.stats;
  if (
    !nonnegativeInteger(stats.matches)
    || !nonnegativeInteger(stats.kills)
    || !nonnegativeInteger(stats.deaths)
    || !nonnegativeInteger(stats.assists)
    || !nonnegativeInteger(stats.headshots)
    || !nonnegativeInteger(stats.damage)
    || !nullableNonnegativeFiniteNumber(stats.average_adr)
    || !nullableNonnegativeFiniteNumber(stats.average_kill_death_ratio)
  ) return invalid();
  parseSteam(value.steam);
  return value as PlayerDirectoryItem;
}

export function parsePlayerDirectoryPage(value: unknown): PlayerDirectoryPage {
  if (
    !recordWithExactKeys(value, pageKeys)
    || !Array.isArray(value.items)
    || !nonnegativeInteger(value.total)
    || !nonnegativeInteger(value.page)
    || Number(value.page) < 1
    || Number(value.page) > maximumPage
    || !nonnegativeInteger(value.page_size)
    || Number(value.page_size) < 1
    || Number(value.page_size) > 100
  ) return invalid();
  const items = value.items.map(parseDirectoryItem);
  if (
    items.length > Number(value.page_size)
    || items.length > Number(value.total)
    || new Set(items.map((item) => item.steam_id)).size !== items.length
  ) return invalid();
  return {
    items,
    total: Number(value.total),
    page: Number(value.page),
    page_size: Number(value.page_size),
    coverage: parseCoverage(value.coverage),
  };
}

export function parsePlayerProfile(value: unknown): PlayerProfile {
  if (!recordWithExactKeys(value, profileKeys)) return invalid();
  return {
    player: parseDirectoryItem(value.player),
    coverage: parseCoverage(value.coverage),
  };
}

export function parsePlayerComparison(value: unknown): PlayerComparison {
  if (!recordWithExactKeys(value, comparisonKeys) || !Array.isArray(value.players)) return invalid();
  const [left, right, ...remainder] = value.players;
  if (left === undefined || right === undefined || remainder.length > 0) return invalid();
  const parsedLeft = parseDirectoryItem(left);
  const parsedRight = parseDirectoryItem(right);
  if (parsedLeft.steam_id === parsedRight.steam_id) return invalid();
  return {
    players: [parsedLeft, parsedRight],
    coverage: parseCoverage(value.coverage),
  };
}

export function parsePlayerMatchPage(value: unknown): PlayerMatchPage {
  if (
    !recordWithExactKeys(value, matchPageKeys)
    || !isCanonicalSteamId(value.steam_id)
    || !Array.isArray(value.items)
    || !nonnegativeInteger(value.total)
    || !nonnegativeInteger(value.page)
    || Number(value.page) < 1
    || Number(value.page) > maximumPage
    || !nonnegativeInteger(value.page_size)
    || Number(value.page_size) < 1
    || Number(value.page_size) > 100
  ) return invalid();
  const items = value.items.map(parseMatch);
  if (
    items.length > Number(value.page_size)
    || items.length > Number(value.total)
    || new Set(items.map((item) => item.demo_id)).size !== items.length
  ) return invalid();
  return {
    steam_id: value.steam_id,
    items,
    total: Number(value.total),
    page: Number(value.page),
    page_size: Number(value.page_size),
    coverage: parseCoverage(value.coverage),
  };
}

export function parsePlayerMapPage(value: unknown): PlayerMapPage {
  if (
    !recordWithExactKeys(value, mapPageKeys)
    || !isCanonicalSteamId(value.steam_id)
    || !Array.isArray(value.items)
    || !nonnegativeInteger(value.total)
    || !nonnegativeInteger(value.page)
    || Number(value.page) < 1
    || Number(value.page) > maximumPage
    || !nonnegativeInteger(value.page_size)
    || Number(value.page_size) < 1
    || Number(value.page_size) > 100
  ) return invalid();
  const items = value.items.map(parseMapItem);
  if (
    items.length > Number(value.page_size)
    || items.length > Number(value.total)
    || new Set(items.map((item) => item.map_name)).size !== items.length
  ) return invalid();
  return {
    steam_id: value.steam_id,
    items,
    total: Number(value.total),
    page: Number(value.page),
    page_size: Number(value.page_size),
    coverage: parseCoverage(value.coverage),
  };
}
