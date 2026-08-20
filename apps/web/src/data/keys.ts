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
  AudioAnalysisOptions,
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

/**
 * `commands.listMatchHistory` takes positional arguments
 * (`page, pageSize, signal, search`) rather than a query object, so the object
 * is declared here and `data/history.ts` spreads it at the call. Field names
 * follow the wire (`page_size`), like `PlayerDirectoryQuery` above, and `search`
 * is optional-absent rather than `| undefined` so an omitted filter and an
 * explicit `undefined` cannot become two cache entries for one list.
 */
export interface MatchHistoryQuery {
  page: number;
  page_size: number;
  search?: string;
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
  match: 'match',
  history: 'history',
  players: 'players',
  evidence: 'evidence',
  tasks: 'tasks',
  outputs: 'outputs',
  config: 'config',
  sessions: 'sessions',
  plans: 'plans',
  recording: 'recording',
  montage: 'montage',
  editor: 'editor',
  media: 'media',
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
   * The match workspace (§7 `/match/:demoId`, spec §4.1's own example
   * `match: { workspace: (demoId) => ['match', demoId] }`). Added in phase 3c —
   * phase 2 built the namespaces the pages of that round needed, and no page
   * read a match analysis until the workspace existed.
   *
   * Why a namespace of its own rather than more sub-resources under
   * `qk.demos.detail(id)`: a `demos` invalidation is what the *library*
   * performs after an import, a rename, a tag edit or a scan, and none of those
   * change a single number in a parsed analysis. Hanging the analysis, the heat
   * points and the replay under `demos` would make every rename re-decode a
   * replay. The two are invalidated together exactly once — when an analysis
   * run completes — and `data/match.ts` states that at the call site.
   *
   * `workspace(demoId)` is the detail root; everything about one match hangs
   * below it, so `invalidateMatch(client, demoId)` reaches the analysis, the
   * heat points, the replay and every per-round read in one call.
   *
   * `radar` is the exception that sits beside it rather than under it: a map's
   * radar calibration belongs to the *map*, and every demo played on Mirage
   * wants the same answer. Keyed by demo it would be refetched per match and
   * invalidated by an event that cannot change it.
   */
  match: {
    all: [QUERY_NAMESPACE.match] as const,
    /** Everything about one match. Also the invalidation handle. */
    workspace: (demoId: string) => [QUERY_NAMESPACE.match, DETAIL, demoId] as const,
    /** `getAnalysis` — rounds, players, highlights, insights, teams. */
    analysis: (demoId: string) => [QUERY_NAMESPACE.match, DETAIL, demoId, 'analysis'] as const,
    /** `getHeatmap` — the positioned events of one match. */
    heat: (demoId: string) => [QUERY_NAMESPACE.match, DETAIL, demoId, 'heat'] as const,
    /** `getReplayBinary` — decoded 2D replay frames. */
    replay: (demoId: string) => [QUERY_NAMESPACE.match, DETAIL, demoId, 'replay'] as const,
    /** One round's review note and tags. Below the match, above nothing. */
    roundReview: (demoId: string, round: number) =>
      [QUERY_NAMESPACE.match, DETAIL, demoId, 'round', round, 'review'] as const,
    /** Radar calibration for a map — see the note above on why it is a sibling. */
    radar: (mapName: string) => [QUERY_NAMESPACE.match, 'radar', mapName] as const,
  },

  /**
   * Steam match history — the list `/history` reads and the download jobs it
   * starts. A namespace of its own rather than a corner of `demos`: a match
   * record exists before any demo does, and 「同步最近比赛」 changes every row
   * without touching the library.
   *
   * Written by: `syncMatchHistory`, `downloadMatchDemo`, `cancelMatchDownload`
   * → invalidate `qk.history.all`. The same writes also touch `qk.tasks.all`
   * (a download is an `ActivityKind`, so it appears in the task feed) and, once
   * a download completes, `qk.demos.all` — `history.ts` states which write does
   * which.
   *
   * `activeDownloads` sits below the namespace root but beside the list: it is
   * refreshed by the same writes, and the page polls it while anything is in
   * flight without re-fetching the table on every tick.
   */
  history: {
    all: [QUERY_NAMESPACE.history] as const,
    list: (query: MatchHistoryQuery) => [QUERY_NAMESPACE.history, LIST, query] as const,
    activeDownloads: () => [QUERY_NAMESPACE.history, 'downloads', 'active'] as const,
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
    agentVideoWorkflow: (jobId: string) =>
      [QUERY_NAMESPACE.tasks, DETAIL, 'recording', jobId, 'agent-video'] as const,
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
    takes: (planId: string, shotId?: string) =>
      [QUERY_NAMESPACE.plans, DETAIL, planId, 'takes', shotId ?? 'all'] as const,
    composition: (planId: string) =>
      [QUERY_NAMESPACE.plans, DETAIL, planId, 'composition'] as const,
  },

  /**
   * 「08 录制计划与镜头预览」 (phase 3f). Three keys, and the interesting part of
   * this namespace is **what is missing from it**.
   *
   * ── the recording plan itself is not cached, on purpose ───────────────────
   *
   * `planRecording` / `planRecordingFromAgentPlan` / `planRecordingRetry` are
   * POSTs that mint a **5-minute lease** (`RECORDING_PLAN_TTL`,
   * `crates/application/src/routes/recording.rs`) and run the director
   * orchestration that merges adjacent shots. Give that a query key and
   * TanStack is free to refetch it — on a remount, on an invalidation, on a
   * `staleTime` expiry — and every refetch would mint a *different* plan with a
   * *different* director result under the preview the user is watching. 「修改
   * 任何片段都会让当前预览计划失效，需要重新生成预览」 is a decision the user
   * makes, never a cache eviction. So a plan lives in `data/recording.ts` as a
   * mutation result held by the page, and expiry is surfaced as a boolean
   * rather than papered over by a silent re-plan.
   *
   * The same reasoning covers `preflightRecordingPlan`: it is a POST that
   * probes the disk, re-hashes every Demo and asks the OS for encoders. It is
   * a mutation with a caller-held result, keyed by the shot list it was run
   * against (see `useRecordingPreflight`), not a query.
   *
   * ── what a write here invalidates ─────────────────────────────────────────
   *
   *   `createRecordingShotPreset` / `putRecordingShotPreset` /
   *   `deleteRecordingShotPreset`  → `qk.recording.shotPresets()`. Nothing
   *   else: nothing on the server dereferences a preset id, so applying one
   *   copies values into a shot and no other read can change.
   *
   *   `executeRecordingPlan`       → **`qk.tasks.all` and `qk.outputs.all`**,
   *   not this namespace. Starting a recording creates an activity record and,
   *   as shots land, outputs — 「最近输出」 is empty forever if the second half
   *   of that pair is forgotten. `data/recording.ts` performs both.
   *
   *   `playDemo` / `stopPlayback`  → `qk.recording.playback()`, the one read
   *   here that a write in this file changes.
   */
  recording: {
    all: [QUERY_NAMESPACE.recording] as const,
    /** `listRecordingShotPresets` — 「存为预设」's catalogue. */
    shotPresets: () => [QUERY_NAMESPACE.recording, 'shot-presets'] as const,
    /**
     * `playbackStatus` — whether CS2 is already playing a Demo. Read before
     * 「在游戏里预览」 so the page can say why the action is unavailable rather
     * than launching a second process.
     */
    playback: () => [QUERY_NAMESPACE.recording, 'playback'] as const,
  },

  /**
   * 「09 快速合辑」 (phase 3f) — montage projects and the export jobs they start.
   *
   * Written by: `createMontageProject` / `putMontageProject` /
   * `deleteMontageProject` → invalidate **both** `montage.detail(id)` and
   * `montage.list()`. The list is not a projection of the detail: its rows
   * print 「5 段素材 · 2 分 04 秒 · 上次保存 3 分钟前」, so a save that only
   * refreshed the open project would leave the switcher printing a stale clip
   * count. `data/montage.ts` does both in one helper for that reason.
   *
   * `exports(projectId)` is a **sibling** of `detail(projectId)` rather than a
   * child of it, which is the one place this namespace departs from the
   * house rule at the top of this file. A save invalidates the detail several
   * times a minute and cannot change a single export job; hanging the job list
   * underneath would re-fetch `/exports` on every keystroke-driven autosave.
   * The reverse direction is real and is honoured: `exportMontageProject`
   * invalidates `exports(id)` *plus* `qk.tasks.all` and `qk.outputs.all`,
   * because an export is an activity that ends in an output.
   */
  montage: {
    all: [QUERY_NAMESPACE.montage] as const,
    /** `listMontageProjects`. No query object — the route takes no filter. */
    list: () => [QUERY_NAMESPACE.montage, LIST] as const,
    detail: (projectId: string) => [QUERY_NAMESPACE.montage, DETAIL, projectId] as const,
    /** `listExportJobs(projectId)`. A sibling — see the note above. */
    exports: (projectId: string) => [QUERY_NAMESPACE.montage, 'exports', projectId] as const,
  },

  /**
   * 「10 多轨编辑器」 (phase 3f-2) — editor projects, their version history and
   * the clip presets the Inspector applies.
   *
   * ── why `snapshots` hangs below `detail` and `presets` does not ───────────
   *
   * A snapshot is a version *of one project*: taking one, restoring one and
   * saving the project all change the same thing, so `snapshots(id)` sits
   * under `detail(id)` and a save that invalidates the project refreshes its
   * history for free. That is the 「版本历史」 panel of the artboard, which
   * prints 「已保存 · 版本 24」 from the same number the detail carries.
   *
   * Presets are the opposite: `PresetRecord` is a library shared by every
   * project (`/editor/presets`, no project id in the path), and applying one
   * changes the *project*, not the preset. So `presets()` is a sibling of
   * `list()`, and `applyEditorPreset` invalidates the project alone.
   *
   * Written by: `saveEditorProject` / `restoreEditorSnapshot` /
   * `applyEditorPreset` / `separateEditorAudio` → `editor.detail(id)` **and**
   * `editor.list()`. Both, for the same reason `montage` does it: the project
   * switcher prints a name and a modified time that a detail-only refresh
   * would leave stale.
   *
   * `exportEditorProject` invalidates neither — an export reads the project
   * and writes an output, so it reaches `qk.tasks.all` and `qk.outputs.all`
   * and leaves the document alone. `exportEditorPackage` is the same shape.
   */
  editor: {
    all: [QUERY_NAMESPACE.editor] as const,
    /** `listEditorProjects`. The route takes no filter. */
    list: () => [QUERY_NAMESPACE.editor, LIST] as const,
    detail: (projectId: string) => [QUERY_NAMESPACE.editor, DETAIL, projectId] as const,
    /** `listEditorSnapshots(projectId)` — a child, so a save refreshes it. */
    snapshots: (projectId: string) =>
      [QUERY_NAMESPACE.editor, DETAIL, projectId, 'snapshots'] as const,
    /** `listEditorPresets`. A library, not a property of any project. */
    presets: () => [QUERY_NAMESPACE.editor, 'presets'] as const,
  },

  /**
   * Media assets, waveforms and audio analysis (phase 3f, 「09」's 配乐与节拍).
   *
   * ── the one rule that shapes this namespace ───────────────────────────────
   *
   * **A waveform and an audio analysis are recomputations, not reads.**
   * `/media/assets/{id}/waveform` decodes the file (90-second client timeout)
   * and `/media/assets/{id}/audio-analysis` runs beat, onset, energy and
   * section detection over it. Both answer the same bytes with the same numbers
   * forever: they change when the *file* changes, and a file behind an asset id
   * only changes through `relinkMediaAsset` / `replaceMediaAsset`.
   *
   * So they are deliberately **not** nested under `asset(id)`. Importing an
   * asset, generating a proxy or extracting an audio track all touch the asset
   * record, and every one of them would drag a minute of DSP along behind it if
   * the analysis hung below the detail key. The three groups are siblings:
   *
   *   `assets(projectId)`   cheap list        invalidated by every asset write
   *   `asset(id)`           cheap record      invalidated by writes to that one
   *   `waveform` / `audioAnalysis`            invalidated by **nothing**;
   *                                           *removed* when the asset is
   *                                           deleted (`waveformsOf`)
   *
   * A corollary worth stating because it is easy to break: **never invalidate
   * `qk.media.all`.** It is here so `keys.test.ts` can prove the namespace is a
   * prefix of its members, and so a future full-cache sweep still reaches these
   * entries — not as a write handle. `data/mediaAssets.ts` exports
   * `invalidateMediaAssets` (the lists) and `forgetMediaAsset` (removal), and
   * no whole-namespace invalidator.
   *
   * `clipWaveform` is keyed here rather than under `outputs` for the same
   * reason: `qk.outputs.all` is invalidated whenever any recording or export
   * finishes, and a recorded clip's waveform costs a decode it would then
   * repeat.
   *
   * `projectId` is `string | null` in the key — `listMediaAssets()` with no
   * project is the whole library, a different list from any project's, and
   * spelling the absence as `null` keeps the two from hashing alike.
   */
  media: {
    all: [QUERY_NAMESPACE.media] as const,
    /** Every asset list. The invalidation handle for an import or a delete. */
    assetsAll: [QUERY_NAMESPACE.media, 'assets'] as const,
    assets: (projectId: string | null) =>
      [QUERY_NAMESPACE.media, 'assets', projectId] as const,
    asset: (assetId: string) => [QUERY_NAMESPACE.media, DETAIL, assetId] as const,
    /** Peaks at a bucket count. Different bucket counts are different pictures,
     *  so the count is in the key rather than resampled from a cached one. */
    waveform: (assetId: string, buckets: number) =>
      [QUERY_NAMESPACE.media, 'waveform', 'asset', assetId, buckets] as const,
    /** Every bucket count of one asset — the removal handle. */
    waveformsOf: (assetId: string) =>
      [QUERY_NAMESPACE.media, 'waveform', 'asset', assetId] as const,
    clipWaveform: (clipId: string, buckets: number) =>
      [QUERY_NAMESPACE.media, 'waveform', 'recorded-clip', clipId, buckets] as const,
    /** `analyzeAudioAsset`. `options` is `null` for the client's own defaults,
     *  which is a different (and much more common) request than any explicit
     *  option set. */
    audioAnalysis: (assetId: string, options: AudioAnalysisOptions | null) =>
      [QUERY_NAMESPACE.media, 'audio-analysis', assetId, options] as const,
    /** Every option set of one asset — the removal handle, like `waveformsOf`. */
    audioAnalysesOf: (assetId: string) =>
      [QUERY_NAMESPACE.media, 'audio-analysis', assetId] as const,
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
