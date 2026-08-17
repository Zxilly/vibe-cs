/**
 * data layer — the match workspace (spec §7 `/match/:demoId`, phase 3c).
 *
 * Every server read the nine §7 views need, declared once. The three agents
 * that fill the views in after this round **use** this file and do not extend
 * it: a view that needed a read nobody had planned for would otherwise add a
 * key literal beside the factory, which is the failure `keys.ts` exists to
 * prevent. If a view genuinely needs a read that is not here, the honest answer
 * is that the backend cannot serve it — the gaps are enumerated at the bottom
 * of this header.
 *
 * ## One read serves eight of the nine views
 *
 * `getAnalysis(demoId)` returns an `AnalysisWorkspace`: teams, per-player
 * stats, every round *with its event list inline*, every highlight, and the
 * `insights` block (round economy, per-player utility, matchups). That single
 * payload is what 概览 / 回合 / 玩家 / 对位 / 道具与经济 / 高光 / Review / 队伍
 * are drawn from, so they all call `useMatchAnalysis` and TanStack serves seven
 * of the eight from cache. Splitting it into eight per-view reads would be
 * eight round trips for one document the service builds in one piece.
 *
 * Only 回放与热力图 needs more: positions over time (`useMatchReplay`), the
 * positioned-event cloud (`useMatchHeatPoints`) and the map's radar
 * calibration (`useMapRadarOverview`).
 *
 * ## Which hook serves which view
 *
 *   useMatchAnalysis        overview rounds players duels utility highlights
 *                           review teams   ← the shared document
 *   useMatchHeatPoints      replay          ← raw positioned events, to be binned
 *   useMapRadarOverview     replay          ← world→image transform, not an image
 *   useMatchReplay          replay          ← decoded frames; see the warning
 *   useRoundReview          rounds review   ← one round's note and tags
 *   useMatchEvidence        rounds duels utility replay highlights review
 *   useMatchAnnotations     review          ← 「我的注释」
 *   useUpdateRoundReview    rounds review
 *   useCreateMatchAnnotation / useUpdateMatchAnnotation / useDeleteMatchAnnotation
 *                           review
 *   useGenerateMatchReview  review          ← 「生成 AI 点评」
 *
 * The context bar's identity (map, date, team names, score before analysis)
 * comes from `data/demos.ts`'s `useDemo`, and 「这场还没分析 · 开始分析」 from
 * `useActiveAnalysisRun` + `useStartDemoAnalysis` in `data/tasks.ts` /
 * `data/demos.ts`. Nothing is re-declared here — a second `useDemo` would be a
 * second cache entry for one demo.
 *
 * ## Invalidation
 *
 * The only event that changes any of this is **an analysis run completing**:
 * it rewrites the analysis document, the heat points, the replay and the
 * evidence index at once. That is `invalidateMatch(client, demoId)` plus
 * `invalidateEvidence`. Nothing else here invalidates the analysis — a rename
 * in the library moves no number in a parsed match, which is why the match keys
 * are their own namespace and not sub-resources of `demos` (see `keys.ts`).
 *
 * Round review notes and evidence annotations are the exception: they are
 * user-authored, they change without an analysis, and they invalidate only
 * their own key (`qk.match.roundReview`, `qk.evidence.annotationsAll`).
 *
 * ## Backend gaps this file deliberately does not paper over
 *
 *   1. **No per-round replay without a run id.** The service has
 *      `getAnalysisRunRoundReplayBinary(runId, round)`, but §10.4 gap 8 records
 *      that there is no query for a demo's past analysis runs — only
 *      `getActiveAnalysisRun`, which is `null` once the run finishes. So the
 *      only reachable replay is the whole-match one, and the round scoping is
 *      a client-side slice of it.
 *   2. **The recording queue is not server state.** 「加入视频」 in the artboards
 *      has no command behind it: `planRecording` builds an *ephemeral* plan
 *      (it carries `expires_at`) and the persistent queue lives in
 *      `features/queue/queueStore.ts`, a client-side zustand store that §4.2's
 *      replacement has not been written yet. No hook is invented for it; the
 *      workspace disables the action and says why.
 *   3. **No shot-accuracy data.** 「AK-47 16 杀 · 命中 34%」 on the players
 *      artboard needs shots fired; `TimelineEvent` has kills and damage and no
 *      weapon-fire event. Kills per weapon are derivable, hit rate is not.
 *   4. **No lineup id for a demo.** `listLineups` is a cross-match directory
 *      keyed by a lineup id nothing maps a demo onto, so the 队伍 view is built
 *      from this match's own `teams` / `insights`, and the /lineups takeover
 *      the merge table describes is not reachable yet.
 */

import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

/*
 * The replay wire is a binary frame stream (`ARPL`), not JSON. The decoder was
 * `features/analysis/replayBinary.ts` and this file imported it across the
 * layer boundary, with a comment saying phase 4 would have to move it here
 * rather than delete it with the rest of `features/**`. Phase 4 did: it is
 * `./replayBinary` now, and it speaks Lingui instead of the retired
 * `shared/i18n` runtime.
 */
import { decodeReplayBinary } from './replayBinary';
import type {
  CreateEvidenceAnnotation,
  EvidenceAnnotationQuery,
  EvidenceAnnotationReviewState,
  EvidenceSearchQuery,
  LlmReviewRequest,
  ReplayPayload,
  ReviewMetadataUpdate,
  UpdateEvidenceAnnotation,
} from '../shared/desktop/dto';
import { useDesktopClient } from './desktopClient';
import { invalidateEvidenceAnnotations, useEvidenceAnnotations, useEvidenceSearch } from './evidence';
import { qk } from './keys';
import { resolveQueryTuning, type DataQueryTuning } from './queryTuning';

/* ── the shared analysis document ────────────────────────────────────────── */

/**
 * The parsed match: teams, players, rounds (events inline), highlights,
 * insights. Serves every view except 回放与热力图, which needs it too — for the
 * round boundaries the replay is sliced on.
 *
 * `null` while no demo is addressed (the route always has one, so this is the
 * guard a test or a not-yet-resolved param hits, not a normal state).
 *
 * Fails when the demo has never been analysed: the service answers 404 and the
 * page turns that into 「这场还没分析 · 开始分析」 (`Empty` preset
 * `not-analysed`) rather than into a red error — see `analysisIsMissing`.
 *
 * Invalidated by: an analysis run completing → `invalidateMatch`.
 */
export function useMatchAnalysis(demoId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.match.analysis(demoId ?? ''),
    queryFn: demoId === null ? skipToken : ({ signal }) => client.getAnalysis(demoId, signal),
    ...resolveQueryTuning(tuning, { enabled: demoId !== null }),
  });
}

/**
 * Whether a failed `useMatchAnalysis` means 「还没分析」 rather than 「打不开」.
 *
 * Pure and exported because the distinction decides which of two very different
 * surfaces the page shows, and getting it wrong in either direction is bad: a
 * 404 rendered as an error hides the one action that fixes it, and a real
 * failure rendered as 「还没分析」 invites the user to start a run that will fail
 * the same way. `DesktopApiError` carries the HTTP status, so the answer is
 * read off the error rather than guessed from its message.
 */
export function analysisIsMissing(error: unknown): boolean {
  return statusOf(error) === 404;
}

function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

/* ── the replay view's three extra reads ─────────────────────────────────── */

/**
 * Every positioned event of one match — kills, deaths, plants, defuses — as raw
 * world points (`HeatPointRecord`), each tagged with round, tick, floor, side
 * and player.
 *
 * **Not aggregated.** §10.3 gap 7 asked for server-side binning and it still
 * does not exist; `domain/map`'s `binWorldSamples` is one linear pass and the
 * page runs it, exactly as `/players/:id` already does. This hook does not bin,
 * because the *binning parameters* (grid size, which floor, which round range)
 * are the view's decision and binning here would cache one arbitrary choice.
 *
 * There is also no server-side cap on this route, unlike the player heat map's
 * 5 000. The page has to state its own denominator; `domain/map/density.test`
 * pins what the layers can carry.
 *
 * Serves: 回放与热力图.
 */
export function useMatchHeatPoints(demoId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.match.heat(demoId ?? ''),
    queryFn: demoId === null ? skipToken : ({ signal }) => client.getHeatmap(demoId, signal),
    ...resolveQueryTuning(tuning, { enabled: demoId !== null }),
  });
}

/**
 * A map's radar calibration — `pos_x` / `pos_y` / `scale` / `rotate` / `zoom` —
 * which is what `domain/map`'s `mapProjection` turns world coordinates into
 * image coordinates with.
 *
 * Keyed by map name, not by demo: every match on Mirage shares one answer.
 *
 * The response also carries `image_url` / `browser_displayable`. **This round
 * uses neither.** Tauri's CSP is `default-src 'self'`, §10.3 gap 8 records that
 * no delivery path for the radar bitmap has been decided, and a page that
 * points an `<img>` at a blocked URL fails silently. The transform is useful on
 * its own — it is what puts a kill in the right place on a blank plate.
 *
 * Serves: 回放与热力图.
 */
export function useMapRadarOverview(mapName: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  const ready = mapName !== null && mapName !== '';
  return useQuery({
    queryKey: qk.match.radar(mapName ?? ''),
    queryFn: !ready ? skipToken : ({ signal }) => client.getRadarOverview(mapName, signal),
    ...resolveQueryTuning(tuning, { enabled: ready }),
  });
}

/**
 * The decoded 2D replay: player positions, yaw, health and weapon per frame,
 * plus projectiles and the bomb.
 *
 * Three things a caller has to know, all of them consequences of the wire being
 * a binary blob rather than a page of JSON:
 *
 *   * **It is the whole match.** See gap 1 in the header — the per-round route
 *     needs an analysis-run id nothing can look up. Slice by tick on the
 *     client; `fidelity.start_tick` / `end_tick` bound the stream.
 *   * **Decoding is synchronous and on the main thread.** `decodeReplayBinary`
 *     walks up to 20 000 frames; there is no worker seam in `data/` yet. A
 *     visible hitch on open is a known cost, recorded rather than hidden.
 *   * **It is off by default.** `enabled` defaults to `false` here — the
 *     opposite of every other hook in this layer — because the workspace opens
 *     on 概览 and seven of the nine views never want megabytes of frames. The
 *     replay view passes `{ enabled: true }` when it mounts.
 *
 * Serves: 回放与热力图.
 */
export function useMatchReplay(demoId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  const wanted = tuning.enabled === true && demoId !== null;
  return useQuery<ReplayPayload>({
    queryKey: qk.match.replay(demoId ?? ''),
    queryFn:
      demoId === null
        ? skipToken
        : async ({ signal }) => decodeReplayBinary(await client.getReplayBinary(demoId, signal)),
    ...resolveQueryTuning(tuning, { enabled: wanted }),
  });
}

/* ── per-round review metadata ───────────────────────────────────────────── */

/**
 * One round's note and review tags — the artboard's 「注释 · 第 2 杀的穿墙点可作为
 * 教学素材」 block in the workspace Inspector.
 *
 * This is *round* metadata (`/demos/:id/rounds/:n/metadata`), which is a
 * different thing from an evidence annotation: it hangs off the round, it holds
 * one comment plus tags from the shared review-tag vocabulary, and there is
 * exactly one of it per round. Evidence annotations hang off a single tick-level
 * fact, there can be many, and they are searchable across matches from
 * `/evidence`. The workspace shows both, in different blocks, because they
 * answer different questions.
 *
 * Serves: 回合, Review 与注释.
 */
export function useRoundReview(
  demoId: string | null,
  round: number | null,
  tuning: DataQueryTuning = {},
) {
  const client = useDesktopClient();
  const ready = demoId !== null && round !== null;
  return useQuery({
    queryKey: qk.match.roundReview(demoId ?? '', round ?? 0),
    queryFn: !ready
      ? skipToken
      : ({ signal }) => client.getRoundReviewMetadata(demoId, round, signal),
    ...resolveQueryTuning(tuning, { enabled: ready }),
  });
}

export interface RoundReviewWrite {
  readonly demoId: string;
  readonly round: number;
  readonly update: ReviewMetadataUpdate;
}

/**
 * Writes one round's note and tags.
 *
 * Invalidates `qk.match.roundReview(demoId, round)` and nothing else: the note
 * is not part of the analysis document, so re-reading the whole match after
 * typing a sentence would refetch every round of it. The review-tag vocabulary
 * itself is `qk.demos.reviewTags()` and only changes when a tag is created or
 * renamed, which happens in the library.
 */
export function useUpdateRoundReview() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ demoId, round, update }: RoundReviewWrite) =>
      client.updateRoundReviewMetadata(demoId, round, update),
    onSuccess: async (_result, { demoId, round }) => {
      await queryClient.invalidateQueries({ queryKey: qk.match.roundReview(demoId, round) });
    },
  });
}

/* ── evidence, scoped to this match ──────────────────────────────────────── */

/**
 * The evidence index, filtered to one demo.
 *
 * A thin wrapper over `data/evidence.ts`'s `useEvidenceSearch` rather than a
 * second read: the key is the same `qk.evidence.search(query)`, so the
 * workspace and `/evidence` share a cache entry whenever they ask the same
 * question. What the wrapper adds is that `demo_id` cannot be forgotten — nine
 * views assembling their own query object is nine chances to leak another
 * match's evidence into this one.
 *
 * Serves: 回合 (round events), 对位 (a duel's kills), 道具与经济 (utility
 * throws), 回放 (the list-view alternative the artboard insists on), 高光,
 * Review.
 */
export function useMatchEvidence(
  demoId: string | null,
  query: Omit<EvidenceSearchQuery, 'demo_id'> = {},
  tuning: DataQueryTuning = {},
) {
  return useEvidenceSearch(
    { ...query, demo_id: demoId ?? '' },
    { ...tuning, enabled: (tuning.enabled ?? true) && demoId !== null },
  );
}

/**
 * The annotations written against this match — 「我的注释 3」 on the Review view.
 *
 * Same wrapper reasoning as `useMatchEvidence`.
 *
 * Serves: Review 与注释.
 */
export function useMatchAnnotations(
  demoId: string | null,
  query: Omit<EvidenceAnnotationQuery, 'demo_id'> = {},
  tuning: DataQueryTuning = {},
) {
  return useEvidenceAnnotations(
    { ...query, demo_id: demoId ?? '' },
    { ...tuning, enabled: (tuning.enabled ?? true) && demoId !== null },
  );
}

/**
 * Creates an annotation on one piece of evidence.
 *
 * §10.4 gap 16 recorded that `DesktopClient` carried no evidence writes, so
 * `/evidence` shipped with its annotate buttons disabled. The `Pick` is widened
 * for this round, and the three writes live *here* rather than in
 * `data/evidence.ts` because this phase owns this file and not that one. They
 * invalidate `invalidateEvidenceAnnotations` — the target `data/evidence.ts`
 * already declared for exactly this — so `/evidence` picks up a note written in
 * the workspace without either file knowing about the other.
 *
 * Deliberately **not** invalidating `qk.evidence.all`: a note does not change
 * the search index, and re-running every open search after each keystroke-sized
 * write is a cost with no answer behind it.
 */
export function useCreateMatchAnnotation() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateEvidenceAnnotation) => client.createEvidenceAnnotation(body),
    onSuccess: () => invalidateEvidenceAnnotations(queryClient),
  });
}

export interface AnnotationUpdate {
  readonly id: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly reviewState: EvidenceAnnotationReviewState;
}

/** Edits an annotation's text, tags or 「待处理 / 已处理」 state. */
export function useUpdateMatchAnnotation() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body, tags, reviewState }: AnnotationUpdate) => {
      const update: UpdateEvidenceAnnotation = {
        body,
        tags: [...tags],
        review_state: reviewState,
      };
      return client.updateEvidenceAnnotation(id, update);
    },
    onSuccess: () => invalidateEvidenceAnnotations(queryClient),
  });
}

/** Deletes an annotation. */
export function useDeleteMatchAnnotation() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.deleteEvidenceAnnotation(id),
    onSuccess: () => invalidateEvidenceAnnotations(queryClient),
  });
}

/* ── AI commentary ───────────────────────────────────────────────────────── */

export interface MatchReviewRequest {
  readonly demoId: string;
  readonly request: LlmReviewRequest;
}

/**
 * 「生成 AI 点评」.
 *
 * A mutation and not a query even though it reads: the route is a POST that
 * takes a scope, a tone and a set of highlight ids, it costs a model call, and
 * the artboard makes it an explicit button — a query would run it on mount.
 * The service caches by evidence digest and reports `cached` on the way back,
 * so pressing it twice with the same inputs does not pay twice; the view shows
 * the result it was handed rather than this layer seeding a cache entry under a
 * key nothing else would ever read.
 *
 * Invalidates nothing: commentary changes no stored fact.
 *
 * The result carries `evidence_ids` — the artboard's 「引用了 4 条证据，全部属于
 * 发送给模型的集合」 — and the view is expected to render them as citations
 * rather than print the prose alone.
 *
 * Serves: Review 与注释.
 */
export function useGenerateMatchReview() {
  const client = useDesktopClient();
  return useMutation({
    mutationFn: ({ demoId, request }: MatchReviewRequest) => client.reviewDemo(demoId, request),
  });
}

/* ── invalidation ────────────────────────────────────────────────────────── */

/**
 * Everything about one match: the analysis document, the heat points, the
 * replay frames and every per-round read. Use after an analysis run for this
 * demo reaches `completed`.
 *
 * The map's radar calibration is *not* included — it hangs beside the match,
 * not below it, because it belongs to the map (see `keys.ts`).
 */
export function invalidateMatch(client: QueryClient, demoId: string): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.match.workspace(demoId) });
}

/** Every match. Use when something invalidates analyses in bulk. */
export function invalidateMatches(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.match.all });
}
