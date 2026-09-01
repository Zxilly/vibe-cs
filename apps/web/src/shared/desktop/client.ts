import { Channel, invoke } from '@tauri-apps/api/core';

import { t } from '@lingui/core/macro';
import { parseActivityFeed, parseActivityItem } from './activityContract';
import { parseAnalysisRun, parseAnalysisRunDetail } from './analysisRunContract';
import { parseDemoMetadata, parseDemoMetadataBatch } from './demoMetadataContract';
import { parseLineupDirectoryPage, parseLineupMapPage } from './lineupContract';
import {
  parsePlayerComparison,
  parsePlayerDirectoryPage,
  parsePlayerHeatmap,
  parsePlayerMapPage,
  parsePlayerMatchPage,
  parsePlayerProfile,
} from './playerContract';
import {
  parsePlayerReviewMetadata,
  parseReviewTag,
  parseReviewTagCatalog,
  parseRoundReviewMetadata,
} from './reviewMetadataContract';
import type {
  ActivityKind,
  ActivityQuery,
  AgentChatInput,
  AgentChatResult,
  AgentEvent,
  AgentSession,
  AgentSessionEntry,
  AgentSessionEntryDraft,
  AgentSessionExport,
  AgentSessionPage,
  AgentSessionPurge,
  AgentSessionQuery,
  AgentSessionStorageStats,
  AgentStatus,
  AgentTurnUpdate,
  AgentWorkspaceSettings,
  AnalysisRun,
  AnalysisRunDetail,
  ApiHealth,
  AppConfig,
  AudioAnalysis,
  AudioAnalysisOptions,
  AvatarCacheCleanup,
  AvatarCacheStatus,
  BatchDeleteOutputResult,
  BeatAlignmentDraft,
  BeatAlignmentRequest,
  CleanupMissingOutputsResult,
  CleanupStagedOutputsResult,
  CreateProjectRequest,
  CosmeticCatalog,
  CosmeticInspectionReport,
  CosmeticPlan,
  CosmeticRewriteRequest,
  CosmeticRewriteResponse,
  CreateEvidenceAnnotation,
  DeleteOutputResult,
  DemoMetadata,
  DemoMetadataBatchUpdate,
  DemoMetadataUpdate,
  DemoPlaybackLaunch,
  DemoPlaybackOptions,
  DemoPlaybackPreflight,
  DemoPlaybackStatus,
  DemoPlaybackStop,
  DemoQuery,
  DemoRecord,
  DemoUpdate,
  DemoWatchStatus,
  DetectedPaths,
  EvidenceAnnotation,
  EvidenceAnnotationQuery,
  EvidenceSearchQuery,
  EvidenceSearchResponse,
  ExportJobRecord,
  HeatPointRecord,
  HlaeBundleHandoff,
  HlaeStatus,
  LineupDirectoryPage,
  LineupMapPage,
  LlmReviewRequest,
  LlmReviewResult,
  LlmTestResult,
  MatchAnalysisRecord,
  MatchDownloadJob,
  MatchHistoryItem,
  MatchHistorySyncResult,
  EditorMarker,
  MediaAsset,
  MediaProxyCleanup,
  OutputItem,
  OutputKind,
  OutputPage,
  OutputQuery,
  OutputReference,
  Paginated,
  PlayerComparison,
  PlayerDirectoryPage,
  PlayerHeatmap,
  PlayerMapPage,
  PlayerMatchPage,
  PlayerProfile,
  PlayerReviewMetadata,
  Project,
  ProjectChangeGroup,
  ProjectDeliveryGate,
  ProjectEditLease,
  ProjectEditLeaseResponse,
  ProjectPatch,
  ProjectPatchResult,
  AcquireProjectEditLeaseRequest,
  HeartbeatProjectEditLeaseRequest,
  QuickCheckResponse,
  RadarOverviewRecord,
  RecordedClipRecord,
  RecordingExecutionResponse,
  RecordingJob,
  RecordingPlanResponse,
  RecoveryStatus,
  ReplayCacheCleanup,
  ReplayCacheStatus,
  ReviewMetadataUpdate,
  ReviewTag,
  ReviewTagCreate,
  RoundReviewMetadata,
  RuntimeState,
  ScanResult,
  StorageStatus,
  UpdateEvidenceAnnotation,
  WaveformResponse,
} from './dto';
import type { DiagnosticExport } from './product';
import type { ActivityFeed, ActivityItem } from './viewModels';
import type { AnalysisWorkspace, DemoSummary, RecordedClip } from './viewModels';

export class DesktopError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'DesktopError';
    this.status = status;
    this.code = code;
  }
}

type RequestOptions = Omit<RequestInit, 'body' | 'signal' | 'headers'> & {
  body?: unknown;
  /** Null keeps a state-changing native invocation attached until it settles. */
  timeoutMs?: number | null;
  signal?: AbortSignal | undefined;
};

const RESOURCE_PREFIX = '/api';

/** Build a URL owned by the desktop media protocol without accepting an arbitrary origin. */
export function desktopMediaUrl(path: string): string {
  if (path.startsWith(`${RESOURCE_PREFIX}/`)) {
    const managedPath = path.slice(RESOURCE_PREFIX.length);
    const origin = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)
      ? 'http://vibe-cs-media.localhost'
      : 'vibe-cs-media://localhost';
    return `${origin}${managedPath}`;
  }
  throw new DesktopError(t`媒体地址不是本地服务路径。`, 0, 'INVALID_MEDIA_URL');
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    body: requestBody,
    timeoutMs = 15_000,
    signal: callerSignal,
    method = 'GET',
  } = options;
  if (callerSignal?.aborted) {
    throw new DesktopError(t`请求超时或已取消，请稍后重试。`, 0, 'REQUEST_ABORTED');
  }
  if (requestBody instanceof FormData) {
    throw new DesktopError(t`无法连接到本地服务，请确认服务正在运行。`, 0, 'NATIVE_UPLOAD_REQUIRED');
  }
  const controller = new AbortController();
  const timer = timeoutMs === null
    ? null
    : globalThis.setTimeout(() => controller.abort(), timeoutMs);

  const abortFromCaller = () => controller.abort();
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const invocation = invoke<T>('desktop_call', {
      call: {
        method: method.toLocaleLowerCase(),
        path,
        ...(requestBody === undefined ? {} : { body: requestBody }),
      },
    });
    const cancellation = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new DesktopError(t`请求超时或已取消，请稍后重试。`, 0, 'REQUEST_ABORTED'));
      }, { once: true });
    });
    return await Promise.race([invocation, cancellation]);
  } catch (error) {
    if (error instanceof DesktopError) throw error;
    if (isDesktopCommandFailure(error)) {
      throw new DesktopError(error.message, error.status, error.code);
    }
    throw new DesktopError(t`无法连接到本地服务，请确认服务正在运行。`, 0, 'DESKTOP_COMMAND_FAILED');
  } finally {
    if (timer !== null) globalThis.clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}

async function requestBinary(path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), 60_000);
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const invocation = invoke<ArrayBuffer>('desktop_binary', { path });
    const cancellation = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new DesktopError(t`请求超时或已取消，请稍后重试。`, 0, 'REQUEST_ABORTED'));
      }, { once: true });
    });
    const buffer = await Promise.race([invocation, cancellation]);
    if (buffer.byteLength > 128 * 1024 * 1024) throw new DesktopError(t`二进制回放超过 128 MiB 上限。`, 413, 'REPLAY_TOO_LARGE');
    return buffer;
  } finally {
    globalThis.clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

interface DesktopCommandFailure {
  status: number;
  code: string;
  message: string;
}

function isDesktopCommandFailure(value: unknown): value is DesktopCommandFailure {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DesktopCommandFailure>;
  return typeof candidate.status === 'number'
    && typeof candidate.code === 'string'
    && typeof candidate.message === 'string';
}

function utf8Hex(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function uploadNativeFile<T>(path: string, file: File, projectId?: string): Promise<T> {
  try {
    return await invoke<T>(
      'desktop_upload',
      await file.arrayBuffer(),
      {
        headers: {
          'x-vibe-upload-path': path,
          'x-vibe-filename-hex': utf8Hex(file.name),
          ...(projectId ? { 'x-vibe-project-id': projectId } : {}),
        },
      },
    );
  } catch (error) {
    if (isDesktopCommandFailure(error)) throw new DesktopError(error.message, error.status, error.code);
    throw new DesktopError(t`无法连接到本地服务，请确认服务正在运行。`, 0, 'DESKTOP_UPLOAD_FAILED');
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
  const wire = record as unknown as Record<string, unknown>;
  if (!Array.isArray(record.players) || Object.hasOwn(wire, 'player_names')) {
    throw new DesktopError(
      'Demo response does not match the current contract.',
      502,
      'INVALID_DEMO_CONTRACT',
    );
  }
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
    path: record.path,
    filename: record.file_name,
    display_name: record.display_name,
    map_name: record.map_name ?? 'unknown',
    match_date: record.match_date,
    cataloged_at: record.created_at,
    duration_seconds: record.duration_seconds ?? 0,
    total_rounds: record.total_rounds ?? 0,
    score_team_a: record.team_a_score,
    score_team_b: record.team_b_score,
    team_a_name: record.team_a_name?.trim() || null,
    team_b_name: record.team_b_name?.trim() || null,
    status: statusMap[record.status],
    lifecycle_status: record.status,
    players: record.players,
    source: record.source === 'watch' || record.source === 'upload' ? record.source : 'local',
    remark: record.remark,
    updated_at: record.updated_at,
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
  if (!side) throw new DesktopError(t`分析响应包含未知阵营：${String(value)}`, 502, 'INVALID_TEAM_SIDE');
  return side;
}

export function normalizeAnalysis(record: MatchAnalysisRecord): AnalysisWorkspace {
  if (
    !Object.hasOwn(record, 'verified_total_ticks')
    || !Object.hasOwn(record, 'insights')
    || record.insights == null
  ) {
    throw new DesktopError(
      'Analysis response does not match the current contract.',
      502,
      'INVALID_ANALYSIS_CONTRACT',
    );
  }
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
    insights: record.insights,
    players: record.players.map((player) => ({
      id: player.steam_id,
      name: player.name,
      team: requireSide(player.team),
      kills: player.kills,
      deaths: player.deaths,
      assists: player.assists,
      headshot_rate: player.kills > 0 ? player.headshots / player.kills : 0,
      kill_death_ratio: player.kill_death_ratio,
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
    player_name: record.player_name ?? t`未知玩家`,
    map_name: record.map_name || 'unknown',
    duration_seconds: record.duration_seconds,
    created_at: record.created_at,
    stream_url: record.stream_url,
  };
}

function configUpdatePayload(config: AppConfig): AppConfig {
  return {
    locale: config.locale,
    theme: config.theme,
    update_manifest_url: config.update_manifest_url,
    data_dir: config.data_dir,
    demo_watch_paths: config.demo_watch_paths,
    cs2_path: config.cs2_path,
    steam_path: config.steam_path,
    steam: config.steam,
    steam_has_web_api_key: config.steam_has_web_api_key,
    steam_has_authentication_code: config.steam_has_authentication_code,
    steam_has_share_code: config.steam_has_share_code,
    llm: config.llm,
    llm_has_api_key: config.llm_has_api_key,
    clear_llm_api_key: config.clear_llm_api_key,
    recording: {
      pre_roll_seconds: config.recording.pre_roll_seconds,
      post_roll_seconds: config.recording.post_roll_seconds,
      resolution: config.recording.resolution,
      fps: config.recording.fps,
      show_radar: config.recording.show_radar,
      show_hud: config.recording.show_hud,
      voice: config.recording.voice,
      camera_fov: config.recording.camera_fov,
      viewmodel_fov: config.recording.viewmodel_fov,
      flash_alpha: config.recording.flash_alpha,
    },
  };
}

const DEFAULT_AUDIO_ANALYSIS_OPTIONS: AudioAnalysisOptions = {
  sample_rate: 11_025,
  maximum_duration_seconds: 30 * 60,
  maximum_beats: 4_096,
  maximum_onsets: 4_096,
  energy_points: 512,
  maximum_sections: 24,
};

export const commands = {
  agentStatus: () => invoke<AgentStatus>('agent_status'),
  cancelAgentChat: (requestId: string) => invoke<boolean>('agent_cancel', { requestId }),
  streamAgentChat: async (input: AgentChatInput, onEvent: (event: AgentEvent) => void) => {
    const channel = new Channel<AgentEvent>();
    channel.onmessage = onEvent;
    try {
      return await invoke<AgentChatResult>('agent_chat', { input, onEvent: channel });
    } catch (error) {
      if (isDesktopCommandFailure(error)) throw new DesktopError(error.message, error.status, error.code);
      throw new DesktopError(t`无法连接到本地服务，请确认服务正在运行。`, 0, 'AGENT_COMMAND_FAILED');
    }
  },
  // --- Agent session layer (spec §4.6). Plain routes under the one desktop_call. ---
  /** Session drawer list and search over session title, Demo and player. */
  listAgentSessions: (query: AgentSessionQuery = {}, signal?: AbortSignal) =>
    request<AgentSessionPage>(
      `/agent/sessions${queryString({ q: query.q ?? undefined, limit: query.limit ?? undefined })}`,
      { signal },
    ),
  createAgentSession: (title: string) =>
    request<AgentSession>('/agent/sessions', { method: 'POST', body: { title } }),
  getAgentSession: (sessionId: string, signal?: AbortSignal) =>
    request<AgentSession>(`/agent/sessions/${encodeURIComponent(sessionId)}`, { signal }),
  renameAgentSession: (sessionId: string, title: string) =>
    request<AgentSession>(`/agent/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH', body: { title },
    }),
  /** Removes the conversation only; referenced plans, tasks and outputs stay. */
  deleteAgentSession: (sessionId: string) =>
    request<void>(`/agent/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
  appendAgentSessionEntry: (sessionId: string, draft: AgentSessionEntryDraft) =>
    request<AgentSessionEntry>(`/agent/sessions/${encodeURIComponent(sessionId)}/entries`, {
      method: 'POST', body: draft,
    }),
  updateAgentTurn: (sessionId: string, entryId: string, update: AgentTurnUpdate) =>
    request<AgentSessionEntry>(
      `/agent/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(entryId)}`,
      { method: 'PUT', body: update },
    ),
  listProjects: (signal?: AbortSignal) => request<Project[]>('/projects', { signal }),
  getProject: (projectId: string, signal?: AbortSignal) =>
    request<Project>(`/projects/${encodeURIComponent(projectId)}`, { signal }),
  getProjectDeliveryGate: (projectId: string, signal?: AbortSignal) =>
    request<ProjectDeliveryGate>(`/projects/${encodeURIComponent(projectId)}/delivery-gate`, { signal }),
  createProject: (requestBody: CreateProjectRequest) =>
    request<Project>('/projects', { method: 'POST', body: requestBody }),
  createProjectRecordingPlan: (projectId: string, clipIds: string[] = []) =>
    request<RecordingPlanResponse>(
      `/projects/${encodeURIComponent(projectId)}/recording-plan`,
      { method: 'POST', body: { clip_ids: clipIds }, timeoutMs: null },
    ),
  exportProject: (
    projectId: string,
    options: { encoder: string; quality: number; range_start_seconds?: number | null; range_end_seconds?: number | null },
  ) => request<{ job_id: string; status: string }>(
    `/projects/${encodeURIComponent(projectId)}/export`,
    { method: 'POST', body: { confirm: true, ...options }, timeoutMs: null },
  ),
  applyProjectPatch: (patch: ProjectPatch) =>
    request<ProjectPatchResult>(`/projects/${encodeURIComponent(patch.project_id)}`, {
      method: 'PATCH', body: patch,
    }),
  listProjectChangeGroups: (projectId: string, signal?: AbortSignal) =>
    request<ProjectChangeGroup[]>(
      `/projects/${encodeURIComponent(projectId)}/change-groups`,
      { signal },
    ),
  revertProjectChangeGroup: (projectId: string, changeGroupId: string, expectedRevision: number) =>
    request<ProjectPatchResult>(
      `/projects/${encodeURIComponent(projectId)}/change-groups/${encodeURIComponent(changeGroupId)}/revert`,
      { method: 'POST', body: { expected_revision: expectedRevision } },
    ),
  getProjectEditLease: (projectId: string, signal?: AbortSignal) =>
    request<ProjectEditLease | null>(
      `/projects/${encodeURIComponent(projectId)}/edit-lease`,
      { signal },
    ),
  acquireProjectEditLease: (projectId: string, requestBody: AcquireProjectEditLeaseRequest) =>
    request<ProjectEditLeaseResponse>(`/projects/${encodeURIComponent(projectId)}/edit-lease`, {
      method: 'POST', body: requestBody,
    }),
  heartbeatProjectEditLease: (
    projectId: string,
    leaseId: string,
    requestBody: HeartbeatProjectEditLeaseRequest,
  ) => request<void>(
    `/projects/${encodeURIComponent(projectId)}/edit-lease/${encodeURIComponent(leaseId)}`,
    { method: 'PUT', body: requestBody },
  ),
  releaseProjectEditLease: (projectId: string, leaseId: string) => request<void>(
    `/projects/${encodeURIComponent(projectId)}/edit-lease/${encodeURIComponent(leaseId)}`,
    { method: 'DELETE' },
  ),
  getAgentWorkspaceSettings: (signal?: AbortSignal) =>
    request<AgentWorkspaceSettings>('/agent/workspace/settings', { signal }),
  updateAgentWorkspaceSettings: (settings: AgentWorkspaceSettings) =>
    request<AgentWorkspaceSettings>('/agent/workspace/settings', { method: 'PUT', body: settings }),
  getAgentSessionStorage: (signal?: AbortSignal) =>
    request<AgentSessionStorageStats>('/agent/workspace/storage', { signal }),
  exportAgentSessions: () =>
    request<AgentSessionExport>('/agent/workspace/storage/export', { timeoutMs: 60_000 }),
  clearAgentSessions: () =>
    request<AgentSessionPurge>('/agent/workspace/storage', { method: 'DELETE', timeoutMs: null }),
  applyAgentSessionRetention: () =>
    request<AgentSessionPurge>('/agent/workspace/storage/retention', {
      method: 'POST', timeoutMs: null,
    }),
  analyzeAudioAsset: (assetId: string, options?: AudioAnalysisOptions) =>
    request<AudioAnalysis>(`/media/assets/${encodeURIComponent(assetId)}/audio-analysis${queryString(options ?? DEFAULT_AUDIO_ANALYSIS_OPTIONS)}`),
  alignClipsToBeats: (body: BeatAlignmentRequest) =>
    request<BeatAlignmentDraft>('/media/audio/align-clips', { method: 'POST', body }),
  health: (signal?: AbortSignal) => request<ApiHealth>('/health', { signal }),
  quickCheck: (signal?: AbortSignal) =>
    request<QuickCheckResponse>('/config/quick-check', { signal }),
  listDemos: async (query: DemoQuery, signal?: AbortSignal) => {
    const page = await request<Paginated<DemoRecord>>(
      `/demos/compact${queryString({
        search: query.search,
        match_source: query.match_source,
        tag_id: query.tag_id,
        map_name: query.map_name,
        status: query.status,
        sort: query.sort,
        page: query.page,
        page_size: query.page_size,
      })}`,
      { signal },
    );
    return { ...page, items: page.items.map(normalizeDemo) };
  },
  getDemo: async (id: string, signal?: AbortSignal) => {
    const record = await request<DemoRecord>(`/demos/${encodeURIComponent(id)}`, { signal });
    return normalizeDemo(record);
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
  importDemos: async (files: File[]) => {
    const results = await Promise.all(
      files.map((file) => uploadNativeFile<ScanResult>('/demo/upload-multiple', file)),
    );
    return results.reduce<ScanResult>((total, result) => ({
      discovered: total.discovered + result.discovered,
      imported: total.imported + result.imported,
      updated: total.updated + result.updated,
      skipped: total.skipped + result.skipped,
      errors: [...total.errors, ...result.errors],
    }), { discovered: 0, imported: 0, updated: 0, skipped: 0, errors: [] });
  },
  updateDemo: async (id: string, update: DemoUpdate) => {
    const record = await request<DemoRecord>(`/demos/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: update,
    });
    return normalizeDemo(record);
  },
  getDemoMetadata: async (id: string, signal?: AbortSignal): Promise<DemoMetadata> =>
    parseDemoMetadata(
      await request<unknown>(`/demos/${encodeURIComponent(id)}/metadata`, { signal }),
      id,
    ),
  updateDemoMetadata: async (id: string, update: DemoMetadataUpdate): Promise<DemoMetadata> =>
    parseDemoMetadata(
      await request<unknown>(`/demos/${encodeURIComponent(id)}/metadata`, {
        method: 'PUT',
        body: update,
      }),
      id,
    ),
  updateDemoMetadataBatch: async (update: DemoMetadataBatchUpdate): Promise<DemoMetadata[]> =>
    parseDemoMetadataBatch(
      await request<unknown>('/demos/metadata/batch', { method: 'POST', body: update }),
      update.demo_ids,
    ),
  exportDemos: (format: 'json' | 'xlsx', query: DemoQuery, signal?: AbortSignal) =>
    requestBinary(`/demos/export${queryString({
      format,
      search: query.search,
      match_source: query.match_source,
      tag_id: query.tag_id,
      map_name: query.map_name,
      status: query.status,
      sort: query.sort,
    })}`, signal),
  listReviewTags: async (signal?: AbortSignal): Promise<ReviewTag[]> =>
    parseReviewTagCatalog(await request<unknown>('/review-tags', { signal })),
  createReviewTag: async (input: ReviewTagCreate): Promise<ReviewTag> =>
    parseReviewTag(await request<unknown>('/review-tags', { method: 'POST', body: input })),
  updateReviewTag: async (id: string, input: ReviewTagCreate): Promise<ReviewTag> =>
    parseReviewTag(await request<unknown>(`/review-tags/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: input,
    })),
  deleteReviewTag: (id: string) =>
    request<void>(`/review-tags/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  deleteDemo: (id: string) =>
    request<void>(`/demos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listLineups: async (query: { search: string; page: number; page_size: number }, signal?: AbortSignal) =>
    parseLineupDirectoryPage(await request<LineupDirectoryPage>(
      `/lineups${queryString(query)}`, { signal },
    )),
  listLineupMaps: async (lineupId: string, query: { page: number; page_size: number }, signal?: AbortSignal) =>
    parseLineupMapPage(await request<LineupMapPage>(
      `/lineups/${encodeURIComponent(lineupId)}/maps${queryString(query)}`, { signal },
    ), lineupId),
  listPlayers: async (
    query: {
      search?: string;
      page?: number;
      page_size?: number;
      sort: 'player' | 'team' | 'matches' | 'kd' | 'kills' | 'deaths' | 'assists' | 'headshots' | 'adr' | 'damage' | 'last_match';
      direction: 'asc' | 'desc';
    },
    signal?: AbortSignal,
  ) => parsePlayerDirectoryPage(await request<PlayerDirectoryPage>(
    `/players${queryString({
      search: query.search,
      page: query.page,
      page_size: query.page_size,
      sort: query.sort,
      direction: query.direction,
    })}`,
    { signal },
  )),
  getPlayer: async (steamId: string, signal?: AbortSignal) => {
    const profile = parsePlayerProfile(await request<PlayerProfile>(
      `/players/${encodeURIComponent(steamId)}`,
      { signal },
    ));
    if (profile.player.steam_id !== steamId) {
      throw new Error('Player response does not match the requested exact player.');
    }
    return profile;
  },
  getPlayerReviewMetadata: async (
    steamId: string,
    signal?: AbortSignal,
  ): Promise<PlayerReviewMetadata> => parsePlayerReviewMetadata(
    await request<unknown>(`/players/${encodeURIComponent(steamId)}/metadata`, { signal }),
    steamId,
  ),
  updatePlayerReviewMetadata: async (
    steamId: string,
    update: ReviewMetadataUpdate,
    signal?: AbortSignal,
  ): Promise<PlayerReviewMetadata> => parsePlayerReviewMetadata(
    await request<unknown>(`/players/${encodeURIComponent(steamId)}/metadata`, {
      method: 'PUT',
      body: update,
      signal,
    }),
    steamId,
  ),
  getRoundReviewMetadata: async (
    demoId: string,
    round: number,
    signal?: AbortSignal,
  ): Promise<RoundReviewMetadata> => parseRoundReviewMetadata(
    await request<unknown>(`/demos/${encodeURIComponent(demoId)}/rounds/${round}/metadata`, { signal }),
    demoId,
    round,
  ),
  updateRoundReviewMetadata: async (
    demoId: string,
    round: number,
    update: ReviewMetadataUpdate,
    signal?: AbortSignal,
  ): Promise<RoundReviewMetadata> => parseRoundReviewMetadata(
    await request<unknown>(`/demos/${encodeURIComponent(demoId)}/rounds/${round}/metadata`, {
      method: 'PUT',
      body: update,
      signal,
    }),
    demoId,
    round,
  ),
  listPlayerMatches: async (
    steamId: string,
    query: { page: number; page_size: number },
    signal?: AbortSignal,
  ) => {
    const page = parsePlayerMatchPage(await request<PlayerMatchPage>(
      `/players/${encodeURIComponent(steamId)}/matches${queryString(query)}`,
      { signal },
    ));
    if (page.steam_id !== steamId) {
      throw new Error('Player match response does not match the requested exact player.');
    }
    return page;
  },
  listPlayerMaps: async (
    steamId: string,
    query: { page: number; page_size: number },
    signal?: AbortSignal,
  ) => {
    const page = parsePlayerMapPage(await request<PlayerMapPage>(
      `/players/${encodeURIComponent(steamId)}/maps${queryString(query)}`,
      { signal },
    ));
    if (page.steam_id !== steamId) {
      throw new Error('Player map response does not match the requested exact player.');
    }
    return page;
  },
  getPlayerHeatmap: async (
    steamId: string,
    query: { map: string; kind: 'all' | 'kills' | 'deaths' },
    signal?: AbortSignal,
  ) => {
    const heatmap = parsePlayerHeatmap(await request<PlayerHeatmap>(
      `/players/${encodeURIComponent(steamId)}/heatmap${queryString(query)}`,
      { signal },
    ));
    if (heatmap.steam_id !== steamId || heatmap.map_name !== query.map) {
      throw new Error('Player heatmap response does not match the requested exact map.');
    }
    return heatmap;
  },
  comparePlayers: async (left: string, right: string, signal?: AbortSignal) => {
    const comparison = parsePlayerComparison(await request<PlayerComparison>(
      `/players/compare${queryString({ left, right })}`,
      { signal },
    ));
    if (
      comparison.players[0].steam_id !== left
      || comparison.players[1].steam_id !== right
    ) {
      throw new Error('Player comparison does not match the requested exact players.');
    }
    return comparison;
  },
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
  startAnalysisRun: async (id: string, signal?: AbortSignal) =>
    parseAnalysisRun(await request<AnalysisRun>(`/demos/${encodeURIComponent(id)}/analysis-runs`, {
      method: 'POST',
      signal,
    })),
  getActiveAnalysisRun: async (id: string, signal?: AbortSignal) =>
    parseAnalysisRunDetail(await request<AnalysisRunDetail>(
      `/demos/${encodeURIComponent(id)}/analysis-runs/active`, { signal },
    )),
  getAnalysisRun: async (id: string, signal?: AbortSignal) => {
    const detail = parseAnalysisRunDetail(await request<AnalysisRunDetail>(
      `/analysis-runs/${encodeURIComponent(id)}`, { signal },
    ));
    if (detail.run.id !== id) {
      throw new Error('Analysis run response does not match the requested exact run.');
    }
    return detail;
  },
  cancelAnalysisRun: async (id: string, signal?: AbortSignal) => {
    const detail = parseAnalysisRunDetail(await request<AnalysisRunDetail>(
      `/analysis-runs/${encodeURIComponent(id)}/cancel`,
      { method: 'POST', signal, timeoutMs: null },
    ));
    if (detail.run.id !== id) {
      throw new Error('Analysis cancel response does not match the requested exact run.');
    }
    return detail;
  },
  getAnalysisRunResult: async (id: string, signal?: AbortSignal) => {
    const record = await request<MatchAnalysisRecord>(
      `/analysis-runs/${encodeURIComponent(id)}/result`, { signal },
    );
    return normalizeAnalysis(record);
  },
  getAnalysis: async (id: string, signal?: AbortSignal) => {
    const record = await request<MatchAnalysisRecord>(
      `/demos/${encodeURIComponent(id)}/analysis`,
      { signal },
    );
    return normalizeAnalysis(record);
  },
  searchEvidence: (query: EvidenceSearchQuery = {}, signal?: AbortSignal) => {
    const parameters = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (typeof value === 'string') {
        const normalized = value.trim();
        if (normalized) parameters.set(key, normalized);
      } else if (value !== undefined) {
        parameters.set(key, String(value));
      }
    });
    const suffix = parameters.size > 0 ? `?${parameters.toString()}` : '';
    return request<EvidenceSearchResponse>(`/evidence/search${suffix}`, { signal });
  },
  listEvidenceAnnotations: (
    query: EvidenceAnnotationQuery = {},
    signal?: AbortSignal,
  ) => request<Paginated<EvidenceAnnotation>>(
    `/evidence/annotations${queryString({
      q: query.q?.trim(),
      tag: query.tag?.trim(),
      demo_id: query.demo_id,
      evidence_id: query.evidence_id?.trim(),
      state: query.state,
      page: query.page,
      page_size: query.page_size,
    })}`,
    { signal },
  ),
  createEvidenceAnnotation: (body: CreateEvidenceAnnotation) =>
    request<EvidenceAnnotation>('/evidence/annotations', { method: 'POST', body }),
  updateEvidenceAnnotation: (id: string, body: UpdateEvidenceAnnotation) =>
    request<EvidenceAnnotation>(`/evidence/annotations/${encodeURIComponent(id)}`, {
      method: 'PATCH', body,
    }),
  deleteEvidenceAnnotation: (id: string) => request<void>(
    `/evidence/annotations/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  ),
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
    desktopMediaUrl(`/api/cosmetics/catalog/items/${itemDefinitionIndex}/paint-kits/${paintKit}/image`),
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
  getReplayBinary: (id: string, signal?: AbortSignal) =>
    requestBinary(`/demos/${encodeURIComponent(id)}/replay.bin`, signal),
  getAnalysisRunRoundReplayBinary: (runId: string, round: number, signal?: AbortSignal) =>
    requestBinary(
      `/analysis-runs/${encodeURIComponent(runId)}/replay/rounds/${encodeURIComponent(String(round))}/replay.bin`,
      signal,
    ),
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
  planRecordingRetry: (jobId: string) =>
    request<RecordingPlanResponse>(
      `/recording/jobs/${encodeURIComponent(jobId)}/retry-plan`,
      { method: 'POST', body: {}, timeoutMs: null },
    ),
  executeRecordingPlan: (projectId: string, planId: string, offlineInsecureAcknowledged: boolean) =>
    request<RecordingExecutionResponse>(
      `/projects/${encodeURIComponent(projectId)}/recording-plans/${encodeURIComponent(planId)}/execute`,
      {
        method: 'POST',
        body: { offline_insecure_acknowledged: offlineInsecureAcknowledged },
        timeoutMs: null,
      },
    ),
  /**
   * Runs the closed pre-recording check list for one leased plan.
   *
   * A POST, and not because it writes: every call re-discovers CS2, re-hashes
   * the plan's Demos, write-probes the output root and re-queries the encoder
   * inventory, so the answer is a measurement and must never be replayed from a
   * cache. It leaves the plan lease untouched, so it can be re-run as often as
   * the user asks, and `timeoutMs: null` keeps it attached while it hashes.
   *
   * Blocked rows disable starting the recording: the server publishes the count
   * as `blocking`. Warnings never do.
   */
  getRecordingJob: (id: string, signal?: AbortSignal) =>
    request<RecordingJob>(`/recording/jobs/${encodeURIComponent(id)}`, { signal }),
  cancelRecordingJob: (id: string) =>
    request<RecordingJob>(`/recording/jobs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: {},
    }),
  listActivities: async (query: ActivityQuery = {}, signal?: AbortSignal) =>
    parseActivityFeed(await request<ActivityFeed>(
      `/activities${queryString({
        search: query.search?.trim(),
        kind: query.kind,
        state: query.state,
        page: query.page,
        page_size: query.page_size,
      })}`,
      { signal },
    )),
  getActivity: async (kind: ActivityKind, id: string, signal?: AbortSignal) => {
    const item = parseActivityItem(await request<ActivityItem>(
      `/activities/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
      { signal },
    ));
    if (item.kind !== kind || item.job_id !== id || item.id !== `${kind}:${id}`) {
      throw new Error('Activity response does not match the requested exact locator.');
    }
    return item;
  },
  runtimeState: (signal?: AbortSignal) => request<RuntimeState>('/app/runtime-state', { signal }),
  abortRecording: () => request<void>('/recording/abort', { method: 'POST', body: {} }),
  listRecordedClips: async (signal?: AbortSignal) => {
    const page = await request<Paginated<RecordedClipRecord>>('/recorded-clips', { signal });
    return { ...page, items: page.items.map(normalizeRecordedClip) };
  },
  listRecordedClipRecords: (signal?: AbortSignal) =>
    request<Paginated<RecordedClipRecord>>('/recorded-clips?page=1&page_size=200', { signal }),
  /**
   * Returns the unreduced wire record rather than the `RecordedClip` shape
   * `listRecordedClips` normalizes to: an inspector that just edited the title
   * needs `path`, `tags` and `metadata` back, and those are exactly what the
   * normalization drops.
   */
  patchRecordedClip: (
    id: string,
    patch: Partial<Pick<RecordedClipRecord, 'title' | 'player_name' | 'category' | 'tags' | 'metadata'>>,
  ) =>
    request<RecordedClipRecord>(`/recorded-clips/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
    }),
  deleteRecordedClip: (id: string) =>
    request<void>(`/recorded-clips/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listMediaAssets: (projectId?: string, signal?: AbortSignal) =>
    request<{ items: MediaAsset[] }>(
      `/media/assets${queryString({ project_id: projectId })}`,
      { signal },
    ),
  uploadMediaAssets: async (files: File[], projectId?: string) => {
    const results = await Promise.all(
      files.map((file) => uploadNativeFile<{ items: MediaAsset[] }>('/media/assets', file, projectId)),
    );
    return { items: results.flatMap((result) => result.items) };
  },
  getAssetWaveform: (id: string, buckets = 120, signal?: AbortSignal) =>
    request<WaveformResponse>(
      `/media/assets/${encodeURIComponent(id)}/waveform${queryString({ buckets })}`,
      { signal, timeoutMs: 90_000 },
    ),
  getMediaAsset: (id: string, signal?: AbortSignal) =>
    request<MediaAsset>(`/media/assets/${encodeURIComponent(id)}`, { signal }),
  /**
   * Registers a file already on disk as a managed asset, without copying it
   * through the upload path. Every field of the body is required by the route
   * even when it is `null`, so all four are always sent.
   */
  importMediaAsset: (
    path: string,
    options: { projectId?: string | undefined; name?: string | undefined; kind?: string | undefined } = {},
  ) =>
    request<MediaAsset>('/media/assets/import', {
      method: 'POST',
      body: {
        path,
        project_id: options.projectId ?? null,
        name: options.name ?? null,
        kind: options.kind ?? null,
      },
      timeoutMs: 90_000,
    }),
  deleteMediaAsset: (id: string) =>
    request<void>(`/media/assets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  replaceMediaAssetMarkers: (id: string, markers: readonly EditorMarker[]) =>
    request<MediaAsset>(`/media/assets/${encodeURIComponent(id)}/markers`, {
      method: 'PUT',
      body: { markers: [...markers] },
    }),
  /** Renders the asset's audio stream into a second, managed audio asset. */
  extractAssetAudio: (id: string) =>
    request<MediaAsset>(`/media/assets/${encodeURIComponent(id)}/extract-audio`, {
      method: 'POST',
      body: {},
      timeoutMs: 20 * 60_000,
    }),
  relinkMediaAsset: (id: string, path: string) =>
    request<MediaAsset>(`/media/assets/${encodeURIComponent(id)}/relink`, {
      method: 'POST',
      body: { path },
      timeoutMs: 90_000,
    }),
  replaceMediaAsset: (id: string, file: File) =>
    uploadNativeFile<MediaAsset>(`/media/assets/${encodeURIComponent(id)}/replace`, file),
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
  listExportJobs: (projectId?: string, signal?: AbortSignal) =>
    request<{ items: ExportJobRecord[] }>(
      `/exports${queryString({ project_id: projectId })}`,
      { signal },
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
  getHlaeStatus: (signal?: AbortSignal) => request<HlaeStatus>('/hlae/status', { signal }),
  prepareManagedHlae: () => request<HlaeStatus>('/hlae/managed/prepare', {
    method: 'POST', body: {}, timeoutMs: null,
  }),
  listHlaeBundles: () => invoke<HlaeBundleHandoff[]>('list_hlae_bundles'),
  revealHlaeBundle: (bundleDirectory: string) =>
    invoke<HlaeBundleHandoff>('reveal_hlae_bundle', { bundleDirectory }),
  storageStatus: (signal?: AbortSignal) => request<StorageStatus>('/storage/status', { signal }),
  updateConfig: (config: AppConfig) =>
    request<AppConfig>('/config', { method: 'PUT', body: configUpdatePayload(config) }),
  testLlm: (llm: AppConfig['llm']) =>
    request<LlmTestResult>('/llm/test', { method: 'POST', body: llm, timeoutMs: 60_000 }),
  listMatchHistory: (page = 1, pageSize = 50, signal?: AbortSignal, search?: string) =>
    request<Paginated<MatchHistoryItem>>(
      `/match-history/matches${queryString({ page, page_size: pageSize, search: search?.trim() })}`,
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
  listActiveMatchDownloadJobs: (signal?: AbortSignal) =>
    request<MatchDownloadJob[]>('/match-history/downloads/active', { signal }),
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
  /** Writes a diagnostic report under the data directory and answers its path. */
  exportDiagnostics: () =>
    request<DiagnosticExport>('/app/diagnostics/export', { method: 'POST', body: {} }),
};

export function readableError(error: unknown): string {
  if (error instanceof DesktopError) return error.message;
  return t`发生未知错误，请重试。`;
}
