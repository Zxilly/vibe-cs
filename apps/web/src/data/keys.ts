/**
 * data layer — the query key factory (spec §2 directory map, §4.1).
 *
 * Every server read in the app is addressed from here. Nothing else in `src`
 * writes a query key literal, because a key literal spelled twice is a cache
 * that invalidates in one place and not the other — the exact failure §2.1
 * rule 6 ("服务端读写一律经 data/**") exists to prevent.
 *
 * ## The shape
 *
 * A key is `[namespace, …]`. TanStack matches keys by prefix, so the shape is
 * chosen to make the two invalidations the UI actually performs single-liners:
 *
 *   invalidate a whole domain   `{ queryKey: qk.demos.all }`
 *   invalidate a single object  `{ queryKey: qk.demos.detail(id) }`
 *
 * The second only works if everything belonging to one object hangs *below* its
 * detail key, so sub-resources are `[ns, 'detail', id, …]` rather than a sibling
 * namespace. `qk.demos.metadata(id)` is therefore refreshed by invalidating the
 * demo, and `keys.test.ts` pins that with `isKeyPrefixOf`.
 *
 * List keys are `[ns, 'list', query]`. The query object goes in whole: TanStack
 * hashes it with sorted object keys, so `{ page: 1, search: 'a' }` and
 * `{ search: 'a', page: 1 }` are the same cache entry while two different
 * filters never collide. Spreading the fields into positional slots instead
 * would make every new filter a breaking change to the key.
 *
 * ## The `service` namespace is special
 *
 * `app/boundary/ServiceGate` invalidates "everything except the probe" on
 * recovery with the predicate `entry.queryKey[0] !== 'service'` (§4.1
 * 「重连成功后 invalidateQueries 全量刷新」). That predicate is only correct
 * while `service` holds the probe *and nothing else* — anything parked there
 * would silently stop refreshing after a reconnect. So the health probe is the
 * sole inhabitant, and `isServiceProbeKey` is the same predicate written once.
 * Service-adjacent reads that must refresh on recovery (quick check, storage,
 * runtime state) live under `config`.
 *
 * `sessions` and `plans` carry keys but no hooks this round: their models
 * (§4.5) are settled with the backend in phase 3e, and a hook written now would
 * be a guess. The namespaces are reserved so 3e does not have to renumber the
 * cache.
 */

import type {
  ActivityKind,
  ActivityQuery,
  AgentObjectKind,
  AgentPlanQuery,
  AgentSessionQuery,
  DemoQuery,
  EvidenceAnnotationQuery,
  EvidenceSearchQuery,
  OutputQuery,
} from '../shared/desktop/dto';

/* ── parameter shapes that the IPC client declares inline ────────────────── */

/**
 * `commands.listPlayers` types its argument inline, so there is no DTO to
 * import. Field names are copied from that signature verbatim (`page_size`, not
 * `pageSize`) so pages can hand the same object to the hook and the key without
 * a mapping step.
 */
export type PlayerDirectorySort =
  | 'player' | 'team' | 'matches' | 'kd' | 'kills' | 'deaths'
  | 'assists' | 'headshots' | 'adr' | 'damage' | 'last_match';

/**
 * The optional fields are `?: string` rather than `?: string | undefined`
 * deliberately: the workspace compiles with `exactOptionalPropertyTypes`, and
 * `commands.listPlayers` declares them the same way. Omit a filter rather than
 * passing an explicit `undefined` — which is also what keeps the hashed key
 * stable, since `{ search: undefined }` and `{}` are two different cache
 * entries.
 */
export interface PlayerDirectoryQuery {
  search?: string;
  page?: number;
  page_size?: number;
  sort: PlayerDirectorySort;
  direction: 'asc' | 'desc';
}

/** The paging argument `listPlayerMatches` / `listPlayerMaps` require. */
export interface PageQuery {
  page: number;
  page_size: number;
}

/**
 * `getPlayerHeatmap`'s query. `kind` has an `all` value the standalone
 * `PlayerHeatmapKind` DTO does not, so it is spelled out here rather than
 * borrowed and widened.
 */
export interface PlayerHeatmapQuery {
  map: string;
  kind: 'all' | 'kills' | 'deaths';
}

/* ── namespaces ──────────────────────────────────────────────────────────── */

/**
 * The first segment of every key. Declared once so the factory below and the
 * recovery predicate cannot drift apart, and so `keys.test.ts` can enumerate
 * them.
 */
export const QUERY_NAMESPACE = {
  service: 'service',
  demos: 'demos',
  players: 'players',
  evidence: 'evidence',
  tasks: 'tasks',
  outputs: 'outputs',
  config: 'config',
  sessions: 'sessions',
  plans: 'plans',
} as const;

export type QueryNamespace = (typeof QUERY_NAMESPACE)[keyof typeof QUERY_NAMESPACE];

/** The segment that separates "a list of things" from "one thing". */
const LIST = 'list';
const DETAIL = 'detail';

/* ── the factory ─────────────────────────────────────────────────────────── */

export const qk = {
  /** The local-service heartbeat. One key, and nothing else may join it — see
   *  the note on `isServiceProbeKey`. */
  service: {
    all: [QUERY_NAMESPACE.service] as const,
    /** Must stay deep-equal to `app/boundary/serviceHealth`'s
     *  `SERVICE_HEALTH_KEY`; `keys.test.ts` asserts it. */
    health: () => [QUERY_NAMESPACE.service, 'health'] as const,
  },

  /**
   * Demo library. Written by: import / scan / rescan / metadata edit / tag
   * edit / delete → invalidate `qk.demos.all`. A single-demo rename only needs
   * `qk.demos.detail(id)`, but the list shows the display name too, so the
   * library's own mutations invalidate the namespace (see `demos.ts`).
   */
  demos: {
    all: [QUERY_NAMESPACE.demos] as const,
    list: (query: DemoQuery) => [QUERY_NAMESPACE.demos, LIST, query] as const,
    detail: (demoId: string) => [QUERY_NAMESPACE.demos, DETAIL, demoId] as const,
    metadata: (demoId: string) => [QUERY_NAMESPACE.demos, DETAIL, demoId, 'metadata'] as const,
    watch: () => [QUERY_NAMESPACE.demos, 'watch'] as const,
    reviewTags: () => [QUERY_NAMESPACE.demos, 'review-tags'] as const,
  },

  /**
   * Player directory and profile. Written by: analysis completing (new matches
   * land under a player) and review-metadata edits → invalidate
   * `qk.players.detail(steamId)` for a profile edit, `qk.players.all` when a
   * new analysis changes the aggregates the directory sorts on.
   */
  players: {
    all: [QUERY_NAMESPACE.players] as const,
    list: (query: PlayerDirectoryQuery) => [QUERY_NAMESPACE.players, LIST, query] as const,
    detail: (steamId: string) => [QUERY_NAMESPACE.players, DETAIL, steamId] as const,
    matches: (steamId: string, page: PageQuery) =>
      [QUERY_NAMESPACE.players, DETAIL, steamId, 'matches', page] as const,
    maps: (steamId: string, page: PageQuery) =>
      [QUERY_NAMESPACE.players, DETAIL, steamId, 'maps', page] as const,
    heatmap: (steamId: string, query: PlayerHeatmapQuery) =>
      [QUERY_NAMESPACE.players, DETAIL, steamId, 'heatmap', query] as const,
  },

  /**
   * Evidence search and annotations. Written by: annotation create / update /
   * delete → invalidate `qk.evidence.annotationsAll`. The search index itself
   * changes only when an analysis completes, which invalidates
   * `qk.evidence.all`.
   */
  evidence: {
    all: [QUERY_NAMESPACE.evidence] as const,
    search: (query: EvidenceSearchQuery) => [QUERY_NAMESPACE.evidence, 'search', query] as const,
    annotationsAll: [QUERY_NAMESPACE.evidence, 'annotations'] as const,
    annotations: (query: EvidenceAnnotationQuery) =>
      [QUERY_NAMESPACE.evidence, 'annotations', query] as const,
  },

  /**
   * The unified task surface of §4.3 — recording, export, download and analysis
   * all read through the activity feed, with the per-kind job records hanging
   * below the activity item they describe. Written by: starting / cancelling /
   * retrying anything → invalidate `qk.tasks.all`.
   */
  tasks: {
    all: [QUERY_NAMESPACE.tasks] as const,
    feed: (query: ActivityQuery) => [QUERY_NAMESPACE.tasks, 'feed', query] as const,
    /** One activity item, addressed by the `kind:id` locator the feed uses. */
    detail: (kind: ActivityKind, jobId: string) =>
      [QUERY_NAMESPACE.tasks, DETAIL, kind, jobId] as const,
    /** The raw job record behind an activity item; below it, so invalidating
     *  the task refreshes both. */
    recordingJob: (jobId: string) =>
      [QUERY_NAMESPACE.tasks, DETAIL, 'recording', jobId, 'job'] as const,
    exportJob: (jobId: string) =>
      [QUERY_NAMESPACE.tasks, DETAIL, 'export', jobId, 'job'] as const,
    analysisRun: (runId: string) =>
      [QUERY_NAMESPACE.tasks, DETAIL, 'analysis', runId, 'run'] as const,
    /** "Is this demo being analysed right now" — keyed by demo, not by run,
     *  because the caller does not know the run id yet. */
    activeAnalysisRun: (demoId: string) =>
      [QUERY_NAMESPACE.tasks, 'analysis', 'active', demoId] as const,
  },

  /**
   * Delivery outputs. Written by: rename / delete / batch delete / cleanup, and
   * by any export or recording finishing → invalidate `qk.outputs.all`.
   */
  outputs: {
    all: [QUERY_NAMESPACE.outputs] as const,
    list: (query: OutputQuery) => [QUERY_NAMESPACE.outputs, LIST, query] as const,
    recordedClips: () => [QUERY_NAMESPACE.outputs, 'recorded-clips'] as const,
  },

  /**
   * Application configuration and the environment probes that depend on it.
   * They share a namespace because they share a cause: writing the config can
   * change the CS2 path (quick check), the data directory (storage) and the
   * HLAE install (hlae status) at once. `config.ts` invalidates the namespace
   * rather than listing them.
   */
  config: {
    all: [QUERY_NAMESPACE.config] as const,
    app: () => [QUERY_NAMESPACE.config, 'app'] as const,
    quickCheck: () => [QUERY_NAMESPACE.config, 'quick-check'] as const,
    storage: () => [QUERY_NAMESPACE.config, 'storage'] as const,
    hlae: () => [QUERY_NAMESPACE.config, 'hlae'] as const,
    recovery: () => [QUERY_NAMESPACE.config, 'recovery'] as const,
    runtime: () => [QUERY_NAMESPACE.config, 'runtime'] as const,
  },

  /** Reserved for phase 3e (§4.5). No hooks yet — the model is not settled. */
  sessions: {
    all: [QUERY_NAMESPACE.sessions] as const,
    list: (query: AgentSessionQuery) => [QUERY_NAMESPACE.sessions, LIST, query] as const,
    detail: (sessionId: string) => [QUERY_NAMESPACE.sessions, DETAIL, sessionId] as const,
    /** The reverse index: which sessions touched this object (§4.5.1). */
    ofObject: (kind: AgentObjectKind, objectId: string) =>
      [QUERY_NAMESPACE.sessions, 'of-object', kind, objectId] as const,
    workspaceReferences: () => [QUERY_NAMESPACE.sessions, 'referencable'] as const,
    settings: () => [QUERY_NAMESPACE.sessions, 'settings'] as const,
    storage: () => [QUERY_NAMESPACE.sessions, 'storage'] as const,
  },

  /** Reserved for phase 3e (§4.5). No hooks yet. */
  plans: {
    all: [QUERY_NAMESPACE.plans] as const,
    list: (query: AgentPlanQuery) => [QUERY_NAMESPACE.plans, LIST, query] as const,
    detail: (planId: string) => [QUERY_NAMESPACE.plans, DETAIL, planId] as const,
  },
} as const;

/* ── predicates ──────────────────────────────────────────────────────────── */

/**
 * `true` for the health probe and nothing else. This is `ServiceGate`'s
 * recovery predicate, written where the keys are: it invalidates every query
 * whose key this rejects, and re-entering the probe from inside its own success
 * path would loop.
 */
export function isServiceProbeKey(key: readonly unknown[]): boolean {
  return key[0] === QUERY_NAMESPACE.service;
}

/** The complement — "everything refreshed when the service comes back". */
export function refreshesOnServiceRecovery(key: readonly unknown[]): boolean {
  return !isServiceProbeKey(key);
}

/**
 * Whether `prefix` addresses `key` the way `invalidateQueries` does: segment by
 * segment from the front, comparing by value. Used by the key tests to prove
 * that invalidating one object reaches its sub-resources; exported because the
 * same question comes up wherever a partial invalidation is reasoned about.
 *
 * Only the segment kinds the factory actually produces are compared — strings,
 * numbers and plain query objects — and objects compare shallowly, which is
 * enough because no key nests one.
 */
export function isKeyPrefixOf(prefix: readonly unknown[], key: readonly unknown[]): boolean {
  if (prefix.length > key.length) return false;
  return prefix.every((segment, index) => segmentsEqual(segment, key[index]));
}

function segmentsEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((name) => Object.is(left[name], right[name]));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
