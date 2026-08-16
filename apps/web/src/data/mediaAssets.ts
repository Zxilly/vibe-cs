/**
 * data layer — media assets, peaks and audio analysis (spec §2, phase 3f).
 *
 * Feeds 「09 快速合辑」's 配乐与节拍 block (「low-orbit.mp3 · 128 BPM · 置信度
 * 0.92」, 「更换音乐」) and the strips that draw a clip's audio. 「10 多轨编辑器」
 * will read the same hooks next round; nothing here is montage-specific, which
 * is why it is its own file rather than a corner of `data/montage.ts`.
 *
 * ## The one thing to understand before adding a hook here
 *
 * **Two of these reads are computations, and they must never be invalidated by
 * a write that cannot change their answer.**
 *
 *   `getAssetWaveform`        decodes the file (90 s client timeout)
 *   `getRecordedClipWaveform` the same, for a recorded take
 *   `analyzeAudioAsset`       beat / onset / energy / section detection
 *
 * All three answer the *bytes behind an asset id*. Importing a second asset,
 * generating a proxy, extracting an audio track or renaming a project changes
 * none of them. So `keys.ts` deliberately keeps them out from under
 * `qk.media.asset(id)` — the note there spells out why — and this file exports
 * no whole-namespace invalidator at all. The two handles are:
 *
 *   `invalidateMediaAssets(client)`  the cheap lists, after any asset write
 *   `forgetMediaAsset(client, id)`   *removal*, when the asset is gone
 *
 * `forgetMediaAsset` removes rather than invalidates: an invalidated waveform
 * for a deleted asset would be refetched on the next mount and 404.
 *
 * The one case that genuinely does invalidate a waveform is a file swap
 * (`relinkMediaAsset` / `replaceMediaAsset`), and neither is wired this round —
 * 「素材重新定位对话框」 belongs to 「10 多轨编辑器」. When it lands it must call
 * `forgetMediaAsset` too, and this comment is the reminder.
 *
 * ## Media URLs
 *
 * A `<video>` / `<audio>` source is **not** a query. It is a `vibe-cs-media:`
 * URL the Tauri CSP allows, produced by `data/nativeShell.ts`'s `mediaSrc`. The
 * path builders live here because the shape of a stream path is a fact about
 * this API, and a page concatenating one by hand would work in the dev server
 * and fail in the shipped app — the bridge whitelists a closed list of paths
 * (`apps/desktop/src-tauri/src/bridge.rs`, `validate_media_path`).
 */

import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import type {
  AudioAnalysis,
  AudioAnalysisOptions,
  MediaAsset,
  WaveformResponse,
} from '../shared/desktop/dto';
import { useDesktopClient } from './desktopClient';
import { qk } from './keys';
import { resolveQueryTuning, type DataQueryTuning } from './queryTuning';

/**
 * The bucket count 「09」 draws its music waveform at. Same default the client
 * uses, named here so the query key and the request cannot disagree — an
 * omitted argument and an explicit `120` would otherwise be two cache entries
 * for one picture.
 */
export const DEFAULT_WAVEFORM_BUCKETS = 120;

/* ── reads ───────────────────────────────────────────────────────────────── */

/**
 * The asset library, optionally scoped to one project.
 *
 * `null` means 「整个素材库」 — a real and different list from any project's,
 * not 「还没选」, so this read is never disabled by its argument. Pass
 * `{ enabled: false }` if that is what you want.
 *
 * Invalidated by: `importMediaAsset`, `deleteMediaAsset`, `extractAssetAudio`,
 * `generateMediaProxy`, `cleanupMediaProxies` → `invalidateMediaAssets`.
 */
export function useMediaAssets(projectId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.media.assets(projectId),
    queryFn: ({ signal }) => client.listMediaAssets(projectId ?? undefined, signal),
    ...resolveQueryTuning(tuning),
  });
}

/**
 * One asset record. Carries `proxy_status` and `metadata_status`, which are the
 * two states 「素材还在处理」 is rendered from — poll it while either is
 * `pending` / `generating`, with the cadence the page chooses.
 */
export function useMediaAsset(assetId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.media.asset(assetId ?? ''),
    queryFn:
      assetId === null ? skipToken : ({ signal }) => client.getMediaAsset(assetId, signal),
    ...resolveQueryTuning(tuning, { enabled: assetId !== null }),
  });
}

/**
 * Peaks for an asset. Expensive the first time, free afterwards
 * (`WaveformResponse.cached` says which happened, and the page may print it).
 *
 * Not invalidated by anything — see the module note.
 */
export function useAssetWaveform(
  assetId: string | null,
  buckets: number = DEFAULT_WAVEFORM_BUCKETS,
  tuning: DataQueryTuning = {},
) {
  const client = useDesktopClient();
  return useQuery<WaveformResponse>({
    queryKey: qk.media.waveform(assetId ?? '', buckets),
    queryFn:
      assetId === null
        ? skipToken
        : ({ signal }) => client.getAssetWaveform(assetId, buckets, signal),
    ...resolveQueryTuning(tuning, { enabled: assetId !== null }),
  });
}

/** The same, for a recorded take. Keyed under `media`, not `outputs`, because
 *  `qk.outputs.all` is invalidated every time any recording or export finishes
 *  and a clip's peaks cost a decode they would then repeat. */
export function useRecordedClipWaveform(
  clipId: string | null,
  buckets: number = DEFAULT_WAVEFORM_BUCKETS,
  tuning: DataQueryTuning = {},
) {
  const client = useDesktopClient();
  return useQuery<WaveformResponse>({
    queryKey: qk.media.clipWaveform(clipId ?? '', buckets),
    queryFn:
      clipId === null
        ? skipToken
        : ({ signal }) => client.getRecordedClipWaveform(clipId, buckets, signal),
    ...resolveQueryTuning(tuning, { enabled: clipId !== null }),
  });
}

/**
 * 「128 BPM · 置信度 0.92」 and the beat grid behind 节拍建议.
 *
 * A `GET` that runs real DSP. It is a query rather than a mutation because it
 * is *idempotent per asset* — same bytes, same beats, forever — which is
 * exactly the property a cache is for. `options` is `undefined` for the
 * client's own defaults and goes into the key as `null` so the common call and
 * an explicit option set cannot collide.
 *
 * `AudioAnalysis.limitations` is not decoration: it names what the analysis
 * could not do (a truncated file, a tempo it would not commit to), and
 * `bpm === null` with a low `tempo_confidence` is a real answer the page must
 * be able to render as 「节拍不可靠」 rather than as an error.
 */
export function useAudioAnalysis(
  assetId: string | null,
  options?: AudioAnalysisOptions,
  tuning: DataQueryTuning = {},
) {
  const client = useDesktopClient();
  return useQuery<AudioAnalysis>({
    queryKey: qk.media.audioAnalysis(assetId ?? '', options ?? null),
    /* `analyzeAudioAsset` takes no `AbortSignal` — the route is a plain GET
       with a query string and the client declares no signal parameter. Nothing
       to forward, so nothing is pretended. */
    queryFn: assetId === null ? skipToken : () => client.analyzeAudioAsset(assetId, options),
    ...resolveQueryTuning(tuning, { enabled: assetId !== null }),
  });
}

/* ── writes ──────────────────────────────────────────────────────────────── */

export interface ImportMediaAssetInput {
  /** An absolute local path, from `useNativeShell().chooseFile`. */
  readonly path: string;
  readonly projectId?: string | undefined;
  readonly name?: string | undefined;
  readonly kind?: string | undefined;
}

/**
 * 「更换音乐」 / 「导入素材」 — import a file the user picked natively.
 *
 * A **path**, not a `File`: the desktop shell has a real picker
 * (`data/nativeShell.ts`), and `POST /media/assets/import` takes a path. The
 * browser-upload route (`uploadMediaAssets`) exists but is not wired, because
 * it needs a `File` object no native picker produces.
 *
 * Invalidates the asset lists — **both** the project-scoped one and the
 * unscoped one, since an import with no project changes 「整个素材库」 and one
 * with a project changes both lists that contain it. Waveforms and analyses are
 * untouched: importing asset B cannot change asset A's beats, and asset B has
 * none cached yet.
 */
export function useImportMediaAsset() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ path, projectId, name, kind }: ImportMediaAssetInput): Promise<MediaAsset> =>
      client.importMediaAsset(path, {
        ...(projectId === undefined ? {} : { projectId }),
        ...(name === undefined ? {} : { name }),
        ...(kind === undefined ? {} : { kind }),
      }),
    onSuccess: () => invalidateMediaAssets(queryClient),
  });
}

/**
 * Removes an asset and **forgets everything derived from it**.
 *
 * `forgetMediaAsset` removes rather than invalidates for a reason worth
 * knowing: an invalidated waveform for a deleted asset is refetched on the next
 * mount and 404s, turning a successful delete into an error banner.
 */
export function useDeleteMediaAsset() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (assetId: string) => client.deleteMediaAsset(assetId),
    onSuccess: async (_result, assetId) => {
      await invalidateMediaAssets(queryClient);
      forgetMediaAsset(queryClient, assetId);
    },
  });
}

/**
 * Renders an asset's audio stream into a second, managed audio asset.
 *
 * Creates a *new* asset, so the lists move; the source asset and every
 * computation over it are unchanged.
 */
export function useExtractAssetAudio() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (assetId: string): Promise<MediaAsset> => client.extractAssetAudio(assetId),
    onSuccess: () => invalidateMediaAssets(queryClient),
  });
}

/**
 * Generates the low-resolution proxy a scrubbing preview plays from.
 *
 * Moves `proxy_status`, which both the record and the lists print, so both are
 * invalidated — and nothing else. A proxy is a re-encode of the same content;
 * the peaks and the beats it would produce are identical, which is exactly the
 * invalidation this file exists to avoid.
 */
export function useGenerateMediaProxy() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (assetId: string): Promise<MediaAsset> => client.generateMediaProxy(assetId),
    onSuccess: async (asset) => {
      await invalidateMediaAssets(queryClient);
      await queryClient.invalidateQueries({ queryKey: qk.media.asset(asset.id) });
    },
  });
}

/**
 * 「清理缓存」's media half — drops proxy files that no longer have a reader.
 *
 * `MediaProxyCleanup.skipped_generating` is why the result is returned rather
 * than swallowed: a sweep that skipped a proxy still being generated has not
 * finished the job, and the page says so instead of printing a reclaimed byte
 * count as if it were the whole story.
 */
export function useCleanupMediaProxies() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => client.cleanupMediaProxies(),
    onSuccess: () => invalidateMediaAssets(queryClient),
  });
}

/* ── media URLs ──────────────────────────────────────────────────────────── */

/**
 * The service path of an asset's own stream.
 *
 * Hand the result to `useNativeShell().mediaSrc(path)`; that is the only place
 * allowed to turn it into a URL. Both halves are needed because the bridge
 * whitelist is matched on the path and the CSP is matched on the scheme, and
 * only `mediaSrc` knows about the second.
 */
export function mediaAssetStreamPath(assetId: string): string {
  return `/api/media/assets/${encodeURIComponent(assetId)}/stream`;
}

/** The proxy stream — smaller, seekable, and only present once
 *  `proxy_status.status === 'ready'`. Check before offering it. */
export function mediaAssetProxyStreamPath(assetId: string): string {
  return `/api/media/assets/${encodeURIComponent(assetId)}/proxy/stream`;
}

/**
 * A recorded take's stream.
 *
 * `RecordedClipRecord.stream_url` already carries exactly this string, so
 * prefer the field when you have the record; this builder is for the places
 * that hold only an id.
 */
export function recordedClipStreamPath(clipId: string): string {
  return `/api/recorded-clips/${encodeURIComponent(clipId)}/stream`;
}

/* ── invalidation ────────────────────────────────────────────────────────── */

/**
 * Every asset list, project-scoped and not. **The only invalidation this file
 * performs**, deliberately — see the module note.
 */
export function invalidateMediaAssets(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.media.assetsAll });
}

/**
 * Drops one asset's record and every computation over it, without refetching
 * any of them. For a delete, and for a future relink / replace.
 *
 * Synchronous: `removeQueries` does not fetch, so there is nothing to await.
 */
export function forgetMediaAsset(client: QueryClient, assetId: string): void {
  client.removeQueries({ queryKey: qk.media.asset(assetId) });
  client.removeQueries({ queryKey: qk.media.waveformsOf(assetId) });
  client.removeQueries({ queryKey: qk.media.audioAnalysesOf(assetId) });
}
