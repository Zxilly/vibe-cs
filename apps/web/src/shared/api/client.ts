import { msg, msgf } from '../i18n';
import type {
  AnalysisWorkspace,
  ApiHealth,
  ApiProblem,
  AppConfig,
  AvatarCacheCleanup,
  AvatarCacheStatus,
  BatchDeleteOutputResult,
  CleanupMissingOutputsResult,
  CleanupStagedOutputsResult,
  CreateEditorProject,
  CreateMontageProject,
  CosmeticCatalog,
  CosmeticInspectionReport,
  CosmeticPlan,
  CosmeticRewriteRequest,
  CosmeticRewriteResponse,
  DeleteOutputResult,
  DemoPlaybackLaunch,
  DemoPlaybackOptions,
  DemoPlaybackPreflight,
  DemoPlaybackStatus,
  DemoPlaybackStop,
  DemoQuery,
  DemoRecord,
  DemoSummary,
  DemoUpdate,
  DemoWatchStatus,
  DetectedPaths,
  EditorProjectSnapshot,
  EditorPreset,
  EditorPresetDocument,
  EditorProjectDeletionResult,
  ExportJobRecord,
  JobAccepted,
  HeatPointRecord,
  EditorExportOptions,
  EditorAudioSeparation,
  EditorPackageExport,
  EditorPackageImport,
  EditorProject,
  LlmReviewRequest,
  LlmReviewResult,
  MatchAnalysisRecord,
  MatchHistoryItem,
  MatchHistorySyncResult,
  MatchDownloadJob,
  MediaAsset,
  MediaProxyCleanup,
  MontageProjectRecord,
  MontageExportRequest,
  ObsDiagnosis,
  ObsRecordStatus,
  ObsStartResponse,
  ObsVideoApplyResult,
  ObsVideoBackup,
  ObsVideoBackupDeleteResult,
  ObsVideoRestoreResult,
  ObsVideoTuningPlan,
  OutputItem,
  OutputKind,
  OutputPage,
  OutputQuery,
  OutputReference,
  Paginated,
  PlayerDirectoryPage,
  PlayerProfile,
  QuickCheckResponse,
  RadarOverviewRecord,
  ReplayCacheCleanup,
  ReplayCacheStatus,
  ReplayFrameRecord,
  ReplayPayload,
  RecordedClip,
  RecordedClipRecord,
  RecordingExecutionResponse,
  RecordingJob,
  RecordingPlanResponse,
  RecordingQueueRequest,
  CaptureLatencyCalibration,
  CaptureLatencySample,
  RecoveryStatus,
  RuntimeState,
  ScanResult,
  StorageStatus,
  WaveformResponse,
} from './dto';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

type RequestOptions = Omit<RequestInit, 'body' | 'signal'> & {
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
};

const desktopApiBase = 'http://127.0.0.1:47831/api';

export interface ApiBaseOptions {
  configuredBase?: string | undefined;
  protocol?: string | undefined;
  hostname?: string | undefined;
}

/** Resolve only build-controlled configuration; runtime URL/query data is never used as an API origin. */
export function resolveApiBase(options: ApiBaseOptions = {}): string {
  const isDesktopOrigin = options.protocol === 'tauri:' || options.hostname?.toLocaleLowerCase() === 'tauri.localhost';
  const fallback = isDesktopOrigin ? desktopApiBase : '/api';
  const configured = options.configuredBase?.trim();
  if (!configured) return fallback;
  if (configured === '/api' || configured === '/api/') return '/api';

  try {
    const parsed = new URL(configured);
    if (!['http:', 'https:'].includes(parsed.protocol)) return fallback;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return fallback;
    const path = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = path.endsWith('/api') ? path : `${path}/api`;
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

const apiBase = resolveApiBase({
  configuredBase: import.meta.env.VITE_API_URL,
  protocol: typeof location === 'undefined' ? undefined : location.protocol,
  hostname: typeof location === 'undefined' ? undefined : location.hostname,
});

/** Build a URL for a service-owned media route without accepting an arbitrary origin. */
export function apiMediaUrl(path: string): string {
  if (path.startsWith('/api/')) return `${apiBase}${path.slice(4)}`;
  if (path.startsWith('/')) return `${apiBase}${path}`;
  throw new ApiError(msg("m0432"), 0, 'INVALID_MEDIA_URL');
}

function problemMessage(problem: ApiProblem | null, status: number): string {
  if (!problem) return msgf("m1142", [status]);
  if (typeof problem.detail === 'string') return problem.detail;
  if (problem.detail?.message) return problem.detail.message;
  if (problem.message) return problem.message;
  if (problem.detail?.code) return msgf("m1143", [problem.detail.code]);
  return msgf("m1142", [status]);
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    body: requestBody,
    timeoutMs = 15_000,
    signal: callerSignal,
    ...requestInit
  } = options;
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(requestInit.headers);
  const isFormData = requestBody instanceof FormData;

  if (requestBody !== undefined && !isFormData) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Accept', 'application/json');
  const locale = typeof document === 'undefined' ? 'zh-CN' : document.documentElement.lang || 'zh-CN';
  headers.set('X-Vibe-CS-Locale', locale);

  const abortFromCaller = () => controller.abort();
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });

  let body: BodyInit | undefined;
  if (requestBody instanceof FormData) body = requestBody;
  else if (requestBody !== undefined) body = JSON.stringify(requestBody);

  try {
    const response = await fetch(`${apiBase}${path}`, {
      ...requestInit,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: controller.signal,
    });

    if (!response.ok) {
      let problem: ApiProblem | null = null;
      try {
        problem = (await response.json()) as ApiProblem;
      } catch {
        problem = null;
      }
      const code =
        problem?.code ??
        (typeof problem?.detail === 'object' ? problem.detail.code : undefined);
      throw new ApiError(problemMessage(problem, response.status), response.status, code);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError(msg("m1144"), 0, 'REQUEST_ABORTED');
    }
    throw new ApiError(msg("m0711"), 0, 'NETWORK_ERROR');
  } finally {
    globalThis.clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}

async function requestBinary(path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), 60_000);
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const response = await fetch(`${apiBase}${path}`, {
      headers: { Accept: 'application/vnd.vibe-cs.replay-v1' },
      signal: controller.signal,
    });
    if (!response.ok) throw new ApiError(msgf("m0382", [response.status]), response.status);
    if (response.headers.get('Content-Type')?.split(';', 1)[0] !== 'application/vnd.vibe-cs.replay-v1') {
      throw new ApiError(msg("m0748"), 502, 'INVALID_REPLAY_FORMAT');
    }
    const declared = Number(response.headers.get('Content-Length') ?? '0');
    if (declared > 128 * 1024 * 1024) throw new ApiError(msg("m0177"), 413, 'REPLAY_TOO_LARGE');
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 128 * 1024 * 1024) throw new ApiError(msg("m0177"), 413, 'REPLAY_TOO_LARGE');
    return buffer;
  } finally {
    globalThis.clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

function queryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== '') params.set(key, String(value));
  });
  const result = params.toString();
  return result ? `?${result}` : '';
}

export function normalizeDemo(record: DemoRecord): DemoSummary {
  const statusMap: Record<DemoRecord['status'], DemoSummary['status']> = {
    discovered: 'pending',
    indexing: 'pending',
    ready: 'ready',
    analyzing: 'parsing',
    failed: 'error',
    missing: 'error',
  };
  return {
    id: record.id,
    filename: record.file_name,
    display_name: record.display_name,
    map_name: record.map_name ?? 'unknown',
    played_at: record.match_date ?? record.created_at,
    duration_seconds: record.duration_seconds ?? 0,
    total_rounds: record.total_rounds ?? 0,
    score_team_a: record.team_a_score ?? 0,
    score_team_b: record.team_b_score ?? 0,
    status: statusMap[record.status],
    players: [],
    source: record.source === 'watch' || record.source === 'upload' ? record.source : 'local',
    remark: record.remark,
  };
}

export function normalizeSide(value: string | number): 'A' | 'B' | null {
  const side = String(value).trim().toLocaleUpperCase().replaceAll('_', '-');
  if (side === 'A' || side === 'T' || side === 'TERRORIST' || side === '2') return 'A';
  if (side === 'B' || side === 'CT' || side === 'COUNTER-TERRORIST' || side === '3') return 'B';
  return null;
}

function requireSide(value: string | number): 'A' | 'B' {
  const side = normalizeSide(value);
  if (!side) throw new ApiError(msgf("m0264", [String(value)]), 502, 'INVALID_TEAM_SIDE');
  return side;
}

export function normalizeAnalysis(record: MatchAnalysisRecord): AnalysisWorkspace {
  const highlightCategory = (kind: MatchAnalysisRecord['highlights'][number]['kind']) => {
    if (kind === 'clutch') return 'clutch' as const;
    if (kind === 'multi_kill') return 'multi-kill' as const;
    if (kind === 'timeline') return 'utility' as const;
    return 'entry' as const;
  };
  return {
    demo_id: record.demo_id,
    map_name: record.map_name,
    tick_rate: record.tick_rate,
    duration_seconds: record.duration_seconds,
    teams: record.teams.map((team) => ({ ...team, side: normalizeSide(team.side) ?? team.side })),
    ...(record.insights ? { insights: record.insights } : {}),
    players: record.players.map((player) => ({
      id: player.steam_id,
      name: player.name,
      team: requireSide(player.team),
      kills: player.kills,
      deaths: player.deaths,
      assists: player.assists,
      headshot_rate: player.kills > 0 ? player.headshots / player.kills : 0,
      rating: player.rating,
      adr: player.adr,
    })),
    rounds: record.rounds.map((round) => ({
      number: round.number,
      winner: requireSide(round.winner),
      reason: round.reason,
      start_tick: round.start_tick,
      end_tick: round.end_tick,
      team_a_score: round.team_a_score,
      team_b_score: round.team_b_score,
      events: round.events,
    })),
    highlights: record.highlights.map((highlight) => ({
      id: highlight.id,
      label: highlight.title,
      category: highlightCategory(highlight.kind),
      kind: highlight.kind,
      description: highlight.description,
      tags: highlight.tags,
      victims: highlight.victims,
      player_id: highlight.player_id,
      round: highlight.round,
      start_tick: highlight.start_tick,
      end_tick: highlight.end_tick,
      confidence: highlight.score,
    })),
  };
}

export function normalizeRecordedClip(record: RecordedClipRecord): RecordedClip {
  return {
    id: record.id,
    title: record.title,
    player_name: record.player_name ?? msg("m0764"),
    map_name: record.map_name || 'unknown',
    duration_seconds: record.duration_seconds,
    created_at: record.created_at,
    stream_url: record.stream_url,
  };
}

export const api = {
  health: (signal?: AbortSignal) => request<ApiHealth>('/health', { signal }),
  quickCheck: (signal?: AbortSignal) =>
    request<QuickCheckResponse>('/config/quick-check', { signal }),
  listDemos: async (query: DemoQuery, signal?: AbortSignal) => {
    const page = await request<Paginated<DemoRecord>>(
      `/demos/compact${queryString({
        search: query.search,
        map_name: query.map,
        status: query.status,
        sort: query.sort,
        page: query.page,
        page_size: query.page_size,
      })}`,
      { signal },
    );
    return { ...page, items: page.items.map(normalizeDemo) };
  },
  scanDemos: (paths: string[] = []) =>
    request<ScanResult>('/demos/scan', {
      method: 'POST',
      body: { paths, recursive: true },
    }),
  getDemoWatchStatus: (signal?: AbortSignal) =>
    request<DemoWatchStatus>('/demos/watch/status', { signal }),
  rescanDemoWatch: () =>
    request<DemoWatchStatus>('/demos/watch/rescan', { method: 'POST', body: {} }),
  importDemoPaths: (paths: string[]) =>
    request<ScanResult>('/demos/import', {
      method: 'POST',
      body: { paths, source: 'local' },
      timeoutMs: 600_000,
    }),
  importDemos: (files: File[]) => {
    const body = new FormData();
    files.forEach((file) => body.append('files', file));
    return request<ScanResult>('/demo/upload-multiple', { method: 'POST', body, timeoutMs: 600_000 });
  },
  updateDemo: async (id: string, update: DemoUpdate) => {
    const record = await request<DemoRecord>(`/demos/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: update,
    });
    return normalizeDemo(record);
  },
  deleteDemo: (id: string) =>
    request<void>(`/demos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listPlayers: (
    query: { search?: string; page?: number; page_size?: number } = {},
    signal?: AbortSignal,
  ) => request<PlayerDirectoryPage>(
    `/players${queryString({
      search: query.search,
      page: query.page,
      page_size: query.page_size,
    })}`,
    { signal },
  ),
  getPlayer: (steamId: string, signal?: AbortSignal) =>
    request<PlayerProfile>(`/players/${encodeURIComponent(steamId)}`, { signal }),
  avatarCacheStatus: (signal?: AbortSignal) =>
    request<AvatarCacheStatus>('/avatar-cache', { signal }),
  clearAvatarCache: (signal?: AbortSignal) =>
    request<AvatarCacheCleanup>('/avatar-cache', { method: 'DELETE', signal }),
  playbackStatus: (signal?: AbortSignal) =>
    request<DemoPlaybackStatus>('/playback/status', { signal }),
  preflightDemo: (
    id: string,
    options: DemoPlaybackOptions = {},
    signal?: AbortSignal,
  ) => request<DemoPlaybackPreflight>(
    `/demos/${encodeURIComponent(id)}/playback/preflight`,
    { method: 'POST', body: options, signal, timeoutMs: 120_000 },
  ),
  playDemo: (
    id: string,
    options: DemoPlaybackOptions = {},
  ) => request<DemoPlaybackLaunch>(
    `/demos/${encodeURIComponent(id)}/play`,
    { method: 'POST', body: options, timeoutMs: 600_000 },
  ),
  stopPlayback: () => request<DemoPlaybackStop>(
    '/playback/stop',
    { method: 'POST', body: {}, timeoutMs: 15_000 },
  ),
  analyzeDemo: async (id: string, signal?: AbortSignal) => {
    const record = await request<MatchAnalysisRecord>(`/demos/${encodeURIComponent(id)}/analysis`, {
      method: 'POST',
      body: {},
      signal,
      timeoutMs: 120_000,
    });
    return normalizeAnalysis(record);
  },
  getAnalysis: (id: string, signal?: AbortSignal) =>
    request<AnalysisWorkspace>(`/demos/${encodeURIComponent(id)}/analysis`, { signal }),
  reviewDemo: (id: string, body: LlmReviewRequest, signal?: AbortSignal) =>
    request<LlmReviewResult>(`/demos/${encodeURIComponent(id)}/review`, {
      method: 'POST',
      body,
      signal,
      timeoutMs: 60_000,
    }),
  inspectCosmetics: (id: string, signal?: AbortSignal) =>
    request<CosmeticInspectionReport>(`/demos/${encodeURIComponent(id)}/cosmetics`, {
      signal,
      timeoutMs: 120_000,
    }),
  getCosmeticCatalog: (signal?: AbortSignal) =>
    request<CosmeticCatalog>('/cosmetics/catalog', { signal, timeoutMs: 120_000 }),
  cosmeticImageUrl: (itemDefinitionIndex: number, paintKit: number) =>
    apiMediaUrl(`/api/cosmetics/catalog/items/${itemDefinitionIndex}/paint-kits/${paintKit}/image`),
  listCosmeticPlans: (id: string, signal?: AbortSignal) =>
    request<CosmeticPlan[]>(`/demos/${encodeURIComponent(id)}/cosmetics/plans`, { signal }),
  createCosmeticPlan: (
    id: string,
    body: { name: string; patches: CosmeticRewriteRequest['patches'] },
  ) => request<CosmeticPlan>(`/demos/${encodeURIComponent(id)}/cosmetics/plans`, {
    method: 'POST',
    body,
  }),
  updateCosmeticPlan: (
    id: string,
    planId: string,
    body: { name: string; patches: CosmeticRewriteRequest['patches'] },
  ) => request<CosmeticPlan>(
    `/demos/${encodeURIComponent(id)}/cosmetics/plans/${encodeURIComponent(planId)}`,
    { method: 'PUT', body },
  ),
  deleteCosmeticPlan: (id: string, planId: string) => request<void>(
    `/demos/${encodeURIComponent(id)}/cosmetics/plans/${encodeURIComponent(planId)}`,
    { method: 'DELETE' },
  ),
  rewriteCosmetics: (id: string, body: CosmeticRewriteRequest) =>
    request<CosmeticRewriteResponse>(`/demos/${encodeURIComponent(id)}/cosmetics/rewrite`, {
      method: 'POST',
      body,
      timeoutMs: 600_000,
    }),
  getReplay: async (id: string, signal?: AbortSignal) => {
    const payload = await request<ReplayPayload>(`/demos/${encodeURIComponent(id)}/replay`, { signal });
    return {
      ...payload,
      frames: payload.frames.map((frame: ReplayFrameRecord) => ({
        ...frame,
        players: frame.players.map((player) => ({ ...player, team: requireSide(player.team) })),
      })),
    };
  },
  getReplayBinary: (id: string, signal?: AbortSignal) =>
    requestBinary(`/demos/${encodeURIComponent(id)}/replay.bin`, signal),
  replayCacheStatus: (signal?: AbortSignal) =>
    request<ReplayCacheStatus>('/replay-cache', { signal }),
  clearReplayCache: () =>
    request<ReplayCacheCleanup>('/replay-cache', { method: 'DELETE' }),
  getHeatmap: (id: string, signal?: AbortSignal) =>
    request<HeatPointRecord[]>(`/demos/${encodeURIComponent(id)}/heatmap`, { signal }),
  getRadarOverview: (mapName: string, signal?: AbortSignal) =>
    request<RadarOverviewRecord>(
      `/maps/${encodeURIComponent(mapName)}/radar/metadata`,
      { signal },
    ),
  planRecording: (body: RecordingQueueRequest) =>
    request<RecordingPlanResponse>('/recording/plan', { method: 'POST', body }),
  calibrateRecordingLatency: (body: { samples: CaptureLatencySample[] }) =>
    request<CaptureLatencyCalibration>('/recording/calibration', { method: 'POST', body }),
  executeRecordingQueue: (body: RecordingQueueRequest) =>
    request<RecordingExecutionResponse>('/recording/queue', { method: 'POST', body }),
  getRecordingJob: (id: string, signal?: AbortSignal) =>
    request<RecordingJob>(`/recording/jobs/${encodeURIComponent(id)}`, { signal }),
  cancelRecordingJob: (id: string) =>
    request<RecordingJob>(`/recording/jobs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: {},
    }),
  runtimeState: (signal?: AbortSignal) => request<RuntimeState>('/app/runtime-state', { signal }),
  abortRecording: () => request<void>('/recording/abort', { method: 'POST', body: {} }),
  listRecordedClips: async (signal?: AbortSignal) => {
    const page = await request<Paginated<RecordedClipRecord>>('/recorded-clips', { signal });
    return { ...page, items: page.items.map(normalizeRecordedClip) };
  },
  exportMontage: (body: MontageExportRequest) =>
    request<JobAccepted>('/montage/export', { method: 'POST', body, timeoutMs: 30_000 }),
  createMontageProject: (body: CreateMontageProject) =>
    request<MontageProjectRecord>('/montage/projects', { method: 'POST', body }),
  exportMontageProject: (id: string) =>
    request<JobAccepted>(`/montage/projects/${encodeURIComponent(id)}/export`, {
      method: 'POST',
      body: {},
      timeoutMs: 30_000,
    }),
  listEditorProjects: (signal?: AbortSignal) =>
    request<{ items: EditorProject[] }>('/editor/projects', { signal }),
  getEditorProject: (id: string, signal?: AbortSignal) =>
    request<EditorProject>(`/editor/projects/${encodeURIComponent(id)}`, { signal }),
  listMediaAssets: (projectId?: string, signal?: AbortSignal) =>
    request<{ items: MediaAsset[] }>(
      `/media/assets${queryString({ project_id: projectId })}`,
      { signal },
    ),
  uploadMediaAssets: (files: File[], projectId?: string) => {
    const body = new FormData();
    if (projectId) body.append('project_id', projectId);
    files.forEach((file) => body.append('files', file));
    return request<{ items: MediaAsset[] }>('/media/assets', {
      method: 'POST',
      body,
      timeoutMs: 120_000,
    });
  },
  createEditorProject: (project: CreateEditorProject) =>
    request<EditorProject>('/editor/projects', { method: 'POST', body: project }),
  duplicateEditorProject: (projectId: string, name: string, asTemplate = false) =>
    request<EditorProject>(`/editor/projects/${encodeURIComponent(projectId)}/duplicate`, {
      method: 'POST',
      body: { name, as_template: asTemplate },
    }),
  saveEditorProject: (project: EditorProject) =>
    request<EditorProject>(`/editor/projects/${encodeURIComponent(project.id)}`, {
      method: 'PATCH',
      body: project,
    }),
  listEditorPresets: (signal?: AbortSignal) =>
    request<{ items: EditorPreset[] }>('/editor/presets', { signal }),
  createEditorPreset: (name: string, document: EditorPresetDocument) =>
    request<EditorPreset>('/editor/presets', {
      method: 'POST',
      body: { name, document },
    }),
  updateEditorPreset: (preset: EditorPreset) =>
    request<EditorPreset>(`/editor/presets/${encodeURIComponent(preset.id)}`, {
      method: 'PUT',
      body: {
        name: preset.name,
        expected_revision: preset.revision,
        document: preset.document,
      },
    }),
  deleteEditorPreset: (id: string, expectedRevision: number) =>
    request<void>(
      `/editor/presets/${encodeURIComponent(id)}${queryString({ expected_revision: expectedRevision })}`,
      { method: 'DELETE' },
    ),
  applyEditorPreset: (
    projectId: string,
    clipId: string,
    presetId: string,
    expectedProjectRevision: number,
    expectedPresetRevision: number,
  ) => request<EditorProject>(
    `/editor/projects/${encodeURIComponent(projectId)}/clips/${encodeURIComponent(clipId)}/apply-preset`,
    {
      method: 'POST',
      body: {
        preset_id: presetId,
        expected_project_revision: expectedProjectRevision,
        expected_preset_revision: expectedPresetRevision,
      },
    },
  ),
  deleteEditorProjects: (items: Array<{ id: string; expected_revision: number }>) =>
    request<EditorProjectDeletionResult>('/editor/projects/delete-batch', {
      method: 'POST',
      body: { items },
      timeoutMs: 120_000,
    }),
  exportEditorPackage: (projectId: string, outputPath?: string) =>
    request<EditorPackageExport>(
      `/editor/projects/${encodeURIComponent(projectId)}/package`,
      {
        method: 'POST',
        body: { output_path: outputPath ?? null },
        timeoutMs: 10 * 60_000,
      },
    ),
  importEditorPackagePath: (path: string) =>
    request<EditorPackageImport>('/editor/packages/import', {
      method: 'POST',
      body: { path },
      timeoutMs: 10 * 60_000,
    }),
  uploadEditorPackage: (file: File) => {
    const body = new FormData();
    body.append('file', file);
    return request<EditorPackageImport>('/editor/packages/upload', {
      method: 'POST',
      body,
      timeoutMs: 10 * 60_000,
    });
  },
  listEditorSnapshots: (projectId: string, signal?: AbortSignal) =>
    request<{ items: EditorProjectSnapshot[] }>(
      `/editor/projects/${encodeURIComponent(projectId)}/snapshots`,
      { signal },
    ),
  restoreEditorSnapshot: (projectId: string, snapshotId: string) =>
    request<EditorProject>(
      `/editor/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
      { method: 'POST', body: {} },
    ),
  exportEditorProject: (projectId: string, options: EditorExportOptions) =>
    request<JobAccepted>(`/editor/projects/${encodeURIComponent(projectId)}/export`, {
      method: 'POST',
      body: options,
    }),
  getAssetWaveform: (id: string, buckets = 120, signal?: AbortSignal) =>
    request<WaveformResponse>(
      `/media/assets/${encodeURIComponent(id)}/waveform${queryString({ buckets })}`,
      { signal, timeoutMs: 90_000 },
    ),
  getMediaAsset: (id: string, signal?: AbortSignal) =>
    request<MediaAsset>(`/media/assets/${encodeURIComponent(id)}`, { signal }),
  separateEditorAudio: (
    projectId: string,
    clipId: string,
    expectedRevision: number,
    muteSource = true,
  ) =>
    request<EditorAudioSeparation>(
      `/editor/projects/${encodeURIComponent(projectId)}/clips/${encodeURIComponent(clipId)}/separate-audio`,
      {
      method: 'POST',
      body: { expected_revision: expectedRevision, mute_source: muteSource },
      timeoutMs: 60 * 60_000,
      },
    ),
  relinkMediaAsset: (id: string, path: string) =>
    request<MediaAsset>(`/media/assets/${encodeURIComponent(id)}/relink`, {
      method: 'POST',
      body: { path },
      timeoutMs: 90_000,
    }),
  replaceMediaAsset: (id: string, file: File) => {
    const body = new FormData();
    body.append('file', file);
    return request<MediaAsset>(`/media/assets/${encodeURIComponent(id)}/replace`, {
      method: 'POST',
      body,
      timeoutMs: 120_000,
    });
  },
  generateMediaProxy: (id: string) =>
    request<MediaAsset>(`/media/assets/${encodeURIComponent(id)}/proxy`, {
      method: 'POST',
      body: {},
      timeoutMs: 20 * 60_000,
    }),
  cleanupMediaProxies: () =>
    request<MediaProxyCleanup>('/media/proxies/cleanup', {
      method: 'POST',
      body: {},
      timeoutMs: 120_000,
    }),
  getRecordedClipWaveform: (id: string, buckets = 120, signal?: AbortSignal) =>
    request<WaveformResponse>(
      `/recorded-clips/${encodeURIComponent(id)}/waveform${queryString({ buckets })}`,
      { signal, timeoutMs: 90_000 },
    ),
  getExportJob: (id: string, signal?: AbortSignal) =>
    request<ExportJobRecord>(`/exports/${encodeURIComponent(id)}`, { signal }),
  cancelExportJob: (id: string) =>
    request<ExportJobRecord>(`/exports/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: {},
    }),
  listOutputs: (query: OutputQuery = {}, signal?: AbortSignal) =>
    request<OutputPage>(
      `/outputs${queryString({
        page: query.page,
        page_size: query.page_size,
        kind: query.kind,
        status: query.status,
        availability: query.availability,
        search: query.search,
      })}`,
      { signal },
    ),
  renameOutput: (kind: OutputKind, id: string, fileName: string) =>
    request<OutputItem>(`/outputs/${kind}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { file_name: fileName },
    }),
  deleteOutput: (kind: OutputKind, id: string, deleteFile = false) =>
    request<DeleteOutputResult>(
      `/outputs/${kind}/${encodeURIComponent(id)}?delete_file=${String(deleteFile)}`,
      { method: 'DELETE' },
    ),
  batchDeleteOutputs: (items: OutputReference[], deleteFiles = false) =>
    request<BatchDeleteOutputResult>('/outputs/batch-delete', {
      method: 'POST',
      body: { items, delete_files: deleteFiles },
    }),
  cleanupMissingOutputs: (kind?: OutputKind) =>
    request<CleanupMissingOutputsResult>('/outputs/cleanup-missing', {
      method: 'POST',
      body: kind ? { kind } : {},
    }),
  cleanupStagedOutputs: () =>
    request<CleanupStagedOutputsResult>('/outputs/cleanup-staged', {
      method: 'POST',
      body: {},
    }),
  getConfig: (signal?: AbortSignal) => request<AppConfig>('/config', { signal }),
  detectPaths: () => request<DetectedPaths>('/config/detect-paths', { method: 'POST', body: {} }),
  storageStatus: (signal?: AbortSignal) => request<StorageStatus>('/storage/status', { signal }),
  updateConfig: (config: AppConfig) =>
    request<AppConfig>('/config', { method: 'PUT', body: config }),
  testObs: (obs: AppConfig['obs']) =>
    request<ObsRecordStatus>('/obs/test', { method: 'POST', body: obs }),
  getObsStatus: (signal?: AbortSignal) =>
    request<ObsRecordStatus>('/obs/status', { signal }),
  startObs: () =>
    request<ObsStartResponse>('/obs/start', { method: 'POST', body: {} }),
  diagnoseObs: (signal?: AbortSignal) =>
    request<ObsDiagnosis>('/obs/diagnose', { method: 'POST', body: {}, signal }),
  getObsVideoTuningPlan: (signal?: AbortSignal) =>
    request<ObsVideoTuningPlan>('/obs/video-tuning/plan', { signal }),
  applyObsVideoTuningPlan: (expectedFingerprint: string) =>
    request<ObsVideoApplyResult>('/obs/video-tuning/apply', {
      method: 'POST',
      body: { confirm: true, expected_fingerprint: expectedFingerprint },
    }),
  listObsVideoBackups: (signal?: AbortSignal) =>
    request<ObsVideoBackup[]>('/obs/video-tuning/backups', { signal }),
  restoreObsVideoBackup: (id: string) =>
    request<ObsVideoRestoreResult>(
      `/obs/video-tuning/backups/${encodeURIComponent(id)}/restore`,
      { method: 'POST', body: { confirm: true } },
    ),
  deleteObsVideoBackup: (id: string) =>
    request<ObsVideoBackupDeleteResult>(
      `/obs/video-tuning/backups/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  testLlm: (llm: AppConfig['llm']) =>
    request<unknown>('/llm/test', { method: 'POST', body: llm }),
  listMatchHistory: (page = 1, pageSize = 50, signal?: AbortSignal) =>
    request<Paginated<MatchHistoryItem>>(
      `/match-history/matches${queryString({ page, page_size: pageSize })}`,
      { signal },
    ),
  syncMatchHistory: () =>
    request<MatchHistorySyncResult>('/match-history/sync', {
      method: 'POST',
      body: {},
      timeoutMs: 120_000,
    }),
  testMatchHistory: (steam: AppConfig['steam']) =>
    request<unknown>('/match-history/test', {
      method: 'POST',
      body: steam,
    }),
  downloadMatchDemo: (matchId: string) =>
    request<MatchDownloadJob>(
      '/match-history/download',
      { method: 'POST', body: { match_id: matchId }, timeoutMs: 120_000 },
    ),
  getMatchDownloadJob: (jobId: string, signal?: AbortSignal) =>
    request<MatchDownloadJob>(`/match-history/download/${encodeURIComponent(jobId)}`, { signal }),
  cancelMatchDownload: (jobId: string) =>
    request<MatchDownloadJob>(`/match-history/download/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
    }),
  disconnectMatchHistory: () =>
    request<{ disconnected: boolean }>('/match-history/credentials', { method: 'DELETE' }),
  recoveryStatus: (signal?: AbortSignal) =>
    request<RecoveryStatus>('/config-backup/status', { signal }),
  recoverConfiguration: () =>
    request<RecoveryStatus>('/config-backup/restore', { method: 'POST', body: {} }),
};

export function readableError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return msg("m0324");
}
